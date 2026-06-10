import Phaser from 'phaser';
import GameScene from './scenes/GameScene.js';
import { WORLD, COLORS, AVATAR_COLORS } from './config.js';

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
const dogToggle = document.getElementById('dog-toggle');
const preview = document.getElementById('preview');

const custom = { color: AVATAR_COLORS[0], hat: 'none', dog: false };

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

// Compagnon
dogToggle.addEventListener('click', () => {
  custom.dog = !custom.dog;
  dogToggle.classList.toggle('sel', custom.dog);
  drawPreview();
});

// --- Aperçu de l'avatar (même style que le rendu Phaser en jeu) ---
function drawPreview() {
  const ctx = preview.getContext('2d');
  const W = preview.width;
  const H = preview.height;
  ctx.clearRect(0, 0, W, H);

  const cx = custom.dog ? W / 2 - 22 : W / 2;
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
  }

  // Petit chien
  if (custom.dog) {
    const dx = cx + 62;
    const dy = cy + 16;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(dx, dy + 12, 16, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8d6e4a';
    ctx.beginPath();
    ctx.ellipse(dx - 4, dy, 13, 8, 0, 0, Math.PI * 2); // corps
    ctx.fill();
    ctx.beginPath();
    ctx.arc(dx + 10, dy - 6, 9, 0, Math.PI * 2); // tête
    ctx.fill();
    // oreilles
    ctx.fillStyle = '#6d5238';
    ctx.beginPath();
    ctx.moveTo(dx + 4, dy - 13);
    ctx.lineTo(dx + 7, dy - 21);
    ctx.lineTo(dx + 11, dy - 13);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(dx + 12, dy - 14);
    ctx.lineTo(dx + 15, dy - 21);
    ctx.lineTo(dx + 18, dy - 12);
    ctx.closePath();
    ctx.fill();
    // queue
    ctx.beginPath();
    ctx.moveTo(dx - 16, dy - 2);
    ctx.lineTo(dx - 23, dy - 9);
    ctx.lineTo(dx - 13, dy - 6);
    ctx.closePath();
    ctx.fill();
    // œil + truffe
    ctx.fillStyle = '#12202c';
    ctx.beginPath();
    ctx.arc(dx + 13, dy - 7, 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2b2b2b';
    ctx.beginPath();
    ctx.arc(dx + 18.5, dy - 4.5, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

drawPreview();
input.focus();

function enter() {
  const pseudo = (input.value || '').trim() || 'Moi';
  intro.classList.add('hidden');
  startGame(pseudo, { ...custom });
}

button.addEventListener('click', enter);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') enter();
});

// Pour info / debug : taille du monde dispo en console.
console.info(`[Eco-Gather] Monde ${WORLD.width}×${WORLD.height}px`);
