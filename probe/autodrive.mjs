/**
 * autodrive.mjs — the virtual driver, both modes, under the main.js loop.
 *
 * It drives through a real `Input`; the shift keys it presses are handled the
 * way `Game._handleActions` handles them.
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
import { WORLD, ROAD, VEHICLE } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';
import { RaycastVehicle } from '../src/vehicle.js';
import { Traffic } from '../src/traffic.js';
import { Powertrain } from '../src/powertrain.js';
import { buildCarParams } from '../src/cars.js';
import { styleRoster, Fleet } from '../src/models.js';
import { Input } from '../src/input.js';
import { AutoDrive } from '../src/autodrive.js';

const seed = process.argv[2] || WORLD.seed;
const SECONDS = Number(process.argv[3] || 90);
const START = 90;
const dt = 1 / 60;
const ok = (b) => (b ? ' ok ' : 'FAIL');

const player = styleRoster(0).find((c) => c.id === 'supercar');
const fleet = new Fleet(seed, 14);
while (fleet.count < fleet.size) fleet.buildOne();
await RAPIER.init();

async function run(mode) {
  const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });
  world.timestep = WORLD.fixedStep;
  const terrain = createTerrain(seed);
  const path = new RoadPath(terrain, seed);
  const scene = new THREE.Scene();
  const chunks = new ChunkManager({ scene, world, RAPIER, path, terrain, foliage: new Map() });
  chunks.preload(START);
  world.step();

  const { spec, model } = player;
  const vehicle = new RaycastVehicle({
    RAPIER, world, scene, params: buildCarParams(spec, model.metrics, VEHICLE, Math.abs(WORLD.gravity)), model,
  });
  const traffic = new Traffic({ scene, path, chunks, fleet });
  const powertrain = new Powertrain();
  await powertrain.start({ spec, V: vehicle.V }, createMockContext().ctx);
  const input = new Input({ addEventListener() {} });

  const game = { input, vehicle, path, powertrain, traffic, carS: START };
  const g0 = chunks.groundAt(START, ROAD.laneWidth * 0.5, new THREE.Vector3());
  g0.y += 0.03;
  vehicle.respawn(g0, path.frameAt(START).tan);
  powertrain.reset(1);

  const ad = new AutoDrive();
  ad.setMode(mode);
  ad.engage();

  let acc = 0, ups = 0, downs = 0, refused = 0, respawns = 0, offRoad = 0, maxSpeed = 0;
  let maxWide = 0, manual = 0, pedalTravel = 0, prevTh = 0, prevBr = 0, impacts = 0, maxGear = 0, revSum = 0;
  const steps = Math.round(SECONDS * 60);
  for (let i = 0; i < steps; i++) {
    input.update(dt);
    ad.drive(dt, game);
    // Game._handleActions, gearbox part.
    if (input.consume('KeyE')) {
      if (powertrain.autoShift) powertrain.setAutoShift(false);
      else if (powertrain.shiftUp()) ups++; else refused++;
    }
    if (input.consume('KeyQ')) {
      if (powertrain.autoShift) powertrain.setAutoShift(false);
      else if (powertrain.shiftDown()) downs++; else refused++;
    }
    if (input.consume('KeyG')) powertrain.setAutoShift(!powertrain.autoShift);

    const lat = path.lateralOffset(vehicle.pos, game.carS);
    vehicle.setSurface(0);
    vehicle.setDriveForce(powertrain.update(dt, {
      wheelSpeed: vehicle.forwardSpeed, throttle: input.throttle, brake: input.brake, reverse: vehicle.reverse,
      grip: vehicle.driveGrip,
    }));
    vehicle.driveSlip = powertrain.wheelSlip + powertrain.launchSlip;
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
    game.carS = path.projectPoint(vehicle.pos, game.carS);
    chunks.update(game.carS);
    traffic.update(dt, { s: game.carS, v: lat, speed: Math.abs(vehicle.forwardSpeed), flashing: false, vehicle });
    if (traffic.lastImpact >= 1) impacts++;
    input.endFrame();

    if (i > 30 && (lat < -0.3 || lat > ROAD.halfWidth + 0.3)) offRoad++;
    if (i > 30) maxWide = Math.max(maxWide, Math.abs(lat - ad.laneV));
    if (!powertrain.autoShift) manual++;
    maxSpeed = Math.max(maxSpeed, vehicle.forwardSpeed);
    maxGear = Math.max(maxGear, powertrain.gear);
    revSum += powertrain.rpm / powertrain.maxRpm;
    pedalTravel += Math.abs(input.throttle - prevTh) + Math.abs(input.brake - prevBr);
    prevTh = input.throttle;
    prevBr = input.brake;

    if (vehicle.upsideDownFor > 2.5 || Math.abs(lat) > 60) {
      const s = Math.max(START, game.carS - 12);
      chunks.update(s, 6);
      const g = chunks.groundAt(s, ROAD.laneWidth * 0.5, new THREE.Vector3());
      g.y += 0.03;
      vehicle.respawn(g, path.frameAt(s).tan);
      game.carS = s;
      respawns++;
    }
  }
  ad.disengage();
  input.consume('KeyG') && powertrain.setAutoShift(!powertrain.autoShift);
  const dist = game.carS - START;
  return {
    mode, dist, avg: dist / SECONDS, maxWide, maxSpeed, ups, downs, refused, respawns, impacts, maxGear,
    offRoad: offRoad / steps, manual: manual / steps, pedal: pedalTravel / SECONDS, revs: revSum / steps,
    restored: powertrain.autoShift,
  };
}

const calm = await run('calm');
const aggr = await run('aggressive');

for (const r of [calm, aggr]) {
  console.log(`\n${r.mode}: ${r.dist.toFixed(0)} m in ${SECONDS}s, avg ${(r.avg * 3.6).toFixed(0)} km/h, top ${(r.maxSpeed * 3.6).toFixed(0)} km/h`);
  console.log(`  [${ok(r.respawns === 0)}] recoveries                    ${r.respawns}`);
  console.log(`  [${ok(r.offRoad < 0.01)}] off its side of the road      ${(r.offRoad * 100).toFixed(2)} % of frames`);
  console.log(`  [${ok(r.maxWide < 3)}] worst lane error              ${r.maxWide.toFixed(2)} m`);
  console.log(`  [${ok(r.manual > 0.99)}] gearbox in manual             ${(r.manual * 100).toFixed(1)} % of frames`);
  console.log(`  [${ok(r.ups > 0 && r.refused === 0)}] own shifts                    ${r.ups} up, ${r.downs} down, ${r.refused} refused, top gear seen ${r.maxGear}`);
  console.log(`  [${ok(r.restored)}] automatic restored on release`);
  console.log(`  [${ok(r.impacts === 0)}] traffic impacts               ${r.impacts}`);
  console.log(`  [ -- ] mean revs ${(r.revs * 100).toFixed(0)} % of redline, pedal travel ${r.pedal.toFixed(2)}/s`);
}
console.log('');
console.log(`  [${ok(aggr.avg > calm.avg * 1.15)}] aggressive is faster          ${(aggr.avg / calm.avg).toFixed(2)}x`);
console.log(`  [${ok(calm.pedal < aggr.pedal)}] calm is smoother on the pedals ${calm.pedal.toFixed(2)} vs ${aggr.pedal.toFixed(2)} /s`);
console.log(`  [${ok(calm.revs < aggr.revs)}] calm short-shifts             ${(calm.revs * 100).toFixed(0)} % vs ${(aggr.revs * 100).toFixed(0)} % of redline`);
