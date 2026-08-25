/**
 * End-to-end drive. Boots the real modules — terrain, path, chunks, the raycast
 * vehicle, engine_sim through the powertrain bridge, and traffic — and drives
 * for a couple of simulated minutes with the same loop ordering main.js uses.
 *
 * This is the only check that sees the pieces working against each other.
 */
import { createMockContext, installGlobals } from '../engine_sim/test/mock-audio.mjs';
installGlobals(createMockContext().ctx);
globalThis.document = {
  createElement: (t) => ({
    tagName: t, style: {}, setAttribute() {}, getContext: () => null,
    addEventListener(e, c) { if (e === 'load') setTimeout(c, 0); },
    removeEventListener() {}, set src(v) {}, get src() { return ''; },
  }),
  createElementNS: (n, t) => globalThis.document.createElement(t),
};
globalThis.self = globalThis;

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import fs from 'node:fs';
import { WORLD, CHUNK, ROAD, VEHICLE } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath, makeFrame } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';
import { RaycastVehicle } from '../src/vehicle.js';
import { Traffic } from '../src/traffic.js';

/** Scratch frame for the autopilot's corner scan — it runs a dozen times a frame. */
const _look = makeFrame();
import { Powertrain } from '../src/powertrain.js';
import { CARS, carById, buildCarParams } from '../src/cars.js';
import { buildCarFromObject } from '../src/assets.js';

const seed = process.argv[2] || WORLD.seed;
const SECONDS = Number(process.argv[3] || 90);

const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
const loader = new FBXLoader();
const models = new Map();
for (const spec of CARS) {
  const buf = fs.readFileSync(`assets/car_models/Fbx/${spec.file}`);
  const root = loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  models.set(spec.id, buildCarFromObject(root, null, spec.file));
}
const roster = CARS.filter((c) => models.has(c.id));

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });
world.timestep = WORLD.fixedStep;
const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const scene = new THREE.Scene();
const chunks = new ChunkManager({ scene, world, RAPIER, path, terrain, foliage: new Map() });
chunks.preload(90);
world.step();

const spec = carById('sport');
const vehicle = new RaycastVehicle({
  RAPIER, world, scene, params: buildCarParams(spec, models.get('sport').metrics, VEHICLE, Math.abs(WORLD.gravity)),
  model: models.get('sport'),
});
const traffic = new Traffic({ scene, path, chunks, models, roster });
const powertrain = new Powertrain();
await powertrain.start({ spec, V: vehicle.V }, createMockContext().ctx);

let carS = 90;
const g0 = chunks.groundAt(carS, ROAD.laneWidth * 0.5, new THREE.Vector3());
g0.y += 0.03;
vehicle.respawn(g0, path.frameAt(carS).tan);

const dt = 1 / 60;

// ---- parked on the title screen -------------------------------------------
{
  // A seed with a gradient under the spawn is the whole point of the test: the
  // car used to roll away down the road while the player picked a paint colour.
  vehicle.setParked(true);
  const start = vehicle.pos.clone();
  const grade = (chunks.groundAt(carS + 20, 0, new THREE.Vector3()).y -
                 chunks.groundAt(carS - 20, 0, new THREE.Vector3()).y) / 40;
  for (let i = 0; i < 600; i++) {
    vehicle.beginStep();
    vehicle.update(WORLD.fixedStep, { steer: 0, throttle: 0, brake: 0, handbrake: false });
    world.step();
    vehicle.syncVisuals(1);
  }
  const drift = Math.hypot(vehicle.pos.x - start.x, vehicle.pos.z - start.z);
  console.log(`  [${drift < 0.05 ? ' ok ' : 'FAIL'}] parked car stays put          ${(drift * 100).toFixed(1)} cm over 5 s on a ${(grade * 100).toFixed(1)}% grade`);
  vehicle.setParked(false);
}

