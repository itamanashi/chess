"""Loopback-only HTTP bridge for the web app's SQLite Explorer database."""

import json
import os
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from web_explorer_cache import ExplorerCacheDatabase


MAX_BODY_BYTES = 16 * 1024 * 1024


def make_handler(database):
    class CacheHandler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            print("Explorer DB: " + fmt % args)

        def _send(self, status, payload):
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path == "/api/explorer-cache/stats":
                try:
                    result = {
                        "entries": database.count(),
                        "engineEvaluations": database.count_engine_evaluations(),
                    }
                except sqlite3.Error as err:
                    self._send(500, {"error": f"Lecture SQLite impossible: {err}"})
                    return
                self._send(200, result)
                return
            prefix = "/api/explorer-cache/entry?key="
            if self.path.startswith(prefix):
                from urllib.parse import parse_qs, urlsplit

                key = parse_qs(urlsplit(self.path).query).get("key", [""])[0]
                if not key or len(key) > 4096:
                    self._send(400, {"error": "Clé de cache invalide."})
                    return
                try:
                    record = database.get(key)
                except sqlite3.Error as err:
                    self._send(500, {"error": f"Lecture SQLite impossible: {err}"})
                    return
                self._send(200, {"record": record})
                return
            engine_prefix = "/api/eval-cache/entry?key="
            if self.path.startswith(engine_prefix):
                from urllib.parse import parse_qs, urlsplit

                key = parse_qs(urlsplit(self.path).query).get("key", [""])[0]
                if not key or len(key) > 4096:
                    self._send(400, {"error": "Clé d'évaluation invalide."})
                    return
                try:
                    record = database.get_engine_evaluation(key)
                except sqlite3.Error as err:
                    self._send(500, {"error": f"Lecture SQLite impossible: {err}"})
                    return
                self._send(200, {"record": record})
                return
            self._send(404, {"error": "Route inconnue."})

        def do_PUT(self):
            if self.path != "/api/explorer-cache/entry":
                self._send(404, {"error": "Route inconnue."})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_BODY_BYTES:
                    raise ValueError("Taille de requête invalide.")
                body = json.loads(self.rfile.read(length))
                key = body.get("key")
                data = body.get("data")
                saved_at = body.get("savedAt")
                if (
                    not isinstance(key, str)
                    or not key
                    or len(key) > 4096
                    or not isinstance(data, dict)
                    or not isinstance(data.get("moves"), list)
                    or not isinstance(saved_at, int)
                ):
                    raise ValueError("Enregistrement de cache invalide.")
                entries = database.put(key, data, saved_at)
            except (ValueError, TypeError, json.JSONDecodeError) as err:
                self._send(400, {"error": str(err)})
                return
            except (OSError, sqlite3.Error) as err:
                self._send(500, {"error": f"Écriture SQLite impossible: {err}"})
                return
            self._send(200, {"stored": True, "entries": entries})

        def do_POST(self):
            if self.path == "/api/eval-cache/import":
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if length <= 0 or length > MAX_BODY_BYTES:
                        raise ValueError("Taille de requête invalide.")
                    body = json.loads(self.rfile.read(length))
                    records = body.get("records") if isinstance(body, dict) else None
                    if not isinstance(records, list) or len(records) > 250:
                        raise ValueError("Lot d'évaluations invalide.")
                    for record in records:
                        if (
                            not isinstance(record, dict)
                            or not isinstance(record.get("key"), str)
                            or not record["key"]
                            or len(record["key"]) > 4096
                            or not isinstance(record.get("lines"), list)
                            or not isinstance(record.get("savedAt"), int)
                        ):
                            raise ValueError("Évaluation invalide.")
                    entries = database.put_engine_evaluations(records)
                except (ValueError, TypeError, json.JSONDecodeError) as err:
                    self._send(400, {"error": str(err)})
                    return
                except (OSError, sqlite3.Error) as err:
                    self._send(500, {"error": f"Écriture SQLite impossible: {err}"})
                    return
                self._send(200, {"stored": len(records), "entries": entries})
                return
            if self.path != "/api/explorer-cache/import":
                self._send(404, {"error": "Route inconnue."})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_BODY_BYTES:
                    raise ValueError("Taille de requête invalide.")
                body = json.loads(self.rfile.read(length))
                records = body.get("records") if isinstance(body, dict) else None
                if not isinstance(records, list) or len(records) > 250:
                    raise ValueError("Lot de migration invalide.")
                for record in records:
                    if (
                        not isinstance(record, dict)
                        or not isinstance(record.get("key"), str)
                        or not record["key"]
                        or len(record["key"]) > 4096
                        or not isinstance(record.get("data"), dict)
                        or not isinstance(record["data"].get("moves"), list)
                        or not isinstance(record.get("savedAt"), int)
                    ):
                        raise ValueError("Enregistrement de migration invalide.")
                entries = database.put_many(records)
            except (ValueError, TypeError, json.JSONDecodeError) as err:
                self._send(400, {"error": str(err)})
                return
            except (OSError, sqlite3.Error) as err:
                self._send(500, {"error": f"Écriture SQLite impossible: {err}"})
                return
            self._send(200, {"stored": len(records), "entries": entries})

        def do_DELETE(self):
            if self.path != "/api/eval-cache":
                self._send(404, {"error": "Route inconnue."})
                return
            try:
                database.clear_engine_evaluations()
            except (OSError, sqlite3.Error) as err:
                self._send(500, {"error": f"Suppression SQLite impossible: {err}"})
                return
            self._send(200, {"cleared": True})

    return CacheHandler


def create_server(host="127.0.0.1", port=8765, db_path=None):
    if host not in ("127.0.0.1", "::1", "localhost"):
        raise ValueError("Le service de cache doit rester en loopback.")
    database = ExplorerCacheDatabase(db_path or os.environ.get("CHESS_EXPLORER_CACHE_DB"))
    return ThreadingHTTPServer((host, port), make_handler(database))


def main():
    host = "127.0.0.1"
    port = int(os.environ.get("CHESS_CACHE_PORT", "8765"))
    server = create_server(host, port)
    print(f"Base SQLite Explorer active sur http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
