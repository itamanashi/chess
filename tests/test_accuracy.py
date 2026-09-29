"""Tests du cœur de précision en-croissant / Lichess (accuracy.py)."""

import math

import pytest

from accuracy import (
    classifier_annotation,
    construire_rapport,
    est_seul_correct,
    phase_du_pli,
    precision_coup,
    precision_partie,
    precision_partie_cps,
    win_chance,
)


def test_win_chance_centre_et_symetrie():
    assert win_chance(0) == pytest.approx(50.0)
    # Régression logistique Lichess (k = 0.00368208) : +100 cp ≈ 59.1, pas 64
    # (64 % correspond à la logistique 400-Elo brute 1/(1+10^(-cp/400))).
    assert win_chance(100) == pytest.approx(59.1, abs=1.0)
    assert win_chance(100) + win_chance(-100) == pytest.approx(100.0)
    assert win_chance(1000) > 97
    assert win_chance(-1000) < 3


def test_precision_coup_amelioration_vaut_100():
    assert precision_coup(50, 60) == 100.0
    assert precision_coup(50, 50) == 100.0


def test_precision_coup_degrade_progressif():
    petite = precision_coup(50, 45)
    grosse = precision_coup(50, 30)
    assert 0 < grosse < petite < 100
    # Référence formule Lichess : 103.1668 * exp(-0.04354 * 5) - 3.1669 + 1
    attendue = 103.1668 * math.exp(-0.04354 * 5) - 3.1669 + 1
    assert petite == pytest.approx(attendue)
    # Courbe Lichess : diff 50 → ~9.5 ; il faut diff 100 pour tomber à ~0.
    assert precision_coup(100, 0) == pytest.approx(0.0, abs=1.0)


def test_classifier_seuils_en_croissant():
    assert classifier_annotation(25) == "??"
    assert classifier_annotation(20) == "??"
    assert classifier_annotation(15) == "?"
    assert classifier_annotation(10) == "?"
    assert classifier_annotation(7) == "?!"
    assert classifier_annotation(5) == "?!"
    assert classifier_annotation(2) == ""


def test_classifier_sacrifices_et_coups_uniques():
    assert classifier_annotation(1, sacrifice=True, seul_correct=True) == "!!"
    assert classifier_annotation(1, sacrifice=True) == "!?"
    assert classifier_annotation(1, seul_correct=True, erreur_adverse_avant=True) == "!"
    assert classifier_annotation(1, seul_correct=True) == ""


def test_est_seul_correct():
    assert est_seul_correct(70, 55) is True
    assert est_seul_correct(70, 65) is False
    assert est_seul_correct(70, None) is False


def test_phase_du_pli():
    assert phase_du_pli(1) == "opening"
    assert phase_du_pli(20) == "opening"
    assert phase_du_pli(21) == "middlegame"
    assert phase_du_pli(60) == "middlegame"
    assert phase_du_pli(61) == "endgame"


def test_partie_parfaite_vaut_100():
    resultat = precision_partie_cps([15, 15, 15, 15, 15])
    assert resultat["white"] == pytest.approx(100.0)
    assert resultat["black"] == pytest.approx(100.0)


def test_blunder_blancs_ne_touche_pas_noirs():
    # Indices pairs = trait blanc : c'est le 3e cp (15 → -600) qui blunder,
    # joué par les Blancs. Les Noirs restent parfaits.
    resultat = precision_partie_cps([15, 15, 15, -600, -600, -600, -600])
    assert resultat["black"] == pytest.approx(100.0)
    assert resultat["white"] is not None and resultat["white"] < 70


def test_precision_partie_couleur_absente():
    echantillons = [{"avant_pov": 50.0, "apres_pov": 50.0, "couleur": "white"}]
    resultat = precision_partie(echantillons)
    assert resultat["white"] == pytest.approx(100.0)
    assert resultat["black"] is None


def test_construire_rapport_agrege():
    plis = [
        {"pli": 1, "san": "e4", "couleur": "white",
         "win_blancs_apres": 55.0, "perte_win": 0.0, "perte_cp": 0, "annotation": ""},
        {"pli": 2, "san": "e5", "couleur": "black",
         "win_blancs_apres": 55.0, "perte_win": 0.0, "perte_cp": 0, "annotation": ""},
        {"pli": 3, "san": "Qh5", "couleur": "white",
         "win_blancs_apres": 30.0, "perte_win": 25.0, "perte_cp": 250, "annotation": "??"},
    ]
    rapport = construire_rapport(plis)
    assert rapport["precisions"]["white"] < rapport["precisions"]["black"]
    assert rapport["annotations"]["??"] == 1
    assert rapport["acpl"]["white"] == pytest.approx(125.0)
    assert rapport["acpl"]["black"] == pytest.approx(0.0)
    assert set(rapport["phases"]) == {"opening", "middlegame", "endgame"}
