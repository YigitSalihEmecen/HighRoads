/**
 * foliage.js — what grows, its look, and where it belongs.
 *
 * One table holds the form and the habitat of each species. Shapes come from
 * env/trees.js and env/bushes.js. Placement and streaming read this file.
 */

import { CHUNK, TREES } from './config.js';
import { BIOMES } from './biomes.js';

/**
 * The biome sampler and lake lookup for this world, set by chunks.js. Kept
 * module-level so `vegetation()` keeps its signature for every caller.
 */
let BIOME_FN = null;
let LAKE_FN = null;
export function setEcology(biomeSampler, lakeShore) { BIOME_FN = biomeSampler; LAKE_FN = lakeShore; }

/* ================================================================= forms == */

export const TREE_FORMS = {
  pine: {
    crown: 'tier',
    trunk: {
      height: 0.55, radius: 0.040, taper: 0.55, sides: 6,
      lean: 0.05, bend: 0.10, flare: 1.9,
    },
    tiers: {
      count: 5, sides: 9, from: 0.50, to: 1.0,
      radius: [0.27, 0.06], height: 1.85, droop: 0.34, jag: 0.30,
    },
    bark: [0.36, 0.25, 0.17],
    palettes: [
      [[0.10, 0.30, 0.11], [0.21, 0.51, 0.17]],
      [[0.07, 0.23, 0.09], [0.16, 0.41, 0.14]],
      [[0.13, 0.36, 0.10], [0.28, 0.57, 0.15]],
    ],
    lod: { tiers: 3, sides: 6, trunkSides: 3 },
  },

  spruce: {
    crown: 'tier',
    trunk: {
      height: 0.22, radius: 0.038, taper: 0.5, sides: 6,
      lean: 0.02, bend: 0.06, flare: 2.1,
    },
    tiers: {
      count: 7, sides: 9, from: 0.08, to: 1.0,
      radius: [0.34, 0.05], height: 1.7, droop: 0.38, jag: 0.28,
    },
    bark: [0.29, 0.20, 0.15],
    palettes: [
      [[0.06, 0.22, 0.09], [0.15, 0.39, 0.13]],
      [[0.09, 0.28, 0.11], [0.20, 0.47, 0.16]],
      [[0.05, 0.17, 0.08], [0.12, 0.32, 0.11]],
    ],
    lod: { tiers: 4, sides: 6, trunkSides: 3 },
  },

  oak: {
    crown: 'blob',
    trunk: {
      height: 0.58, radius: 0.052, taper: 0.62, sides: 6,
      lean: 0.10, bend: 0.26, flare: 1.8,
    },
    limbs: {
      count: 3, from: 0.82, to: 1.0, angle: 0.58, length: 0.30,
      radius: 0.62, taper: 0.66, sides: 3,
      levels: 2, split: 2, splitAngle: 0.50, shrink: 0.62, rise: 0.34,
    },
    blobs: {
      tips: 6, detail: 1, size: [0.17, 0.23], squash: 0.86,
      warp: 0.22, lift: 0.15, apex: 0.75,
    },
    bark: [0.36, 0.27, 0.19],
    palettes: [
      [[0.24, 0.52, 0.20], [0.40, 0.70, 0.27]],
      [[0.19, 0.44, 0.18], [0.33, 0.62, 0.25]],
      [[0.30, 0.58, 0.19], [0.49, 0.76, 0.26]],
    ],
    lod: { levels: 1, split: 2, limbs: 1, detail: 0, trunkSides: 3 },
  },

  maple: {
    crown: 'blob',
    trunk: {
      height: 0.60, radius: 0.046, taper: 0.60, sides: 6,
      lean: 0.09, bend: 0.22, flare: 1.7,
    },
    limbs: {
      count: 3, from: 0.78, to: 1.0, angle: 0.50, length: 0.28,
      radius: 0.60, taper: 0.64, sides: 3,
      levels: 2, split: 2, splitAngle: 0.44, shrink: 0.62, rise: 0.44,
    },
    blobs: {
      tips: 6, detail: 1, size: [0.16, 0.22], squash: 0.94,
      warp: 0.20, lift: 0.15, apex: 0.85,
    },
    bark: [0.37, 0.28, 0.21],
    palettes: [
      [[0.78, 0.35, 0.09], [0.94, 0.58, 0.15]],
      [[0.66, 0.19, 0.11], [0.86, 0.36, 0.14]],
      [[0.80, 0.56, 0.10], [0.95, 0.76, 0.22]],
    ],
    lod: { levels: 1, split: 2, limbs: 1, detail: 0, trunkSides: 3 },
  },

  birch: {
    crown: 'blob',
    trunk: {
      height: 0.56, radius: 0.030, taper: 0.55, sides: 5,
      lean: 0.14, bend: 0.30, flare: 1.5,
    },
    limbs: {
      count: 3, from: 0.70, to: 1.0, angle: 0.42, length: 0.24,
      radius: 0.58, taper: 0.62, sides: 3,
      levels: 2, split: 2, splitAngle: 0.38, shrink: 0.62, rise: 0.52,
    },
    blobs: {
      tips: 6, detail: 1, size: [0.13, 0.18], squash: 0.90, 
      warp: 0.24, lift: 0.15, apex: 0.8,
    },
    bark: [0.92, 0.91, 0.86],
    palettes: [
      [[0.52, 0.70, 0.24], [0.72, 0.86, 0.35]],
      [[0.44, 0.62, 0.22], [0.63, 0.79, 0.31]],
      [[0.62, 0.74, 0.22], [0.83, 0.90, 0.33]],
    ],
    lod: { levels: 1, split: 2, limbs: 1, detail: 0, trunkSides: 3 },
  },

  poplar: {
    crown: 'blob',
    trunk: {
      height: 0.30, radius: 0.032, taper: 0.60, sides: 5,
      lean: 0.03, bend: 0.08, flare: 1.6,
    },
    limbs: {
      count: 5, from: 0.16, to: 1.0, angle: 0.30, length: 0.24,
      radius: 0.50, taper: 0.60, sides: 3,
      levels: 1, split: 2, splitAngle: 0.30, shrink: 0.7, rise: 1.15,
    },
    blobs: {
      tips: 5, detail: 1, size: [0.13, 0.17], squash: 1.20,
      warp: 0.16, lift: 0.2, apex: 1.0,
    },
    bark: [0.43, 0.38, 0.29],
    palettes: [
      [[0.26, 0.50, 0.20], [0.40, 0.66, 0.27]],
      [[0.31, 0.56, 0.21], [0.47, 0.72, 0.28]],
      [[0.21, 0.43, 0.19], [0.34, 0.58, 0.24]],
    ],
    // Five primaries, no second generation (far tier trims count only).
    lod: { levels: 1, split: 2, limbs: 0.6, detail: 0, trunkSides: 3 },
  },

  aspen: {
    crown: 'blob',
    trunk: {
      height: 0.50, radius: 0.031, taper: 0.58, sides: 5,
      lean: 0.08, bend: 0.20, flare: 1.5,
    },
    limbs: {
      count: 3, from: 0.72, to: 1.0, angle: 0.38, length: 0.24,
      radius: 0.56, taper: 0.62, sides: 3,
      levels: 2, split: 2, splitAngle: 0.34, shrink: 0.62, rise: 0.62,
    },
    blobs: {
      tips: 6, detail: 1, size: [0.13, 0.17], squash: 1.05,
      warp: 0.20, lift: 0.15, apex: 0.85,
    },
    bark: [0.80, 0.78, 0.69],
    palettes: [
      [[0.86, 0.66, 0.13], [0.97, 0.85, 0.30]],
      [[0.74, 0.76, 0.22], [0.92, 0.91, 0.36]],
      [[0.90, 0.52, 0.11], [0.99, 0.74, 0.24]],
    ],
    lod: { levels: 1, split: 2, limbs: 1, detail: 0, trunkSides: 3 },
  },

  dead: {
    crown: 'bare',
    trunk: {
      height: 0.78, radius: 0.058, taper: 0.34, sides: 5,
      lean: 0.16, bend: 0.42, flare: 1.9,
    },
    limbs: {
      count: 4, from: 0.42, to: 0.98, angle: 1.00, length: 0.30,
      radius: 0.62, taper: 0.58, sides: 4,
      levels: 2, split: 3, splitAngle: 0.72, shrink: 0.66, rise: 0.45,
      // Nothing is hung on a dead tree's tips, so they are the one place in the
      // table that has to close itself. An open tube end is a hole.
      capTips: true, capRoots: true,
    },
    bark: [0.50, 0.45, 0.38],
    palettes: [
      [[0.50, 0.45, 0.38], [0.62, 0.57, 0.49]],
      [[0.44, 0.39, 0.33], [0.56, 0.51, 0.44]],
      [[0.55, 0.50, 0.43], [0.67, 0.62, 0.54]],
    ],
    // Two generations on the far tier too: width is branches; dropping them
    // took the far crown radius past what `matchWidth` corrects.
    lod: { levels: 2, split: 2, limbs: 1, trunkSides: 3 },
  },

  // ---- added with the biome system ------------------------------------
  beech: {
    crown: 'blob',
    trunk: { height: 0.50, radius: 0.050, taper: 0.62, sides: 6, lean: 0.05, bend: 0.14, flare: 1.7 },
    limbs: {
      count: 3, from: 0.70, to: 1.0, angle: 0.62, length: 0.30,
      radius: 0.62, taper: 0.66, sides: 3,
      levels: 2, split: 2, splitAngle: 0.46, shrink: 0.64, rise: 0.30,
    },
    blobs: { tips: 8, detail: 1, size: [0.17, 0.22], squash: 0.80, warp: 0.18, lift: 0.12, apex: 0.8 },
    bark: [0.55, 0.53, 0.50],
    palettes: [
      [[0.16, 0.42, 0.15], [0.30, 0.60, 0.21]],
      [[0.36, 0.16, 0.14], [0.52, 0.26, 0.20]],     // copper beech
      [[0.22, 0.48, 0.16], [0.38, 0.66, 0.22]],
    ],
    lod: { levels: 1, split: 2, limbs: 0.75, detail: 0, trunkSides: 3 },
  },

  fir: {
    crown: 'tier',
    trunk: { height: 0.18, radius: 0.034, taper: 0.5, sides: 6, lean: 0.01, bend: 0.04, flare: 2.0 },
    tiers: { count: 9, sides: 8, from: 0.10, to: 1.0, radius: [0.24, 0.03], height: 1.6, droop: 0.42, jag: 0.22 },
    bark: [0.27, 0.21, 0.17],
    palettes: [
      [[0.05, 0.20, 0.12], [0.12, 0.36, 0.17]],
      [[0.07, 0.25, 0.15], [0.16, 0.42, 0.20]],
      [[0.04, 0.16, 0.10], [0.10, 0.30, 0.15]],
    ],
    lod: { tiers: 5, sides: 6, trunkSides: 3 },
  },

  larch: {
    crown: 'tier',
    trunk: { height: 0.40, radius: 0.036, taper: 0.5, sides: 6, lean: 0.04, bend: 0.08, flare: 1.8 },
    tiers: { count: 6, sides: 7, from: 0.32, to: 1.0, radius: [0.25, 0.05], height: 1.5, droop: 0.30, jag: 0.40 },
    bark: [0.38, 0.27, 0.20],
    palettes: [
      [[0.70, 0.56, 0.12], [0.90, 0.76, 0.24]],     // autumn gold
      [[0.40, 0.56, 0.18], [0.58, 0.72, 0.26]],     // spring lime
      [[0.78, 0.48, 0.12], [0.94, 0.66, 0.20]],
    ],
    lod: { tiers: 3, sides: 5, trunkSides: 3 },
  },

  cypress: {
    crown: 'tier',
    trunk: { height: 0.12, radius: 0.030, taper: 0.5, sides: 5, lean: 0.01, bend: 0.03, flare: 1.6 },
    tiers: { count: 10, sides: 7, from: 0.06, to: 1.0, radius: [0.13, 0.03], height: 1.9, droop: 0.12, jag: 0.18 },
    bark: [0.33, 0.25, 0.19],
    palettes: [
      [[0.08, 0.24, 0.12], [0.16, 0.38, 0.17]],
      [[0.10, 0.28, 0.14], [0.20, 0.42, 0.19]],
      [[0.07, 0.21, 0.11], [0.14, 0.34, 0.15]],
    ],
    lod: { tiers: 5, sides: 5, trunkSides: 3 },
  },

  acacia: {
    crown: 'blob',
    // The umbrella: a tall bare stem, limbs flung wide and nearly flat, a
    // crown squashed into a plate.
    trunk: { height: 0.62, radius: 0.040, taper: 0.62, sides: 5, lean: 0.12, bend: 0.30, flare: 1.6 },
    limbs: {
      count: 3, from: 0.80, to: 1.0, angle: 1.05, length: 0.42,
      radius: 0.58, taper: 0.62, sides: 3,
      levels: 2, split: 2, splitAngle: 0.46, shrink: 0.66, rise: 0.22,
      // Flung wide, the tips clear the flat crown plates: close them.
      capTips: true, capRoots: true,
    },
    blobs: { tips: 8, detail: 1, size: [0.20, 0.26], squash: 0.34, warp: 0.16, lift: 0.25, apex: 0, noCull: true },
    bark: [0.34, 0.27, 0.20],
    palettes: [
      [[0.36, 0.48, 0.18], [0.54, 0.62, 0.24]],
      [[0.42, 0.50, 0.16], [0.62, 0.64, 0.22]],
      [[0.30, 0.44, 0.17], [0.48, 0.58, 0.23]],
    ],
    lod: { levels: 1, split: 2, limbs: 1, detail: 0, trunkSides: 3 },
  },

  willow: {
    crown: 'blob',
    // Weeping: arching limbs that rise and spill, lumps hung BELOW the tips
    // and stretched tall — a curtain, not a ball.
    trunk: { height: 0.42, radius: 0.058, taper: 0.60, sides: 6, lean: 0.12, bend: 0.28, flare: 1.8 },
    limbs: {
      count: 4, from: 0.74, to: 1.0, angle: 0.85, length: 0.34,
      radius: 0.56, taper: 0.62, sides: 3,
      levels: 2, split: 2, splitAngle: 0.60, shrink: 0.62, rise: 0.75,
    },
    blobs: { tips: 10, detail: 1, size: [0.15, 0.20], squash: 1.75, warp: 0.14, lift: -0.55, apex: 0.7 },
    bark: [0.36, 0.31, 0.24],
    palettes: [
      [[0.40, 0.58, 0.20], [0.62, 0.78, 0.30]],
      [[0.34, 0.52, 0.22], [0.54, 0.72, 0.30]],
      [[0.46, 0.62, 0.22], [0.70, 0.82, 0.34]],
    ],
    lod: { levels: 1, split: 2, limbs: 0.75, detail: 0, trunkSides: 3 },
  },

  cherry: {
    crown: 'blob',
    trunk: { height: 0.48, radius: 0.040, taper: 0.60, sides: 6, lean: 0.10, bend: 0.28, flare: 1.6 },
    limbs: {
      count: 3, from: 0.74, to: 1.0, angle: 0.75, length: 0.30,
      radius: 0.60, taper: 0.64, sides: 3,
      levels: 2, split: 2, splitAngle: 0.50, shrink: 0.62, rise: 0.36,
    },
    blobs: { tips: 8, detail: 1, size: [0.15, 0.20], squash: 0.78, warp: 0.22, lift: 0.18, apex: 0.6 },
    bark: [0.30, 0.20, 0.18],
    palettes: [
      [[0.92, 0.62, 0.72], [0.99, 0.82, 0.88]],      // sakura pink
      [[0.95, 0.90, 0.92], [1.00, 0.97, 0.98]],      // white blossom
      [[0.86, 0.48, 0.62], [0.97, 0.70, 0.80]],      // deep pink
    ],
    lod: { levels: 1, split: 2, limbs: 0.75, detail: 0, trunkSides: 3 },
  },

  olive: {
    crown: 'blob',
    trunk: { height: 0.40, radius: 0.060, taper: 0.55, sides: 5, lean: 0.22, bend: 0.55, flare: 2.0 },
    limbs: {
      count: 3, from: 0.70, to: 1.0, angle: 0.80, length: 0.32,
      radius: 0.60, taper: 0.62, sides: 3,
      levels: 2, split: 2, splitAngle: 0.48, shrink: 0.62, rise: 0.30,
      capTips: true, capRoots: true,
    },
    blobs: { tips: 7, detail: 1, size: [0.16, 0.21], squash: 0.70, warp: 0.26, lift: 0.14, apex: 0.5, noCull: true },
    bark: [0.42, 0.38, 0.32],
    palettes: [
      [[0.38, 0.44, 0.32], [0.56, 0.62, 0.48]],      // silvery
      [[0.32, 0.40, 0.26], [0.50, 0.58, 0.40]],
      [[0.42, 0.48, 0.36], [0.62, 0.68, 0.54]],
    ],
    lod: { levels: 1, split: 2, limbs: 1, detail: 0, trunkSides: 3 },
  },
};

