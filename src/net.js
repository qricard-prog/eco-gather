// Petit wrapper autour de socket.io-client.
// En dev : VITE_SERVER_URL vide → connexion same-origin, proxifiée vers le
// serveur de signaling par Vite (voir vite.config.js).
// En prod : définir VITE_SERVER_URL = URL du serveur déployé (Fly/Railway).

import { io } from 'socket.io-client';

const URL = import.meta.env.VITE_SERVER_URL || undefined;

export function connect() {
  return io(URL, {
    autoConnect: true,
    reconnection: true,
  });
}
