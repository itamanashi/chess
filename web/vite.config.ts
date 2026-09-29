import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Port FIXE : sans strictPort, Vite glisse silencieusement vers 5174+
    // quand 5173 est occupé, et l'onglet resté sur 5173 semble « ne jamais
    // s'updater ». Ici : toujours 5173, ou erreur explicite (un serveur
    // tourne déjà → le garder, pas en relancer un).
    port: 5173,
    strictPort: true,
    // Isolation cross-origin REQUISE par le Stockfish 19 threadé
    // (`public/sf19/`, SharedArrayBuffer) : sans ces en-têtes le moteur
    // démarre mais ne répond jamais (silence total). Toute mise en prod
    // (preview, hébergeur statique) doit servir les MÊMES en-têtes.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // Mêmes en-têtes en preview : sans isolation, SharedArrayBuffer est
  // indisponible et Stockfish retombe en mono-thread (repli automatique).
  preview: {
    port: 5173,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
