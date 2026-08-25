/**
 * config.js — every tunable in one place.
 *
 * Units are SI throughout: metres, kilograms, seconds, newtons, radians.
 * The vehicle numbers are physically plausible but deliberately biased toward
 * "grippy and forgiving" — this is a cruiser, not a simulator.
 */

export const WORLD = {
  seed: 'highroads-01',

  /** Slightly heavier than Earth: makes landings snappy and reduces float. */
  gravity: -16.0,

  /** Physics runs on a fixed 120 Hz clock, decoupled from the render loop. */
  fixedStep: 1 / 120,
  /**
   * Substeps one frame may run, and therefore the longest frame the simulation
   * will follow in real time: `maxSubSteps * fixedStep` = 50 ms, or 20 fps.
   *
   * This is the spiral-of-death guard and it is also, deliberately, the ONLY
   * place the frame-time ceiling is expressed — `main.js` clamps `dt` to
   * exactly this product rather than to a separate magic number. When those two
   * disagreed, they did so silently and expensively: the clamp was 50 ms while
   * the budget covered only 41.7 ms, so every frame between those bounds ran
   * the physics short and threw the remainder away. On a 90 ms hitch the world
   * advanced 46% of what the rest of the frame assumed, which read as the car
   * being yanked backwards. Keeping the ceiling derived means the accumulator
   * always drains and no time is ever lost inside the clamp.
   */
  maxSubSteps: 6,
};

