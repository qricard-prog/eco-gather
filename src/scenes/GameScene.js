import Phaser from 'phaser';
import { WORLD, PLAYER, PROXIMITY, COLORS } from '../config.js';
import { connect } from '../net.js';
import { LiveKitMedia } from '../media.js';
import { Social, EMOTES } from '../social.js';

const WALL = 24; // épaisseur des murs du périmètre
const SEND_INTERVAL = 60; // ms entre deux envois de position au serveur
// Délai avant de quitter la room LiveKit une fois seul (évite les coupures
// si on ne fait que frôler la limite de proximité). Économise des minutes.
const MEDIA_GRACE_MS = 5000;

export default class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  init(data) {
    this.pseudo = data?.pseudo || 'Moi';
    // Personnalisation choisie sur l'écran d'accueil.
    this.custom = {
      color: data?.color ?? COLORS.player,
      hat: data?.hat || 'none',
      dog: Boolean(data?.dog),
    };
    this.proximityRadius = PROXIMITY.radius;
    this.showBubble = true;
    this.facing = new Phaser.Math.Vector2(0, 1);
    this.typing = false; // vrai quand on écrit dans le chat (gèle le déplacement)
    this.myColor = this.custom?.color ?? COLORS.player;
    this.bubbles = new Set(); // bulles de chat à repositionner chaque frame

