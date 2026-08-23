/**
 * How much steering does the driver actually have, and can a slide be caught?
 *
 * Runs on flat ground so the terrain plays no part. Three questions:
 *   1. usable steering angle across the speed range;
 *   2. steady-state cornering — what the car will actually pull;
 *   3. provoke a slide, then try to catch it, and see whether countersteer
 *      arrests the yaw or the car simply spins.
 */
// FBXLoader reaches for the DOM to build texture images; the same stub the
// other probes use, hoisted so it is in place before three is imported.
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
import { WORLD, VEHICLE } from '../src/config.js';
import { RaycastVehicle } from '../src/vehicle.js';
import { CARS, carById, buildCarParams } from '../src/cars.js';
import { buildCarFromObject } from '../src/assets.js';

const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
const loader = new FBXLoader();
const models = new Map();
for (const spec of CARS) {
  const buf = fs.readFileSync(`assets/car_models/Fbx/${spec.file}`);
  models.set(spec.id, buildCarFromObject(
    loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), ''), null, spec.file));
}
await RAPIER.init();

function makeWorld() {
  const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });
  world.timestep = WORLD.fixedStep;
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(4000, 1, 4000).setTranslation(0, -1, 0).setFriction(1.0));
  return world;
}

function spawn(id) {
  const world = makeWorld();
  const spec = carById(id);
  const v = new RaycastVehicle({
    RAPIER, world, scene: new THREE.Scene(),
    params: buildCarParams(spec, models.get(id).metrics, VEHICLE, Math.abs(WORLD.gravity)),
    model: models.get(id),
  });
  v.respawn(new THREE.Vector3(0, 0.03, 0), new THREE.Vector3(0, 0, -1));
  return { world, v };
}

const h = WORLD.fixedStep;
function step(sim, input, drive = 0) {
  sim.v.setSurface(0);
  sim.v.setDriveForce(drive);
  sim.v.beginStep();
  sim.v.update(h, input);
  sim.world.step();
}
const IN = (steer = 0, throttle = 0, brake = 0, handbrake = false) => ({ steer, throttle, brake, handbrake });

// Bring a car up to speed by driving the body directly, then let it settle.
function atSpeed(id, mps) {
  const sim = spawn(id);
  for (let i = 0; i < 120; i++) step(sim, IN());
  const q = sim.v.body.rotation();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
  sim.v.body.setLinvel({ x: fwd.x * mps, y: 0, z: fwd.z * mps }, true);
  for (const w of sim.v.wheels) w.spin = 0;
  return sim;
}

console.log('=== usable steering angle vs speed (Sport) ===');
console.log('  km/h    max steer   lat accel it implies   road needs (165 m min radius)');
for (const kmh of [30, 60, 100, 150, 200, 250]) {
  const sim = atSpeed('sport', kmh / 3.6);
  step(sim, IN(1));
  for (let i = 0; i < 60; i++) step(sim, IN(1));
  const V = sim.v.V;
  const L = V.wheelbaseHalf * 2;
  const deg = (sim.v.steer * 180) / Math.PI;
  const vms = kmh / 3.6;
  const lat = (vms * vms * Math.tan(Math.abs(sim.v.steer))) / L;
  const need = (180 / Math.PI) * Math.atan(L / 165);
  console.log(`  ${String(kmh).padStart(4)}    ${deg.toFixed(2).padStart(6)} deg   ${lat.toFixed(1).padStart(6)} m/s^2` +
    `              ${need.toFixed(2)} deg  ->  ${(deg / need).toFixed(2)}x headroom`);
}