export const ROAD = {
  /** Spacing between spline control points. Catmull-Rom interpolates between. */
  ctrlSpacing: 46,
  /** Arc-length sample spacing along the spline (the lookup-table resolution). */
  sampleStep: 2.5,

  /**
   * Four lanes, two each way. 3.7 m is real motorway width, and it is sized off
   * the widest thing in the roster rather than picked for looks: the Military
   * Vehicle is 3.28 m across and the Monster Truck 2.95 m, so a 2.9 m lane did
   * not physically contain either of them.
   */
  laneWidth: 3.7,
  halfWidth: 7.4,
  /** Paved shoulder beyond the lane markings before terrain blending starts. */
  shoulder: 2.0,

  /**
   * Peak curvature, in radians per metre. 1/165 keeps the minimum radius above
   * ~165 m, which matters for more than feel: the terrain grid is parameterised
   * in road space, so a radius tighter than the corridor half-width would make
   * the lateral rays self-intersect and fold the mesh.
   */
  maxCurvature: 1 / 165,
  /** How fast the curvature itself is allowed to change (noise frequency). */
  curveFreq: 0.055,

  /** Max road gradient (rise over run) — 9.5% is a steep-but-real mountain road. */
  maxGrade: 0.095,
  /**
   * Limit on how fast the *gradient itself* may change, per control point.
   * This is the vertical-curve constraint real alignments are designed to, and
   * without it the grade can swing from +9.5% to -9.5% across one 46 m span:
   * vertical acceleration is v^2 times the curvature, so at 160 km/h that
   * throws the car clean off the road. 0.05 per span keeps it under ~2.5 m/s^2.
   */
  maxGradeChange: 0.05,
  /** Elevation smoothing applied to control points (0 = follow terrain exactly). */
  elevationSmoothing: 0.55,

  /**
   * Banking. bank = curvature * bankGain, clamped. Physically this is
   * tan(θ) = v²/(R·g) with a design speed baked into the gain; 35 puts a
   * typical 400 m sweeper at ~4% and only the tightest corners on the clamp.
   */
  bankGain: 35,
  maxBank: 0.075,

  /**
   * Cut-and-fill, which is what a real alignment does and what replaced the old
   * smoothstep blend. Ground height is simply clamped between two planes rising
   * and falling from the road edge:
   *
   *     y = clamp(natural,  roadY - fillSlope*d,  roadY + cutSlope*d)
   *
   * Everything falls out of that one expression: both sides cut in a valley,
   * one cut and one filled on a mountainside, both filled on a causeway, and a
   * rock cutting where the road punches through a ridge. Steeper cut than fill,
   * because rock stands where loose fill will not.
   */
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
 * Road routing — how the alignment chooses where to go.
 *
 * The old generator integrated a heading from two octaves of noise and then
 * chased a smoothed terrain elevation. It was completely BLIND to the shape of
 * the ground: it wandered by noise and bulldozed whatever it met, which is why
 * every drive felt the same and why the road spent so much of its life in a
 * cutting or on an embankment for no visible reason.
 *
 * This replaces it with the standard approach from the literature — Galin et
 * al., *Procedural Generation of Roads* (Computer Graphics Forum, 2010), where
 * the alignment is the minimum of a cost function over terrain slope, curvature
 * and obstacles — adapted to the one constraint that paper does not have: this
 * world is INFINITE and streams. There is no global heightmap to run A* over
 * and no destination to route to, so the global search becomes a GREEDY
 * LOOKAHEAD: at every control point, fan out a set of candidate headings, score
 * each one over the span it would create, and commit to the cheapest. O(1) per
 * control point, and the road can still be extended forever.
 *
 * The reason this produces "intentional" roads is worth stating plainly,
 * because it is not obvious that a cost function buys character. On a hillside,
 * a road running ALONG the contour needs almost no earthwork; one running
 * across it needs a deep cut on the uphill side and a tall fill on the
 * downhill. Minimising earthwork therefore makes the road contour around hills,
 * run along valley floors, and climb in traverses instead of straight up —
 * every one of which is a thing real surveyors do for the same reason. Nothing
 * here says "follow the hillside". It says "do not move earth", and following
 * the hillside is what that turns out to mean.
 */
export const ROUTE = {
  /**
   * Candidate headings fanned out per control point, across the full legal turn
   * either way. Odd, so that "straight on" is always among them.
   */
  candidates: 13,

  /**
   * How far the corridor is sampled either side of the candidate centreline
   * when estimating earthwork, and how many probes across it.
   *
   * This has to be WIDER than the carriageway, and by a lot. Earthwork is not
   * about the road surface — that is flat by construction — it is about the cut
   * and fill slopes running out from the verge, which is where the volume is
   * and what the eye actually reads as a scar.
   */
  corridor: 38,
  probes: 5,
  /** Stations sampled along each candidate span. */
  stations: 3,

  /**
   * Detail level the router sees, as a `terrain.height` lateral argument.
   *
   * Deliberately coarser than the surface the mesh builds. The router is
   * choosing a route through a LANDFORM; letting it see 7 m bumps makes it
   * swerve around things that the cut-and-fill clamp will flatten anyway.
   */
  lod: 90,

  /** Ride height of the finished carriageway over the natural surface. */
  rideHeight: 0.9,

  // ---- cost weights. Relative only; the winner is an argmin. -------------
  /**
   * Earthwork is a BUDGET, not an objective, and finding that out cost a
   * rewrite.
   *
   * Minimising it outright works exactly as the literature says and produces
   * the wrong road: measured against the old noise generator it cut mean
   * earthwork 6.4 m → 4.9 m and simultaneously cut sidehill cross-sections
   * 12% → 8%, because the cheapest place to put a road is a flat field. The
   * router had found the boring routes, efficiently.
   *
   * So earthwork costs nothing at all up to `earthFree` and then bites hard.
   * Below the threshold the router is indifferent between a level road and a
   * shelf cut into a hillside, which lets the terms below — the ones that are
   * actually about the drive — decide. Above it, no amount of view justifies
   * a fifteen-metre cutting.
   */
  earthFree: 7.0,
  /**
   * Raised from 2.4 when the terrain's vertical scale roughly tripled (see
   * `noise.js:continent` and `mountainH`). The budget is the same 7 m; what
   * changed is that in country with 600 m of local relief the router now MEETS
   * that budget everywhere, so the slope of the penalty past it is what decides
   * whether it traverses a hillside or bulldozes across it. At 2.4 it bulldozed
   * — mean earthwork 11.2 m over four seeds, which is a motorway cutting for
   * most of the drive. Swept: 6.0 gives 8.9 m and takes the sidehill share from
   * 48% to 58%, which is the same road being built by going round rather than
   * through.
   */
  wEarthwork: 6.0,
  /** Steepness, as a fraction of the legal maximum, squared. */
  wGrade: 14,
  /**
   * Turn taken, and the CHANGE in turn between spans.
   *
   * Both were three times this and the result was a road that barely turned at
   * all — one seed measured a 95th-percentile curvature of 0.00 mrad/m, which
   * is a straight line four kilometres long. A cost function will happily buy
   * smoothness with every corner you have if you let it.
   */
  wTurn: 2.5,
  wTurnChange: 12,
  /**
   * Deviation from the intended bearing.
   *
   * The one term that stops the road being clever to death. Pure earthwork
   * minimisation on a hillside is a contour line, and a contour line around a
   * hill is a CIRCLE — the road would spiral and never arrive anywhere. A
   * slowly drifting compass bearing gives it somewhere to be going, and the
   * terrain decides how it gets there. That is also what a real alignment is:
   * two fixed points, and a survey party arguing about the middle.
   */
  wBearing: 8,
  // Swept over six seeds against shelf share, earthwork and net progress. 5
  // bought a couple more points of shelf and took the worst seed's progress to
  // 0.07 — a road going nowhere. 8 is the largest value that never spiralled.
  /** How fast the intended bearing drifts, in radians per metre of road. */
  bearingDrift: 0.0016,

  // ---- character. What makes one stretch of road unlike another. --------
  /**
   * Scale over which the route's personality changes, in metres.
   *
   * 2.2 km, so a drive has chapters rather than moods: long enough to settle
   * into a valley and come out of it, short enough that a ten-minute run is not
   * all one thing.
   */
  characterScale: 2200,
  /**
   * How far the personality can push the earthwork weight down. At 1 the router
   * ignores earthwork entirely on its most direct setting and drives straight
   * through hills in cuttings, which is a real kind of road and a good contrast
   * to the contour-hugging one.
   */
  directness: 0.72,
  /**
   * Reward for seeking high ground or low ground, per metre of elevation
   * difference from the neighbourhood. The sign comes from the character noise,
   * so the road spends a while preferring ridgelines and a while preferring
   * valley floors.
   */
  wSeek: 0.55,
  /**
   * Reward for a genuine SHELF: ground rising on one side of the road while it
   * falls away on the other.
   *
   * This is the "driving along the side of a hill" term and it is the single
   * most important number in the block. It is not the same as rewarding a big
   * height difference across the corridor — a road on top of a ridge has that
   * too, with both sides falling. This scores `min(rise, fall)`, which is zero
   * unless one side really is up and the other really is down.
   */
  wShelf: 2.4,
  /**
   * Reward for being in interesting country at all: the vertical range of the
   * ground across the corridor.
   *
   * Without it the router is content on a plain, because a plain satisfies
   * every engineering term perfectly. This is what sends the road looking for
   * hills to be on the side of.
   */
  wRelief: 0.85,

  /**
   * SELF-AVOIDANCE. The road must not come back alongside itself.
   *
   * Not an aesthetic rule — a structural one, and the new router is what made
   * it necessary. Every chunk carries terrain out to `CHUNK.halfExtent` (700 m)
   * either side while being only `CHUNK.length` (120 m) long, so a chunk's
   * sheet covers an enormous area. Where two stretches of road pass near each
   * other, each one's sheet is carved for ITS road and is natural ground over
   * the other's — so one carriageway ends up with a hillside lying across it.
   *
   * Measured: with the cost router turning consistently to follow a contour,
   * chunk 0's carriageway was being covered by chunk 23's sheet, 2.8 km away
   * along the road and doubled back to within a few hundred metres of it. The
   * old noise generator wandered too incoherently to loop like that; a router
   * that follows hillsides does it readily, because going round a hill is what
   * following a contour means.
   *
   * So: candidates that come within `selfClear` of any part of the road between
   * `selfNear` and `selfFar` behind are penalised, hard and smoothly. The band
   * matters at both ends — closer than `selfNear` is simply the road you are
   * on, and further than `selfFar` cannot be loaded at the same time.
   */
  selfNear: 260,
  selfFar: 1600,
  selfClear: 300,
  wSelf: 900,

  /**
   * Distance over which a candidate must beat the incumbent to be chosen, as a
   * fraction of the incumbent's cost. Without a margin the argmin flickers
   * between near-equal candidates from one span to the next, and the road gets
   * a fine tremor that reads as noise rather than as decision.
   */
  hysteresis: 0.04,
};

export const CHUNK = {
  /** Length of one chunk along the road, in metres. */
  length: 120,
  /** Longitudinal subdivisions per chunk (120 / 48 = 2.5 m quads). */
  segmentsU: 48,

  /**
   * Chunks kept behind / ahead. Matched to the fog depth: at 720 m ahead the
   * fog already leaves under 2% of the colour, so building further is paying
   * full geometry cost for something invisible.
   */
  behind: 2,
  ahead: 6,

  /** Chunks built per frame once running — keeps frame spikes bounded. */
  buildPerFrame: 1,
  /** Built synchronously before the first frame so the car has ground. */
  preload: 5,

  /**
   * Drainage ditch depth just off the shoulder. Kept shallow and wide: this
   * sits exactly where a car leaves the road, and a deep narrow one is a hit
   * rather than a feature.
   */
  ditchDepth: 0.3,
  ditchWidth: 9,
  /** Distance past the verge over which the road's cross-slope dies away. */
  bankRunout: 22,

  /**
   * Lateral sampling stays this fine out to `nearBand`, then grows
   * geometrically. The band has to cover everywhere the car can plausibly
   * drive: beyond it the columns were reaching 12–16 m apart against 2.5 m
   * rows, and those sliver triangles are what the car catches on off-road.
   */
  nearStep: 2.4,
  nearBand: 78,

  /**
   * Lateral extent of generated terrain. This has to be matched against
   * ATMOSPHERE.fogDensity: at 170 m the exponential fog still leaves ~80% of
   * the terrain colour showing, so the edge of the world was plainly visible
   * off to the sides. The columns out here are tens of metres apart, so buying
   * the extra distance costs almost nothing.
   */
  halfExtent: 700,
  /** Props stop well short of the terrain edge — nothing out there reads anyway. */
  propExtent: 210,
  /** Scatter attempts per chunk. Most are rejected by the suitability rules. */
  propSamples: 420,
  /**
   * Vegetation is placed around a handful of cluster seeds rather than
   * independently. Independent draws give a statistically even field, which is
   * precisely the "scattered around to fill space" look; clumping produces
   * thickets and copses with real clearings between them.
   */
  clusterCount: 7,
  clusterShare: 0.62,
  /** Sharpens stand edges — density is squared, then scaled by this. */
  standBias: 1.7,
  /**
   * The outermost band tilts gently away below the eyeline so the corridor ends
   * by sloping out of sight rather than at a clean cut edge.
   *
   * Kept shallow, and this is measured rather than taste. Out here the fold
   * guard already skews cells — it maps lateral offsets through a curvature
   * that changes from row to row, so a quad 600 m out is a parallelogram — and
   * every terrain cell in the corridor whose faces meet at more than 60 degrees
   * is on the inside of a bend for that reason. Adding a steep drop on top
   * takes those from 3 to 8 and the worst from 72 to 87 degrees, which reads as
   * a jagged dark band along the horizon. At 520 m the fog has taken half the
   * colour and at 700 m nearly all of it, so a 30 m drop hides the edge
   * perfectly well and costs none of that.
   */
  horizonFalloff: 520,
  horizonDrop: 30,
  /**
   * Master switch for the tree scatter.
   *
   * OFF. The measured cost is 468 instances for **1,030,000 triangles** — 90%
   * of the geometry on screen, against 109,000 for the whole terrain sheet —
   * because the Quaternius canopies are solid meshes at 1,700–2,900 each. What
   * that buys is 10.3 trees per hectare, where real woodland is 200–1,000.
   *
   * Be clear about what this switch is and is not. It is not a fix: the trees
   * were the only vertical thing in the world and the horizon is emptier
   * without them. It is the honest way to hold a triangle budget until the
   * canopy has a level of detail worth spending it on — distant trees as
   * two-triangle impostors rendered once per species at boot, which is what
   * makes thousands affordable where hundreds are not.
   *
   * Turning it back on is this line. Nothing else changed; `foliage.js` and the
   * whole scatter are intact.
   */
  trees: false,

  /**
   * How far BELOW another pass of the road a chunk's far sheet is pushed where
   * the two overlap, metres. See `chunks.js:sampleGround`.
   *
   * The problem this solves is bug #55 and it is structural: a chunk carries
   * terrain to `halfExtent` (700 m) either side while being `length` (120 m)
   * long, so wherever the route doubles back within 700 m — which a router that
   * follows contours does readily — one chunk's sheet covers another chunk's
   * road. That sheet is natural ground over there, and the road under it is in
   * a cutting, so what the player meets is a hillside standing on the
   * carriageway. Measured on the default seed: a 2.6 m step across the road at
   * s = 2827, put there by a chunk 720 m further along.
   *
   * `ROUTE.selfClear` cannot fix it. It keeps the two carriageways 300 m apart;
   * the sheets are 700 m wide.
   *
   * So the far sheet is cut down to the foreign road's own plane, by the same
   * cut ramp the road's own earthwork uses — and then this much further, so the
   * two surfaces never fight for the same depth. The finer, correctly carved
   * sheet that belongs to that road is drawn on top and hides the whole thing;
   * what is left underneath is invisible geometry rather than a wall. Lowering
   * only, never lifting: a clamp that can raise ground is a clamp that can bury
   * a road, which is the bug.
   */
  foreignSink: 4.0,
  /**
   * Gradient of that cut, rise over run.
   *
   * MUCH shallower than `ROAD.cutSlope`, and the reason is the resolution of
   * the sheet doing the cutting, not anything about earthwork. Out where a
   * foreign road turns up, the lateral columns are 55 m apart; the clamp is a
   * V and the mesh draws the CHORD across it, which sits above the true bottom
   * by roughly slope x spacing / 2. At the road's own 62% that is 17 m of
   * terrain standing over the carriageway — measured, and it is why the first
   * version of this fix removed nothing at all. At 10% the chord error is 2.8 m
   * against a 4 m sink, so the surface stays under the road however the columns
   * happen to fall relative to it.
   *
   * The shallow gradient also makes the depression a few columns wide instead
   * of one, which is what stops it reading as a crease if it is ever caught
   * uncovered at the edge of the fog.
   */
  foreignSlope: 0.10,

  /** Lateral distance at which the player counts as having left the world. */
  recoverLateral: 300,
};

/**
 * Ground cover.
 *
 * The single biggest lever on whether the world reads as flat, and the numbers
 * below are a triangle budget as much as a look. A tuft is four triangles
 * carrying seven painted blades (see grass.js), so the counts here are large in
 * a way the rest of the project's scatter numbers are not: `CHUNK.propSamples`
 * is 420 attempts for at most 52 trees, and this places tens of thousands.
 *
 * Only the chunks either side of the car carry any, because grass is invisible
 * long before a chunk streams out — building it for all nine would be six
 * chunks of geometry nobody can resolve.
 */
export const GRASS = {
  enabled: true,

  /**
   * Tufts per square metre at the verge. Each is seven blades, so 3.2 here is
   * roughly 22 blades/m^2 — well under a real sward, and enough that crossed
   * cards close up into a continuous field rather than reading as objects.
   */
  density: 3.6,
  /** Lateral band: from the paved edge out to here, metres. */
  halfExtent: 62,
  /**
   * Full density out to here, then tapering to nothing at `halfExtent`.
   *
   * The taper is what hides the SIDEWAYS edge of the field — the density
   * reaches zero exactly at the band edge, so there is nothing to see stopping.
   * The distance fade below cannot do that job: a tuft directly beside the car
   * at the band edge is only as far away as the band is wide, so a fade tuned
   * to hide it would take the grass up the road with it.
   */
  denseTo: 34,

  /**
   * Camera distance over which a tuft shrinks away, metres.
   *
   * Deliberately LONGER than the lateral band: most of the grass a driver sees
   * is up the road ahead, not out to the side, and cutting it at the band width
   * would empty the verge fifty metres in front of the car. The sideways edge
   * is hidden by `denseTo`'s taper instead. Gradual either way — a card popping
   * out at a threshold is visible precisely because the player is driving
   * toward it.
   */
  fadeStart: 62,
  fadeEnd: 95,

  /**
   * How much larger a tuft grows at the edge of the band than at the verge.
   *
   * This is the whole reason the field can reach the middle distance at all.
   * Rendered, grass at a constant size looked like a ribbon hugging the tarmac
   * with bare ground beyond it — not because nothing was placed out there, but
   * because a low camera compresses forty metres of verge into a few dozen
   * pixels, and individual cards at that scale are gaps with grass between them
   * rather than the other way round.
   *
   * Bigger cards cover more ground for the same instance, and detail nobody can
   * resolve is detail nobody needs: the count per unit area is divided by the
   * square of this, so coverage extends while the triangle budget does not.
   */
  farScale: 1.0,

  /** Chunks either side of the car that carry grass. 1 = three chunks, 360 m. */
  chunkRadius: 1,
  /** Grass chunks built per frame. Scattering one is thousands of samples. */
  buildPerFrame: 1,

  /**
   * Tuft height, metres. Taller than a lawn on purpose: this is roadside rough,
   * and the first render showed why it matters — at 0.4 m the cards read as
   * scattered spikes standing on the ground rather than as a surface, because
   * you see the gap between them before you see them.
   */
  height: [0.55, 1.25],
  /**
   * Width as a fraction of height. A square-ish card is what makes neighbours
   * overlap into a continuous field; taller-than-wide leaves visible gaps at
   * any density a browser can afford.
   */
  widthRatio: 0.95,

  /**
   * Steepest ground grass grows on. Higher than the trees' limits on purpose:
   * grass holds a bank that a tree cannot, and a bare cut face beside a verge
   * full of grass is exactly the seam this is meant to remove.
   */
  maxSlope: 1.6,

  /** Wind direction (world XZ), strength in metres of tip travel, and rate. */
  windDir: { x: 0.86, z: 0.51 },
  windStrength: 0.22,
  windSpeed: 1.35,

  /** Blades drawn into one card, and the card texture's size in pixels. */
  bladesPerCard: 7,
  textureSize: 256,

  /**
   * The SECOND tier: the middle distance.
   */
  far: {
    enabled: true,
    behind: 1,
    ahead: 5,
    /** Lateral band, metres. Past this the terrain's detail texture takes over. */
    halfExtent: 185,
    /**
     * Card size: exactly 1.0x so distant grass blades match foreground grass.
     */
    widthScale: 1.0,
    heightScale: 1.0,
    /** Density, as a fraction of what would preserve ground cover at that scale. */
    coverage: 0.05,
    /** Grows in over this camera-distance window, behind the near tier's fade. */
    fadeIn: [55, 110],
    /** And shrinks out again here — matched to the fog, not to the band. */
    fadeOut: [330, 470],
    /** Steepest ground it will stand on. Looser than the near tier: at this
     *  distance a card on a 60-degree face reads as scrub, not as a mistake. */
    maxSlope: 2.2,
  },
};

/**
 * The terrain's own surface detail — see `env/ground.js`.
 *
 * This is the other half of the answer to "the ground is flat green". The
 * palette in `TERRAIN_COLORS` decides the hue; this decides whether there is
 * anything to see between one vertex and the next, which past the verge is tens
 * of metres of perfectly smooth interpolation.
 */
export const GROUND = {
  enabled: true,
  /** Detail map resolution. Three channels of luminance; see env/ground.js. */
  textureSize: 512,

  /**
   * Metres of world per tile, near and far.
   */
  tileNear: 5.5,
  tileFar: 28,

  /**
   * How hard each scale modulates the ground colour, 0..1.
   */
  contrastNear: 0.34,
  contrastFar: 0.30,

  /**
   * Distance over which the near tile fades out, metres.
   */
  nearFade: [45, 130],
};

/**
 * Procedural stone — see `env/rocks.js`.
 *
 * The brief is texture: chips and stones concentrated along the road shoulder-to-grass
 * transition verge, and talus spilling from cuttings.
 */
export const ROCKS = {
  enabled: true,

  /**
   * Chunks either side of the car that carry stone.
   */
  behind: 1,
  ahead: 4,

  /** Scatter attempts per chunk. Concentrated on the road-to-grass verge. */
  samples: 4000,

  /**
   * How many of each class's variants any ONE chunk may use.
   */
  variantsPerChunk: 2,

  /**
   * Where stone is allowed, in metres of lateral offset from the centreline.
   * Tightened strictly to the road shoulder / grass transition strip.
   */
  band: [9.8, 16.0],

  /**
   * Cut faces. Where the terrain is steeper than this, stone is far more likely
   * — this is the "scree out of a cutting" rule, and it is the single thing
   * that stops an excavated hillside reading as a smooth green ramp.
   */
  screeSlope: 0.62,

  /** Relative weight of each class on ordinary ground, and on a cut face. */
  mix: { scree: 0.62, stone: 0.31, boulder: 0.07 },
  screeMix: { scree: 0.86, stone: 0.13, boulder: 0.01 },

  /**
   * Size classes. `detail` is the icosahedron subdivision — 0 is 20 triangles,
   * 1 is 80 — and it is the whole triangle budget for this module.
   *
   * `flatten` is the vertical squash range. Stone is bedded and broken, so the
   * default is well under 1; a value near 0.3 is a slab.
   *
   * `facets` is how many random half-space planes the lump is clipped against.
   * That is what a fracture is, and without it the result is a potato.
   */
  classes: {
    scree: {
      variants: 5, detail: 0, size: [0.10, 0.34],
      flatten: [0.34, 0.66], facets: 4, roughness: 0.42,
      // The sun's cascade is 78 m across 2048 px — 4 cm a texel. A 15 cm chip
      // is three texels, so its shadow is noise, and there are more chips than
      // everything else put together.
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
 * Wind noise — see `wind.js`.
 *
 * The one sound the engine simulator cannot make, and the cheapest immersion in
 * the project. Every number here was chosen by listening; the notes say what
 * each one is for so that stays true after the next change.
 */
export const WIND = {
  /** Master level for the whole layer, 0..1. Exposed in the settings drawer. */
  volume: 0.45,

  /** Seconds of noise generated at boot. Long enough that the loop is inaudible. */
  bufferSeconds: 10,

  /**
   * Speed at which it starts, and where it reaches full, m/s.
   *
   * 8 m/s is about 29 km/h — below that a car is quiet and the sound would just
   * be a floor of hiss under the idle. 72 m/s is 259 km/h, past everything in
   * the roster, so nothing ever sits pinned at the top of the curve.
   */
  startSpeed: 8,
  fullSpeed: 72,

  /**
   * Shape of the rise.
   *
   * Aeroacoustic POWER goes as roughly the sixth power of velocity, which is
   * true and useless: it puts everything under 150 km/h at silence and
   * everything over it at one level. This is an AMPLITUDE curve with a tilt —
   * just over squared — so the whole speed range is expressive.
   */
  exponent: 2.2,

  /** Seconds of one-pole smoothing on the speed the filters follow. */
  smoothing: 0.18,
  /** Time constant for the parameter ramps. Below ~20 ms these click. */
  rampTime: 0.05,

  /** Broadband rush: level at full speed, and the low-pass sweep. */
  rushLevel: 0.85,
  rushCutoff: [260, 1500],

  /**
   * Edge whistle: level, band, and how far up the speed range it waits.
   *
   * It arrives at 45% of the range and climbs quadratically from there. That
   * lateness is the whole effect — it is what makes 200 km/h sound different
   * from 120 km/h rather than simply louder.
   */
  whistleLevel: 0.30,
  whistleFreq: [900, 2600],
  whistleFrom: 0.45,
  whistleQ: 1.6,
};

/**
 * Tyre effects — smoke and marks. See `fx.js`.
 *
 * Both are driven by the SAME quantity the skid audio already uses, `wheel
 * .slipAmount`, which is how far past its peak the tyre is. Nothing here
 * introduces a second opinion about whether a tyre is sliding.
 */
export const FX = {
  smoke: {
    enabled: true,
    /**
     * Particle pool. Fixed: the mesh is allocated once and particles are
     * recycled oldest-first, so a long burnout costs exactly what a short one
     * does and there is no allocation in the frame loop.
     */
    max: 260,
    /** Puffs per second per wheel at full slip. */
    rate: 55,
    /** Seconds a puff lives. */
    life: 1.5,
    /** Radius at birth and at death, metres. Smoke expands as it entrains air. */
    size: [0.30, 2.1],
    /** Rise rate and how fast a puff sheds the wheel's velocity, m/s and 1/s. */
    rise: 1.25,
    drag: 1.9,
    /** Peak opacity. Reached early in the life, then decays to nothing. */
    opacity: 0.34,

    /**
     * Below this much slip nothing is emitted at all.
     *
     * Deliberately well above zero. A tyre carrying a little slip is a tyre
     * working, not a tyre burning, and smoke off every corner turns the whole
     * game into a drift video.
     *
     * But not much above it either, and this is worth knowing before tuning it
     * up again: the tyre model resolves an over-driven wheel by CLAMPING the
     * combined impulse to the friction circle, and `slipAmount` is how much it
     * had to take away. A full-throttle standing start in the Sport measures
     * 0.39 to 0.46 on the driven wheels — that is a car lighting up its rear
     * tyres, and it is nowhere near 1. A threshold set by imagining what "full
     * slip" ought to mean lands above everything the model ever produces.
     */
    minSlip: 0.22,

    /**
     * The "wheelspin, not speed" gate, m/s.
     *
     * Tyre smoke is rubber being erased, and that happens when the CONTACT
     * PATCH is moving relative to the road — a standing burnout, a bad launch,
     * a lit-up second gear. At 200 km/h a sliding tyre is doing the same thing
     * per second but it is also leaving the smoke a hundred metres behind, so
     * there is never a cloud to see. Emission therefore fades out across this
     * range, which is also exactly the behaviour asked for: smoke when the
     * revs are up and the car is not.
     */
    speedFade: [14, 34],

    /** Where a puff is born relative to the contact patch: back and up, metres. */
    offset: [0.25, 0.12],
  },

  marks: {
    enabled: true,
    /**
     * Ring buffer of quads, shared across all four wheels.
     *
     * A ring rather than a growing trail: an infinite road would otherwise
     * accumulate an infinite mesh, and the oldest marks are behind the camera
     * by the time they are overwritten. 3,000 quads at a 0.35 m step is roughly
     * 260 m of continuous mark per wheel, which no drift lasts.
     */
    maxQuads: 3000,
    /**
     * Minimum distance the wheel must travel before another quad is laid, m.
     *
     * Short, because a mark has to start early: the most interesting moment is
     * a standing start, where the car covers very little ground while the tyres
     * are doing the most. At 0.35 m the first quad did not appear until the car
     * was already moving and the wheelspin was over.
     */
    step: 0.20,
    /** Seconds a mark takes to fade out completely. */
    life: 16,
    /** Darkest a mark gets. */
    opacity: 0.5,
    /**
     * Above this much slip a mark is laid. LOWER than the smoke's threshold:
     * rubber is left on the road long before there is enough of it in the air
     * to see, which is why a racetrack has black lines through every corner and
     * not just where the cars smoke.
     */
    minSlip: 0.18,
    /** Lift above the contact patch, metres. Enough to clear the terrain mesh. */
    lift: 0.035,
    /** Mark width as a fraction of the tyre's own width. */
    widthScale: 0.85,
  },
};

export const VEHICLE = {
  mass: 1250,
  /**
   * Ceiling on chassis speed, m/s (~360 km/h). Above every car's real top
   * speed, so it never touches normal driving — it exists purely to stop a
   * bad contact resolve from turning into an unrecoverable flight.
   */
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
  /** Hooke spring rate, N/m. ~42 kN/m puts static sag at ~40% of travel. */
  springK: 42000,
  /** Damping coefficients, N/(m/s). Rebound > bump is the usual road-car tune. */
  damperBump: 3300,
  damperRebound: 4400,
  /** Hard ceiling so a big compression can't launch the car. */
  maxSpringForce: 60000,
  /** Anti-roll bar rate, N per unit of normalised travel difference. */
  /**
   * A stiffer bar shifts lateral load transfer onto its own axle, and tyre grip
   * is sub-linear in load — so the stiff end loses grip first. Front-stiff
   * therefore means understeer. Rear-biased here, which frees the front to bite
   * and lets the car rotate, and soft enough overall to allow visible body roll.
   */
  antiRollFront: 2500,
  antiRollRear: 4200,

  // ---------------------------------------------------------------- tyres --
  /** Coulomb friction ceiling — bounds the whole friction circle. */
  tyreFriction: 1.25,

  /**
   * Slip-angle tyre model (a stripped-down Pacejka Magic Formula):
   *
   *     Fy = D · sin( C · atan( B · α ) )
   *
   * Lateral force builds with slip angle, peaks, then eases off. That falloff
   * is the whole point: it is what you feel through the car as the front axle
   * "goes light". A tyre that simply cancels lateral velocity has no such cue —
   * it grips perfectly right up until it doesn't.
   */
  /**
   * C — the shape factor, and the single biggest lever on whether a slide is
   * holdable. It sets how much grip survives past the peak:
   * `sin(C·π/2)` of it, once the slip angle is large. At 1.45 that is 76%, so
   * the tyre falls off a cliff the moment it lets go and the car is gone. At
   * 1.25 it keeps 92%, which is what makes a slide something you steer rather
   * than something that happens to you. 1.32 sits between the two: enough
   * falloff that the limit is still something you can feel arriving, enough
   * grip past it that the car does not simply leave.
   *
   * Now 1.22, which keeps 94%. At 1.32 the tyre still shed 11% of its grip the
   * moment it went past the peak, and because the rear axle reaches the peak
   * first under power that loss arrives as the back of the car leaving — the
   * "lost it out of nowhere" the car was being criticised for. Losing 6%
   * instead leaves the limit something you can feel arriving and then drive
   * through, which is the whole point of using a Magic Formula rather than a
   * friction cone.
   */
  tyreShape: 1.22,
  corneringStiffnessFront: 15,  // B — peak near 7.1 deg: crisp turn-in
  /**
   * The rear used to be much softer than the front (11.5 against 14), which
   * reads as a rear axle that takes its time deciding — the car rotates well
   * past where the driver aimed it before the back tyres have built the force
   * to stop it. Closing the gap makes the rear answer nearer the front's
   * timing, so the car settles into a corner instead of continuing to swing.
   */
  corneringStiffnessRear: 13.0,
  /**
   * Rear peak grip > front, so the front washes out first (safe understeer).
   * 1.07 rather than 1.02: understeer you can see coming and lift out of is a
   * mistake with a way back, and oversteer at 200 km/h is not.
   */
  rearGripBias: 1.07,
  /** Below this speed band, slip angle is meaningless; blend to velocity-cancelling. */
  slipBlendSpeed: [0.6, 3.5],
  /**
   * Traction control: how far drive torque may exceed the friction left over
   * after cornering. 1.0 would be a perfect nanny; 1.4 still allows wheelspin
   * and power-on rotation but stops a stab of throttle ending in a spin.
   *
   * 2.0 rather than 2.4. A stab of throttle mid-corner was still enough to
   * break the rear axle away in one step, which is the single most common way
   * the car was being lost. The margin is still well clear of 1.0, so wheelspin
   * and power-on rotation both survive — they just have to be asked for.
   */
  tractionControl: 2.0,

  /** Effective mass per tyre for the low-speed velocity-cancelling fallback. */
  lateralGripMass: 0.30,
  /** Handbrake kills most of the rear lateral grip => predictable drifts. */
  handbrakeGripMul: 0.28,
  /**
   * Tyre forces are applied this far above the contact patch. Real weight
   * transfer stays, but the roll moment shrinks enough to stop silly flips.
   */
  frictionAnchorLift: 0.24,
  rollingResistance: 320,
  /**
   * Surface drag off the asphalt. Grass and gravel both rob rolling resistance
   * and grip, which is what stops the verge being a free shortcut.
   */
  offRoadDrag: 3.2,
  offRoadGrip: 0.72,

  // -------------------------------------------------------------- driving --
  /**
   * Torque split [FL, FR, RL, RR]. Strongly rear-biased: the front tyres are
   * then almost entirely free to steer rather than spending their friction
   * budget putting power down, which is most of what "connected to the front
   * wheels" actually means.
   *
   * These are fractions of the TOTAL drive force and must sum to 1. Each entry
   * scales the whole engine output, so a set summing to 2 silently doubles the
   * car's acceleration.
   */
  driveBias: [0.09, 0.09, 0.41, 0.41],
  /** Per wheel. Sums past the tyre limit so the brakes can actually lock up. */
  brakeForce: [7500, 7500, 5000, 5000],
  handbrakeForce: 9000,

  /**
   * Steering. The usable angle is not a taste curve — it is derived from grip:
   * in a steady turn v²/R = a_max and R = L/tan(δ), so δ_max = atan(L·a_max/v²).
   * Beyond that the front tyres are simply asked for more than they have, and
   * the car plows on regardless of the wheel. `maxSteer` is the parking-speed
   * lock, `minSteer` the floor at any speed, and the margin is how far past the
   * grip limit you are allowed to ask (so a slide is still provokable).
   */
  maxSteer: 0.58,
  /**
   * Floor on the usable angle, and the margin past the grip limit.
   *
   * The derivation `δ_max = atan(L·a_max/v²)` is right, and taken literally it
   * makes a fast car feel welded straight ahead: measured, 1.72 deg of lock at
   * 200 km/h with only 1.85x the angle the tightest corner on the road needs.
   * There is nothing to drive with, and nothing left to catch a slide with
   * either. The margin is how far past the tyres' honest limit the driver may
   * ask — understeer is the penalty, which is a fair trade for having a car
   * that responds — and `minSteer` guarantees a usable angle at any speed.
   */
  minSteer: 0.075,
  steerGripMargin: 1.6,
  /**
   * Slew rates toward full lock and back to centre, rad/s.
   *
   * Down from 6.2 / 8.0. These are most of what "weight" means for a car you
   * steer with a key or a thumb: a digital input snapped to full lock in
   * 94 ms gives a car that darts, and darting is indistinguishable from
   * twitchiness at speed. 5.0 puts full lock 200 ms away, which is about how
   * long a real driver's hands take, and the lock still opens on the same curve
   * so nothing about catching a slide changes.
   */
  steerRate: 5.0,          // rad/s toward full lock
  steerReturnRate: 6.6,    // rad/s back to centre when input released

  // ----------------------------------------------------------- powertrain --
  /**
   * Fallbacks only. Every roster entry supplies its own, and engine_sim owns
   * the torque curve, the clutch and the shift logic — so there is deliberately
   * no torque or shift-point tuning here. The keys that used to describe the
   * old built-in engine model (idle/peak torque/shift rpm, driveline
   * efficiency) are gone; they had been dead since the simulator took over.
   */
  maxRpm: 7400,
  finalDrive: 3.7,
  /** index 0 = reverse, index 1 = neutral, 2+ = forward gears. */
  gearRatios: [-3.3, 0, 3.62, 2.24, 1.58, 1.19, 0.96, 0.79],

  // ------------------------------------------------------------ aero/misc --
  dragCoefficient: 0.55,   // 0.5 * rho * Cd * A, lumped
  /**
   * N per (m/s)^2. At a 70 m/s top speed this adds ~11 kN — a bit over half the
   * car's weight again, which keeps fast sweepers planted. Much beyond this and
   * the car stops feeling like it has any weight at all.
   */
  downforce: 2.2,
  /**
   * Zero: Rapier's linear damping applies a force of damping·m·v, which at
   * 190 km/h was ~1300 N — comparable to the entire aero drag term and enough
   * to make `dragCoefficient` meaningless. All longitudinal resistance is
   * modelled explicitly (aero drag + rolling resistance) so top speed is a
   * property of the car, not of a solver setting.
   */
  linearDamping: 0.0,
  /**
   * Angular damping, 1/s. Raised from 0.30: it is a first-order resistance to
   * being rotated at all, so it reads directly as mass in the body rather than
   * as a correction — the car stops pivoting the instant the steering asks and
   * starts taking a moment to come round. It is small enough that a deliberate
   * slide still happens; it is the flick that it takes the edge off.
   */
  angularDamping: 0.45,
  /** Self-righting torque so a bad landing doesn't end the run. */
  uprightTorque: 5.5,
  /** Pitch/yaw authority while airborne. */
  airControl: 2.6,

  /**
   * Slide containment — where a drift stops being a drift and becomes a spin.
   *
   * Measured on the old tune: a handbrake turn left the car yawing at
   * 3.29 rad/s, countersteer took 3.96 s to arrest it, and it went right round.
   * That is not a difficulty curve, it is a car the driver has been locked out
   * of: past a certain angle every tyre is so far beyond its peak that the
   * steering has almost no authority left, so no input recovers it.
   *
   * A yaw damper fades in between these two chassis slip angles and is fully
   * engaged past the second. Below `driftAngle` it does literally nothing.
   *
   * DELIBERATELY LATE AND GENTLE. At 23 deg and a strength of 3.0 it caught a
   * spin in 0.68 s, which is excellent and also completely obvious: 23 deg is
   * an ordinary slide, so the car was being straightened out from under the
   * driver every time they provoked one. That is the "weird correction". The
   * band now starts past the angle a car reaches under any normal provocation
   * and the strength is less than half, so it is a net that catches a genuine
   * spin rather than a hand on the wheel.
   */
  /**
   * Now 29 deg / 60 deg at strength 1.9, from 36 / 72 at 1.3.
   *
   * Bug #38 pulled this band deliberately late because at 23 deg and strength
   * 3.0 the assist was straightening the car out from under the driver. That
   * was right, and it went one stop too far: at 36 deg the net only catches a
   * car that is already most of the way round, so everything between an
   * ordinary slide and a spin was unassisted and a mistake there was
   * unrecoverable. Measured, a provoked spin took 2.54 s and 167 deg to arrest.
   * 29 deg is still past anything ordinary cornering reaches — the tyres peak
   * around 7 deg of slip — so a held drift is untouched, but the net is now
   * under the part of the range where the car was actually being lost.
   */
  driftAngle: 0.50,        // ~29 deg — past any ordinary slide
  spinAngle: 1.05,         // ~60 deg — past here the car is going round
  spinRecovery: 1.9,       // damper strength, N·m·s per rad/s per kg

  /**
   * Chassis slip angles over which the steering lock opens beyond the
   * grip-derived limit. See `_updateSteering`: the steady-state derivation does
   * not hold in a slide, and applying it there leaves no countersteer at all.
   *
   * The opening is PROPORTIONAL, not a jump to full lock. Going straight to
   * 33 deg the moment the car moved around read as the steering ratio changing
   * underneath you. A fixed multiple of whatever the limit already was keeps
   * the response continuous — the wheel means the same thing throughout, there
   * is simply more of it available.
   */
  slideOpenFrom: 0.14,     // ~8 deg — the car is starting to move around
  slideOpenTo: 0.55,       // ~32 deg — fully opened
  slideLockGain: 4.0,      // how many times the steady-state limit, at most
};

export const TRAFFIC = {
  /** Cars kept alive around the player. */
  count: 9,

  /**
   * The band of road that is populated, and where inside it a car may appear.
   *
   * `spawnMin` is the important one. It used to be 40 m, which put cars into
   * existence in the middle of the carriageway in full view — the single most
   * obvious thing wrong with the old traffic. At 460 m the exponential fog has
   * already taken about half the contrast out of a car and the depth-of-field
   * focus (which reaches 260 m at speed) has softened it, so what arrives is a
   * shape resolving out of the haze rather than an object switching on.
   */
  spawnMin: 460,
  ahead: 620,
  behind: 260,
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
  /**
   * Ceiling on the speed change one impact may hand the player, m/s.
   *
   * Not a fudge factor. The impulse itself is the honest closed-form exchange,
   * but a glancing blow evaluated at 300 km/h against a 2.6 t military truck
   * produces a Δv that removes the player from the world, and no amount of
   * correctness makes that the right outcome in a driving game. 11 m/s is a
   * hard shunt you can recover from.
   */
  maxImpactDv: 11,
  /** Seconds a struck car spends spinning out before it is taken away. */
  spinTime: 4.5,
  /** How fast a spinning car sheds speed, m/s². */
  spinDecel: 5.5,
};

export const CAMERA = {
  fov: 62,
  near: 0.4,
  far: 2600,
  /**
   * Chase rig: distance / height / look-ahead, in metres. Deliberately tight —
   * the camera sits just off the bootlid at rest, which is what makes low speed
   * feel like driving rather than like watching a model from across the room.
   */
  chase: { dist: 4.4, height: 2.30, ahead: 6.0 },
  close: { dist: 3.3, height: 1.80, ahead: 4.8 },
  /** Height of the point the camera aims at, above the contact plane. */
  aimHeight: 0.95,
  /**
   * The rig scales with the vehicle: a 2.9 m monster truck needs the camera
   * further up and back than a 1.37 m sports car, or it sits at roof height.
   * Referenced against a typical car body, and clamped so the extremes stay
   * recognisably the same camera.
   */
  bodyRef: 1.45,
  heightScaleMax: 1.75,
  distScaleMax: 1.35,
  /** Positional and rotational smoothing rates (higher = stiffer). */
  posDamp: 9.5,
  aimDamp: 12.0,
  /**
   * How the rig opens out with speed. `speedRef` is the speed at which the
   * pull-back is essentially complete — set high so the change is gradual
   * across the whole range rather than all of it happening by 60 km/h. `speedLag` is
   * how fast the rig is allowed to *react* to a speed change, which is what
   * stops the camera lunging on every throttle stab.
   */
  /**
   * `speedRef` was 165 m/s — 594 km/h, far beyond anything in the roster — so
   * the speed factor never rose above about 0.4 and none of the terms below did
   * much of anything. At 68 m/s the rig reaches full effect at a speed a car can
   * actually see, and the field of view now opens by a useful amount rather than
   * by a degree and a half.
   */
  speedRef: 68,
  speedLag: 0.5,
  /** How far the rig backs off and lifts at full speed, metres. Kept small. */
  distGain: 0.45,
  heightGain: 0.12,
  /** Degrees of extra field of view at full speed — most of the speed cue. */
  fovSpeedGain: 12,

  /**
   * Garage: the rig that orbits the car on the title screen.
   *
   * `aim` is NEGATIVE on purpose. The look-at point sits at the centre of the
   * frame, so aiming at a point below the car lifts the car up the screen and
   * out from behind the dock of buttons along the bottom.
   */
  /**
   * `aim` is NEGATIVE, and it is how far BELOW the car the rig looks. The
   * look-at point sits at the centre of the frame, so aiming low lifts the car
   * up the screen and clear of the dock along the bottom.
   *
   * -2.2 rather than -0.55 because the dock got taller when it gained a second
   * paint row: rendered at 1280x720 the car sat exactly behind the panel, which
   * is a poor outcome for a screen whose entire job is showing it.
   */
  garage: { dist: 7.2, height: 2.3, spin: 0.22, aim: -2.2 },

  /**
   * Leaving the garage, the rig sweeps to the chase position rather than
   * cutting. `snapBoost` multiplies the damping rates for `snapTime` seconds so
   * it arrives promptly without teleporting.
   */
  snapTime: 1.1,
  snapBoost: 2.6,
};

/**
 * The showroom — the title screen's own little world.
 *
 * Nothing here is procedural or seed-dependent, which is the point: a product
 * shot should look the same every time, and the road behind the old garage
 * screen did not. See showroom.js.
 */
export const SHOWROOM = {
  fov: 38,
  /** Cyclorama radius, metres. Large enough that no car can approach the wall. */
  radius: 60,

  /** Backdrop, floor upward. Cool and dim, so warm paint reads against it. */
  floorColor: 0x171a22,
  wallColor: 0x333a48,
  topColor: 0x4a5468,
  /** The pool of light thrown on the wall behind the car. */
  glowColor: 0x3a4560,

  /**
   * Half-extent of the invisible shadow catcher, metres. There is no plate any
   * more — see `showroom.js:shadowFloor` — but the car still needs something
   * under it for its shadow to land on, or it hovers.
   */
  plateRadius: 3.6,
  /** How dark that shadow is. It is the only thing the floor draws. */
  shadowOpacity: 0.42,

  // ---- three-point lighting, fixed ------------------------------------
  keyColor: 0xfff2e0,
  keyIntensity: 3.0,
  fillColor: 0xc8d8ff,
  fillIntensity: 0.85,
  rimColor: 0xffd9a8,
  rimIntensity: 2.2,
  hemiSky: 0x9fb4d6,
  hemiGround: 0x1a1d24,
  hemiIntensity: 0.75,

  // ---- framing ---------------------------------------------------------
  /**
   * Fraction of the free band the car is allowed to fill.
   */
  fill: 0.58,
  /** Never closer than this, whatever the arithmetic says. */
  minDistance: 5.5,
  /** Camera distance as a multiple of the solved distance, and its lift. */
  orbitRadius: 0.95,
  eyeLift: 0.32,

  /** Turntable rate, radians per second, and where it starts. */
  spin: 0.22,
  startAngle: 2.35,
};

export const ATMOSPHERE = {
  /**
   * Overcast-bright rather than golden hour. The previous rig sat the sun almost
   * on the horizon with a heavily saturated warm key, which raked every surface
   * and blew the highlights. Here the sun is well up, close to white, and the
   * hemisphere fill is strong — that combination flattens the shading ratio and
   * lets the vertex colours read as pastel instead of being stained orange.
   */
  fogColor: 0xd6dbdb,
  /**
   * Reduced now that depth of field carries the distance cue. Fog this thick
   * was doing the separating on its own, which meant washing the whole
   * landscape to one flat colour before you could see any of it.
   */
  fogDensity: 0.0016,

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
   * Radial speed blur. `speedBlur` is the smear at full speed, as a fraction of
   * the distance from screen centre; `speedBlurInner` is the radius that stays
   * perfectly sharp. Set speedBlur to 0 to drop the pass entirely.
   *
   * This replaced depth of field, which focused at a single distance and
   * therefore blurred the car itself — see scene.js.
   */
  speedBlur: 0.055,
  speedBlurInner: 0.17,
  /** Speed, m/s, at which the blur reaches full strength. */
  speedBlurRef: 68,

  /** Overall brightness multiplier applied by the tone mapper. */
  exposure: 1.18,
};

/**
 * Near-miss scoring, used by Traffic mode.
 *
 * The shape is the familiar one: a pass close to another car scores, closer
 * scores more, and consecutive passes build a multiplier that decays unless it
 * is refreshed. What is specific here is that ONCOMING traffic is worth much
 * more — it arrives at the sum of both speeds, so the same lateral gap is a
 * fraction of the time to react to and ought to pay accordingly.
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
 * The ground palette. Lighter and less saturated than natural, to sit with the
 * flatter lighting.
 *
 * Nine entries where there were five, and the four new ones are all doing the
 * same job: the world was one green. `grassLow` to `grassHigh` is a hue ramp of
 * about fifteen degrees, which over a hillside is not a variation, it is a
 * gradient — and a gradient across smoothly interpolated vertices metres apart
 * is exactly the flat wash this is meant to break up.
 *
 * What actually makes ground look like ground is DIFFERENT MATERIALS next to
 * each other, not one material shading. So:
 *
 * - `grassDeep` — the damp green of a hollow or a north face
 * - `grassDry`  — sun-bleached straw, on a shoulder or a south-facing bank
 * - `scrub`     — the olive of heather and low bush, which is what covers
 *                 ground too steep or too high for grass
 * - `snow`      — above the tree line. Worth having now that a peak reaches a
 *                 kilometre over the valley it stands in
 *
 * `chunks.js:_groundColor` mixes between them by altitude ABOVE THE LOCAL BASE
 * — see `noise.js:continent` — rather than by absolute height, which stopped
 * meaning anything the moment the whole map started rising and falling by
 * hundreds of metres under the landforms.
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
