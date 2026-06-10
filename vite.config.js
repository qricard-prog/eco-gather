import { defineConfig } from 'vite';

// En dev, on proxifie le canal Socket.io vers le serveur de signaling (port 3001)
// pour que le client se connecte en same-origin (io() sans URL).
export default defineConfig({
  server: {
    host: true, // accessible sur le réseau local en dev
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
      // Endpoint de génération des tokens LiveKit (côté serveur de signaling).
      '/token': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
  },
});
