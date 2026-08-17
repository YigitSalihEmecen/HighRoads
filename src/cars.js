/**
 * cars.js — the roster.
 *
 * Every entry names an FBX and the handful of numbers that make it feel like a
 * distinct vehicle. Everything geometric — wheelbase, track, rolling radius,
 * body box — is measured from the model at load time rather than typed in
 * here, so the physics always matches what you can see.
 *
 * The derived numbers below are what keep nine very different vehicles all
 * driveable without individual hand-tuning:
 *
 *   springK        set from mass so static sag is the same fraction of travel
 *                  on a 1.1 t hatchback and a 2.6 t monster truck alike;
 *   damping        a fixed ratio of critical, hence sqrt(k·m);
 *   anti-roll      a fixed fraction of the spring rate;
 *   travel         scaled off the rolling radius, so big-wheeled trucks get
 *                  the long soft suspension their proportions imply;
 *   CoM height     a fraction of body height — this is what makes the truck
 *                  lean and the sports car stay flat.
 *
 * The pack also contains `Air Plane_1.fbx`, which has three wheels and a
 * propeller. It is not in the roster: a four-corner raycast vehicle has nothing
 * sensible to do with it.
 */

/** Static sag as a fraction of total suspension travel. */
const SAG_FRACTION = 0.28;
/** Body roll at the vehicle's own cornering limit, radians (~4.9 deg). */
const TARGET_ROLL = 0.085;
/** Damping as a fraction of critical, per direction. */
const ZETA_BUMP = 0.46;
const ZETA_REBOUND = 0.61;

