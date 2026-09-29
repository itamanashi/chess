# Rapport de bug — Freeze de l'onglet sur l'app Chess Repertoire Studio

Date : 2026-09-22. Rédigé par l'IA précédente après ~2 h d'investigation sans résolution.
Objectif : donner à une autre IA tous les faits vérifiés, les fausses pistes écartées (avec preuves),
l'état exact du code, et les prochaines hypothèses à tester.

---

## 1. Symptôme (paroles utilisateur, traduites au plus près)

1. « Quand j'essaie d'écrire à la place du 60 dans budget positions ça bug et je ne peux plus rien faire dans la page. »
2. « Le bug est toujours présent et rien ne s'affiche dans la console. »
3. « Toujours le même bug, je ne peux modifier aucun des 5 [champs] et la valeur ne change pas quoi que je fasse. »
4. « C'est Budget positions (illimité) et quand je mets par exemple 0 pour faire 600, rien ne change, tout est bloqué, et même un reload je ne peux pas le faire tant que j'ai pas fermé l'onglet de la page. »
5. « OK je peux taper dans budget mais quand je clique ailleurs je freeze. » (après un correctif)
6. Tests privés Opera : « ça utilise moins de pourcentage et ça freeze pas ».
7. Shift+Échap (gestionnaire des tâches Opera) : « oui ça utilise à 100 % quand j'ouvre un répertoire ».

État final : **le freeze persiste**. L'utilisateur veut soumettre ce rapport à une autre IA pour hypothèses.

---

## 2. Environnement (vérifié, pas supposé)

- OS : Windows. Navigateur : **Opera GX** (fr), ~60 processus `opera.exe` (session lourde).
- Aucune extension tierce installée (pas de dossier `Extensions` ; uniquement composants intégrés :
  bloqueur de pubs intégré présent `adblocker_data`, flags visibles : `acceptable-ads=off`,
  `ai-chat-in-side-panel=on`, etc.).
- App servie par **Vite 8.3.0 dev** sur `http://localhost:5173/` (`npm run dev`, React 19.2.8,
  chess.js 1.4.0, stockfish.js 10.0.2, Playwright 1.60 dispo pour QA).
- Repo : `C:\Users\NOM\Desktop\Nouveaudossier\code\chess`, **pas de git**. Python : pytest 77/77.
- Profil utilisateur réel : bibliothèque de répertoires perso (taille inconnue !), localStorage rempli
  (cache Explorer, prefs), token Lichess présent mais **rejeté (401)** — voir §4.
- Pendant l'enquête, le serveur dev est tombé une fois (plus aucun `node`, port refusé) puis relancé.
  L'onglet utilisateur a donc, à un moment, tourné sur un bundle déconnecté/ancien.

---

## 3. Console utilisateur (copiés-collés exacts, dans l'ordre d'arrivée)

A. Erreur CSP eval :
`The Content Security Policy (CSP) prevents the evaluation of arbitrary strings as JavaScript...`
→ **Piste morte** : zéro `eval`/`new Function`/`setTimeout(string)` dans `web/src`, aucune directive
CSP en dev comme en build. Ne peut pas venir de l'app (autre onglet ou composant Opera).

B. `[vite] connecting...` / `[vite] connected.` → HMR OK, l'onglet est bien sur le serveur dev.
C. `Unchecked runtime.lastError: Could not establish connection. Receiving end does not exist.` (×2)
→ signature typique d'un composant/extension Opera qui envoie des messages (pas forcément fautif).
D. `[Violation] 'message' handler took 215ms / 287ms`, `[Violation] 'input' handler took 215ms`
→ **fait clé** : chaque frappe coûtait 200 ms+ dans SON onglet (profil vierge headless : instantané).
E. Trace 401 :
```
GET https://explorer.lichess.ovh/lichess?fen=...&moves=12&speeds=blitz,rapid,classical&ratings=400,1000 401 (Unauthorized)
    at async.ts:115 → fetchWithRetry @ lichess.ts:286 → lichess.ts:220
    → RepertoireBuilder.tsx:327 → RepertoireBuilder.tsx:338 → <RepertoireBuilder> → App.tsx:867
```
→ Token absent/invalide : **tout l'Explorer est en échec silencieux** dans son profil
(les deux endpoints exigent une auth depuis mars 2026). Les 401 sont terminaux (pas de retry).

---

## 4. Mesures système (faites pendant le freeze signalé)

