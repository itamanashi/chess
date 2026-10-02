"""Lanceur rapide pour l'application Web moderne d'étude de répertoire d'échecs.

Usage :
    python run_web.py
"""
import os
import socket
import subprocess
import sys
import time
import webbrowser
from urllib.request import urlopen

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


def port_occupe(port, hote_v4="127.0.0.1", hote_v6="::1"):
    """True si quelque chose écoute déjà sur le port (IPv4 ou IPv6)."""
    for famille, hote in ((socket.AF_INET, hote_v4), (socket.AF_INET6, hote_v6)):
        try:
            with socket.socket(famille, socket.SOCK_STREAM) as s:
                s.settimeout(0.3)
                if s.connect_ex((hote, port)) == 0:
                    return True
        except OSError:
            pass
    return False

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

    # Vite est en strictPort (vite.config.ts) : une 2e instance quitte
    # immédiatement si 5173 est déjà pris (ancien serveur zombie). Mieux vaut
    # réutiliser l'onglet existant que de crasher avec un traceback.
    if port_occupe(5173):
        print("Un serveur occupe déjà le port 5173 — réutilisez l'onglet ouvert")
        print("sur http://localhost:5173/ au lieu d'en relancer un.")
        print("(Si la page ne répond plus, tuez l'ancien processus node/Vite puis relancez.)")
        webbrowser.open("http://localhost:5173/")
        cache_server.terminate()
        try:
            cache_server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cache_server.kill()
            cache_server.wait()
        return

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
    except subprocess.CalledProcessError as err:
        print(
            f"[ERREUR] Le serveur Vite s'est arrêté (code {err.returncode}).\n"
            "Causes probables : port 5173 déjà occupé par un ancien serveur\n"
            "(tuez le processus node restant), ou fenêtre console fermée pendant\n"
            "le démarrage. Relancez après vérification.",
            file=sys.stderr,
        )
        sys.exit(1)
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
