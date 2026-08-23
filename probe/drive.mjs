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
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';
import { RaycastVehicle } from '../src/vehicle.js';
import { Traffic } from '../src/traffic.js';
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
  // Stanley-style lane keeping: a heading term plus a cross-track term whose
  // authority falls off with speed. A bare proportional controller on lateral
  // position oscillates and then leaves the road, which the project's own
  // ledger records as having been mistaken for vehicle instability once
  // already — an unstable autopilot measures the autopilot, not the car.
  const lat = path.lateralOffset(vehicle.pos, carS);
  {
    const f = path.frameAt(carS + 6);
    // Signed yaw from the car's heading to the road's, about world up.
    const cross = vehicle.fwd.x * f.tan.z - vehicle.fwd.z * f.tan.x;
    const headingErr = Math.atan2(-cross, vehicle.fwd.x * f.tan.x + vehicle.fwd.z * f.tan.z);
    // Positive steer yaws left, which moves the car toward -x — the direction
    // of DECREASING lateral offset. Hence the sign on the cross-track term.
    const crossTrack = Math.atan2(2.2 * (lat - ROAD.laneWidth * 0.5), Math.abs(vehicle.forwardSpeed) + 4);
    input.steer = Math.max(-1, Math.min(1, (headingErr + crossTrack) / vehicle.V.maxSteer));
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
