/**
 * gears.mjs — does every car pull through every gear, with every engine?
 *
 *   node probe/gears.mjs [carId|all] [engineId|all]
 *
 * A straight-line drag race on a flat road: full throttle from rest, the
 * automatic box, the game's lumped aero drag (`V.dragCoefficient`·v²) and a
 * rolling resistance under the game's gravity. Reports the highest gear
 * reached, top speed, and the time to it. A car that never reaches its last
 * gear is STUCK: the gearing does not suit the engine (the reported "never
 * gets past 4th"). engine_sim designs each box for the engine fitted.
 */
import { createMockContext, installGlobals } from '../engine_sim/test/mock-audio.mjs';
installGlobals(createMockContext().ctx);
import { Powertrain } from '../src/powertrain.js';
import { CARS, ENGINE_OPTIONS, buildCarParams } from '../src/cars.js';
import { VEHICLE, WORLD } from '../src/config.js';

const g = Math.abs(WORLD.gravity);
const wantCar = process.argv[2] || 'all', wantEng = process.argv[3] || 'all';
const metrics = { trackHalf: 0.79, wheelbaseHalf: 1.28, wheelRadius: 0.34, wheelWidth: 0.24,
  bodyHeight: 1.25, bodyHalfWidth: 0.9, bodyHalfLength: 2.2 };
const engines = ENGINE_OPTIONS.map((e) => e.id);
let stuck = 0, runs = 0;
const rows = [];
for (const spec of CARS) {
  if (wantCar !== 'all' && spec.id !== wantCar) continue;
  const V = buildCarParams(spec, metrics, VEHICLE, g);
  for (const eng of engines) {
    if (wantEng !== 'all' && eng !== wantEng) continue;
    const pt = new Powertrain();
    pt.engineChoice = eng;
    await pt.start({ spec, V }, createMockContext().ctx);
    pt.setAutoShift?.(true);
    const nG = pt.sim.physics.gearCount;
    let v = 0, maxG = 1, vMax = 0, tTop = 0, t100 = NaN;
    const dt = 1 / 60, sub = 2;
    for (let i = 0; i < 60 * 70; i++) {
      const F = pt.update(dt, { wheelSpeed: v, throttle: 1, brake: 0, reverse: false, neutral: false });
      for (let k = 0; k < sub; k++) {
        const h = dt / sub;
        const drag = V.dragCoefficient * v * Math.abs(v) + 0.015 * V.mass * g;
        v = Math.max(0, v + ((F - drag) / V.mass) * h);
      }
      if (pt.gear > maxG) maxG = pt.gear;
      if (v > vMax + 0.05) { vMax = v; tTop = i * dt; }
      if (!(t100 >= 0) && v >= 100 / 3.6) t100 = i * dt;
    }
    const up = pt.sim.physics.shift.upshiftRpm(1);
    const short = nG - maxG;
    const isStuck = short >= 1;
    runs++; if (isStuck) stuck++;
    rows.push(`${spec.id.padEnd(9)} ${(eng === 'stock' ? spec.engine + '*' : eng).padEnd(10)} gears ${maxG}/${nG}  0-100 ${isFinite(t100) ? t100.toFixed(1).padStart(4) : '  - '} s  top ${(vMax * 3.6).toFixed(0).padStart(4)} km/h at ${tTop.toFixed(0).padStart(3)} s  rpm ${Math.round(pt.rpm).toString().padStart(5)} (upshift ${Math.round(up)}, redline ${pt.sim.profile.redlineRpm})${isStuck ? '   << STUCK' : ''}`);
    pt.sim.dispose?.();
  }
}
console.log(rows.join('\n'));
console.log(`\n  ${stuck} of ${runs} car/engine pairs never reach their last gear`);
console.log(`  [${stuck ? 'FAIL' : ' ok '}] every pairing pulls through its gearbox`);
process.exit(stuck ? 1 : 0);
