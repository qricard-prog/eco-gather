import Phaser from 'phaser';
import { WORLD, PLAYER, PROXIMITY, COLORS, BOTS, SHOW_BOTS } from '../config.js';
import { connect } from '../net.js';
import { LiveKitMedia } from '../media.js';

const WALL = 24; // épaisseur des murs du périmètre
const SEND_INTERVAL = 60; // ms entre deux envois de position au serveur
// Délai avant de quitter la room LiveKit une fois seul (évite les coupures
// si on ne fait que frôler la limite de proximité). Économise des minutes.
const MEDIA_GRACE_MS = 5000;

// Mobilier de l'open-space (rectangles bloquants + déco non bloquante).
const FURNITURE = [
  { type: 'desk', x: 600, y: 470, w: 130, h: 64 },
  { type: 'desk', x: 770, y: 470, w: 130, h: 64 },
  { type: 'desk', x: 940, y: 470, w: 130, h: 64 },
  { type: 'table', x: 1080, y: 770, w: 180, h: 110 },
  { type: 'counter', x: 1320, y: 250, w: 200, h: 50 },
  { type: 'plant', x: 110, y: 110, r: 22 },
  { type: 'plant', x: 110, y: 890, r: 22 },
  { type: 'plant', x: 1490, y: 890, r: 22 },
];

// Tapis / zones d'accueil (décoratif, non bloquant)
const RUGS = [
  { x: 760, y: 770, r: 120 },
  { x: 380, y: 300, r: 95 },
];

export default class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  init(data) {
    this.pseudo = data?.pseudo || 'Moi';
    this.proximityRadius = PROXIMITY.radius;
    this.showBubble = true;
    this.facing = new Phaser.Math.Vector2(0, 1);

    // « Autres » avatars (bots + participants réseau), indexés par id.
    this.others = new Map();
    this.nearby = [];

    // Réseau
    this.socket = null;
    this.online = false;
    this.lastSent = { x: 0, y: 0 };
    this.lastSentAt = 0;

