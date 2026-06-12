import Phaser from 'phaser';
import GameScene from './scenes/GameScene.js';
import { WORLD, COLORS, AVATAR_COLORS, HATS, PETS } from './config.js';

// Le jeu n'est lancé qu'une fois le pseudo saisi (écran d'accueil HTML).
function startGame(pseudo, custom) {
  const config = {
    type: Phaser.AUTO,
    parent: 'app',
    backgroundColor: COLORS.floor,
    pixelArt: false,
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: '100%',
      height: '100%',
    },
    physics: {
      default: 'arcade',
      arcade: { debug: false },
    },
    scene: [GameScene],
  };

  const game = new Phaser.Game(config);
  game.scene.start('GameScene', { pseudo, ...custom });
  // En dev uniquement : expose le jeu pour le debug en console.
  if (import.meta.env.DEV) window.ecoGame = game;
  return game;
}

// --- Écran d'accueil : pseudo + personnalisation de l'avatar ---
const intro = document.getElementById('intro');
const input = document.getElementById('pseudo');
const button = document.getElementById('enter');
const swatchesEl = document.getElementById('swatches');
const hatsEl = document.getElementById('hats');
const petsEl = document.getElementById('pets');
const preview = document.getElementById('preview');

const custom = { color: AVATAR_COLORS[0], hat: 'none', pet: 'none' };

const hex = (c) => '#' + c.toString(16).padStart(6, '0');

// Pastilles de couleurs
AVATAR_COLORS.forEach((c, i) => {
  const b = document.createElement('button');
  b.className = 'swatch' + (i === 0 ? ' sel' : '');
  b.style.background = hex(c);
  b.setAttribute('aria-label', `Couleur ${hex(c)}`);
  b.addEventListener('click', () => {
    custom.color = c;
    swatchesEl.querySelectorAll('.swatch').forEach((s) => s.classList.remove('sel'));
    b.classList.add('sel');
    drawPreview();
  });
  swatchesEl.appendChild(b);
});

// Accessoires (chapeaux)
hatsEl.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    custom.hat = chip.dataset.hat;
    hatsEl.querySelectorAll('.chip').forEach((c) => c.classList.remove('sel'));
    chip.classList.add('sel');
    drawPreview();
  });
});

// Compagnons : chips générées depuis la config (+ « Aucun » déjà présent).
PETS.forEach((p) => {
  const b = document.createElement('button');
  b.className = 'chip';
  b.dataset.pet = p.id;
  b.textContent = `${p.emoji} ${p.label}`;
  petsEl.appendChild(b);
});
petsEl.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    custom.pet = chip.dataset.pet;
    petsEl.querySelectorAll('.chip').forEach((c) => c.classList.remove('sel'));
    chip.classList.add('sel');
    drawPreview();
  });
});

// --- Profil mémorisé : pseudo + avatar restaurés d'une visite à l'autre ---
const PROFILE_KEY = 'eco-profile';

function syncUIFromCustom() {
  [...swatchesEl.querySelectorAll('.swatch')].forEach((b, i) =>
    b.classList.toggle('sel', AVATAR_COLORS[i] === custom.color)
  );
  hatsEl.querySelectorAll('.chip').forEach((c) =>
    c.classList.toggle('sel', c.dataset.hat === custom.hat)
  );
  petsEl.querySelectorAll('.chip').forEach((c) =>
    c.classList.toggle('sel', c.dataset.pet === custom.pet)
  );
  drawPreview();
}

try {
  const saved = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
  if (saved) {
    if (typeof saved.pseudo === 'string') input.value = saved.pseudo.slice(0, 16);
    if (AVATAR_COLORS.includes(saved.color)) custom.color = saved.color;
    if (HATS.includes(saved.hat)) custom.hat = saved.hat;
    if (saved.pet === 'none' || PETS.some((p) => p.id === saved.pet)) custom.pet = saved.pet;
    syncUIFromCustom();
  }
} catch {
  /* profil corrompu : on repart de zéro */
}

