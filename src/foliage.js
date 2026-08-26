/**
 * foliage.js — what grows, what it looks like, and where it belongs.
 *
 * ONE TABLE FOR BOTH HALVES OF A SPECIES, and that is the change this file has
 * just been through. It used to hold ecology only — altitude bands, slope
 * limits, which OBJ files to load — because the shapes lived in an asset pack.
 * The shapes are now grown from code (`env/trees.js`, `env/bushes.js`), and a
 * pine's form and a pine's habitat are two facts about the same thing. Keeping
 * them in different files is how a species ends up narrow, dark and needled in
 * one place and a lowland broadleaf in the other.
 *
 * The split that DOES survive is the one `src/env/README.md` describes:
 *
 *   this file    what a species is — its form parameters and its habitat
 *   env/trees.js how to turn form parameters into triangles
 *   chunks.js    where the things actually go
 *
 * `chunks.js` is the only one of the three that needs the road, the terrain
 * sheet and the streaming window, which is why placement lives there and why
 * `probe/props.mjs` can exercise the whole scatter with no canvas and no GL.
 *
 * ── the ecology, and why it is one field rather than three ──────────────────
 *
 * The old scatter placed trees on a stand mask and then placed grass, entirely
 * separately, over every square metre of ground that was not too steep. So a
 * clearing had full grass and a thicket had full grass, the two never agreed
 * about anything, and the verge read as a lawn with objects standing on it.
 *
 * `vegetation()` below is the fix and it is the centre of this file: ONE
 * evaluation returns the canopy, understorey and ground-cover densities at a
 * point, derived from the same handful of terrain signals, so they cannot
 * disagree. Grass thins where the canopy closes over it because it is told to
 * by the same number that put the canopy there.
 *
 * Four signals do the work, and each is a real thing about real vegetation:
 *
 *   STAND       `terrain.forestDensity` — two scales of noise multiplied, so
 *               woodland has stands a few hundred metres across with clearings
 *               broken through them rather than being a uniform wash.
*   MOISTURE    a slow field, biased wet in the hollows: relief below the local
   *               continental surface is where water goes. It is what separates
   *               a birch from a pine and lush verge from dry scrub.
 *   RELIEF      height above local sea level, not absolute height. 400 m is a
 *               summit in one place and a valley floor two hundred kilometres
 *               away; a treeline keyed to the absolute number puts bare rock in
 *               a lowland field.
 *   EXPOSURE    slope, and the region mask from `noise.js` — how mountainous
 *               this part of the world is at all.
 *
 * And one derived signal that is worth naming because it does more for the look
 * than any of the four:
 *
 *   EDGE        `4c(1 - c)` on the canopy density. It peaks where the canopy is
 *               half closed — which is the woodland edge, and in real ecology
 *               the edge is where the scrub is: more light than the forest
 *               floor, more shelter than the open field. Hanging the bushes on
 *               it means a wood gets a fringe automatically, and a fringe is
 *               most of what makes a tree line stop looking like a wall.
 */

import { CHUNK, TREES } from './config.js';

/* ================================================================= forms == */

/**
 * How each species is BUILT. Consumed by `env/trees.js:growTree`; see that
 * file's header for what the parameters mean mechanically.
 *
 * The eight are chosen to be distinguishable AT DISTANCE, which is a stronger
 * requirement than being different up close. Silhouette first: a narrow spire,
 * a broad dome, a slim pale column, a bare armature. Two species that differ
 * only in leaf shape are one species with extra draw calls.
 *
 * `bark` and `leaf` are the vertex hues the grey atlas is multiplied by, and
 * the reason a birch is a birch at fifty metres.
 */
