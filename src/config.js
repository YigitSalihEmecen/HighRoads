/**
 * config.js — the single set of tunables.
 *
 * All units are SI. The vehicle values favour a forgiving cruiser over a hard
 * simulator.
 */

export const WORLD = {
  seed: 'highroads-01',

  /** Gravity, m/s². Slightly over Earth. */
  gravity: -16.0,

  /** Fixed 120 Hz physics clock, decoupled from the render loop. */
  fixedStep: 1 / 120,
  /** Frame-time ceiling: `maxSubSteps * fixedStep` = 50 ms. `main.js` clamps `dt` to this. */
  maxSubSteps: 6,
};

export const ROAD = {
  /** Spacing between spline control points, metres. */
  ctrlSpacing: 46,
  /** Arc-length sample spacing, metres (lookup-table resolution). */
  sampleStep: 2.5,

  /** Lane width, metres — sized off the 3.28 m Military Vehicle. */
  laneWidth: 3.7,
  /** Lanes each way, and the half-width they make (`TERRAIN.lanes` sets both). */
  lanesPerSide: 2,
  halfWidth: 7.4,
  /** Painted line width, and the gap between the two centre lines. */
  lineWidth: 0.2,
  centreGap: 0.16,
  /** The edge line stands this far in from the asphalt's edge. */
  edgeInset: 0.25,
  /** Paved shoulder beyond the lane markings, metres. */
  shoulder: 2.0,

  /** Peak curvature, 1/m — keeps the minimum radius above ~165 m. */
  maxCurvature: 1 / 165,
  /** How fast curvature itself may change (noise frequency). */
  curveFreq: 0.055,

  /** Max road gradient (rise over run) — 9.5%. */
  maxGrade: 0.095,
  /** Max change in gradient per control point, keeps vertical acceleration bounded. */
  maxGradeChange: 0.05,
  /** Elevation smoothing applied to control points (0 = follow terrain exactly). */
  elevationSmoothing: 0.55,

  /** Banking: bank = curvature * bankGain, clamped. */
  bankGain: 35,
  maxBank: 0.075,

  /** Cut-and-fill plane slopes (rise over run); cut steeper than fill. */
  cutSlope: 0.62,
  fillSlope: 0.5,
  /** Rounding radius where the cut/fill ramp leaves the verge, metres. */
  shoulderRound: 14,
  /** Smoothing window where the ramp meets the natural surface, metres. */
  slopeBlend: 3.5,

  /** Centre line: metres painted, then the same again unpainted. */
  dashLength: 3.0,

};

/**
 * Road routing — greedy lookahead over terrain slope, curvature and obstacles.
 * Minimising earthwork contours the road around hills, along valley floors and
 * in traverses, as real surveyors route.
 */
export const ROUTE = {
  /** Candidate headings fanned out per control point. Odd, so "straight on" is always among them. */
  candidates: 13,

  /** Corridor sampled either side of the centreline, metres — must be wider than the carriageway. */
  corridor: 38,
  probes: 5,
  /** Stations sampled along each candidate span. */
  stations: 3,

  /** Detail level the router sees, as a `terrain.height` lateral argument. */
  lod: 90,

  /** Ride height of the finished carriageway over the natural surface. */
  rideHeight: 0.9,

  // ---- cost weights. Relative only; the winner is an argmin. -------------
  /** Earthwork is a budget, not an objective: free up to here, then it bites. */
  earthFree: 7.0,
  /** Slope of the penalty past `earthFree`. */
  wEarthwork: 6.0,
  /** Steepness, as a fraction of the legal maximum, squared. */
  wGrade: 14,
  /** Turn taken, and the change in turn between spans. */
  wTurn: 2.5,
  wTurnChange: 12,
  /** Deviation from the intended bearing. */
  wBearing: 8,
  /** How fast the intended bearing drifts, radians per metre of road. */
  bearingDrift: 0.0016,

  // ---- character. What makes one stretch of road unlike another. --------
  /** Scale over which the route's personality changes, metres. */
  characterScale: 2200,
  /** How far the personality can push the earthwork weight down. */
  directness: 0.72,
  /** Reward for seeking high or low ground, per metre of elevation difference. */
  wSeek: 0.55,
  /** Reward for a shelf: ground rising one side while it falls away the other. */
  wShelf: 2.4,
  /** Reward for vertical range across the corridor. */
  wRelief: 0.85,

  /** SELF-AVOIDANCE — the road must not come back alongside itself. */
  selfNear: 260,
  selfFar: 1600,
  selfClear: 300,
  wSelf: 900,

  /** Fraction a candidate must beat the incumbent by, against argmin flicker. */
  hysteresis: 0.04,

  /**
   * How far a terrain vertex may travel into its own turn, as a fraction.
   * Cross-file with `chunks.js:foldSafeOffset` and `path.corridorAt`.
   */
  foldMargin: 0.7,

  /** Turn rate the fold guard is built from, averaged over this many samples. */
  foldSmooth: 6,

  /** Length of road, metres, the relaxed heading is averaged over. */
  relaxWindow: 800,
};

export const CHUNK = {
  /** Length of one chunk along the road, metres. */
  length: 120,
  /** Longitudinal subdivisions per chunk (120 / 48 = 2.5 m quads). */
  segmentsU: 48,

  /** Chunks kept behind / ahead — keyed to the far grass tier's fade-out. */
  behind: 2,
  ahead: 7,

  /** Chunks built per frame once running — keeps frame spikes bounded. */
  buildPerFrame: 1,
  /** Built synchronously before the first frame so the whole active window exists. */
  preload: 9,

  /** Drainage ditch depth just off the shoulder, metres. */
  ditchDepth: 0.3,
  ditchWidth: 9,
  /** Distance past the verge over which the road's cross-slope dies away. */
  bankRunout: 22,

  /** Lateral sampling stays this fine out to `nearBand`, then grows geometrically. */
  nearStep: 2.4,
  nearBand: 78,

  /** Offsets over which the sheet's lateral direction rotates toward the relaxed heading. */
  relaxBand: [78, 260],

  /**
   * Main-thread budget for world streaming per frame, ms. Once a frame has
   * spent this, remaining builds wait (the sheet always gets a 1.5 ms sliver).
   */
  frameBudgetMs: 5,
  /** Legacy: lateral extent of the old road-space sheet. Still the far-tree band's outer limit. */
  halfExtent: 700,
  /** How far the (undrawn) scatter grid reaches either side of the road, metres. */
  scatterExtent: 200,
  /**
   * How close to the centreline anything may be planted, metres. Read by
   * `foliage.js:vegetation`; wider than `chunks.js:EDGE`.
   */
  plantClear: 11,

  /** The outermost band tilts gently away below the eyeline. */
  horizonFalloff: 520,
  horizonDrop: 30,

  /**
   * How far a chunk's far sheet is pushed below another pass of the road,
   * metres. Cross-file with `chunks.js:sampleGround`.
   */
  foreignSink: 4.0,
  /** Gradient of that cut, rise over run — shallower than `ROAD.cutSlope`. */
  foreignSlope: 0.10,

  /** The apron — the world-space ground beneath the road-space sheets. */
  apronHalf: 900,
  apronStep: 22,
  apronDetail: 40,
  apronSink: 1.2,
  /** How far below the carriageway the apron is cut where it passes under it. */
  apronRoadSink: 7.0,
  apronMove: 180,

  /** Lateral distance at which the player counts as having left the world. */
  recoverLateral: 300,
};

/**
 * The canopy — see `src/env/treegen.js` + `src/forest.js` (TreeGen), the legacy
 * `src/env/legacy/trees.js`, and `src/foliage.js`.
 * Legacy: both tiers are opaque, untextured, faceted solids. Placement, the
 * stand logic and the fades below drive both generators.
 */
