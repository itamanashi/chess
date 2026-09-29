"""Lanceur rapide pour l'application Web moderne d'étude de répertoire d'échecs.

Usage :
    python run_web.py
"""
import os
import subprocess
import sys
import webbrowser

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

    print("\nLancement du serveur Vite sur http://localhost:5173 ...")
    print("Appuyez sur Ctrl+C pour arrêter le serveur.\n")

    # Lance Vite avec ouverture automatique du navigateur
    try:
        subprocess.run(["npm", "run", "dev", "--", "--open"], cwd=WEB_DIR, check=True, shell=True)
    except KeyboardInterrupt:
        print("\nArrêt du serveur Web. À bientôt !")

if __name__ == "__main__":
    main()
