"""SQLite-backed durable store for the web app's Lichess Explorer results."""

import json
import os
import sqlite3
from pathlib import Path


def default_db_path():
    configured = os.environ.get("CHESS_EXPLORER_CACHE_DB")
    if configured:
        return Path(configured)
    if os.name == "nt":
        root = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    else:
        root = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(root) / "ChessRepertoireStudio" / "explorer-cache.sqlite3"


class ExplorerCacheDatabase:
    def __init__(self, path=None):
        self.path = Path(path) if path else default_db_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS explorer_cache (
                    cache_key TEXT PRIMARY KEY,
                    response_json TEXT NOT NULL,
                    saved_at INTEGER NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS engine_evaluations (
                    cache_key TEXT PRIMARY KEY,
                    lines_json TEXT NOT NULL,
                    saved_at INTEGER NOT NULL
                )
                """
            )

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=10)
        conn.execute("PRAGMA synchronous=FULL")
        return conn

    def get(self, key):
        with self._connect() as conn:
            row = conn.execute(
                "SELECT response_json, saved_at FROM explorer_cache WHERE cache_key = ?",
                (key,),
            ).fetchone()
        if not row:
            return None
        return {"data": json.loads(row[0]), "savedAt": row[1]}

    def put(self, key, data, saved_at):
        return self.put_many([{"key": key, "data": data, "savedAt": saved_at}])

    def put_many(self, records):
        rows = [
            (
                record["key"],
                json.dumps(record["data"], ensure_ascii=False, separators=(",", ":")),
                record["savedAt"],
            )
            for record in records
        ]
        with self._connect() as conn:
            conn.executemany(
                """
                INSERT INTO explorer_cache (cache_key, response_json, saved_at)
                VALUES (?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    response_json = excluded.response_json,
                    saved_at = excluded.saved_at
                WHERE excluded.saved_at >= explorer_cache.saved_at
                """,
                rows,
            )
        return self.count()

    def count(self):
        with self._connect() as conn:
            return conn.execute("SELECT COUNT(*) FROM explorer_cache").fetchone()[0]

    def get_engine_evaluation(self, key):
        with self._connect() as conn:
            row = conn.execute(
                "SELECT cache_key, lines_json, saved_at FROM engine_evaluations WHERE cache_key = ?",
                (key,),
            ).fetchone()
        if not row:
            return None
        return {"key": row[0], "lines": json.loads(row[1]), "savedAt": row[2]}

    def put_engine_evaluations(self, records):
        rows = [
            (
                record["key"],
                json.dumps(record["lines"], ensure_ascii=False, separators=(",", ":")),
                record["savedAt"],
            )
            for record in records
        ]
        with self._connect() as conn:
            conn.executemany(
                """
                INSERT INTO engine_evaluations (cache_key, lines_json, saved_at)
                VALUES (?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    lines_json = excluded.lines_json,
                    saved_at = excluded.saved_at
                WHERE excluded.saved_at >= engine_evaluations.saved_at
                """,
                rows,
            )
        with self._connect() as conn:
            return conn.execute("SELECT COUNT(*) FROM engine_evaluations").fetchone()[0]

    def count_engine_evaluations(self):
        with self._connect() as conn:
            return conn.execute("SELECT COUNT(*) FROM engine_evaluations").fetchone()[0]

    def clear_engine_evaluations(self):
        with self._connect() as conn:
            conn.execute("DELETE FROM engine_evaluations")
