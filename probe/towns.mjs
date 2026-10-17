/**
 * towns.mjs — cities (towns.js) over tens of kilometres of road.
 *
 * How many; that every settlement is a city standing well off the road (the
 * roadside hamlets and villages were removed); that the land under a city is
 * levelled to its level; that cities keep clear of every road, including road
 * generated after them; that nothing grows in one; that the plan is a
 * function of the seed alone; and what City-gen's buildings cost. LIST=1
 * prints each city's station (for render.mjs's teleport).
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import { WORLD, TOWNS } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';
import { buildTown } from '../src/env/towns.worker.js';

const seed = process.argv[2] || WORLD.seed;
const KM = Number(process.env.KM || 45);

function world() {
  const terrain = createTerrain(seed);
  const path = new RoadPath(terrain, seed);
  const chunks = new ChunkManager({ scene: new THREE.Scene(), world: null, RAPIER: null, path, terrain });
  const t0 = performance.now();
  path.ensureLength(KM * 1000 + 2500);
  const tRoad = performance.now();
  chunks.field.sync();
  chunks.towns.plan();
  chunks.towns._recheck();
  return { path, chunks, towns: chunks.towns, field: chunks.field, ms: performance.now() - tRoad, road: tRoad - t0 };
}

let bad = 0;
const check = (label, pass, detail = '') => {
  if (!pass) bad++;
  console.log(`  [${pass ? ' ok ' : 'FAIL'}] ${label.padEnd(36)} ${detail}`);
};
console.log(`\nseed "${seed}" — cities over ${KM} km\n`);

const A = world();
const { towns, field, path } = A;
const n = towns.list.length;
console.log(`  ${n} cities`);
if (process.env.LIST) {
  for (const t of towns.list) {
    console.log(`    city    s≈${path.projectPoint(new THREE.Vector3(t.cx, 0, t.cz), t.slot * TOWNS.slot, 1e9, 1e9).toFixed(0)}  ${t.size.toFixed(0)} m, ${field.roadDistance(t.cx, t.cz).toFixed(0)} m out`);
  }
}
const per10 = (n / KM) * 10;
check('cities per 10 km', per10 >= 0.8 && per10 <= 4, per10.toFixed(1));
check('nothing but cities', towns.list.every((t) => t.kind === 'city'), '');
// The road it was planned from may bend back toward it, so 60 % of the nearest planned distance.
const close = towns.list.filter((t) => field.roadDistance(t.cx, t.cz) < TOWNS.cityDist[0] * 0.6);
check('every city well off the road', close.length === 0, close.length ? `${close.length} within ${(TOWNS.cityDist[0] * 0.6).toFixed(0)} m` : `nearest ${Math.min(...towns.list.map((t) => field.roadDistance(t.cx, t.cz))).toFixed(0)} m`);
check('planning cost', A.ms / Math.max(1, n) < 40, `${(A.ms / Math.max(1, n)).toFixed(1)} ms/city`);

// City land to its level; cities clear of all road; nothing grows in one.
let off = 0, samples = 0, worst = 0, grows = 0;
for (const t of towns.list) {
  for (const [a, b] of [[0, 0], [0.6, 0.6], [-0.6, 0.3], [0.2, -0.7]]) {
    const [x, z] = towns._cityPoint(t, a * t.hs, b * t.hs);
    const d = Math.abs(field.height(x, z) - (t.level - 0.6));
    worst = Math.max(worst, d); if (d > 0.05) off++; samples++;
    if (towns.clear(x, z) < 0.999) grows++;
  }
}
check('city ground levelled', off === 0, `${off} of ${samples} off, worst ${worst.toFixed(2)} m`);
check('nothing grows in a city', grows === 0, `${grows}`);
let near = 0;
for (const t of towns.list) if (!towns._cityClear(t)) near++;
check('cities clear of every road', near === 0, `${near}`);

// Same seed, same plan.
const B = world();
const sig = (w) => w.towns.list.map((t) => `${t.slot}:${t.cx.toFixed(2)}:${t.cz.toFixed(2)}`).join('|');
check('deterministic', sig(A) === sig(B));

const tris = (levels) => levels.map((L) => ((L.solid ? L.solid.idx.length : 0) + (L.glass ? L.glass.idx.length : 0)) / 3);
const city = towns.list[0];
if (city) {
  const t0 = performance.now();
  const lv = buildTown({ kind: 'city', size: city.size, seed: city.seed, density: city.density });
  const ms = performance.now() - t0;
  check('city builds', tris(lv)[0] < 400000, `${city.size.toFixed(0)} m: ${(tris(lv)[0] / 1000).toFixed(0)}k tris, ${ms.toFixed(0)} ms`);
}

console.log(bad ? `\n${bad} FAILED\n` : '\nall ok\n');
process.exit(bad ? 1 : 0);
