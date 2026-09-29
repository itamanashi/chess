"""Analyse de précision — spec en-croissant / Lichess (miroir Python du cœur TS).

Références :
  - docs en-croissant « Analyze Game » : Win% Lichess, Win% loss comme
    métrique primaire, annotations !!/!/!?/?!/?/?? ;
  - lila ``AccuracyPercent.scala`` : précision par coup + précision de partie
    (moyenne pondérée par volatilité + moyenne harmonique) / 2.

Conventions : Win% toujours perspective Blancs (0..100) ; la précision d'un
coup est perspective JOUEUR (on replie : pov = blanc ? w : 100 - w).
Les evals moteur brutes sont relatives au TRAIT (UCI).
"""

import argparse
import math
import sys

WIN_CHANCE_K = 0.00368208
MOVE_ACC_A = 103.1668
MOVE_ACC_K = 0.04354
MOVE_ACC_B = -3.1669
MOVE_ACC_BONUS = 1.0

SEUIL_DOUTEUX = 5.0
SEUIL_ERREUR = 10.0
SEUIL_BLUNDER = 20.0
ECART_ONLY_SOUND = 10.0

CP_INITIAL = 15
CP_MAT = 1000


def win_chance(cp_blancs: float) -> float:
    """Centipawns (perspective Blancs) → Win% Blancs (0..100)."""
    return 50 + 50 * (2 / (1 + math.exp(-WIN_CHANCE_K * cp_blancs)) - 1)


def score_vers_cp_blancs(cp=None, mat=None, trait: str = "w") -> float:
    """Score moteur (relatif au trait) → cp perspective Blancs."""
    if mat is not None:
        signe = 1 if trait == "w" else -1
        return signe * (CP_MAT if mat > 0 else -CP_MAT)
    valeur = cp if isinstance(cp, (int, float)) and math.isfinite(cp) else 0
    return (1 if trait == "w" else -1) * valeur


def win_blancs_vers_pov(win_blancs: float, couleur: str) -> float:
    """Win% Blancs → Win% point de vue joueur ('white' | 'black')."""
    return win_blancs if couleur == "white" else 100 - win_blancs


def precision_coup(avant_pov: float, apres_pov: float) -> float:
    """Précision d'un coup (formule Lichess exacte). Amélioration → 100."""
    if apres_pov >= avant_pov:
        return 100.0
    diff = avant_pov - apres_pov
    brut = MOVE_ACC_A * math.exp(-MOVE_ACC_K * diff) + MOVE_ACC_B + MOVE_ACC_BONUS
    return max(0.0, min(100.0, brut))


def precision_coup_cp(cp_avant_blancs: float, cp_apres_blancs: float, couleur: str) -> float:
    """Précision depuis des cps perspective Blancs + couleur du joueur."""
    avant = win_blancs_vers_pov(win_chance(cp_avant_blancs), couleur)
    apres = win_blancs_vers_pov(win_chance(cp_apres_blancs), couleur)
    return precision_coup(avant, apres)


def _moyenne(xs) -> float:
    return sum(xs) / len(xs)


def ecart_type(xs) -> float:
    if not xs:
        return 0.0
    m = _moyenne(xs)
    return math.sqrt(_moyenne([(x - m) ** 2 for x in xs]))