export const TREES = {
  enabled: true,

  /**
   * Who grows the canopy: 'treegen' (`tree_gen/` submodule, env/treegen.js,
   * drawn by forest.js) or 'legacy' (the faceted low-poly trees,
   * env/legacy/trees.js). `?trees=legacy` in the URL picks the old one.
   */
  generator: 'treegen',

  /** TreeGen: generation budget, and the levels of detail drawn. */
  treegen: {
    /** Shapes per species; leaf colour still follows `foliage.js` palettes. */
    variants: 2,
    /** Mesh resolution multiplier and caps, per tree. */
    detail: 0.5,
    maxLeaves: 26000,
    maxBranches: 4000,
    barkSize: 256,
    impostorHeight: 192,
    /** Size against `foliage.js` heights, which were drawn for the legacy trees. */
    scale: 2.5,
    /**
     * TreeGen level specs, nearest first (see tree_gen/src/lod.js). Its LOD0
     * (full, ~100k+ triangles) is never drawn in the game; these are its
     * LOD1-4: simplified bark with thinned polygon leaves, two card levels
     * with their own atlases, and the lit billboard. `from` is the camera
     * distance, metres, where a level takes over (±13 m per tree).
     */
    lods: [
      { from: 0, error: 0.002, leafDetail: 0.35, keep: 0.25 },
      // Cards are painted from the leaf outlines, and a tile is 10-20 px:
      // coarse outlines cost a third and cannot be seen.
      { from: 60, error: 0.008, perCard: 12, cardSpan: 0.07, atlas: 512, keep: 0.3, leafDetail: 0.3 },
      // The widest band, so the cheapest mesh: big cards, a coarse skeleton.
      { from: 160, error: 0.016, perCard: 32, cardSpan: 0.14, atlas: 256, keep: 0.3, leafDetail: 0.3 },
      // The billboard reads flat up close: only out in the haze.
      { from: 560, impostor: true, error: 0.016 },
    ],
    /**
     * Trees drawn at these levels (from the nearest) cast shadows — through
     * the last mesh level's geometry, not their own (forest.js): the shadow
     * of a 56k-triangle crown and of its 1.3k-triangle cards look the same.
     */
    shadowLevels: 2,
    /**
     * Cutout coverage held up with distance: alpha is scaled by 1 + this × the
     * mip level, since averaged mips thin a crown until it reads as see-through.
     */
    alphaMipScale: 1.5,
  },

  /**
   * Shadows past the sun's shadow box (forest.js:shadeCanopy): each tree a
   * soft ellipse in a top-down map, `size` px over `extent` metres around
   * the camera, re-rendered when the camera moves `snap` metres. `crown`
   * scales the crown radius, `density` how dark one crown is, `strength`
   * how much direct light a full shadow takes; `fade` (m) is where it takes
   * over from the real shadow map.
   */
  canopyShadow: { enabled: true, size: 1024, extent: 1800, snap: 48, crown: 0.85, density: 0.85, strength: 0.8, fade: [55, 80] },

  /** Geometries built per species at boot, and species drawn per chunk. */
  variants: 3,
  picks: 8,

  /** How far a single face's colour may stray from its palette, +/-. */
  faceJitter: 0.075,

  /** How much bigger a far tree's lumps are, as an exponent on the count ratio. */
  lodGrow: 0.42,

  /** Where the near tier hands over to the far one, metres of camera distance. */
  lodFade: [260, 420],
  farFadeIn: [260, 420],
  /** Where the far tier stops. */
  farFade: [700, 880],

  /** Fade-in for a far tree with NO near mesh behind it, metres. */
  loneFadeIn: [480, 660],

  /** Scatter attempts per chunk, and the caps on what survives. */
  samples: 2000,
  nearCap: 110,
  /** The distant woodland (far tier only) beyond the near band — see chunks.js. */
  distantExtent: 650,
  distantSamples: 500,
  distantCap: 160,
  /** Acceptance against the canopy field; lower than the near band's 1. */
  distantDensity: 0.55,
  farCap: 760,

  /** Chunks either side of the car that carry the NEAR canopy. */
  behind: 2,
  ahead: 4,

  /** Vegetation is placed around cluster seeds rather than independently. */
  clusterCount: 6,
  clusterShare: 0.78,
  clusterSpecies: 0.8,

  /** What weight a guild-mate keeps inside another species' stand. */
  clusterMix: 0.22,

  /** Stand radius, metres, on a power law. */
  clusterRadius: [11, 78],

  /** How hard a stand thins toward its rim. */
  clusterFalloff: 1.6,

  /** Crown spacing: two crowns may overlap by this much of their radii. */
  crownGap: 0.5,
  /** Hash cell, metres: at least the widest crown pair × `crownGap`, or the 3×3 check misses. */
  spacingCell: 24,

  /** Age structure inside a stand. */
  vigour: 0.42,
  saplings: 0.18,

  /**
   * Height by place (chunks.js:_grove). A slow field marks TALL GROVES —
   * `window` against the mask's measured range (p05..p95 0.367..0.631): a
   * fifth of the land touched, a sixteenth in full — where every tree grows up to `boost` taller
   * and `grove` species (foliage.js) are favoured. A faster one drifts whole
   * woods between `age` young and old, so the skyline steps wood to wood.
   */
  grove: { freq: 0.0014, window: [0.56, 0.63], boost: 1.5, ageFreq: 0.007, age: [0.78, 1.22] },

  /** Chance a placed tree gets a second stem from the same stool, touching. */
  coppice: 0.14,

  /**
   * Ground colour taken and per-tree variance. The hue is in the GEOMETRY —
   * see `foliage.js:TREE_FORMS`.
   */
  groundTint: 0.16,
  instanceVary: 0.2,
  /** Share of broadleaf woods turned gold or copper (chunks.js:_treeTint). */
  autumnShare: 0.14,
  /** Sharpens stand edges — density squared, then scaled by this. */
  standBias: 2.3,

  /** The tree line, as relief above the local continental surface, metres. */
  treeLine: [190, 430],

  /** What is left of the ground cover under a closed canopy, 0..1. */
  shadeFloor: 0.25,

  /**
   * Window over which the fine patchiness field takes grass away entirely —
   * against the field's measured range, not 0..1.
   */
  barePatch: [0.42, 0.50],

  /** Wind direction (world XZ), tip travel in metres, and rate. */
  windDir: { x: 0.86, z: 0.51 },
  windStrength: 0.55,
  windSpeed: 0.65,
};

/**
 * The understorey: TreeGen bushes (`tree_gen/src/bush.js`), grown and drawn
 * with the canopy (`env/treegen.js`, `forest.js`), so only with the TreeGen
 * generator. Small, numerous, placed on the woodland EDGE rather than inside
 * or outside it.
 */
export const BUSHES = {
  enabled: true,

  variants: 2,
  picks: 2,

  /** Generation caps per bush (the trees' are `TREES.treegen`). */
  maxLeaves: 3000,
  maxBranches: 1000,

  /** Camera distance over which a shrub shrinks away, metres. */
  fade: [70, 105],

  /** Attempts per chunk and the cap on survivors. */
  samples: 900,
  cap: 78,

  /** Thicket seeds per chunk, the share drawn near one, and their radius. */
  clusterCount: 5,
  clusterShare: 0.62,
  clusterRadius: [7, 30],

  /** Lighter than the canopy: a shrub is stiff and close to the ground. */
  windStrength: 0.18,
};

/**
 * Ground cover. A tuft is four triangles carrying seven painted blades.
 * Only chunks either side of the car carry any, because grass is invisible
 * long before a chunk streams out.
 */
export const GRASS = {
  enabled: true,

  /**
   * Tufts per square metre at the verge, before rejections. An ask, not a
   * count. A quarter-ish of the 1.9 it was when tufts were half the size:
   * each covers four times the ground, so the field reads as full with far
   * fewer instances (and the same fragments).
   */
  density: 0.55,
  /** Lateral band: from the paved edge out to here, metres. */
  halfExtent: 46,
  /** Full density out to here, then tapering to nothing at `halfExtent`. */
  denseTo: 26,

  /** Camera distance over which a tuft shrinks away, metres. */
  fadeStart: 75,
  fadeEnd: 125,

  /** How much larger a tuft grows at the edge of the band than at the verge. */
  farScale: 1.0,

  /** Chunks either side of the car that carry grass. 1 = three chunks, 360 m. */
  chunkRadius: 1,
  /** Grass chunks built per frame. Scattering one is thousands of samples. */
  buildPerFrame: 1,

  /** Tuft height, metres. */
  height: [0.44, 1.0],
  /** Width as a fraction of height. A square-ish card overlaps into a field. */
  widthRatio: 0.95,

  /** Steepest ground grass grows on. */
  maxSlope: 1.6,

  /** Wind direction (world XZ), strength in metres of tip travel, and rate. */
  windDir: { x: 0.86, z: 0.51 },
  windStrength: 0.36,
  windSpeed: 1.35,

  /** Blades drawn into one card, and the card texture's size in pixels. */
  bladesPerCard: 7,
  textureSize: 256,

  /** The THIRD tier: the woodland floor. Near-field only. */
  wood: {
    enabled: true,
    behind: 1,
    ahead: 1,
    /** Lateral band, metres. Trees start at `CHUNK.plantClear`; this follows. */
    halfExtent: 90,
    /** Tufts per square metre asked, before `floor` scales it down. */
    density: 0.22,
    /** Height range, metres. */
    height: [0.88, 1.9],
    /** Nearly square, so neighbours overlap into a surface. */
    widthRatio: 0.82,
    /** Still brighter than the ground it stands on. */
    lift: [1.02, 1.28],
    /** As many blades as the roadside card. */
    bladesPerCard: 7,
    /** Shrinks out here. */
    fadeOut: [50, 80],
    maxSlope: 1.2,
  },

  /** The SECOND tier: the middle distance. */
  far: {
    enabled: true,
    behind: 1,
    ahead: 3,
    /** Lateral band, metres. Past this the terrain's detail texture takes over. */
    halfExtent: 140,
    /** Card size: 1.0x so distant grass blades match foreground ones. */
    widthScale: 1.0,
    heightScale: 1.0,
    /** Density, as a fraction of what would preserve ground cover at that scale. */
    coverage: 0.05,
    /** Grows in over this camera-distance window, behind the near tier's fade. */
    fadeIn: [60, 115],
    /** And shrinks out again here — the grass's own far edge, up against the fog. */
    fadeOut: [190, 280],
    /** Steepest ground it will stand on, looser than the near tier. */
    maxSlope: 2.2,
  },
};

