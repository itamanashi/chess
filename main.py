import argparse
import os
import sys

import chess
import requests

# Force UTF-8 sur Windows pour bien afficher les accents
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


# Normalisation des roques Lichess → UCI standard (audit A4 : trois implémentations
# en conflit — unification ici pour la cohérence avec repertoire.py).
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


def _load_dotenv(path=".env"):
    """Charge un fichier .env minimaliste sans dépendance externe."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


_load_dotenv()


def get_opening_moves(
    fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    token=None,
    endpoint="masters",
    ratings=None,
    speeds=None,
    since=None,
):
    # Depuis mars 2026, l'Opening Explorer de Lichess exige une authentification.
    # Voir : https://lichess.org/@/thibault/blog/the-opening-explorer-now-requires-authentication/FSWh9Zg3
    # Crée un token gratuit (aucun scope requis) sur :
    # https://lichess.org/account/oauth/token puis passe-le via LICHESS_TOKEN.
    token = token or os.getenv("LICHESS_TOKEN")
    if not token:
        raise RuntimeError(
            "Token Lichess manquant.\n"
            "1. Crée un token gratuit sur https://lichess.org/account/oauth/token (aucun scope requis).\n"
            "2. Puis relance avec : set LICHESS_TOKEN=lip_xxx (Windows) ou export LICHESS_TOKEN=lip_xxx (Linux/Mac),\n"
            "   ou via --token lip_xxx, ou en créant un fichier .env à partir de .env.example."
        )

    if endpoint not in ("masters", "lichess"):
        raise ValueError(f"endpoint inconnu : {endpoint!r} (attendu 'masters' ou 'lichess')")

    # Miroir de web/src/services/lichess.ts : les deux endpoints partagent
    # le même format de réponse (white/draws/black + moves[]).
    if endpoint == "masters":
        url = "https://explorer.lichess.ovh/masters"
        params = {"fen": fen, "moves": "12"}
        if since is not None:
            params["since"] = str(since)
    else:
        url = "https://explorer.lichess.ovh/lichess"
        params = {
            "variant": "standard",
            "fen": fen,
            "moves": "12",
            "speeds": speeds or "blitz,rapid,classical",
        }
        if ratings:
            params["ratings"] = ratings

    headers = {
        # Lichess exige un User-Agent personnalisé identifiant l'application
        "User-Agent": "MyChessApp/1.0 (Contact: dev@example.com)",
        "Authorization": f"Bearer {token}",
    }

    try:
        response = requests.get(url, params=params, headers=headers, timeout=15)
    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"Erreur réseau vers Lichess : {e}") from e

    if response.status_code == 401:
        raise RuntimeError(
            "401 Unauthorized : token Lichess invalide ou absent.\n"
            "Vérifie ton token sur https://lichess.org/account/oauth/token "
            "et relance avec LICHESS_TOKEN=lip_xxx."
        )
    if response.status_code == 429:
        raise RuntimeError(
            "429 Too Many Requests : limite de 25 requêtes/minute dépassée. Attends un peu et réessaie."
        )
    try:
        response.raise_for_status()
    except requests.exceptions.HTTPError as e:
        raise RuntimeError(f"Erreur HTTP {response.status_code} : {response.text[:300]}") from e

    try:
        data = response.json()
    except ValueError as e:
        raise RuntimeError(f"Réponse JSON invalide de Lichess : {response.text[:300]}") from e

    moves = []
    board = chess.Board(fen)
    for move in data.get("moves", []):
        uci = move.get("uci")
        uci_std = normaliser_uci(board, uci) if uci else uci
        try:
            move_obj_uci = chess.Move.from_uci(uci_std) if uci_std else None
            legal = move_obj_uci is not None and move_obj_uci in board.legal_moves
        except ValueError:
            legal = False
        if not legal:
            continue
        # L'endpoint lichess renvoie toujours san, mais on le recalcule
        # en repli (comme lichess_repertoire.py) pour ne jamais casser.
        try:
            san = move.get("san") or board.san(move_obj_uci)
        except ValueError:
            continue
        move_obj = {
            "coup": san,
            "uci": uci_std,
            "san": san,
            "parties": move.get("white", 0) + move.get("draws", 0) + move.get("black", 0),
            "victoires_blancs": move.get("white", 0),
            "nuls": move.get("draws", 0),
            "victoires_noirs": move.get("black", 0),
            "score_moyen": move.get("averageRating"),
            "ouverture": (move.get("opening") or {}).get("name"),
            "eco": (move.get("opening") or {}).get("eco"),
        }
        board.push(move_obj_uci)
        moves.append(move_obj)
        board.pop()

    return moves


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Affiche les coups d'ouverture les plus joués (Lichess Masters)."
    )
    parser.add_argument(
        "--fen",
        default="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        help="Position FEN à analyser (défaut : position initiale).",
    )
    parser.add_argument(
        "--token",
        default=None,
        help="Token Lichess (défaut : variable d'environnement LICHESS_TOKEN).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=5,
        help="Nombre de coups à afficher (défaut : 5).",
    )
    return parser.parse_args(argv)

if __name__ == "__main__":
    args = parse_args()
    try:
        top_moves = get_opening_moves(fen=args.fen, token=args.token)
    except RuntimeError as e:
        print(f"Erreur : {e}", file=sys.stderr)
        sys.exit(1)

    if not top_moves:
        print("Aucun coup trouvé pour cette position.")
        sys.exit(0)

    print("Coups les plus joués par les Grands Maîtres (position initiale) :")
    for m in top_moves[:args.limit]:
        total = m['parties']
        p_white = round((m['victoires_blancs'] / total) * 100, 1) if total > 0 else 0
        p_draw = round((m['nuls'] / total) * 100, 1) if total > 0 else 0
        p_black = round((m['victoires_noirs'] / total) * 100, 1) if total > 0 else 0

        print(f"- {m['coup']} : {total:,} parties | Blancs: {p_white}% | Nuls: {p_draw}% | Noirs: {p_black}%")