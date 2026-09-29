"""Tests pour db_cache.py - Cache SQLite."""
import os
import sqlite3
import pytest
from unittest.mock import patch, Mock
import db_cache


@pytest.fixture
def temp_db(tmp_path):
    """Base de données temporaire pour les tests."""
    db_path = tmp_path / "test_cache.db"
    yield str(db_path)
    if db_path.exists():
        db_path.unlink()


class TestPosKey:
    """Tests pour pos_key()."""

    def test_initial_position(self):
        """Position initiale doit avoir une clé canonique."""
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        key = db_cache.pos_key(fen)
        assert key == "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"

    def test_normalizes_phantom_ep(self):
        """Doit normaliser les cases EP fantômes."""
        fen1 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
        fen2 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
        # python-chess normalise automatiquement EP fantôme -> '-'
        key1 = db_cache.pos_key(fen1)
        key2 = db_cache.pos_key(fen2)
        assert key1 == key2

    def test_different_positions_different_keys(self):
        """Positions différentes doivent avoir des clés différentes."""
        fen1 = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        fen2 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
        assert db_cache.pos_key(fen1) != db_cache.pos_key(fen2)

    def test_ignores_halfmove_and_fullmove(self):
        """Doit ignorer les compteurs de coups."""
        fen1 = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        fen2 = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 5 10"
        assert db_cache.pos_key(fen1) == db_cache.pos_key(fen2)

    def test_handles_invalid_fen_gracefully(self):
        """FEN invalide doit quand même générer une clé."""
        invalid_fen = "invalid fen string here"
        key = db_cache.pos_key(invalid_fen)
        assert isinstance(key, str)


class TestDatabaseOperations:
    """Tests pour opérations de base de données."""

    def test_connect_creates_schema(self, temp_db):
        """_connect doit créer le schéma."""
        conn = db_cache._connect(temp_db)
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='api_cache'")
        assert cursor.fetchone() is not None
        conn.close()

    def test_store_and_lookup(self, temp_db):
        """store() puis lookup() doivent fonctionner."""
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        moves = [
            {"coup": "e4", "parties": 10000, "victoires_blancs": 5000},
            {"coup": "d4", "parties": 8000, "victoires_blancs": 4000}
        ]

        db_cache.store(temp_db, fen, moves)
        cached = db_cache.lookup(temp_db, fen)

        assert cached is not None
        assert len(cached) == 2
        assert cached[0]["coup"] == "e4"
        assert cached[1]["coup"] == "d4"

    def test_lookup_missing_position(self, temp_db):
        """lookup() sur position absente doit renvoyer None."""
        fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
        cached = db_cache.lookup(temp_db, fen)
        assert cached is None

    def test_store_replaces_existing(self, temp_db):
        """store() doit remplacer une entrée existante."""
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        moves1 = [{"coup": "e4", "parties": 10000}]
        moves2 = [{"coup": "e4", "parties": 12000}]

        db_cache.store(temp_db, fen, moves1)
        db_cache.store(temp_db, fen, moves2)
        cached = db_cache.lookup(temp_db, fen)

        assert cached[0]["parties"] == 12000

    def test_normalized_positions_share_cache(self, temp_db):
        """Positions normalisées doivent partager le cache."""
        fen1 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
        fen2 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
        moves = [{"coup": "e5", "parties": 5000}]

        db_cache.store(temp_db, fen1, moves)
        cached = db_cache.lookup(temp_db, fen2)

        assert cached is not None
        assert cached[0]["coup"] == "e5"


class TestFetchMoves:
    """Tests pour fetch_moves()."""

    def test_returns_from_cache_when_present(self, temp_db):
        """Doit renvoyer depuis le cache si présent."""
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        moves = [{"coup": "e4", "parties": 10000}]
        db_cache.store(temp_db, fen, moves)

        result, from_cache = db_cache.fetch_moves(fen, db_path=temp_db)

        assert from_cache is True
        assert result[0]["coup"] == "e4"

    @patch('db_cache.get_opening_moves')
    def test_fetches_from_api_when_missing(self, mock_api, temp_db):
        """Doit interroger l'API si absent du cache."""
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        api_moves = [{"coup": "e4", "parties": 10000}]
        mock_api.return_value = api_moves

        result, from_cache = db_cache.fetch_moves(fen, token="lip_test", db_path=temp_db)

        assert from_cache is False
        assert result[0]["coup"] == "e4"
        mock_api.assert_called_once_with(fen=fen, token="lip_test")

    @patch('db_cache.get_opening_moves')
    def test_stores_api_result_in_cache(self, mock_api, temp_db):
        """Doit enregistrer le résultat API dans le cache."""
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        api_moves = [{"coup": "e4", "parties": 10000}]
        mock_api.return_value = api_moves

        db_cache.fetch_moves(fen, token="lip_test", db_path=temp_db)
        cached = db_cache.lookup(temp_db, fen)

        assert cached is not None
        assert cached[0]["coup"] == "e4"

    @patch('db_cache.get_opening_moves')
    def test_propagates_api_error(self, mock_api, temp_db):
        """Doit propager les erreurs API."""
        mock_api.side_effect = RuntimeError("API error")
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

        with pytest.raises(RuntimeError, match="API error"):
            db_cache.fetch_moves(fen, token="lip_test", db_path=temp_db)


class TestStatsDb:
    """Tests pour stats_db()."""

    def test_empty_database(self, temp_db):
        """Base vide doit renvoyer 0 positions."""
        db_cache._connect(temp_db).close()
        n, last = db_cache.stats_db(temp_db)
        assert n == 0
        assert last is None

    def test_counts_positions(self, temp_db):
        """Doit compter le nombre de positions."""
        fen1 = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        fen2 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
        moves = [{"coup": "e4"}]

        db_cache.store(temp_db, fen1, moves)
        db_cache.store(temp_db, fen2, moves)

        n, last = db_cache.stats_db(temp_db)
        assert n == 2

    def test_returns_latest_update(self, temp_db):
        """Doit renvoyer la dernière mise à jour."""
        fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        moves = [{"coup": "e4"}]
        db_cache.store(temp_db, fen, moves)

        n, last = db_cache.stats_db(temp_db)
        assert last is not None
        assert "T" in last  # ISO format

    def test_nonexistent_database(self):
        """Base inexistante doit renvoyer (0, None)."""
        n, last = db_cache.stats_db("/nonexistent/path.db")
        assert n == 0
        assert last is None