/**
 * The carriageway surface — see `env/road.js`.
 */
export const ROAD_SURFACE = {
  /**
   * The asphalt, grown at boot (env/road.js): binder, aggregate chips and a
   * distress layer (ravelling pits, alligator cracking), texels a side over
   * `tile` metres of ROAD space (across, along) — so wear follows the lanes.
   */
  textureSize: 1024,
  tile: 2.0,
  /** Chips per square metre of tile, and the share that are pale stone. */
  chips: 5200,
  paleChips: 0.12,
  /** Alligator cells across the tile, and how many survive as cracks. */
  alligatorCells: 11,

  /** The far wear mottle: metres per tile, and how hard it modulates. */
  tileFar: 17,
  contrastFar: 0.62,
  /** Where the aggregate's grain stops, metres. */
  nearFade: [26, 90],

  /** Dry asphalt, fresh to old. Real values are 0.85-0.98; wet would be under 0.4. */
  roughness: [0.86, 0.97],
  /** Wheel paths polish, sealant shines. */
  polish: 0.07,
  sealGloss: 0.32,

  /**
   * RESURFACING. The road is laid in sections — a pure function of `s`: one
   * seam at every multiple of `sectionCell` and one more somewhere inside it —
   * each carriageway its own age unless the whole width was done at once
   * (`fullWidth` of the time). Age 0 is fresh black; 1 is bleached, chipped,
   * cracked grey. A seam is a doubled row of the ribbon, so it is crisp.
   */
  sectionCell: 420,
  fullWidth: 0.55,
  ages: [0.04, 0.3, 0.58, 0.9],
  /** Colour multipliers on the base asphalt, fresh and old. */
  fresh: [0.74, 0.75, 0.8],
  old: [2.9, 2.82, 2.6],

  /** Patch repairs: chance per lane per 16 m, at age 0 and at age 1. */
  patch: [0.05, 0.42],
  /** Cracks: transverse every 9 m at most; share sealed with tar. */
  sealShare: 0.45,
  /** Cracks thin out to nothing over this distance, metres. */
  crackFade: [60, 180],

  /** Parallax occlusion on the asphalt: relief depth (m), fade (m), layers. */
  pom: { depth: 0.016, fade: [4, 18], steps: [3, 10] },
};

/**
 * The terrain's own surface detail — see `env/ground.js`.
 */
export const GROUND = {
  enabled: true,
  /** Detail map resolution. Three channels of luminance; see env/ground.js. */
  textureSize: 512,

  /** Metres of world per tile, near and far. */
  tileNear: 5.5,
  tileFar: 28,

  /** How hard each scale modulates the ground colour, 0..1. */
  contrastNear: 0.34,
  contrastFar: 0.30,

  /** Distance over which the near tile fades out, metres. */
  nearFade: [45, 130],

  /** Metres per tile of the macro (lush/parched) variation. */
  macroTile: 371,
  /** Strength of the screen-space detail bump. */
  bump: 0.045,

  /**
   * The SWARD: a generated tile of turf, ray-marched (parallax occlusion) on
   * green ground near the camera — see env/ground.js. Its albedo fades with
   * `nearFade`; the march with `fade`, and costs nothing past it.
   */
  sward: {
    enabled: true,
    /** What the tile is grown as: grass, grass under fallen leaves, snow, rippled sand (`WORLDS`). */
    kind: 'grass',
    /** Texels a side, and metres of ground the tile covers. */
    size: 1024,
    tile: 3.0,
    /** Per square metre of tile: tufts of blades, and pebbles in the soil. */
    tufts: 70,
    pebbles: 22,
    /** Share of tufts gone to straw. */
    dryShare: 0.16,
    /** Relief depth, metres, from the soil to the tallest blade. */
    depth: 0.1,
    /** The march fades out over this distance, metres. */
    fade: [8, 26],
    /** Layers marched looking straight down, and along the ground. */
    steps: [4, 14],
    /** Anisotropic taps on the colour fetch (the march takes none). */
    anisotropy: 8,
    /** Self-shadow strength, 0..1: four more fetches per pixel; 0 skips them. */
    shadow: 0.6,
    /** How strongly the turf's luminance, and its occlusion, reach the albedo. */
    contrast: 0.85,
    occlusion: 0.7,
    /** Dry blades and bare soil, as a multiplier on the ground colour. */
    dry: [1.08, 0.92, 0.6],
  },

  /**
   * The VERGE: packed dirt and gravel between the shoulder and the grass, a
   * generated heightfield marched with the sward (same `fade` and `steps`).
   * Soil and stone are separate heights, so stones sink into the dirt with
   * distance from the asphalt instead of being faded out.
   */
  verge: {
    enabled: true,
    size: 1024,
    tile: 2.0,
    /** Relief depth, metres: a height of 1 is a cobble standing this proud. */
    depth: 0.045,
    /** Per square metre of tile: gravel, and the odd cobble. */
    gravel: 2600,
    cobbles: 12,
    /** Metres from the centre line: gravel starts, and has gone to grass by the end. */
    band: [ROAD.halfWidth + ROAD.shoulder - 0.4, ROAD.halfWidth + ROAD.shoulder + 4.5],
    /** How far the band's edge wanders, metres. */
    jitter: 2.0,
    /** Stone, light and warm (sRGB). */
    stone: [0xc4bfb5, 0xa8957a],
  },
};

/**
 * Road signs — see `env/signs.js` (the library) and `chunks.js:_buildSigns`
 * (where they go). Distances in metres along / across the road.
 */
export const SIGNS = {
  enabled: true,
  /** Roadsign-gen's level of detail: 1 = 768 px faces, 2 = 384 px and fewer segments. */
  lod: 1,
  /** Every roadside sign, post and all, against the generator's own sizes. */
  scale: 1.2,
  /** Gantries: pole height, and the faces' size, against the generator's. */
  overheadLift: 1.35,
  overheadScale: 1.25,
  /** Past this a sign is a few pixels: not drawn. */
  drawDistance: 520,

  /** Gap between the shoulder's edge and the near edge of a roadside sign. */
  clearance: 1.3,
  /** Sunk this far, so a post on a slope does not show daylight under its foot. */
  sink: 0.15,
  /** Nothing within this of another road, or within this of where the ground folds. */
  foreignRadius: 30,

  /** Chevrons: along a bend that is sharper than this (1/m) within 60 m, one every `chevronStep`. */
  chevronCurv: 1 / 280,
  chevronStep: 45,
  /**
   * A bend worth a warning: sharper than `bendCurv` for `curveHold`, after
   * `curveLead` of straighter road. The warning stands `curveLead` before it.
   */
  bendCurv: 1 / 420,
  curveLead: 120,
  curveHold: 40,
  /** No two signs on one side of the road closer than this (bar a run of chevrons). */
  spacing: 26,

  /** One roll per chunk; the weights of what it becomes. */
  featureChance: 0.45,
  mix: { speed: 0.17, warn: 0.17, guide: 0.18, marker: 0.12, pennant: 0.06, portal: 0.07, cantilever: 0.07, back: 0.16 },

  /** Generator-seeded extras in the library (env/signs.js). */
  seededVerge: 4,
  seededOverhead: 4,
  /** Gantry legs, either side of the centreline; faces shifted over the player's lanes. */
  gantryLeg: 11.2,
  gantryShift: 3.7,
  /** A cantilever's span: its column on the verge, its arm over the near carriageway. */
  cantileverSpan: 10.5,
  /** Skip a gantry where the ground at a leg is this far below the road. */
  gantryDrop: 1.2,
};

/**
 * Settlements — see `towns.js` (where they go, and the ground they level) and
 * `env/towns.worker.js` (City-gen building them). The road is cut into slots;
 * each slot rolls one settlement or none. Distances in metres.
 */
export const TOWNS = {
  enabled: true,
  /** Road length per roll, and the chance a roll is a city. */
  slot: 1500,
  cityChance: 0.7,

  /**
   * Cities: on the horizon, never on the road (roadside hamlets and villages
   * were removed). Centre this far out, side this long.
   */
  cities: true,
  cityDist: [850, 1300],
  citySize: [360, 540],
  /** Land under a city may vary this much before levelling; levelled ground blends back over `cityBlend`. */
  cityRelief: 40,
  cityBlend: 150,
  cityDensity: [1.3, 2.3],

  /** Generated within `buildRadius` of the focus, freed past `keep`. */
  buildRadius: 2300,
  keep: 2800,
};

