"""Construit un répertoire d'ouverture à partir de Lichess Masters et l'exporte en PGN.

Exemple :
    python repertoire.py --depth 12 --max-moves 2 --min-games 1000 --output repertoire.pgn
    python repertoire.py --couleur blancs --depth 6 --max-moves 3
"""
import argparse
import json
import os
import sys
import time

import chess
import chess.pgn

from main import get_opening_moves

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

FEN_INITIAL = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

ROQUES_UCI = {"e1h1": "e1g1", "e1a1": "e1c1", "e8h8": "e8g8", "e8a8": "e8c8"}


def normaliser_uci(board, uci):
    """L'API Lichess renvoie le roque en UCI style Chess960 (roi "prend" la tour,
    ex. e1h1) alors que python-chess attend la notation standard (e1g1).
    Sans conversion, O-O / O-O-O sont rejetés comme illégaux."""
    if len(uci) == 4 and uci in ROQUES_UCI:
        piece = board.piece_at(chess.parse_square(uci[:2]))
        if piece is not None and piece.symbol().lower() == "k":
            return ROQUES_UCI[uci]
    return uci


def construire_arbre(fen_depart=FEN_INITIAL, profondeur_max=12, coups_max=2,
                     min_parties=1000, max_positions=200, delai=3.0,
                     token=None, couleur="tous", verbose=True):
    """Explore récursivement l'explorer Masters et renvoie (racine, stats).

    racine = {"fen": ..., "children": [ {..., "fen": ..., "children": [...]}, ... ]}
    Chaque enfant contient : uci, san, coup, parties, victoires_blancs, nuls,
    victoires_noirs, ouverture, eco, fen, children.
    """
    cache = {}  # fen -> liste de coups API
    positions_interrogees = 0

    def coups_filtres(fen, trait_blanc):
        nonlocal positions_interrogees
        if fen in cache:
            return cache[fen]
        if positions_interrogees >= max_positions:
            return []
        try:
            coups = get_opening_moves(fen=fen, token=token)
        except RuntimeError as e:
            print(f"[!] {e}", file=sys.stderr)
            return []
        positions_interrogees += 1
        if verbose:
            print(f"[{positions_interrogees}/{max_positions}] {fen[:40]}... -> {len(coups)} coups", flush=True)
        # Filtre nombre de parties minimum
        coups = [c for c in coups if c.get("parties", 0) >= min_parties and c.get("uci")]
        # Nombre de coups à garder selon la couleur du répertoire
        if couleur == "blancs":
            limite = 1 if trait_blanc else coups_max
        elif couleur == "noirs":
            limite = coups_max if trait_blanc else 1
        else:
            limite = coups_max
        coups = coups[:limite]
        cache[fen] = coups
        if positions_interrogees < max_positions:
            time.sleep(delai)  # limite Lichess : 25 req/min
        return coups

    def explorer(board, profondeur):
        noeud = {"fen": board.fen(), "children": []}
        if profondeur >= profondeur_max:
            return noeud
        if positions_interrogees >= max_positions:
            return noeud
        trait_blanc = board.turn == chess.WHITE
        for coup in coups_filtres(board.fen(), trait_blanc):
            try:
                uci_std = normaliser_uci(board, coup["uci"])
                move = chess.Move.from_uci(uci_std)
                if move not in board.legal_moves:
                    continue
            except ValueError:
                continue
            board.push(move)
            enfant = dict(coup)  # copie san/uci/stats/ouverture
            enfant["uci"] = uci_std
            enfant["fen"] = board.fen()
            sous_arbre = explorer(board, profondeur + 1)
            enfant["children"] = sous_arbre["children"]
            noeud["children"].append(enfant)
            board.pop()
            if positions_interrogees >= max_positions:
                break
        return noeud

    board = chess.Board(fen_depart)
    racine = explorer(board, 0)
    stats = {"positions_interrogees": positions_interrogees, "positions_cache": len(cache)}
    return racine, stats


