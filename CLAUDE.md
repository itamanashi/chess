# Chess Repertoire Studio

Application d'étude d'ouvertures d'échecs basée sur Lichess Masters avec exploration interactive, entraînement et cache local.

## Architecture

### Backend (Python)
- **main.py** : API Lichess Masters avec authentification token Bearer
- **repertoire.py** : Construction récursive d'arbres d'ouvertures (depth, max-moves, filter par min-parties)
- **build_repertoire.py** : Construction interactive (choix utilisateur + réponses API)
- **db_cache.py** : Cache SQLite local indexé par position normalisée (4 premiers champs FEN)
- **board_html.py** : Rendu HTML/JavaScript du plateau

### Frontend (Vite + React)
- **web/** : Application moderne avec interface Chessground
- **app.py** : Interface Streamlit (legacy)

## Patterns clés

### Normalisation de positions
```python
# FEN normalisée ignores EP fantôme et compteurs
pos_key = " ".join(chess.Board(fen).fen().split()[:4])
```

### Normalisation UCI des roques
Lichess API renvoie roque en notation Chess960 (e1h1) vs python-chess standard (e1g1) :
```python
ROQUES_UCI = {"e1h1": "e1g1", "e1a1": "e1c1", "e8h8": "e8g8", "e8a8": "e8c8"}
```

### Modes répertoire
- **blancs** : 1 coup aux blancs (top N), N coups aux noirs
- **noirs** : N coups aux blancs, 1 coup aux noirs
- **tous** : N coups à chaque position

### Règles de génération auto — NE PAS VIOLER (choix utilisateur explicite)
- Génération **fréquentiste pure** : sélection par couverture/popularité Explorer à l'Elo cible (`services/autoRepertoire.ts`). **Jamais** de réécriture par winrate ni par moteur dans la boucle de génération (ni sélection, ni priorité, ni élagage par défaut : `pruneMinLineValue: 0`, opt-in `Qualité mini (LV)`).
- **Seule exception : le mat.** Fin forcée ≠ avis : `#` Explorer + mat-en-1 légal (`findMateInOneUcis`, chess.js, sans moteur) → inclusion garantie même sous les seuils, priorité `MATE_PRIORITY_BONUS`, flag `isMate` (types + pastille CSS `mate-tag` + jamais élagué + préservé par `mergeAutoRoot`). Mat en N>1 = moteur = analyse manuelle uniquement (`trapPotential`, `localEngine`), jamais dans le BFS.
- **Exception explicite utilisateur (2026-09-25) : gradient Elo sur NOS répliques.** En modes blancs/noirs, à notre tour, l'unique réplique gardée = argmax `qualityScore` (part locale × lift vs Maîtres, ×3 max / ×0.1 min, repli popularité si réf < 30 parties) au lieu du top-1 popularité brute — sans winrate (`white/draws/black` jamais lus) ni moteur. Double lecture Masters par position à nous (compteurs `refCached`/`refApi`, pause `gapMs`, échec réf = dégradation silencieuse, jamais d'abandon) — SAUF juge moteur actif : Stockfish tranche seul, zéro lecture Masters. Adversaire toujours pool cible uniquement (jamais de double lecture), mode `both` et endpoint Masters inchangés (pas de double lecture).
- **Exception explicite utilisateur (2026-09-25) : juge moteur OPT-IN sur NOS répliques.** Quand la case « Répliques moteur » est cochée, à nos positions le Stockfish local (worker, `analyzeLocalFen` MultiPV 6 / D14, `priority: background`, 6 s/nœud) classe les coups joués : garde les équivalents (±30 cp, multi-répliques, jamais de top-1 forcé), départage par re-creusage profond (D20, ±10 cp, 10 s) seulement si le top-2 est à ≤15 cp ; sinon l'élargi est gardé et le BFS creuse chaque ligne via l'API. Aveugle/partiel/évincé → repli gradient (compteur `engineFallbacks`, jamais d'abandon) ; `Arrêter` se propage. Juge injectable (`EngineJudgeSettings.judge`, tests sans worker) ; service sans import moteur (zéro cycle). Compteurs `engineNodes`/`engineFallbacks` affichés. Jamais de winrate API dans la boucle.
- Moteur/winrate cantonnés à l'**affichage** (pastilles, rapports, GameReport) : ils étiquettent, ils ne choisissent pas.

### Analyse de précision (spec en-croissant / Lichess)
- **web/src/utils/accuracy.ts** : cœur pur — Win% (`k=0.00368208`), précision par coup (`103.1668·exp(-0.04354·Δ)-3.1669+1`), précision de partie ((pondérée volatilité + harmonique)/2 par couleur), annotations `??/?/?!/!?/!/!!` (seuils 20/10/5 + sacrifice + only-sound), ACPL, phases, `buildGameReport`
- **web/src/services/gameAnalysis.ts** : rapport sur Stockfish LOCAL (analyse à rebours, MultiPV ≥ 2, annulable, `analyzeFn` injectable pour tests) — `analyzeGameSans` / `analyzeGamePgn`
- **web/src/services/stockfish.ts** : pont compat (batch + `analyzeGameAccuracy` détaillée W/B sur vrai moteur, ne lève que sur Abort)
- **web/src/components/GameReportView.tsx** + **ChesscomPanel.tsx** : rapport visionneuse (W/B, ACPL, annotations, phases, coups annotés cliquables), batch annulable (P12/1000 ms — P10 ratait les sacrifices/Brilliant), colonne Précision
- **accuracy.py** + **tests/test_accuracy.py** : miroir Python du cœur (CLI `--cps`, sans moteur)

### Design system web (« carnet d'étude », FR uniquement)
- **styles/tokens.css** : palette resserrée (1 accent vert fonctionnel + sémantiques), typo système (serif Georgia/Charter pour les titres de vue, ui-monospace pour coups/FEN), radius 6/10, focus-visible global, `prefers-reduced-motion` complet — aucune dépendance Google Fonts
- **styles/controls.css** : un seul système de boutons (primary/secondary/ghost/icon/danger/sm), segmentés, pastilles, tableaux, modales, toasts
- Conventions : sections + séparateurs plutôt que cards imbriquées ; cartes réservées aux répertoires/modales ; ♞♔♚ Unicode = symboles métier (conservés) ; pas d'emojis statut (pastilles CSS) ; seuils W/N/B unifiés à 15 %
- **Piège watcher Vite** : le serveur `npm run dev` de longue durée rate parfois des événements (fichier servi obsolète malgré HMR) → toucher le fichier ou **redémarrer le serveur** après un rework

### Gestion du cache
1. Lookup dans SQLite par pos_key
2. Si absent → requête API (rate limit 25/min)
3. Store résultat en base + retour
4. Les requêtes API sont loggées avec horodatage ISO

## API Lichess

### Authentification
- Token créé via https://lichess.org/account/oauth/token (aucun scope requis)
- Stocké dans `.env` → `LICHESS_TOKEN=lip_xxx`
- Headers : `Authorization: Bearer {token}`

### Endpoint
```
GET https://explorer.lichess.ovh/masters?fen={fen}
```

Réponse :
```json
{
  "moves": [
    {
      "san": "e4",
      "uci": "e2e4",
      "white": 5000,
      "draws": 2000,
      "black": 3000,
      "averageRating": 2500,
      "opening": {"name": "King's Pawn", "eco": "B00"}
    }
  ]
}
```

### Erreurs courantes
- **401** : Token invalide/absent
- **429** : Rate limit dépassée (attendre 1+ min)
- **Network** : Timeout ou connexion échouée

## Conventions de code

### Imports
```python
import chess              # Board, Move, pgn
import requests           # API calls
import sqlite3            # Cache
import json               # Arbre export
```

### Structures de données

**Nœud d'arbre** :
```python
{
  "fen": "...",
  "san": "e4",           # Notation standard
  "uci": "e2e4",         # Notation UCI normalisée
  "coup": "e4",          # Alias pour san
  "parties": 10000,      # Total de parties
  "victoires_blancs": 5000,
  "nuls": 2000,
  "victoires_noirs": 3000,
  "ouverture": "King's Pawn",
  "eco": "B00",
  "children": [...]      # Nœuds suivants
}
```

### Nommage
- `fen` : Position (notation Forsyth-Edwards)
- `uci` : Coup en UCI (normalisé)
- `san` : Coup en notation algébrique standard
- `coup` : Alias pour san
- `parties` : Total de parties (white + draws + black)

### Paramètres courants
- `profondeur_max` / `depth` : Plis (demi-coups)
- `coups_max` / `max_moves` : Coups conservés par position
- `min_parties` / `min_games` : Seuil de popularité
- `max_positions` : Budget de requêtes API
- `couleur` : "blancs", "noirs" ou "tous"
- `delai` / `delay` : Pause entre requêtes (s) pour respecter rate limit

## Commandes fréquentes

### Exploration automatisée
```bash
python repertoire.py --depth 12 --max-moves 2 --min-games 1000 \
  --output repertoire.pgn --json repertoire.json
```

### Construction interactive
```bash
python build_repertoire.py --couleur blancs --depth 8 --reponses 3
```

### Requête simple
```bash
python main.py --limit 5 --token lip_xxx
```

### Tests
```bash
pytest tests/ -v
pytest tests/test_db_cache.py -v
pytest tests/test_repertoire.py -v --tb=short
```

### Typecheck web (PIÈGE : `npx tsc --noEmit` NU ne vérifie RIEN — tsconfig.json racine solution-style `files: []` !)
```bash
cd web && npx tsc -p tsconfig.app.json --noEmit   # le VRAI check (découvert 2026-09-25 : le faux check masquait tout)
```

### Interface Streamlit (legacy)
```bash
streamlit run app.py
```

### Interface web moderne (dev auto-reload, port 5173 fixe)
```bash
python run_web.py        # ou : cd web && npm run dev
```
Le serveur dev reste ouvert : chaque sauvegarde recharge le navigateur seul (HMR, sans rebuild ni relance). `vite preview` = build figé, à éviter pendant le développement.

## Gestion des erreurs

### API
- Erreurs levées en RuntimeError avec message explicite
- Pas d'enregistrement en cache en cas d'erreur
- Les branches avec erreur s'arrêtent (verbose=True pour logs)

### Base de données
- Cache corrompu ne crash pas (graceful degradation)
- Positions normalisées partagent automatiquement le cache
- Replaces (UPDATE OR REPLACE) sur insertion en doublon

## Structure du projet

```
chess/
├── main.py                    # API Lichess
├── repertoire.py              # Construction récursive
├── build_repertoire.py        # Construction interactive
├── db_cache.py                # Cache SQLite
├── board_html.py              # Rendu HTML
├── app.py                     # Streamlit (legacy)
├── run_web.py                 # Launcher Vite
├── requirements.txt           # Dépendances
├── repertoire.json            # Arbre répertoire (export)
├── repertoire.pgn             # Répertoire PGN (export)
├── repertoire_cache.db        # Cache local
├── .env                       # Variables d'environnement (LICHESS_TOKEN)
├── tests/
│   ├── test_main.py           # Tests API
│   ├── test_repertoire.py     # Tests construction
│   ├── test_db_cache.py       # Tests cache
│   └── test_integration.py    # Tests end-to-end
├── web/                       # Frontend Vite/React
│   ├── src/
│   │   ├── styles/            # Design system « carnet d'étude » (tokens, contrôles, layout, library, studio)
│   │   ├── components/        # Panneaux par onglet (logique métier conservée, présentation unifiée)
│   │   ├── services/ hooks/ utils/ storage/ types/ i18n/
│   ├── package.json
│   └── vite.config.js
└── venv/                      # Virtual environment Python
```

## Dépendances principales

- **chess** : Légalité des coups, notation FEN/UCI
- **requests** : Appels API HTTP
- **streamlit** : Interface web (legacy)
- **pytest** : Tests (dev)

## Tips

- Toujours normaliser les FEN avant cache (évite doublons EP fantômes)
- Logging verbose utile pour déboguer les erreurs API
- Cache = point fort du projet (25 req/min → économise requêtes)
- Cache web Explorer : LRU mémoire 2000 + IndexedDB **indéfini** (`storage/explorerCacheDb.ts`, read-through, flush incrémental 25/timer/fin de run, migration auto de l'ancien blob localStorage) — clés = endpoint/cotes/filtre/FEN, donc un autre Elo = zéro hit (normal)
- Roque = piège courant (UCI differ entre Lichess et python-chess)
- Transpositions gérées automatiquement via pos_key normalisation

## Chess.com — onglet « Mes parties »

- **services/chesscom.ts** : API publique sans token (pseudo + avatar persistés via `chesscomStore`) — profil, archives mensuelles, `fetchAllGames` (historique complet, concurrence 4, progression, annulation, archives en échec isolées)
- **hooks/useChesscomAccount.ts** : état compte partagé sidebar ↔ panneau (instance unique dans App)
- **components/Sidebar.tsx** : carte compte dépliable au clic sur le profil (lier/actualiser/dissocier, progression) ; chip photo + `@pseudo` en bas
- **components/ChesscomPanel.tsx** : parties visionnées sur le GRAND échiquier (timeline principale, lecture seule) — liste filtrable (issue/couleur/cadence, pagination 100, colonne Précision, lignes clavier Entrée/Espace), visionneuse clavier ←/→/Échap, tables Blancs/Noirs Most Played (ECO, nom via ECOUrl + table de repli, durée moyenne, V-N-D)
- Parties en cache mémoire de session uniquement (historique complet = Mo, hors quota localStorage) ; `StudioTab` += `'games'`

## OpenClaude Integration

### Auto-exécution des tests
```bash
pytest tests/ -v
```

### Graphify knowledge graph
```bash
graphify .
graph-query "How does castling normalization work?"
```

### Commandes de développement
```bash
# Construire un répertoire blancs complet
python repertoire.py --couleur blancs --depth 12 --output rep_blancs.pgn --json rep_blancs.json

# Interroger Lichess Live
python main.py --limit 8 --token lip_xxx

# Tests spécifiques
pytest tests/test_db_cache.py::TestPosKey -v
```

---

**Dernier update** : 2026-09-17 | Tests : pytest 77/77 ✅ · vitest 238/238 ✅ · tsc 0 erreur ✅ | Rework visuel « carnet d'étude » (styles/ 5 fichiers, FR intégral, a11y)