export const CARS = [
  {
    id: 'sport',
    defaultColor: 'red',
    file: 'Sport Car_39.fbx',
    name: 'Sport',
    blurb: 'Light, low and rear-driven. The quickest thing here, and the least forgiving.',
    /** Flat-plane V8 — no half-orders, so it screams rather than burbles. */
    engine: 'v8flat',
    gearbox: 'dct',
    shiftTimeMs: 45,
    mass: 1180,
    peakTorque: 400,
    peakTorqueRpm: 4600,
    maxRpm: 7600,
    gearRatios: [-3.3, 0, 3.62, 2.24, 1.58, 1.19, 0.96, 0.79],
    finalDrive: 3.8,
    drive: 'rwd',
    grip: 1.3,
    comHeight: 0.40,
    travelScale: 1.05,
    dragCoefficient: 0.52,
    downforce: 2.6,
  },
  {
    id: 'muscle',
    defaultColor: 'orange',
    file: 'N_Muscle Car_10.fbx',
    name: 'Muscle',
    blurb: 'Big torque, long bonnet, lazy gearing. Will step out if you ask it to.',
    /** Cross-plane V8. Uneven bank firing puts 31% of its energy in the half-orders: the burble. */
    engine: 'v8cross',
    gearbox: 'manual',
    shiftTimeMs: 150,
    mass: 1520,
    peakTorque: 520,
    peakTorqueRpm: 3600,
    maxRpm: 6400,
    gearRatios: [-2.9, 0, 3.06, 1.92, 1.4, 1.0, 0.78],
    finalDrive: 3.4,
    drive: 'rwd',
    grip: 1.18,
    comHeight: 0.42,
    travelScale: 1.15,
    dragCoefficient: 0.62,
    downforce: 1.6,
  },
  {
    id: 'classic',
    defaultColor: 'teal',
    file: 'Classic Car_9.fbx',
    name: 'Classic',
    blurb: 'Skinny tyres, soft springs and modest power. Slow in, wobbly out.',
    /** Inline six — perfectly balanced, even firing, a smooth hum. */
    engine: 'i6',
    gearbox: 'manual',
    shiftTimeMs: 170,
    mass: 1240,
    peakTorque: 250,
    peakTorqueRpm: 3400,
    maxRpm: 5800,
    gearRatios: [-3.4, 0, 3.4, 2.0, 1.35, 1.0],
    finalDrive: 3.9,
    drive: 'rwd',
    grip: 1.02,
    comHeight: 0.46,
    travelScale: 1.35,
    dragCoefficient: 0.78,
    downforce: 0.8,
  },
  {
    id: 'hatchback',
    defaultColor: 'yellow',
    file: 'Hatchback Car_15.fbx',
    name: 'Hatchback',
    blurb: 'Front-driven, short and eager. Understeers honestly and never bites.',
    /** Inline four, even intervals and no half-order content. */
    engine: 'i4',
    gearbox: 'manual',
    shiftTimeMs: 130,
    mass: 1090,
    peakTorque: 230,
    peakTorqueRpm: 4200,
    maxRpm: 6800,
    gearRatios: [-3.5, 0, 3.55, 2.05, 1.42, 1.06, 0.86],
    finalDrive: 4.1,
    drive: 'fwd',
    grip: 1.16,
    comHeight: 0.44,
    travelScale: 1.1,
    dragCoefficient: 0.6,
    downforce: 1.0,
  },
  {
    id: 'police',
    defaultColor: 'white',
    file: 'Police Car N_4.fbx',
    name: 'Interceptor',
    blurb: 'A saloon with the good engine. Fast, heavy, and stops well.',
    /** 60-degree V6. */
    engine: 'v6',
    gearbox: 'auto',
    shiftTimeMs: 120,
    mass: 1650,
    peakTorque: 430,
    peakTorqueRpm: 4200,
    maxRpm: 6900,
    gearRatios: [-3.2, 0, 3.4, 2.1, 1.5, 1.12, 0.9, 0.74],
    finalDrive: 3.6,
    drive: 'rwd',
    grip: 1.24,
    comHeight: 0.43,
    travelScale: 1.15,
    dragCoefficient: 0.66,
    downforce: 1.8,
  },
  {
    id: 'pickup',
    defaultColor: 'blue',
    file: 'Pick Up_11.fbx',
    name: 'Pick-Up',
    blurb: 'Long wheelbase, light rear end, four-wheel drive when it counts.',
    /** Cross-plane V8 with a long-geared automatic. */
    engine: 'v8cross',
    gearbox: 'auto',
    shiftTimeMs: 190,
    mass: 1950,
    peakTorque: 480,
    peakTorqueRpm: 3200,
    maxRpm: 5600,
    gearRatios: [-3.1, 0, 3.8, 2.2, 1.5, 1.08, 0.84],
    finalDrive: 3.7,
    drive: 'awd',
    grip: 1.12,
    comHeight: 0.48,
    travelScale: 1.35,
    dragCoefficient: 0.95,
    downforce: 0.6,
  },
  {
    id: 'van',
    defaultColor: 'silver',
    file: 'N Van_10.fbx',
    name: 'Van',
    blurb: 'Tall, slow and permanently leaning. Surprisingly relaxing.',
    /** Turbocharged inline five — offbeat, and it spools. */
    engine: 'i5',
    gearbox: 'auto',
    shiftTimeMs: 200,
    mass: 1820,
    peakTorque: 300,
    peakTorqueRpm: 3000,
    maxRpm: 5200,
    gearRatios: [-3.6, 0, 4.0, 2.3, 1.5, 1.05, 0.82],
    finalDrive: 4.0,
    drive: 'fwd',
    grip: 1.0,
    comHeight: 0.55,
    travelScale: 1.3,
    dragCoefficient: 1.2,
    downforce: 0.3,
  },
  {
    id: 'military',
    defaultColor: 'green',
    file: 'Military Vehicle_3.fbx',
    name: 'Military',
    blurb: 'Two and a half tonnes of permanent four-wheel drive. Ignores terrain.',
    /** Turbocharged inline six, geared for pulling. */
    engine: 'i6',
    gearbox: 'auto',
    shiftTimeMs: 210,
    mass: 2600,
    peakTorque: 700,
    peakTorqueRpm: 2600,
    maxRpm: 4800,
    gearRatios: [-3.8, 0, 4.6, 2.6, 1.7, 1.2, 0.9],
    finalDrive: 4.3,
    drive: 'awd',
    grip: 1.14,
    comHeight: 0.5,
    travelScale: 1.5,
    dragCoefficient: 1.5,
    downforce: 0.2,
  },
  {
    id: 'monster',
    defaultColor: 'purple',
    file: 'Monster Truck_15.fbx',
    name: 'Monster Truck',
    blurb: 'Enormous wheels, endless travel, comically high roll centre.',
    /** Cross-plane V8 with nothing between it and the sky. */
    engine: 'v8cross',
    gearbox: 'auto',
    shiftTimeMs: 180,
    mass: 2400,
    peakTorque: 820,
    peakTorqueRpm: 3400,
    maxRpm: 6000,
    gearRatios: [-3.4, 0, 4.2, 2.4, 1.6, 1.15, 0.88],
    finalDrive: 4.0,
    drive: 'awd',
    grip: 1.2,
    comHeight: 0.46,
    // Long and soft — it should wallow — but not so much that the body has more
    // vertical travel than a road car has total height.
    travelScale: 1.6,
    dragCoefficient: 1.5,
    downforce: 0.2,
  },
];