    // Autres participants (réseau), indexés par id socket.
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
    this.mediaToken = null; // { url, token }, rafraîchi à chaque (re)connexion
    this.mediaDisconnectTimer = null;
    this._tokenFetching = false;
  }

  create() {
    this.physics.world.setBounds(0, 0, WORLD.width, WORLD.height);
    this.cameras.main.setBounds(0, 0, WORLD.width, WORLD.height);

    this.drawFloor();
    this.buildWalls();
    this.buildFurniture();
    this.createPlayer();

    this.fx = this.add.graphics().setDepth(5);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);

    this.connOverlay = document.getElementById('conn-overlay');
    this.connMsg = document.getElementById('conn-msg');

    this.setupInput();
    this.buildHud();
    this.connectNetwork();
    this.setupSocial();

    // Coupe proprement les connexions quand la scène s'arrête.
    this.events.once('shutdown', () => {
      clearTimeout(this._wakeTimer);
      this.cancelMediaDisconnect();
      this.media?.disconnect();
      this.socket?.disconnect();
    });
  }

  // ---------------------------------------------------------------- décor

  drawFloor() {
    const g = this.add.graphics().setDepth(-10);
    // Base
    g.fillStyle(COLORS.floor, 1);
    g.fillRect(0, 0, WORLD.width, WORLD.height);

    // Teintes de zones (très subtiles, pour structurer l'espace)
    g.fillStyle(0x2b8a5a, 0.10); // détente
    g.fillRoundedRect(40, 40, 530, 300, 18);
    g.fillStyle(0x2b4d8a, 0.12); // salle de réunion
    g.fillRect(1068, 24, 508, 352);
    g.fillStyle(0x8a5a2b, 0.12); // coin café
    g.fillRoundedRect(1100, 710, 460, 250, 18);
    g.fillStyle(0x46466a, 0.08); // open-space
    g.fillRoundedRect(545, 355, 510, 300, 18);

    // Grille par-dessus pour le sens de l'échelle
    g.lineStyle(1, COLORS.grid, 0.5);
    for (let x = 0; x <= WORLD.width; x += 40) g.lineBetween(x, 0, x, WORLD.height);
    for (let y = 0; y <= WORLD.height; y += 40) g.lineBetween(0, y, WORLD.width, y);

    // Étang à canards (coin bas-gauche)
    const pond = this.add.graphics().setDepth(-9);
    pond.fillStyle(0x1d4e6e, 0.95);
    pond.fillEllipse(250, 800, 270, 165);
    pond.fillStyle(0x2a6e96, 0.8);
    pond.fillEllipse(250, 800, 210, 120);
    pond.lineStyle(3, 0x3b89b8, 0.5);
    pond.strokeEllipse(250, 800, 270, 165);

    // Tapis de la zone détente
    const rug = this.add.graphics().setDepth(-9);
    rug.fillStyle(COLORS.rug, 0.6);
    rug.fillEllipse(280, 205, 330, 190);
    rug.lineStyle(2, 0x33506e, 0.6);
    rug.strokeEllipse(280, 205, 330, 190);

    // Étiquettes de zones
    this.addZoneLabel(280, 320, 'DÉTENTE');
    this.addZoneLabel(1320, 345, 'RÉUNION');
    this.addZoneLabel(1330, 925, 'CAFÉ');
    this.addZoneLabel(795, 385, 'OPEN-SPACE');
  }

  addZoneLabel(x, y, text) {
    this.add
      .text(x, y, text, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '24px',
        fontStyle: 'bold',
        color: '#54708e',
      })
      .setOrigin(0.5)
      .setAlpha(0.55)
      .setDepth(-8);
  }

  // Petit élément décoratif emoji (non bloquant).
  addEmoji(x, y, char, size = 24, depth = 1) {
    return this.add
      .text(x, y, char, { fontSize: `${size}px` })
      .setOrigin(0.5)
      .setDepth(depth);
  }

  buildWalls() {
    this.walls = this.physics.add.staticGroup();
    const w = WORLD.width;
    const h = WORLD.height;
    const segs = [
      // Périmètre
      { x: w / 2, y: WALL / 2, w, h: WALL },
      { x: w / 2, y: h - WALL / 2, w, h: WALL },
      { x: WALL / 2, y: h / 2, w: WALL, h },
      { x: w - WALL / 2, y: h / 2, w: WALL, h },
      // Salle de réunion (cloison gauche avec porte, cloison basse pleine)
      { x: 1060, y: 117, w: 16, h: 186 },
      { x: 1060, y: 335, w: 16, h: 90 },
      { x: 1318, y: 380, w: 516, h: 16 },
    ];
    segs.forEach((s) => this.addStaticRect(this.walls, s, COLORS.wall, COLORS.wallStroke));
  }

  buildFurniture() {
    this.furniture = this.physics.add.staticGroup();

    // ---- Open-space : deux rangées de bureaux avec chaises ----
    const deskRows = [
      { y: 440, chairY: 396 },
      { y: 570, chairY: 614 },
    ];
    deskRows.forEach((row) => {
      [620, 790, 960].forEach((x) => {
        this.addStaticRect(this.furniture, { x, y: row.y, w: 130, h: 60 }, COLORS.desk, COLORS.wallStroke);
        this.add.rectangle(x, row.y - 4, 114, 38, COLORS.deskTop).setDepth(1);
        // Écran sur le bureau + chaise (décoratifs)
        this.add.rectangle(x, row.y - 10, 30, 18, 0x1c2733).setDepth(2).setStrokeStyle(1, 0x4a6680);
        this.add.circle(x, row.chairY, 9, 0x2c3a4a).setDepth(0).setStrokeStyle(2, 0x44586e);
      });
    });

    // ---- Salle de réunion : grande table + chaises + écran mural ----
    this.addStaticRect(this.furniture, { x: 1320, y: 200, w: 240, h: 100 }, 0x5a4632, COLORS.wallStroke);
    this.add.rectangle(1320, 196, 224, 80, 0x73593f).setDepth(1);
    [
      [1250, 130], [1320, 130], [1390, 130],
      [1250, 270], [1320, 270], [1390, 270],
      [1180, 200], [1460, 200],
    ].forEach(([cx, cy]) => this.add.circle(cx, cy, 9, 0x2c3a4a).setDepth(0).setStrokeStyle(2, 0x44586e));
    this.add.rectangle(1320, 42, 180, 12, 0x10161d).setDepth(0).setStrokeStyle(2, 0x4a6680);
    this.addEmoji(1320, 72, '📊', 26, 0);

    // ---- Coin café : comptoir, machine, tabourets, douceurs ----
    this.addStaticRect(this.furniture, { x: 1330, y: 790, w: 260, h: 44 }, 0x6b4f3a, COLORS.wallStroke);
    this.add.rectangle(1330, 786, 244, 24, 0x8a6a4f).setDepth(1);
    this.add.rectangle(1238, 782, 26, 30, 0x222a33).setDepth(2).setStrokeStyle(1, 0x4a6680); // machine
    this.addEmoji(1310, 784, '☕', 18, 2);
    this.addEmoji(1392, 784, '🍩', 18, 2);
    [1260, 1330, 1400].forEach((x) =>
      this.add.circle(x, 856, 8, 0x2c3a4a).setDepth(0).setStrokeStyle(2, 0x44586e)
    );

    // ---- Zone détente : canapé + bibliothèque + fun ----
    this.addStaticRect(this.furniture, { x: 170, y: 140, w: 130, h: 50 }, 0x3b5a8a, 0x55779e);
    this.add.rectangle(170, 122, 130, 16, 0x2f4a73).setDepth(1); // dossier
    this.add.rectangle(110, 140, 14, 46, 0x2f4a73).setDepth(1); // accoudoirs
    this.add.rectangle(230, 140, 14, 46, 0x2f4a73).setDepth(1);
    this.addStaticRect(this.furniture, { x: 445, y: 105, w: 150, h: 30 }, 0x5a4632, COLORS.wallStroke);
    [395, 425, 455, 485].forEach((x, i) =>
      this.add.rectangle(x, 103, 12, 18, [0xe06b8f, 0x5b8def, 0xf2c14e, 0x36c98f][i]).setDepth(1)
    );
    this.addEmoji(510, 250, '🎸', 30, 1);
    this.addEmoji(340, 235, '🐈', 26, 1); // le chat du bureau, en sieste

    // ---- Étang : canards (l'étang bloque le passage) ----
    this.addStaticCircle(this.furniture, { x: 250, y: 800, r: 76 }, 0x000000, 0); // collider invisible
    this.addEmoji(225, 785, '🦆', 26, 1);
    this.addEmoji(300, 830, '🦆', 18, 1);

    // ---- Table de ping-pong ----
    this.addStaticRect(this.furniture, { x: 760, y: 830, w: 210, h: 110 }, 0x1f6e46, 0xd9e6df);
    this.add.rectangle(760, 830, 4, 102, 0xd9e6df).setDepth(1); // filet
    this.addEmoji(650, 770, '🏓', 22, 1);

    // ---- Plantes vertes ----
    [
      { x: 1020, y: 100, r: 20 },
      { x: 600, y: 100, r: 20 },
      { x: 80, y: 930, r: 18 },
      { x: 1530, y: 440, r: 18 },
      { x: 1520, y: 925, r: 18 },
    ].forEach((p) => {
      const c = this.addStaticCircle(this.furniture, p, COLORS.plant, 1);
      c.setStrokeStyle(3, 0x1f5a37, 1);
    });

    // ---- Petites touches drôles ----
    this.addEmoji(1000, 945, '🚧', 22, 1);
    this.addEmoji(545, 940, '🛹', 22, 1);
  }

  addStaticRect(group, s, fill, stroke) {
    const rect = this.add.rectangle(s.x, s.y, s.w, s.h, fill).setDepth(0);
    rect.setStrokeStyle(2, stroke, 1);
    group.add(rect);
    return rect;
  }

  addStaticCircle(group, c, fill, alpha = 1) {
    const circle = this.add.circle(c.x, c.y, c.r, fill, alpha).setDepth(0);
    group.add(circle);
    circle.body.setCircle(c.r, -c.r, -c.r);
    return circle;
  }

  // --------------------------------------------------------------- avatars

  // Construit un avatar (Container) : ombre + disque avec reflet + yeux
  // directionnels + accessoire éventuel + étiquette. Les parties animées
  // sont stockées via setData pour la boucle d'animation.
  makeAvatar(x, y, name, color, opts = {}) {
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
    this.addHat(bodyG, opts.hat);

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

  // Accessoire de tête, dessiné dans le groupe « corps » (suit le rebond).
  addHat(bodyG, hat) {
    const r = PLAYER.radius;
    if (hat === 'casquette') {
      const dome = this.add.arc(0, -r * 0.55, r * 0.75, 180, 360, false, 0xe74c3c);
      const visor = this.add.rectangle(r * 0.55, -r * 0.55, r, 5, 0xc0392b);
      bodyG.add([dome, visor]);
    } else if (hat === 'hautdeforme') {
      const brim = this.add.rectangle(0, -r * 0.85, r * 1.9, 4, 0x222a33);
      const crown = this.add.rectangle(0, -r * 0.85 - 9, r * 1.1, 16, 0x222a33);
      const band = this.add.rectangle(0, -r * 0.85 - 3, r * 1.1, 5, 0xe74c3c);
      bodyG.add([crown, band, brim]);
    } else if (hat === 'fete') {
      // Points en coordonnées positives : l'origine du Triangle Phaser est
      // calculée sur la bounding box, les coordonnées négatives la faussent.
      const cone = this.add.triangle(0, -r - 8, 10, 0, 0, 24, 20, 24, 0xf2c14e);
      const pompom = this.add.circle(0, -r - 20, 4.5, 0xe06b8f);
      bodyG.add([cone, pompom]);
    }
  }

  // Petit chien compagnon (Container indépendant qui suit son maître).
  makeDog(x, y) {
    const c = this.add.container(x, y).setDepth(9);
    const shadow = this.add.ellipse(0, 8, 24, 7, 0x000000, 0.25);
    const inner = this.add.container(0, 0);
    const tail = this.add.triangle(-13, -3, 0, 0, 8, 6, 0, 8, 0x6d5238);
    const body = this.add.ellipse(-3, 0, 18, 11, 0x8d6e4a);
    const head = this.add.circle(8, -5, 7, 0x8d6e4a);
    const earL = this.add.triangle(5, -11, 3, 0, 0, 8, 6, 8, 0x6d5238);
    const earR = this.add.triangle(11, -11, 3, 0, 0, 8, 6, 8, 0x6d5238);
    const eye = this.add.circle(10, -6, 1.5, 0x12202c);
    const nose = this.add.circle(14.5, -3.5, 2, 0x2b2b2b);
    inner.add([tail, body, head, earL, earR, eye, nose]);
    c.add([shadow, inner]);
    c.setData('inner', inner);
    c.setData('phase', Math.random() * Math.PI * 2);
    return c;
  }

  // Le chien suit son maître avec un temps de retard, trottine et regarde
  // dans la direction du déplacement.
  updateDog(owner, time) {
    const dog = owner.getData('dogC');
    if (!dog) return;
    const dir = owner.getData('dir') || { x: 0, y: 1 };
    const tx = owner.x - dir.x * 36;
    const ty = owner.y - dir.y * 36;
    dog.x = Phaser.Math.Linear(dog.x, tx, 0.08);
    dog.y = Phaser.Math.Linear(dog.y, ty, 0.08);

    const moving = Math.hypot(tx - dog.x, ty - dog.y) > 2.5;
    const inner = dog.getData('inner');
    const t = time / 1000;
    const ph = dog.getData('phase');
    inner.y = moving
      ? -Math.abs(Math.sin(t * 11 + ph)) * 2.5
      : -(Math.sin(t * 2.2 + ph) + 1) * 0.5;
    if (Math.abs(dir.x) > 0.15) inner.scaleX = dir.x < 0 ? -1 : 1;
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

  createPlayer() {
    this.player = this.makeAvatar(
      WORLD.width / 2,
      WORLD.height / 2,
      this.pseudo,
      this.custom.color,
      { hat: this.custom.hat }
    );
    this.physics.add.existing(this.player);
    this.player.body.setCircle(PLAYER.radius, -PLAYER.radius, -PLAYER.radius);
    this.player.body.setCollideWorldBounds(true);
    this.playerCircle = this.player.getData('circle');

    if (this.custom.dog) {
      this.player.setData('dogC', this.makeDog(this.player.x + 30, this.player.y + 10));
    }

    this.physics.add.collider(this.player, this.walls);
    this.physics.add.collider(this.player, this.furniture);
  }

  // ---------------------------------------------------------------- réseau

  connectNetwork() {
    this.showConnecting("Connexion à l'espace…");
    this.socket = connect();

    // Vaut aussi pour les RECONNEXIONS : on repart d'un monde propre, on
    // re-rejoint, et on rafraîchit le token média (l'identité = id socket,
    // qui change à chaque reconnexion).
    this.socket.on('connect', () => {
      this.online = true;
      this.clearConnecting();
      this.resetWorld();
      this.socket.emit('join', {
        pseudo: this.pseudo,
        color: this.custom.color,
        hat: this.custom.hat,
        dog: this.custom.dog,
      });
      this.refreshMediaToken();
    });

    this.socket.on('disconnect', () => {
      this.online = false;
      this.showConnecting('Reconnexion…');
      // Le média est lié à l'ancien id : on le coupe et on forcera un nouveau token.
      this.cancelMediaDisconnect();
      this.media?.disconnect();
      this.mediaToken = null;
    });

    // Si la (re)connexion traîne, c'est probablement le réveil du serveur gratuit.
    this.socket.io.on('reconnect_attempt', () =>
      this.showConnecting('Reconnexion…')
    );

    // Identité assignée par le serveur + participants déjà présents.
    this.socket.on('init', ({ you, players }) => {
      this.player.setPosition(you.x, you.y);
      this.playerCircle.setFillStyle(you.color);
      this.myColor = you.color;
      const dog = this.player.getData('dogC');
      if (dog) {
        dog.x = you.x + 30;
        dog.y = you.y + 10;
      }
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

    // Chat reçu d'un autre : journal + bulle au-dessus de son avatar.
    this.socket.on('chat', ({ id, pseudo, color, text }) => {
      this.social?.addMessage({ name: pseudo, color, text });
      const o = this.others.get(id);
      if (o) this.showChatBubble(o.container, text);
    });

    // Émote reçue d'un autre : émoji flottant au-dessus de son avatar.
    this.socket.on('emote', ({ id, emoji }) => {
      const o = this.others.get(id);
      if (o) this.spawnEmote(o.container, emoji);
    });
  }

  // ----------------------------------------------------------- chat / émotes

  setupSocial() {
    this.social = new Social({
      onSendChat: (text) => {
        this.socket?.emit('chat', { text });
        this.social.addMessage({ name: this.pseudo, color: this.myColor, text, self: true });
        this.showChatBubble(this.player, text);
      },
      onEmote: (emoji) => {
        this.socket?.emit('emote', { emoji });
        this.spawnEmote(this.player, emoji);
      },
      onFocusChange: (focused) => {
        this.typing = focused;
        if (focused) this.player.body.setVelocity(0, 0);
        else this.input.keyboard.resetKeys(); // évite une touche « coincée »
      },
    });
  }

  // Bulle de parole temporaire au-dessus d'un avatar. Objet niveau scène,
  // repositionné chaque frame (voir updateFloaters) pour suivre l'avatar.
  showChatBubble(container, text) {
    const prev = container.getData('bubble');
    if (prev) {
      prev.timer?.remove();
      prev.obj.destroy();
      this.bubbles.delete(prev);
    }
    const shown = text.length > 64 ? text.slice(0, 64) + '…' : text;
    const bubble = this.add
      .text(container.x, container.y - (PLAYER.radius + 14), shown, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '12px',
        color: '#11161d',
        backgroundColor: '#eef4f8',
        padding: { x: 8, y: 5 },
        align: 'center',
        wordWrap: { width: 170 },
      })
      .setOrigin(0.5, 1)
      .setDepth(30);
    const entry = { obj: bubble, owner: container, timer: null };
    entry.timer = this.time.delayedCall(5000, () => {
      bubble.destroy();
      this.bubbles.delete(entry);
      container.setData('bubble', null);
    });
    container.setData('bubble', entry);
    this.bubbles.add(entry);
  }

  // Émoji qui s'élève et s'estompe au-dessus d'un avatar (niveau scène).
  spawnEmote(container, emoji) {
    const e = this.add
      .text(container.x, container.y - (PLAYER.radius + 8), emoji, { fontSize: '26px' })
      .setOrigin(0.5, 0.5)
      .setDepth(31);
    this.tweens.add({
      targets: e,
      y: e.y - 46,
      alpha: 0,
      duration: 1200,
      ease: 'Sine.out',
      onComplete: () => e.destroy(),
    });
  }

  // Fait suivre les bulles de chat à leur avatar.
  updateFloaters() {
    this.bubbles.forEach((b) => {
      if (!b.owner.active) {
        b.timer?.remove();
        b.obj.destroy();
        this.bubbles.delete(b);
        return;
      }
      b.obj.setPosition(b.owner.x, b.owner.y - (PLAYER.radius + 14));
    });
  }

  // Détruit les avatars distants (et leur chien/bulle) pour repartir d'un état
  // propre — appelé à chaque (re)connexion. Le joueur local est conservé.
  resetWorld() {
    this.others.forEach((o) => {
      o.container.getData('dogC')?.destroy();
      const b = o.container.getData('bubble');
      if (b) {
        b.timer?.remove();
        b.obj.destroy();
        this.bubbles.delete(b);
      }
      o.container.destroy();
    });
    this.others.clear();
    this.nearby = [];
  }

  // Récupère un token média pour l'id socket courant (n'utilise PAS de minutes :
  // c'est un simple appel HTTP). La connexion à la room reste paresseuse.
  refreshMediaToken() {
    if (this._tokenFetching) return;
    this._tokenFetching = true;
    const id = this.socket.id;
    fetch(`/token?identity=${encodeURIComponent(id)}&name=${encodeURIComponent(this.pseudo)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('token indisponible'))))
      .then(({ token, url }) => {
        if (!this.media) this.media = new LiveKitMedia();
        this.mediaToken = { url, token };
        // Quelqu'un déjà à portée (ex. reconnexion en pleine conversation) → on rejoint.
        if (this.nearbyRemoteCount() > 0) this.ensureMediaConnected();
      })
      .catch((e) => console.info('[media] désactivé :', e?.message || e))
      .finally(() => {
        this._tokenFetching = false;
      });
  }

  // ----- Overlay de connexion / réveil du serveur -----

  showConnecting(msg) {
    if (!this.connOverlay) return;
    this.connMsg.textContent = msg;
    this.connOverlay.classList.remove('hidden');
    clearTimeout(this._wakeTimer);
    // Au-delà de quelques secondes, c'est très probablement le réveil du dyno gratuit.
    this._wakeTimer = setTimeout(() => {
      this.connMsg.textContent = '⏳ Réveil du serveur… (le service gratuit peut mettre ~1 min)';
    }, 4500);
  }

  clearConnecting() {
    clearTimeout(this._wakeTimer);
    this.connOverlay?.classList.add('hidden');
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
    const container = this.makeAvatar(p.x, p.y, p.pseudo, p.color, { hat: p.hat });
    if (p.dog) container.setData('dogC', this.makeDog(p.x + 30, p.y + 10));
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
    o.container.getData('dogC')?.destroy();
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
      if (!this.typing) this.showBubble = !this.showBubble;
    });

    // Entrée : focus le chat. Chiffres 1-6 : émotes rapides.
    this.input.keyboard.on('keydown-ENTER', () => {
      if (!this.typing) this.social?.focusInput();
    });
    ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX'].forEach((key, i) => {
      this.input.keyboard.on(`keydown-${key}`, () => {
        if (this.typing || !EMOTES[i]) return;
        this.socket?.emit('emote', { emoji: EMOTES[i] });
        this.spawnEmote(this.player, EMOTES[i]);
      });
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
    this.updateFloaters();
    this.updateProximity();
    this.updateHud();
  }

  // Met à jour direction du regard + rebond/respiration de chaque avatar,
  // et fait trottiner les chiens derrière leur maître.
  animateAvatars(time) {
    const pMoving = this.player.body.velocity.lengthSq() > 1;
    this.player.getData('dir').x = this.facing.x;
    this.player.getData('dir').y = this.facing.y;
    this.animateAvatar(this.player, pMoving, time);
    this.updateDog(this.player, time);

    this.others.forEach((o) => {
      const dir = o.container.getData('dir');
      const moving = Math.hypot(o.container.x - o.tx, o.container.y - o.ty) > 0.6;
      dir.x = o.dir?.x ?? 0;
      dir.y = o.dir?.y ?? 1;
      this.animateAvatar(o.container, moving, time);
      this.updateDog(o.container, time);
    });
  }

  handleMovement() {
    const body = this.player.body;
    // Pendant la saisie du chat, l'avatar ne bouge pas.
    if (this.typing) {
      body.setVelocity(0, 0);
      return;
    }
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
    this.media?.subscribeTo(o.id);
    this.ensureMediaConnected();
  }

  onLeaveRange(o) {
    o.inRange = false;
    o.circle.setFillStyle(o.baseColor);
    this.tweens.add({ targets: o.container, scale: 1, duration: 160, ease: 'Sine.out' });
    this.media?.unsubscribeFrom(o.id);
    // Plus personne à portée → on quitte la room après le délai de grâce.
    if (this.nearbyRemoteCount() === 0) this.scheduleMediaDisconnect();
  }

  updateHud() {
    const remotes = this.others.size;
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
        `Déplacement : flèches ou ZQSD   ·   Chat : Entrée   ·   Émotes : 1-6`,
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