/**
 * Wind noise — see `wind.js`. The one sound the engine simulator cannot make;
 * every number here was chosen by listening.
 */
export const WIND = {
  /** Master level for the whole layer, 0..1. Exposed in the settings drawer. */
  volume: 0.1,

  /** Seconds of noise generated at boot. Long enough that the loop is inaudible. */
  bufferSeconds: 10,

  /** Speed at which it starts, and where it reaches full, m/s. */
  startSpeed: 8,
  fullSpeed: 72,

  /** Shape of the rise. Just over squared, so the whole speed range is expressive. */
  exponent: 2.2,

  /** Seconds of one-pole smoothing on the speed the filters follow. */
  smoothing: 0.18,
  /** Time constant for the parameter ramps. Below ~20 ms these click. */
  rampTime: 0.05,

  /** Broadband rush: level at full speed, and the low-pass sweep. */
  rushLevel: 0.85,
  rushCutoff: [260, 1500],

  /** Edge whistle: level, band, and how far up the speed range it waits. */
  whistleLevel: 0.30,
  whistleFreq: [900, 2600],
  whistleFrom: 0.45,
  whistleQ: 1.6,
};

/**
 * Tyre effects — smoke and marks. See `fx.js`. Both are driven by the same
 * quantity the skid audio uses, `wheel.slipAmount`.
 */
export const FX = {
  smoke: {
    enabled: true,
    /** Particle pool. Fixed: mesh allotted at boot, particles recycled oldest-first. */
    max: 420,
    /** Puffs per second per wheel at full slip. */
    rate: 55,
    /** Seconds a puff lives. */
    life: 1.5,
    /** Radius at birth and at death, metres. */
    size: [0.30, 2.1],
    /** Rise rate and how fast a puff sheds the wheel's velocity, m/s and 1/s. */
    rise: 1.25,
    drag: 1.9,
    /** Peak opacity. Reached early in the life, then decays. */
    opacity: 0.34,

    /** Below this much slip nothing is emitted at all. */
    minSlip: 0.22,

    /** Tyre heat time constants, s: how long a slide takes to billow, and to clear. */
    heatUp: 0.9,
    heatDown: 1.6,

    /** Emission thins to 40 % across this speed range, m/s: fast slides spread along the road. */
    speedFade: [20, 45],

    /** Where a puff is born relative to the contact patch: back and up, metres. */
    offset: [0.25, 0.12],
  },

  marks: {
    enabled: true,
    /** Ring buffer of quads, shared across all four wheels. */
    maxQuads: 3000,
    /** Minimum distance the wheel must travel before another quad is laid, m. */
    step: 0.20,
    /** Seconds a mark takes to fade out completely. */
    life: 16,
    /** Darkest a mark gets. */
    opacity: 0.5,
    /** Above this much slip a mark is laid. */
    minSlip: 0.18,
    /** ...once the slip has lasted this long, s. Shorter blips left lone dark squares. */
    holdTime: 0.1,
    /** Lift above the contact patch, metres. Enough to clear the terrain mesh. */
    lift: 0.035,
    /** Mark width as a fraction of the tyre's own width. */
    widthScale: 0.85,
  },
};

export const VEHICLE = {
  mass: 1250,
  /** Ceiling on chassis speed, m/s (~360 km/h). Stops a bad contact resolve becoming flight. */
  maxChassisSpeed: 100,
  /** Centre of mass offset from the body origin — low CoM resists rolling. */
  comOffset: { x: 0, y: -0.20, z: 0.05 },

  /** Chassis collider half-extents (also drives the inertia tensor). */
  chassis: { hx: 0.95, hy: 0.34, hz: 2.15 },

  /** Wheel layout, relative to the body origin. */
  trackHalf: 0.86,
  wheelbaseHalf: 1.42,
  anchorHeight: -0.10,
  wheelRadius: 0.36,
  wheelWidth: 0.26,

  // ---------------------------------------------------------- suspension --
  /** Maximum suspension travel (also the ray length beyond the wheel radius). */
  restLength: 0.42,
  /** Hooke spring rate, N/m. */
  springK: 42000,
  /** Damping coefficients, N/(m/s). Rebound > bump is the usual road-car tune. */
  damperBump: 3300,
  damperRebound: 4400,
  /** Hard ceiling so a big compression can't launch the car. */
  maxSpringForce: 60000,
  /**
   * Anti-roll bar rate, N per unit of normalised travel difference.
   * Rear-biased: front-stiff would shift load and lose grip — understeer.
   */
  antiRollFront: 2500,
  antiRollRear: 4200,

  // ---------------------------------------------------------------- tyres --
  /** Coulomb friction ceiling — bounds the whole friction circle. */
  tyreFriction: 1.25,

  /** Slip-angle tyre model (a stripped-down Pacejka Magic Formula). */
  /**
   * C — the shape factor, the biggest lever on whether a slide is holdable;
   * sets how much grip survives past the peak.
   */
  tyreShape: 1.15,
  corneringStiffnessFront: 15,  // B — peak near 7.1 deg: crisp turn-in
  /** Rear peak grip against front. Above 1 the front washes out first. */
  corneringStiffnessRear: 13.0,
  /**
   * Rear peak grip against front. Above 1 the front washes out first (safe
   * understeer); below 1 the car rotates on its own terms.
   */
  rearGripBias: 1.00,
  /** Below this speed band, slip angle is meaningless; blend to velocity-cancelling. */
  slipBlendSpeed: [0.6, 3.5],

  /** Effective mass per tyre for the low-speed velocity-cancelling fallback. */
  lateralGripMass: 0.30,
  /** Tyre forces applied this far above the contact patch, cutting roll moment. */
  frictionAnchorLift: 0.24,
  rollingResistance: 320,
  /** Surface drag off the asphalt, so the verge is not a free shortcut. */
  offRoadDrag: 3.2,
  offRoadGrip: 0.72,

  // -------------------------------------------------------------- driving --
  /**
   * Torque split [FL, FR, RL, RR], rear-biased so the front tyres steer.
   * Fractions of total drive force; must sum to 1.
   */
  driveBias: [0.09, 0.09, 0.41, 0.41],
  /** Per wheel. Sums past the tyre limit so the brakes can actually lock up. */
  brakeForce: [7500, 7500, 5000, 5000],
  handbrakeForce: 9000,

  /** Steering: usable angle derived from grip — `δ_max = atan(L·a_max/v²)`. */
  maxSteer: 0.58,
  /**
   * Floor on the usable angle, and the margin past the grip limit.
   */
  minSteer: 0.095,
  steerGripMargin: 1.6,
  /** Slew rates toward full lock and back to centre, rad/s. */
  steerRate: 5.0,          // rad/s toward full lock
  steerReturnRate: 6.6,    // rad/s back to centre when input released

  // ----------------------------------------------------------- powertrain --
  /**
   * Fallbacks only. Every roster entry supplies its own; `engine_sim` owns the
   * torque curve, clutch and shift logic.
   */
  maxRpm: 7400,
  finalDrive: 3.7,
  /** index 0 = reverse, index 1 = neutral, 2+ = forward gears. */
  gearRatios: [-3.3, 0, 3.62, 2.24, 1.58, 1.19, 0.96, 0.79],

  // ------------------------------------------------------------ aero/misc --
  dragCoefficient: 0.55,   // 0.5 * rho * Cd * A, lumped
  /** N per (m/s)^2. At 70 m/s this adds ~11 kN, keeping fast sweepers planted. */
  downforce: 2.2,
  /** Zero: Rapier's linear damping would otherwise overwhelm the aero term. */
  linearDamping: 0.0,
  /** Angular damping, 1/s. Means the car stops pivoting the instant steering asks. */
  angularDamping: 0.45,
  /** Self-righting torque so a bad landing doesn't end the run. */
  uprightTorque: 5.5,
  /** Pitch/yaw authority while airborne. */
  airControl: 2.6,

  /** Chassis slip angles over which steering lock opens beyond the grip limit. */
  slideOpenFrom: 0.14,     // ~8 deg — the car is starting to move around
  slideOpenTo: 0.55,       // ~32 deg — fully opened
  slideLockGain: 4.0,      // how many times the steady-state limit, at most

  /**
   * Countersteer authority: chassis slip angles over which opposing steering
   * is allowed off the cornering limit, and how much of the parking lock it
   * may reach. See `vehicle.js:_updateSteering`.
   */
  counterFrom: 0.035,      // ~2 deg — the car has begun to move around
  counterTo: 0.16,         // ~9 deg — full countersteer authority
  counterLock: 0.62,
};