/**
 * Paint options. These drive a plain material rather than the palette atlas —
 * the atlas cell carrying each car's bodywork is detected at load and moved
 * onto its own material slot, so any colour is available, not just the 256 in
 * the texture.
 */
export const CAR_COLORS = [
  { id: 'red',    name: 'Rosso',     hex: 0xc0392b },
  { id: 'orange', name: 'Amber',     hex: 0xd97a1a },
  { id: 'yellow', name: 'Giallo',    hex: 0xd8b224 },
  { id: 'green',  name: 'Racing',    hex: 0x2f6b45 },
  { id: 'teal',   name: 'Petrol',    hex: 0x2a7f86 },
  { id: 'blue',   name: 'Cobalt',    hex: 0x2a5ca8 },
  { id: 'purple', name: 'Plum',      hex: 0x6a3d8f },
  { id: 'white',  name: 'Bianco',    hex: 0xdcdcd6 },
  { id: 'silver', name: 'Silver',    hex: 0x9aa0a6 },
  { id: 'black',  name: 'Nero',      hex: 0x24262b },
];

export function colorById(id) {
  return CAR_COLORS.find((c) => c.id === id) || CAR_COLORS[0];
}

/**
 * The engine roster from engine_sim. Any engine can go in any car — the
 * drivetrain profile (mass, ratios, final drive) stays the car's own, so
 * dropping a V12 into the van changes what it sounds like *and* what it does.
 */
export const ENGINE_OPTIONS = [
  { id: 'stock',   name: 'Stock' },
  { id: 'i3',      name: 'I3 turbo' },
  { id: 'i4',      name: 'I4' },
  { id: 'boxer4',  name: 'Boxer-4' },
  { id: 'i5',      name: 'I5 turbo' },
  { id: 'i6',      name: 'I6 turbo' },
  { id: 'v6',      name: 'V6' },
  { id: 'flat6',   name: 'Flat-6' },
  { id: 'v8cross', name: 'V8 cross' },
  { id: 'v8flat',  name: 'V8 flat' },
  { id: 'v10',     name: 'V10' },
  { id: 'v12',     name: 'V12' },
];

export const DEFAULT_CAR = 'sport';

export function carById(id) {
  return CARS.find((c) => c.id === id) || CARS[0];
}

/** Front/rear torque split for each layout, as [FL, FR, RL, RR] summing to 1. */
const DRIVE_SPLIT = {
  fwd: [0.5, 0.5, 0, 0],
  rwd: [0, 0, 0.5, 0.5],
  awd: [0.19, 0.19, 0.31, 0.31],
};

/**
 * Combines a roster entry with the geometry measured from its FBX to produce
 * the full parameter set the vehicle controller consumes.
 *
 * @param {object} spec     one of CARS
 * @param {object} metrics  from assets.loadCarModel
 * @param {object} base     shared defaults (config.VEHICLE)
 * @param {number} gravity  m/s², positive magnitude
 */