// ---- garage phase: parked, gearbox in neutral, throttle blipped ------------
{
  powertrain.blip();
  let minRpm = Infinity, maxRpm = 0, gears = new Set();
  for (let i = 0; i < 150; i++) {
    const th = powertrain.blipThrottle(dt);
    powertrain.update(dt, { wheelSpeed: 0, throttle: th, brake: 0, reverse: false, neutral: true });
    vehicle.beginStep();
    vehicle.update(WORLD.fixedStep, { steer: 0, throttle: 0, brake: 0, handbrake: false });
    world.step();
    minRpm = Math.min(minRpm, powertrain.rpm);
    maxRpm = Math.max(maxRpm, powertrain.rpm);
    gears.add(powertrain.gear);
  }
  const revved = maxRpm > minRpm * 1.6;
  const neutral = gears.size === 1 && gears.has(0);
  console.log(`  [${revved ? ' ok ' : 'FAIL'}] garage blip revs the engine  ${minRpm.toFixed(0)} -> ${maxRpm.toFixed(0)} rpm`);
  console.log(`  [${neutral ? ' ok ' : 'FAIL'}] gearbox held in neutral      gear(s) seen: ${[...gears].join(',')}`);
  // Settle before driving, the way pressing Drive does.
  for (let i = 0; i < 60; i++) {
    powertrain.update(dt, { wheelSpeed: 0, throttle: 0, brake: 0, reverse: false, neutral: false });
  }
  console.log(`  [${powertrain.gear >= 1 ? ' ok ' : 'FAIL'}] first gear selected on Drive  gear ${powertrain.gear}`);
}

const steps = Math.round(SECONDS * 60);
let acc = 0;
const ok = (b) => (b ? ' ok ' : 'FAIL');
let airborneFrames = 0, maxSpeed = 0, nan = 0, maxAccel = 0, hardHits = 0;
let prevSpeed = 0, respawns = 0, maxAltDrop = 0;
// Impacts are supposed to be violent. Counting them as "hard hits" would be
// measuring the feature, so frames near one are attributed separately.
let impacts = 0, impactAccel = 0, sinceImpact = 999;
let maxLat = 0, maxYaw = 0;
const input = { steer: 0, throttle: 1, brake: 0, handbrake: false };