/* =============================================================== habitat == */

/** @type {Record<string, FoliageKind>} */
export const FOLIAGE = {
  pine: {
    guild: 'conifer',
    height: [14, 26], weight: 1.0, relief: [30, 340], maxSlope: 0.8,
    lateral: [13, 165], rugged: 0.7, wet: -0.2, social: 0.85,
  },
  spruce: {
    guild: 'conifer',
    height: [12, 22], weight: 0.8, relief: [60, 380], maxSlope: 0.85,
    lateral: [13, 165], rugged: 0.9, wet: 0.15, social: 0.9,
  },
  oak: {
    guild: 'warm',
    height: [11, 19], weight: 0.9, relief: [-40, 140], maxSlope: 0.55,
    lateral: [14, 165], rugged: -0.5, wet: 0.1, social: 0.4,
  },
  maple: {
    guild: 'warm',
    height: [12, 20], weight: 0.8, relief: [-50, 240], maxSlope: 0.55,
    lateral: [13, 165], rugged: -0.35, wet: 0.1, social: 0.5,
  },
  birch: {
    // The pale trunk is the woodland's white mass; a high social bias keeps it
    // in real white stands rather than a pale sprinkle. Weight down from 1.7
    // since lore guarantees whole pale regions now.
    guild: 'pale',
    height: [10, 18], weight: 1.25, relief: [-50, 320], maxSlope: 0.7,
    lateral: [13, 165], rugged: 0.1, wet: 0.0, social: 0.75,
  },
  poplar: {
    guild: 'pale',
    height: [15, 25], weight: 0.3, relief: [-40, 130], maxSlope: 0.45,
    lateral: [14, 150], rugged: -0.6, wet: 0.35, social: 0.75,
  },
  aspen: {
    guild: 'pale',
    height: [14, 24], weight: 0.65, relief: [-40, 340], maxSlope: 0.75,
    lateral: [13, 165], rugged: 0.2, wet: -0.1, social: 0.65,
  },
  dead: {
    // Above the treeline; NO GUILD — standing dead belongs in any wood, so the
    // treeline stays a thinning, not a hard edge.
    guild: null,
    height: [7, 14], weight: 0.2, relief: [140, 460], maxSlope: 0.95,
    lateral: [15, 165], rugged: 0.95, wet: -0.5, social: 0.15,
  },
  beech: {
    guild: 'warm',
    height: [14, 24], weight: 0.9, relief: [-40, 220], maxSlope: 0.6,
    lateral: [13, 165], rugged: -0.3, wet: 0.2, social: 0.85,
  },
  fir: {
    guild: 'conifer',
    height: [14, 26], weight: 0.9, relief: [40, 420], maxSlope: 0.85,
    lateral: [13, 165], rugged: 0.8, wet: 0.2, social: 0.9,
  },
  larch: {
    guild: 'conifer',
    height: [12, 22], weight: 0.6, relief: [60, 460], maxSlope: 0.9,
    lateral: [13, 165], rugged: 0.6, wet: 0.0, social: 0.6,
  },
  cypress: {
    guild: 'dry',
    height: [9, 17], weight: 0.9, relief: [-40, 260], maxSlope: 0.7,
    lateral: [12, 165], rugged: 0.2, wet: -0.4, social: 0.5,
  },
  acacia: {
    guild: 'dry',
    height: [6, 11], weight: 1.0, relief: [-40, 240], maxSlope: 0.5,
    lateral: [12, 165], rugged: -0.2, wet: -0.7, social: 0.0,
  },
  willow: {
    guild: 'wet',
    height: [8, 14], weight: 1.0, relief: [-60, 120], maxSlope: 0.45,
    lateral: [13, 165], rugged: -0.6, wet: 0.8, social: 0.3,
  },
  cherry: {
    guild: 'warm',
    height: [6, 10], weight: 0.9, relief: [-40, 200], maxSlope: 0.55,
    lateral: [12, 165], rugged: -0.4, wet: 0.1, social: 0.45,
  },
  olive: {
    guild: 'dry',
    height: [5, 9], weight: 0.9, relief: [-40, 220], maxSlope: 0.6,
    lateral: [12, 165], rugged: 0.1, wet: -0.5, social: 0.2,
  },
};