export const TREE_FORMS = {
  /**
   * PINE — a bare trunk with the crown pushed to the top of it.
   *
   * The clear stem is the whole silhouette: in a stand, pines self-prune their
   * lower limbs and what you see from the road is fifty trunks and a ceiling.
   * `branches[0].start` at 0.62 is that fact, and it is why a pine wood looks
   * like a pine wood rather than like a Christmas tree farm.
   */
  pine: {
    levels: 2,
    sections: 4,
    segments: 5,
    segmentDrop: 2,
    trunk: { length: 1.0, radius: 0.048, lean: 0.10 },
    branches: [
      { count: 9, angle: 1.22, start: 0.46, length: 0.40, radius: 0.36, tipShrink: 0.6, leafy: true },
      { count: 3, angle: 0.85, start: 0.35, length: 0.55, radius: 0.5, tipShrink: 0.3, leafy: false },
    ],
    gnarliness: 0.22,
    taper: 0.42,
    growth: { dir: { x: 0, y: 0.55, z: 0 }, strength: 0.9 },
    minRadius: 0.004,
    maxBranches: 26,
    leafSize: 0.46,
    leafFalloff: 0.82,
    leafDrop: 0.10,
    cards: 3,
    leafCell: 'needle',
    bark: [0.34, 0.24, 0.18],
    leaf: [0.20, 0.34, 0.21],
    impostor: {
      crownBase: 0.34, trunkWidth: 0.020,
      blobs: 40, blobSize: 0.070, blobSquash: 0.8, bias: 0.85,
      // Narrow cone: wide at the bottom of the crown, a spire at the top.
      profile: (t) => 0.56 * (1 - t) + 0.04,
    },
  },

  /**
   * SPRUCE — the same conifer idea carried all the way to the ground.
   *
   * Branches from low on the stem, held up by a gentle upward `growth.dir.y`
   * (0.18) that converges the crown into a cone while the low, long limbs keep
   * their skirt — the number is positive but small, so heavy outer branches
   * still hang. (It drifted to -0.25 at one point and the whole crown slumped
   * into a bush: the branching angle 1.45 leaves the trunk almost horizontal,
   * so the tree's verticality comes entirely from this vector.) Standing next
   * to a pine it is the contrast that makes both of them legible.
   */
  spruce: {
    levels: 2,
    sections: 4,
    segments: 5,
    segmentDrop: 2,
    trunk: { length: 1.0, radius: 0.042, lean: 0.05 },
    branches: [
      { count: 13, angle: 1.15, start: 0.12, length: 0.40, radius: 0.30, tipShrink: 0.72, leafy: true },
      { count: 2, angle: 0.9, start: 0.4, length: 0.5, radius: 0.5, tipShrink: 0.3, leafy: false },
    ],
    gnarliness: 0.16,
    taper: 0.36,
    growth: { dir: { x: 0, y: 0.18, z: 0 }, strength: 0.85 },
    minRadius: 0.004,
    maxBranches: 30,
    leafSize: 0.40,
    leafFalloff: 0.80,
    leafDrop: 0.14,
    cards: 3,
    leafCell: 'needle',
    bark: [0.28, 0.21, 0.17],
    leaf: [0.15, 0.28, 0.19],
    impostor: {
      crownBase: 0.08, trunkWidth: 0.016,
      blobs: 50, blobSize: 0.068, blobSquash: 0.78, bias: 0.9,
      profile: (t) => 0.62 * (1 - t * 0.94) + 0.03,
    },
  },

  /**
   * OAK — short thick stem, hard fork, wide dome.
   *
   * `branches[0].angle` at 1.05 rad with only three children is what makes the
   * fork read: a broadleaf's structure is a few heavy limbs leaving the trunk
   * at once, not a spiral of small ones. Leaf mass is carried on the limbs as
   * well as the tips (`leafy`), without which a wide crown is a bare frame with
   * pom-poms on the ends of it.
   */
  oak: {
    levels: 3,
    sections: 4,
    segments: 6,
    segmentDrop: 2,
    trunk: { length: 0.55, radius: 0.062, lean: 0.16 },
    branches: [
      { count: 3, angle: 1.05, start: 0.55, length: 0.86, radius: 0.62, tipShrink: 0.2, leafy: false },
      { count: 3, angle: 0.86, start: 0.35, length: 0.78, radius: 0.62, tipShrink: 0.25, leafy: true },
      { count: 2, angle: 0.75, start: 0.3, length: 0.7, radius: 0.6, tipShrink: 0.3, leafy: false },
    ],
    gnarliness: 0.62,
    taper: 0.52,
    growth: { dir: { x: 0, y: 0.35, z: 0 }, strength: 0.55 },
    minRadius: 0.005,
    maxBranches: 24,
    leafSize: 0.52,
    leafFalloff: 0.84,
    leafDrop: 0.06,
    cards: 3,
    leafCell: 'broadleaf',
    bark: [0.35, 0.29, 0.22],
    leaf: [0.28, 0.40, 0.20],
    impostor: {
      crownBase: 0.30, trunkWidth: 0.030,
      blobs: 40, blobSize: 0.115, blobSquash: 0.9, bias: 0.55,
      // A dome: widest a third of the way up, closing over the top.
      profile: (t) => 0.86 * Math.sin(Math.PI * (0.22 + t * 0.72)) * 0.9,
    },
  },

  /**
   * MAPLE — an autumn broadleaf: a dense round crown on a stout stem.
   *
   * The silhouette keeps the heavy central fork of a broadleaf but spends it
   * on a fuller, rounder head — closer to a ball than an oak's wide-open dome.
   * At distance what separates it from every other tree in the table is that
   * it is not green: the warm red-orange is what makes the pale trunks beside
   * it read as pale.
   */
  maple: {
    levels: 3,
    sections: 4,
    segments: 6,
    segmentDrop: 2,
    trunk: { length: 0.6, radius: 0.058, lean: 0.14 },
    branches: [
      { count: 3, angle: 0.92, start: 0.5, length: 0.82, radius: 0.62, tipShrink: 0.25, leafy: false },
      { count: 3, angle: 0.78, start: 0.33, length: 0.76, radius: 0.6, tipShrink: 0.3, leafy: true },
      { count: 2, angle: 0.7, start: 0.28, length: 0.66, radius: 0.55, tipShrink: 0.35, leafy: false },
    ],
    gnarliness: 0.55,
    taper: 0.5,
    growth: { dir: { x: 0, y: 0.4, z: 0 }, strength: 0.6 },
    minRadius: 0.005,
    maxBranches: 26,
    leafSize: 0.52,
    leafFalloff: 0.84,
    leafDrop: 0.08,
    cards: 3,
    leafCell: 'broadleaf',
    bark: [0.36, 0.29, 0.23],
    leaf: [0.76, 0.25, 0.09],
    impostor: {
      crownBase: 0.38, trunkWidth: 0.026,
      blobs: 44, blobSize: 0.105, blobSquash: 0.92, bias: 0.6,
      // A full round crown, widest a third up and staying wide to the top.
      profile: (t) => 0.84 * Math.sin(Math.PI * (0.12 + t * 0.76)),
    },
  },

  /**
   * BIRCH — slender, pale, and high-crowned.
   *
   * The bark colour is doing most of the work here and it is worth being honest
   * about that: at any distance where the crown is a few pixels, a birch wood
   * is white verticals against dark ground, and that is the whole read. The
   * crown is kept a pale yellow-green rather than a hard green so the wood
   * reads light from a distance — a mass of pale birch reads as a pale mass.
   */
  birch: {
    levels: 2,
    sections: 4,
    segments: 5,
    segmentDrop: 2,
    trunk: { length: 0.9, radius: 0.028, lean: 0.22 },
    branches: [
      { count: 6, angle: 0.76, start: 0.40, length: 0.56, radius: 0.5, tipShrink: 0.35, leafy: true },
      { count: 3, angle: 0.62, start: 0.3, length: 0.62, radius: 0.55, tipShrink: 0.3, leafy: true },
    ],
    gnarliness: 0.5,
    taper: 0.4,
    growth: { dir: { x: 0, y: 0.5, z: 0 }, strength: 0.8 },
    minRadius: 0.0035,
    maxBranches: 24,
    leafSize: 0.42,
    leafFalloff: 0.84,
    leafDrop: 0.09,
    cards: 3,
    leafCell: 'broadleaf',
    bark: [0.93, 0.92, 0.87],
    leaf: [0.64, 0.68, 0.44],
    impostor: {
      crownBase: 0.42, trunkWidth: 0.014,
      blobs: 32, blobSize: 0.085, blobSquash: 0.95, bias: 0.6,
      profile: (t) => 0.66 * Math.sin(Math.PI * (0.28 + t * 0.68)),
    },
  },

  /**
   * POPLAR — a column. The cheapest possible silhouette contrast.
   *
   * Children leave the trunk at 0.32 rad, which is barely off vertical, so the
   * whole tree is taller than it is wide by a factor of five. One of these in a
   * hedgerow is worth more to a horizon than ten more oaks.
   */
  poplar: {
    levels: 2,
    sections: 4,
    segments: 5,
    segmentDrop: 2,
    trunk: { length: 1.25, radius: 0.032, lean: 0.06 },
    branches: [
      { count: 11, angle: 0.42, start: 0.18, length: 0.46, radius: 0.42, tipShrink: 0.5, leafy: true },
      { count: 2, angle: 0.3, start: 0.3, length: 0.5, radius: 0.5, tipShrink: 0.3, leafy: true },
    ],
    gnarliness: 0.3,
    taper: 0.38,
    growth: { dir: { x: 0, y: 1.0, z: 0 }, strength: 1.0 },
    minRadius: 0.0035,
    maxBranches: 26,
    leafSize: 0.36,
    leafFalloff: 0.86,
    leafDrop: 0.05,
    cards: 3,
    leafCell: 'broadleaf',
    bark: [0.42, 0.38, 0.30],
    leaf: [0.33, 0.44, 0.22],
    impostor: {
      crownBase: 0.16, trunkWidth: 0.015,
      blobs: 36, blobSize: 0.068, blobSquash: 1.15, bias: 0.5,
      profile: (t) => 0.34 * Math.sin(Math.PI * (0.15 + t * 0.8)),
    },
  },

  /**
   * ASPEN — a pale golden stand tree, the birch's up-country sibling.
   *
   * Same trick as the birch — a light trunk doing the legibility work at
   * distance — but a taller, slimmer egg of bright yellow foliage, so the two
   * reads differ before the colour even resolves. Colonises coarser, sunnier
   * ground than birch tolerates.
   */
  aspen: {
    levels: 2,
    sections: 4,
    segments: 5,
    segmentDrop: 2,
    trunk: { length: 1.1, radius: 0.03, lean: 0.12 },
    branches: [
      { count: 8, angle: 0.55, start: 0.22, length: 0.55, radius: 0.5, tipShrink: 0.4, leafy: true },
      { count: 2, angle: 0.45, start: 0.3, length: 0.6, radius: 0.55, tipShrink: 0.3, leafy: true },
    ],
    gnarliness: 0.32,
    taper: 0.4,
    growth: { dir: { x: 0, y: 0.9, z: 0 }, strength: 1.0 },
    minRadius: 0.0035,
    maxBranches: 26,
    leafSize: 0.34,
    leafFalloff: 0.86,
    leafDrop: 0.06,
    cards: 3,
    leafCell: 'broadleaf',
    bark: [0.80, 0.78, 0.70],
    leaf: [0.86, 0.64, 0.12],
    impostor: {
      crownBase: 0.30, trunkWidth: 0.014,
      blobs: 40, blobSize: 0.07, blobSquash: 1.0, bias: 0.55,
      // A tall slim egg: widest mid-crown, closed at both ends.
      profile: (t) => 0.54 * Math.sin(Math.PI * t),
    },
  },

  /**
   * DEAD — bare wood, and the cheapest thing in the table at roughly a third
   * the triangles of an oak, because it carries almost no leaf mass.
   *
   * It earns its place by being the only species that survives above the tree
   * line, so the transition out of woodland is a thinning of standing dead
   * timber rather than a hard edge into bare rock.
   */
  dead: {
    levels: 3,
    sections: 4,
    segments: 5,
    segmentDrop: 2,
    trunk: { length: 0.7, radius: 0.05, lean: 0.3 },
    branches: [
      { count: 3, angle: 1.15, start: 0.4, length: 0.72, radius: 0.55, tipShrink: 0.3, leafy: false },
      { count: 3, angle: 1.0, start: 0.25, length: 0.62, radius: 0.5, tipShrink: 0.35, leafy: false },
      { count: 2, angle: 0.9, start: 0.2, length: 0.55, radius: 0.45, tipShrink: 0.4, leafy: false },
    ],
    gnarliness: 0.85,
    taper: 0.4,
    growth: { dir: { x: 0.2, y: 0.3, z: -0.1 }, strength: 0.5 },
    minRadius: 0.005,
    maxBranches: 22,
    leafSize: 0.22,
    leafFalloff: 0.8,
    leafDrop: 0.0,
    cards: 2,
    leafCell: 'twig',
    bark: [0.46, 0.42, 0.36],
    leaf: [0.44, 0.40, 0.33],
    impostor: {
      crownBase: 0.38, trunkWidth: 0.022,
      blobs: 18, blobSize: 0.048, blobSquash: 0.9, bias: 0.6,
      profile: (t) => 0.5 * Math.sin(Math.PI * (0.2 + t * 0.7)),
    },
  },
};

