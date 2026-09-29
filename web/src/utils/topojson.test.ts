import { describe, expect, it } from 'vitest';
import { topoToWorldPaths, worldViewHeight } from './topojson';

function miniTopo() {
  // Carré delta-encodé : (0,0) → (10,0) → (10,10) → (0,10) → (0,0),
  // transform identité ×10 (échelle 10, translation [-180, -90]).
  return {
    type: 'Topology',
    transform: { scale: [10, 10], translate: [-180, -90] },
    objects: {
      countries: {
        geometries: [
          { type: 'Polygon', id: '250', properties: { name: 'France' }, arcs: [[0]] },
          { type: 'Polygon', id: '010', properties: { name: 'Antarctica' }, arcs: [[0]] },
          { type: 'Polygon', id: '-99', properties: { name: 'Kosovo' }, arcs: [[0]] },
        ],
      },
    },
    arcs: [[
      [18, 9], [1, 0], [0, 1], [-1, 0], [0, -1],
    ]],
  };
}

function ringTopo(deltas: number[][], id: string) {
  return {
    type: 'Topology',
    transform: { scale: [1, 1], translate: [0, 0] },
    objects: {
      countries: {
        geometries: [
          { type: 'Polygon', id, properties: { name: id }, arcs: [[0]] },
        ],
      },
    },
    arcs: [deltas],
  };
}

/** Toutes les abscisses du chemin doivent rester dans la carte. */
function xsInMap(path: string, W: number): boolean {
  const xs = [...path.matchAll(/[ML]([\d.]+),/g)].map((m) => Number(m[1]));
  return xs.length > 0 && xs.every((x) => x >= 0 && x <= W);
}

describe('topoToWorldPaths', () => {
  it('décode les arcs, projette et écarte l’Antarctique', () => {
    const out = topoToWorldPaths(miniTopo(), 1000);
    expect(out).not.toBeNull();
    // France + Kosovo conservés, Antarctique écartée.
    expect(out!.map((f) => f.id).sort()).toEqual(['-99', '250']);
    const fr = out!.find((f) => f.id === '250')!;
    expect(fr.name).toBe('France');
    expect(fr.path.startsWith('M')).toBe(true);
    expect(fr.path.endsWith('Z')).toBe(true);
    expect(fr.path).toContain('L');
  });

  it('hauteur viewBox = 144° couverts (0,4 × largeur)', () => {
    expect(worldViewHeight(1000)).toBe(400);
  });

  it('retourne null sur structure inattendue (sans crash)', () => {
    expect(topoToWorldPaths(null, 1000)).toBeNull();
    expect(topoToWorldPaths({}, 1000)).toBeNull();
    expect(topoToWorldPaths({ objects: {}, arcs: [] }, 1000)).toBeNull();
  });

  it('antiméridien (Russie/Fidji) : découpe sans trait parasite, tout reste dans la carte', () => {
    // Carré 179° → 181° : traverse 180° vers l'est.
    const out = topoToWorldPaths(
      ringTopo([[179, 0], [2, 0], [0, 10], [-2, 0], [0, -10]], '643'),
      1000,
    );
    expect(out).not.toBeNull();
    const path = out![0].path;
    // Trois morceaux (traversée aller à lat 0 + retour à lat 10), aucun
    // segment transocéanique : tout reste dans la carte.
    expect(path.split('M').length - 1).toBe(3);
    expect(xsInMap(path, 1000)).toBe(true);
  });

  it('longitudes hors bornes (Aléoutiennes, < -180) : repliées dans la carte', () => {
    // Carré -179° → -190° : déborde à l'ouest, doit réapparaître à droite.
    const out = topoToWorldPaths(
      ringTopo([[179 - 358, 0], [-11, 0], [0, 10], [11, 0], [0, -10]], '840'),
      1000,
    );
    expect(out).not.toBeNull();
    expect(xsInMap(out![0].path, 1000)).toBe(true);
  });

  it('frôlement exact du méridien (points pile sur ±180) : aucun saut de bord', () => {
    // Carré 179° → 180° pile → 180° → 179° : touche sans traverser.
    const out = topoToWorldPaths(
      ringTopo([[179, 0], [1, 0], [0, 10], [-1, 0], [0, -10]], '643'),
      1000,
    );
    expect(out).not.toBeNull();
    // Un seul morceau, replié côté continu (pas de trait pleine largeur).
    expect(out![0].path.split('M').length - 1).toBe(1);
    expect(xsInMap(out![0].path, 1000)).toBe(true);
  });
});
