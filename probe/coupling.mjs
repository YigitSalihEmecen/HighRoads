/**
 * coupling.mjs — does the engine reflect the car?
 *
 * Drives real generated cars on flat ground, up a slope, into a wall, in
 * reverse and through the air, the way main.js feeds the powertrain (road
 * speed + the driven tyres' grip), and checks that:
 *  - with the clutch home and the tyres gripping, rpm is road speed through the gear;
 *  - the force on the car never exceeds what the driven tyres can carry;
 *  - reverse is a loaded gear: rpm follows road speed, the engine pushes the car, a limiter caps it;
 *  - wheelspin reaches the engine, and traction control reins it in;
 *  - off the ground the engine spins the wheels instead of holding road speed.
 */
globalThis.document = { createElement: (t) => ({ tagName: t, style: {}, setAttribute() {}, getContext: () => null, addEventListener() {}, removeEventListener() {} }), createElementNS: (n, t) => globalThis.document.createElement(t) };
globalThis.self = globalThis;
import { createMockContext, installGlobals } from '../engine_sim/test/mock-audio.mjs';
installGlobals(createMockContext().ctx);
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { WORLD, VEHICLE } from '../src/config.js';
import { RaycastVehicle } from '../src/vehicle.js';
import { Powertrain } from '../src/powertrain.js';
import { buildCarParams } from '../src/cars.js';
import { styleRoster } from '../src/models.js';

await RAPIER.init();
const h = WORLD.fixedStep;
const roster = styleRoster(0);
const RPM = 60 / (2 * Math.PI);

/** Runs one scenario; `each(frame)` sees every frame's state. */
async function drive(style, gearbox, { seconds, input, slope = 0, wall = null, drop = 0, tc = true }, each) {
  const c = roster.find((r) => r.id === style);
  const spec = { ...c.spec, gearbox };
  const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });
  world.timestep = h;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), slope);
  world.createCollider(RAPIER.ColliderDesc.cuboid(4000, 1, 4000).setTranslation(0, -1, 0).setRotation(q).setFriction(1));
  if (wall != null) world.createCollider(RAPIER.ColliderDesc.cuboid(10, 2, 0.5).setTranslation(0, 1, wall));
  world.step();
  const V = buildCarParams(spec, c.model.metrics, VEHICLE, Math.abs(WORLD.gravity));
  const v = new RaycastVehicle({ RAPIER, world, scene: new THREE.Scene(), params: V, model: c.model });
  v.respawn(new THREE.Vector3(0, drop + 0.03, 0), new THREE.Vector3(0, 0, -1));
  const pt = new Powertrain();
  pt.tractionControl = tc;
  await pt.start({ spec, V }, createMockContext().ctx);
  pt.reset(1);
  const dt = 1 / 60;
  for (let i = 0; i < seconds * 60; i++) {
    const t = i * dt;
    const inp = { steer: 0, throttle: 0, brake: 0, handbrake: false, ...input(t) };
    const reverse = v.reverse;
    const pedals = reverse ? { throttle: inp.brake, brake: inp.throttle } : { throttle: inp.throttle, brake: inp.brake };
    const grip = v.driveGrip;
    const F = pt.update(dt, { wheelSpeed: v.forwardSpeed, throttle: pedals.throttle, brake: pedals.brake, reverse, neutral: false, grip });
    v.setDriveForce(F);
    v.driveSlip = pt.wheelSlip;
    v.setSurface(0);
    for (let k = 0; k < 2; k++) { v.beginStep(); v.update(h, inp); world.step(); }
    const p = pt.sim.physics;
    const geared = p.gear > 0 ? (Math.abs(v.forwardSpeed) / V.wheelRadius) * p.fd * p.ratios[p.gear - 1] * RPM : 0;
    each({ t, v, pt, p, F, grip, geared, reverse, speed: v.forwardSpeed });
  }
  pt.dispose?.();
}