/* =============================================================== habitat == */

/**
 * @typedef {object} FoliageKind
 * @property {[number, number]} height   metres, min..max
 * @property {number} weight             relative abundance
 * @property {[number, number]} relief   height above LOCAL sea level it will grow at
 * @property {number} maxSlope           steepest ground it holds on (rise/run)
 * @property {[number, number]} lateral  how far from the road it may appear
 * @property {number} [rugged]           >0 favours mountains, <0 favours lowland
 * @property {number} [wet]              >0 wants damp ground, <0 wants dry
 * @property {number} [social]           0 = happy alone, 1 = only ever in stands
 */

/** @type {Record<string, FoliageKind>} */
export const FOLIAGE = {
  pine: {
    height: [14, 26], weight: 1.0, relief: [30, 340], maxSlope: 0.8,
    lateral: [13, 165], rugged: 0.7, wet: -0.2, social: 0.85,
  },
  spruce: {
    height: [12, 22], weight: 0.8, relief: [60, 380], maxSlope: 0.85,
    lateral: [13, 165], rugged: 0.9, wet: 0.15, social: 0.9,
  },
  oak: {
    height: [11, 19], weight: 0.9, relief: [-40, 140], maxSlope: 0.55,
    lateral: [14, 165], rugged: -0.5, wet: 0.1, social: 0.4,
  },
  maple: {
    // Warm-leaved broadleaf of settled mid ground, climbing out of the lowland.
    height: [12, 20], weight: 0.8, relief: [-50, 240], maxSlope: 0.55,
    lateral: [13, 165], rugged: -0.35, wet: 0.1, social: 0.5,
  },
  birch: {
    // The pale trunk is the woodland's white mass: the commonest tree mid-slope
    // and the most abundant pale one anywhere, so a birch wood reads everywhere.
    // A high social bias keeps it clustering into real white stands rather than
    // scattering as a pale sprinkle between everything else.
    height: [10, 18], weight: 1.7, relief: [-50, 320], maxSlope: 0.7,
    lateral: [13, 165], rugged: 0.1, wet: 0.0, social: 0.75,
  },
  poplar: {
    height: [15, 25], weight: 0.3, relief: [-40, 130], maxSlope: 0.45,
    lateral: [14, 150], rugged: -0.6, wet: 0.35, social: 0.75,
  },
  aspen: {
    // Pale coloniser of higher, drier, steeper ground than birch cares for.
    height: [14, 24], weight: 0.65, relief: [-40, 340], maxSlope: 0.75,
    lateral: [13, 165], rugged: 0.2, wet: -0.1, social: 0.65,
  },
  dead: {
    // Survives higher than anything living — the last thing before bare rock.
    height: [7, 14], weight: 0.2, relief: [140, 460], maxSlope: 0.95,
    lateral: [15, 165], rugged: 0.95, wet: -0.5, social: 0.15,
  },
};

