# ♞ Chess Repertoire Studio

Application moderne d'étude, d'exploration et d'entraînement de répertoires d'ouvertures d'échecs basée sur la base de données **Lichess Masters**.

---

## 🚀 Démarrage Rapide

### Option 1 : Lancement en 1 clic (Recommandé)
Exécutez simplement le script Python à la racine :
```bash
python run_web.py
```
Le serveur Web Vite démarre et ouvre automatiquement votre navigateur sur `http://localhost:5173`.
Ce lanceur démarre aussi une base SQLite locale pour conserver les réponses Lichess et les évaluations Stockfish hors des données du navigateur. L'ancien IndexedDB est importé dans cette base au premier lancement. Sur Windows, le fichier est dans `%LOCALAPPDATA%\ChessRepertoireStudio\explorer-cache.sqlite3`; sur Linux/macOS, dans `$XDG_DATA_HOME/ChessRepertoireStudio/` ou `~/.local/share/ChessRepertoireStudio/`.

### Option 2 : Lancement direct via npm
```bash
cd web
npm install
npm run dev
```
Le lancement direct garde uniquement les bases navigateur (IndexedDB); pour la persistance SQLite, utiliser `python run_web.py`.

---

## ✨ Fonctionnalités Clés

### 1. 📖 Mode Explorateur de Répertoire
* **Échiquier Chessground (Lichess)** : fluide, vectoriel, réactif (déplacement au clic ou drag & drop).
* **Annotations tactiques** : clic droit et glisser pour tracer des flèches colorées (vert, rouge, bleu, jaune), clic droit sur une case pour l'entourer.
* **Statistiques Grands Maîtres en temps réel** : pourcentage de victoires Blancs, Nuls et Noirs, nom de l'ouverture et code ECO.
* **Gestion des transpositions** : les positions atteintes par différents ordres de coups sont automatiquement reconnues et unifiées.
* **Navigation fluide** : boutons Début, Reculer, Avancer, Fin et lecture automatique de la variante principale (*Principale*).
* **Copie rapide** : boutons FEN et PGN en un clic.

### 2. 🎯 Mode Entraînement / Drill (Spaced Repetition)
* Entraînez-vous activement contre votre propre répertoire :
  * Choisissez votre camp : **♔ Blancs** ou **♚ Noirs**.
  * L'ordinateur joue automatiquement les coups de l'adversaire selon leur popularité.
  * Jouez votre coup de répertoire :
    * **Coup correct** : confirmation visuelle émeraude, son gratifiant et réponse adverse automatique.
    * **Coup hors répertoire** : alerte rouge, son d'avertissement, indication du coup théorique attendu avec possibilité de réessayer ou de voir la solution.
* Suivi des performances : taux de précision (%), série de coups parfaits (streak) et variantes complétées.
* **FSRS et découverte progressive** : l'algorithme FSRS planifie les révisions (rétention cible 90 %), avec « À revoir » après une erreur, « Difficile » si un indice a été utilisé et « Bien » pour une réussite sans indice. Le Drill débloque d'abord 10 positions de votre camp ; chaque première réussite sans indice valide une position, puis ouvre la cohorte suivante de 10. Les révisions échues restent prioritaires et la progression est conservée localement par répertoire.

### 3. 🌐 Lichess Live Explorer
* Interrogez en direct l'API Lichess Masters ou Lichess Joueurs à partir de la position courante du plateau (sans aucun copier-coller de FEN !).
* Ajoutez n'importe quel coup de l'API Lichess à votre répertoire local d'un simple clic sur **« ➕ Au répertoire »**.
* **Token Lichess** : votre token est stocké en localStorage de votre navigateur (cf. avertissement sécurité ci-dessous). Ne le partagez jamais et pensez à l'ajouter dans votre `.gitignore` si vous partagez le dépôt.

---

## 🎯 Analyse de précision façon en-croissant

Le projet implémente le système d'analyse de parties d'**en-croissant** (lui-même basé sur les formules **Lichess**), sur le **Stockfish local** (WASM, aucun cloud) :

### Rapport de partie (« Mes parties » → visionneuse → « Analyser cette partie »)
* **Analyse à rebours** (de la finale vers le début : réutilisation du hash moteur), **MultiPV 2 minimum**.
* **Win%** : `50 + 50 × (2 / (1 + exp(-0.00368208 × cp)) - 1)` — la métrique primaire est la **perte de Win%** (meilleur coup − coup joué).
* **Précision par coup** : `103.1668 × exp(-0.04354 × ΔWin%) - 3.1669 + 1` (100 si le coup égale le meilleur).
* **Précision de partie W/B** : moyenne pondérée par volatilité + moyenne harmonique, divisée par 2 (formule `lila` exacte).
* **Annotations** : `??` (≥ 20), `?` (≥ 10), `?!` (≥ 5), `!?` (sacrifice), `!` (seul bon coup qui punit), `!!` (sacrifice + seul bon coup) — avec la variante du meilleur coup sur les erreurs.
* **ACPL** et **précisions par phase** (ouverture / milieu / finale) ; coups annotés et cliquables dans la visionneuse.
* Bouton **batch « Analyser précision »** sur la liste : réglages légers (P10, 500 ms/position), progression honnête, **annulable** ; seul le badge de votre camp est affiché (détail W/B en infobulle).

### Précision d'entraînement (mode Drill)
* **Précision simple** : `% de coups corrects sur le total des tentatives`.
* **Précision eval** : même cœur Win% ci-dessus, entre deux évaluations moteur.

### Miroir Python (CLI, sans moteur — cps blancs en entrée)
```bash
python accuracy.py --cps 15,20,10,-40 --trait white
pytest tests/test_accuracy.py -v
```

### 4. 📁 Import / Export
* **Export PGN** : téléchargez votre variante ou répertoire au format PGN standard.
* **Export JSON** : sauvegardez l'arbre complet de votre répertoire.
* **Import JSON** : chargez n'importe quel répertoire personnalisé créé avec vos scripts.

---

## 🛠️ Outils CLI Python (Conservés intacts)

Vos scripts d'origine restent disponibles à la racine pour explorer ou générer de nouveaux fichiers :
* `python main.py --limit 5` : affiche les coups les plus joués à la position initiale.
* `python repertoire.py --depth 12 --max-moves 2 --output repertoire.pgn --json repertoire.json` : exploration récursive automatisée.
* `python build_repertoire.py --couleur blancs` : constructeur interactif en ligne de commande.
* `db_cache.py` : cache SQLite local évitant de répéter les requêtes API vers Lichess.

---

## 🛡️ Sécurité et .gitignore

**IMPORTANT : Ajoutez toujours `.env`, `venv/`, `repertoire_cache.db` et `*.db` à votre `.gitignore`.**

Le fichier `.env` contient des tokens sensibles (ex: `LICHESS_TOKEN`). Voir le fichier `.gitignore` fourni à la racine du projet pour la liste complète.

Ne jamais valider de token Lichess ou de mots de passe en clair dans un dépôt public.
