"""Template du plateau interactif (drag & drop) partagé par app.py et viewer.html.

Utilise chessboard.js + chess.js via CDN (connexion internet requise).
La promotion est automatique en dame (note affichée dans l'interface).
"""

TEMPLATE = r"""<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/chessboard-js/1.0.0/chessboard-1.0.0.min.css">
<style>
  * { box-sizing: border-box; }
  body { background: #161512; color: #e8e6e3; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; }
  header { padding: 12px 18px; background: #262421; border-bottom: 1px solid #3a3733; display: flex; align-items: center; gap: 10px; }
  header h1 { font-size: 18px; margin: 0; }
  header .sub { color: #a09a93; font-size: 13px; }
  main { display: flex; gap: 18px; padding: 18px; flex-wrap: wrap; align-items: flex-start; }
  .board-col { flex: 0 1 520px; min-width: 300px; }
  #board { width: 100%; max-width: 520px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .btn { background: #629924; color: #fff; border: none; border-radius: 8px; padding: 8px 12px; cursor: pointer; font-size: 14px; }
  .btn:hover { background: #6fae2b; }
  .btn.sec { background: #3a3733; }
  .btn.sec:hover { background: #4a4642; }
  .panel { flex: 1 1 320px; min-width: 290px; }
  .card { background: #262421; border: 1px solid #3a3733; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
  .card h2 { font-size: 15px; margin: 0 0 8px 0; color: #bab5ae; text-transform: uppercase; letter-spacing: .5px; }
  #status { font-size: 15px; }
  #fenbox { font-family: monospace; font-size: 12px; color: #a09a93; word-break: break-all; margin-top: 8px; }
  .hist { font-size: 15px; line-height: 2.1; }
  .hist .mv { padding: 1px 5px; border-radius: 4px; }
  .hist .cur { background: #629924; color: #fff; }
  .kid { width: 100%; text-align: left; background: #2e2b28; border: 1px solid #3a3733; border-radius: 10px; padding: 10px; margin: 8px 0; cursor: pointer; color: #e8e6e3; font-size: 14px; }
  .kid:hover { border-color: #629924; }
  .kid .san { font-size: 17px; font-weight: 700; }
  .kid .meta { color: #bab5ae; font-size: 13px; margin-top: 2px; }
  .bar { height: 8px; border-radius: 4px; overflow: hidden; display: flex; margin-top: 6px; background: #444; border: 1px solid #555; }
  .bar .w { background: #f5f5f5; } .bar .d { background: #7a7a7a; } .bar .b { background: #111; }
  .badge-ok { color: #9be15d; } .badge-ko { color: #e0a458; }
  .note { color: #a09a93; font-size: 12px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .txt { background: #1b1a18; color: #e8e6e3; border: 1px solid #3a3733; border-radius: 8px; padding: 8px 10px; font-size: 13px; }
</style>
</head>
<body>
<header>
  <h1>&#9822; Mon r&eacute;pertoire</h1>
  <span class="sub">glisse les pi&egrave;ces ou clique une suite &mdash; promotion auto-dame</span>
</header>
<main>
  <section class="board-col">
    <div id="board"></div>
    <div class="toolbar">
      <button class="btn sec" onclick="goStart()">&#9198; D&eacute;but</button>
      <button class="btn sec" onclick="goBack()">&#9664; Retour</button>
      <button class="btn sec" onclick="goFwd()">Avant &#9654;</button>
      <button class="btn sec" onclick="lignePrincipale()">&#11088; Principale</button>
      <button class="btn sec" onclick="board.flip()">&#8646; Flip</button>
      <button class="btn sec" onclick="copyFen()">&#128203; FEN</button>
      <button class="btn sec" onclick="copyPgn()">&#128203; PGN</button>
    </div>
    <div class="card" style="margin-top:10px"><div id="status"></div><div id="fenbox"></div></div>
  </section>
  <section class="panel">
    <div class="card"><h2>R&eacute;pertoire</h2>
      <div class="row">
        <button class="btn sec" onclick="loadBuiltin()">Tous</button>
        <button class="btn sec" onclick="switchRep('blancs')">Blancs</button>
        <button class="btn sec" onclick="switchRep('noirs')">Noirs</button>
        <button class="btn sec" onclick="document.getElementById('filepick').click()">Fichier&hellip;</button>
        <input type="file" id="filepick" accept=".json,application/json" style="display:none">
      </div>
      <div class="note" id="srclabel" style="margin-top:6px"></div>
    </div>
    <div class="card"><h2>Live Lichess</h2>
      <div class="row">
        <input class="txt" id="token" type="password" placeholder="Token lip_... (reste dans ce navigateur)" style="flex:1;min-width:180px">
        <button class="btn" onclick="liveQuery()">Interroger</button>
      </div>
      <div id="live" style="margin-top:8px"></div>
      <div class="note">Token stock&eacute; uniquement en local. Max 25 req/min.</div>
    </div>
    <div class="card"><h2>Coups jou&eacute;s</h2><div id="history" class="hist"></div></div>
    <div class="card"><h2>Suite du r&eacute;pertoire</h2><div id="kids"></div></div>
    <div class="card"><h2>Position</h2><div id="details"></div></div>
  </section>
</main>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/chessboard-js/1.0.0/chessboard-1.0.0.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js"></script>
<script>
var START_FEN = "__START_FEN__";
var REP = __REP_JSON__;

var repMap = {};
function normFen(f) {
  // Clé canonique : pièces + trait + roques + prise en passant RÉELLE.
  // python-chess (qui a généré repertoire.json) omet la case EP quand aucune
  // capture en passant n'est légalement possible, tandis que chess.js
  // l'indique toujours (ex. "e3" après 1.e4). On normalise pour matcher.
  var p = f.split(" ");
  if (p.length < 4) return f;
  if (p[3] !== "-") {
    var file = p[3].charCodeAt(0) - 97, rank = parseInt(p[3][1], 10);
    var blancs = (p[1] === "w");
    var rangPreneur = blancs ? rank - 1 : rank + 1; // rangée des pions pouvant capturer
    var rangee = 8 - rangPreneur;
    var pion = blancs ? "P" : "p";
    var lignes = p[0].split("/");
    var ok = false;
    if (rangee >= 0 && rangee < 8) {
      var ligne = lignes[rangee] || "", col = 0;
      var cases = [];
      for (var i = 0; i < ligne.length; i++) {
        var ch = ligne[i];
        if (/\d/.test(ch)) { for (var k = 0; k < parseInt(ch, 10); k++) cases.push(""); }
        else cases.push(ch);
      }
      [file - 1, file + 1].forEach(function (c) {
        if (c >= 0 && c < 8 && cases[c] === pion) ok = true;
      });
    }
    if (!ok) p[3] = "-";
  }
  return p.slice(0, 4).join(" ");
}
function indexRep() {
  repMap = {};
  (function index(n) {
    if (!n || !n.fen) return;
    repMap[n.fen] = n;
    var s = normFen(n.fen);
    if (!repMap[s]) repMap[s] = n;
    (n.children || []).forEach(index);
  })(REP);
}
indexRep();
var BUILTIN = REP;
var REP_EXTRA = __REP_EXTRA__;
function switchRep(couleur) {
  if (REP_EXTRA && REP_EXTRA[couleur]) { setRep(REP_EXTRA[couleur], couleur + " (intégré)"); return; }
  fetchRep("repertoire_" + couleur + ".json");
}
function fetchRep(path) {
  var lab = document.getElementById("srclabel");
  lab.textContent = "Chargement de " + path + " ...";
  fetch(path).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function (j) { setRep(j, path); })
    .catch(function (e) { lab.textContent = "Échec (" + e.message + "). Ouvre via http (ex. python -m http.server) ou utilise Fichier…"; });
}
function setRep(data, label) {
  REP = data; indexRep();
  hist = [START_FEN]; uciHist = [null]; sanHist = [null]; openHist = [null]; idx = 0;
  refresh();
  document.getElementById("srclabel").textContent = "Source : " + label;
}
function loadBuiltin() { setRep(BUILTIN, "intégré (tous)"); }
function fetchRep(path) {
  var lab = document.getElementById("srclabel");
  lab.textContent = "Chargement de " + path + " ...";
  fetch(path).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function (j) { setRep(j, path); })
    .catch(function (e) { lab.textContent = "Échec (" + e.message + "). Ouvre via http (ex. python -m http.server) ou utilise Fichier…"; });
}
function loadFile(input) {
  var f = input.files && input.files[0];
  if (!f) return;
  var rd = new FileReader();
  rd.onload = function () {
    try { setRep(JSON.parse(rd.result), f.name); }
    catch (e) { document.getElementById("srclabel").textContent = "JSON invalide : " + e.message; }
  };
  rd.readAsText(f);
  input.value = "";
}
function liveQuery() {
  var box = document.getElementById("live");
  var tok = document.getElementById("token").value.trim();
  if (!tok) { box.innerHTML = '<span class="note">Colle ton token (https://lichess.org/account/oauth/token).</span>'; return; }
  try { localStorage.setItem("lichess_token", tok); } catch (e) {}
  box.innerHTML = '<span class="note">Requête Lichess…</span>';
  fetch("https://explorer.lichess.ovh/masters?fen=" + encodeURIComponent(hist[idx]), { headers: { "Authorization": "Bearer " + tok } })
    .then(function (r) {
      if (r.status === 401) throw new Error("token invalide (401)");
      if (r.status === 429) throw new Error("limite 25/min dépassée (429)");
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (d) { renderLive(d.moves || []); })
    .catch(function (e) { box.innerHTML = '<span class="badge-ko">' + e.message + "</span>"; });
}
function renderLive(moves) {
  var box = document.getElementById("live");
  if (!moves.length) { box.innerHTML = '<span class="note">Aucun coup.</span>'; return; }
  var tot = moves.reduce(function (a, m) { return a + m.white + m.draws + m.black; }, 0) || 1;
  box.innerHTML = "";
  moves.slice(0, 8).forEach(function (m) {
    var parties = m.white + m.draws + m.black;
    var pct = (100 * parties / tot).toFixed(1);
    var b = document.createElement("button");
    b.className = "kid";
    b.innerHTML = '<div class="san">' + m.san + ' <span style="font-weight:400;font-size:13px;color:#bab5ae">' + fmt(parties) + " parties (" + pct + '%)</span></div>'
      + '<div class="meta">' + ((m.opening && m.opening.name) || "") + "</div>";
    b.onclick = function () {
      var u = m.uci;
      var mv = game.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.length > 4 ? u[4] : "q" });
      if (mv) commitUci(u, mv.san, (m.opening && m.opening.name) || "");
    };
    box.appendChild(b);
  });
}
function repNode(fen) { return repMap[fen] || repMap[normFen(fen)] || null; }

var game = new Chess();
var board = null;
var hist = [START_FEN], uciHist = [null], sanHist = [null], openHist = [null], idx = 0;

function fmt(n) { return Number(n || 0).toLocaleString("fr-FR"); }

function fenFromHash() {
  var h = "";
  try { h = (window.parent && window.parent !== window) ? window.parent.location.hash : window.location.hash; }
  catch (e) { try { h = window.location.hash; } catch (_) {} }
  var m = /fen=([^&]+)/.exec(h || "");
  if (m) { try { return decodeURIComponent(m[1]); } catch (_) { return null; } }
  return null;
}
function saveHash(fen) {
  var v = "#fen=" + encodeURIComponent(fen);
  try { if (window.parent && window.parent !== window && window.parent.history && window.parent.history.replaceState) window.parent.history.replaceState(null, "", v); } catch (e) {}
  try { if (window.history && window.history.replaceState) window.history.replaceState(null, "", v); else window.location.hash = v; } catch (e) {}
}

function refresh() {
  var fen = hist[idx];
  game.load(fen);
  board.position(fen);
  renderHistory(); renderKids(); renderStatus(); renderDetails();
  saveHash(fen);
}

function renderHistory() {
  var el = document.getElementById("history");
  if (idx === 0) { el.innerHTML = '<span class="note">Position initiale &mdash; &agrave; toi de jouer.</span>'; return; }
  var html = "";
  for (var i = 1; i <= idx; i++) {
    if ((i - 1) % 2 === 0) html += "<b>" + ((i + 1) / 2) + ".</b> ";
    html += '<span class="mv' + (i === idx ? " cur" : "") + '">' + sanHist[i] + "</span> ";
  }
  el.innerHTML = html;
}

function renderKids() {
  var el = document.getElementById("kids");
  var node = repNode(hist[idx]);
  if (!node || !(node.children || []).length) {
    el.innerHTML = '<span class="note">Fin de ligne / hors r&eacute;pertoire. Joue librement ou reviens en arri&egrave;re.</span>';
    return;
  }
  var kids = node.children;
  var tot = kids.reduce(function (a, c) { return a + (c.parties || 0); }, 0) || 1;
  el.innerHTML = "";
  kids.forEach(function (c) {
    var pct = (100 * (c.parties || 0) / tot);
    var tot1 = (c.parties || 1);
    var pw = (100 * (c.victoires_blancs || 0) / tot1).toFixed(1);
    var pd = (100 * (c.nuls || 0) / tot1).toFixed(1);
    var pb = (100 * (c.victoires_noirs || 0) / tot1).toFixed(1);
    var b = document.createElement("button");
    b.className = "kid";
    b.innerHTML = '<div class="san">' + c.san + ' <span style="font-weight:400;font-size:13px;color:#bab5ae">' + fmt(c.parties) + " parties (" + pct.toFixed(1) + '%)</span></div>'
      + '<div class="meta">' + (c.ouverture || c.eco || "") + " &mdash; B " + pw + "% / N " + pd + "% / N " + pb + "%</div>"
      + '<div class="bar"><div class="w" style="width:' + pw + '%"></div><div class="d" style="width:' + pd + '%"></div><div class="b" style="width:' + pb + '%"></div></div>';
    b.onclick = function () { doUci(c.uci, c.ouverture || c.eco || ""); };
    el.appendChild(b);
  });
}

function renderStatus() {
  var el = document.getElementById("status");
  var trait = game.turn() === "w" ? "&#11036; Blancs" : "&#11035; Noirs";
  var extra = "";
  if (game.in_checkmate()) extra = " &mdash; <b>&Eacute;chec et mat</b>";
  else if (game.in_stalemate()) extra = " &mdash; <b>Pat</b>";
  else if (game.in_draw()) extra = " &mdash; <b>Nulle</b>";
  else if (game.in_check()) extra = " &mdash; <b>&Eacute;chec</b>";
  var node = repNode(hist[idx]);
  var badge = node
    ? '<span class="badge-ok">&#10003; dans le r&eacute;pertoire (' + (node.children || []).length + " suite(s))</span>"
    : '<span class="badge-ko">&#9888; hors r&eacute;pertoire</span>';
  el.innerHTML = "<b>Trait :</b> " + trait + extra + " &nbsp;|&nbsp; " + badge
    + ' &nbsp;|&nbsp; <span class="note">' + idx + " plis</span>";
  document.getElementById("fenbox").textContent = hist[idx];
}

function renderDetails() {
  var el = document.getElementById("details");
  if (idx === 0) { el.innerHTML = '<span class="note">D&eacute;but du r&eacute;pertoire.</span>'; return; }
  var parent = repNode(hist[idx - 1]);
  var info = null;
  if (parent) (parent.children || []).forEach(function (c) { if (c.uci === uciHist[idx]) info = c; });
  if (!info) { el.innerHTML = '<span class="note">Coup hors r&eacute;pertoire.</span>'; return; }
  el.innerHTML = "<b>" + info.san + "</b> &mdash; " + (info.ouverture || info.eco || "")
    + "<br>" + fmt(info.parties) + " parties : B " + fmt(info.victoires_blancs)
    + " / N " + fmt(info.nuls) + " / N " + fmt(info.victoires_noirs);
}

function commitUci(uci, san, opening) {
  hist = hist.slice(0, idx + 1); uciHist = uciHist.slice(0, idx + 1);
  sanHist = sanHist.slice(0, idx + 1); openHist = openHist.slice(0, idx + 1);
  hist.push(game.fen()); uciHist.push(uci); sanHist.push(san); openHist.push(opening || "");
  idx++;
  refresh();
}

function doUci(uci, opening) {
  var from = uci.slice(0, 2), to = uci.slice(2, 4), promo = uci.length > 4 ? uci[4] : "q";
  var mv = game.move({ from: from, to: to, promotion: promo });
  if (!mv) return;
  commitUci(uci, mv.san, opening);
}

function onDrop(source, target) {
  var mv = game.move({ from: source, to: target, promotion: "q" });
  if (mv === null) return "snapback";
  var uci = source + target + (mv.promotion ? mv.promotion : "");
  var parent = repNode(hist[idx]);
  var op = "";
  if (parent) (parent.children || []).forEach(function (c) { if (c.uci === uci) op = c.ouverture || c.eco || ""; });
  commitUci(uci, mv.san, op);
}

function removeGrey() { $("#board .square-55d63").css("background", ""); }
function grey(sq) {
  var $s = $("#board .square-" + sq);
  var bg = $s.hasClass("black-3c85d") ? "#a9a9a9" : "#696969";
  $s.css("background", bg);
}
function onMouseoverSquare(square, piece) {
  var moves = game.moves({ square: square, verbose: true });
  if (!moves.length) return;
  grey(square);
  moves.forEach(function (m) { grey(m.to); });
}
function onMouseoutSquare() { removeGrey(); }

function goStart() { idx = 0; refresh(); }
function goBack() { if (idx > 0) { idx--; refresh(); } }
function goFwd() { if (idx < hist.length - 1) { idx++; refresh(); } }
function lignePrincipale() {
  // Joue en boucle le coup le plus joué (1er enfant = tri API décroissant).
  var node = repNode(hist[idx]);
  if (!node || !(node.children || []).length || idx >= 60) return;
  var top = node.children[0];
  doUci(top.uci, top.ouverture || top.eco || "");
  setTimeout(lignePrincipale, 350);
}

function buildPgn() {
  var t = new Chess(); t.load(START_FEN);
  for (var i = 1; i <= idx; i++) {
    var u = uciHist[i];
    t.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.length > 4 ? u[4] : "q" });
  }
  return t.pgn();
}
function copyText(txt, ok) {
  function done() { alert(ok); }
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () { prompt("Copie :", txt); });
  else prompt("Copie :", txt);
}
function copyFen() { copyText(hist[idx], "FEN copi\u00e9 !"); }
function copyPgn() { copyText(buildPgn(), "PGN copi\u00e9 !"); }

$(document).ready(function () {
  var start = START_FEN;
  var h = fenFromHash();
  if (h) { var t = new Chess(); if (t.load(h)) start = h; }
  hist = [start]; uciHist = [null]; sanHist = [null]; openHist = [null]; idx = 0;
  game.load(start);
  board = Chessboard("board", {
    position: start, draggable: true, dropOffBoard: "snapback",
    pieceTheme: "https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png",
    onDrop: onDrop, onMouseoverSquare: onMouseoverSquare, onMouseoutSquare: onMouseoutSquare,
    onSnapEnd: function () { board.position(game.fen()); },
    showNotation: true
  });
  $(window).resize(function () { try { board.resize(); } catch (e) {} });
  try { var t0 = localStorage.getItem("lichess_token"); if (t0) document.getElementById("token").value = t0; } catch (e) {}
  document.getElementById("filepick").addEventListener("change", function () { loadFile(this); });
  document.getElementById("srclabel").textContent = "Source : intégré (tous)";
  refresh();
});
</script>
</body>
</html>
"""


def render_board_html(rep_json_text, start_fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                      extra_json_text=None):
    """Injecte le JSON du répertoire (+ blancs/noirs si fournis) et le FEN de départ."""
    html = TEMPLATE.replace("__START_FEN__", start_fen)
    html = html.replace("__REP_JSON__", rep_json_text)
    html = html.replace("__REP_EXTRA__", extra_json_text or '{"blancs": null, "noirs": null}')
    return html
