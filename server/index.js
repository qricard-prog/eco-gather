// Serveur de signaling « positions » + tokens LiveKit — Étapes 2 & 3.
// Node + Express + Socket.io. État en mémoire, réinitialisé au redémarrage.
// Aucune persistance, aucune base de données (cf. brief).

// Charge les variables d'environnement depuis .env si le fichier existe
// (clés LiveKit notamment). Sans .env, le serveur fonctionne quand même
// pour les positions (le média est juste désactivé).
try {
  process.loadEnvFile();
} catch {
  /* pas de .env : OK */
}

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { AccessToken } from 'livekit-server-sdk';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const LIVEKIT_ROOM = 'eco-gather'; // un seul « espace » LiveKit pour le POC

const app = express();

// CORS simple (utile en prod quand le front est sur une autre origine ;
// en dev tout passe par le proxy Vite, donc same-origin).
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/health', (_req, res) =>
  res.json({ ok: true, players: players.size, livekit: livekitReady() })
);

// Le média (audio/vidéo/partage) n'est actif que si les 3 clés sont présentes.
function livekitReady() {
  return Boolean(
    process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET && process.env.LIVEKIT_URL
  );
}

// Génère un token d'accès LiveKit. La clé secrète ne quitte JAMAIS le serveur :
// le front ne reçoit que le JWT signé + l'URL du projet.
app.get('/token', async (req, res) => {
  if (!livekitReady()) {
    return res.status(503).json({ error: 'LiveKit non configuré (clés manquantes)' });
  }
  const identity = String(req.query.identity || '').slice(0, 64);
  const name = String(req.query.name || 'Invité').slice(0, 16);
  if (!identity) return res.status(400).json({ error: 'identity requis' });

  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity,
    name,
    ttl: '2h',
  });
  at.addGrant({
    roomJoin: true,
    room: LIVEKIT_ROOM,
    canPublish: true,
    canSubscribe: true,
  });

  const token = await at.toJwt();
  res.json({ token, url: process.env.LIVEKIT_URL, room: LIVEKIT_ROOM });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }, // POC : front et serveur sur des origines différentes en prod
});

// socketId -> { id, pseudo, x, y, dir, color, hat, dog }
const players = new Map();

// Palette de secours si le client n'envoie pas de couleur valide.
const PALETTE = [0x36c98f, 0x5b8def, 0xf2c14e, 0xe06b8f, 0xb06bd6, 0x4fd6c8, 0xf08a4b];
// Doit rester synchro avec src/config.js
const HATS = ['none', 'casquette', 'hautdeforme', 'fete', 'couronne', 'lunettes', 'casque'];
const PETS = ['none', 'chien', 'dino', 'wombat', 'kangourou', 'perroquet', 'poubelle'];
let colorCursor = 0;
function nextColor() {
  const c = PALETTE[colorCursor % PALETTE.length];
  colorCursor += 1;
  return c;
}

// Point d'apparition aléatoire dans l'allée centrale (zone dégagée du décor).
function spawnPoint() {
  return {
    x: Math.round(580 + Math.random() * 400),
    y: Math.round(600 + Math.random() * 90),
  };
}

io.on('connection', (socket) => {
  socket.on('join', ({ pseudo, color, hat, pet } = {}) => {
    const { x, y } = spawnPoint();
    const player = {
      id: socket.id,
      pseudo: (pseudo || 'Invité').slice(0, 16),
      x,
      y,
      dir: { x: 0, y: 1 },
      // Personnalisation choisie à l'entrée (validée côté serveur).
      color: Number.isInteger(color) && color >= 0 && color <= 0xffffff ? color : nextColor(),
      hat: HATS.includes(hat) ? hat : 'none',
      pet: PETS.includes(pet) ? pet : 'none',
    };
    players.set(socket.id, player);

    // Renvoie au nouveau venu son identité + la liste des présents.
    socket.emit('init', {
      you: player,
      players: [...players.values()].filter((p) => p.id !== socket.id),
    });
    // Préviens les autres.
    socket.broadcast.emit('player-joined', player);

    console.log(`[+] ${player.pseudo} (${socket.id.slice(0, 5)}) — ${players.size} en ligne`);
  });

  socket.on('move', ({ x, y, dir } = {}) => {
    const p = players.get(socket.id);
    if (!p) return;
    p.x = x;
    p.y = y;
    if (dir) p.dir = dir;
    // On ne renvoie pas au même client (il connaît déjà sa position).
    socket.broadcast.emit('player-moved', { id: socket.id, x, y, dir: p.dir });
  });

  // Chat texte (diffusé à tous les autres ; l'émetteur l'affiche localement).
  socket.on('chat', ({ text } = {}) => {
    const p = players.get(socket.id);
    if (!p) return;
    const clean = String(text || '').slice(0, 200).trim();
    if (!clean) return;
    socket.broadcast.emit('chat', { id: socket.id, pseudo: p.pseudo, color: p.color, text: clean });
  });

  // Émotes / réactions (liste blanche, doit rester synchro avec src/social.js).
  const EMOTES = ['👋', '👍', '🎉', '❤️', '😂', '🤔'];
  socket.on('emote', ({ emoji } = {}) => {
    if (!players.has(socket.id) || !EMOTES.includes(emoji)) return;
    socket.broadcast.emit('emote', { id: socket.id, emoji });
  });

  // Danse : simple signal relayé, l'animation est jouée par chaque client.
  socket.on('dance', () => {
    if (players.has(socket.id)) socket.broadcast.emit('dance', { id: socket.id });
  });

  // Café : l'avatar tient un ☕ (et gagne un petit boost côté client).
  socket.on('coffee', () => {
    if (players.has(socket.id)) socket.broadcast.emit('coffee', { id: socket.id });
  });

  // Nourrissage des canards : chaque client rejoue la scène au même endroit.
  socket.on('feed', ({ x, y } = {}) => {
    if (!players.has(socket.id)) return;
    if (typeof x !== 'number' || typeof y !== 'number') return;
    socket.broadcast.emit('feed', { x, y });
  });

  // Hot-dog : l'avatar de l'émetteur grossit chez tout le monde.
  socket.on('eat', () => {
    if (players.has(socket.id)) socket.broadcast.emit('eat', { id: socket.id });
  });

  // Haltères : l'avatar de l'émetteur bombe les biceps chez tout le monde.
  socket.on('flex', () => {
    if (players.has(socket.id)) socket.broadcast.emit('flex', { id: socket.id });
  });

  // Vélo : les roues du boost apparaissent chez tout le monde.
  socket.on('bike', () => {
    if (players.has(socket.id)) socket.broadcast.emit('bike', { id: socket.id });
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    players.delete(socket.id);
    io.emit('player-left', { id: socket.id });
    if (p) console.log(`[-] ${p.pseudo} parti — ${players.size} en ligne`);
  });
});

// En production, le serveur sert aussi le front compilé (mono-service) :
// le client se connecte alors en same-origin, pas de CORS ni d'URL séparée.
// En dev, `dist/` peut ne pas exister → on ne monte rien (Vite sert le front).
const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  // Fallback SPA : toute autre route GET renvoie l'app (les routes API sont au-dessus).
  app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  console.log('   front compilé servi depuis /dist');
}

httpServer.listen(PORT, () => {
  console.log(`🌿 Eco-Gather sur http://localhost:${PORT}`);
  console.log(
    livekitReady()
      ? `   média LiveKit activé (${process.env.LIVEKIT_URL})`
      : '   média LiveKit désactivé (clés absentes — positions seules)'
  );
});
