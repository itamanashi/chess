"""Tests pour repertoire.py - Construction d'arbre de répertoire."""
import pytest
from unittest.mock import patch, Mock
import chess
import repertoire


class TestNormaliserUci:
    """Tests pour normaliser_uci()."""

    def test_short_castling_white(self):
        """Petit roque blanc doit être normalisé."""
        board = chess.Board()
        # Lichess renvoie e1h1, python-chess attend e1g1
        assert repertoire.normaliser_uci(board, "e1h1") == "e1g1"

    def test_long_castling_white(self):
        """Grand roque blanc doit être normalisé."""
        board = chess.Board()
        assert repertoire.normaliser_uci(board, "e1a1") == "e1c1"

    def test_short_castling_black(self):
        """Petit roque noir doit être normalisé."""
        board = chess.Board()
        assert repertoire.normaliser_uci(board, "e8h8") == "e8g8"

    def test_long_castling_black(self):
        """Grand roque noir doit être normalisé."""
        board = chess.Board()
        assert repertoire.normaliser_uci(board, "e8a8") == "e8c8"

    def test_regular_move_unchanged(self):
        """Coup normal ne doit pas être modifié."""
        board = chess.Board()
        assert repertoire.normaliser_uci(board, "e2e4") == "e2e4"

    def test_non_king_move_unchanged(self):
        """Coup ressemblant au roque mais pas du roi."""
        board = chess.Board()
        assert repertoire.normaliser_uci(board, "a1h1") == "a1h1"


class TestConstruireArbre:
    """Tests pour construire_arbre()."""

    @patch('repertoire.get_opening_moves')
    def test_basic_tree_construction(self, mock_api):
        """Construction d'arbre basique."""
        mock_api.return_value = [
            {
                "coup": "e4",
                "san": "e4",
                "uci": "e2e4",
                "parties": 10000,
                "victoires_blancs": 5000,
                "nuls": 2000,
                "victoires_noirs": 3000,
                "ouverture": "King's Pawn",
                "eco": "B00"
            }
        ]

        racine, stats = repertoire.construire_arbre(
            profondeur_max=1,
            coups_max=1,
            min_parties=1000,
            max_positions=10,
            delai=0.1,
            verbose=False
        )

        assert racine["fen"] == "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        assert len(racine["children"]) == 1
        assert racine["children"][0]["san"] == "e4"

    @patch('repertoire.get_opening_moves')
    def test_respects_max_depth(self, mock_api):
        """Doit respecter la profondeur maximale."""
        mock_api.return_value = [
            {"coup": "e4", "san": "e4", "uci": "e2e4", "parties": 10000}
        ]

        racine, stats = repertoire.construire_arbre(
            profondeur_max=0,
            coups_max=5,
            max_positions=100,
            delai=0.1,
            verbose=False
        )

        assert len(racine["children"]) == 0

    @patch('repertoire.get_opening_moves')
    def test_filters_by_min_games(self, mock_api):
        """Doit filtrer par nombre minimum de parties."""
        mock_api.return_value = [
            {"coup": "e4", "san": "e4", "uci": "e2e4", "parties": 10000},
            {"coup": "d4", "san": "d4", "uci": "d2d4", "parties": 500}
        ]

        racine, stats = repertoire.construire_arbre(
            profondeur_max=1,
            coups_max=5,
            min_parties=1000,
            max_positions=10,
            delai=0.1,
            verbose=False
        )

        assert len(racine["children"]) == 1
        assert racine["children"][0]["coup"] == "e4"

    @patch('repertoire.get_opening_moves')
    def test_limits_moves_per_position(self, mock_api):
        """Doit limiter le nombre de coups par position."""
        mock_api.return_value = [
            {"coup": "e4", "san": "e4", "uci": "e2e4", "parties": 10000},
            {"coup": "d4", "san": "d4", "uci": "d2d4", "parties": 9000},
            {"coup": "Nf3", "san": "Nf3", "uci": "g1f3", "parties": 8000}
        ]

        racine, stats = repertoire.construire_arbre(
            profondeur_max=1,
            coups_max=2,
            min_parties=1000,
            max_positions=10,
            delai=0.1,
            verbose=False
        )

        assert len(racine["children"]) == 2

    @patch('repertoire.get_opening_moves')
    def test_respects_max_positions(self, mock_api):
        """Doit respecter le budget de requêtes."""
        mock_api.return_value = [
            {"coup": "e4", "san": "e4", "uci": "e2e4", "parties": 10000}
        ]

        racine, stats = repertoire.construire_arbre(
            profondeur_max=10,
            coups_max=1,
            min_parties=1000,
            max_positions=2,
            delai=0.1,
            verbose=False
        )

        assert stats["positions_interrogees"] <= 2

    @patch('repertoire.get_opening_moves')
    def test_couleur_blancs_mode(self, mock_api):
        """Mode blancs : 1 coup aux blancs, N coups aux noirs."""
        mock_api.return_value = [
            {"coup": "e4", "san": "e4", "uci": "e2e4", "parties": 10000},
            {"coup": "d4", "san": "d4", "uci": "d2d4", "parties": 9000}
        ]

        racine, stats = repertoire.construire_arbre(
            profondeur_max=1,
            coups_max=3,
            couleur="blancs",
            max_positions=10,
            delai=0.1,
            verbose=False
        )

        # Aux blancs : 1 seul coup (le meilleur)
        assert len(racine["children"]) == 1

    @patch('repertoire.get_opening_moves')
    def test_couleur_noirs_mode(self, mock_api):
        """Mode noirs : N coups aux blancs, 1 coup aux noirs."""
        mock_api.return_value = [
            {"coup": "e4", "san": "e4", "uci": "e2e4", "parties": 10000},
            {"coup": "d4", "san": "d4", "uci": "d2d4", "parties": 9000}
        ]

        racine, stats = repertoire.construire_arbre(
            profondeur_max=1,
            coups_max=3,
            couleur="noirs",
            max_positions=10,
            delai=0.1,
            verbose=False
        )

        # Aux blancs : coups_max coups
        assert len(racine["children"]) <= 3

    @patch('repertoire.get_opening_moves')
    def test_handles_api_error_gracefully(self, mock_api):
        """Erreur API ne doit pas crasher, juste arrêter la branche."""
        mock_api.side_effect = RuntimeError("API error")

        racine, stats = repertoire.construire_arbre(
            profondeur_max=2,
            coups_max=2,
            max_positions=10,
            delai=0.1,
            verbose=False
        )

        assert racine["fen"] == "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        assert len(racine["children"]) == 0


