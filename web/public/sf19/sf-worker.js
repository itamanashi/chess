/**
 * Bootstrap du Stockfish local dans un Web Worker (module ES).
 *
 * Moteur : Stockfish 19 smallnet (`@lichess-org/stockfish-web`, le même que
 * l'analyse Lichess — réseau ~1,2 Mo à part, chargé ci-dessous).
 * Protocole volontairement identique à l'ancien `stockfish.wasm.js` : texte
 * UCI via postMessage, `quit` ferme le worker. `localEngine.ts` est donc
 * inchangé (seules l'URL et `{ type: 'module' }` changent).
 *
 * Les messages postés pendant l'init (chargement wasm + réseau NNUE) sont
 * bufferisés par la plateforme et traités une fois `onmessage` posé.
 */
import createStockfish from './sf_19_smallnet.js';

// Les commandes postées pendant l'init (wasm + NNUE, plusieurs awaits)
// seraient distribuées AVANT qu'onmessage soit posé, donc perdues.
// File d'attente précoce, drainée à la fin de l'init (synchrone : aucune
// commande ne peut s'intercaler entre le drain et la réassignation).
const earlyQueue = [];
onmessage = (e) => {
  earlyQueue.push(e.data);
};

const sf = await createStockfish();

sf.listen = (line) => postMessage(line);
sf.onError = (msg) => {
  console.error('[sf19]', msg);
};

// Réseau(x) NNUE recommandé(s) par le moteur lui-même (noms stables,
// checksum dans le nom : `nn-<sha256[:12]>.nnue`). Boucle générique comme
// `tools/wasm-cli.ts` : 1 réseau pour ce build smallnet.
for (let index = 0; ; index++) {
  const name = sf.getRecommendedNnue(index);
  if (!name) break;
  const res = await fetch(name);
  if (!res.ok) throw new Error(`[sf19] NNUE introuvable : ${name} (${res.status})`);
  sf.setNnueBuffer(new Uint8Array(await res.arrayBuffer()), index);
}

const handle = (cmd) => {
  if (cmd === 'quit') {
    close();
    return;
  }
  sf.uci(cmd);
};
for (const cmd of earlyQueue) handle(cmd);
onmessage = (e) => handle(e.data);