for (let i = 0; i < steps; i++) {
  /**
   * Stanley-style lane keeping: a heading term plus a cross-track term whose
   * authority falls off with speed. A bare proportional controller on lateral
   * position oscillates and then leaves the road, which the project's own
   * ledger records as having been mistaken for vehicle instability once
   * already — an unstable autopilot measures the autopilot, not the car.
   *
   * Two "improvements" were tried here and both were worse, which is worth
   * recording. Lengthening the 6 m reference point to scale with speed took the
   * lane error from 5.8 m to 18 m and the car started spinning: Stanley's
   * cross-track term is derived for a reference AT THE FRONT AXLE, and a long
   * lookahead double-counts the correction. Replacing the whole thing with pure
   * pursuit was worse again — its gain falls off as the lookahead grows, so it
   * tracks a path it is already on beautifully and cannot recover onto one it
   * has left. The controller was never the problem.
   */
  const lat = path.lateralOffset(vehicle.pos, carS);
  {
    const f = path.frameAt(carS + 6);
    // Signed yaw from the car's heading to the road's, about world up.
    const cross = vehicle.fwd.x * f.tan.z - vehicle.fwd.z * f.tan.x;
    const headingErr = Math.atan2(-cross, vehicle.fwd.x * f.tan.x + vehicle.fwd.z * f.tan.z);
    // Positive steer yaws left, which moves the car toward -x — the direction
    // of DECREASING lateral offset. Hence the sign on the cross-track term.
    const crossTrack = Math.atan2(2.2 * (lat - ROAD.laneWidth * 0.5), Math.abs(vehicle.forwardSpeed) + 4);

    /**
     * Feed-forward: the steer the corner needs, before any error exists.
     *
     * A purely proportional tracker has a STEADY-STATE OFFSET against a
     * constant-curvature path — it can only ask for steering in proportion to
     * how far off line it already is, so on a long bend it settles wherever the
     * error is big enough to buy the angle the corner needs, and sits there.
     * That is a property of the controller, not of the road: traced on the
     * alignment this reported 5.8 m on, the car was carrying zero tyre slip and
     * a third of available lock the whole way round, quietly running wide at a
     * millimetre a metre.
     *
     * Raising the gain does not fix it and makes it worse — swept, 3.6 and 5.0
     * took the worst seed to 14.9 m and 15.1 m as the loop went unstable. The
     * Ackermann angle for the local radius does fix it, because it is the term
     * that was missing rather than a larger dose of the term that was there.
     */
    const steerFF = (vehicle.V.wheelbaseHalf * 2) * path.frameAt(carS + 12, _look).curv;

    /**
     * ...divided by the lock ACTUALLY AVAILABLE, not by `V.maxSteer`.
     *
     * `input.steer` is a normalised command: the vehicle multiplies it by
     * whatever lock the grip and rollover limits leave at this speed, which is
     * the right contract for a human holding a stick. Everything above computes
     * a steering ANGLE, and converting an angle to that command with the
     * unlimited maximum quietly divides it by six at 160 km/h. The car then
     * tracked a wider radius than the road, drifted out at about a millimetre a
     * metre with zero tyre slip and a third of the lock it thought it was
     * using, and reported the verge it eventually found as a fault in the road.
     *
     * This is a harness bug of the same family as the ones in AGENT_CONTEXT §7:
     * it looked exactly like the world being wrong, and it got worse as the
     * alignment got more interesting, which is precisely the correlation that
     * makes it convincing.
     */
    const lock = Math.max(1e-3, vehicle.steerLimit || vehicle.V.maxSteer);
    input.steer = Math.max(-1, Math.min(1,
      (headingErr + crossTrack + steerFF) / lock));

    /**
     * ...and it lifts for corners, which is the one thing that actually needed
     * fixing.
     *
     * The alignment used to barely turn, so "90 s flat out" was a fair
     * description of a lap and the throttle could be pinned at 1. The cost
     * router puts real bends in it — measured, the tightest need about 265 km/h
     * against a top speed of 250 — and a test that refuses to brake for those
     * is measuring what happens when you do not brake. "Worst lane error" stops
     * meaning anything about the road or the car.
     *
     * Corner speed from the curvature ahead and the grip actually available:
     * v = sqrt(a / kappa), at 85% of the tyres' limit so it is a driver's
     * margin rather than a computer's.
     */
    // The WORST curvature between here and the lookahead, not the curvature at
    // one point of it. Reading a single station ahead misses the corner the car
    // is already in — traced on one seed, the model was looking at an 828 m
    // radius 73 m up the road while the car sat in a 270 m one, so it held full
    // throttle into a bend it had never seen. A driver looks at the whole
    // corner; so does this now.
    const reach = Math.min(110, 25 + Math.abs(vehicle.forwardSpeed) * 1.4);
    let kappa = 0;
    for (let d = 0; d <= reach; d += 10) {
      kappa = Math.max(kappa, Math.abs(path.frameAt(carS + d, _look).curv));
    }
    const aMax = vehicle.V.tyreFriction * Math.abs(WORLD.gravity) * 0.58;
    const vCorner = kappa > 1e-5 ? Math.sqrt(aMax / kappa) : 1e3;
    const speed = Math.abs(vehicle.forwardSpeed);
    input.throttle = speed < vCorner ? 1 : 0;
    input.brake = speed > vCorner * 1.1 ? 0.6 : 0;

    // And it lifts when it is running wide, which is the other thing a driver
    // does and the reason this matters here: the autopilot is a fixed-gain
    // controller with no sense of its own error, so on a road with corners in
    // it, it will hold the throttle open while drifting onto the verge and then
    // report the ditch it finds there as a fault in the world.
    const wide = Math.abs(lat - ROAD.laneWidth * 0.5);
    if (wide > 2.4) {
      input.throttle = 0;
      if (wide > 3.6) input.brake = Math.max(input.brake, 0.45);
    }
  }

  vehicle.setSurface(0);
  vehicle.setDriveForce(powertrain.update(dt, {
    wheelSpeed: vehicle.forwardSpeed, throttle: input.throttle, brake: input.brake, reverse: false,
  }));

  acc += dt;
  let sub = 0;
  while (acc >= WORLD.fixedStep && sub < WORLD.maxSubSteps) {
    vehicle.beginStep();
    vehicle.update(WORLD.fixedStep, input);
    world.step();
    acc -= WORLD.fixedStep;
    sub++;
  }
  if (acc > WORLD.fixedStep) acc = WORLD.fixedStep * 0.999;
  vehicle.syncVisuals(acc / WORLD.fixedStep);

  carS = path.projectPoint(vehicle.pos, carS);
  chunks.update(carS);
  traffic.update(dt, {
    s: carS, v: lat, speed: Math.abs(vehicle.forwardSpeed), flashing: false, vehicle,
  });

  if (traffic.lastImpact >= 1) { impacts++; sinceImpact = 0; } else sinceImpact++;
  if (sinceImpact > 120) {
    maxLat = Math.max(maxLat, Math.abs(lat - ROAD.laneWidth * 0.5));
    maxYaw = Math.max(maxYaw, Math.abs(vehicle.body.angvel().y));
  }

  if (!Number.isFinite(vehicle.pos.x + vehicle.pos.y + vehicle.pos.z + vehicle.speed)) nan++;
  if (vehicle.groundedCount === 0) airborneFrames++;
  maxSpeed = Math.max(maxSpeed, vehicle.speed);
  const a = Math.abs(vehicle.speed - prevSpeed) / dt;
  if (i > 30) {
    if (sinceImpact < 8) impactAccel = Math.max(impactAccel, a);
    else { maxAccel = Math.max(maxAccel, a); if (a > 120) hardHits++; }
  }
  prevSpeed = vehicle.speed;

  // Against the road under the car's own lateral offset, not the centreline:
  // on a banked road in a lane those differ, and after a shunt the car may
  // genuinely be down an embankment.
  const groundY = chunks.groundAt(carS, 0, new THREE.Vector3()).y;
  if (sinceImpact > 120) {
    maxAltDrop = Math.max(maxAltDrop, chunks.groundAt(carS, lat, new THREE.Vector3()).y - vehicle.pos.y);
  }
  if (vehicle.upsideDownFor > 2.5 || Math.abs(lat) > CHUNK.recoverLateral || vehicle.pos.y < groundY - 90) {
    const s = Math.max(90, carS - 12);
    chunks.update(s, 6);
    const g = chunks.groundAt(s, ROAD.laneWidth * 0.5, new THREE.Vector3());
    g.y += 0.03;
    vehicle.respawn(g, path.frameAt(s).tan);
    carS = s;
    respawns++;
  }
}

