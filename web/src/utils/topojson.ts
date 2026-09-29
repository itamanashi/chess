/**
 * Décodeur TopoJSON MINIMAL pour `world-atlas countries-110m` : arcs
 * delta-encodés → chemins SVG en projection équirectangulaire. Aucune
 * dépendance (d3/topojson-client évités pour un seul usage).
 *
 * - Antarctique (id « 010 ») écartée : elle écraserait la carte.
 * - Latitudes bornées à [-60, 84] (la carte reste compacte).
 * - `W` = largeur viewBox ; hauteur = 0.4 × W (144° couverts / 360°).
 */

export interface WorldFeature {
  /** Identifiant world-atlas (ISO numérique en chaîne, ex. « 250 »). */
  id: string;
  /** Nom anglais d'origine (repli d'infobulle si pas d'alpha-2). */
  name: string;
  /** Chemin SVG prêt à rendre. */
  path: string;
}

const ANTARCTIC_ID = '010';
const MIN_LAT = -60;
const MAX_LAT = 84;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isRecord(v: Json): v is { [k: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: Json): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Replie une longitude dans [-180, 180]. */
function normLon(lon: number): number {
  return ((lon + 540) % 360) - 180;
}

/**
 * Découpe un anneau (longitudes CONTINUES, éventuellement hors ±180 :
 * Russie/Fidji chevauchent l'antiméridien, les Aléoutiennes dépassent -180)
 * en morceaux sans saut de méridien. Chaque traversée STRICTE insère les
 * points de coupe aux deux bords pour des remplissages propres. Les
 * frôlements EXACTS du méridien (points quantifiés pile sur ±180, fréquents
 * dans les données 110m) sont repliés côté continu : sans ça, `normLon`
 * les bascule de l'autre bord et trace le trait horizontal parasite qui
 * barrait la carte (Russie affichée sur le Canada).
 */
function splitAntimeridian(pts: Array<[number, number]>): Array<Array<[number, number]>> {
  if (pts.length === 0) return [];
  const parts: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  /** Longitude AFFICHÉE du dernier point (suivi de continuité). */
  let shownPrev: number | null = null;
  const pushRaw = (d: number, lat: number): void => {
    current.push([d, lat]);
    shownPrev = d;
  };
  const pushWrapped = (u: number, lat: number): void => {
    let d = normLon(u);
    // Frôlement exact du méridien : rester du côté continu (segment nul
    // invisible) plutôt que de sauter d'un bord à l'autre de la carte.
    if (shownPrev !== null && Math.abs(d - shownPrev) > 180) {
      d = shownPrev > 0 ? 180 : -180;
    }
    pushRaw(d, lat);
  };
  pushWrapped(pts[0][0], pts[0][1]);
  let prevU = pts[0][0];
  for (let i = 1; i < pts.length; i++) {
    const [rawLon, lat] = pts[i];
    const prevLat = pts[i - 1][1];
    // Représentant continu de la longitude (proche du point précédent).
    let u = rawLon;
    while (u - prevU > 180) u -= 360;
    while (u - prevU < -180) u += 360;
    // Méridiens ±180 (+360k) STRICTEMENT traversés entre prevU et u
    // (strict : t reste dans (0,1), jamais de NaN sur points confondus).
    const lo = Math.min(prevU, u);
    const hi = Math.max(prevU, u);
    const goingEast = u > prevU;
    let segU = prevU;
    let segLat = prevLat;
    for (let m = Math.ceil((lo - 180) / 360); ; m++) {
      const edge = 180 + 360 * m;
      if (edge >= hi) break;
      if (edge <= lo) continue;
      const t = (edge - segU) / (u - segU);
      const latC = segLat + t * (lat - segLat);
      pushRaw(goingEast ? 180 : -180, latC);
      parts.push(current);
      current = [];
      pushRaw(goingEast ? -180 : 180, latC);
      segU = edge;
      segLat = latC;
    }
    pushWrapped(u, lat);
    prevU = u;
  }
  parts.push(current);
  return parts;
}

/** Un anneau = liste d'indices d'arcs (indice `~i` = arc i inversé). */
function decodeRing(
  ring: Json[],
  arcs: Json[],
  scale: [number, number],
  translate: [number, number],
  project: (lon: number, lat: number) => [number, number],
): string {
  const lonLat: Array<[number, number]> = [];
  for (const arcRef of ring) {
    if (typeof arcRef !== 'number' || !Number.isInteger(arcRef)) continue;
    const reversed = arcRef < 0;
    const arc = arcs[reversed ? ~arcRef : arcRef];
    if (!Array.isArray(arc) || arc.length === 0) continue;
    // Arc delta-encodé : accumulation puis transformation affine.
    let x = 0;
    let y = 0;
    const decoded: Array<[number, number]> = [];
    for (const p of arc) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const dx = num(p[0]);
      const dy = num(p[1]);
      if (dx === null || dy === null) continue;
      x += dx;
      y += dy;
      decoded.push([x * scale[0] + translate[0], y * scale[1] + translate[1]]);
    }
    if (reversed) decoded.reverse();
    // Raccord sans doublon au point de jonction.
    for (let k = 0; k < decoded.length; k++) {
      if (lonLat.length > 0 && k === 0) continue;
      lonLat.push(decoded[k]);
    }
  }
  if (lonLat.length === 0) return '';
  return splitAntimeridian(lonLat)
    .map((part) => {
      const pts = part.map((p) => project(p[0], p[1]));
      return `M${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}Z`;
    })
    .join('');
}

