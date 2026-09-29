"""Régénère viewer.html avec les répertoires intégrés.

Usage :
    python export_viewer.py
Lit repertoire.json (obligatoire) + repertoire_blancs.json et
repertoire_noirs.json (optionnels) et produit viewer.html, ouvrable
en double-clic sans serveur.
"""
import json
import os
import sys

from board_html import render_board_html

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def charge(path):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    print(f"(!) {path} absent — bouton correspondant via Fichier… ou fetch http.")
    return None


if __name__ == "__main__":
    with open("repertoire.json", encoding="utf-8") as f:
        tous = f.read()
    extra = json.dumps(
        {"blancs": charge("repertoire_blancs.json"),
         "noirs": charge("repertoire_noirs.json")},
        ensure_ascii=False,
    )
    with open("viewer.html", "w", encoding="utf-8") as f:
        f.write(render_board_html(tous, extra_json_text=extra))
    print(f"viewer.html régénéré ({os.path.getsize('viewer.html'):,} octets).".replace(",", " "))
