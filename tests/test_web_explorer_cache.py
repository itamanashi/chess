import json
import threading
import urllib.error
import urllib.request

from web_cache_server import create_server
from web_explorer_cache import ExplorerCacheDatabase


def test_sqlite_cache_survives_database_reopen(tmp_path):
    path = tmp_path / "explorer.sqlite3"
    data = {"white": 12, "draws": 4, "black": 8, "moves": [{"san": "e4"}]}
    ExplorerCacheDatabase(path).put("masters:fen", data, 123)

    reopened = ExplorerCacheDatabase(path)
    assert reopened.get("masters:fen") == {"data": data, "savedAt": 123}
    assert reopened.count() == 1


def test_loopback_api_get_put_and_stats(tmp_path):
    server = create_server(port=0, db_path=tmp_path / "explorer.sqlite3")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    root = f"http://127.0.0.1:{server.server_port}"
    try:
        record = {"key": "masters:fen", "data": {"moves": []}, "savedAt": 123}
        request = urllib.request.Request(
            f"{root}/api/explorer-cache/entry",
            data=json.dumps(record).encode(),
            headers={"Content-Type": "application/json"},
            method="PUT",
        )
        with urllib.request.urlopen(request) as response:
            assert json.loads(response.read()) == {"stored": True, "entries": 1}
        with urllib.request.urlopen(f"{root}/api/explorer-cache/entry?key=masters%3Afen") as response:
            assert json.loads(response.read()) == {"record": {"data": {"moves": []}, "savedAt": 123}}
        with urllib.request.urlopen(f"{root}/api/explorer-cache/stats") as response:
            assert json.loads(response.read()) == {"entries": 1, "engineEvaluations": 0}

        imported = {
            "records": [
                {"key": "masters:older", "data": {"moves": [{"san": "d4"}]}, "savedAt": 100}
            ]
        }
        migration = urllib.request.Request(
            f"{root}/api/explorer-cache/import",
            data=json.dumps(imported).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(migration) as response:
            assert json.loads(response.read()) == {"stored": 1, "entries": 2}

        eval_record = {"key": "fen|d14|pv6", "lines": [{"uci": "e2e4"}], "savedAt": 150}
        eval_import = urllib.request.Request(
            f"{root}/api/eval-cache/import",
            data=json.dumps({"records": [eval_record]}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(eval_import) as response:
            assert json.loads(response.read()) == {"stored": 1, "entries": 1}
        with urllib.request.urlopen(f"{root}/api/eval-cache/entry?key=fen%7Cd14%7Cpv6") as response:
            assert json.loads(response.read()) == {
                "record": {"key": "fen|d14|pv6", "lines": [{"uci": "e2e4"}], "savedAt": 150}
            }

        invalid = urllib.request.Request(
            f"{root}/api/explorer-cache/entry",
            data=b'{"key":"bad","data":{},"savedAt":1}',
            headers={"Content-Type": "application/json"},
            method="PUT",
        )
        try:
            urllib.request.urlopen(invalid)
            assert False, "invalid response must fail"
        except urllib.error.HTTPError as error:
            assert error.code == 400
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
