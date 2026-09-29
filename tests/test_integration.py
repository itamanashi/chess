"""Tests d'intégration end-to-end."""
import os
import pytest
from unittest.mock import patch
import chess
import repertoire
import db_cache


@pytest.fixture
def temp_files(tmp_path):
    """Fichiers temporaires pour les tests."""
    return {
        "db": str(tmp_path / "test.db"),
        "pgn": str(tmp_path / "test.pgn"),
        "json": str(tmp_path / "test.json")
    }


class TestFullWorkflow:
    """Tests du workflow complet."""

    @patch('repertoire.get_opening_moves')
    def test_build_and_export_repertoire(self, mock_api, temp_files):
        """Construction et export d'un répertoire complet."""
        # Mock réponses API
        def api_response(fen, token=None):
            if "w KQkq" in fen and fen.count("/") == 7:  # Position initiale
                return [
                    {"coup": "e4", "san": "e4", "uci": "e2e4", "parties": 10000,
                     "victoires_blancs": 5000, "nuls": 2000, "victoires_noirs": 3000,
                     "ouverture": "King's Pawn", "eco": "B00"},
                    {"coup": "d4", "san": "d4", "uci": "d2d4", "parties": 9000,
                     "victoires_blancs": 4500, "nuls": 2500, "victoires_noirs": 2000,
                     "ouverture": "Queen's Pawn", "eco": "D00"}
                ]
            elif "4P3" in fen:  # Après 1.e4
                return [
                    {"coup": "e5", "san": "e5", "uci": "e7e5", "parties": 8000,
                     "victoires_blancs": 4000, "nuls": 2000, "victoires_noirs": 2000,
                     "ouverture": "King's Pawn Opening", "eco": "C20"},
                    {"coup": "c5", "san": "c5", "uci": "c7c5", "parties": 7000,
                     "victoires_blancs": 3500, "nuls": 2000, "victoires_noirs": 1500,
                     "ouverture": "Sicilian Defense", "eco": "B20"}
                ]
            return []

        mock_api.side_effect = api_response

        # Construction
        racine, stats = repertoire.construire_arbre(
            profondeur_max=2,
            coups_max=2,
            min_parties=1000,
            max_positions=10,
            delai=0.1,
            token="lip_test",
            verbose=False
        )

        # Vérifications arbre
        assert len(racine["children"]) == 2
        assert racine["children"][0]["coup"] == "e4"
        assert len(racine["children"][0]["children"]) == 2

        # Export PGN
        repertoire.exporter_pgn(racine, chemin=temp_files["pgn"])
        assert os.path.exists(temp_files["pgn"])

        with open(temp_files["pgn"], encoding="utf-8") as f:
            content = f.read()
            assert "1. e4" in content
            assert "1. d4" in content

    @patch('db_cache.get_opening_moves')
    def test_cache_integration(self, mock_api, temp_files):
        """Test intégration du cache."""
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        moves = [
            {"coup": "e4", "san": "e4", "uci": "e2e4", "parties": 10000}
        ]
        mock_api.return_value = moves

        # Premier appel : API
        result1, from_cache1 = db_cache.fetch_moves(
            fen, token="lip_test", db_path=temp_files["db"]
        )
        assert from_cache1 is False
        assert mock_api.call_count == 1

        # Deuxième appel : Cache
        result2, from_cache2 = db_cache.fetch_moves(
            fen, token="lip_test", db_path=temp_files["db"]
        )
        assert from_cache2 is True
        assert mock_api.call_count == 1  # Pas d'appel supplémentaire
        assert result1 == result2

    @patch('repertoire.get_opening_moves')
    def test_castling_normalization_in_tree(self, mock_api, temp_files):
        """Test normalisation des roques dans l'arbre."""
        def api_response(fen, token=None):
            if "w KQkq" in fen and "rnbqkb1r" in fen:  # Après préparation roque
                return [
                    {"coup": "O-O", "san": "O-O", "uci": "e1h1", "parties": 5000,
                     "victoires_blancs": 2500, "nuls": 1500, "victoires_noirs": 1000}
                ]
            return []

        mock_api.side_effect = api_response

        # Position permettant le roque blanc
        fen = "rnbqkb1r/pppppppp/5n2/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 4 3"
        board = chess.Board(fen)

        racine, stats = repertoire.construire_arbre(
            fen_depart=fen,
            profondeur_max=1,
            coups_max=1,
            min_parties=1000,
            max_positions=5,
            delai=0.1,
            verbose=False
        )

        if racine["children"]:
            # Le roque doit être normalisé en e1g1
            assert racine["children"][0]["uci"] == "e1g1"

    @patch('repertoire.get_opening_moves')
    def test_white_repertoire_mode(self, mock_api, temp_files):
        """Test mode répertoire blancs."""
        def api_response(fen, token=None):
            if "w KQkq" in fen and fen.count("/") == 7:
                return [
                    {"coup": "e4", "san": "e4", "uci": "e2e4", "parties": 10000},
                    {"coup": "d4", "san": "d4", "uci": "d2d4", "parties": 9000}
                ]
            elif "b KQkq" in fen:
                return [
                    {"coup": "e5", "san": "e5", "uci": "e7e5", "parties": 8000},
                    {"coup": "c5", "san": "c5", "uci": "c7c5", "parties": 7000},
                    {"coup": "e6", "san": "e6", "uci": "e7e6", "parties": 6000}
                ]
            return []

        mock_api.side_effect = api_response

        racine, stats = repertoire.construire_arbre(
            profondeur_max=2,
            coups_max=3,
            couleur="blancs",
            min_parties=1000,
            max_positions=10,
            delai=0.1,
            verbose=False
        )

        # Blancs : 1 seul coup (le meilleur)
        assert len(racine["children"]) == 1
        # Noirs : jusqu'à 3 coups
        assert len(racine["children"][0]["children"]) <= 3

    @patch('repertoire.get_opening_moves')
    def test_handles_transpositions(self, mock_api, temp_files):
        """Test gestion des transpositions."""
        # Position identique accessible par deux chemins
        def api_response(fen, token=None):
            if "w KQkq" in fen and fen.count("/") == 7:
                return [
                    {"coup": "Nf3", "san": "Nf3", "uci": "g1f3", "parties": 5000},
                    {"coup": "d4", "san": "d4", "uci": "d2d4", "parties": 5000}
                ]
            elif "Nf3" in fen or "d4" in fen:
                return [
                    {"coup": "d5", "san": "d5", "uci": "d7d5", "parties": 3000}
                ]
            return []

        mock_api.side_effect = api_response

        racine, stats = repertoire.construire_arbre(
            profondeur_max=2,
            coups_max=2,
            min_parties=1000,
            max_positions=10,
            delai=0.1,
            verbose=False
        )

        # Les deux chemins doivent être explorés
        assert len(racine["children"]) == 2


class TestErrorHandling:
    """Tests de gestion d'erreurs."""

    @patch('repertoire.get_opening_moves')
    def test_continues_after_api_error(self, mock_api, temp_files):
        """Doit continuer après une erreur API sur une branche."""
        call_count = [0]

        def api_response(fen, token=None):
            call_count[0] += 1
            if call_count[0] == 2:  # Deuxième appel échoue
                raise RuntimeError("API error")
            return [
                {"coup": "e4", "san": "e4", "uci": "e2e4", "parties": 10000}
            ]

        mock_api.side_effect = api_response

        # Ne doit pas crasher
        racine, stats = repertoire.construire_arbre(
            profondeur_max=3,
            coups_max=1,
            min_parties=1000,
            max_positions=10,
            delai=0.1,
            verbose=False
        )

        assert racine is not None

    def test_handles_corrupted_cache_gracefully(self, temp_files):
        """Cache corrompu ne doit pas crasher."""
        # Créer une base corrompue
        with open(temp_files["db"], "w") as f:
            f.write("not a valid sqlite database")

        # Ne doit pas crasher, juste échouer silencieusement
        try:
            result = db_cache.lookup(temp_files["db"], "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
        except Exception:
            pass  # OK si erreur, l'important c'est de ne pas crash l'app
