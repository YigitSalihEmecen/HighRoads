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
  halfWidth: 7.4,
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
  ahead: 6,

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

  /** Lateral extent of generated terrain — matched against ATMOSPHERE.fogDensity. */
  halfExtent: 700,
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
 * The canopy — see `src/env/trees.js`, `src/env/lowpoly.js` and `src/foliage.js`.
 * Both tiers are opaque, untextured, faceted solids; no atlas, no billboard.
 */
export const TREES = {
  enabled: true,

  /** Geometries built per species at boot, and species drawn per chunk. */
  variants: 3,
  picks: 6,

  /** How far a single face's colour may stray from its palette, +/-. */
  faceJitter: 0.075,

  /** How much bigger a far tree's lumps are, as an exponent on the count ratio. */
  lodGrow: 0.42,

  /** Where the near tier hands over to the far one, metres of camera distance. */
  lodFade: [260, 420],
  farFadeIn: [260, 420],
  /** Where the far tier stops. */
  farFade: [620, 720],

  /** Fade-in for a far tree with NO near mesh behind it, metres. */
  loneFadeIn: [480, 660],

  /** Scatter attempts per chunk, and the caps on what survives. */
  samples: 2000,
  nearCap: 120,
  farCap: 760,

  /** Chunks either side of the car that carry the NEAR canopy. */
  behind: 2,
  ahead: 4,

  /** Vegetation is placed around cluster seeds rather than independently. */
  clusterCount: 9,
  clusterShare: 0.72,
  clusterSpecies: 0.8,

  /** What weight a guild-mate keeps inside another species' stand. */
  clusterMix: 0.22,

  /** Stand radius, metres, on a power law. */
  clusterRadius: [11, 78],

  /** How hard a stand thins toward its rim. */
  clusterFalloff: 1.6,

  /** Crown spacing: two crowns may overlap by this much of their radii. */
  crownGap: 0.5,
  spacingCell: 14,

  /** Age structure inside a stand. */
  vigour: 0.42,
  saplings: 0.18,

  /** Chance a placed tree gets a second stem from the same stool, touching. */
  coppice: 0.14,

  /**
   * Ground colour taken and per-tree variance. The hue is in the GEOMETRY —
   * see `foliage.js:TREE_FORMS`.
   */
  groundTint: 0.16,
  instanceVary: 0.14,
  /** Sharpens stand edges — density squared, then scaled by this. */
  standBias: 2.7,

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
 * The understorey — see `src/env/bushes.js`.
 * Small, numerous, placed on the woodland EDGE rather than inside or outside it.
 */
export const BUSHES = {
  enabled: true,

  variants: 3,
  picks: 2,

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

  /** Tufts per square metre at the verge, before rejections. An ask, not a count. */
  density: 3.6,
  /** Lateral band: from the paved edge out to here, metres. */
  halfExtent: 62,
  /** Full density out to here, then tapering to nothing at `halfExtent`. */
  denseTo: 34,

  /** Camera distance over which a tuft shrinks away, metres. */
  fadeStart: 140,
  fadeEnd: 240,

  /** How much larger a tuft grows at the edge of the band than at the verge. */
  farScale: 1.0,

  /** Chunks either side of the car that carry grass. 1 = three chunks, 360 m. */
  chunkRadius: 1,
  /** Grass chunks built per frame. Scattering one is thousands of samples. */
  buildPerFrame: 1,

  /** Tuft height, metres. */
  height: [0.55, 1.25],
  /** Width as a fraction of height. A square-ish card overlaps into a field. */
  widthRatio: 0.95,

  /** Steepest ground grass grows on. */
  maxSlope: 1.6,

  /** Wind direction (world XZ), strength in metres of tip travel, and rate. */
  windDir: { x: 0.86, z: 0.51 },
  windStrength: 0.22,
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
    halfExtent: 120,
    /** Tufts per square metre asked, before `floor` scales it down. */
    density: 1.35,
    /** Height range, metres. */
    height: [1.1, 2.4],
    /** Nearly square, so neighbours overlap into a surface. */
    widthRatio: 0.82,
    /** Still brighter than the ground it stands on. */
    lift: [1.02, 1.28],
    /** As many blades as the roadside card. */
    bladesPerCard: 7,
    /** Shrinks out here. */
    fadeOut: [78, 118],
    maxSlope: 1.2,
  },

  /** The SECOND tier: the middle distance. */
  far: {
    enabled: true,
    behind: 1,
    ahead: 6,
    /** Lateral band, metres. Past this the terrain's detail texture takes over. */
    halfExtent: 185,
    /** Card size: 1.0x so distant grass blades match foreground ones. */
    widthScale: 1.0,
    heightScale: 1.0,
    /** Density, as a fraction of what would preserve ground cover at that scale. */
    coverage: 0.05,
    /** Grows in over this camera-distance window, behind the near tier's fade. */
    fadeIn: [190, 260],
    /** And shrinks out again here — the grass's own far edge, up against the fog. */
    fadeOut: [420, 630],
    /** Steepest ground it will stand on, looser than the near tier. */
    maxSlope: 2.2,
  },
};