// --- Aperçu de l'avatar (même style que le rendu Phaser en jeu) ---
function drawPreview() {
  const ctx = preview.getContext('2d');
  const W = preview.width;
  const H = preview.height;
  ctx.clearRect(0, 0, W, H);

  const cx = custom.pet !== 'none' ? W / 2 - 22 : W / 2;
  const cy = H / 2 + 8;
  const r = 26;

  // Ombre
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + r + 4, r * 0.95, r * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();

  // Corps
  ctx.fillStyle = hex(custom.color);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Reflet
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.beginPath();
  ctx.ellipse(cx, cy - r * 0.4, r * 0.55, r * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();

  // Yeux (regard vers le bas, comme à l'arrivée en jeu)
  const eye = (ex) => {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx + ex, cy + 5, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#12202c';
    ctx.beginPath();
    ctx.arc(cx + ex, cy + 6, 2.4, 0, Math.PI * 2);
    ctx.fill();
  };
  eye(-8);
  eye(8);

  // Chapeau
  if (custom.hat === 'casquette') {
    ctx.fillStyle = '#e74c3c';
    ctx.beginPath();
    ctx.arc(cx, cy - r + 7, r - 5, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(cx + 4, cy - r + 3, r, 7);
  } else if (custom.hat === 'hautdeforme') {
    ctx.fillStyle = '#222a33';
    ctx.fillRect(cx - r * 0.95, cy - r - 1, r * 1.9, 6);
    ctx.fillRect(cx - r * 0.55, cy - r - 23, r * 1.1, 23);
    ctx.fillStyle = '#e74c3c';
    ctx.fillRect(cx - r * 0.55, cy - r - 8, r * 1.1, 6);
  } else if (custom.hat === 'fete') {
    ctx.fillStyle = '#f2c14e';
    ctx.beginPath();
    ctx.moveTo(cx, cy - r - 24);
    ctx.lineTo(cx - 13, cy - r + 6);
    ctx.lineTo(cx + 13, cy - r + 6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#e06b8f';
    ctx.beginPath();
    ctx.arc(cx, cy - r - 24, 5, 0, Math.PI * 2);
    ctx.fill();
  } else if (custom.hat === 'couronne') {
    ctx.fillStyle = '#f2c14e';
    ctx.fillRect(cx - 17, cy - r - 2, 34, 11);
    [-12, 0, 12].forEach((dx) => {
      ctx.beginPath();
      ctx.moveTo(cx + dx, cy - r - 16);
      ctx.lineTo(cx + dx - 7, cy - r - 2);
      ctx.lineTo(cx + dx + 7, cy - r - 2);
      ctx.closePath();
      ctx.fill();
    });
    ctx.fillStyle = '#e06b8f';
    ctx.beginPath();
    ctx.arc(cx, cy - r + 3, 3.2, 0, Math.PI * 2);
    ctx.fill();
  } else if (custom.hat === 'lunettes') {
    ctx.fillStyle = '#10161d';
    [-8, 8].forEach((dx) => {
      ctx.beginPath();
      ctx.arc(cx + dx, cy + 5, 7.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillRect(cx - 4, cy + 3, 8, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.arc(cx - 10, cy + 3, 2.2, 0, Math.PI * 2);
    ctx.fill();
  } else if (custom.hat === 'casque') {
    ctx.strokeStyle = '#222a33';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(cx, cy - 6, r - 1, Math.PI, 0);
    ctx.stroke();
    ctx.fillStyle = '#222a33';
    [-r + 2, r - 2].forEach((dx) => {
      ctx.beginPath();
      ctx.arc(cx + dx, cy - 3, 9, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = '#3d5a80';
    [-r + 2, r - 2].forEach((dx) => {
      ctx.beginPath();
      ctx.arc(cx + dx, cy - 3, 4.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Compagnon (même emoji qu'en jeu)
  if (custom.pet !== 'none') {
    const pet = PETS.find((p) => p.id === custom.pet);
    if (pet) {
      const dx = cx + 60;
      const dy = cy + 18;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(dx, dy + 14, 17, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '32px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pet.emoji, dx, dy);
    }
  }
}

drawPreview();
input.focus();

function enter() {
  const pseudo = (input.value || '').trim() || 'Moi';
  localStorage.setItem(PROFILE_KEY, JSON.stringify({ pseudo, ...custom }));
  intro.classList.add('hidden');
  startGame(pseudo, { ...custom });
}

button.addEventListener('click', enter);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') enter();
});

// Pour info / debug : taille du monde dispo en console.
console.info(`[Eco-Gather] Monde ${WORLD.width}×${WORLD.height}px`);