export const TRAFFIC = {
  /** Cars kept alive around the player, on average; `wave` swells and thins it along the road. */
  count: 10,
  /** Density varies ±this fraction over a few kilometres: busy stretches, empty ones. */
  wave: 0.45,
  /** Distinct generated cars in the pool (models.js Fleet). */
  fleetSize: 18,
  /** Past this (metres along the road) a car is drawn as one merged mesh. */
  lodDistance: 70,

  /** Populated band, and where inside it a car may appear — cars spawn in the haze. */
  spawnMin: 430,
  ahead: 620,
  behind: 240,
  /** Share of spawns that come the other way. */
  oncomingShare: 0.42,
  /** Same-direction cars may also appear this far behind when the player dawdles. */
  spawnBehind: 190,

  /** Desired speeds, m/s, before each driver's personality and car class. */
  speedMin: 18,
  speedMax: 32,
  speedFloor: 0,

  // ------------------------------------------- Intelligent Driver Model --
  /** Comfortable acceleration and deceleration, m/s², for a middling driver. */
  accel: 1.7,
  decel: 2.6,
  /** Panic stop ceiling. IDM asks for more when something appears in the lane. */
  emergencyDecel: 9,
  /** Standstill gap, metres, and time headway, seconds. */
  jamGap: 2.5,
  headway: 1.3,
  /** Lateral acceleration traffic is willing to use through a corner. */
  cornerAccel: 3.2,

  // ---------------------------------------------------------- lanes --
  /** Seconds a manoeuvre takes, and seconds of indicator before it starts. */
  laneChangeTime: 3.0,
  signalTime: 1.1,
  /** Acceleration gain (m/s²) that makes an overtake worth it; and the most braking it may impose. */
  overtakeGain: 0.35,
  safeDecel: 3.0,
  changeCooldown: 4,

  /** How far back a driver notices someone coming up behind. */
  noticeRange: 90,
  /** Flashed: slow to this fraction of cruise while pulling aside. */
  yieldSlow: 0.75,
  /** Seconds to impact at which an oncoming driver flashes and swerves. */
  alarmTime: 3.2,

  // ------------------------------------------------------------- impacts --
  /** Bounciness of a car-to-car hit. Sheet metal is not a squash ball. */
  restitution: 0.15,
  /** Ceiling on the speed change one impact may hand the player, m/s. */
  maxImpactDv: 11,
  /** Seconds one impact's impulse is spread over: crumple time, so a hit shoves rather than teleports. */
  impactTime: 0.18,
  /** Seconds a struck car spends spinning out before it is taken away. */
  spinTime: 4.5,
  /** How fast a spinning car sheds speed, m/s². */
  spinDecel: 5.5,
};

export const CAMERA = {
  fov: 62,
  near: 0.4,
  /** `far` pulled in to match the fog wall for depth precision; nothing exists past ~700 m. */
  far: 2300,   // past the fogged-out terrain (TILES.radius); was 3200
  /**
   * Chase rig: distance / height / look-ahead, metres. `zoom` scales how much
   * the rig opens out with speed; the close camera stays put.
   */
  chase: { dist: 4.8, height: 2.30, ahead: 6.0, zoom: 1.0 },
  close: { dist: 4.2, height: 1.80, ahead: 4.8, zoom: 0.5 },
  /** Lowest the chase camera may sit above the terrain under it, metres. */
  groundClearance: 1.4,
  /** Height of the point the camera aims at, above the contact plane. */
  aimHeight: 0.95,
  /**
   * The rig scales with the vehicle's body size, clamped to the extremes.
   */
  bodyRef: 1.45,
  heightScaleMax: 1.75,
  distScaleMax: 1.35,
  /**
   * Natural frequencies of the rig's critically damped springs, rad/s
   * (higher = stiffer). `yaw`/`pitch` swing the rig round the car; `height`
   * filters suspension and bumps out of the pivot; `dist` eases the pull-back.
   */
  yawRate: 1.8,
  pitchRate: 1.4,
  heightRate: 2.0,
  /** Most the pivot may sit above or below the car, metres: bounds how far hills and bumps move the camera vertically. */
  heightSlack: 0.35,
  distRate: 1.2,
  /** The climb rate fed forward to the height spring is smoothed at this rate: hills track, bumps don't. */
  climbRate: 0.8,
  /** 0..1 — how much the rig follows the direction of travel rather than the nose, so a slide doesn't swing it. */
  travelAlign: 0.6,
  /** Share of the car's pitch the rig follows on grades. */
  pitchFollow: 0.08,
  /** The rig trails by speed × this, seconds: the pull-back at speed. */
  pullTime: 0.03,
  /** Camera roll per unit of slide, radians, and how fast it eases in. */
  slipRoll: 0.005,
  rollRate: 1.2,
  /** How the rig opens out with speed — pull-back complete at `speedRef`. */
  speedRef: 68,
  speedLag: 0.5,
  /** How far the rig backs off and lifts at full speed, metres. Kept small. */
  distGain: 0.6,
  heightGain: 0.03,
  /** Degrees of extra field of view at full speed — most of the speed cue. */
  fovSpeedGain: 3,

};

/**
 * The title screen's camera — the car parked on the road, rendered as a camera
 * move rather than a scene change. Only the framing maths survives; see
 * `camera.js:_updateTitle`.
 */
export const TITLE = {
  /** Narrower than the driving field of view: this is a portrait, not a road. */
  fov: 46,

  /** Turntable rate, radians per second. A full turn takes about forty seconds. */
  spin: 0.15,

  /** The four angles that make a good car shot, in radians of orbit phase. */
  angles: [0.85, -0.85, 2.35, -2.35],

  /** Fraction of the free rectangle the car is allowed to fill — under one. */
  fill: 0.62,
  /** Never closer than this, whatever the arithmetic says, metres. */
  minDistance: 6.0,
  /** Orbit radius and height as multiples of the solved distance — a direction. */
  orbitRadius: 0.94,
  eyeLift: 0.30,
  /** Where the rig looks, as a fraction of body height above the contact plane. */
  aimHeight: 0.34,

  /** Seconds for the fly-in from the orbit to the chase position. */
  introTime: 1.35,
};

export const ATMOSPHERE = {
  /** Overcast-bright: sun well up, close to white, strong hemisphere fill. */
  fogColor: 0xd6dbdb,
  /** Haze, not a fog wall: world readable to ~150 m, half-lost by ~380 m. */
  fogDensity: 0.0015,

  skyTop: 0x7ba4ce,
  skyZenith: 0x3f6ea8,
  skyHorizon: 0xdde3e2,
  sunColor: 0xfff4e6,
  sunIntensity: 2.4,

  hemiSky: 0xd2e2f2,
  hemiGround: 0xa39c8c,
  /** Deliberately high: this is what lifts the shadows and kills the contrast. */
  hemiIntensity: 1.5,
  /** Image-based light from the baked sky: reflections, and part of the ambient. 0 disables it. */
  envIntensity: 0.45,
  /** Share of the hemisphere fill kept now the baked sky carries the rest of the ambient. */
  hemiTrim: 0.7,

  /** Sun well above the horizon — the single biggest lever on "sunset vibe". */
  sunDir: { x: -0.34, y: 0.62, z: -0.71 },

  shadowRadius: 78,
  shadowMapSize: 2048,

  /**
   * Render resolution as a multiple of CSS pixels, capped below the display's
   * own: a 2× laptop panel at 2.0 is 5 MP shaded per frame, at 1.5 it is 2.9.
   * Dynamic resolution (scene.js:adapt) may drop to `minPixelRatio` under load.
   */
  maxPixelRatio: 1.5,
  minPixelRatio: 1,
  /** MSAA samples on the scene target; also what alpha-to-coverage cutouts need to soften. */
  msaa: 0,
  /** FXAA after tone mapping: edges, cutouts and thin far geometry. */
  fxaa: true,

  /** Post-processing. Bloom is now a hint of glow, not a glare. */
  bloomStrength: 0.14,
  bloomThreshold: 0.9,
  vignette: 0.13,
  /**
   * Radial speed blur: smear at full speed as a fraction of distance from the
   * screen centre; `speedBlurInner` stays perfectly sharp. Replaced depth of
   * field, which blurred the car itself.
   */
  speedBlur: 0.055,
  speedBlurInner: 0.17,
  /** Speed, m/s, at which the blur reaches full strength. */
  speedBlurRef: 68,

  /** Overall brightness multiplier applied by the tone mapper. */
  exposure: 1.18,
};

/**
 * Near-miss scoring, used by Traffic mode. Closer and consecutive passes score
 * more; oncoming traffic is worth much more.
 */
export const SCORE = {
  /** Lateral clearance, metres, within which a pass scores at all. */
  nearRange: 2.6,
  /** Points for a pass that all but touches, and for one at the edge of range. */
  best: 260,
  worst: 40,
  /** Oncoming cars are worth this many times a same-direction pass. */
  oncomingBonus: 2.4,
  /** Seconds the chain survives without another pass. */
  chainTime: 5.0,
  /** Multiplier gained per pass, and its ceiling. */
  chainStep: 1,
  chainMax: 10,
  /** Minimum seconds between two scoring passes, so a cluster is not a jackpot. */
  cooldown: 0.3,
  /** Below this speed a pass does not count, m/s. */
  minSpeed: 12,
  /** How far along the road a car must get before its pass is scored. */
  passWindow: 14,
};