/**
 * The carriageway surface — see `env/road.js`.
 */
export const ROAD_SURFACE = {
  /** One mask, three channels: aggregate, wear, cracks. */
  textureSize: 512,

  /** Metres per tile, near and far — deliberately not a round ratio. */
  tileNear: 2.4,
  tileFar: 17,

  /** How much of each mask reaches the albedo. */
  contrastNear: 1.10,
  contrastFar: 0.62,

  /** Where the aggregate stops, metres. */
  nearFade: [26, 90],

  /** Dry asphalt. Real values are 0.92-0.98; wet would be under 0.4. */
  roughness: 0.95,
  /** How far the wear channel may polish the surface back down. */
  polish: 0.22,

  /** Ridged noise above this becomes a crack, and this much darker. */
  crackThreshold: 0.72,
  crackDepth: 0.42,
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
};

/**
 * Procedural stone — see `env/rocks.js`. Chips on the shoulder-to-grass verge,
 * talus spilling from cuttings.
 */
export const ROCKS = {
  enabled: true,

  /** Chunks either side of the car that carry stone. */
  behind: 1,
  ahead: 4,

  /** Scatter attempts per chunk. Concentrated on the road-to-grass verge. */
  samples: 4000,

  /** How many of each class's variants any ONE chunk may use. */
  variantsPerChunk: 2,

  /** Where stone is allowed, in metres of lateral offset from the centreline. */
  band: [9.8, 16.0],

  /** Cut faces: where the terrain is steeper than this, stone is far more likely. */
  screeSlope: 0.62,

  /** Relative weight of each class on ordinary ground, and on a cut face. */
  mix: { scree: 0.62, stone: 0.31, boulder: 0.07 },
  screeMix: { scree: 0.86, stone: 0.13, boulder: 0.01 },

  /**
   * Stone hues, one drawn per instance. Stone does not take the ground's
   * colour — rule 5 of `src/env/README.md`; the luminance is in the geometry.
   */
  palette: [
    [0.55, 0.55, 0.55],  // medium granite grey
    [0.62, 0.60, 0.58],  // light warm granite
    [0.46, 0.46, 0.47],  // cool slate
    [0.52, 0.47, 0.40],  // earthy warm stone
    [0.43, 0.39, 0.34],  // dark earth stone
    [0.64, 0.61, 0.55],  // sandy limestone
    [0.35, 0.34, 0.33],  // charcoal basalt
  ],
  /** Per-instance brightness jitter around the palette entry. */
  shade: [0.85, 1.15],

  /** Size classes: detail = icosahedron subdivision; flatten = vertical squash. */
  classes: {
    scree: {
      variants: 5, detail: 0, size: [0.10, 0.34],
      flatten: [0.34, 0.66], facets: 4, roughness: 0.42,
      // A 15 cm chip is three texels, so its shadow is noise.
      shadow: false,
    },
    stone: {
      variants: 5, detail: 1, size: [0.32, 0.95],
      flatten: [0.40, 0.78], facets: 5, roughness: 0.34,
    },
    boulder: {
      variants: 4, detail: 1, size: [1.0, 2.6],
      flatten: [0.55, 0.92], facets: 6, roughness: 0.30,
    },
  },
};

/**
 * Wind noise — see `wind.js`. The one sound the engine simulator cannot make;
 * every number here was chosen by listening.
 */
export const WIND = {
  /** Master level for the whole layer, 0..1. Exposed in the settings drawer. */
  volume: 0.45,

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
    max: 260,
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

    /** The "wheelspin, not speed" gate, m/s. Emission fades out across this range. */
    speedFade: [14, 34],

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
  /** Traction control: how far drive torque may exceed the friction left after cornering. */
  tractionControl: 2.0,

  /** Effective mass per tyre for the low-speed velocity-cancelling fallback. */
  lateralGripMass: 0.30,
  /** Handbrake kills most of the rear lateral grip => predictable drifts. */
  handbrakeGripMul: 0.28,
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

  /** Slide containment — where a drift stops being a drift and becomes a spin. */
  driftAngle: 0.50,        // ~29 deg — past any ordinary slide
  spinAngle: 1.05,         // ~60 deg — past here the car is going round
  spinRecovery: 1.9,       // damper strength, N·m·s per rad/s per kg

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
  /** Cars kept alive around the player. */
  count: 9,

  /** Populated band, and where inside it a car may appear — cars spawn in the haze. */
  spawnMin: 430,
  ahead: 620,
  behind: 240,
  /** Share of spawns that come the other way. */
  oncomingShare: 0.42,

  speedMin: 17,
  speedMax: 31,
  speedFloor: 6,
  /** Bumper-to-bumper minimum, plus this much per m/s of speed. */
  minGap: 16,
  headway: 0.9,
  accelRate: 0.55,
  brakeRate: 2.4,
  /** Lateral acceleration traffic is willing to use through a corner. */
  cornerAccel: 6.5,

  /** How far back a driver notices someone coming up behind. */
  noticeRange: 90,
  /** Flashed: slow to this fraction of cruise while pulling aside. */
  yieldSlow: 0.7,
  /** Tailgated without a flash: most drivers find a little more speed. */
  pressedBoost: 1.16,
  changeCooldown: 3.5,
  laneRate: 1.1,

  // ------------------------------------------------------------- impacts --
  /** Bounciness of a car-to-car hit. Sheet metal is not a squash ball. */
  restitution: 0.15,
  /** Ceiling on the speed change one impact may hand the player, m/s. */
  maxImpactDv: 11,
  /** Seconds a struck car spends spinning out before it is taken away. */
  spinTime: 4.5,
  /** How fast a spinning car sheds speed, m/s². */
  spinDecel: 5.5,
};

