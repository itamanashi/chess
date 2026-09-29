"""
Lichess Elo Repertoire Builder (Dashboard V3 avec Rich)
======================================================
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Optional, Callable

import requests
import chess

from rich.console import Console
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.tree import Tree
from rich.text import Text
from rich.layout import Layout

console = Console()

DEFAULT_OUTPUT = "lichess_repertoire"
DEFAULT_RANGES = [(1000, 1200), (1200, 1400), (1400, 1600), (1600, 1800), (1800, 2000), (2000, 2200), (2200, 2500)]
LICHESS_RATING_GROUPS = [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500]


# ============================================================
# STATISTIQUES & CACHE
# ============================================================

class AppState:
    """Conserve l'état global pour le rendu du Dashboard."""
    def __init__(self):
        self.api_calls = 0
        self.cache_hits = 0
        self.rate_limits = 0
        self.current_path: list[str] = []
        self.current_depth = 0
        self.current_color = "white"
        self.range_str = ""
        self.last_action = "Initialisation..."

    @property
    def total_requests(self) -> int:
        return self.api_calls + self.cache_hits

    @property
    def cache_ratio(self) -> float:
        if self.total_requests == 0:
            return 0.0
        return (self.cache_hits / self.total_requests) * 100


state = AppState()


class Cache:
    def __init__(self, directory: Path):
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)

    def _filename(self, url: str, params: dict) -> Path:
        raw = url + "?" + "&".join(f"{k}={params[k]}" for k in sorted(params))
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        return self.directory / f"{digest}.json"

    def get(self, url: str, params: dict):
        path = self._filename(url, params)
        if not path.exists():
            return None
        try:
            with path.open("r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    def put(self, url: str, params: dict, data):
        path = self._filename(url, params)
        tmp = path.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(data, f)
        tmp.replace(path)


# ============================================================
# CLIENT LICHESS API
# ============================================================

class LichessExplorer:
    BASE_URL = "https://explorer.lichess.ovh/lichess"

    def __init__(self, cache: Cache, token: Optional[str] = None, delay: float = 0.5, timeout: int = 30):
        self.cache = cache
        self.delay = delay
        self.timeout = timeout
        self.session = requests.Session()
        
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
        }
        if token:
            headers["Authorization"] = f"Bearer {token.strip()}"
        self.session.headers.update(headers)

    def query(self, fen: str, ratings: list[int], speeds: Optional[list[str]] = None) -> dict:
        params = {
            "variant": "standard",
            "fen": fen,
            "moves": "12",
            "ratings": ",".join(str(r) for r in ratings),
        }
        if speeds:
            params["speeds"] = ",".join(speeds)

        cached = self.cache.get(self.BASE_URL, params)
        if cached is not None:
            state.cache_hits += 1
            state.last_action = "[bold green]HIT CACHE[/bold green]"
            return cached

        state.api_calls += 1
        state.last_action = "[bold yellow]REQUÊTE API[/bold yellow]"
        time.sleep(self.delay)

        response = self.session.get(self.BASE_URL, params=params, timeout=self.timeout)

        if response.status_code == 429:
            state.rate_limits += 1
            state.last_action = "[bold red]RATE LIMIT (429) - Pause 60s...[/bold red]"
            time.sleep(60)
            response = self.session.get(self.BASE_URL, params=params, timeout=self.timeout)

        response.raise_for_status()
        data = response.json()
        self.cache.put(self.BASE_URL, params, data)
        return data


# ============================================================
# TRAITEMENT DU RÉPERTOIRE & ARBRE
# ============================================================

def safe_rate(value: int, total: int) -> float:
    return round(value / total * 100, 2) if total > 0 else 0.0


class RepertoireBuilder:
    def __init__(self, explorer: LichessExplorer, rating_groups: list[int], max_depth: int = 16, min_games: int = 100, min_frequency: float = 2.0, max_moves: int = 5, speeds: Optional[list[str]] = None, on_update: Optional[Callable[[], None]] = None):
        self.explorer = explorer
        self.rating_groups = rating_groups
        self.max_depth = max_depth
        self.min_games = min_games
        self.min_frequency = min_frequency
        self.max_moves = max_moves
        self.speeds = speeds
        self.on_update = on_update

    def build(self, repertoire_color: str) -> dict:
        state.current_color = repertoire_color
        return self._build_position(chess.Board(), 0, repertoire_color, [])

    def _build_position(self, board: chess.Board, depth: int, repertoire_color: str, path: list[str]) -> dict:
        state.current_depth = depth
        state.current_path = path

        if self.on_update:
            self.on_update()

        if depth >= self.max_depth:
            return {"fen": board.fen(), "depth": depth, "path": path, "leaf": True}

        data = self.explorer.query(board.fen(), self.rating_groups, self.speeds)
        
        if self.on_update:
            self.on_update()

        total_games = data.get("white", 0) + data.get("draws", 0) + data.get("black", 0)
        moves_list = []

        for move in data.get("moves", []):
            uci = move["uci"]
            try:
                san = board.san(chess.Move.from_uci(uci))
            except Exception:
                san = uci
            
            games = move.get("white", 0) + move.get("draws", 0) + move.get("black", 0)
            w_rate = safe_rate(move.get("white", 0), games)
            b_rate = safe_rate(move.get("black", 0), games)
            eval_score = round((w_rate - b_rate) / 100 * 2.0, 2)

            moves_list.append({
                "uci": uci, "san": san, "games": games,
                "frequency": safe_rate(games, total_games),
                "eval_score": eval_score, "child": None
            })

        moves_list.sort(key=lambda x: x["games"], reverse=True)

        candidate_moves = [m for m in moves_list if m["games"] >= self.min_games and m["frequency"] >= self.min_frequency]
        is_my_turn = (board.turn == chess.WHITE and repertoire_color == "white") or (board.turn == chess.BLACK and repertoire_color == "black")
        candidate_moves = candidate_moves[:1] if is_my_turn else candidate_moves[:self.max_moves]

        node_moves = []
        for move in candidate_moves:
            try:
                chess_move = chess.Move.from_uci(move["uci"])
            except ValueError:
                continue

            if chess_move not in board.legal_moves:
                continue

            child_board = board.copy()
            child_board.push(chess_move)
            child_node = self._build_position(child_board, depth + 1, repertoire_color, path + [move["san"]])

            move["child"] = child_node
            node_moves.append(move)

        return {"fen": board.fen(), "depth": depth, "path": path, "moves": node_moves}


