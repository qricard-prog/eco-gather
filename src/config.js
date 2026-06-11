// Constantes de calibration du prototype.
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
  botActive: 0xf2c14e,
  bubble: 0x36c98f,
  label: '#e6edf3',
  labelBg: 0x0d141c,
};

// Couleurs d'avatar proposées à l'entrée (partagées avec l'aperçu HTML).
export const AVATAR_COLORS = [
  0x36c98f, // vert
  0x5b8def, // bleu
  0xf2c14e, // jaune
  0xe06b8f, // rose
  0xb06bd6, // violet
  0x4fd6c8, // turquoise
  0xf08a4b, // orange
];

// Accessoires de tête disponibles (id stable côté réseau).
export const HATS = ['none', 'casquette', 'hautdeforme', 'fete', 'couronne', 'lunettes', 'casque'];

// Compagnons disponibles (id réseau + emoji affiché en jeu et en aperçu).
export const PETS = [
  { id: 'chien', emoji: '🐕', label: 'Chien' },
  { id: 'dino', emoji: '🦖', label: 'Dino' },
  { id: 'wombat', emoji: '🦡', label: 'Wombat' },
  { id: 'kangourou', emoji: '🦘', label: 'Kangourou' },
  { id: 'perroquet', emoji: '🦜', label: 'Perroquet' },
  { id: 'poubelle', emoji: '🗑️', label: 'Poubelle' },
];
