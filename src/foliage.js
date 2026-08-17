/**
 * foliage.js — which plants exist, how big they are, and where they belong.
 *
 * The Quaternius pack is deliberately over-supplied: 150 models covering snow,
 * desert and autumn variants we mostly don't want. This module curates a
 * temperate subset and attaches the ecology — the rules that decide whether a
 * given patch of hillside gets pines, birches, scrub or bare rock.
 *
 * Placement is driven by three signals already available from the terrain:
 *   altitude   pushes conifers up and broadleaves down, and stops everything
 *              at the treeline;
 *   slope      bare rock on anything steep enough that soil wouldn't hold;
 *   region     the biome mask from noise.js, so forest thins out into open
 *              country and back over kilometres rather than metres.
 *
 * Models are authored around 2.5–3.5 units tall, so every entry carries the
 * scale that turns it into a believable real-world height.
 */

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
  // ---- canopy ------------------------------------------------------------
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

  // ---- understorey -------------------------------------------------------
  bush: {
    models: ['Bush_1', 'Bush_2', 'BushBerries_1', 'BushBerries_2'],
    height: [1.1, 2.4],
    weight: 0.85,
    altitude: [-60, 110],
    maxSlope: 0.7,
    lateral: [9, 90],
  },
  plant: {
    models: ['Plant_1', 'Plant_2', 'Plant_3', 'Plant_4', 'Plant_5'],
    height: [0.5, 1.1],
    weight: 0.7,
    altitude: [-60, 95],
    maxSlope: 0.6,
    // Close in, where the eye actually resolves something this small.
    lateral: [8, 45],
  },
  flowers: {
    models: ['Flowers'],
    height: [0.35, 0.6],
    weight: 0.35,
    altitude: [-40, 70],
    maxSlope: 0.4,
    lateral: [8, 30],
    regionBias: -0.5,
  },

  // ---- ground furniture --------------------------------------------------
  rock: {
    models: ['Rock_1', 'Rock_2', 'Rock_3', 'Rock_4', 'Rock_5', 'Rock_6', 'Rock_7'],
    height: [0.6, 3.4],
    // Rock passes every suitability test — it has no slope or altitude limit —
    // so it needs a low weight or it simply wins most of the draws and the
    // world turns into a quarry.
    weight: 0.3,
    altitude: [-60, 160],
    // Rock is the one thing that *prefers* steep ground.
    maxSlope: 5,
    lateral: [9, 210],
    regionBias: 0.7,
  },
  mossRock: {
    models: ['Rock_Moss_1', 'Rock_Moss_3', 'Rock_Moss_5', 'Rock_Moss_6'],
    height: [0.5, 2.6],
    weight: 0.24,
    altitude: [-60, 90],
    maxSlope: 5,
    lateral: [9, 150],
    regionBias: -0.4,
  },
  log: {
    models: ['WoodLog', 'WoodLog_Moss', 'TreeStump', 'TreeStump_Moss'],
    height: [0.5, 1.2],
    weight: 0.22,
    altitude: [-60, 95],
    maxSlope: 0.4,
    lateral: [10, 70],
  },
};

/**
 * Ground cover is a separate, denser pass rather than one more species in the
 * weighted draw. Grass has to read as a continuous surface, not as scattered
 * individuals, so it needs an order of magnitude more instances than anything
 * else and its own density mask — competing for the same draws as trees would
 * have starved it. At 192 triangles a tuft it is by far the cheapest thing
 * here, which is what makes that affordable.
 */
export const GRASS = {
  models: ['Grass', 'Grass_2', 'Grass_Short'],
  /** Concrete models per chunk; more variety costs a draw call each. */
  picks: 2,
  height: [0.35, 0.95],
  /** Verge outwards. Stops well inside the fog so it is never a distant carpet. */
  lateral: [7.0, 62],
  maxSlope: 0.62,
  altitude: [-70, 115],
  samples: 850,
  cap: 300,
  /**
   * Bald patches. Grass covering every square metre looks sprayed on; real
   * ground has worn tracks, dry soil and rock showing through, so coverage is
   * gated by a mid-frequency noise field with a hard floor.
   */
  patchScale: 0.035,
  patchFloor: 0.28,
};

/**
 * Species are drawn from groups, and each chunk commits to only a few members
 * of each group. This is purely a batching concern: an InstancedMesh exists per
 * (chunk, model), so letting all twelve species appear everywhere costs 130+
 * draw calls before a single tree is shaded. Picking per chunk keeps the batch
 * count near six while the world at large still shows everything.
 *
 * The caps are a triangle budget. Canopy models are 1700–2900 triangles each —
 * two orders of magnitude more than a rock — so they are what actually needs
 * limiting, not the prop count.
 */
export const FOLIAGE_GROUPS = {
  canopy: { members: ['pine', 'commonTree', 'birch', 'willow', 'autumnTree', 'deadTree'], picks: 2, cap: 34 },
  shrub: { members: ['bush'], picks: 1, cap: 34 },
  ground: { members: ['plant', 'flowers'], picks: 1, cap: 55 },
  stone: { members: ['rock', 'mossRock'], picks: 1, cap: 34 },
  debris: { members: ['log'], picks: 1, cap: 8 },
};

/** Which group a species belongs to. */
export const GROUP_OF = (() => {
  const m = {};
  for (const [g, def] of Object.entries(FOLIAGE_GROUPS)) for (const k of def.members) m[k] = g;
  return m;
})();

/** Flat list of every model this module can ask for. */
export function foliageModelNames() {
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
