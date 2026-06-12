import Phaser from 'phaser';
import { WORLD, PLAYER, PROXIMITY, COLORS, PETS, AVATAR_COLORS } from '../config.js';
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
      pet: data?.pet || 'none',
    };
    this.proximityRadius = PROXIMITY.radius;
    this.showBubble = true;
    this.facing = new Phaser.Math.Vector2(0, 1);
    this.typing = false; // vrai quand on écrit dans le chat (gèle le déplacement)
    this.myColor = this.custom?.color ?? COLORS.player;
    this.bubbles = new Set(); // bulles de chat à repositionner chaque frame
    this.attachments = new Set(); // objets accrochés à un avatar (☕…)

    // Vie de bureau
    this.coffeeUntil = 0; // boost café en cours jusqu'à cet instant
    this.feedCooldown = 0;
    this._confettiCd = 0;
    this.ducks = [];

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

    this.blockers = []; // zones physiques invisibles (murs + mobilier)
    this.drawFloor();
    this.buildWalls();
    this.buildFurniture();
    this.createPlayer();

    this.fx = this.add.graphics().setDepth(5);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);

    // Indication contextuelle d'interaction (☕ / 🦆), suit le joueur.
    this.hintText = this.add
      .text(0, 0, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '12px',
        color: '#11161d',
        backgroundColor: '#eef4f8',
        padding: { x: 8, y: 4 },
      })
      .setOrigin(0.5, 1)
      .setDepth(40)
      .setVisible(false);

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
  // Les visuels sont dessinés (Graphics, coins arrondis, ombres portées) ;
  // la physique utilise des zones invisibles (this.blockers), découplées.

  // Petit élément décoratif emoji (non bloquant).
  addEmoji(x, y, char, size = 24, depth = 1) {
    return this.add
      .text(x, y, char, { fontSize: `${size}px` })
      .setOrigin(0.5)
      .setDepth(depth);
  }

  // Étiquette de zone discrète (pastille type plan d'étage).
  addZoneLabel(x, y, text) {
    const t = this.add
      .text(x, y, text, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '11px',
        color: '#8fa6bd',
        backgroundColor: '#0d141cd9',
        padding: { x: 9, y: 4 },
      })
      .setOrigin(0.5)
      .setDepth(-6)
      .setAlpha(0.95);
    t.setLetterSpacing?.(2);
    return t;
  }

  // Obstacles physiques invisibles.
  addBlocker(x, y, w, h) {
    const z = this.add.zone(x, y, w, h);
    this.physics.add.existing(z, true);
    this.blockers.push(z);
    return z;
  }

  addBlockerCircle(x, y, r) {
    const z = this.add.zone(x, y, r * 2, r * 2);
    this.physics.add.existing(z, true);
    z.body.setCircle(r);
    this.blockers.push(z);
    return z;
  }

  drawFloor() {
    const g = this.add.graphics().setDepth(-10);
    const T = 64; // dalle de moquette

    // Moquette de bureau : damier très doux (deux teintes proches)
    g.fillStyle(0x1f2733, 1);
    g.fillRect(0, 0, WORLD.width, WORLD.height);
    g.fillStyle(0x222b38, 1);
    for (let y = 0; y < WORLD.height; y += T) {
      for (let x = (y / T) % 2 === 0 ? 0 : T; x < WORLD.width; x += T * 2) {
        g.fillRect(x, y, T, T);
      }
    }

    // Détente : parquet (lattes horizontales)
    g.fillStyle(0x2a3140, 1);
    g.fillRoundedRect(40, 40, 530, 300, 16);
    g.fillStyle(0x252c3a, 1);
    for (let y = 52; y < 322; y += 24) g.fillRect(52, y, 506, 12);

    // Réunion : moquette feutrée bleutée
    g.fillStyle(0x232f42, 1);
    g.fillRect(1068, 24, 508, 348);
    g.fillStyle(0x26334a, 1);
    for (let y = 24; y < 372; y += T) {
      for (let x = 1068 + ((y / T) % 2 === 0 ? 0 : T); x < 1576; x += T * 2) {
        g.fillRect(x, y, Math.min(T, 1576 - x), Math.min(T, 372 - y));
      }
    }

    // Café : carrelage chaud
    g.fillStyle(0x2b251e, 1);
    g.fillRoundedRect(1100, 710, 460, 250, 16);
    g.fillStyle(0x2f2922, 1);
    const C = 28;
    for (let y = 712; y < 958; y += C) {
      for (let x = 1102 + (Math.floor(y / C) % 2 === 0 ? 0 : C); x < 1558; x += C * 2) {
        g.fillRect(x, y, Math.min(C, 1558 - x), Math.min(C, 958 - y));
      }
    }

    // Tapis de la zone détente (deux tons + liseré)
    const rug = this.add.graphics().setDepth(-9);
    rug.fillStyle(0x2c3a50, 1);
    rug.fillEllipse(280, 205, 330, 190);
    rug.fillStyle(0x33445e, 1);
    rug.fillEllipse(280, 205, 270, 150);
    rug.lineStyle(2, 0x46587a, 0.8);
    rug.strokeEllipse(280, 205, 330, 190);

    // Étang (berge, eau, reflets, nénuphars)
    const pond = this.add.graphics().setDepth(-9);
    pond.fillStyle(0x152f42, 1);
    pond.fillEllipse(250, 800, 290, 182);
    pond.fillStyle(0x1d4e6e, 1);
    pond.fillEllipse(250, 800, 264, 158);
    pond.fillStyle(0x2a6e96, 0.9);
    pond.fillEllipse(244, 794, 200, 110);
    pond.lineStyle(2, 0x3b89b8, 0.35);
    pond.strokeEllipse(238, 792, 150, 70);
    pond.strokeEllipse(252, 800, 220, 120);
    pond.fillStyle(0x2f8a57, 1); // nénuphars
    pond.fillCircle(190, 830, 9);
    pond.fillCircle(322, 776, 7);
    pond.fillStyle(0x37a566, 1);
    pond.fillCircle(192, 828, 5);

    // Vignette douce pour la profondeur
    if (!this.textures.exists('vignette')) {
      const cv = this.textures.createCanvas('vignette', 512, 320);
      const ctx = cv.getContext();
      const grd = ctx.createRadialGradient(256, 160, 90, 256, 160, 310);
      grd.addColorStop(0, 'rgba(0,0,0,0)');
      grd.addColorStop(1, 'rgba(0,0,0,0.42)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, 512, 320);
      cv.refresh();
    }
    this.add
      .image(WORLD.width / 2, WORLD.height / 2, 'vignette')
      .setDisplaySize(WORLD.width + 120, WORLD.height + 90)
      .setDepth(-7);

    // Étiquettes de zones
    this.addZoneLabel(795, 374, 'OPEN-SPACE');
    this.addZoneLabel(1320, 354, 'RÉUNION');
    this.addZoneLabel(1330, 734, 'CAFÉ');
    this.addZoneLabel(280, 330, 'DÉTENTE');
  }

  // Mur avec biseau (haut/gauche clair, bas/droite sombre) — léger relief.
  drawWallSeg(g, x, y, w, h) {
    const l = x - w / 2;
    const t = y - h / 2;
    g.fillStyle(0x31404f, 1);
    g.fillRect(l, t, w, h);
    g.fillStyle(0x41546a, 1);
    g.fillRect(l, t, w, 3);
    g.fillRect(l, t, 3, h);
    g.fillStyle(0x24303c, 1);
    g.fillRect(l, t + h - 3, w, 3);
    g.fillRect(l + w - 3, t, 3, h);
  }

  buildWalls() {
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
    const g = this.add.graphics().setDepth(2);
    segs.forEach((s) => {
      this.drawWallSeg(g, s.x, s.y, s.w, s.h);
      this.addBlocker(s.x, s.y, s.w, s.h);
    });
  }

  // Chaise de bureau (siège + assise, avec ombre).
  drawChair(sh, g, x, y) {
    sh.fillStyle(0x000000, 0.22);
    sh.fillEllipse(x, y + 7, 26, 9);
    g.fillStyle(0x2c3a4a, 1);
    g.fillCircle(x, y, 11);
    g.fillStyle(0x3a4d63, 1);
    g.fillCircle(x, y - 1, 8);
  }

  // Plante en pot (pot + feuillage en grappes).
  drawPlant(sh, g, top, x, y) {
    sh.fillStyle(0x000000, 0.22);
    sh.fillEllipse(x, y + 12, 30, 10);
    g.fillStyle(0x70513a, 1);
    g.fillRoundedRect(x - 9, y + 2, 18, 12, 4);
    top.fillStyle(0x27693f, 1);
    top.fillCircle(x - 7, y - 6, 8);
    top.fillStyle(0x2f7d4f, 1);
    top.fillCircle(x + 7, y - 5, 8);
    top.fillStyle(0x37a566, 1);
    top.fillCircle(x, y - 12, 9);
    this.addBlockerCircle(x, y, 16);
  }

  buildFurniture() {
    const sh = this.add.graphics().setDepth(-1); // ombres portées
    const g = this.add.graphics().setDepth(0); // corps des meubles
    const top = this.add.graphics().setDepth(1); // plateaux et détails

    const shadow = (x, y, w, h) => {
      sh.fillStyle(0x000000, 0.25);
      sh.fillEllipse(x, y, w, h);
    };

    // ---- Open-space : deux rangées de bureaux avec écran, clavier, chaise ----
    [
      { y: 440, chairY: 396 },
      { y: 570, chairY: 614 },
    ].forEach((row) => {
      [620, 790, 960].forEach((x) => {
        shadow(x, row.y + 30, 140, 20);
        g.fillStyle(0x7a5c42, 1);
        g.fillRoundedRect(x - 65, row.y - 30, 130, 60, 10);
        g.fillStyle(0x8d6c4e, 1);
        g.fillRoundedRect(x - 58, row.y - 26, 116, 46, 8);
        top.fillStyle(0x10161d, 1); // écran
        top.fillRoundedRect(x - 17, row.y - 24, 34, 20, 3);
        top.fillStyle(0x3d5a80, 0.9);
        top.fillRect(x - 13, row.y - 20, 26, 12);
        top.fillStyle(0x10161d, 1); // pied
        top.fillRect(x - 3, row.y - 4, 6, 3);
        top.fillStyle(0x232f3c, 1); // clavier
        top.fillRoundedRect(x - 15, row.y + 4, 30, 9, 2);
        this.drawChair(sh, g, x, row.chairY);
        this.addBlocker(x, row.y, 130, 60);
      });
    });

    // ---- Salle de réunion : grande table, 8 chaises, écran mural ----
    shadow(1320, 252, 250, 24);
    g.fillStyle(0x6e523c, 1);
    g.fillRoundedRect(1200, 150, 240, 100, 14);
    g.fillStyle(0x82664c, 1);
    g.fillRoundedRect(1208, 156, 224, 88, 11);
    top.lineStyle(1, 0x95775a, 0.6);
    top.strokeRoundedRect(1208, 156, 224, 88, 11);
    [
      [1250, 130], [1320, 130], [1390, 130],
      [1250, 270], [1320, 270], [1390, 270],
      [1180, 200], [1460, 200],
    ].forEach(([cx, cy]) => this.drawChair(sh, g, cx, cy));
    this.addBlocker(1320, 200, 240, 100);
    top.fillStyle(0x10161d, 1); // écran mural
    top.fillRoundedRect(1220, 36, 200, 26, 4);
    top.fillStyle(0x16222e, 1);
    top.fillRect(1226, 40, 188, 18);
    this.addEmoji(1320, 49, '📊', 14, 2);

    // ---- Coin café : comptoir, machine, tabourets ----
    shadow(1330, 815, 270, 22);
    g.fillStyle(0x6e523c, 1);
    g.fillRoundedRect(1200, 768, 260, 44, 10);
    g.fillStyle(0x82664c, 1);
    g.fillRoundedRect(1206, 772, 248, 26, 8);
    top.fillStyle(0x1d242e, 1); // machine à café
    top.fillRoundedRect(1224, 766, 30, 34, 5);
    top.fillStyle(0xe74c3c, 1);
    top.fillCircle(1239, 774, 2.5);
    this.addEmoji(1312, 784, '☕', 16, 2);
    this.addEmoji(1392, 784, '🍩', 16, 2);
    this.addBlocker(1330, 790, 260, 44);
    [1260, 1330, 1400].forEach((x) => {
      shadow(x, 862, 22, 8);
      g.fillStyle(0x4a3a2c, 1);
      g.fillCircle(x, 856, 9);
      g.fillStyle(0x5d4a38, 1);
      g.fillCircle(x, 855, 6);
    });

    // ---- Zone détente : canapé, bibliothèque, fun ----
    shadow(170, 168, 150, 20);
    g.fillStyle(0x365081, 1); // coque
    g.fillRoundedRect(100, 112, 140, 58, 14);
    g.fillStyle(0x4a6da3, 1); // coussins
    g.fillRoundedRect(112, 132, 54, 32, 8);
    g.fillRoundedRect(174, 132, 54, 32, 8);
    g.fillStyle(0x3f5d8c, 1); // dossier
    g.fillRoundedRect(100, 112, 140, 18, 9);
    this.addBlocker(170, 140, 140, 56);

    shadow(445, 122, 160, 14);
    g.fillStyle(0x5a4632, 1); // bibliothèque
    g.fillRoundedRect(367, 89, 156, 32, 6);
    g.fillStyle(0x6b5540, 1);
    g.fillRoundedRect(373, 93, 144, 24, 4);
    [0xe06b8f, 0x5b8def, 0xf2c14e, 0x36c98f, 0xb06bd6].forEach((c, i) => {
      top.fillStyle(c, 1);
      top.fillRoundedRect(385 + i * 26, 95, 14, 20, 2);
    });
    this.addBlocker(445, 105, 156, 32);

    this.addEmoji(510, 250, '🎸', 30, 1);
    this.addEmoji(340, 235, '🐈', 26, 1); // le chat du bureau, en sieste

    // ---- Étang : canards interactifs (l'eau bloque le passage) ----
    this.addBlockerCircle(250, 800, 76);
    this.ducks = [
      { obj: this.addEmoji(225, 785, '🦆', 26, 1), home: { x: 225, y: 785 }, target: { x: 225, y: 785 } },
      { obj: this.addEmoji(300, 830, '🦆', 18, 1), home: { x: 300, y: 830 }, target: { x: 300, y: 830 } },
    ];

    // ---- Table de ping-pong ----
    shadow(760, 868, 220, 22);
    g.fillStyle(0x256b47, 1);
    g.fillRoundedRect(655, 775, 210, 110, 10);
    g.fillStyle(0x2c7a52, 1);
    g.fillRoundedRect(661, 780, 198, 100, 8);
    top.lineStyle(2, 0xe8f2ec, 0.95);
    top.strokeRoundedRect(661, 780, 198, 100, 8);
    top.fillStyle(0xe8f2ec, 1);
    top.fillRect(758, 780, 4, 100); // filet
    this.addEmoji(650, 770, '🏓', 22, 2);
    this.addBlocker(760, 830, 210, 110);

    // ---- Plantes vertes ----
    [
      [1020, 100], [600, 100], [80, 930], [1530, 440], [1520, 925],
    ].forEach(([x, y]) => this.drawPlant(sh, g, top, x, y));

    // ---- Petites touches drôles ----
    this.addEmoji(1000, 945, '🚧', 22, 1);
    this.addEmoji(545, 940, '🛹', 22, 1);
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
    this.addHat(bodyG, faceG, opts.hat);

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
  // Les lunettes sont ajoutées au visage pour suivre le regard.
  addHat(bodyG, faceG, hat) {
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
    } else if (hat === 'couronne') {
      const band = this.add.rectangle(0, -r + 2, 22, 8, 0xf2c14e);
      const points = [-7, 0, 7].map((dx) =>
        this.add.triangle(dx, -r - 4, 4, 0, 0, 8, 8, 8, 0xf2c14e)
      );
      const gem = this.add.circle(0, -r + 2, 2.2, 0xe06b8f);
      bodyG.add([band, ...points, gem]);
    } else if (hat === 'lunettes') {
      const left = this.add.circle(-5, -1, 4.6, 0x10161d);
      const right = this.add.circle(5, -1, 4.6, 0x10161d);
      const bridge = this.add.rectangle(0, -1.5, 4, 2, 0x10161d);
      const glint = this.add.circle(-6.5, -2.5, 1.3, 0xffffff, 0.4);
      faceG.add([left, right, bridge, glint]);
    } else if (hat === 'casque') {
      const band = this.add.arc(0, -4, r - 1, 180, 360, false).setStrokeStyle(5, 0x222a33);
      const cupL = this.add.circle(-r + 1, -2, 6, 0x222a33);
      const cupR = this.add.circle(r - 1, -2, 6, 0x222a33);
      const padL = this.add.circle(-r + 1, -2, 3, 0x3d5a80);
      const padR = this.add.circle(r - 1, -2, 3, 0x3d5a80);
      bodyG.add([band, cupL, cupR, padL, padR]);
    }
  }

  // Compagnon (emoji) : Container indépendant qui suit son maître.
  makePet(petId, x, y) {
    const def = PETS.find((p) => p.id === petId);
    if (!def) return null;
    const c = this.add.container(x, y).setDepth(9);
    const shadow = this.add.ellipse(0, 11, 26, 8, 0x000000, 0.25);
    const inner = this.add.container(0, 0);
    const sprite = this.add.text(0, 0, def.emoji, { fontSize: '24px' }).setOrigin(0.5);
    inner.add(sprite);
    c.add([shadow, inner]);
    c.setData('inner', inner);
    c.setData('phase', Math.random() * Math.PI * 2);
    return c;
  }

  // Le compagnon suit son maître avec un temps de retard, trottine et
  // regarde dans la direction du déplacement.
  updatePet(owner, time) {
    const pet = owner.getData('petC');
    if (!pet) return;
    const dir = owner.getData('dir') || { x: 0, y: 1 };
    const tx = owner.x - dir.x * 38;
    const ty = owner.y - dir.y * 38;
    pet.x = Phaser.Math.Linear(pet.x, tx, 0.08);
    pet.y = Phaser.Math.Linear(pet.y, ty, 0.08);

    const moving = Math.hypot(tx - pet.x, ty - pet.y) > 2.5;
    const inner = pet.getData('inner');
    const t = time / 1000;
    const ph = pet.getData('phase');
    inner.y = moving
      ? -Math.abs(Math.sin(t * 11 + ph)) * 2.5
      : -(Math.sin(t * 2.2 + ph) + 1) * 0.5;
    // La plupart des emojis animaux regardent vers la gauche nativement.
    if (Math.abs(dir.x) > 0.15) inner.scaleX = dir.x > 0 ? -1 : 1;
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

    // Danse : gros rebond + déhanché + petit squash, prioritaire sur le reste.
    if ((container.getData('danceUntil') || 0) > time) {
      const bounce = Math.abs(Math.sin(t * 11 + phase)) * 7;
      bodyG.y = -bounce;
      bodyG.angle = Math.sin(t * 9 + phase) * 16;
      bodyG.setScale(1 + Math.sin(t * 18 + phase) * 0.06, 1 - Math.sin(t * 18 + phase) * 0.06);
      shadow.setScale(1 - bounce * 0.03, 1 - bounce * 0.03);
      return;
    }
    bodyG.angle = 0;
    bodyG.setScale(1, 1);

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

    if (this.custom.pet !== 'none') {
      this.player.setData('petC', this.makePet(this.custom.pet, this.player.x + 30, this.player.y + 10));
    }

    this.physics.add.collider(this.player, this.blockers);
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
        pet: this.custom.pet,
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
      const pet = this.player.getData('petC');
      if (pet) {
        pet.x = you.x + 30;
        pet.y = you.y + 10;
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

    // Danse d'un autre participant.
    this.socket.on('dance', ({ id }) => {
      const o = this.others.get(id);
      if (o) this.startDance(o.container);
    });

    // Café d'un autre participant (☕ visible sur son avatar).
    this.socket.on('coffee', ({ id }) => {
      const o = this.others.get(id);
      if (o) {
        this.attachCoffee(o.container, 20000);
        this.spawnEmote(o.container, '☕');
      }
    });

    // Quelqu'un nourrit les canards : on rejoue la même scène.
    this.socket.on('feed', (p) => {
      if (typeof p?.x === 'number' && typeof p?.y === 'number') this.doFeed(p);
    });
  }

  // Lance la danse d'un avatar (~2,6 s) ; l'animation est jouée dans
  // animateAvatar tant que danceUntil n'est pas dépassé.
  startDance(container) {
    container.setData('danceUntil', this.time.now + 2600);
    this.spawnEmote(container, '🎶');
  }

  // ------------------------------------------------- interactions (touche E)

  COFFEE = { x: 1239, y: 783, range: 90 };
  POND = { x: 250, y: 800, feedRange: 200 };
  ROOM = { x: 1068, y: 380 }; // intérieur : x > ROOM.x && y < ROOM.y

  // La salle de réunion est privée : tous ceux à l'intérieur sont en
  // conversation entre eux, et isolés du reste de l'espace.
  inMeetingRoom(x, y) {
    return x > this.ROOM.x && y < this.ROOM.y;
  }

  nearCoffee() {
    return (
      Phaser.Math.Distance.Between(this.player.x, this.player.y, this.COFFEE.x, this.COFFEE.y) <
      this.COFFEE.range
    );
  }

  nearPond() {
    const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, this.POND.x, this.POND.y);
    return d < this.POND.feedRange && d > 70; // pas les pieds dans l'eau
  }

  tryInteract() {
    if (this.typing) return;
    if (this.nearCoffee()) this.drinkCoffee();
    else if (this.nearPond()) this.tryFeed();
  }

  // ----- Café : ☕ en main + boost de vitesse 20 s -----

  drinkCoffee() {
    if (this.time.now < this.coffeeUntil) return; // déjà un café en main
    this.coffeeUntil = this.time.now + 20000;
    this.attachCoffee(this.player, 20000);
    this.spawnEmote(this.player, '☕');
    this.socket?.emit('coffee');
  }

  // Accroche un ☕ à un avatar (objet niveau scène, suivi dans updateFloaters).
  attachCoffee(container, duration) {
    const obj = this.add
      .text(container.x + 22, container.y - 16, '☕', { fontSize: '15px' })
      .setOrigin(0.5)
      .setDepth(29);
    const entry = { owner: container, obj, dx: 22, dy: -16 };
    this.attachments.add(entry);
    this.time.delayedCall(duration, () => {
      obj.destroy();
      this.attachments.delete(entry);
    });
  }

  // ----- Canards : miettes + accourue + retour au bercail -----

  tryFeed() {
    if (this.time.now < this.feedCooldown) return;
    this.feedCooldown = this.time.now + 8000;
    const p = this.feedPoint(this.player.x, this.player.y);
    this.doFeed(p);
    this.socket?.emit('feed', p);
  }

  // Point de nourrissage : sur la berge, du côté du joueur.
  feedPoint(x, y) {
    const dx = x - this.POND.x;
    const dy = y - this.POND.y;
    const len = Math.hypot(dx, dy) || 1;
    return {
      x: Math.round(this.POND.x + (dx / len) * 105),
      y: Math.round(this.POND.y + (dy / len) * 64),
    };
  }

  doFeed({ x, y }) {
    // Miettes de pain
    for (let i = 0; i < 6; i++) {
      const c = this.add
        .circle(x + (Math.random() * 36 - 18), y + (Math.random() * 24 - 12), 2.2, 0xd9c9a0)
        .setDepth(1);
      this.tweens.add({ targets: c, alpha: 0, delay: 5200, duration: 800, onComplete: () => c.destroy() });
    }
    // Les canards accourent en cancanant, puis rentrent au bercail.
    this.ducks.forEach((d, i) => {
      d.target = { x: x + (i ? 20 : -14), y: y + (i ? 12 : -6) };
      const quack = this.add
        .text(d.obj.x, d.obj.y - 18, 'coin !', {
          fontSize: '11px',
          color: '#cfe0ee',
          backgroundColor: '#0d141ccc',
          padding: { x: 4, y: 2 },
        })
        .setOrigin(0.5, 1)
        .setDepth(30);
      this.tweens.add({ targets: quack, y: quack.y - 14, alpha: 0, duration: 1500, onComplete: () => quack.destroy() });
    });
    this.time.delayedCall(6500, () => {
      this.ducks.forEach((d) => {
        d.target = { ...d.home };
      });
    });
  }

  updateDucks() {
    this.ducks.forEach((d) => {
      d.obj.x = Phaser.Math.Linear(d.obj.x, d.target.x, 0.045);
      d.obj.y = Phaser.Math.Linear(d.obj.y, d.target.y, 0.045);
      const dx = d.target.x - d.obj.x;
      if (Math.abs(dx) > 1.5) d.obj.scaleX = dx > 0 ? -1 : 1; // l'emoji regarde à gauche
    });
  }

  // ----- Confettis quand on danse à 3+ au même endroit -----

  maybeConfetti(time) {
    if (time < this._confettiCd) return;
    const dancers = [];
    if ((this.player.getData('danceUntil') || 0) > time) dancers.push(this.player);
    this.others.forEach((o) => {
      if ((o.container.getData('danceUntil') || 0) > time) dancers.push(o.container);
    });
    if (dancers.length < 3) return;
    const cx = dancers.reduce((s, c) => s + c.x, 0) / dancers.length;
    const cy = dancers.reduce((s, c) => s + c.y, 0) / dancers.length;
    if (!dancers.every((c) => Phaser.Math.Distance.Between(c.x, c.y, cx, cy) < 220)) return;
    this._confettiCd = time + 4000;
    this.confettiBurst(cx, cy - 30);
  }

  confettiBurst(x, y) {
    for (let i = 0; i < 40; i++) {
      const r = this.add
        .rectangle(x, y, 5, 8, AVATAR_COLORS[i % AVATAR_COLORS.length])
        .setDepth(35);
      r.angle = Math.random() * 360;
      this.tweens.add({
        targets: r,
        x: x + (Math.random() * 280 - 140),
        y: y + 40 + Math.random() * 160,
        angle: r.angle + (Math.random() * 540 - 270),
        alpha: 0,
        duration: 1000 + Math.random() * 600,
        ease: 'Cubic.easeOut',
        onComplete: () => r.destroy(),
      });
    }
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

  // Fait suivre les bulles de chat et les objets accrochés (☕) à leur avatar.
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
    this.attachments.forEach((a) => {
      if (!a.owner.active) {
        a.obj.destroy();
        this.attachments.delete(a);
        return;
      }
      a.obj.setPosition(a.owner.x + a.dx, a.owner.y + a.dy);
    });
  }

  // Détruit les avatars distants (et leur chien/bulle) pour repartir d'un état
  // propre — appelé à chaque (re)connexion. Le joueur local est conservé.
  resetWorld() {
    this.others.forEach((o) => {
      o.container.getData('petC')?.destroy();
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
    if (p.pet && p.pet !== 'none') container.setData('petC', this.makePet(p.pet, p.x + 30, p.y + 10));
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
    o.container.getData('petC')?.destroy();
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

    // Entrée : focus le chat. Chiffres 1-6 : émotes rapides. X : danse !
    this.input.keyboard.on('keydown-ENTER', () => {
      if (!this.typing) this.social?.focusInput();
    });
    this.input.keyboard.on('keydown-X', () => {
      if (this.typing) return;
      this.startDance(this.player);
      this.socket?.emit('dance');
    });
    this.input.keyboard.on('keydown-E', () => this.tryInteract());
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
        fontFamily: 'system-ui, sans-serif',
        fontSize: '12px',
        color: '#cfe0ee',
        backgroundColor: '#0a0e13cc',
        padding: { x: 9, y: 6 },
        lineSpacing: 3,
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
    this.updateDucks();
    this.maybeConfetti(time);
    this.updateProximity();
    this.updateHint();
    this.updateHud();
  }

  // Indication contextuelle « E : … » près des points d'interaction.
  updateHint() {
    let text = '';
    if (this.nearCoffee() && this.time.now >= this.coffeeUntil) text = '☕ E : prendre un café';
    else if (this.nearPond() && this.time.now >= this.feedCooldown) text = '🦆 E : nourrir les canards';
    if (text) {
      this.hintText.setText(text);
      this.hintText.setPosition(this.player.x, this.player.y - (PLAYER.radius + 34));
      this.hintText.setVisible(true);
    } else {
      this.hintText.setVisible(false);
    }
  }

  // Met à jour direction du regard + rebond/respiration de chaque avatar,
  // et fait trottiner les chiens derrière leur maître.
  animateAvatars(time) {
    const pMoving = this.player.body.velocity.lengthSq() > 1;
    this.player.getData('dir').x = this.facing.x;
    this.player.getData('dir').y = this.facing.y;
    this.animateAvatar(this.player, pMoving, time);
    this.updatePet(this.player, time);

    this.others.forEach((o) => {
      const dir = o.container.getData('dir');
      const moving = Math.hypot(o.container.x - o.tx, o.container.y - o.ty) > 0.6;
      dir.x = o.dir?.x ?? 0;
      dir.y = o.dir?.y ?? 1;
      this.animateAvatar(o.container, moving, time);
      this.updatePet(o.container, time);
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

    // Boost café : +35 % de vitesse tant que le ☕ est en main.
    const speed = this.time.now < this.coffeeUntil ? PLAYER.speed * 1.35 : PLAYER.speed;
    const v = new Phaser.Math.Vector2(vx, vy);
    if (v.lengthSq() > 0) {
      v.normalize().scale(speed);
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
    const myIn = this.inMeetingRoom(px, py);

    if (this.showBubble && !myIn) {
      this.fx.lineStyle(2, COLORS.bubble, 0.35);
      this.fx.strokeCircle(px, py, r);
    }

    this.nearby = [];
    this.others.forEach((o) => {
      const bx = o.container.x;
      const by = o.container.y;
      // Salle de réunion privée : tous ceux à l'intérieur sont en conversation
      // entre eux quelle que soit la distance, et isolés de l'extérieur.
      const oIn = this.inMeetingRoom(bx, by);
      const inRange =
        myIn || oIn ? myIn && oIn : Phaser.Math.Distance.Between(px, py, bx, by) <= r;

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
    const net = this.online ? `🟢 ${this.others.size + 1} en ligne` : '🔴 hors-ligne';
    const media = !this.mediaToken ? '' : this.media?.connected ? '  ·  🎥' : '  ·  💤';
    this.hud.setText(
      [
        `${this.pseudo}  ·  ${net}${media}`,
        `ZQSD/flèches  ·  Chat : ⏎  ·  Émotes : 1-6  ·  Danse : X  ·  Action : E  ·  Bulle : P`,
      ].join('\n')
    );

    this.status.setY(this.scale.height - 44);
    const inRoom = this.inMeetingRoom(this.player.x, this.player.y);
    if (inRoom) {
      this.status.setColor('#9bb8e8');
      this.status.setText(
        this.nearby.length
          ? `🔒 Salle de réunion privée — avec : ${this.nearby.join(', ')}`
          : '🔒 Salle de réunion privée — seul pour l\'instant'
      );
    } else if (this.nearby.length) {
      this.status.setColor('#36c98f');
      this.status.setText(`🟢 En conversation avec : ${this.nearby.join(', ')}`);
    } else {
      this.status.setColor('#8a9bb0');
      this.status.setText("⚪️ Personne à proximité — approche-toi d'un collègue");
    }
  }
}