/**
 * Shrubs: same habitat fields as trees plus `edge`, which weights toward the
 * woodland fringe (`vegetation()`'s EDGE signal). Named SHRUBS not BUSHES so a
 * module importing both need not rename one.
 *
 * `palettes` replace the old single tint: per-variant, baked into geometry —
 * the halfway-to-ground blend desaturated every species to the same pale olive.
 */
export const SHRUBS = {
  bramble: {
    form: 'round', height: [0.9, 1.8], weight: 1.0, relief: [-50, 180],
    maxSlope: 0.9, lateral: [9, 150], wet: 0.3, edge: 1.0,
    palettes: [
      [[0.24, 0.46, 0.20], [0.38, 0.62, 0.27]],
      [[0.19, 0.38, 0.18], [0.31, 0.54, 0.24]],
      [[0.30, 0.52, 0.19], [0.46, 0.68, 0.26]],
    ],
  },
  hazel: {
    form: 'upright', height: [1.9, 3.6], weight: 0.7, relief: [-40, 170],
    maxSlope: 0.7, lateral: [11, 150], wet: 0.25, edge: 0.85,
    palettes: [
      [[0.29, 0.54, 0.22], [0.45, 0.71, 0.30]],
      [[0.35, 0.60, 0.23], [0.53, 0.78, 0.31]],
      [[0.24, 0.47, 0.21], [0.39, 0.64, 0.28]],
    ],
  },
  gorse: {
    form: 'spiky', height: [0.8, 1.7], weight: 0.75, relief: [0, 300],
    maxSlope: 1.1, lateral: [9, 150], wet: -0.55, edge: -0.5,
    palettes: [
      [[0.36, 0.46, 0.15], [0.66, 0.68, 0.18]],
      [[0.42, 0.50, 0.14], [0.78, 0.74, 0.19]],
      [[0.31, 0.41, 0.16], [0.57, 0.60, 0.20]],
    ],
  },
  heather: {
    form: 'low', height: [0.35, 0.8], weight: 0.9, relief: [60, 420],
    maxSlope: 1.2, lateral: [9, 150],     wet: -0.25, edge: -0.85,
    // Dusty, not magenta: saturated purple shot as three flat wrappers; real
    // heather only reads purple in mass and at distance.
    palettes: [
      [[0.36, 0.28, 0.32], [0.52, 0.42, 0.46]],
      [[0.34, 0.31, 0.23], [0.50, 0.47, 0.34]],
      [[0.40, 0.29, 0.27], [0.56, 0.44, 0.40]],
    ],
  },
  fern: {
    form: 'fern', height: [0.6, 1.2], weight: 1.0, relief: [-60, 320],
    maxSlope: 1.0, lateral: [9, 150], wet: 0.5, edge: 0.6,
    palettes: [
      [[0.20, 0.44, 0.16], [0.36, 0.64, 0.22]],
      [[0.26, 0.50, 0.18], [0.44, 0.70, 0.26]],
      [[0.42, 0.42, 0.16], [0.62, 0.56, 0.22]],     // bracken turning
    ],
  },
  juniper: {
    form: 'conical', height: [1.2, 2.8], weight: 0.9, relief: [0, 460],
    maxSlope: 1.2, lateral: [9, 150], wet: -0.3, edge: 0.2,
    palettes: [
      [[0.10, 0.28, 0.18], [0.20, 0.42, 0.26]],
      [[0.14, 0.32, 0.20], [0.26, 0.48, 0.30]],
      [[0.16, 0.30, 0.22], [0.30, 0.46, 0.34]],
    ],
  },
  rosebush: {
    form: 'flower', height: [0.8, 1.5], weight: 0.9, relief: [-50, 200],
    maxSlope: 0.8, lateral: [9, 150], wet: 0.1, edge: 0.7,
    // Third entry: the blossom colour.
    palettes: [
      [[0.18, 0.40, 0.16], [0.30, 0.56, 0.22], [0.86, 0.22, 0.30]],
      [[0.20, 0.42, 0.17], [0.32, 0.58, 0.23], [0.96, 0.62, 0.74]],
      [[0.19, 0.40, 0.16], [0.30, 0.55, 0.22], [0.98, 0.92, 0.70]],
    ],
  },
  lavender: {
    form: 'flower', height: [0.5, 0.9], weight: 0.9, relief: [-40, 260],
    maxSlope: 0.9, lateral: [9, 150], wet: -0.6, edge: -0.4,
    palettes: [
      [[0.36, 0.42, 0.32], [0.50, 0.56, 0.44], [0.56, 0.44, 0.82]],
      [[0.34, 0.40, 0.30], [0.48, 0.54, 0.42], [0.66, 0.50, 0.86]],
      [[0.38, 0.44, 0.33], [0.52, 0.58, 0.46], [0.50, 0.40, 0.76]],
    ],
  },
  boxwood: {
    form: 'dome', height: [0.7, 1.4], weight: 0.8, relief: [-50, 240],
    maxSlope: 0.8, lateral: [9, 150], wet: 0.0, edge: 0.3,
    palettes: [
      [[0.14, 0.36, 0.14], [0.24, 0.50, 0.20]],
      [[0.18, 0.40, 0.16], [0.30, 0.56, 0.22]],
      [[0.12, 0.32, 0.13], [0.22, 0.46, 0.18]],
    ],
  },
  reeds: {
    form: 'reeds', height: [1.4, 2.4], weight: 1.0, relief: [-80, 120],
    maxSlope: 0.5, lateral: [9, 150], wet: 0.9, edge: 0.0,
    palettes: [
      [[0.40, 0.48, 0.20], [0.62, 0.64, 0.30], [0.36, 0.24, 0.14]],
      [[0.46, 0.52, 0.22], [0.70, 0.68, 0.34], [0.40, 0.27, 0.15]],
      [[0.36, 0.44, 0.19], [0.56, 0.60, 0.28], [0.32, 0.22, 0.13]],
    ],
  },
};