function decodePolygon(
  coords: Json,
  arcs: Json[],
  scale: [number, number],
  translate: [number, number],
  project: (lon: number, lat: number) => [number, number],
): string {
  if (!Array.isArray(coords)) return '';
  return coords
    .map((ring) => (Array.isArray(ring) ? decodeRing(ring, arcs, scale, translate, project) : ''))
    .filter((d) => d.length > 0)
    .join('');
}

/**
 * TopoJSON → tracés SVG. Retourne `null` si la structure est inattendue
 * (version CDN différente : la carte affiche un repli, sans crash).
 */
export function topoToWorldPaths(topo: unknown, W: number): WorldFeature[] | null {
  if (!isRecord(topo as Json)) return null;
  const t = topo as { [k: string]: Json };
  if (!isRecord(t['objects']) || !Array.isArray(t['arcs'])) return null;
  const objects = t['objects'] as { [k: string]: Json };
  const countries = objects['countries'];
  if (!isRecord(countries) || !Array.isArray(countries['geometries'])) return null;
  const transform = isRecord(t['transform']) ? (t['transform'] as { [k: string]: Json }) : null;
  const scaleJson = transform?.['scale'];
  const translateJson = transform?.['translate'];
  const scale: [number, number] =
    Array.isArray(scaleJson) && num(scaleJson[0]) !== null && num(scaleJson[1]) !== null
      ? [scaleJson[0] as number, scaleJson[1] as number]
      : [1, 1];
  const translate: [number, number] =
    Array.isArray(translateJson) && num(translateJson[0]) !== null && num(translateJson[1]) !== null
      ? [translateJson[0] as number, translateJson[1] as number]
      : [0, 0];
  const arcs = t['arcs'] as Json[];
  const project = (lon: number, lat: number): [number, number] => {
    const clamped = Math.min(MAX_LAT, Math.max(MIN_LAT, lat));
    return [((lon + 180) / 360) * W, ((MAX_LAT - clamped) / 360) * W];
  };
  const out: WorldFeature[] = [];
  for (const g of countries['geometries'] as Json[]) {
    if (!isRecord(g)) continue;
    const id = g['id'];
    const idStr = typeof id === 'string' ? id : typeof id === 'number' ? String(id) : '';
    if (!idStr || idStr === ANTARCTIC_ID) continue;
    const props = isRecord(g['properties']) ? (g['properties'] as { [k: string]: Json }) : null;
    const name = props && typeof props['name'] === 'string' ? (props['name'] as string) : idStr;
    const type = g['type'];
    let d = '';
    // NB : en TopoJSON les anneaux vivent dans `arcs` (`coordinates` = GeoJSON).
    if (type === 'Polygon') d = decodePolygon(g['arcs'], arcs, scale, translate, project);
    else if (type === 'MultiPolygon' && Array.isArray(g['arcs'])) {
      d = (g['arcs'] as Json[])
        .map((poly) => decodePolygon(poly, arcs, scale, translate, project))
        .filter((s) => s.length > 0)
        .join('');
    }
    if (d) out.push({ id: idStr, name, path: d });
  }
  return out;
}

/** Hauteur viewBox assortie à la largeur (144° de latitude couverts). */
export function worldViewHeight(W: number): number {
  return ((MAX_LAT - MIN_LAT) / 360) * W;
}