    // Média (LiveKit) — connexion paresseuse : on ne rejoint la room
    // que lorsqu'au moins un participant est à portée (économie de minutes).
    this.media = null;
    this.mediaStarted = false;
    this.mediaToken = null; // { url, token } récupéré une fois, réutilisé
    this.mediaDisconnectTimer = null;
  }

  create() {
    this.physics.world.setBounds(0, 0, WORLD.width, WORLD.height);
    this.cameras.main.setBounds(0, 0, WORLD.width, WORLD.height);

    this.drawFloor();
    this.drawRugs();
    this.buildWalls();
    this.buildFurniture();
    if (SHOW_BOTS) this.createBots();
    this.createPlayer();

    this.fx = this.add.graphics().setDepth(5);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);

    this.setupInput();
    this.buildHud();
    this.connectNetwork();

    // Coupe proprement les connexions quand la scène s'arrête.
    this.events.once('shutdown', () => {
      this.cancelMediaDisconnect();
      this.media?.disconnect();
      this.socket?.disconnect();
    });
  }

  // ---------------------------------------------------------------- décor

  drawFloor() {
    const g = this.add.graphics().setDepth(-10);
    g.fillStyle(COLORS.floor, 1);
    g.fillRect(0, 0, WORLD.width, WORLD.height);
    g.lineStyle(1, COLORS.grid, 0.6);
    for (let x = 0; x <= WORLD.width; x += 40) g.lineBetween(x, 0, x, WORLD.height);
    for (let y = 0; y <= WORLD.height; y += 40) g.lineBetween(0, y, WORLD.width, y);
  }

  drawRugs() {
    const g = this.add.graphics().setDepth(-9);
    RUGS.forEach((r) => {
      g.fillStyle(COLORS.rug, 0.55);
      g.fillCircle(r.x, r.y, r.r);
    });
  }

  buildWalls() {
    this.walls = this.physics.add.staticGroup();
    const w = WORLD.width;
    const h = WORLD.height;
    [
      { x: w / 2, y: WALL / 2, w, h: WALL },
      { x: w / 2, y: h - WALL / 2, w, h: WALL },
      { x: WALL / 2, y: h / 2, w: WALL, h },
      { x: w - WALL / 2, y: h / 2, w: WALL, h },
    ].forEach((s) => this.addStaticRect(this.walls, s, COLORS.wall, COLORS.wallStroke));
  }

  buildFurniture() {
    this.furniture = this.physics.add.staticGroup();
    FURNITURE.forEach((f) => {
      if (f.type === 'plant') {
        this.addStaticCircle(this.furniture, f, COLORS.plant);
      } else {
        const fill = f.type === 'desk' ? COLORS.desk : COLORS.wall;
        this.addStaticRect(this.furniture, f, fill, COLORS.wallStroke);
        if (f.type === 'desk') {
          this.add.rectangle(f.x, f.y - 4, f.w - 16, f.h - 22, COLORS.deskTop).setDepth(1);
        }
      }
    });
  }

  addStaticRect(group, s, fill, stroke) {
    const rect = this.add.rectangle(s.x, s.y, s.w, s.h, fill).setDepth(0);
    rect.setStrokeStyle(2, stroke, 1);
    group.add(rect);
    return rect;
  }

  addStaticCircle(group, c, fill) {
    const circle = this.add.circle(c.x, c.y, c.r, fill).setDepth(0);
    circle.setStrokeStyle(3, 0x1f5a37, 1);
    group.add(circle);
    circle.body.setCircle(c.r, -c.r, -c.r);
    return circle;
  }

  // --------------------------------------------------------------- avatars

  // Construit un avatar « léché » (Container) :
  // ombre au sol + disque avec reflet + yeux directionnels + étiquette.
  // Les parties animées (corps, visage, ombre) sont stockées via setData
  // pour la boucle d'animation (rebond de marche, regard, respiration).
  makeAvatar(x, y, name, color) {
    const r = PLAYER.radius;
    const container = this.add.container(x, y).setDepth(10);

    // Ombre portée au sol (ne bouge pas avec le rebond)
    const shadow = this.add.ellipse(0, r + 2, r * 1.9, r * 0.8, 0x000000, 0.28);

    // Corps animable (rebond / respiration)
    const bodyG = this.add.container(0, 0);
    const disc = this.add.circle(0, 0, r, color);
    disc.setStrokeStyle(3, 0xffffff, 0.9);
    const highlight = this.add.ellipse(0, -r * 0.4, r * 1.1, r * 0.85, 0xffffff, 0.16);

    // Visage : deux yeux qui se décalent vers la direction du regard
    const faceG = this.add.container(0, 0);
    const eyeL = this.add.circle(-5, -1, 3.1, 0xffffff);
    const eyeR = this.add.circle(5, -1, 3.1, 0xffffff);
    const pupL = this.add.circle(-5, -1, 1.5, 0x12202c);
    const pupR = this.add.circle(5, -1, 1.5, 0x12202c);
    faceG.add([eyeL, eyeR, pupL, pupR]);

    bodyG.add([disc, highlight, faceG]);

    const label = this.add
      .text(0, r + 12, name, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '13px',
        color: COLORS.label,
        backgroundColor: '#0d141ccc',
        padding: { x: 6, y: 2 },
      })
      .setOrigin(0.5, 0);

    container.add([shadow, bodyG, label]);
    container.setData('circle', disc);
    container.setData('bodyG', bodyG);
    container.setData('faceG', faceG);
    container.setData('shadow', shadow);
    container.setData('label', label);
    container.setData('phase', Math.random() * Math.PI * 2);
    container.setData('dir', { x: 0, y: 1 });
    container.setSize(r * 2, r * 2);
    return container;
  }

  // Anime un avatar : regard (yeux vers la direction), rebond de marche
  // ou légère respiration au repos, ombre qui « respire » avec.
  animateAvatar(container, moving, time) {
    const bodyG = container.getData('bodyG');
    const faceG = container.getData('faceG');
    const shadow = container.getData('shadow');
    const phase = container.getData('phase');
    const dir = container.getData('dir') || { x: 0, y: 1 };
    const t = time / 1000;

    // Regard
    faceG.x = dir.x * 4.5;
    faceG.y = dir.y * 4.5 - 1;

    // Rebond / respiration
    let bob;
    if (moving) {
      bob = Math.abs(Math.sin(t * 12 + phase)) * 3.2;
    } else {
      bob = (Math.sin(t * 2.4 + phase) + 1) * 0.55;
    }
    bodyG.y = -bob;
    const s = 1 - bob * 0.02;
    shadow.setScale(s, s);
  }

  createBots() {
    BOTS.forEach((b) => {
      const container = this.makeAvatar(b.x, b.y, b.name, b.color);
      this.physics.add.existing(container, true);
      container.body.setCircle(PLAYER.radius, -PLAYER.radius, -PLAYER.radius);
      this.others.set(`bot:${b.name}`, {
        id: `bot:${b.name}`,
        type: 'bot',
        name: b.name,
        baseColor: b.color,
        container,
        circle: container.getData('circle'),
        inRange: false,
      });
    });
  }

  createPlayer() {
    this.player = this.makeAvatar(WORLD.width / 2, WORLD.height / 2, this.pseudo, COLORS.player);
    this.physics.add.existing(this.player);
    this.player.body.setCircle(PLAYER.radius, -PLAYER.radius, -PLAYER.radius);
    this.player.body.setCollideWorldBounds(true);
    this.playerCircle = this.player.getData('circle');

    this.physics.add.collider(this.player, this.walls);
    this.physics.add.collider(this.player, this.furniture);
    this.others.forEach((o) => {
      if (o.type === 'bot') this.physics.add.collider(this.player, o.container);
    });
  }

  // ---------------------------------------------------------------- réseau

  connectNetwork() {
    this.socket = connect();

    this.socket.on('connect', () => {
      this.online = true;
      this.socket.emit('join', { pseudo: this.pseudo });
      this.startMedia();
    });

    this.socket.on('disconnect', () => {
      this.online = false;
    });

    // Identité assignée par le serveur + participants déjà présents.
    this.socket.on('init', ({ you, players }) => {
      this.player.setPosition(you.x, you.y);
      this.playerCircle.setFillStyle(you.color);
      players.forEach((p) => this.addRemote(p));
    });

    this.socket.on('player-joined', (p) => this.addRemote(p));

    this.socket.on('player-moved', ({ id, x, y, dir }) => {
      const o = this.others.get(id);
      if (!o) return;
      o.tx = x;
      o.ty = y;
      if (dir) o.dir = dir;
    });

    this.socket.on('player-left', ({ id }) => this.removeRemote(id));
  }

  // Prépare la couche média : récupère le token (n'utilise PAS de minutes,
  // c'est juste un appel HTTP), mais ne rejoint pas encore la room LiveKit.
  // La connexion réelle est paresseuse (voir ensureMediaConnected).
  startMedia() {
    if (this.mediaStarted) return;
    this.mediaStarted = true;
    const id = this.socket.id;
    fetch(`/token?identity=${encodeURIComponent(id)}&name=${encodeURIComponent(this.pseudo)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('token indisponible'))))
      .then(({ token, url }) => {
        this.media = new LiveKitMedia();
        this.mediaToken = { url, token };
        // Si quelqu'un est déjà à portée à l'arrivée, on se connecte tout de suite.
        if (this.nearbyRemoteCount() > 0) this.ensureMediaConnected();
      })
      .catch((e) => {
        console.info('[media] désactivé :', e?.message || e);
        this.media = null;
      });
  }

  // Nombre de participants réseau actuellement dans la bulle de proximité.
  nearbyRemoteCount() {
    let n = 0;
    this.others.forEach((o) => {
      if (o.type === 'remote' && o.inRange) n += 1;
    });
    return n;
  }

  // Rejoint la room LiveKit si ce n'est pas déjà fait (déclenché par la proximité).
  ensureMediaConnected() {
    if (!this.media || !this.mediaToken) return;
    if (this.media.connected || this.media.connecting) return;
    this.cancelMediaDisconnect();
    this.media
      .connect(this.mediaToken.url, this.mediaToken.token, this.pseudo)
      .catch((e) => console.info('[media] connexion impossible :', e?.message || e));
  }

  // Programme la sortie de la room après un délai de grâce, si on reste seul.
  scheduleMediaDisconnect() {
    if (!this.media || this.mediaDisconnectTimer) return;
    this.mediaDisconnectTimer = this.time.delayedCall(MEDIA_GRACE_MS, () => {
      this.mediaDisconnectTimer = null;
      if (this.nearbyRemoteCount() === 0) this.media?.disconnect();
    });
  }

  cancelMediaDisconnect() {
    this.mediaDisconnectTimer?.remove();
    this.mediaDisconnectTimer = null;
  }

  addRemote(p) {
    if (this.others.has(p.id)) return;
    const container = this.makeAvatar(p.x, p.y, p.pseudo, p.color);
    this.others.set(p.id, {
      id: p.id,
      type: 'remote',
      name: p.pseudo,
      baseColor: p.color,
      container,
      circle: container.getData('circle'),
      inRange: false,
      tx: p.x,
      ty: p.y,
      dir: p.dir || { x: 0, y: 1 },
    });
  }

  removeRemote(id) {
    const o = this.others.get(id);
    if (!o) return;
    this.media?.unsubscribeFrom(id);
    o.container.destroy();
    this.others.delete(id);
    this.nearby = this.nearby.filter((n) => n !== o.name);
    // S'il partait et qu'on se retrouve seul, on programme la sortie de la room.
    if (this.nearbyRemoteCount() === 0) this.scheduleMediaDisconnect();
  }

  // ---------------------------------------------------------------- entrées

  setupInput() {
    this.cursors = this.input.keyboard.createCursorKeys();
    this.keys = this.input.keyboard.addKeys({
      z: Phaser.Input.Keyboard.KeyCodes.Z,
      q: Phaser.Input.Keyboard.KeyCodes.Q,
      s: Phaser.Input.Keyboard.KeyCodes.S,
      d: Phaser.Input.Keyboard.KeyCodes.D,
    });
    this.input.keyboard.on('keydown-OPEN_BRACKET', () => this.adjustRadius(-PROXIMITY.step));
    this.input.keyboard.on('keydown-CLOSED_BRACKET', () => this.adjustRadius(PROXIMITY.step));
    this.input.keyboard.on('keydown-P', () => {
      this.showBubble = !this.showBubble;
    });
  }

  adjustRadius(delta) {
    this.proximityRadius = Phaser.Math.Clamp(
      this.proximityRadius + delta,
      PROXIMITY.min,
      PROXIMITY.max
    );
  }

  // ------------------------------------------------------------------- HUD

  buildHud() {
    const pad = 12;
    this.hud = this.add
      .text(pad, pad, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#cfe0ee',
        backgroundColor: '#0a0e13d9',
        padding: { x: 10, y: 8 },
        lineSpacing: 4,
      })
      .setScrollFactor(0)
      .setDepth(100);

    this.status = this.add
      .text(pad, 0, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '14px',
        color: '#36c98f',
        backgroundColor: '#0a0e13d9',
        padding: { x: 10, y: 8 },
      })
      .setScrollFactor(0)
      .setDepth(100);
  }

  // ---------------------------------------------------------------- update

  update(time) {
    this.handleMovement();
    this.interpolateRemotes();
    this.animateAvatars(time);
    this.updateProximity();
    this.updateHud();
  }

  // Met à jour direction du regard + rebond/respiration de chaque avatar.
  animateAvatars(time) {
    const pMoving = this.player.body.velocity.lengthSq() > 1;
    this.player.getData('dir').x = this.facing.x;
    this.player.getData('dir').y = this.facing.y;
    this.animateAvatar(this.player, pMoving, time);

    this.others.forEach((o) => {
      let moving = false;
      const dir = o.container.getData('dir');
      if (o.type === 'remote') {
        moving = Math.hypot(o.container.x - o.tx, o.container.y - o.ty) > 0.6;
        dir.x = o.dir?.x ?? 0;
        dir.y = o.dir?.y ?? 1;
      }
      this.animateAvatar(o.container, moving, time);
    });
  }

  handleMovement() {
    const body = this.player.body;
    let vx = 0;
    let vy = 0;
    if (this.cursors.left.isDown || this.keys.q.isDown) vx -= 1;
    if (this.cursors.right.isDown || this.keys.d.isDown) vx += 1;
    if (this.cursors.up.isDown || this.keys.z.isDown) vy -= 1;
    if (this.cursors.down.isDown || this.keys.s.isDown) vy += 1;

    const v = new Phaser.Math.Vector2(vx, vy);
    if (v.lengthSq() > 0) {
      v.normalize().scale(PLAYER.speed);
      this.facing.copy(v).normalize();
    }
    body.setVelocity(v.x, v.y);

    this.maybeSendPosition();
  }

  maybeSendPosition() {
    if (!this.online) return;
    const now = this.time.now;
    const moved =
      Math.abs(this.player.x - this.lastSent.x) > 1 || Math.abs(this.player.y - this.lastSent.y) > 1;
    if (now - this.lastSentAt < SEND_INTERVAL || !moved) return;
    this.socket.emit('move', {
      x: Math.round(this.player.x),
      y: Math.round(this.player.y),
      dir: { x: +this.facing.x.toFixed(2), y: +this.facing.y.toFixed(2) },
    });
    this.lastSent = { x: this.player.x, y: this.player.y };
    this.lastSentAt = now;
  }

  // Lissage des avatars distants vers leur dernière position connue.
  interpolateRemotes() {
    this.others.forEach((o) => {
      if (o.type !== 'remote') return;
      o.container.x = Phaser.Math.Linear(o.container.x, o.tx, 0.25);
      o.container.y = Phaser.Math.Linear(o.container.y, o.ty, 0.25);
    });
  }

  updateProximity() {
    this.fx.clear();
    const px = this.player.x;
    const py = this.player.y;
    const r = this.proximityRadius;

    if (this.showBubble) {
      this.fx.lineStyle(2, COLORS.bubble, 0.35);
      this.fx.strokeCircle(px, py, r);
    }

    this.nearby = [];
    this.others.forEach((o) => {
      const bx = o.container.x;
      const by = o.container.y;
      const inRange = Phaser.Math.Distance.Between(px, py, bx, by) <= r;

      if (inRange) {
        this.nearby.push(o.name);
        this.fx.fillStyle(COLORS.bubble, 0.12);
        this.fx.fillCircle(bx, by, PLAYER.radius + 16);
        this.fx.lineStyle(3, COLORS.botActive, 0.9);
        this.fx.strokeCircle(bx, by, PLAYER.radius + 10);
        this.fx.lineStyle(4, COLORS.bubble, 0.5);
        this.fx.lineBetween(px, py, bx, by);
      }

      if (inRange && !o.inRange) this.onEnterRange(o);
      else if (!inRange && o.inRange) this.onLeaveRange(o);
    });
  }

  onEnterRange(o) {
    o.inRange = true;
    o.circle.setFillStyle(COLORS.botActive);
    this.tweens.add({ targets: o.container, scale: 1.12, duration: 160, ease: 'Back.out' });
    // Participant proche : on rejoint la room (si pas déjà fait) et on s'y abonne.
    if (o.type === 'remote') {
      this.media?.subscribeTo(o.id);
      this.ensureMediaConnected();
    }
  }

  onLeaveRange(o) {
    o.inRange = false;
    o.circle.setFillStyle(o.baseColor);
    this.tweens.add({ targets: o.container, scale: 1, duration: 160, ease: 'Sine.out' });
    if (o.type === 'remote') {
      this.media?.unsubscribeFrom(o.id);
      // Plus personne à portée → on quitte la room après le délai de grâce.
      if (this.nearbyRemoteCount() === 0) this.scheduleMediaDisconnect();
    }
  }

  updateHud() {
    const remotes = [...this.others.values()].filter((o) => o.type === 'remote').length;
    const net = this.online ? `🟢 connecté · ${remotes + 1} en ligne` : '🔴 hors-ligne (solo)';
    const media = !this.mediaToken
      ? 'positions seules'
      : this.media?.connected
        ? '🎥 actif (consomme des minutes)'
        : '💤 en veille (0 minute)';
    this.hud.setText(
      [
        `Pseudo : ${this.pseudo}    ${net}`,
        `Média : ${media}`,
        `Rayon de proximité : ${this.proximityRadius} px   ([ / ] pour régler)`,
        `Bulle visible : ${this.showBubble ? 'oui' : 'non'}   (P pour basculer)`,
        `Déplacement : flèches ou ZQSD`,
      ].join('\n')
    );

    this.status.setY(this.scale.height - 44);
    if (this.nearby.length) {
      this.status.setColor('#36c98f');
      this.status.setText(`🟢 En conversation avec : ${this.nearby.join(', ')}`);
    } else {
      this.status.setColor('#8a9bb0');
      this.status.setText("⚪️ Personne à proximité — approche-toi d'un collègue");
    }
  }
}
