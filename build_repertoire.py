"""Construit un répertoire perso : TES coups + réponses adverses de l'API.

À chacun de tes tours, le script affiche les coups les plus joués et te
demande de choisir. Les coups adverses sont pris automatiquement (top N).
Chaque réponse API est enregistrée dans une base SQLite (db_cache.py)
indexée par position, pour ne jamais payer deux fois la même requête.

Exemples :
    python build_repertoire.py --couleur blancs
    python build_repertoire.py --couleur noirs --depth 8 --reponses 3
    python build_repertoire.py --couleur blancs --auto   (sans interaction)
"""
import argparse
import json
import os
import sys
import time

import chess

import db_cache
from repertoire import compter_lignes, exporter_pgn, normaliser_uci

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

FEN_INITIAL = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def fmt(n):
    return f"{n:,}".replace(",", " ")


def choisir_coup_interactif(coups, auto=False):
    """Affiche les candidats et demande le coup de l'utilisateur."""
    top = coups[:8]
    total_pos = sum(c.get("parties", 0) for c in coups) or 1
    for i, c in enumerate(top):
        total = c.get("parties", 0) or 1
        part = round(100 * c.get("parties", 0) / total_pos, 1)
        pw = round(100 * c.get("victoires_blancs", 0) / total, 1)
        pb = round(100 * c.get("victoires_noirs", 0) / total, 1)
        print(f"  {i + 1}. {c['san']:6} {fmt(c.get('parties', 0)):>12} parties "
              f"({part}% du poste) | B {pw}% / N {pb}% | {c.get('ouverture') or ''}")
    if auto:
        print(f"  -> auto : {top[0]['san']}")
        return top[0]
    while True:
        try:
            rep = input("Ton coup [numéro/SAN, Entrée=défaut 1, s=stopper cette branche] : ").strip()
        except EOFError:
            print("\n  -> fin d'entrée, défaut : 1")
            return top[0]
        if rep == "":
            return top[0]
        if rep.lower() in ("s", "stop", "q"):
            return None
        if rep.isdigit() and 1 <= int(rep) <= len(top):
            return top[int(rep) - 1]
        normalise = rep.replace("+", "").replace("#", "").replace("!", "").replace("?", "").lower()
        for c in top:
            if c["san"].replace("+", "").replace("#", "").lower() == normalise:
                return c
            if c.get("uci", "").lower() == normalise:
                return c
        print("  Choix non reconnu, réessaie.")


def construire(fen_depart=FEN_INITIAL, couleur="blancs", profondeur_max=8,
               reponses=2, min_parties=500, max_positions=150, delai=3.0,
               token=None, db_path=db_cache.DB_DEFAUT, auto=False):
    moi = chess.WHITE if couleur == "blancs" else chess.BLACK
    requetes, hits = 0, 0

    def explorer(board, profondeur):
        nonlocal requetes, hits
        noeud = {"fen": board.fen(), "children": []}
        if profondeur >= profondeur_max or requetes >= max_positions:
            return noeud
        try:
            coups, en_cache = db_cache.fetch_moves(board.fen(), token=token, db_path=db_path)
        except RuntimeError as e:
            print(f"[!] {e}")
            return noeud
        if en_cache:
            hits += 1
        else:
            requetes += 1
            print(f"[API {requetes}/{max_positions}] {board.fen()[:45]}... ({len(coups)} coups)")
            time.sleep(delai)
        coups = [c for c in coups if c.get("parties", 0) >= min_parties and c.get("uci")]
        if not coups:
            return noeud

        if board.turn == moi:
            print(f"\n--- À TOI ({'Blancs' if moi else 'Noirs'}, pli {profondeur + 1}) ---")
            print(f"FEN : {board.fen()}")
            choix = choisir_coup_interactif(coups, auto=auto)
            selection = [choix] if choix else []
            if not choix:
                print("  Branche stoppée.")
        else:
            selection = coups[:reponses]

        for coup in selection:
            try:
                uci_std = normaliser_uci(board, coup["uci"])
                move = chess.Move.from_uci(uci_std)
                if move not in board.legal_moves:
                    continue
            except ValueError:
                continue
            board.push(move)
            enfant = dict(coup)
            enfant["uci"] = uci_std
            enfant["fen"] = board.fen()
            enfant["children"] = explorer(board, profondeur + 1)["children"]
            noeud["children"].append(enfant)
            board.pop()
            if requetes >= max_positions:
                break
        return noeud

    racine = explorer(chess.Board(fen_depart), 0)
    return racine, {"requetes_api": requetes, "hits_cache": hits}


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Construit un répertoire perso (tes coups + réponses API).")
    p.add_argument("--couleur", choices=["blancs", "noirs"], required=True)
    p.add_argument("--depth", type=int, default=8)
    p.add_argument("--reponses", type=int, default=2, help="Réponses adverses gardées par position.")
    p.add_argument("--min-games", type=int, default=500)
    p.add_argument("--max-positions", type=int, default=150, help="Budget max de requêtes API.")
    p.add_argument("--delay", type=float, default=3.0)
    p.add_argument("--db", default=db_cache.DB_DEFAUT)
    p.add_argument("--output", default=None, help="Base du nom de sortie (défaut : repertoire_<couleur>).")
    p.add_argument("--auto", action="store_true", help="Choisit toujours le coup le plus joué (non interactif).")
    p.add_argument("--token", default=None)
    return p.parse_args(argv)


if __name__ == "__main__":
    args = parse_args()
    base = args.output or f"repertoire_{args.couleur}"
    print(f"Répertoire {args.couleur} : profondeur={args.depth}, "
          f"réponses/pos={args.reponses}, min_parties={args.min_games}, base={args.db}")
    racine, stats = construire(
        couleur=args.couleur, profondeur_max=args.depth, reponses=args.reponses,
        min_parties=args.min_games, max_positions=args.max_positions,
        delai=args.delay, token=args.token, db_path=args.db, auto=args.auto,
    )
    with open(base + ".json", "w", encoding="utf-8") as f:
        json.dump(racine, f, ensure_ascii=False, indent=2)
    exporter_pgn(racine, fen_depart=FEN_INITIAL, chemin=base + ".pgn", couleur=args.couleur)
    lignes = compter_lignes(racine)
    n_db, last = db_cache.stats_db(args.db)
    print(f"\nTerminé : {lignes} lignes -> {os.path.abspath(base + '.pgn')}")
    print(f"API : {stats['requetes_api']} requêtes, {stats['hits_cache']} lectures cache. "
          f"Base : {n_db} positions enregistrées.")