- Renderer Opera PID 16880 (`--type=renderer`, Opera GX) : **+4,9 s CPU / 4 s, puis +4,7, puis +4,5** —
  boucle soutenue >100 % pendant 10+ minutes. **On n'a jamais prouvé que c'est l'onglet chess**
  (60+ onglets/processus) — c'est l'inconnue n°1.
- Aucun `node` / serveur à un moment (serveur tombé) ; relancé ensuite (visible puis caché puis visible).
- QA headless (Chromium Playwright, profil vierge, même bundle) : **tout passe à chaque fois**
  (frappe, blur, presets, mini-génération, arbre 9000 nœuds après correctif) — voir §6.

---

## 5. État du code AUJOURD'HUI (ce qui a changé pendant l'enquête)

Fichiers supprimés : `auto_repertoire.py`, `tests/test_auto_repertoire.py` (outil batch Python, remplacé par le web).

`web/src/components/AutoRepertoirePanel.tsx` :
- Les 5 champs numériques étaient **contrôlés avec clamp immédiat** (`Number('') || 60` → le champ
  se re-remplissait tout seul, saisie quasi impossible) — **premier bug réel, corrigé**.
- D'abord `useNumberText` (texte local + commit blur/Entrée), puis champs **non-contrôlés**
  (`useUncontrolledNumber` + refs, `defaultValue`, commit blur/Entrée) : **zéro rendu React à la frappe**.
- Budget illimité (plafond 400 supprimé), presets Rapide/Standard/Batch(1000).
- `pruneMinLineValue` défaut 0.45 → **0** (opt-in) — règle utilisateur : pas de winrate/moteur en génération.
- État de run visible : compteur `X/Y pos · Z coups · N s`, bouton Arrêter près du titre, notice
  « champs verrouillés », progression throttlée (4/s).