/* ================================================================ scatter == */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth01 = (v) => { const t = clamp01(v); return t * t * (3 - 2 * t); };
const band = (v, lo, hi, feather) => {
  // Fade over `feather` so species transition, not a hard line.
  if (v < lo - feather || v > hi + feather) return 0;
  let f = 1;
  if (v < lo) f *= (v - (lo - feather)) / feather;
  if (v > hi) f *= ((hi + feather) - v) / feather;
  return clamp01(f);
};

/**
 * The one evaluation every scatter in the project shares. Called once per
 * candidate point by the tree and bush scatters and once per TERRAIN CELL by
 * the ground cover (hence terrain + world coords, not chunk + road offset).
 *
 * @param {object} [out]  reused record; allocating one per grass cell is tens
 *                        of thousands of objects a chunk
 */
export function vegetation(terrain, x, z, relief, slope, lateral, out = {}) {
  const stand = terrain.forestDensity(x, z);
  const rugged = terrain.region(x, z);

  // ---- the biome blend (biomes.js) and the lakes -------------------------
  let canMul = 1, underMul = 1, grassMul = 1, lone = 0, flowers = 0.04;
  if (BIOME_FN) {
    const B = BIOME_FN.biomeAt(x, z);
    out.biomeA = B.a; out.biomeB = B.b; out.biomeT = B.t;
    canMul = BIOME_FN.mix(B, 'canopy');
    underMul = BIOME_FN.mix(B, 'under');
    grassMul = BIOME_FN.mix(B, 'grass');
    lone = BIOME_FN.mix(B, 'lone');
    flowers = BIOME_FN.mix(B, 'flowers');
  } else {
    out.biomeA = null;
  }
  // `u` is distance from a lake's centre over its shoreline radius: < 1 is water.
  const u = LAKE_FN ? LAKE_FN(x, z) : Infinity;
  const shore = u < 1.6 ? 1 - smooth01((u - 1.0) / 0.6) : 0;
  const water = u < 1.04 ? 1 : 0;

  // Damp ground, 0..1: a slow drifting field plus landform — water collects
  // below the local surface, so a hollow is wet everywhere, for free.
  const wetField = terrain.mask(x, z, 0.00085, 4210, -1180);
  const hollow = clamp01(0.5 - relief / 260);
  const moisture = Math.max(clamp01(wetField * 0.62 + hollow * 0.55), shore);

  // Treeline as a soft ceiling, not a height: too high, steep, exposed, and the
  // three multiply, so a sheltered gully carries woodland higher than an open
  // ridge at the same altitude — the field follows the ground, not a contour.
  const altitude = 1 - Math.pow(clamp01((relief - TREES.treeLine[0]) /
    Math.max(1, TREES.treeLine[1] - TREES.treeLine[0])), 1.4);
  const steep = 1 - clamp01((slope - 0.35) / 0.75);
  // Moisture still thins the wood, but the biome already decided what grows
  // here — savanna is dry BY DEFINITION and must not be emptied for it.
  const dry = 0.62 + 0.38 * moisture;

  // Canopy: squaring the stand mask sharpens edges (a clearing must be empty);
  // `standBias` scales it back so squaring costs contrast, not coverage. The
  // biome scales it, and a `lone` biome (savanna, meadow) trades stands for a
  // thin even scatter of single trees — what open country actually looks like.
  const standed = stand * stand * TREES.standBias;
  const scattered = 0.16 + 0.10 * stand;
  let canopy = clamp01((standed * (1 - lone) + scattered * lone) * canMul * altitude * steep * dry);
  canopy *= 1 - water;
  canopy *= 1 - 0.6 * shore * (1 - (out.biomeA === 'wetland' ? 1 : 0));
  // Nothing grows on the carriageway or shoulder; the fade prevents a tree
  // appearing to sprout out of the verge.
  canopy *= clamp01((lateral - CHUNK.plantClear) / 8);

  // THE EDGE, `4c(1 - c)`: peaks at half-closed canopy — the woodland fringe.
  const edge = clamp01(4 * canopy * (1 - canopy));

  // Understorey: the fringe, plus open scrub where it is too dry or high for
  // trees but not yet bare rock.
  const openScrub = clamp01((1 - canopy) * clamp01((0.72 - moisture) / 0.42) *
    clamp01(1 - (relief - TREES.treeLine[1]) / 260));
  const understorey = clamp01((edge * 0.9 + openScrub * 0.5) * underMul + shore * 0.6) *
    clamp01((lateral - CHUNK.plantClear) / 6) * (1 - water);

  // Ground cover — the field the player most looks at. Three things take grass
  // away, as in a real field: /SHADE/ a closed canopy is litter, not sward
  // (kept at `shadeFloor` so a dark wood has something growing); /DROUGHT/ dry
  // ground goes patchy before bare; /PATCHES/ a fine field thins sward into
  // bald ground — without it a meadow is an unreal uniform carpet.
  const shade = 1 - canopy * (1 - TREES.shadeFloor);
  const patch = terrain.mask(x, z, 0.0135, -733, 611);
  const patchy = clamp01((patch - TREES.barePatch[0]) /
    Math.max(0.01, TREES.barePatch[1] - TREES.barePatch[0]));
  const ground = clamp01(
    (0.62 + 0.38 * moisture) * shade * patchy * (1 - clamp01((slope - 0.9) / 0.8)) * grassMul
  ) * (u < 0.98 ? 0 : 1);
  out.flowers = flowers * (1 - shore * 0.5);
  out.canMul = canMul;
  out.shore = shore;
  out.lake = u;

  // THE GUILD FIELD — what KIND of wood. A stand mask says how much canopy,
  // nothing about what it is made of; independent draws put a dark pine inside
  // a bright birch wood. One slow field, three overlapping bands; noise gives
  // the patchwork, the terrain SHIFTS where a place sits (conifers climb, warm
  // broadleaves keep to damp lowlands) without being a separate rule. Bands
  // touch, and a genuinely mixed wood is where two score partially.
  // Stretched against the field's MEASURED range (p05..p95 0.367..0.631), not
  // 0..1: two fBm octaves never reach the ends, and raw the whole world sat in
  // the middle band — neighbouring trees agreed 83% of the time, ~chance.
  const kind = clamp01((terrain.mask(x, z, 0.0011, 8123, -4410) - 0.367) / 0.264);
  const high = clamp01((relief - 40) / 240);
  const axis = clamp01(kind + (high * 0.30 + rugged * 0.22) - moisture * 0.18 - 0.10);
  out.gWarm = band(axis, 0.00, 0.26, 0.12);
  out.gPale = band(axis, 0.38, 0.62, 0.12);
  out.gConifer = band(axis, 0.74, 1.00, 0.12);

  // WOODLAND FLOOR: shade-tolerant grass opposite of `ground`, which is thinned
  // BY shade. A closed wood is not meadow sward but carries tall soft stuff in
  // the gaps; damp ground carries more of it.
  out.floor = clamp01(canopy * 1.25) * (0.40 + 0.60 * moisture) *
    clamp01((lateral - CHUNK.plantClear) / 8);

  out.canopy = canopy;
  out.understorey = understorey;
  out.ground = ground;
  out.edge = edge;
  out.moisture = moisture;
  out.rugged = rugged;
  out.stand = stand;
  return out;
}

