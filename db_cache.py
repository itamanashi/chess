"""Cache SQLite des réponses de l'API Lichess Masters, indexé par position.

La clé est la position normalisée (pièces + trait + roques + vraie prise
en passant), donc `e3` fantôme (chess.js) et `-` (python-chess) partagent
la même entrée. Aucune dépendance externe hormis `chess` et `requests`
(via main).

IMPORTANT : Ce cache SQLite est indépendant du cache navigateur JS dans lichess.ts.
- db_cache.py: Utilise pos_key() normalisant sur 4 champs FEN (python-chess behavior).
- lichess.ts: Utilise LRU en mémoire + localStorage persist avec TTL 14 jours.
- preferences.stocke le token Lichess en localStorage.
- Ces trois systèmes ne sont pas synchronisés — ils servent des contextes différents.
- Rate limit 25/min : le Python utilise `delai` paramètre, le JS a sa propre logique backoff.
- Ne pas mélanger les clés entre les deux environnements.
"""
import json
import os
import sqlite3
from datetime import datetime, timezone

import chess

from main import get_opening_moves

DB_DEFAUT = "repertoire_cache.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS api_cache (
  pos_key    TEXT PRIMARY KEY,
  fen        TEXT NOT NULL,
  moves_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
"""


def pos_key(fen):
    """Clé canonique d'une position : 4 premiers champs FEN normalisés."""
    try:
        # chess.Board.fen() omet déjà la case EP fantôme (sans capture légale).
        return " ".join(chess.Board(fen).fen().split()[:4])
    except ValueError:
        return " ".join(fen.split()[:4])


def _connect(db_path):
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute(SCHEMA)
    conn.commit()
    return conn


def lookup(db_path, fen):
    """Renvoie la liste de coups cachée, ou None si absente."""
    conn = _connect(db_path)
    try:
        row = conn.execute(
            "SELECT moves_json FROM api_cache WHERE pos_key = ?", (pos_key(fen),)
        ).fetchone()
    finally:
        conn.close()
    return json.loads(row[0]) if row else None


def store(db_path, fen, moves):
    conn = _connect(db_path)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO api_cache (pos_key, fen, moves_json, updated_at)"
            " VALUES (?, ?, ?, ?)",
            (pos_key(fen), fen, json.dumps(moves, ensure_ascii=False),
             datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
    finally:
        conn.close()


def fetch_moves(fen, token=None, db_path=DB_DEFAUT):
    """Coups pour `fen`, depuis la base si présente sinon depuis l'API.

    Renvoie (moves, depuis_cache). Les erreurs API lèvent RuntimeError
    (rien n'est enregistré dans ce cas).
    """
    cached = lookup(db_path, fen)
    if cached is not None:
        return cached, True
    moves = get_opening_moves(fen=fen, token=token)
    store(db_path, fen, moves)
    return moves, False


def stats_db(db_path=DB_DEFAUT):
    """Renvoie (nb_positions, dernière_maj) de la base."""
    if not os.path.exists(db_path):
        return 0, None
    conn = sqlite3.connect(db_path)
    try:
        n = conn.execute("SELECT COUNT(*) FROM api_cache").fetchone()[0]
        last = conn.execute("SELECT MAX(updated_at) FROM api_cache").fetchone()[0]
    finally:
        conn.close()
    return n, last