`web/src/services/autoRepertoire.ts` (+ tests) : priorité absolue aux mats (`findMateInOneUcis`
sans moteur + `#` Explorer, `MATE_PRIORITY_BONUS=1e6`, flag `isMate`, compteur `stats.mates`,
protection contre l'élagage LV). `pruneMinLineValue: 0` par défaut.

`web/src/services/lichess.ts` (+ test) : **TTL 14 j supprimé** (cache persistant sans expiration,
borné LRU 800 + persist 200).

`web/src/utils/repertoire.ts` : `generateTreePgn` (export PGN arbre + variantes, round-trip chess.js testé).
`web/src/utils/treePgn.test.ts` (nouveau, 6 tests).

`web/src/types/chess.ts` : `RepertoireMove.isMate?`. `web/src/utils/repertoireTree.ts` (+ tests) :
`mergeAutoRoot` préserve `isMate`. `web/src/components/RepertoireBuilder.tsx` + `RepertoireGraphTree.tsx` :
pastille CSS `mate-tag`. `web/src/styles/controls.css` : style `.mate-tag`.

`web/src/components/RepertoireGraphTree.tsx` (**correctif perf prouvé par mesure**) :
- nœuds + arêtes mémorisés (`graphStatic`, caméra = transform CSS) : pan/zoom/survol ne re-rendent plus rien ;
- analyse Stockfish au **clic** (épinglé/sélectionné) uniquement, **plus au survol**
  (chaque nœud frôlé relançait une analyse + re-rendait tout l'arbre).
- Mesure headless sur arbre 9000 nœuds : avant = bloc de **2006 ms** au montage + re-rendus complets
  par survol/molette ; après = rafale survols+molette **max 372 ms**.

`CLAUDE.md` : section « Règles de génération auto — NE PAS VIOLER » (fréquentiste pure, mat seule exception).

Suites : **vitest 374/374 ✅, `tsc --noEmit` 0 erreur ✅, pytest 77/77 ✅.**

---

## 6. QA headless effectuée (Playwright + Chromium, même bundle, profil vierge)

Scripts (hors repo) : `AppData/Local/Temp/opencode/qa-budget.mjs`, `qa-stress.mjs`, `qa-bigrep.mjs`,
`gen-bigtree.mjs` (arbre légal 9000 nœuds seedé en localStorage).
- Frappe `60`→`1000`/`605`/`100000`, vide→min, lettres rejetées, presets, mini-génération : **OK, 0 erreur**.
- Arbre 9000 nœuds : ouverture 4 s, **9001 divs DOM**, longtask 2 s au montage (avant correctif mémo).
- **Jamais reproduit le freeze** en profil vierge. C'est un fait central : le bug exige quelque chose
  du profil réel (données ? prefs ? bloqueur intégré ? charge machine ?).

---

## 7. Hypothèses ÉCARTÉES (avec preuve — ne pas les refaire)

1. Bundle obsolète servi : réfuté (le bundle servi contient le fix, label « (illimité) » vu par l'utilisateur).
2. Champ contrôlé qui se réinitialise : **c'était un vrai bug, corrigé et vérifié** (puis champs non-contrôlés).
3. `eval`/CSP : aucun dans le code ni les headers — la CSP vient d'ailleurs.
4. Retry infini sur 401 : `fetchWithRetry` lève immédiatement sur 401 (lu, testé).
5. Re-parse localStorage par lecture cache : lectures = LRU mémoire O(1) (`lsLoaded` verrou).
6. `<form>`/submit sur Entrée : aucun `<form>` dans l'app.
7. Effets à dépendances instables (boucle async silencieuse) : `eloConfig` = référence stable,
   deps engine `[currentFen, localDepth, isOpponentTurn, suggestionSource]` stables,
   `indexRepertoire` mémorisé, trap/robustesse manuelles, autoplay borné (60 coups), adaptive borné (8 rounds).
8. Moteur adaptatif infini : borné (8 rounds, 15 s/round, D28 max) ; file avec préemption interactive.

---

## 8. Hypothèses OUVERTES (par priorité pour la suite)

H1. **L'onglet qui boucle n'est pas (seulement) le chess** : identifier via Shift+Échap QUEL onglet est à 100 %.
    Si ce n'est pas localhost → tout le reste est hors sujet.
H2. **Bloqueur intégré Opera vs DOM vivant** : mises à jour fréquentes (progression moteur par profondeur,
    badge, countdown 450 ms) + observeurs du bloqueur = boucle observe→mute. Tester bloqueur OFF pour localhost.
H3. **Taille des données réelles** : si ses répertoires font >> 9000 nœuds, le montage initial seul
    (toujours ~2 s/9000 nœuds en headless rapide !) + analyses auto à l'ouverture peuvent mettre l'onglet à genoux
    sur une machine chargée. Compter ses nœuds (indexRepertoire en console) et tester un répertoire vierge.
H4. **Stockfish cumulé** : analyse auto à chaque position (D12→28 MPV5) + file sérialisée + navigation rapide =
    backlog CPU de dizaines de minutes, UI verrouillée par les champs désactivés. Vérifier profondeur moteur
    persistée (`localStorage`) et tester source='users' (moteur coupé).
H5. **GX Control (limiteur RAM/CPU d'Opera GX)** : un renderer bridé + WASM + gros DOM = spirale. Vérifier les limites.
H6. **Pression mémoire machine** (60+ processus Opera) : paging → tout rame, violations 200 ms+, reload impossible.
    Fermer les onglets lourds et re-tester.
H7. **Token Lichess invalide** : tout l'Explorer est mort dans son profil (401) — réparer le token changera
    radicalement le comportement (données présentes → autres chemins de code) ; à faire AVANT tout autre test.

---

## 9. Tests décisifs proposés (10 s chacun, dans l'ordre)

1. Shift+Échap → noter l'onglet à ~100 % (nom + mémoire). Si ce n'est pas localhost : stop, le bug est ailleurs.
2. Onglet chess : réparer le token Lichess (profil → token valide), recharger, re-tester la frappe + navigation.
3. « Nouveau Répertoire » vide → mêmes gestes : si OK avec petit arbre et KO avec les gros → piste taille (H3).
4. Bloqueur Opera OFF pour localhost (icône barre d'adresse) → re-tester.
5. Source des conseils = « Joueurs » (moteur coupé) → re-tester (isole Stockfish, H4).
6. Enregistrement Performance DevTools pendant 10 s de freeze (coupable exact : JS, layout, GC, worker).

---

## 10. Fichiers à lire en premier (autre IA)

- `web/src/components/AutoRepertoirePanel.tsx` (champs + run + progression)
- `web/src/components/RepertoireBuilder.tsx` (effets fetch/engine/autoplay, lignes 140–270, 470–520)
- `web/src/components/RepertoireGraphTree.tsx` (rendu graphe, effet viewer lignes ~690–730)
- `web/src/services/lichess.ts` (cache + retry), `web/src/services/localEngine.ts` (sessions/file)
- `web/src/services/autoRepertoire.ts` (génération BFS)
- `web/src/App.tsx` (~860 : montage RepertoireBuilder ; autoplay ligne principale ~419)