console.log('\n=== provoke a slide, then try to catch it (Sport, 30 m/s) ===');
{
  const sim = atSpeed('sport', 30);
  // Handbrake turn to break the rear loose.
  for (let i = 0; i < Math.round(0.7 / h); i++) step(sim, IN(1, 0.4, 0, true), 4000);
  const yawAt = () => sim.v.body.angvel().y;
  const peak = yawAt();
  // Countersteer and feed power, the way a driver would.
  // "Spun" means the car went round, not that it was yawing fast at the instant
  // the handbrake came off — the provocation itself guarantees that.
  let caught = -1, maxYaw = Math.abs(peak), heading = 0;
  for (let i = 0; i < Math.round(4.0 / h); i++) {
    step(sim, IN(-1, 0.5, 0, false), 3000);
    const y = yawAt();
    heading += y * h;
    maxYaw = Math.max(maxYaw, Math.abs(y));
    if (caught < 0 && Math.abs(y) < 0.35 && i > 20) caught = i * h;
  }
  const spun = Math.abs(heading) > Math.PI;
  console.log(`  yaw rate at release ${Math.abs(peak).toFixed(2)} rad/s, peak during recovery ${maxYaw.toFixed(2)}`);
  console.log(`  countersteer ${caught >= 0 ? `arrested it in ${caught.toFixed(2)} s` : 'NEVER arrested it'}` +
    `, total rotation ${((Math.abs(heading) * 180) / Math.PI).toFixed(0)} deg${spun ? '  (WENT ROUND)' : ''}`);
}

// Tall vehicles: opening the lock in a slide bypasses the rollover limit, so
// check the things it exists to prevent.
console.log('\n=== rollover check, tall vehicles, hard slalom at 25 m/s ===');
for (const id of ['monster', 'van', 'military', 'pickup']) {
  const sim = atSpeed(id, 25);
  let worstTilt = 1, over = 0;
  for (let i = 0; i < Math.round(6.0 / h); i++) {
    const steer = Math.sin(i * h * 2.2) > 0 ? 1 : -1;
    step(sim, IN(steer, 0.6, 0, false), 3000);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(
      new THREE.Quaternion(...Object.values(sim.v.body.rotation())));
    worstTilt = Math.min(worstTilt, up.y);
    if (up.y < 0.3) over++;
  }
  const ok = worstTilt > 0.45 ? ' ok ' : 'FAIL';
  console.log(`  [${ok}] ${id.padEnd(9)} worst tilt (1 = level) ${worstTilt.toFixed(2)}, frames near rolled ${over}`);
}

console.log('\n=== can a drift be held? (Sport, handbrake released, power on) ===');
{
  const sim = atSpeed('sport', 28);
  for (let i = 0; i < Math.round(0.6 / h); i++) step(sim, IN(1, 0.3, 0, true), 3000);
  let held = 0, slipSum = 0, n = 0;
  for (let i = 0; i < Math.round(3.0 / h); i++) {
    step(sim, IN(-0.35, 1, 0, false), 6500);
    const s = sim.v.slip;
    slipSum += s; n++;
    if (s > 0.25 && Math.abs(sim.v.body.angvel().y) < 2.2) held += h;
  }
  console.log(`  seconds spent sliding but still controllable: ${held.toFixed(2)} of 3.00`);
  console.log(`  mean slip ${(slipSum / n).toFixed(3)}, final speed ${(sim.v.speed * 3.6).toFixed(0)} km/h`);
}

// How much of the recovery is the damper (an assist) versus the steering and
// tyre changes (honest)? Rerun the catch with the damper switched off.
console.log('\n=== how much of the catch is the assist? ===');
{
  const V0 = VEHICLE.spinRecovery;
  for (const strength of [0, V0]) {
    VEHICLE.spinRecovery = strength;
    const sim = atSpeed('sport', 30);
    for (let i = 0; i < Math.round(0.7 / h); i++) step(sim, IN(1, 0.4, 0, true), 4000);
    let caught = -1, heading = 0;
    for (let i = 0; i < Math.round(5.0 / h); i++) {
      step(sim, IN(-1, 0.5, 0, false), 3000);
      const y = sim.v.body.angvel().y;
      heading += y * h;
      if (caught < 0 && Math.abs(y) < 0.35 && i > 20) caught = i * h;
    }
    console.log(`  spinRecovery ${strength.toFixed(1)}: caught in ` +
      `${caught >= 0 ? caught.toFixed(2) + ' s' : 'never'}, rotated ${((Math.abs(heading) * 180) / Math.PI).toFixed(0)} deg`);
  }
  VEHICLE.spinRecovery = V0;
}
