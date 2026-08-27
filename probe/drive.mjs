/**
 * drive.mjs — end-to-end drive.
 *
 * Boots path, chunks, the vehicle, powertrain and traffic, then drives under
 * the main.js loop ordering.
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

/** Scratch frame for the autopilot's corner scan — used a dozen times a frame. */
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
  // A gradient under the spawn used to let the car roll away while the player
  // picked a paint colour.
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
// Impacts are supposed to be violent; frames near one are attributed separately.
let impacts = 0, impactAccel = 0, sinceImpact = 999;
let maxLat = 0, maxYaw = 0;
const input = { steer: 0, throttle: 1, brake: 0, handbrake: false };

for (let i = 0; i < steps; i++) {
  // Stanley-style lane keeping: heading term plus a cross-track term whose
  // authority falls off with speed. A bare P controller on lateral position
  // oscillates and leaves the road.
  const lat = path.lateralOffset(vehicle.pos, carS);
  {
    const f = path.frameAt(carS + 6);
    // Signed yaw from the car's heading to the road's, about world up.
    const cross = vehicle.fwd.x * f.tan.z - vehicle.fwd.z * f.tan.x;
    const headingErr = Math.atan2(-cross, vehicle.fwd.x * f.tan.x + vehicle.fwd.z * f.tan.z);
    // Positive steer yaws left toward -x — hence the sign on the cross-track term.
    const crossTrack = Math.atan2(2.2 * (lat - ROAD.laneWidth * 0.5), Math.abs(vehicle.forwardSpeed) + 4);

    // Feed-forward: the Ackermann angle for the local radius. A purely
    // proportional tracker holds a steady-state offset against a constant
    // curvature path, and raising the gain goes unstable.
    const steerFF = (vehicle.V.wheelbaseHalf * 2) * path.frameAt(carS + 12, _look).curv;

    // ...divided by the lock ACTUALLY available, not `V.maxSteer`.
    const lock = Math.max(1e-3, vehicle.steerLimit || vehicle.V.maxSteer);
    input.steer = Math.max(-1, Math.min(1,
      (headingErr + crossTrack + steerFF) / lock));

    // ...and it lifts for corners. Corner speed from the curvature ahead and
    // the grip actually available, at 85% of the tyres' limit.
    // The WORST curvature between here and the lookahead, not at one station:
    // reading a single point misses the corner the car is already in.
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

    // And it lifts when running wide, so the drift is not reported as a fault.
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

  // Ground under the car's own lateral offset: on a banked road those differ.
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
