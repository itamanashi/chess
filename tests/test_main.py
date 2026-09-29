"""Tests pour main.py - API Lichess Masters."""
import os
import pytest
from unittest.mock import patch, Mock
import main


class TestGetOpeningMoves:
    """Tests pour get_opening_moves()."""

    def test_missing_token_raises_error(self):
        """Sans token, doit lever RuntimeError."""
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(RuntimeError, match="Token Lichess manquant"):
                main.get_opening_moves()

    @patch('main.requests.get')
    def test_successful_request(self, mock_get):
        """Requête réussie doit renvoyer la liste de coups."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "moves": [
                {
                    "san": "e4",
                    "uci": "e2e4",
                    "white": 5000,
                    "draws": 2000,
                    "black": 3000,
                    "averageRating": 2500,
                    "opening": {"name": "King's Pawn", "eco": "B00"}
                },
                {
                    "san": "d4",
                    "uci": "d2d4",
                    "white": 4500,
                    "draws": 2500,
                    "black": 3000,
                    "averageRating": 2480,
                    "opening": {"name": "Queen's Pawn", "eco": "D00"}
                }
            ]
        }
        mock_get.return_value = mock_response

        result = main.get_opening_moves(token="lip_test123")

        assert len(result) == 2
        assert result[0]["coup"] == "e4"
        assert result[0]["parties"] == 10000
        assert result[0]["victoires_blancs"] == 5000
        assert result[0]["nuls"] == 2000
        assert result[0]["victoires_noirs"] == 3000
        assert result[0]["ouverture"] == "King's Pawn"
        assert result[0]["eco"] == "B00"

    @patch('main.requests.get')
    def test_401_unauthorized(self, mock_get):
        """401 doit lever RuntimeError avec message explicite."""
        mock_response = Mock()
        mock_response.status_code = 401
        mock_get.return_value = mock_response

        with pytest.raises(RuntimeError, match="401 Unauthorized"):
            main.get_opening_moves(token="lip_invalid")

    @patch('main.requests.get')
    def test_429_rate_limit(self, mock_get):
        """429 doit lever RuntimeError avec message rate limit."""
        mock_response = Mock()
        mock_response.status_code = 429
        mock_get.return_value = mock_response

        with pytest.raises(RuntimeError, match="429 Too Many Requests"):
            main.get_opening_moves(token="lip_test123")

    @patch('main.requests.get')
    def test_network_error(self, mock_get):
        """Erreur réseau doit lever RuntimeError."""
        import requests
        mock_get.side_effect = requests.exceptions.RequestException("Network error")

        with pytest.raises(RuntimeError, match="Erreur réseau"):
            main.get_opening_moves(token="lip_test123")

    @patch('main.requests.get')
    def test_invalid_json_response(self, mock_get):
        """Réponse JSON invalide doit lever RuntimeError."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.side_effect = ValueError("Invalid JSON")
        mock_response.text = "Not JSON"
        mock_get.return_value = mock_response

        with pytest.raises(RuntimeError, match="Réponse JSON invalide"):
            main.get_opening_moves(token="lip_test123")

    @patch('main.requests.get')
    def test_custom_fen(self, mock_get):
        """Doit accepter un FEN personnalisé."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"moves": []}
        mock_get.return_value = mock_response

        custom_fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
        main.get_opening_moves(fen=custom_fen, token="lip_test123")

        call_args = mock_get.call_args
        assert call_args[1]["params"]["fen"] == custom_fen

    @patch('main.requests.get')
    def test_headers_present(self, mock_get):
        """Doit inclure User-Agent et Authorization."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"moves": []}
        mock_get.return_value = mock_response

        main.get_opening_moves(token="lip_test123")

        call_args = mock_get.call_args
        headers = call_args[1]["headers"]
        assert "User-Agent" in headers
        assert headers["Authorization"] == "Bearer lip_test123"


class TestParseArgs:
    """Tests pour parse_args()."""

    def test_default_values(self):
        """Valeurs par défaut."""
        args = main.parse_args([])
        assert args.fen == "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        assert args.limit == 5
        assert args.token is None

    def test_custom_fen(self):
        """FEN personnalisé."""
        custom_fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
        args = main.parse_args(["--fen", custom_fen])
        assert args.fen == custom_fen

    def test_custom_limit(self):
        """Limite personnalisée."""
        args = main.parse_args(["--limit", "10"])
        assert args.limit == 10

    def test_custom_token(self):
        """Token personnalisé."""
        args = main.parse_args(["--token", "lip_custom"])
        assert args.token == "lip_custom"


class TestDotenvLoader:
    """Tests pour _load_dotenv()."""

    def test_loads_valid_env_file(self, tmp_path):
        """Doit charger un fichier .env valide."""
        env_file = tmp_path / ".env"
        env_file.write_text("TEST_KEY=test_value\nANOTHER_KEY='quoted'")

        with patch.dict(os.environ, {}, clear=True):
            main._load_dotenv(str(env_file))
            assert os.environ.get("TEST_KEY") == "test_value"
            assert os.environ.get("ANOTHER_KEY") == "quoted"

    def test_skips_comments_and_empty_lines(self, tmp_path):
        """Doit ignorer commentaires et lignes vides."""
        env_file = tmp_path / ".env"
        env_file.write_text("# Comment\n\nVALID=yes\n# Another comment")

        with patch.dict(os.environ, {}, clear=True):
            main._load_dotenv(str(env_file))
            assert os.environ.get("VALID") == "yes"

    def test_does_not_override_existing_vars(self, tmp_path):
        """Ne doit pas écraser les variables existantes."""
        env_file = tmp_path / ".env"
        env_file.write_text("EXISTING=from_file")

        with patch.dict(os.environ, {"EXISTING": "from_env"}, clear=True):
            main._load_dotenv(str(env_file))
            assert os.environ.get("EXISTING") == "from_env"

    def test_handles_missing_file(self):
        """Fichier absent ne doit pas lever d'erreur."""
        main._load_dotenv("/nonexistent/.env")