/**
 * The ground palette — lighter and less saturated than natural, to sit with the
 * flatter lighting. Mixed by altitude above the local base (see
 * `chunks.js:_groundColor`, `noise.js:continent`), not by absolute height.
 */
export const TERRAIN_COLORS = {
  grassLow: 0x74915c,
  grassHigh: 0x8e9a68,
  grassDeep: 0x546b45,
  grassDry: 0xb0a473,
  scrub: 0x6e7350,
  rock: 0x8f867b,
  dirt: 0x9d8e75,
  /** Hollows (water and soil gather), and slopes turned from the sun. */
  lush: 0x4e7a3c,
  shade: 0x5b7c5b,
  /** Plant communities, in patches: bracken, heather, fresh sward, rush. */
  bracken: 0x8f8149,
  heather: 0x7b6a5d,
  fresh: 0x9caf5c,
  rush: 0x58643f,
  /** Bare ground the terrain shader draws: eroded soil (rock is `rock`). */
  soil: 0x8a7457,
  peak: 0xa9a29a,
  snow: 0xe8ebee,
  /** Lake beach and lake bed. */
  sand: 0xcdbb8f,
  mud: 0x5d5446,
};

/**
 * World-space terrain tiles (`worldtiles.js`). A quadtree: each level doubles
 * the tile and its cell size. 64 m / 2 m cells beside the car, 2 km / 64 m at
 * the horizon.
 */
export const TILES = {
  /** Side of a level-0 tile, metres (32 cells of 2 m). */
  base: 64,
  levels: 6,
  /** A tile splits while the focus is within `split` × its own size. */
  split: 1.6,
  /**
   * How far tiles are built from the focus, metres. Matched to the FOG, not
   * the far plane: at the thinnest preset fog (golden, 0.0013) the ground is
   * 99.6 % fogged by ~1770 m, so terrain past that was built, kept and drawn
   * for nothing (2600 m before; 215 tiles → see probe/perf.mjs).
   */
  radius: 1850,
  /** Tiles nearer than this carry a trimesh collider. */
  colliderRadius: 170,
  /** Skirt depth in cells (plus 1.5 m). */
  skirt: 2.0,
  buildPerFrame: 2,
  /** A tile is ~6 ms; past this no second tile starts in the same frame. */
  msPerFrame: 4,
};

/** Biome regions (`biomes.js`). */
export const BIOME = {
  /** Worley cell size, metres — the typical span of one biome patch. */
  cell: 1300,
  /** Cross-fade band at a border, metres of F2 − F1. */
  border: 260,
  /** Domain-warp amplitude on the cell lattice, metres. */
  warp: 700,
  /** Random score added per cell, so similar climates still vary. */
  variety: 0.9,
};

/** Lakes (`terrainfield.js:Lakes`, `env/water.js`). */
export const WATER = {
  enabled: true,
  /** One candidate lake per cell of this size, metres. */
  cell: 900,
  /** Fallback chance per cell when no biome is wired in. */
  chance: 0.35,
  /** Shoreline radius range, metres. */
  radius: [55, 190],
  /** Depth at the centre below the waterline, metres. */
  depth: 7,
  /** Width of the shelving beach, metres. */
  beach: 26,
  /** Closest any road may come to a shore, metres. */
  roadClear: 60,
  /** Highest the ground just outside the shore may stand over the water, metres. */
  maxRim: 16,
  /** Colours: deep water, shallows, and the sky tint the Fresnel term mixes toward. */
  deep: 0x1d4a5a,
  shallow: 0x4f8c86,
  foam: 0xe8f0ee,
};

/**
 * Roadside barriers — see `env/barriers.js` (the models) and
 * `chunks.js:_buildBarriers` (where they go). Where a real road has one: on
 * the outside of a sharp bend, and where the ground beside the road falls
 * well below it. Steel W-beam guardrail is the highway's; a timber post and
 * rail fence the country road's. Distances in metres.
 */
export const BARRIERS = {
  enabled: true,
  /** Post spacing, and the face's offset outward from the asphalt's edge. */
  step: 4,
  offset: 1.2,
  /** A bend sharper than this (1/m) gets one on its outside. */
  curv: 1 / 260,
  /** Ground this far below the road, `probe` out from the edge, gets one either way. */
  drop: 2.2,
  probe: 4,
  /** A run is held this far past its hazard, gaps under `bridge` are closed, runs under `minRun` dropped. */
  lead: 16,
  bridge: 28,
  minRun: 36,
  /** Share of runs in timber, by lanes each way (1, 2); a drop past `steelDrop` is always steel. */
  woodShare: [0.7, 0.12],
  steelDrop: 5,
  /** Solid: a car (the player's, a rigid body) stops against one. */
  colliders: true,
};

/* =============================================================== graphics == */

/**
 * The three levels of graphical fidelity, chosen from the title screen or the
 * settings panel. The override below REWRITES parts of the config objects
 * before assets build, so changing level saves and reloads the page.
 *
 *   HIGH    the current defaults — dense woods, long draw distance.
 *   MEDIUM  half the draw distance, and about half of everything in it.
 *   LOW     the FAR TIER ONLY — no near canopy, no grass, no shrubs.
 */
export const GRAPHICS_LEVELS = ['high', 'medium', 'low'];

const GRAPHICS_KEY = 'highroads.graphics';

export function graphicsLevel() {
  // Wrapped, not `typeof`-guarded: Node's `localStorage` global throws unless
  // started with a store, so a `typeof` check passes and the call still fails.
  try {
    const v = localStorage.getItem(GRAPHICS_KEY);
    return GRAPHICS_LEVELS.includes(v) ? v : 'high';
  } catch (err) {
    return 'high';
  }
}

export function setGraphicsLevel(level) {
  if (GRAPHICS_LEVELS.includes(level)) {
    try { localStorage.setItem(GRAPHICS_KEY, level); } catch (err) { /* private window */ }
  }
  return level;
}

/** Applies the saved level by rewriting the config, before assets build. */
function applyGraphics() {
  const level = graphicsLevel();
  if (level === 'medium') {
    // Half the draw distance, thickened fog to hide the closer seam.
    CHUNK.ahead = 4;
    ATMOSPHERE.fogDensity = 0.0024;
    ATMOSPHERE.maxPixelRatio = 1.25;
    ATMOSPHERE.bloomStrength = 0;
    ATMOSPHERE.envIntensity = 0;
    ATMOSPHERE.hemiTrim = 1;
    CAMERA.far = 1100;
    TILES.radius = 1050;    // fog 0.0024 is 99 % by ~900 m; was 1500, past the far plane
    TILES.levels = 5;

    // A thinner wood: `farCap` falls further than `nearCap` (a far tree is
    // fifty triangles to a near one's five, over two more chunks).
    TREES.samples = 1200;
    TREES.nearCap = 70;   // two thirds of high (trap 39a)
    TREES.distantCap = 80;
    TREES.distantExtent = 480;
    TREES.farCap = 380;
    TREES.picks = 4;
    TREES.ahead = 3;
    TREES.farFade = [430, 470];
    TREES.loneFadeIn = [300, 460];
    // No polygon-leaf level: cards from the first metre.
    TREES.treegen.lods = TREES.treegen.lods.slice(1)
      .map((L, i) => ({ ...L, from: [0, 150, 360][i] }));
    TREES.treegen.shadowLevels = 1;

    // Grass and shrubs scale down together.
    GRASS.density = 0.38;
    GRASS.far.ahead = 2;
    GRASS.far.fadeOut = [150, 220];
    BUSHES.samples = 600;
    BUSHES.cap = 72;
    SIGNS.lod = 2;
    SIGNS.drawDistance = 400;
    // The fog closes at ~900 m: cities stand just inside it.
    TOWNS.cityDist = [560, 820];
    GROUND.sward.size = 512;
    GROUND.sward.steps = [4, 12];
    ROAD_SURFACE.pom.steps = [2, 6];
    GROUND.sward.fade = [6, 24];
    GROUND.sward.shadow = 0;
    GROUND.verge.size = 512;
  } else if (level === 'low') {
    // The shortest draw distance, and a fog that ends it invisibly.
    CHUNK.ahead = 3;
    ATMOSPHERE.fogDensity = 0.0034;
    ATMOSPHERE.maxPixelRatio = 1;
    ATMOSPHERE.minPixelRatio = 0.75;
    ATMOSPHERE.bloomStrength = 0;
    ATMOSPHERE.envIntensity = 0;
    ATMOSPHERE.hemiTrim = 1;
    CAMERA.far = 760;
    TILES.radius = 720;     // fog 0.0034 is 99 % by ~630 m; was 1000, past the far plane
    TILES.levels = 5;
    TILES.split = 1.3;

    // No grass, no shrubs.
    GRASS.enabled = false;
    BUSHES.enabled = false;
    SIGNS.lod = 2;
    SIGNS.drawDistance = 300;
    // The horizon is too close for a city.
    TOWNS.cities = false;
    // The turf's look without its march.
    GROUND.sward.size = 512;
    GROUND.sward.depth = 0;
    GROUND.verge.size = 512;
    GROUND.verge.depth = 0;
    ATMOSPHERE.fxaa = false;
    ROAD_SURFACE.textureSize = 512;
    ROAD_SURFACE.pom.depth = 0;

    // The far tier, all the way in. `nearCap` = 0 builds no near meshes at all.
    TREES.samples = 900;
    TREES.nearCap = 0;
    TREES.farCap = 300;
    TREES.distantCap = 40;
    TREES.distantExtent = 400;
    TREES.picks = 4;
    TREES.behind = 1;
    TREES.ahead = 0;
    TREES.farFadeIn = [6, 16];
    TREES.loneFadeIn = [6, 16];
    TREES.farFade = [280, 345];
    TREES.treegen.lods = TREES.treegen.lods.slice(2)
      .map((L, i) => ({ ...L, from: [0, 250][i] }));
    TREES.treegen.shadowLevels = 0;
    // No tree casts a real shadow on Low: the canopy map is all of them, from the car out.
    TREES.canopyShadow.size = 512;
    TREES.canopyShadow.extent = 900;
    TREES.canopyShadow.fade = [0, 1];
    TREES.treegen.impostorHeight = 128;
  }
  return level;
}

