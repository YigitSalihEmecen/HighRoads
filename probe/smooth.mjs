/**
 * Does the car move smoothly on screen, at any frame rate?
 *
 * This is the only probe that measures what the PLAYER sees rather than what
 * the simulation does, and it exists because the two came apart badly. The
 * world-space motion was already perfect — render interpolation put the car
 * exactly `speed * dt` further along every single frame, at every frame rate —
 * and the car still visibly sprang backwards at speed, worse the lower the
 * frame rate went. Neither `drive.mjs` nor `handling.mjs` can see that: both
 * ask where the car IS, and the fault was entirely in where it was DRAWN
 * relative to the camera.
 *
 * So the metric here is the car's position in CAMERA SPACE, frame to frame.
 * Under constant motion a chase camera should hold the car at a constant
 * distance; anything else is the springing.
 *
 * Two faults were found this way, and both are re-introducible:
 *
 *   1. Exponential damping toward a MOVING goal settles at a lag containing
 *      `dt` (see util.dampTrack), so the camera sat 3.98 m behind at 60 fps and
 *      3.51 m at 30 fps — and moved between them whenever frame time wobbled.
 *   2. `WORLD.maxSubSteps * fixedStep` was 41.7 ms while `main.js` clamped the
 *      frame to 50 ms. Every frame between those two ran the physics short and
 *      discarded the rest, while the camera and everything else were handed the
 *      full `dt`. A 90 ms hitch advanced the world 46% of the frame.
 *
 * Frame times are SCRIPTED, including jitter and spikes, because a steady frame
 * rate hides both faults completely — every steady rate measured clean while
 * the game was visibly broken.
 */
globalThis.document = {
  createElement: (t) => ({
    tagName: t, style: {}, setAttribute() {}, getContext: () => null,
    addEventListener(e, c) { if (e === 'load') setTimeout(c, 0); },
    removeEventListener() {}, set src(v) {}, get src() { return ''; },
  }),
  createElementNS: (n, t) => globalThis.document.createElement(t),
};
globalThis.self = globalThis;
import { createMockContext, installGlobals } from '../engine_sim/test/mock-audio.mjs';
installGlobals(createMockContext().ctx);
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import fs from 'node:fs';
import { WORLD, VEHICLE, CAMERA } from '../src/config.js';
import { RaycastVehicle } from '../src/vehicle.js';
import { ChaseCamera } from '../src/camera.js';
import { Powertrain } from '../src/powertrain.js';
import { carById, buildCarParams } from '../src/cars.js';
import { buildCarFromObject } from '../src/assets.js';

const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
const spec = carById(process.argv[2] || 'sport');
const buf = fs.readFileSync(`assets/car_models/Fbx/${spec.file}`);
const model = buildCarFromObject(new FBXLoader().parse(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), ''), null, spec.file);
await RAPIER.init();

const h = WORLD.fixedStep;
/** The longest frame the substep budget can actually follow. Mirrors main.js. */
const MAX_FRAME = WORLD.maxSubSteps * h;

/** Springing you would notice, mm of camera-space movement peak to peak. */
const SPRING_LIMIT = 40;
/** How far the world's advance may stray from `speed * dt`. */
const ADVANCE_TOL = 0.02;

let bad = 0;
const rows = [];

async function run(label, frameDt, { jitter = 0, spikeEvery = 0, spikeDt = 0, steer = 0 } = {}) {
  const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });
  world.timestep = h;
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(6000, 1, 6000).setTranslation(0, -1, 0).setFriction(1.0));
  world.step();

  const V = buildCarParams(spec, model.metrics, VEHICLE, Math.abs(WORLD.gravity));
  const v = new RaycastVehicle({ RAPIER, world, scene: new THREE.Scene(), params: V, model });
  v.respawn(new THREE.Vector3(0, 0.03, 0), new THREE.Vector3(0, 0, -1));
  const pt = new Powertrain();
  await pt.start({ spec, V }, createMockContext().ctx);

  const cam = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, CAMERA.near, CAMERA.far);
  const rig = new ChaseCamera(cam);
  const input = { steer, throttle: 1, brake: 0, handbrake: false };

  // main.js's loop, in order, with its clamp.
  let acc = 0;
  const frame = (rawDt) => {
    const dt = Math.min(rawDt, MAX_FRAME);
    v.setDriveForce(pt.update(dt, {
      wheelSpeed: v.forwardSpeed, throttle: 1, brake: 0, reverse: false, neutral: false }));
    v.setSurface(0);
    acc += dt;
    let steps = 0;
    while (acc >= h && steps < WORLD.maxSubSteps) {
      v.beginStep(); v.update(h, input); world.step(); acc -= h; steps++;
    }
    if (acc > h) acc = h * 0.999;
    v.syncVisuals(acc / h);
    rig.update(dt, v);
    return dt;
  };

  for (let i = 0; i < Math.round(14 / frameDt); i++) frame(frameDt);   // reach speed

  let rnd = 0x2545f49;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const advance = [], camDist = [];
  const prev = v.renderPos.clone();
  const frames = Math.round(6 / frameDt);
  for (let i = 0; i < frames; i++) {
    let raw = frameDt * (1 + (rand() * 2 - 1) * jitter);
    if (spikeEvery && i % spikeEvery === 0) raw = spikeDt;
    const dt = frame(raw);
    advance.push(v.renderPos.distanceTo(prev) / Math.max(1e-6, v.speed * dt));
    prev.copy(v.renderPos);
    cam.updateMatrixWorld(true);
    // Distance from the eye, which is what a chase camera holds constant.
    camDist.push(v.renderPos.distanceTo(cam.position));
  }

  const step = camDist.slice(1).map((d, i) => d - camDist[i]);
  const p2p = (Math.max(...step) - Math.min(...step)) * 1000;
  const advMin = Math.min(...advance), advMax = Math.max(...advance);
  const ok = p2p <= SPRING_LIMIT && advMin > 1 - ADVANCE_TOL && advMax < 1 + ADVANCE_TOL;
  if (!ok) bad++;
  rows.push(`  [${ok ? ' ok ' : 'FAIL'}] ${label.padEnd(24)} ${(v.speed * 3.6).toFixed(0).padStart(4)} km/h  ` +
    `advance ${advMin.toFixed(3)}..${advMax.toFixed(3)}   spring ${p2p.toFixed(0).padStart(5)} mm`);

  v.dispose();
  pt.dispose();
}

console.log(`\n  ${spec.name}: how far the car moves relative to the camera, frame to frame.`);
console.log(`  Constant motion should hold it still. Limit ${SPRING_LIMIT} mm.\n`);

await run('144 fps', 1 / 144);
await run('60 fps', 1 / 60);
await run('60 fps, 20% jitter', 1 / 60, { jitter: 0.20 });
await run('45 fps', 1 / 45);
await run('30 fps', 1 / 30);
await run('30 fps, 30% jitter', 1 / 30, { jitter: 0.30 });
await run('24 fps', 1 / 24);
await run('20 fps', 1 / 20);
await run('60 fps, 90 ms hitches', 1 / 60, { jitter: 0.05, spikeEvery: 40, spikeDt: 0.09 });
await run('30 fps, cornering', 1 / 30, { jitter: 0.30, steer: 0.55 });

console.log(rows.join('\n'));
console.log(`\n  [${bad ? 'FAIL' : ' ok '}] ${rows.length} frame-rate patterns` +
  (bad ? `  — ${bad} springing` : ''));
process.exit(bad ? 1 : 0);