/**
 * How much the biome at this point wants a species, 0..1 — the blend of the
 * two biomes' normalised weights. A species absent from both is 0.
 */
export function biomeAffinity(kind, field) {
  const A = BIOMES[field.biomeA], B = BIOMES[field.biomeB];
  const table = kind.type === 'shrub' ? 'shrubW' : 'treeW';
  const wa = (A && A[table][kind.name]) || 0;
  const wb = (B && B[table][kind.name]) || 0;
  const t = field.biomeT || 0;
  let w = wa * (1 - t) + wb * t;
  // Wet-ground species are drawn to a shore whatever the biome says.
  if (kind.wet > 0.6) w = Math.max(w, (field.shore || 0) * 0.9);
  return w;
}

/** A species' affinity for the place, 0..1: the biome where there is one, else the old guild field. */
export function guildAffinity(kind, field) {
  if (field.biomeA) return biomeAffinity(kind, field);
  if (!kind.guild) return 1;
  if (kind.guild === 'conifer') return field.gConifer;
  if (kind.guild === 'pale') return field.gPale;
  return field.gWarm;
}

export function suitability(kind, field, relief, slope, lateral) {
  if (slope > kind.maxSlope) return 0;
  if (lateral < kind.lateral[0] || lateral > kind.lateral[1]) return 0;

  const span = kind.relief[1] - kind.relief[0];
  let f = band(relief, kind.relief[0], kind.relief[1], span * 0.25);
  if (f <= 0) return 0;

  if (kind.rugged) {
    const want = kind.rugged > 0 ? field.rugged : 1 - field.rugged;
    f *= 1 - Math.abs(kind.rugged) * (1 - want);
  }
  if (kind.wet) {
    const want = kind.wet > 0 ? field.moisture : 1 - field.moisture;
    f *= 1 - Math.abs(kind.wet) * (1 - want);
  }
  if (kind.edge) {
    const want = kind.edge > 0 ? field.edge : 1 - field.edge;
    f *= 1 - Math.abs(kind.edge) * 0.8 * (1 - want);
  }
  // `social` species score poorly outside a stand — no lone spruce in a meadow.
  if (kind.social) {
    f *= 1 - kind.social * (1 - clamp01(field.stand * 1.35));
  }

  // The biome (or, with none wired in, the guild): a hard floor — 2-4% off
  // the table, not zero — so a wood is one kind with the odd outlier. Soft
  // was tried first: at 30% off-guild every second birch stand holds a dark
  // conifer, which is exactly what reads as wrong.
  f *= field.biomeA ? 0.02 + 0.98 * biomeAffinity(kind, field)
                    : 0.04 + 0.96 * guildAffinity(kind, field);
  return Math.max(0, f);
}

// An InstancedMesh exists per (chunk, geometry), so each chunk commits up front
// to `TREES.picks` species, one variant each, seeded from its index: a reloaded
// chunk is identical, neighbours differ, the world still shows the whole table.
export const TREE_NAMES = Object.keys(FOLIAGE);
export const SHRUB_NAMES = Object.keys(SHRUBS);
for (const n of TREE_NAMES) { FOLIAGE[n].name = n; FOLIAGE[n].type = 'tree'; }
for (const n of SHRUB_NAMES) { SHRUBS[n].name = n; SHRUBS[n].type = 'shrub'; }