applyGraphics();

/**
 * The tree generator: Settings › Graphics saves it (and reloads, like the
 * level — the library is built at boot); `?trees=legacy|treegen` overrides it
 * for one load. Same try/catch as graphicsLevel: Node's storage throws.
 */
const TREES_KEY = 'highroads.trees';
export const TREE_GENERATORS = ['treegen', 'legacy'];

export function setTreeGenerator(g) {
  if (TREE_GENERATORS.includes(g)) {
    try { localStorage.setItem(TREES_KEY, g); } catch (err) { /* private window */ }
  }
}

try {
  const g = new URLSearchParams(location.search).get('trees') || localStorage.getItem(TREES_KEY);
  if (TREE_GENERATORS.includes(g)) TREES.generator = g;
} catch (err) { /* no location or storage (Node) */ }

/** `?towns=0` drops the settlements for one load (an A/B, probe/perf.mjs QUERY). */
try {
  if (new URLSearchParams(location.search).get('towns') === '0') TOWNS.enabled = false;
} catch (err) { /* no location (Node) */ }

/* ================================================================ terrain == */

/**
 * THE TERRAIN MENU (Settings › Terrain, settings.js): every knob of the world
 * a player may want to turn, in one place. Saved to localStorage and applied
 * below, after the graphics level and before anything is built — so a change
 * rebuilds the world (a reload), like the level. `TERRAIN_SPEC` is the menu:
 * the sheet is built from it, so a knob added there appears in it.
 */
export const TERRAIN = {
  /** The world's climate, a key of `WORLDS`: the whole world is that biome. */
  biome: 'temperate',
  /** Lanes each way: 2 (the dual carriageway) or 1 (a two-lane country road). */
  lanes: 2,
  /** Height of the landforms, × the generator's. */
  relief: 1,
  /** How often each landscape wins, × (0 removes it). */
  mix: { plains: 1, hills: 1, valley: 1, mountain: 1, canyon: 1, plateau: 1 },
  /** Woodland cover, ×; and how tightly it keeps to stands, 0 (scattered) .. 1 (only woods). */
  forest: 1,
  clumping: 0.85,
  /** Ground cover density, ×. */
  grass: 1,
  /** Bare rock and bald soil, ×. */
  rock: 1,
  soil: 1,
  /** −1 lush .. +1 parched. */
  dryness: 0,
  /** Lake chance, ×. */
  lakes: 1,
  /** Cities on the horizon; barriers on bends and drops; sign density, ×. */
  cities: true,
  barriers: true,
  signs: 1,
};

/** The menu, in order: `options` is a segmented switch, `toggle` an on/off, otherwise a slider. */
export const TERRAIN_SPEC = [
  { group: 'Climate' },
  { key: 'biome', label: 'Biome', options: [['temperate', 'Temperate'], ['snow', 'Snowy'], ['desert', 'Desert'], ['fall', 'Fall']],
    hint: 'what the whole world is: green country, deep winter, sand sea or autumn woods' },
  { group: 'Road' },
  { key: 'lanes', label: 'Lanes', options: [[2, 'Four'], [1, 'Two']], hint: 'four lanes, or a two-lane country road' },
  { key: 'barriers', label: 'Barriers', toggle: true, hint: 'steel guardrail and timber fence on bends and drops' },
  { key: 'signs', label: 'Signs', min: 0, max: 2, hint: 'how many roadside signs' },
  { group: 'Landscape' },
  { key: 'relief', label: 'Relief', min: 0.4, max: 1.8, hint: 'height of the hills and mountains' },
  { key: 'mix.plains', label: 'Plains', min: 0, max: 3, hint: 'how often the land lies flat' },
  { key: 'mix.hills', label: 'Hills', min: 0, max: 3, hint: 'rolling hill country' },
  { key: 'mix.valley', label: 'Valleys', min: 0, max: 3, hint: 'connected V-shaped valleys' },
  { key: 'mix.mountain', label: 'Mountains', min: 0, max: 3, hint: 'ridges a kilometre high' },
  { key: 'mix.canyon', label: 'Canyons', min: 0, max: 3, hint: 'tablelands cut by gorges' },
  { key: 'mix.plateau', label: 'Plateaus', min: 0, max: 3, hint: 'terraced escarpments' },
  { key: 'lakes', label: 'Lakes', min: 0, max: 3, hint: 'how often a lake fills a hollow' },
  { group: 'Ground' },
  { key: 'forest', label: 'Forest', min: 0, max: 2, hint: 'how much land the woods cover' },
  { key: 'clumping', label: 'Clumping', min: 0, max: 1, hint: '0 trees scattered everywhere, 1 only in woods' },
  { key: 'grass', label: 'Grass', min: 0, max: 2, hint: 'ground cover density (0 none)' },
  { key: 'rock', label: 'Rock', min: 0, max: 2, hint: 'bare rock on steep faces and crests' },
  { key: 'soil', label: 'Bare soil', min: 0, max: 2, hint: 'bald, eroded ground on slopes' },
  { key: 'dryness', label: 'Dryness', min: -1, max: 1, hint: 'lush green to parched straw' },
  { key: 'cities', label: 'Cities', toggle: true, hint: 'cities on the horizon' },
];

/**
 * THE WORLD BIOMES (`TERRAIN.biome`). Each rewrites the config below before
 * anything builds, so one choice reaches every system:
 *
 *   biomes     which `biomes.js` regions the Worley cells may pick from
 *   relief, mix, roughness   × the landforms (`noise.js`); `dunes` adds a dune field
 *   colors     overrides of `TERRAIN_COLORS` (the ground palette)
 *   tintMix    how much of each region's own ground cast survives (0..1)
 *   rockSlope  ny range over which steep ground goes to bare rock (`_groundColor`)
 *   snowLine   whether high ground still takes snow
 *   ground     overrides of `GROUND` contrast, and `sward` — the relief tile
 *              marched near the car: `kind` grass / leaves / snow / sand
 *   grass      × ground cover; `grassCol` [rgb, share] tufts go toward
 *   bare       species grown without leaves; `snow` lies on every branch (0..1)
 *   fallLeaves every broadleaf in autumn colour; `autumnShare` as in `TREES`
 *   verge      false: no gravel verge, the ground runs to the asphalt (snow)
 *   road       what lies on the carriageway: 'snow' | 'sand' | 'leaves'
 *   sky        × fog colour and density, × exposure, the ground bounce, the grade's
 *              warm/cool pair (`applySky`)
 */