export function buildCarParams(spec, metrics, base, gravity) {
  const mass = spec.mass;

  // Suspension travel follows wheel size: a 0.64 m monster-truck wheel implies
  // far more travel than a 0.39 m road wheel, and hard-coding one number for
  // both makes the truck ride like a go-kart.
  const restLength = metrics.wheelRadius * 1.15 * (spec.travelScale || 1);

  // Spring rate chosen so static sag is the same fraction of travel for every
  // car:  k = m·g / (4 · sag)
  const sag = restLength * SAG_FRACTION;
  const springK = (mass * gravity) / (4 * sag);

  // Critical damping for one corner is 2·sqrt(k · m/4) = sqrt(k·m).
  const cCrit = Math.sqrt(springK * mass);

  // Underbody clearance: enough to clear the suspension's own static travel.
  const clearance = Math.max(sag * 1.6, metrics.wheelRadius * 0.55);

  // Static Stability Factor — the real-world rollover metric: half-track over
  // centre-of-mass height. A vehicle tips once lateral acceleration exceeds
  // SSF·g, so anything with SSF below its own grip coefficient will roll before
  // it slides. That is precisely the monster truck and the van, and without
  // this they lie down in the first corner every time.
  const comHeight = metrics.bodyHeight * spec.comHeight;
  const ssf = metrics.trackHalf / comHeight;
  const rolloverAccel = gravity * ssf * 0.82;

  // Anti-roll sized from the roll moment this vehicle will actually see, not as
  // a fixed fraction of spring rate. A fraction fails badly at the extremes: the
  // monster truck's springs are soft *because* its travel is huge, so a
  // proportional bar leaves a 2.9 m-tall body with almost no roll stiffness and
  // it lies down in the first corner.
  //   roll moment  M = m · a_limit · arm      (arm reduced by frictionAnchorLift,
  //                                            since tyre forces are applied
  //                                            above the contact patch)
  //   roll stiffness needed for a target lean:  K = M / θ
  //   springs already provide  k · track² / 2;  the bars make up the shortfall.
  const aLimit = Math.min(spec.grip * gravity, rolloverAccel);
  const arm = Math.max(0.15, comHeight - base.frictionAnchorLift);
  const track = metrics.trackHalf * 2;
  const kRollNeeded = (mass * aLimit * arm) / TARGET_ROLL;
  const kRollSprings = (springK * track * track) / 2;
  const barTotal = Math.max(0, (kRollNeeded - kRollSprings) * restLength) / (track * track);

  return {
    ...base,
    ...spec,

    mass,
    wheelRadius: metrics.wheelRadius,
    wheelWidth: metrics.wheelWidth,
    trackHalf: metrics.trackHalf,
    wheelbaseHalf: metrics.wheelbaseHalf,
    /** Overall body height — the chase camera scales itself off this. */
    bodyHeight: metrics.bodyHeight,

    // Body origin is the contact plane, and these models include a floor pan
    // reaching all the way down to it. Wrapping the collider around the full
    // body height therefore rests its underside on the road: the box scrapes,
    // Rapier's contact friction fights the tyres, and the heavier bodies (van,
    // monster truck) simply never move. Lift it to a real ground clearance —
    // always more than the static sag, or it grounds out the moment it settles.
    chassis: {
      hx: metrics.bodyHalfWidth * 0.92,
      hy: (metrics.bodyHeight - clearance) * 0.5,
      hz: metrics.bodyHalfLength * 0.96,
    },
    chassisCentreY: clearance + (metrics.bodyHeight - clearance) * 0.5,
    groundClearance: clearance,
    comOffset: { x: 0, y: metrics.bodyHeight * spec.comHeight, z: 0.04 },

    // The anchor is where the strut meets the body. Subtracting the static sag
    // is what makes the settled physics pose coincide with the model's design
    // pose: at rest the body origin lands exactly on the contact plane and each
    // wheel centre exactly one rolling radius above it — which is where the FBX
    // author put them. Omit the sag term and the whole car sits buried by 12 cm.
    anchorHeight: metrics.wheelRadius + restLength - sag,
    staticSag: sag,
    restLength,
    springK,
    damperBump: ZETA_BUMP * cCrit,
    damperRebound: ZETA_REBOUND * cCrit,
    maxSpringForce: mass * gravity * 3.0,
    antiRollFront: barTotal * 0.42,
    antiRollRear: barTotal * 0.58,

    driveBias: DRIVE_SPLIT[spec.drive] || DRIVE_SPLIT.awd,
    // Brake torque is sized against weight, not copied between vehicles.
    brakeForce: [
      mass * gravity * 0.3,
      mass * gravity * 0.3,
      mass * gravity * 0.2,
      mass * gravity * 0.2,
    ],
    handbrakeForce: mass * gravity * 0.36,
    rollingResistance: mass * 0.26,

    tyreFriction: spec.grip,
    /**
     * Lateral acceleration at which this body tips, with margin. The steering
     * law takes the lower of this and the grip limit, so top-heavy vehicles
     * run out of steering angle before they run out of roll — they push wide
     * instead of falling over, which is how such things behave in reality.
     */
    rolloverAccel,
    staticStabilityFactor: ssf,
    dragCoefficient: spec.dragCoefficient,
    downforce: spec.downforce,

    idleRpm: Math.round(spec.maxRpm * 0.12),
    shiftUpRpm: Math.round(spec.maxRpm * 0.90),
    shiftDownRpm: Math.round(spec.maxRpm * 0.40),
  };
}
