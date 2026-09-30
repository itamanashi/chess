"""Lanceur rapide pour l'application Web moderne d'étude de répertoire d'échecs.

Usage :
    python run_web.py
"""
import os
import subprocess
import sys
import time
import webbrowser
from urllib.request import urlopen

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

def main():
    print("=" * 60)
    print("  Chess Repertoire Studio — Démarrage du serveur Web...")
    print("=" * 60)

    if not os.path.isdir(WEB_DIR):
        print(f"Erreur : Dossier 'web' introuvable dans {WEB_DIR}", file=sys.stderr)
        sys.exit(1)

    node_modules = os.path.join(WEB_DIR, "node_modules")
    if not os.path.isdir(node_modules):
        print("Installation des dépendances npm requises...")
        subprocess.run(["npm", "install"], cwd=WEB_DIR, check=True, shell=True)

    print("\nLancement de la base SQLite locale et du serveur Web...")
    cache_server = subprocess.Popen(
        [sys.executable, os.path.join(os.path.dirname(__file__), "web_cache_server.py")],
        cwd=os.path.dirname(os.path.abspath(__file__)),
    )
    for _ in range(50):
        if cache_server.poll() is not None:
            raise RuntimeError("Le service de base SQLite n'a pas pu démarrer sur le port 8765.")
        try:
            with urlopen("http://127.0.0.1:8765/api/explorer-cache/stats", timeout=0.2):
                break
        except OSError:
            time.sleep(0.1)
    else:
        cache_server.terminate()
        cache_server.wait(timeout=5)
        raise RuntimeError("Délai dépassé au démarrage de la base SQLite locale.")
    print("Appuyez sur Ctrl+C pour arrêter le serveur.\n")

    try:
        web_env = os.environ.copy()
        web_env["VITE_SQLITE_CACHE_ENABLED"] = "true"
        subprocess.run(
            ["npm", "run", "dev", "--", "--open"],
            cwd=WEB_DIR,
            check=True,
            shell=True,
            env=web_env,
        )
    except KeyboardInterrupt:
        print("\nArrêt du serveur Web. À bientôt !")
    finally:
        cache_server.terminate()
        try:
            cache_server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cache_server.kill()
            cache_server.wait()

if __name__ == "__main__":
    main()
