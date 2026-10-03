# AGENTS.md — Chess Repertoire Studio

Two halves: Python scripts at root (Lichess API, repertoire building, SQLite cache) + `web/` (Vite + React 19 + TS frontend). `CLAUDE.md` has full domain detail; this file is operational traps only.

## Commands (run from repo root unless noted)

```bash
pytest tests/ -v                                   # Python suite
cd web && npm run test -- --run <path/to.test.ts>  # focused vitest (script is one-shot `vitest run`)
cd web && npx tsc -p tsconfig.app.json --noEmit    # THE typecheck — see trap below
cd web && npx oxlint                               # lint
python run_web.py                                  # dev server, fixed port 5173 (or: cd web && npm run dev)
```

- **tsc trap**: `web/tsconfig.json` is solution-style (`files: []`), so bare `npx tsc --noEmit` in `web/` checks NOTHING. Always pass `-p tsconfig.app.json`.
- **Stale dev server**: the long-running `npm run dev` sometimes misses file events (serves obsolete code despite HMR). After a rework that doesn't show up, touch the file or restart the server. Never use `vite preview` during dev (frozen build).
- Shell is PowerShell on win32: no `head`/`tail` (use `Select-Object`), quote paths with spaces, and avoid inline `python -c` with nested quotes — write a temp script under `C:\Users\NOM\AppData\Local\Temp\opencode\` and run it instead.
- Python token: Lichess `LICHESS_TOKEN=lip_xxx` in root `.env` (create via lichess.org/account/oauth/token, no scope). Rate limit 25 req/min — the SQLite cache (`repertoire_cache.db`) exists to avoid burning it; always cache-first.

## Data & correctness traps (verified in code, do not "simplify")

- **Position keys**: FEN normalized to first 4 fields before cache lookup (`" ".join(fen.split()[:4])`) — ignores phantom en-passant + clocks. Same position, different counters = same entry.
- **Castling UCI**: Lichess API returns Chess960-style (`e1h1/e1a1/e8h8/e8a8`); python-chess expects `e1g1/e1c1/e8g8/e8c8`. Map them or legality checks break.
- **Explorer cache keys** (`web/src/storage/explorerCacheDb.ts`): endpoint + odds + filter + FEN. A different Elo = zero hits (normal, not a bug). LRU memory (2000) + IndexedDB, indefinite.
- **French `MoveQuality` keys** (`web/src/services/chesscom.ts`): `brillant/genial/meilleur/tres-bien/bon/theorique/imprecision/erreur/gaffe/gain-manque`. Never use English chess.com labels (`brilliant/best/...`) as keys — tsc will reject, and display buckets must fold leftovers explicitly (genial→Meilleur, theorique→Bon, gain-manque→Erreur).

## Repertoire generation rules (explicit user decisions — do not violate)

- Pure frequentist generation by Explorer coverage at target Elo. No winrate (`white/draws/black` never read in the loop) and no engine in the selection/priority/pruning path (`pruneMinLineValue: 0` default).
- **Only exception: forced mate.** Mate-in-1 from Explorer `#` + legal check (`findMateInOneUcis`, no engine) is always included, never pruned. Mate in N>1 = engine = manual analysis only.
- **Our replies, blancs/noirs modes**: keep argmax `qualityScore` (local share × lift vs Masters, ×3 max / ×0.1 min), not raw top-1. Masters double-read per own position only (opponent = target pool only); if engine judge enabled, Stockfish decides alone with zero Masters reads.
- **Engine judge is opt-in** ("Répliques moteur" checkbox): local Stockfish MultiPV 6/D14 re-ranks our replies, keeps equivalents (±30 cp), deepens only top-2 within ≤15 cp. Blind/partial/evicted → gradient fallback, never abort. Engine/winrate elsewhere = display labels only.

## Frontend conventions

- Design system "carnet d'étude", **French only**: `web/src/styles/` (`tokens.css` palette/radius/type, `controls.css` single button system). ♞♔♚ are domain symbols (kept); no status emojis (CSS pastilles instead).
- Chess.com tab needs no token; game history lives in **session memory only** (never localStorage — full history is MBs). `StudioTab` += `'games'`.
- Accuracy core is pure and mirrored: `web/src/utils/accuracy.ts` ↔ root `accuracy.py` (+ `tests/test_accuracy.py`, CLI `--cps`, no engine). Engine reports live in `services/gameAnalysis.ts` / `stockfish.ts`.

## Visual QA (no Playwright browsers installed)

```bash
agent-browser --executable-path "C:\Program Files\Google\Chrome\Application\chrome.exe" open http://localhost:5173/ --json
agent-browser --executable-path "...chrome.exe" snapshot -i --json   # @refs; re-snapshot after any page change
agent-browser --executable-path "...chrome.exe" screenshot <path> --json
```

- Smallest real-data fixture: Chess.com account `lichess` (1 archive, 1 game) + "Analyser précision" (~20 s, Stockfish in-browser) exercises hero, gauges, stat cards, quality bar, tactics, narrative, strengths, axes.
- Prefer `--eval` reads over screenshots for structure; screenshot for layout. HMR preserves analysis state on CSS-only edits.

## End-of-update gate (verify + push, après toute maj majeure)

- Vérifier d'abord, pousser ensuite : `npx tsc -p tsconfig.app.json --noEmit` + `npx oxlint` + tests ciblés (`npm run test -- --run <fichiers>`, `pytest tests/ -v` si Python touché). Zéro erreur avant commit.
- Puis `git status` / `git diff` / `git log --oneline -10` : stager uniquement les fichiers voulus, jamais de secrets (`.env`, `*.db` déjà ignorés — vérifier quand même), message concis dans le style du repo, et push sur `main`.
