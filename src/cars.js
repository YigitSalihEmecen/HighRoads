/**
 * cars.js — the vehicle roster.
 *
 * Each entry names an FBX and the numbers that define a vehicle. Wheelbase,
 * track, rolling radius and body box come from the model at load time.
 * Spring and damping derive from mass so all vehicles drive similarly.
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
    engine: 'v8flat',
    gearbox: 'dct',
    shiftTimeMs: 45,
    mass: 1180,
    maxRpm: 7600,
    gearRatios: [-3.3, 0, 3.62, 2.24, 1.58, 1.19, 0.96, 0.79],
    finalDrive: 3.8,
    drive: 'rwd',
    grip: 1.44,
    comHeight: 0.38,
    travelScale: 1.05,
    dragCoefficient: 0.52,
    downforce: 3.2,
  },
  {
    id: 'muscle',
    defaultColor: 'orange',
    file: 'N_Muscle Car_10.fbx',
    name: 'Muscle',
    blurb: 'Big torque, long bonnet, lazy gearing. Will step out if you ask it to.',
    engine: 'v8cross',
    gearbox: 'manual',
    shiftTimeMs: 150,
    mass: 1520,
    maxRpm: 6400,
    gearRatios: [-2.9, 0, 3.06, 1.92, 1.4, 1.0, 0.78],
    finalDrive: 3.4,
    drive: 'rwd',
    grip: 1.32,
    comHeight: 0.4,
    travelScale: 1.15,
    dragCoefficient: 0.62,
    downforce: 2.1,
  },
  {
    id: 'classic',
    defaultColor: 'teal',
    file: 'Classic Car_9.fbx',
    name: 'Classic',
    blurb: 'Skinny tyres, soft springs and modest power. Slow in, wobbly out.',
    engine: 'i6',
    gearbox: 'manual',
    shiftTimeMs: 170,
    mass: 1240,
    maxRpm: 5800,
    gearRatios: [-3.4, 0, 3.4, 2.0, 1.35, 1.0],
    finalDrive: 3.9,
    drive: 'rwd',
    grip: 1.16,
    comHeight: 0.44,
    travelScale: 1.35,
    dragCoefficient: 0.78,
    downforce: 1.1,
  },
  {
    id: 'hatchback',
    defaultColor: 'yellow',
    file: 'Hatchback Car_15.fbx',
    name: 'Hatchback',
    blurb: 'Front-driven, short and eager. Understeers honestly and never bites.',
    engine: 'i4',
    gearbox: 'manual',
    shiftTimeMs: 130,
    mass: 1090,
    maxRpm: 6800,
    gearRatios: [-3.5, 0, 3.55, 2.05, 1.42, 1.06, 0.86],
    finalDrive: 4.1,
    drive: 'fwd',
    grip: 1.3,
    comHeight: 0.42,
    travelScale: 1.1,
    dragCoefficient: 0.6,
    downforce: 1.4,
  },
  {
    id: 'police',
    defaultColor: 'white',
    file: 'Police Car N_4.fbx',
    name: 'Interceptor',
    blurb: 'A saloon with the good engine. Fast, heavy, and stops well.',
    engine: 'v6',
    gearbox: 'auto',
    shiftTimeMs: 120,
    mass: 1650,
    maxRpm: 6900,
    gearRatios: [-3.2, 0, 3.4, 2.1, 1.5, 1.12, 0.9, 0.74],
    finalDrive: 3.6,
    drive: 'rwd',
    grip: 1.38,
    comHeight: 0.41,
    travelScale: 1.15,
    dragCoefficient: 0.66,
    downforce: 2.3,
  },
  {
    id: 'pickup',
    defaultColor: 'blue',
    file: 'Pick Up_11.fbx',
    name: 'Pick-Up',
    blurb: 'Long wheelbase, light rear end, four-wheel drive when it counts.',
    engine: 'v8cross',
    gearbox: 'auto',
    shiftTimeMs: 190,
    mass: 1950,
    maxRpm: 5600,
    gearRatios: [-3.1, 0, 3.8, 2.2, 1.5, 1.08, 0.84],
    finalDrive: 3.7,
    drive: 'awd',
    grip: 1.26,
    comHeight: 0.46,
    travelScale: 1.35,
    dragCoefficient: 0.95,
    downforce: 0.9,
  },
  {
    id: 'van',
    defaultColor: 'silver',
    file: 'N Van_10.fbx',
    name: 'Van',
    blurb: 'Tall, slow and permanently leaning. Surprisingly relaxing.',
    engine: 'i5',
    gearbox: 'auto',
    shiftTimeMs: 200,
    mass: 1820,
    maxRpm: 5200,
    gearRatios: [-3.6, 0, 4.0, 2.3, 1.5, 1.05, 0.82],
    finalDrive: 4.0,
    drive: 'fwd',
    grip: 1.14,
    comHeight: 0.53,
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
    engine: 'i6',
    gearbox: 'auto',
    shiftTimeMs: 210,
    mass: 2600,
    maxRpm: 4800,
    gearRatios: [-3.8, 0, 4.6, 2.6, 1.7, 1.2, 0.9],
    finalDrive: 4.3,
    drive: 'awd',
    grip: 1.28,
    comHeight: 0.48,
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
    engine: 'v8cross',
    gearbox: 'auto',
    shiftTimeMs: 180,
    mass: 2400,
    maxRpm: 6000,
    gearRatios: [-3.4, 0, 4.2, 2.4, 1.6, 1.15, 0.88],
    finalDrive: 4.0,
    drive: 'awd',
    grip: 1.32,
    comHeight: 0.44,
    // Long and soft — capped so body travel stays under a road car's total height.
    travelScale: 1.6,
    dragCoefficient: 1.5,
    downforce: 0.2,
  },
];

/** The paint slot is a plain material, not the atlas — the bodywork's atlas cell is moved off at load. */
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

