/**
 * biomes.js — what kind of country a place is.
 *
 * ── the method ──────────────────────────────────────────────────────────────
 *
 * Two layers, both standard in procedural world building:
 *
 *  1. CLIMATE (Whittaker). Every point has a temperature and a moisture.
 *     Temperature falls with height above the local base (a lapse rate) and
 *     drifts over tens of kilometres; moisture is a slow field plus landform —
 *     water collects in hollows — plus the lakes. A biome is a region of that
 *     (T, M) plane: cold + wet is boreal forest, hot + dry is savanna, and so on.
 *
 *  2. REGIONS (Worley / Voronoi cells). Classifying every point independently
 *     gives a climate map that is right and boring: every gradient becomes a
 *     sequence of thin parallel bands. Real country comes in PATCHES — a whole
 *     valley of birch, a hillside of pine — so the classification is done once
 *     per CELL of a jittered grid (`BIOME.cell`), at the cell's own centre, and
 *     the cell paints its whole area. The grid is domain-warped, so cells are
 *     organic shapes rather than polygons, and each cell carries a seeded bias
 *     so neighbouring cells with similar climate do not all pick the same thing.
 *
 * Borders blend over `BIOME.border` metres using the classic F2 − F1 Worley
 * distance: zero on the boundary, growing into the interior, so two biomes
 * cross-fade in a band rather than at a line, and the band follows the warped
 * edge exactly.
 *
 * Every consumer — the tree and shrub scatter, the grass, the ground colour,
 * the lakes — asks `biomeAt()`, so they cannot disagree about where a border is.
 */

import { BIOME } from './config.js';
import { hashInt, mulberry32, smoothstep, clamp } from './util.js';

/**
 * The biome table.
 *
 *   T, M      ideal temperature and moisture (0..1)
 *   trees     species → relative weight (species missing = never)
 *   shrubs    shrub   → relative weight
 *   canopy    multiplier on woodland density (0 = open country)
 *   lone      0..1, how much of the canopy is LONE trees rather than stands
 *             (savanna is all lone trees; a forest none)
 *   under     multiplier on understorey
 *   grass     multiplier on ground cover; `flowers` share of tufts in bloom
 *   bloom     flower colours
 *   tint      multiplier on the ground palette (r, g, b)
 *   lake      chance a lake cell here holds water
 *   rocks     multiplier on stone
 */
