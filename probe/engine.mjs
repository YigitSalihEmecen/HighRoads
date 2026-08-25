/**
 * The engine_sim bridge contract.
 *
 * engine_sim is a separate repository pulled in as a submodule, so it moves on
 * its own schedule and this game has to keep up with it. `powertrain.js` reaches
 * into a specific set of methods and fields; when one of them goes away the
 * failure is usually SILENT — `sim.comp` sat behind an `if` and simply stopped
 * doing anything the day upstream replaced it with a three-band compressor.
 *
 * So the contract is asserted explicitly here, and then every engine in the
 * roster is actually run to make sure it produces torque and revs.
 *
 * Run this after every `git submodule update --remote engine_sim`.
 */
import { createMockContext, installGlobals } from '../engine_sim/test/mock-audio.mjs';
installGlobals(createMockContext().ctx);

import { EngineSim, ENGINE_PROFILES } from '../engine_sim/src/engine-sim.js';
import { Powertrain } from '../src/powertrain.js';
import { ENGINE_OPTIONS, CARS, buildCarParams } from '../src/cars.js';
import { VEHICLE, WORLD } from '../src/config.js';

const ok = (b) => (b ? ' ok ' : 'FAIL');
let bad = 0;
const check = (label, pass, detail = '') => {
  if (!pass) bad++;
  console.log(`  [${ok(pass)}] ${label.padEnd(46)} ${detail}`);
};

// ---- 1. the API the bridge depends on -------------------------------------
const sim = new EngineSim(createMockContext().ctx, { engine: 'i4', vehicle: 'sports', volume: 0.5 });
const SIM_METHODS = ['start', 'stop', 'dispose', 'update', 'setThrottle', 'setBrake',
  'setEngineType', 'setAutoShift', 'shiftUp', 'shiftDown', 'setVolume', 'setMix',
  'setTone', 'setEQ', 'setDynamics'];
const SIM_FIELDS = ['physics', 'profile', 'transmission', 'ctx'];
const DT_METHODS = ['setVehicle', 'selectGear', '_stepVehicle'];
const DT_FIELDS = ['Tp', 'fd', 'eff', 'r', 'ww', 'gear', 'rpm', 'shifting', 'limiterCut'];

const missingM = SIM_METHODS.filter((m) => typeof sim[m] !== 'function');
const missingF = SIM_FIELDS.filter((f) => sim[f] === undefined);
const missingDM = DT_METHODS.filter((m) => typeof sim.physics[m] !== 'function');
const missingDF = DT_FIELDS.filter((f) => sim.physics[f] === undefined);
check('EngineSim methods the bridge calls', !missingM.length, missingM.join(',') || `${SIM_METHODS.length} present`);
check('EngineSim fields the bridge reads', !missingF.length, missingF.join(',') || `${SIM_FIELDS.length} present`);
check('Drivetrain methods the bridge calls', !missingDM.length, missingDM.join(',') || `${DT_METHODS.length} present`);
check('Drivetrain fields the bridge reads', !missingDF.length, missingDF.join(',') || `${DT_FIELDS.length} present`);

// ---- 2. the roster names engines that exist -------------------------------
const unknown = ENGINE_OPTIONS.filter((e) => e.id !== 'stock' && !ENGINE_PROFILES[e.id]).map((e) => e.id);
check('every ENGINE_OPTIONS id exists upstream', !unknown.length, unknown.join(',') || `${ENGINE_OPTIONS.length - 1} engines`);
const stock = [...new Set(CARS.map((c) => c.engine))].filter((id) => !ENGINE_PROFILES[id]);
check('every car\'s stock engine exists upstream', !stock.length, stock.join(',') || 'all 9 cars');
const unoffered = Object.keys(ENGINE_PROFILES).filter((id) => !ENGINE_OPTIONS.some((e) => e.id === id));
check('every upstream engine is offered in the garage', !unoffered.length,
  unoffered.length ? `not offered: ${unoffered.join(',')}` : `${Object.keys(ENGINE_PROFILES).length} engines`);

// ---- 3. each engine actually runs through the bridge ----------------------
const spec = CARS.find((c) => c.id === 'sport');
const metrics = { trackHalf: 0.79, wheelbaseHalf: 1.28, wheelRadius: 0.34, wheelWidth: 0.24,
  bodyHeight: 1.2, bodyHalfWidth: 0.92, bodyHalfLength: 2.1 };
const V = buildCarParams(spec, metrics, VEHICLE, Math.abs(WORLD.gravity));

const dt = 1 / 60;
const rows = [];
for (const opt of ENGINE_OPTIONS) {
  const pt = new Powertrain();
  pt.setEngine(opt.id);
  await pt.start({ spec, V }, createMockContext().ctx);

  let maxForce = 0, maxRpm = 0, gears = new Set(), nan = 0, speed = 0;
  for (let i = 0; i < 60 * 45; i++) {
    const f = pt.update(dt, { wheelSpeed: speed, throttle: 1, brake: 0, reverse: false });
    if (!Number.isFinite(f) || !Number.isFinite(pt.rpm)) nan++;
    // Crude longitudinal integration — enough to make it rev out and shift.
    speed = Math.max(0, speed + ((f - 0.45 * speed * speed) / V.mass) * dt);
    maxForce = Math.max(maxForce, f);
    maxRpm = Math.max(maxRpm, pt.rpm);
    gears.add(pt.gear);
  }
  // `presetLabel` since engine_sim gained its preset system; `profile.label` is
  // the older field and is undefined for a preset-loaded engine. Neither is
  // guaranteed, and a missing label is a cosmetic detail in a row about torque.
  const label = pt.sim.presetLabel || (pt.sim.profile && pt.sim.profile.label) || opt.id;
  // Gear count is a property of the COMBINATION, not of the bridge: a 1.2 litre
  // V-twin in a 1180 kg car really does spend a long time in first, and that is
  // the engine-swap feature behaving correctly rather than a fault. What the
  // bridge has to deliver is torque, revs, a working gearbox and no NaN.
  const good = nan === 0 && maxForce > 500 && maxRpm > 2000 && gears.size >= 2;
  if (!good) bad++;
  rows.push(`  [${ok(good)}] ${opt.id.padEnd(9)} ${label.padEnd(30)} ` +
    `peak ${(maxForce / 1000).toFixed(1).padStart(5)} kN  ${String(Math.round(maxRpm)).padStart(5)} rpm  ` +
    `${gears.size} gears  ${(speed * 3.6).toFixed(0).padStart(3)} km/h`);
  pt.dispose();
}
console.log('\n  every engine, 45 s flat out through the bridge:');
for (const r of rows) console.log(r);

console.log(`\n  ${bad ? bad + ' FAILURE(S)' : 'bridge contract holds'}`);
process.exit(bad ? 1 : 0);