def _borner(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _moyenne_ponderee(paires) -> float | None:
    s = sw = 0.0
    for v, w in paires:
        s += v * w
        sw += w
    return s / sw if sw > 0 else None


def _moyenne_harmonique(xs) -> float | None:
    if not xs:
        return None
    s = 0.0
    for x in xs:
        if x <= 0:
            return 0.0
        s += 1 / x
    return len(xs) / s


def precision_partie(echantillons) -> dict:
    """Précision de partie par couleur (fidèle à lila).

    ``echantillons`` : liste de dicts {avant_pov, apres_pov, couleur}.
    Poids = écart-type glissant des Win% (fenêtre n/10 bornée 2..8),
    poids borné 0.5..12, puis (moyenne pondérée + harmonique) / 2.
    """
    resultat = {"white": None, "black": None}
    for couleur in ("white", "black"):
        propres = [e for e in echantillons if e["couleur"] == couleur]
        if not propres:
            continue
        victoires = [propres[0]["avant_pov"]] + [e["apres_pov"] for e in propres]
        fenetre = _borner(len(echantillons) // 10, 2, 8)
        poids = []
        for i in range(len(propres)):
            glissante = victoires[i:i + fenetre]
            while len(glissante) < fenetre:
                glissante.append(glissante[-1] if glissante else 50)
            poids.append(_borner(ecart_type(glissante), 0.5, 12))
        precisions = [precision_coup(e["avant_pov"], e["apres_pov"]) for e in propres]
        pond = _moyenne_ponderee(list(zip(precisions, poids)))
        harm = _moyenne_harmonique(precisions)
        if pond is None or harm is None:
            continue
        resultat[couleur] = _borner((pond + harm) / 2, 0, 100)
    return resultat


def precision_partie_cps(cps_blancs, trait_initial: str = "white") -> dict:
    """Variante pratique : cps perspective Blancs (position initiale INCLUSE)."""
    echantillons = []
    for i in range(len(cps_blancs) - 1):
        if i % 2 == 0:
            joueur = trait_initial
        else:
            joueur = "black" if trait_initial == "white" else "white"
        echantillons.append({
            "avant_pov": win_blancs_vers_pov(win_chance(cps_blancs[i]), joueur),
            "apres_pov": win_blancs_vers_pov(win_chance(cps_blancs[i + 1]), joueur),
            "couleur": joueur,
        })
    return precision_partie(echantillons)


def classifier_annotation(perte_win, sacrifice=False, seul_correct=False,
                          erreur_adverse_avant=False) -> str:
    """Table en-croissant : ??/??/…/!! (perte = best − joué, pov joueur)."""
    if perte_win >= SEUIL_BLUNDER:
        return "??"
    if perte_win >= SEUIL_ERREUR:
        return "?"
    if perte_win >= SEUIL_DOUTEUX:
        return "?!"
    if sacrifice and seul_correct:
        return "!!"
    if sacrifice:
        return "!?"
    if seul_correct and erreur_adverse_avant:
        return "!"
    return ""


def est_seul_correct(win_best_pov, win_second_pov=None, seuil=ECART_ONLY_SOUND) -> bool:
    """Best vs 2e best : écart Win% pov ≥ seuil → « only sound move »."""
    if win_second_pov is None or not math.isfinite(win_second_pov):
        return False
    return win_best_pov - win_second_pov >= seuil


def phase_du_pli(pli: int) -> str:
    """Phase simplifiée : ouverture ≤ 20, milieu ≤ 60, sinon finale."""
    if pli <= 20:
        return "opening"
    if pli <= 60:
        return "middlegame"
    return "endgame"


def construire_rapport(plis) -> dict:
    """Rapport (précisions, ACPL, annotations, phases) depuis les plis.

    Chaque pli : dict {pli, san, couleur, win_blancs_apres, perte_win,
    perte_cp, annotation}. Les précisions par coup sont recalculées ici
    (formule Lichess) pour garantir la cohérence.
    """
    echantillons = []
    for i, pli in enumerate(plis):
        win_avant = win_chance(CP_INITIAL) if i == 0 else plis[i - 1]["win_blancs_apres"]
        echantillons.append({
            "avant_pov": win_blancs_vers_pov(win_avant, pli["couleur"]),
            "apres_pov": win_blancs_vers_pov(pli["win_blancs_apres"], pli["couleur"]),
            "couleur": pli["couleur"],
        })
        pli["precision"] = precision_coup(echantillons[-1]["avant_pov"], echantillons[-1]["apres_pov"])

    precisions = precision_partie(echantillons)

    acpl = {}
    for couleur in ("white", "black"):
        pertes = [p["perte_cp"] for p in plis if p["couleur"] == couleur]
        acpl[couleur] = (sum(pertes) / len(pertes)) if pertes else None

    annotations = {"!!": 0, "!": 0, "!?": 0, "?!": 0, "?": 0, "??": 0}
    for pli in plis:
        if pli.get("annotation"):
            annotations[pli["annotation"]] += 1

    phases = {}
    for phase in ("opening", "middlegame", "endgame"):
        sous = [e for e, p in zip(echantillons, plis) if phase_du_pli(p["pli"]) == phase]
        phases[phase] = precision_partie(sous)

    return {"plis": plis, "precisions": precisions, "acpl": acpl,
            "annotations": annotations, "phases": phases}


def _parse_cps(spec: str) -> list:
    """'15,20,-30,M5,-M3' → cps blancs (M = mat → ±CP_MAT)."""
    cps = []
    for tok in spec.split(","):
        tok = tok.strip()
        if not tok:
            continue
        if tok.upper().startswith("M"):
            corps = tok[1:]
            signe = -1 if corps.startswith("-") else 1
            corps = corps.lstrip("+-")
            try:
                dist = int(corps)
            except ValueError:
                raise SystemExit(f"mat invalide : {tok!r} (ex. M5, -M3)")
            cps.append(signe * CP_MAT if dist != 0 else 0)
        else:
            try:
                cps.append(float(tok))
            except ValueError:
                raise SystemExit(f"cp invalide : {tok!r}")
    return cps


def main(argv=None) -> int:
    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    ap = argparse.ArgumentParser(
        description="Précision en-croissant/Lichess depuis des cps blancs "
                    "(position initiale INCLUSE, ex. --cps 15,20,10,-40).")
    ap.add_argument("--cps", required=True,
                    help="cps blancs séparés par des virgules (M5 = mat en 5).")
    ap.add_argument("--trait", default="white", choices=["white", "black"],
                    help="couleur du trait initial (défaut : white).")
    args = ap.parse_args(argv)
    cps = _parse_cps(args.cps)
    if len(cps) < 2:
        raise SystemExit("il faut au moins 2 positions (avant + après).")
    resultat = precision_partie_cps(cps, args.trait)
    for couleur in ("white", "black"):
        valeur = resultat[couleur]
        print(f"{couleur}: {'—' if valeur is None else f'{valeur:.1f} %'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