class TestCompterLignes:
    """Tests pour compter_lignes()."""

    def test_empty_tree(self):
        """Arbre vide = 1 ligne."""
        noeud = {"fen": "...", "children": []}
        assert repertoire.compter_lignes(noeud) == 1

    def test_single_branch(self):
        """Branche unique = 1 ligne."""
        noeud = {
            "fen": "...",
            "children": [
                {
                    "fen": "...",
                    "children": [
                        {"fen": "...", "children": []}
                    ]
                }
            ]
        }
        assert repertoire.compter_lignes(noeud) == 1

    def test_multiple_branches(self):
        """Plusieurs branches."""
        noeud = {
            "fen": "...",
            "children": [
                {"fen": "...", "children": []},
                {"fen": "...", "children": []},
                {"fen": "...", "children": []}
            ]
        }
        assert repertoire.compter_lignes(noeud) == 3

    def test_complex_tree(self):
        """Arbre complexe."""
        noeud = {
            "fen": "...",
            "children": [
                {
                    "fen": "...",
                    "children": [
                        {"fen": "...", "children": []},
                        {"fen": "...", "children": []}
                    ]
                },
                {"fen": "...", "children": []}
            ]
        }
        assert repertoire.compter_lignes(noeud) == 3


class TestExporterPgn:
    """Tests pour exporter_pgn()."""

    def test_exports_simple_tree(self, tmp_path):
        """Export PGN d'un arbre simple."""
        racine = {
            "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            "children": [
                {
                    "uci": "e2e4",
                    "parties": 10000,
                    "ouverture": "King's Pawn",
                    "children": []
                }
            ]
        }

        output = tmp_path / "test.pgn"
        result = repertoire.exporter_pgn(racine, chemin=str(output))

        assert output.exists()
        content = output.read_text(encoding="utf-8")
        assert "1. e4" in content

    def test_exports_with_variations(self, tmp_path):
        """Export PGN avec variantes."""
        racine = {
            "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            "children": [
                {
                    "uci": "e2e4",
                    "parties": 10000,
                    "ouverture": "King's Pawn",
                    "children": []
                },
                {
                    "uci": "d2d4",
                    "parties": 9000,
                    "ouverture": "Queen's Pawn",
                    "children": []
                }
            ]
        }

        output = tmp_path / "test.pgn"
        repertoire.exporter_pgn(racine, chemin=str(output))

        content = output.read_text(encoding="utf-8")
        assert "1. e4" in content
        assert "1. d4" in content

    def test_sets_headers_correctly(self, tmp_path):
        """Headers PGN doivent être corrects."""
        racine = {"fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "children": []}
        output = tmp_path / "test.pgn"

        repertoire.exporter_pgn(racine, chemin=str(output), couleur="blancs")

        content = output.read_text(encoding="utf-8")
        assert "[Event \"Répertoire d'ouverture (blancs)\"]" in content
        assert "[White \"Répertoire Blancs\"]" in content


class TestParseArgs:
    """Tests pour parse_args()."""

    def test_default_values(self):
        """Valeurs par défaut."""
        args = repertoire.parse_args([])
        assert args.fen == "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        assert args.depth == 12
        assert args.max_moves == 2
        assert args.min_games == 1000
        assert args.max_positions == 200
        assert args.delay == 3.0
        assert args.couleur == "tous"
        assert args.output == "repertoire.pgn"
        assert args.json is None

    def test_custom_depth(self):
        """Profondeur personnalisée."""
        args = repertoire.parse_args(["--depth", "20"])
        assert args.depth == 20

    def test_custom_couleur(self):
        """Couleur personnalisée."""
        args = repertoire.parse_args(["--couleur", "blancs"])
        assert args.couleur == "blancs"

    def test_json_output(self):
        """Export JSON."""
        args = repertoire.parse_args(["--json", "repertoire.json"])
        assert args.json == "repertoire.json"