export const BIOMES = {
  meadow: {
    label: 'Meadow', T: 0.58, M: 0.52,
    trees: { oak: 1.0, maple: 0.5, cherry: 0.35, birch: 0.2, poplar: 0.25 },
    shrubs: { bramble: 1.0, hazel: 0.6, rosebush: 0.8, boxwood: 0.4 },
    canopy: 0.32, lone: 0.55, under: 0.8, grass: 1.2, flowers: 0.22,
    bloom: [[0.95, 0.85, 0.30], [0.96, 0.96, 0.92], [0.80, 0.42, 0.78], [0.95, 0.45, 0.30]],
    tint: [1.02, 1.04, 0.92], lake: 0.30, rocks: 0.6,
  },
  broadleaf: {
    label: 'Broadleaf forest', T: 0.55, M: 0.68,
    trees: { oak: 1.0, beech: 1.0, maple: 0.5, birch: 0.25 },
    shrubs: { hazel: 1.0, bramble: 0.8, fern: 1.0, boxwood: 0.3 },
    canopy: 1.25, lone: 0.05, under: 1.0, grass: 0.9, flowers: 0.04,
    bloom: [[0.96, 0.96, 0.92], [0.70, 0.62, 0.92]],
    tint: [0.92, 1.0, 0.90], lake: 0.25, rocks: 0.7,
  },
  autumn: {
    label: 'Autumn woodland', T: 0.45, M: 0.55,
    trees: { maple: 1.0, aspen: 0.8, beech: 0.5, birch: 0.5, larch: 0.2 },
    shrubs: { bramble: 0.8, hazel: 0.8, fern: 0.7, heather: 0.3 },
    canopy: 1.0, lone: 0.12, under: 0.9, grass: 0.95, flowers: 0.03,
    bloom: [[0.95, 0.80, 0.30]],
    tint: [1.10, 1.00, 0.82], lake: 0.25, rocks: 0.8,
  },
  boreal: {
    label: 'Boreal forest', T: 0.25, M: 0.62,
    trees: { pine: 1.0, spruce: 0.9, fir: 0.9, larch: 0.35, birch: 0.15 },
    shrubs: { juniper: 1.0, fern: 0.8, heather: 0.6, bramble: 0.2 },
    canopy: 1.3, lone: 0.04, under: 0.8, grass: 0.75, flowers: 0.02,
    bloom: [[0.96, 0.96, 0.92]],
    tint: [0.86, 0.96, 0.92], lake: 0.45, rocks: 1.1,
  },
  birchwood: {
    label: 'Birch wood', T: 0.38, M: 0.50,
    trees: { birch: 1.0, aspen: 0.6, poplar: 0.3, pine: 0.1 },
    shrubs: { fern: 1.0, bramble: 0.5, juniper: 0.3, heather: 0.4 },
    canopy: 0.95, lone: 0.15, under: 0.9, grass: 1.05, flowers: 0.06,
    bloom: [[0.96, 0.96, 0.92], [0.98, 0.86, 0.30]],
    tint: [0.98, 1.04, 0.90], lake: 0.35, rocks: 0.8,
  },
  savanna: {
    label: 'Dry savanna', T: 0.86, M: 0.18,
    trees: { acacia: 1.0, olive: 0.25, dead: 0.06 },
    shrubs: { gorse: 1.0, juniper: 0.5, lavender: 0.3, boxwood: 0.2 },
    canopy: 0.30, lone: 0.92, under: 0.6, grass: 0.85, flowers: 0.03,
    bloom: [[0.95, 0.80, 0.30]],
    tint: [1.22, 1.04, 0.70], lake: 0.06, rocks: 1.2,
  },
  mediterranean: {
    label: 'Mediterranean scrub', T: 0.78, M: 0.34,
    trees: { cypress: 1.0, olive: 0.9, pine: 0.3 },
    shrubs: { lavender: 1.0, gorse: 0.6, boxwood: 0.7, juniper: 0.4 },
    canopy: 0.45, lone: 0.55, under: 1.1, grass: 0.8, flowers: 0.10,
    bloom: [[0.62, 0.48, 0.86], [0.95, 0.85, 0.30]],
    tint: [1.12, 1.04, 0.80], lake: 0.10, rocks: 1.1,
  },
  alpine: {
    label: 'Alpine', T: 0.08, M: 0.45,
    // Above the treeline only: cold lowland is boreal, not alpine.
    minRelief: 110,
    trees: { larch: 0.8, pine: 0.6, dead: 0.6, fir: 0.3 },
    shrubs: { heather: 1.0, juniper: 0.9 },
    canopy: 0.35, lone: 0.45, under: 0.8, grass: 0.6, flowers: 0.06,
    bloom: [[0.62, 0.48, 0.86], [0.96, 0.96, 0.92]],
    tint: [0.92, 0.94, 0.94], lake: 0.40, rocks: 1.8,
  },
  wetland: {
    label: 'Wetland', T: 0.52, M: 0.82,
    trees: { willow: 1.0, poplar: 0.6, birch: 0.35, beech: 0.15 },
    shrubs: { reeds: 1.0, fern: 0.6, bramble: 0.4, hazel: 0.3 },
    canopy: 0.70, lone: 0.40, under: 1.2, grass: 1.3, flowers: 0.08,
    bloom: [[0.98, 0.86, 0.30], [0.96, 0.96, 0.92]],
    tint: [0.88, 1.06, 0.92], lake: 0.85, rocks: 0.4,
  },
  blossom: {
    label: 'Blossom grove', T: 0.62, M: 0.60,
    trees: { cherry: 1.0, maple: 0.25, birch: 0.2 },
    shrubs: { rosebush: 1.0, boxwood: 0.6, hazel: 0.3 },
    canopy: 0.70, lone: 0.30, under: 0.9, grass: 1.15, flowers: 0.30,
    bloom: [[0.98, 0.72, 0.82], [0.96, 0.96, 0.92], [0.95, 0.85, 0.30]],
    tint: [1.0, 1.05, 0.95], lake: 0.30, rocks: 0.5,
    // A rare biome: it only wins a cell when the cell's own roll lands it.
    rare: 0.10,
  },
};
export const BIOME_NAMES = Object.keys(BIOMES);

/** Normalised species weights per biome, computed once: the best species is 1. */
for (const b of Object.values(BIOMES)) {
  const mt = Math.max(...Object.values(b.trees));
  b.treeW = Object.fromEntries(Object.entries(b.trees).map(([k, v]) => [k, v / mt]));
  const ms = Math.max(...Object.values(b.shrubs));
  b.shrubW = Object.fromEntries(Object.entries(b.shrubs).map(([k, v]) => [k, v / ms]));
}