export const CAMERA = {
  fov: 62,
  near: 0.4,
  /** `far` pulled in to match the fog wall for depth precision; nothing exists past ~700 m. */
  far: 1500,
  /**
   * Chase rig: distance / height / look-ahead, metres. `zoom` scales how much
   * the rig opens out with speed; the close camera stays put.
   */
  chase: { dist: 4.8, height: 2.30, ahead: 6.0, zoom: 1.0 },
  close: { dist: 4.2, height: 1.80, ahead: 4.8, zoom: 0.5 },
  /** Height of the point the camera aims at, above the contact plane. */
  aimHeight: 0.95,
  /**
   * The rig scales with the vehicle's body size, clamped to the extremes.
   */
  bodyRef: 1.45,
  heightScaleMax: 1.75,
  distScaleMax: 1.35,
  /** Positional and rotational smoothing rates (higher = stiffer). */
  posDamp: 9.5,
  aimDamp: 12.0,
  /** How the rig opens out with speed — pull-back complete at `speedRef`. */
  speedRef: 68,
  speedLag: 0.5,
  /** How far the rig backs off and lifts at full speed, metres. Kept small. */
  distGain: 0.25,
  heightGain: 0.08,
  /** Degrees of extra field of view at full speed — most of the speed cue. */
  fovSpeedGain: 12,
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
  fogDensity: 0.0022,

  skyTop: 0x7ba4ce,
  skyZenith: 0x3f6ea8,
  skyHorizon: 0xdde3e2,
  sunColor: 0xfff4e6,
  sunIntensity: 2.4,

  hemiSky: 0xd2e2f2,
  hemiGround: 0xa39c8c,
  /** Deliberately high: this is what lifts the shadows and kills the contrast. */
  hemiIntensity: 1.5,

  /** Sun well above the horizon — the single biggest lever on "sunset vibe". */
  sunDir: { x: -0.34, y: 0.62, z: -0.71 },

  shadowRadius: 78,
  shadowMapSize: 2048,

  /** Post-processing. Bloom is now a hint of glow, not a glare. */
  bloomStrength: 0.10,
  bloomThreshold: 0.95,
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
  peak: 0xa9a29a,
  snow: 0xe8ebee,
};

/* =============================================================== graphics == */

/**
 * The three levels of graphical fidelity, chosen from the title screen or the
 * settings panel. The override below REWRITES parts of the config objects
 * before assets build, so changing level saves and reloads the page.
 *
 *   HIGH    the current defaults — dense woods, long draw distance.
 *   MEDIUM  half the draw distance, and about half of everything in it.
 *   LOW     the FAR TIER ONLY — no near canopy, no grass, no shrubs, no stone.
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
    ATMOSPHERE.fogDensity = 0.0034;
    CAMERA.far = 1000;

    // A thinner wood: `farCap` falls further than `nearCap` (a far tree is
    // fifty triangles to a near one's five, over two more chunks).
    TREES.samples = 1200;
    TREES.nearCap = 76;
    TREES.farCap = 380;
    TREES.picks = 4;
    TREES.ahead = 3;
    TREES.farFade = [430, 470];
    TREES.loneFadeIn = [300, 460];

    // Grass, shrubs and stone scale down together.
    GRASS.density = 2.3;
    GRASS.far.ahead = 4;
    GRASS.far.fadeOut = [300, 460];
    BUSHES.samples = 600;
    BUSHES.cap = 72;
    ROCKS.samples = 2200;
  } else if (level === 'low') {
    // The shortest draw distance, and a fog that ends it invisibly.
    CHUNK.ahead = 3;
    ATMOSPHERE.fogDensity = 0.0044;
    CAMERA.far = 700;

    // No grass, no shrubs, no stone.
    GRASS.enabled = false;
    BUSHES.enabled = false;
    ROCKS.enabled = false;

    // The far tier, all the way in. `nearCap` = 0 builds no near meshes at all.
    TREES.samples = 900;
    TREES.nearCap = 0;
    TREES.farCap = 300;
    TREES.picks = 4;
    TREES.behind = 1;
    TREES.ahead = 0;
    TREES.farFadeIn = [6, 16];
    TREES.loneFadeIn = [6, 16];
    TREES.farFade = [280, 345];
  }
  return level;
}

applyGraphics();