/** Second paint colour; hex: null leaves the artist's swatch, which is what Stock asks for. */
export const CAR_TRIM_COLORS = [
  { id: 'stock', name: 'Stock', hex: null },
  ...CAR_COLORS,
  { id: 'graphite', name: 'Graphite', hex: 0x3a3d44 },
  { id: 'cream',    name: 'Cream',    hex: 0xe6dcc4 },
];

export function trimColorById(id) {
  return CAR_TRIM_COLORS.find((c) => c.id === id) || CAR_TRIM_COLORS[0];
}

export const DEFAULT_TRIM = 'stock';

/** Any engine can go in any car; the drivetrain profile stays the car's own. */
export const ENGINE_OPTIONS = [
  { id: 'stock',    name: 'Stock' },
  { id: 'vtwin',    name: 'V-twin' },
  { id: 'i3',       name: 'I3 turbo' },
  { id: 'rotary2',  name: 'Rotary' },
  { id: 'i4',       name: 'I4' },
  { id: 'boxer4',   name: 'Boxer-4' },
  { id: 'i5',       name: 'I5 turbo' },
  { id: 'i6',       name: 'I6 turbo' },
  { id: 'i6diesel', name: 'I6 diesel' },
  { id: 'v6',       name: 'V6' },
  { id: 'v6tt',     name: 'V6 twin-turbo' },
  { id: 'flat6',    name: 'Flat-6' },
  { id: 'v8cross',  name: 'V8 cross' },
  { id: 'v8tt',     name: 'V8 twin-turbo' },
  { id: 'v8flat',   name: 'V8 flat' },
  { id: 'v10',      name: 'V10' },
  { id: 'v12',      name: 'V12' },
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

export function buildCarParams(spec, metrics, base, gravity) {
  const mass = spec.mass;

  // Travel follows wheel size — one number for all makes big wheels ride like a go-kart.
  const restLength = metrics.wheelRadius * 1.15 * (spec.travelScale || 1);

  // Static sag is the same fraction of travel for every car: k = m·g/(4·sag).
  const sag = restLength * SAG_FRACTION;
  const springK = (mass * gravity) / (4 * sag);

  // Critical damping for one corner is 2·sqrt(k · m/4) = sqrt(k·m).
  const cCrit = Math.sqrt(springK * mass);

  // Underbody clearance: enough to clear the suspension's own static travel.
  const clearance = Math.max(sag * 1.6, metrics.wheelRadius * 0.55);

  // SSF = half-track/CoM height; a vehicle rolls once lateral accel exceeds SSF·g.
  const comHeight = metrics.bodyHeight * spec.comHeight;
  const ssf = metrics.trackHalf / comHeight;
  const rolloverAccel = gravity * ssf * 0.82;

  // Bar sized from the roll moment the car sees; a fraction of spring rate fails big soft trucks.
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

    // Models include a floor pan to the contact plane — collider must sit above real clearance or it scrapes.
    chassis: {
      hx: metrics.bodyHalfWidth * 0.92,
      hy: (metrics.bodyHeight - clearance) * 0.5,
      hz: metrics.bodyHalfLength * 0.96,
    },
    chassisCentreY: clearance + (metrics.bodyHeight - clearance) * 0.5,
    groundClearance: clearance,
    comOffset: { x: 0, y: metrics.bodyHeight * spec.comHeight, z: 0.04 },

    // Anchor = hub − sag, so the settled pose matches the FBX pose; omit sag and the car sits buried ~12 cm.
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
    /** Top-heavy vehicles run out of steering before they run out of roll — they push wide instead of tipping. */
    rolloverAccel,
    staticStabilityFactor: ssf,
    dragCoefficient: spec.dragCoefficient,
    downforce: spec.downforce,

  };
}
