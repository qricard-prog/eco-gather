// Constantes de calibration du prototype.
// L'Étape 1 sert justement à régler ces valeurs « au feeling ».
// La plupart sont ajustables en direct au clavier (voir GameScene).

export const WORLD = {
  width: 1600,
  height: 1000,
};

export const PLAYER = {
  speed: 220, // px/s
  radius: 16,
};

export const PROXIMITY = {
  // Distance (entre centres) en-dessous de laquelle deux avatars
  // « entrent en conversation ». Ajustable avec [ et ].
  radius: 130,
  min: 60,
  max: 320,
  step: 10,
};

export const COLORS = {
  floor: 0x141c26,
  grid: 0x1d2935,
  wall: 0x33475e,
  wallStroke: 0x4a6680,
  desk: 0x6b4f3a,
  deskTop: 0x8a6a4f,
  plant: 0x2f7d4f,
  rug: 0x223344,
  player: 0x36c98f,
  bot: 0x5b8def,
  botActive: 0xf2c14e,
  bubble: 0x36c98f,
  label: '#e6edf3',
  labelBg: 0x0d141c,
};

// Affiche les bots (PNJ statiques) en plus des vrais participants réseau.
// Pratique pour la démo solo ; mettre à false pour un espace « 100 % réel ».
export const SHOW_BOTS = true;

// Les « collègues » simulés (PNJ statiques) de l'Étape 1.
export const BOTS = [
  { name: 'Léa', x: 380, y: 300, color: 0x5b8def },
  { name: 'Karim', x: 1180, y: 320, color: 0xb06bd6 },
  { name: 'Sophie', x: 760, y: 760, color: 0xe06b8f },
];