/**
 * Shrubs. Four forms, built by `env/bushes.js`; the same habitat fields as the
 * trees plus `edge`, which is the one thing that separates them.
 *
 * Named `SHRUBS` and not `BUSHES` on purpose: `BUSHES` is the config block, and
 * a module importing both would have to rename one of them at every call site.
 *
 * `edge` weights a species toward the woodland fringe — see `vegetation()`'s
 * EDGE signal. Bramble and hazel live there; gorse and heather are open-ground
 * plants and score highest where the canopy has given up entirely.
 */
export const SHRUBS = {
  bramble: {
    form: 'round', height: [0.9, 1.8], weight: 1.0, relief: [-50, 180],
    maxSlope: 0.9, lateral: [9, 150], wet: 0.3, edge: 1.0, tint: [0.30, 0.38, 0.20],
  },
  hazel: {
    form: 'upright', height: [1.9, 3.6], weight: 0.7, relief: [-40, 170],
    maxSlope: 0.7, lateral: [11, 150], wet: 0.25, edge: 0.85, tint: [0.32, 0.42, 0.22],
  },
  gorse: {
    form: 'spiky', height: [0.8, 1.7], weight: 0.75, relief: [0, 300],
    maxSlope: 1.1, lateral: [9, 150], wet: -0.55, edge: -0.5, tint: [0.38, 0.40, 0.17],
  },
  heather: {
    form: 'low', height: [0.35, 0.8], weight: 0.9, relief: [60, 420],
    maxSlope: 1.2, lateral: [9, 150], wet: -0.25, edge: -0.85, tint: [0.36, 0.31, 0.30],
  },
};