console.log(`\nseed "${seed}" — ${SECONDS}s flat out in the Sport, ${(carS - 90).toFixed(0)} m covered\n`);
console.log(`  [${ok(nan === 0)}] non-finite vehicle states     ${nan}`);
console.log(`  [${ok(maxSpeed < VEHICLE.maxChassisSpeed - 1)}] top speed                     ${(maxSpeed * 3.6).toFixed(0)} km/h  (clamp sits at ${(VEHICLE.maxChassisSpeed * 3.6).toFixed(0)})`);
console.log(`  [${ok(airborneFrames / steps < 0.08)}] airborne                      ${(100 * airborneFrames / steps).toFixed(2)} % of frames`);
console.log(`  [${ok(hardHits === 0)}] hard hits away from traffic   ${hardHits}  (worst ${maxAccel.toFixed(0)} m/s^2)`);
console.log(`  [${ok(maxAltDrop < 1.5)}] deepest below the road        ${maxAltDrop.toFixed(2)} m  (settled frames only)`);
console.log(`  [ -- ] ${impacts} impacts, peak ${impactAccel.toFixed(0)} m/s^2 (cap implies ${(11 / dt).toFixed(0)})`);
console.log(`  [${ok(maxLat < 4)}] worst lane error, no impact   ${maxLat.toFixed(2)} m`);
console.log(`  [${ok(maxYaw < 2.0)}] worst yaw rate, no impact     ${maxYaw.toFixed(2)} rad/s`);
console.log(`  [${ok(respawns === 0)}] recoveries triggered          ${respawns}`);
console.log(`  [ -- ] engine ${powertrain.rpm.toFixed(0)} rpm, gear ${powertrain.gearLabel()}, ${traffic.cars.length} cars alive`);
