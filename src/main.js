import Phaser from 'phaser';
import GameScene from './scenes/GameScene.js';
import { WORLD, COLORS } from './config.js';

// Le jeu n'est lancé qu'une fois le pseudo saisi (écran d'accueil HTML).
function startGame(pseudo) {
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
  game.scene.start('GameScene', { pseudo });
  // En dev uniquement : expose le jeu pour le debug en console.
  if (import.meta.env.DEV) window.ecoGame = game;
  return game;
}

// --- Écran d'accueil : saisie du pseudo ---
const intro = document.getElementById('intro');
const input = document.getElementById('pseudo');
const button = document.getElementById('enter');

input.focus();

function enter() {
  const pseudo = (input.value || '').trim() || 'Moi';
  intro.classList.add('hidden');
  startGame(pseudo);
}

button.addEventListener('click', enter);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') enter();
});

// Pour info / debug : taille du monde dispo en console.
console.info(`[Eco-Gather] Monde ${WORLD.width}×${WORLD.height}px`);