/* ================================================================ scatter == */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const band = (v, lo, hi, feather) => {
  // Fade in and out over `feather` rather than cutting, so species transition
  // into one another up a hillside instead of stopping in a line.
  if (v < lo - feather || v > hi + feather) return 0;
  let f = 1;
  if (v < lo) f *= (v - (lo - feather)) / feather;
  if (v > hi) f *= ((hi + feather) - v) / feather;
  return clamp01(f);
};

/**
 * The one evaluation every scatter in the project shares.
 *
 * Called once per candidate point by the tree and bush scatters, and once per
 * TERRAIN CELL by the ground cover — which is why it takes a terrain and two
 * world coordinates rather than a chunk and a road offset. It knows nothing
 * about the road except how far away it is.
 *
 * @param {object} terrain     from `noise.js:createTerrain`
 * @param {number} x,z         world position
 * @param {number} relief      height above the local continental surface
 * @param {number} slope       rise/run of the ground here
 * @param {number} lateral     distance from the road centreline
 * @param {object} [out]       reused record; allocating one per grass cell is
 *                             tens of thousands of objects a chunk
 */
export function vegetation(terrain, x, z, relief, slope, lateral, out = {}) {
  const stand = terrain.forestDensity(x, z);
  const rugged = terrain.region(x, z);

  /**
   * Damp ground, 0..1. Two terms: a slow field that drifts over kilometres,
   * and the landform itself — water collects below the local surface, so a
   * hollow is wet and a shoulder is not, everywhere, for free.
   */
  const wetField = terrain.mask(x, z, 0.00085, 4210, -1180);
  const hollow = clamp01(0.5 - relief / 260);
  const moisture = clamp01(wetField * 0.62 + hollow * 0.55);

  /**
   * The tree line, as a soft ceiling rather than a height.
   *
   * Trees stop where it is too high, too steep and too exposed, and the three
   * multiply: a sheltered gully carries woodland further up than an open ridge
   * beside it at the same altitude, which is the thing that makes a treeline
   * follow the ground instead of contouring round it like a bathtub ring.
   */
  const altitude = 1 - Math.pow(clamp01((relief - TREES.treeLine[0]) /
    Math.max(1, TREES.treeLine[1] - TREES.treeLine[0])), 1.4);
  const steep = 1 - clamp01((slope - 0.35) / 0.75);
  const dry = 0.35 + 0.65 * moisture;

  /**
   * Canopy density. Squaring the stand mask sharpens its edges — a wood needs
   * a boundary and a clearing needs to be empty — and `TREES.standBias` scales
   * the result back up so squaring costs coverage rather than only contrast.
   */
  let canopy = clamp01(stand * stand * TREES.standBias * altitude * steep * dry);
  // Nothing grows on the carriageway or its shoulder, and the fade outward
  // keeps a tree from ever appearing to sprout out of the verge.
  canopy *= clamp01((lateral - CHUNK.plantClear) / 8);

  /**
   * THE EDGE. Peaks at half-closed canopy, which is the woodland fringe.
   * Everything scrubby hangs off this; see the file header.
   */
  const edge = clamp01(4 * canopy * (1 - canopy));

  /**
   * Understorey: the fringe, plus open scrub where the ground is too dry or too
   * high for trees but not yet bare rock.
   */
  const openScrub = clamp01((1 - canopy) * clamp01((0.72 - moisture) / 0.42) *
    clamp01(1 - (relief - TREES.treeLine[1]) / 260));
  const understorey = clamp01(edge * 0.9 + openScrub * 0.5) *
    clamp01((lateral - CHUNK.plantClear) / 6);

  /**
   * Ground cover, and this is the part of the field the player spends the most
   * time looking at.
   *
   * Three things take grass away, and they are the three that take it away in
   * a real field:
   *
   *   SHADE     a closed canopy has litter under it, not sward. Full shade is
   *             `TREES.shadeFloor` of the open-ground density, not zero: even
   *             a dark wood has something growing in it, and a hard zero draws
   *             the stand's own outline on the ground in bare earth.
   *   DROUGHT   dry ground goes patchy before it goes bare.
   *   PATCHES   a fine field, tens of metres across, that thins the sward into
   *             bald ground independently of everything else. Without it a
   *             meadow is a uniform carpet, which is the single most artificial
   *             thing a procedural verge can do — real grassland is mottled at
   *             a scale you can see from a car.
   */
  const shade = 1 - canopy * (1 - TREES.shadeFloor);
  const patch = terrain.mask(x, z, 0.0135, -733, 611);
  const patchy = clamp01((patch - TREES.barePatch[0]) /
    Math.max(0.01, TREES.barePatch[1] - TREES.barePatch[0]));
  const ground = clamp01(
    (0.62 + 0.38 * moisture) * shade * patchy * (1 - clamp01((slope - 0.9) / 0.8))
  );

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
 * Suitability of one species for a point, 0..1, multiplied by its weight to
 * form the sampling distribution. Zero means "never here".
 *
 * `field` is a record from `vegetation()`; `relief`, `slope` and `lateral` are
 * the same numbers that produced it.
 */
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
  // `social` species score poorly outside a stand, which is what stops a lone
  // spruce turning up in the middle of a meadow.
  if (kind.social) {
    f *= 1 - kind.social * (1 - clamp01(field.stand * 1.35));
  }

  // Thin out as the ground steepens, well before the hard cutoff.
  f *= 1 - Math.min(1, slope / kind.maxSlope) * 0.5;
  return Math.max(0, f);
}

/**
 * Which species a chunk may draw, and how many draw calls that costs.
 *
 * An InstancedMesh exists per (chunk, geometry), so letting every species and
 * every variant appear everywhere costs a draw call each before a single tree
 * is shaded. Each chunk therefore commits up front to `TREES.picks` species and
 * one variant of each, seeded from its own index — so a chunk unloaded and
 * reloaded comes back identical, neighbouring chunks draw different things, and
 * the world at large still shows the whole table.
 */
export const TREE_NAMES = Object.keys(FOLIAGE);
export const SHRUB_NAMES = Object.keys(SHRUBS);