# ============================================================
# COMPOSANTS VISUELS (RICH)
# ============================================================

def make_dashboard_layout() -> Layout:
    layout = Layout()
    layout.split_column(
        Layout(name="header", size=3),
        Layout(name="body", ratio=1),
        Layout(name="footer", size=1),
    )
    layout["body"].split_row(
        Layout(name="tree_view", ratio=2),
        Layout(name="stats_view", ratio=1),
    )
    return layout


def render_tree() -> Panel:
    tree = Tree("[bold cyan]Échiquier (Origine)[/bold cyan]")
    curr = tree
    # Rendu dynamique du chemin actuel
    for move in state.current_path:
        curr = curr.add(f"[bold yellow]{move}[/bold yellow]")
    
    return Panel(tree, title=f"[bold]Ligne Actuelle (Profondeur: {state.current_depth})[/bold]", border_style="blue")


def render_stats() -> Panel:
    table = Table.grid(expand=True, padding=(0, 1))
    table.add_column(justify="left", style="bold white")
    table.add_column(justify="right")

    table.add_row("Plage Elo:", f"[cyan]{state.range_str}[/cyan]")
    table.add_row("Couleur:", f"[bold {state.current_color}]{state.current_color.upper()}[/bold {state.current_color}]")
    table.add_row("Appels API:", f"[yellow]{state.api_calls}[/yellow]")
    table.add_row("Cache Hits:", f"[green]{state.cache_hits}[/green]")
    table.add_row("Ratio Cache:", f"[bold green]{state.cache_ratio:.1f}%[/bold green]")
    table.add_row("Rate Limits (429):", f"[red]{state.rate_limits}[/red]")
    table.add_row("Dernier Statut:", state.last_action)

    return Panel(table, title="[bold]Statistiques[/bold]", border_style="magenta")


# ============================================================
# MAIN LOOP
# ============================================================

def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--ranges", nargs="+", type=lambda x: tuple(map(int, x.split("-"))), default=DEFAULT_RANGES)
    parser.add_argument("--depth", type=int, default=16)
    parser.add_argument("--min-games", type=int, default=100)
    parser.add_argument("--min-frequency", type=float, default=2.0)
    parser.add_argument("--max-moves", type=int, default=5)
    parser.add_argument("--delay", type=float, default=0.5)
    parser.add_argument("--speeds", nargs="+", default=["blitz", "rapid"])
    parser.add_argument("--token", type=str, default=None)
    return parser.parse_args()


def main():
    args = parse_args()
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    cache = Cache(output_dir / ".cache")
    explorer = LichessExplorer(cache=cache, token=args.token, delay=args.delay)

    layout = make_dashboard_layout()
    header_text = Text("LICHESS ELO REPERTOIRE BUILDER V3", style="bold gold1", justify="center")
    layout["header"].update(Panel(header_text, style="on blue"))
    layout["footer"].update(Text("Appuie sur Ctrl+C pour interrompre l'exécution.", style="dim italic", justify="center"))

    with Live(layout, refresh_per_second=10, console=console):
        for low, high in args.ranges:
            state.range_str = f"{low}-{high}"
            groups = [r for r in LICHESS_RATING_GROUPS if low <= r < high] or [1600]

            for color in ["blancs", "noirs"]:
                color_dir = output_dir / color / state.range_str
                color_dir.mkdir(parents=True, exist_ok=True)
                repertoire_color = "white" if color == "blancs" else "black"

                def update_ui():
                    layout["body"]["tree_view"].update(render_tree())
                    layout["body"]["stats_view"].update(render_stats())

                builder = RepertoireBuilder(
                    explorer=explorer,
                    rating_groups=groups,
                    max_depth=args.depth,
                    min_games=args.min_games,
                    min_frequency=args.min_frequency,
                    max_moves=args.max_moves,
                    speeds=args.speeds,
                    on_update=update_ui
                )

                tree = builder.build(repertoire_color)
                update_ui()

                json_data = {"metadata": {"color": repertoire_color, "range": state.range_str}, "tree": tree}
                (color_dir / "repertoire.json").write_text(json.dumps(json_data, indent=2), encoding="utf-8")

    console.print("\n[bold green]✓ Répertoires générés avec succès ![/bold green]")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        console.print("\n[bold red]Interruption utilisateur.[/bold red]")
        sys.exit(0)