/**
 * Builds the biome sampler for one world.
 * @param {object} terrain noise.js terrain (for `mask`, `continent`, `height`)
 * @param {number} seed
 */
export function createBiomes(terrain, seed) {
  const cells = new Map();
  const S = BIOME.cell;

  /** Climate at a point, 0..1 each. `relief` = height above the local base. */
  function climate(x, z, relief) {
    const warmth = (terrain.mask(x, z, 0.000075, 1771 + seed % 997, -9031) - 0.5) * 3.2 + 0.52;
    const lapse = clamp(relief / 520, -0.15, 1);
    const T = clamp(warmth - lapse * 0.45, 0, 1);
    const wet = (terrain.mask(x, z, 0.00013, -5309, 2287 + seed % 613) - 0.5) * 3.0 + 0.5;
    const hollow = clamp(0.5 - relief / 300, 0, 1);
    const M = clamp(wet * 0.8 + hollow * 0.35 - 0.08, 0, 1);
    return { T, M };
  }

  /** The cell at grid (ci, cj): its warped centre and its biome. Memoised. */
  function cell(ci, cj) {
    const k = ci * 73856093 ^ cj * 19349663;
    let c = cells.get(k);
    if (c) return c;
    const rng = mulberry32(hashInt(k ^ (seed * 2654435761)));
    const cx = (ci + 0.15 + 0.7 * rng()) * S;
    const cz = (cj + 0.15 + 0.7 * rng()) * S;
    const relief = terrain.height(cx, cz, 400) - terrain.continent(cx, cz);
    const { T, M } = climate(cx, cz, relief);
    let best = 'meadow', bestScore = -Infinity;
    for (const name of BIOME_NAMES) {
      const b = BIOMES[name];
      const dT = (T - b.T) / 0.22, dM = (M - b.M) / 0.24;
      let score = -(dT * dT + dM * dM) + rng() * BIOME.variety;
      if (b.rare && rng() > b.rare) score -= 99;
      if (b.minRelief && relief < b.minRelief) score -= 2 + (b.minRelief - relief) / 60;
      if (score > bestScore) { bestScore = score; best = name; }
    }
    c = { cx, cz, biome: best, T, M };
    if (cells.size > 20000) cells.clear();
    cells.set(k, c);
    return c;
  }

  const res = { a: 'meadow', b: 'meadow', t: 0, T: 0.5, M: 0.5 };

  /**
   * The biome blend at (x, z): `a` the nearest cell's biome, `b` the second,
   * `t` the weight of `b` (0 deep inside a cell, 0.5 on the border).
   * Returns a SHARED record — copy what you need before calling again.
   */
  function biomeAt(x, z) {
    // Domain warp: two octaves, a few hundred metres — the cell edges become
    // coastlines instead of polygon edges.
    const wx = x + (terrain.mask(x, z, 0.0009, 313, 911) - 0.5) * BIOME.warp
                 + (terrain.mask(x, z, 0.0031, -77, 404) - 0.5) * BIOME.warp * 0.35;
    const wz = z + (terrain.mask(x, z, 0.0009, -2201, 57) - 0.5) * BIOME.warp
                 + (terrain.mask(x, z, 0.0031, 812, -309) - 0.5) * BIOME.warp * 0.35;
    const ci = Math.floor(wx / S), cj = Math.floor(wz / S);
    let d1 = Infinity, d2 = Infinity, c1 = null, c2 = null;
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        const c = cell(i, j);
        const dx = wx - c.cx, dz = wz - c.cz;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < d1) { d2 = d1; c2 = c1; d1 = d; c1 = c; }
        else if (d < d2) { d2 = d; c2 = c; }
      }
    }
    res.a = c1.biome;
    res.b = c2.biome;
    res.T = c1.T; res.M = c1.M;
    // F2 - F1 is twice the distance to the bisector between the two cells.
    res.t = c1.biome === c2.biome ? 0 : 0.5 * (1 - smoothstep(0, BIOME.border, d2 - d1));
    return res;
  }

  /** Blend of one numeric biome property at the last `biomeAt` result. */
  function mix(r, key) {
    return BIOMES[r.a][key] * (1 - r.t) + BIOMES[r.b][key] * r.t;
  }

  return { biomeAt, mix, climate, BIOMES };
}
