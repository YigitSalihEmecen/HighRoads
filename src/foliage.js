/**
 * foliage.js — which trees exist, how big they are, and where they belong.
 *
 * SCOPE: trees only, deliberately. The Quaternius pack also ships rocks,
 * bushes, plants, flowers, logs and grass tufts, and all of them are currently
 * switched off — the scatter needs designing properly rather than tuning, and
 * a half-populated understorey reads worse than none. The species table below
 * is the whole vocabulary; adding a group back means adding it here and to
 * FOLIAGE_GROUPS, and nothing else changes.
 *
 * Placement is driven by three signals already available from the terrain:
 *   altitude   pushes conifers up and broadleaves down, and stops everything
 *              at the treeline;
 *   slope      nothing grows on ground too steep for soil to hold;
 *   region     the biome mask from noise.js, so forest thins out into open
 *              country and back over kilometres rather than metres.
 *
 * Models are authored around 2.5–3.5 units tall, so every entry carries the
 * scale that turns it into a believable real-world height.
 */

import { CHUNK } from './config.js';

/**
 * @typedef {object} FoliageKind
 * @property {string[]} models   file names (no extension)
 * @property {[number, number]} height  metres, min..max
 * @property {number} weight     relative abundance
 * @property {[number, number]} altitude  fades in/out over this band, metres
 * @property {number} maxSlope   steepest ground it will grow on (rise/run)
 * @property {[number, number]} lateral   how far from the road it may appear
 * @property {number} [regionBias]  >0 favours mountains, <0 favours lowland
 */

/** @type {Record<string, FoliageKind>} */
export const FOLIAGE = {
  pine: {
    models: ['PineTree_1', 'PineTree_2', 'PineTree_3', 'PineTree_4', 'PineTree_5'],
    height: [9, 19],
    weight: 1.0,
    altitude: [10, 120],
    maxSlope: 0.75,
    lateral: [13, 135],
    regionBias: 0.6,
  },
  commonTree: {
    models: ['CommonTree_1', 'CommonTree_2', 'CommonTree_3', 'CommonTree_4', 'CommonTree_5'],
    height: [7, 14],
    weight: 0.9,
    altitude: [-60, 85],
    maxSlope: 0.6,
    lateral: [13, 135],
    regionBias: -0.3,
  },
  birch: {
    models: ['BirchTree_1', 'BirchTree_2', 'BirchTree_3', 'BirchTree_4', 'BirchTree_5'],
    height: [8, 15],
    weight: 0.55,
    altitude: [-40, 95],
    maxSlope: 0.55,
    lateral: [13, 135],
  },
  willow: {
    models: ['Willow_1', 'Willow_2', 'Willow_3'],
    height: [8, 13],
    weight: 0.3,
    // Willows want damp low ground, so they stop well below the others.
    altitude: [-60, 35],
    maxSlope: 0.35,
    lateral: [14, 120],
    regionBias: -0.8,
  },
  autumnTree: {
    models: ['CommonTree_Autumn_1', 'CommonTree_Autumn_3', 'BirchTree_Autumn_2', 'BirchTree_Autumn_4'],
    height: [7, 13],
    weight: 0.28,
    altitude: [-30, 90],
    maxSlope: 0.6,
    lateral: [13, 135],
  },
  deadTree: {
    models: ['CommonTree_Dead_2', 'CommonTree_Dead_4', 'BirchTree_Dead_1', 'BirchTree_Dead_4'],
    height: [6, 12],
    weight: 0.16,
    // Survives higher than anything living — the last thing before bare rock.
    altitude: [40, 145],
    maxSlope: 0.85,
    lateral: [15, 150],
    regionBias: 0.9,
  },
};

/**
 * Species are drawn from groups, and each chunk commits to only a few members
 * of each group. This is purely a batching concern: an InstancedMesh exists per
 * (chunk, model), so letting every species appear everywhere costs a draw call
 * each before a single tree is shaded. Picking per chunk keeps the batch count
 * low while the world at large still shows everything.
 *
 * The cap is a triangle budget. Canopy models are 1700–2900 triangles each, so
 * the count is what needs limiting rather than the sample count.
 */
export const FOLIAGE_GROUPS = {
  canopy: {
    members: ['pine', 'commonTree', 'birch', 'willow', 'autumnTree', 'deadTree'],
    picks: 3,
    cap: 52,
  },
};

/** Which group a species belongs to. */
export const GROUP_OF = (() => {
  const m = {};
  for (const [g, def] of Object.entries(FOLIAGE_GROUPS)) for (const k of def.members) m[k] = g;
  return m;
})();

/**
 * Flat list of every model this module can ask for.
 *
 * Empty when `CHUNK.trees` is off, which is the whole switch: no models load,
 * so `chunks._buildProps` finds an empty library and returns nothing, and the
 * boot does not spend twenty-six fetches on geometry it will never draw. The
 * species table below stays exactly as it is.
 */
export function foliageModelNames() {
  if (!CHUNK.trees) return [];
  const names = new Set();
  for (const kind of Object.values(FOLIAGE)) for (const m of kind.models) names.add(m);
  return [...names];
}

/**
 * Suitability of a kind for a given spot, 0..1. Multiplied by the kind's weight
 * to form a sampling distribution; 0 means "never here".
 */
export function suitability(kind, { altitude, slope, lateral, region }) {
  if (slope > kind.maxSlope) return 0;
  if (lateral < kind.lateral[0] || lateral > kind.lateral[1]) return 0;

  const [aLo, aHi] = kind.altitude;
  // Fade over the outer 25% of the altitude band instead of cutting hard, so
  // species transition into one another up a hillside.
  const band = (aHi - aLo) * 0.25;
  if (altitude < aLo - band || altitude > aHi + band) return 0;
  let f = 1;
  if (altitude < aLo) f *= (altitude - (aLo - band)) / band;
  if (altitude > aHi) f *= ((aHi + band) - altitude) / band;

  if (kind.regionBias) {
    const want = kind.regionBias > 0 ? region : 1 - region;
    f *= 1 - Math.abs(kind.regionBias) * (1 - want);
  }

  // Thin out as the ground steepens, well before the hard cutoff.
  f *= 1 - Math.min(1, slope / kind.maxSlope) * 0.55;
  return Math.max(0, f);
}
