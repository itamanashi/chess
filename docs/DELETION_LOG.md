# Code Deletion Log

## [2026-10-05] Refactor Session (web/ frontend)

Méthode : pas de knip/depcheck/ts-prune dans les devDeps et analyse manuelle à la place —
`tsc -p tsconfig.app.json` (`noUnusedLocals`/`noUnusedParameters` actifs), `oxlint`,
recherche d'importateurs par grep sur tout `web/src`, vérification d'absence d'import
dynamique, puis `vitest run` + `vite build` après chaque lot. Aucun commit créé :
l'arbre contenait déjà un WIP non commité (variantes design), les suppressions restent
à relire avant `git add`/`git commit`.

### Unused Dependencies Removed
- `stockfish.js@^10.0.2` (`web/package.json` + `web/package-lock.json`, via `npm uninstall`)
  - Raison : zéro import dans `web/src` (statique ou dynamique), zéro référence dans
    `vite.config.ts` / `index.html`. Le moteur actuel passe par les WASM vendus dans
    `web/public/` (`stockfish.wasm`, `sf19/`) via `services/gameAnalysis.ts` / `localEngine.ts`.
  - Seule occurrence restante du nom : commentaire d'attribution dans le fichier vendu
    `web/public/stockfish.wasm.js` (pas un import npm).

### Unused Files Deleted
- `web/src/services/engineAdvantage.test.ts` — doublon octet-pour-octet de
  `web/src/utils/engineAdvantage.test.ts` (seule différence : le chemin d'import relatif).
  `services/engineAdvantage.ts` n'existe pas et rien n'importe `services/engineAdvantage`.
  Conservé : la version colocalisée `utils/engineAdvantage.test.ts` (convention du repo).

### Duplicate Code Consolidated
- `formatDuration()` : 5 copies identiques → `utils/formatGames.ts::formatDuration`
  (déjà utilisée par `VariantStatsPanel`). Fichiers dédupliqués :
  `components/RepertoireLibrary.tsx`, `library-variants/RepertoireLibrary.apple-design.tsx`,
  `.../RepertoireLibrary.frontend-design.tsx`, `.../RepertoireLibrary.ui-ux-pro-max.tsx`,
  `.../RepertoireLibrary.landing-page-design.tsx`.
  La variante `web-design-guidelines` garde sa copie volontairement (espaces insécables
  et suffixes `min`/`s` : rendu visuel différent, pas un doublon).
- `formatEval(eval: number | null)` : 5 copies identiques → nouvel export partagé
  `utils/formatGames.ts::formatEval` (+ tests dans `formatGames.test.ts`, dont
  `formatDuration` qui n'était pas testée). Même exception `web-design-guidelines`
  (`'0,00'` vs `'0.00'`). `VariantStatsPanel` utilisait une variante locale `(number)` au
  comportement identique → basculée sur le partagé.
- Bonus sécurité : `VariantStatsPanel` appelait `useMemo` après un `return` conditionnel
  (erreur `react-hooks/rules-of-hooks` d'oxlint). `return` déplacé après les hooks avec
  garde `null` dans le mémo — comportement identique, erreur levée.

### Volontairement conservé (revue manuelle)
- `components/library-variants/` (5 redesigns) + `LibraryVariantShowcase.tsx` : doublons
  apparents mais expérimentation design active, référencés par `App.tsx` via `?variant=`.
  Décision produit requise avant toute suppression.
- `components/mes-parties-variants/Overview.apple.tsx` : utilisé par `ChesscomPanel.tsx`
  (onglet `overview`). Son voisin `OverviewPreview.apple.tsx` (mock sans props) n'a aucun
  importateur — candidat à la suppression, laissé au propriétaire du WIP.
- `utils/repCardStats.ts`, `storage/studyTime.ts`, `styles/games.css` : tous importés
  (non suivis par git mais référencés). Ne pas confondre « untracked » et « mort ».
- `console.warn` dans `utils/async.ts` et `services/localEngine.ts` : logs d'erreur
  intentionnels, conservés.

### Impact
- Fichiers supprimés : 1 (`services/engineAdvantage.test.ts`)
- Dépendances supprimées : 1 (`stockfish.js`)
- Lignes dupliquées éliminées : ~100 (10 helpers locaux → 2 exports partagés)
- Lignes ajoutées : ~40 (export `formatEval` + 3 tests)
- `dist` JS : ~863 KB (inchangé à la marge ; le gain est en `node_modules` + poids d'install)

### Testing
- `npx tsc -p tsconfig.app.json --noEmit` : 0 erreur
- `npx oxlint` : 507 warnings (pré-existants, inchangés), **0 erreur** (était 1)
- `npm run test -- --run` : 46 fichiers, 517 tests, tous verts
- `npm run build` : succès (`✓ built in ~2s` ; seuls warnings pré-existants chunk-size /
  dynamic-import dans `autoRepertoire.ts`, hors périmètre)