def compter_lignes(noeud):
    """Nombre de lignes (variantes terminales) dans l'arbre."""
    if not noeud["children"]:
        return 1
    return sum(compter_lignes(c) for c in noeud["children"])


def exporter_pgn(racine, fen_depart=FEN_INITIAL, chemin="repertoire.pgn", couleur="tous"):
    board = chess.Board(fen_depart)
    jeu = chess.pgn.Game()
    jeu.headers["Event"] = f"Répertoire d'ouverture ({couleur})"
    jeu.headers["Site"] = "Lichess Masters Explorer"
    jeu.headers["White"] = "Répertoire Blancs" if couleur in ("blancs", "tous") else "Adversaire"
    jeu.headers["Black"] = "Répertoire Noirs" if couleur in ("noirs", "tous") else "Adversaire"
    jeu.headers["FEN"] = fen_depart
    jeu.setup(board)

    def ajouter_variantes(noeud_pgn, echiquier, enfants):
        for i, enfant in enumerate(enfants):
            try:
                coup = chess.Move.from_uci(enfant["uci"])
            except (ValueError, KeyError):
                continue
            commentaire = f"{enfant.get('ouverture') or ''} — {enfant.get('parties', 0):,} parties".strip(" —")
            if i == 0:
                suivant = noeud_pgn.add_main_variation(coup)
            else:
                suivant = noeud_pgn.add_variation(coup)
            if commentaire:
                suivant.comment = commentaire
            echiquier.push(coup)
            ajouter_variantes(suivant, echiquier, enfant.get("children", []))
            echiquier.pop()

    ajouter_variantes(jeu, board, racine.get("children", []))
    with open(chemin, "w", encoding="utf-8") as f:
        print(jeu, file=f)
    return chemin


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Construit un répertoire d'ouverture (Lichess Masters) en PGN.")
    p.add_argument("--fen", default=FEN_INITIAL, help="FEN de départ.")
    p.add_argument("--depth", type=int, default=12, help="Profondeur max en plis (demi-coups). Défaut : 12.")
    p.add_argument("--max-moves", type=int, default=2, help="Coups gardés par position. Défaut : 2.")
    p.add_argument("--min-games", type=int, default=1000, help="Seuil min de parties. Défaut : 1000.")
    p.add_argument("--max-positions", type=int, default=200, help="Budget max de requêtes API. Défaut : 200.")
    p.add_argument("--delay", type=float, default=3.0, help="Pause entre requêtes (s). Défaut : 3.0.")
    p.add_argument("--couleur", choices=["blancs", "noirs", "tous"], default="tous")
    p.add_argument("--output", default="repertoire.pgn", help="Fichier PGN de sortie.")
    p.add_argument("--json", default=None, help="Fichier JSON optionnel pour l'arbre brut.")
    p.add_argument("--token", default=None, help="Token Lichess (défaut : LICHESS_TOKEN / .env).")
    return p.parse_args(argv)


if __name__ == "__main__":
    args = parse_args()
    print(f"Construction du répertoire ({args.couleur}) : profondeur={args.depth}, "
          f"coups/pos={args.max_moves}, min_parties={args.min_games}, "
          f"max_positions={args.max_positions} ...")
    racine, stats = construire_arbre(
        fen_depart=args.fen,
        profondeur_max=args.depth,
        coups_max=args.max_moves,
        min_parties=args.min_games,
        max_positions=args.max_positions,
        delai=args.delay,
        token=args.token,
        couleur=args.couleur,
    )
    lignes = compter_lignes(racine)
    chemin = exporter_pgn(racine, fen_depart=args.fen, chemin=args.output, couleur=args.couleur)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(racine, f, ensure_ascii=False, indent=2)
        print(f"Arbre JSON : {args.json}")
    print(f"Terminé : {stats['positions_interrogees']} positions interrogées, "
          f"{lignes} lignes, PGN -> {os.path.abspath(chemin)}")
    print("Importe ce PGN dans Lichess (Étude > Importer PGN) pour t'entraîner.")
