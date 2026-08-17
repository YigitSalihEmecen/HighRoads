/**
 * config.js — every tunable in one place.
 *
 * Units are SI throughout: metres, kilograms, seconds, newtons, radians.
 * The vehicle numbers are physically plausible but deliberately biased toward
 * "grippy and forgiving" — this is a cruiser, not a simulator.
 */

export const WORLD = {
  seed: 'fastroads-01',

  /** Slightly heavier than Earth: makes landings snappy and reduces float. */
  gravity: -16.0,

  /** Physics runs on a fixed 120 Hz clock, decoupled from the render loop. */
  fixedStep: 1 / 120,
  maxSubSteps: 5,
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
  lanes: 4,
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
  cutSlope: 0.85,
  fillSlope: 0.62,

  /** Centre line: metres painted, then the same again unpainted. */
  dashLength: 3.0,

  /**
   * A tunnel begins where the ground over the centreline exceeds this, so the
   * mountain has already closed overhead before the bore starts and the car is
   * never driving straight at a terrain surface. Shallower than this and the
   * cut-and-fill clamp opens an ordinary cutting instead.
   */
  /**
   * DISABLED (see README, "Tunnels are off by one constant"). Set to ~11 to
   * enable. The geometry is verified correct — solid rock over the bore, mouths
   * cut where the arch breaks out, no terrain intruding into the carriageway —
   * but on some spans the car stops dead inside the bore against something I
   * have not identified. A deep cutting is what you get instead, which the
   * cut-and-fill clamp already produces well.
   */
  tunnelCover: 11,
  tunnelMinLength: 55,
  /** Dips shallower than this are bridged rather than splitting one tunnel. */
  tunnelBridge: 60,
  tunnelHalfWidth: 9.2,
  tunnelCrown: 7.6,
  /** Rock left between the bore crown and the mountain before a mouth opens. */
  tunnelRoof: 2.5,
  /** Thickness of the portal ring, which is what gives the mouth solidity. */
  portalThickness: 2.6,
  /** Floor slab either side of the bore, so a hole can never outrun the floor. */
  tunnelSill: 2.5,
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
   * by sloping out of sight rather than at a clean cut edge. This is only a
   * safety net — at 700 m the fog already leaves ~1% of the terrain colour, so
   * the drop stays shallow. An aggressive drop here produces near-vertical
   * facets whose normals flip, and those read as a jagged dark band.
   */
  horizonFalloff: 560,
  horizonDrop: 60,
  /** Lateral distance at which the player counts as having left the world. */
  recoverLateral: 300,
};

export const VEHICLE = {
  mass: 1250,
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
  tyreShape: 1.45,             // C — peak at B·α ≈ 1.86, then a soft plateau
  corneringStiffnessFront: 14, // B — peak near 7.6 deg: crisp turn-in
  corneringStiffnessRear: 11.5,// softer rear: slip builds progressively
  /** Rear peak grip > front, so the front washes out first (safe understeer). */
  rearGripBias: 1.02,
  /** Below this speed band, slip angle is meaningless; blend to velocity-cancelling. */
  slipBlendSpeed: [0.6, 3.5],
  /**
   * Traction control: how far drive torque may exceed the friction left over
   * after cornering. 1.0 would be a perfect nanny; 1.4 still allows wheelspin
   * and power-on rotation but stops a stab of throttle ending in a spin.
   */
  tractionControl: 1.4,

  /** Effective mass per tyre for the low-speed velocity-cancelling fallback. */
  lateralGripMass: 0.30,
  /** Handbrake kills most of the rear lateral grip => predictable drifts. */
  handbrakeGripMul: 0.30,
  /**
   * Tyre forces are applied this far above the contact patch. Real weight
   * transfer stays, but the roll moment shrinks enough to stop silly flips.
   */
  frictionAnchorLift: 0.22,
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
  minSteer: 0.030,
  steerGripMargin: 1.05,
  steerRate: 4.4,          // rad/s toward full lock
  steerReturnRate: 6.2,    // rad/s back to centre when input released

  // ----------------------------------------------------------- powertrain --
  idleRpm: 900,
  maxRpm: 7400,
  shiftUpRpm: 6700,
  shiftDownRpm: 2900,
  shiftTime: 0.28,
  peakTorque: 385,         // Nm
  peakTorqueRpm: 4300,
  finalDrive: 3.7,
  drivelineEfficiency: 0.9,
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
  angularDamping: 0.30,
  /** Self-righting torque so a bad landing doesn't end the run. */
  uprightTorque: 5.5,
  /** Pitch/yaw authority while airborne. */
  airControl: 2.6,

  bodyColor: 0xd94f3d,
};

export const TRAFFIC = {
  /** Cars kept alive around the player. */
  count: 8,
  ahead: 420,
  behind: 220,
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
  chase: { dist: 5.2, height: 2.95, ahead: 6.5 },
  close: { dist: 4.0, height: 2.25, ahead: 5.0 },
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
  speedRef: 165,
  speedLag: 0.5,
  distGain: 0.55,
  heightGain: 0.18,
  fovSpeedGain: 4,
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
  sunIntensity: 2.05,

  hemiSky: 0xd2e2f2,
  hemiGround: 0xa39c8c,
  /** Deliberately high: this is what lifts the shadows and kills the contrast. */
  hemiIntensity: 1.25,

  /** Sun well above the horizon — the single biggest lever on "sunset vibe". */
  sunDir: { x: -0.34, y: 0.62, z: -0.71 },

  shadowRadius: 78,
  shadowMapSize: 2048,

  /** Post-processing. Bloom is now a hint of glow, not a glare. */
  bloomStrength: 0.10,
  bloomThreshold: 0.95,
  vignette: 0.2,
  /**
   * Distance blur. Everything nearer than `blurStart` stays perfectly sharp —
   * which is what keeps the car crisp regardless of where the camera sits — and
   * blur ramps to full by `blurEnd`. The start distance is pushed further out
   * with speed.
   */
  /** Set false to drop depth of field entirely; everything else keeps working. */
  blurEnabled: true,
  /**
   * Depth of field, focus pulled toward the horizon with speed. Note this
   * focuses at ONE distance, so the car — five metres away — softens as focus
   * goes out. Lower `dofMaxBlur` to reduce that; it scales the whole effect.
   */
  dofFocus: 90,
  dofAperture: 0.000022,
  dofMaxBlur: 0.004,
  dofFocusNear: 55,
  dofFocusFar: 260,
  exposure: 1.0,
};

/** Lighter and less saturated than natural, to sit with the flatter lighting. */
export const TERRAIN_COLORS = {
  grassLow: 0x7d9663,
  grassHigh: 0x94a06d,
  rock: 0x968b7e,
  peak: 0xc9c3b8,
  dirt: 0x9d8e75,
};