let bad = 0;
const check = (name, ok, detail) => { if (!ok) bad++; console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${name.padEnd(48)} ${detail}`); };
const full = () => ({ throttle: 1 });

// 1. Clutch home, tyres gripping: rpm = road speed through the gear (95th
// percentile — the frame after a shift still rings). Automatics: the converter
// may only ever slip the engine ABOVE the gearing, and by a bounded amount.
const p95 = (a) => (a.sort((x, y) => x - y), a[Math.floor(a.length * 0.95)] ?? Infinity);
for (const [style, box] of [['sedan', 'manual'], ['coupe', 'dct'], ['suv', 'auto']]) {
  const err = [];
  let over = 0, below = 0;
  await drive(style, box, { seconds: 10, input: full }, (f) => {
    const settled = !f.p.shifting && Math.abs(f.pt.wheelSlip) < 0.05 && f.speed > 8;
    if (settled && (f.p.isAuto || f.p.clutch > 0.99)) err.push((f.pt.rpm - f.geared) / f.geared);
    if (Number.isFinite(f.grip) && f.t > 0.1 && Math.abs(f.F) > f.grip * 1.01 + 1) over++;
  });
  if (box === 'auto') {
    // A few frames dip under while the lock-up clutch engages after an upshift.
    below = err.filter((e) => e < -0.03).length;
    check(`${style} ${box}: converter slip above the gearing`, err.length > 60 && below <= err.length * 0.02 && p95(err.slice()) < 0.3,
      `p95 ${(p95(err.slice()) * 100).toFixed(1)} %, ${below} frames below over ${err.length}`);
  } else {
    const e = p95(err.map(Math.abs));
    check(`${style} ${box}: rpm follows the road when locked`, err.length > 60 && e < 0.02, `p95 ${(e * 100).toFixed(1)} % over ${err.length} frames`);
  }
  check(`${style} ${box}: force within the tyres' grip`, over === 0, `${over} frames over`);
}

// 2. Reverse: a loaded first gear, speed-limited.
{
  let maxRev = 0, worst = 0, n = 0, pushed = 0, redline = 0;
  await drive('hatch', 'manual', { seconds: 9, input: (t) => (t < 0.2 ? {} : { brake: 1 }) }, (f) => {
    redline = f.pt.sim.profile.redlineRpm;
    if (!f.reverse) return;
    maxRev = Math.max(maxRev, -f.speed);
    if (f.F < -100) pushed++;
    // Past the launch (the clutch slips up to ~22 km/h, as it does going forward).
    if (-f.speed > 7) { worst = Math.max(worst, Math.abs(f.pt.rpm - f.geared) / f.geared); n++; }
  });
  check('reverse: the engine pushes the car', pushed > 120, `${pushed} frames of drive force`);
  check('reverse: rpm follows road speed once moving', n > 60 && worst < 0.05, `worst ${(worst * 100).toFixed(1)} % over ${n} frames`);
  check('reverse: speed-limited, never on the limiter', maxRev * 3.6 < 48, `${(maxRev * 3.6).toFixed(0)} km/h (redline ${redline})`);
}

// 3. Wheelspin reaches the engine; traction control holds it.
for (const tc of [false, true]) {
  let spin = 0, peakSpin = 0, frames = 0;
  await drive('hatch', 'manual', { seconds: 5, input: full, slope: 0.29, tc }, (f) => {
    if (f.t < 0.5) return;
    spin += Math.abs(f.pt.wheelSlip); frames++;
    peakSpin = Math.max(peakSpin, Math.abs(f.pt.wheelSlip));
  });
  const mean = spin / frames;
  if (!tc) check('30 % slope, TC off: the front tyres spin up', peakSpin > 6, `peak ${peakSpin.toFixed(1)} m/s`);
  else check('30 % slope, TC on: slip held near the grip peak', mean < 3.5, `mean ${mean.toFixed(1)} m/s, peak ${peakSpin.toFixed(1)}`);
}

// 4. Off the ground the engine turns the wheels, not the road.
{
  let airRpm = 0, landed = false, after = 0;
  await drive('supercar', 'manual', { seconds: 2, input: full, drop: 4, tc: false }, (f) => {
    if (f.grip === 0) airRpm = Math.max(airRpm, f.pt.rpm);
    else if (f.t > 0.3) landed = true;
    if (landed) after = f.speed;
  });
  check('airborne: wheels spin up with the throttle', airRpm > 4000, `${Math.round(airRpm)} rpm in the air`);
  check('landing: spinning wheels drive the car away', after > 3, `${(after * 3.6).toFixed(0)} km/h 1 s later`);
}

// 5. Against a wall: no motion, the box loaded, rpm at stall — not at the limiter.
{
  let stuckRpm = 0, redline = 0;
  await drive('suv', 'auto', { seconds: 6, input: full, wall: -15 }, (f) => {
    redline = f.pt.sim.profile.redlineRpm;
    if (f.t > 4) stuckRpm = Math.max(stuckRpm, f.pt.rpm);
  });
  check('pinned against a wall: converter stall, not redline', stuckRpm < redline * 0.6, `${Math.round(stuckRpm)} rpm (redline ${redline})`);
}

console.log(`\n  [${bad ? 'FAIL' : ' ok '}] engine and car agree`);
process.exit(bad ? 1 : 0);