export const WORLDS = {
  temperate: {
    label: 'Temperate',
    biomes: ['meadow', 'broadleaf', 'autumn', 'boreal', 'birchwood', 'savanna', 'mediterranean', 'alpine', 'wetland', 'blossom'],
    grass: 1.8,
  },
  snow: {
    label: 'Snowy',
    biomes: ['boreal', 'birchwood', 'alpine', 'broadleaf'],
    relief: 1.1, mix: { mountain: 1.5, hills: 1.2, plains: 0.8 },
    colors: {
      grassLow: 0xe9eef3, grassHigh: 0xf1f4f7, grassDeep: 0xdde5ee, grassDry: 0xf6f3ec,
      scrub: 0x8b857c, rock: 0x6c6965, dirt: 0xe4e9ee,
      lush: 0xd3deeb, shade: 0xc4d3e6,
      bracken: 0xe2e7ea, heather: 0xdce2e9, fresh: 0xf7f9fb, rush: 0xd0d9e2,
      soil: 0x5a5047, peak: 0xf0f3f6, snow: 0xf2f5f8, sand: 0xe4e9ee, mud: 0x6b7276,
    },
    tintMix: 0.15, rockSlope: [0.9, 0.77], soil: 0.35, verge: false,
    ground: { contrastNear: 0.12, contrastFar: 0.1, sward: { kind: 'snow', tile: 4, depth: 0.07, contrast: 1, fade: [10, 34] } },
    grass: 0.14, grassCol: [[0.62, 0.52, 0.34], 0.85],
    bare: ['oak', 'maple', 'beech', 'birch', 'aspen', 'poplar', 'larch', 'willow', 'cherry', 'olive', 'acacia',
      'elm', 'ancient', 'tupelo',
      'bramble', 'hazel', 'rosebush', 'fern', 'gorse', 'heather', 'lavender', 'reeds'],
    snow: 1,
    road: 'snow',
    sky: { fog: [0.97, 1.0, 1.05], fogDensity: 1.25, exposure: 0.8, hemiGround: 0xdfe6ee, grade: [0xf4efe8, 0x9fb8e0] },
  },
  desert: {
    label: 'Desert',
    biomes: ['erg', 'reg', 'savanna'],
    // Mostly flat: plains and tablelands; the rare jebel and wadi keep it from boredom.
    relief: 0.6, roughness: 0.25, dunes: true,
    mix: { plains: 3, hills: 0.45, valley: 0.15, mountain: 0.12, canyon: 0.6, plateau: 1.1 },
    colors: {
      grassLow: 0xdcbc8c, grassHigh: 0xe0c697, grassDeep: 0xcfa874, grassDry: 0xead3a6,
      scrub: 0xb38c63, rock: 0xa8684a, dirt: 0xb89f7c,
      lush: 0xc0965f, shade: 0xc7a47a,
      bracken: 0xd6a978, heather: 0xae9677, fresh: 0xe6cf9f, rush: 0xa48c63,
      soil: 0xc59c70, peak: 0xc9a07c, snow: 0xc9a07c, sand: 0xe6d3a9, mud: 0x7a6a50,
    },
    tintMix: 0.3, rockSlope: [0.86, 0.68], snowLine: false, soil: 0.2,
    ground: { contrastNear: 0.2, contrastFar: 0.18, sward: { kind: 'sand', tile: 6, depth: 0.05, contrast: 1, fade: [12, 40] } },
    grass: 0.35, grassCol: [[0.78, 0.66, 0.42], 0.5],
    road: 'sand',
    sky: { fog: [1.06, 1.0, 0.88], fogDensity: 1.15, exposure: 0.92, hemiGround: 0xc9a77c },
  },
  fall: {
    label: 'Fall',
    biomes: ['autumn', 'broadleaf', 'birchwood', 'meadow', 'wetland'],
    colors: {
      grassLow: 0x98884a, grassHigh: 0xab9554, grassDeep: 0x78683b, grassDry: 0xbf9252,
      scrub: 0x7c6440, dirt: 0x8e7a5e,
      lush: 0x7b7740, shade: 0x726a49,
      bracken: 0xa95f2e, heather: 0x86584a, fresh: 0xae9d4c, rush: 0x6b5c35,
    },
    tintMix: 0.6,
    ground: { sward: { kind: 'leaves', leaves: 900 } },
    grassCol: [[0.66, 0.55, 0.3], 0.5],
    fallLeaves: true, autumnShare: 0.35,
    road: 'leaves',
    sky: { fog: [1.04, 1.0, 0.92] },
  },
};

/** The world biome in force this load (`TERRAIN.biome`), set by `applyTerrain`. */
export let WORLD_BIOME = WORLDS.temperate;

const TERRAIN_KEY = 'highroads.terrain';
const TERRAIN_DEFAULTS = JSON.parse(JSON.stringify(TERRAIN));
const pathGet = (o, k) => k.split('.').reduce((a, p) => (a == null ? a : a[p]), o);
const pathSet = (o, k, v) => {
  const ps = k.split('.');
  const last = ps.pop();
  ps.reduce((a, p) => a[p], o)[last] = v;
};

/** A knob's saved value if it is a valid one for it, else undefined. */
function terrainValue(spec, v) {
  if (spec.toggle) return typeof v === 'boolean' ? v : undefined;
  if (spec.options) return spec.options.some(([o]) => o === v) ? v : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(spec.max, Math.max(spec.min, v)) : undefined;
}

/** The knob values in force this load, `{ key: value }` (dotted keys). */
export function terrainSettings() {
  if (chosen) return { ...chosen };
  const out = {};
  for (const sp of TERRAIN_SPEC) if (sp.key) out[sp.key] = pathGet(TERRAIN, sp.key);
  return out;
}
/** The knobs as chosen, before the world biome scaled any of them. */
let chosen = null;

export const terrainDefault = (key) => pathGet(TERRAIN_DEFAULTS, key);

/** Saves `{ key: value }`; the next load builds the world from it. Null resets. */
export function saveTerrain(values) {
  try {
    if (values) localStorage.setItem(TERRAIN_KEY, JSON.stringify(values));
    else localStorage.removeItem(TERRAIN_KEY);
  } catch (err) { /* private window, Node */ }
}

function applyTerrain() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(TERRAIN_KEY) || 'null'); } catch (err) { /* Node, bad JSON */ }
  // `?terrain={"lanes":1}` overrides the saved knobs for one load: a world's
  // settings shared as a link, like its seed (and the probes' A/B).
  try {
    const q = JSON.parse(new URLSearchParams(location.search).get('terrain') || 'null');
    if (q && typeof q === 'object') saved = { ...saved, ...q };
  } catch (err) { /* no location (Node), bad JSON */ }
  if (saved && typeof saved === 'object') {
    for (const sp of TERRAIN_SPEC) {
      if (!sp.key) continue;
      const v = terrainValue(sp, saved[sp.key]);
      if (v !== undefined) pathSet(TERRAIN, sp.key, v);
    }
  }

  chosen = terrainSettings();
  applyWorld(WORLDS[TERRAIN.biome] || WORLDS.temperate);

  // The road's width, and everything sized off it.
  ROAD.lanesPerSide = TERRAIN.lanes;
  ROAD.halfWidth = ROAD.laneWidth * TERRAIN.lanes;
  const edge = ROAD.halfWidth + ROAD.shoulder;
  GROUND.verge.band = [edge - 0.4, edge + 4.5];
  SIGNS.gantryLeg = ROAD.halfWidth + 3.8;
  SIGNS.gantryShift = ROAD.halfWidth / 2;
  SIGNS.cantileverSpan = ROAD.halfWidth + 3.1;
  // Gantries belong to a dual carriageway; a country road carries fewer cars.
  if (TERRAIN.lanes < 2) {
    SIGNS.mix.portal = 0;
    SIGNS.mix.cantilever = 0;
    TRAFFIC.count = Math.round(TRAFFIC.count * 0.7);
  }

  if (TERRAIN.signs <= 0) SIGNS.enabled = false;
  SIGNS.featureChance = Math.min(1, SIGNS.featureChance * TERRAIN.signs);
  SIGNS.chevronStep /= Math.max(0.35, TERRAIN.signs);
  if (TERRAIN.grass <= 0) GRASS.enabled = false;
  GRASS.density *= TERRAIN.grass;
  GRASS.wood.density *= TERRAIN.grass;
  TOWNS.cities = TOWNS.cities && TERRAIN.cities;
  BARRIERS.enabled = BARRIERS.enabled && TERRAIN.barriers;
}

/** Rewrites the config for one world biome (see `WORLDS`). */
function applyWorld(W) {
  WORLD_BIOME = W;
  if (W.relief) TERRAIN.relief *= W.relief;
  for (const k in W.mix || {}) TERRAIN.mix[k] *= W.mix[k];
  if (W.soil != null) TERRAIN.soil *= W.soil;
  Object.assign(TERRAIN_COLORS, W.colors);
  const G = W.ground || {};
  for (const k of ['contrastNear', 'contrastFar']) if (G[k] != null) GROUND[k] = G[k];
  if (G.sward) {
    // Low graphics marches nothing (depth 0); a world keeps that.
    const depth = GROUND.sward.depth;
    Object.assign(GROUND.sward, G.sward);
    if (!depth) GROUND.sward.depth = 0;
  }
  if (W.grass != null) {
    GRASS.density *= W.grass;
    GRASS.wood.density *= W.grass;
  }
  if (W.autumnShare != null) TREES.autumnShare = W.autumnShare;
  if (W.verge === false) GROUND.verge.enabled = false;
}

applyTerrain();
// Cities are all there is of the towns now: none, nothing to plan.
if (!TOWNS.cities) TOWNS.enabled = false;
