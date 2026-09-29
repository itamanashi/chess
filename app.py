"""Interface Streamlit legacy — interface web moderne disponible dans `web/`.

Cette interface Streamlit est en mode maintenance (`legacy`). L'interface
utilisateur moderne se trouve dans le répertoire `web/` (React + Vite).

Ne pas utiliser les deux simultanément — elles partagent certaines données
via le cache local mais ont des architectures distinctes.
"""
import json
import os
import sys

import streamlit as st
import streamlit.components.v1 as components

from board_html import render_board_html
from db_cache import DB_DEFAUT, fetch_moves, stats_db

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

FEN_INITIAL = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
JSON_DEFAUT = "repertoire.json"

st.set_page_config(page_title="Explorateur de répertoire", layout="wide")

st.markdown(
    """
    <style>
    .stApp { background: #161512; color: #e8e6e3; }
    h1, h2, h3 { color: #e8e6e3 !important; }
    .stTextInput input, .stSelectbox div { background: #262421 !important; color: #e8e6e3 !important; }
    .stButton button { background: #629924; color: white; border-radius: 8px; border: none; }
    .stButton button:hover { background: #6fae2b; color: white; }
    section[data-testid="stSidebar"] { background: #1e1c1a; }
    </style>
    """,
    unsafe_allow_html=True,
)


@st.cache_data
def charger_json_texte(chemin: str):
    with open(chemin, encoding="utf-8") as f:
        return f.read()


@st.cache_data
def stats_arbre(json_texte: str):
    racine = json.loads(json_texte)
    total, prof_max, lignes = 0, 0, 0

    def visit(noeud, prof):
        nonlocal total, prof_max, lignes
        total += 1
        prof_max = max(prof_max, prof)
        enfants = noeud.get("children", [])
        if not enfants:
            lignes += 1
        for e in enfants:
            visit(e, prof + 1)

    visit(racine, 0)
    return total, prof_max, lignes


@st.cache_data
def _extra_json():
    """Blancs/noirs intégrés au plateau s'ils existent, sinon None."""
    d = {}
    for c in ("blancs", "noirs"):
        p = f"repertoire_{c}.json"
        try:
            with open(p, encoding="utf-8") as f:
                d[c] = json.load(f)
        except (OSError, ValueError):
            d[c] = None
    return json.dumps(d, ensure_ascii=False)


st.sidebar.title("⚙️ Répertoire")
json_path = st.sidebar.text_input("Fichier JSON", value=JSON_DEFAUT)
fichier = st.sidebar.file_uploader("...ou importe un JSON", type=["json"])

json_texte, erreur = None, None
if fichier is not None:
    try:
        json_texte = fichier.read().decode("utf-8")
        json.loads(json_texte)  # validation
        st.sidebar.success("JSON importé depuis l'uploader")
    except Exception as e:
        erreur = f"JSON invalide : {e}"
elif os.path.exists(json_path):
    try:
        json_texte = charger_json_texte(json_path)
    except Exception as e:
        erreur = f"Erreur lecture : {e}"
else:
    erreur = f"Fichier introuvable : {json_path}"

token_ok = bool(os.getenv("LICHESS_TOKEN"))
n_db, _ = stats_db(DB_DEFAUT)
st.sidebar.markdown("---")
st.sidebar.write(f"🔑 Token Lichess : {'✅ détecté' if token_ok else '❌ absent (.env ?)'}")
st.sidebar.write(f"💾 Base locale : {n_db} positions")
st.sidebar.caption("Limite Lichess : 25 requêtes/min. Le live enregistre en base.")

st.title("♞ Explorateur de répertoire d'ouverture")
st.caption("Glisse les pièces sur le plateau (ou clique une suite à droite). La position survit aux rechargements via l'URL.")

if erreur or not json_texte:
    st.warning(erreur or "Charge un `repertoire.json` valide pour commencer.")
    st.code("python repertoire.py --depth 12 --max-moves 2 --output repertoire.pgn --json repertoire.json")
    st.stop()

total, prof_max, lignes = stats_arbre(json_texte)
c1, c2, c3 = st.columns(3)
c1.metric("Positions au répertoire", f"{total:,}".replace(",", " "))
c2.metric("Profondeur max", f"{prof_max} plis")
c3.metric("Lignes", f"{lignes:,}".replace(",", " "))

html = render_board_html(json_texte, FEN_INITIAL, _extra_json())
components.html(html, height=800, scrolling=True)

st.markdown("---")
st.subheader("🔴 Live Lichess — approfondir une position")
st.caption("Bouton « 📋 FEN » sur le plateau pour copier, puis colle ici :")
fen_live = st.text_input("FEN", value="", placeholder="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1")
if st.button("Interroger Lichess Masters"):
    if not fen_live.strip():
        st.warning("Colle d'abord un FEN.")
    else:
        with st.spinner("Requête Lichess Masters..."):
            try:
                live, en_cache = fetch_moves(fen_live.strip())
            except RuntimeError as err:
                st.error(str(err))
                live = None
        if live:
            st.caption("💾 servi depuis la base locale" if en_cache else "🌐 réponse API enregistrée en base")
        if live:
            tot = sum(m["parties"] for m in live[:8]) or 1
            for m in live[:8]:
                with st.expander(
                    f"{m['coup']} — {m['parties']:,} parties ({round(m['parties']/tot*100,1)}%)".replace(",", " "),
                    expanded=False,
                ):
                    st.write(f"**Ouverture :** {m.get('ouverture') or m.get('eco') or '?'}")
                    st.write(
                        f"Blancs {m['victoires_blancs']:,} | Nuls {m['nuls']:,} | Noirs {m['victoires_noirs']:,} — UCI `{m.get('uci')}`".replace(",", " ")
                    )
                    st.progress(min(m["parties"] / tot, 1.0))
