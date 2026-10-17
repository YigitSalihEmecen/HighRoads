/**
 * towns.mjs — settlements (towns.js) over tens of kilometres of road.
 *
 * How many of each kind; that no lot touches the carriageway or another road;
 * that every lot stands on its footing (the ground under it lies between the
 * lot's floor and the footing's foot); that the land beside a village is
 * levelled to the road and under a city to its level; that cities keep clear
 * of every road, including road generated after them; that nothing grows in
 * a settlement; that the plan is a function of the seed alone; and what
 * City-gen's buildings cost. LIST=1 prints each settlement's station (for
 * render.mjs's teleport).
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import { WORLD, ROAD, TOWNS } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';
import { buildTown } from '../src/env/towns.worker.js';

const seed = process.argv[2] || WORLD.seed;
const KM = Number(process.env.KM || 45);
const EDGE = ROAD.halfWidth + ROAD.shoulder;

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
console.log(`\nseed "${seed}" — settlements over ${KM} km\n`);

const A = world();
const { towns, field, path } = A;
const by = {};
for (const t of towns.list) by[t.kind] = (by[t.kind] || 0) + 1;
const lots = towns.list.reduce((n, t) => n + (t.lots ? t.lots.length : 0), 0);
console.log(`  ${towns.list.length} settlements — ${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ')}; ${lots} lots`);
if (process.env.LIST) {
  for (const t of towns.list) {
    console.log(t.kind === 'city'
      ? `    city    s≈${path.projectPoint(new THREE.Vector3(t.cx, 0, t.cz), t.slot * TOWNS.slot, 1e9, 1e9).toFixed(0)}  ${t.size.toFixed(0)} m, ${field.roadDistance(t.cx, t.cz).toFixed(0)} m out`
      : `    ${t.kind.padEnd(7)} s=${t.s0.toFixed(0)}–${t.s1.toFixed(0)}  sides ${t.sides.join(',')}  ${t.lots.length} lots${t.church ? ' + church' : ''}`);
  }
}
const per10 = (towns.list.length / KM) * 10;
check('settlements per 10 km', per10 >= 2 && per10 <= 7, per10.toFixed(1));
const through = towns.list.filter((t) => t.kind === 'village' && t.sides.length === 2).length;
check('a village the road passes through', through > 0, `${through} of ${by.village || 0} villages`);
check('a city on the horizon', (by.city || 0) > 0, `${by.city || 0}`);
check('planning cost', A.ms / Math.max(1, towns.list.length) < 40, `${(A.ms / Math.max(1, towns.list.length)).toFixed(1)} ms/settlement`);

// Lots: corners off every carriageway; the ground under each between its floor and its footing's foot.
let onRoad = 0, floating = 0, buried = 0, n = 0, worstUp = 0, worstDown = 0, grows = 0;
for (const t of towns.list) {
  if (t.kind === 'city') continue;
  for (const L of [...t.lots, ...(t.church ? [t.church] : [])]) {
    const c = Math.cos(L.angle), s = Math.sin(L.angle);
    const x = t.origin.x + L.x, z = t.origin.z + L.z, y = t.origin.y + L.y;
    if (towns.clear(x, z) < 0.999) grows++;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
      const lx = a * L.w / 2, lz = b * L.d / 2;
      const wx = x + lx * c + lz * s, wz = z - lx * s + lz * c;
      if (field.roadDistance(wx, wz) < EDGE + 1) onRoad++;
      const g = field.height(wx, wz);
      if (g > y + 0.05) { buried++; worstUp = Math.max(worstUp, g - y); }
      if (g < y - L.drop) { floating++; worstDown = Math.max(worstDown, y - L.drop - g); }
      n++;
    }
  }
}
check('no lot on a carriageway', onRoad === 0, `${onRoad} of ${n} points`);
check('no lot floor under its ground', buried === 0, buried ? `${buried} points, worst ${worstUp.toFixed(2)} m` : '');
check('no footing short of the ground', floating === 0, floating ? `${floating} points, worst ${worstDown.toFixed(2)} m` : '');
check('nothing grows on a lot', grows === 0, `${grows}`);

// Village land levelled to the road; city land to its level; cities clear of all road.
let off = 0, samples = 0, worst = 0;
for (const t of towns.list) {
  if (t.kind === 'city') {
    for (const [a, b] of [[0, 0], [0.6, 0.6], [-0.6, 0.3], [0.2, -0.7]]) {
      const [x, z] = towns._cityPoint(t, a * t.hs, b * t.hs);
      const d = Math.abs(field.height(x, z) - (t.level - 0.6));
      worst = Math.max(worst, d); if (d > 0.05) off++; samples++;
    }
    continue;
  }
  const f = path.frameAt((t.s0 + t.s1) / 2);
  for (const side of t.sides) {
    const v = side * (t.W[side > 0 ? 1 : 0] - TOWNS.flat) * 0.6;
    const x = f.pos.x - f.tan.z * v, z = f.pos.z + f.tan.x * v;
    const d = Math.abs(field.height(x, z) - (f.pos.y - 0.25));
    worst = Math.max(worst, d); if (d > 0.6) off++; samples++;
  }
}
check('settlement ground levelled', off === 0, `${off} of ${samples} off, worst ${worst.toFixed(2)} m`);
let near = 0;
for (const t of towns.list) if (t.kind === 'city' && !towns._cityClear(t)) near++;
check('cities clear of every road', near === 0, `${near}`);

// Same seed, same plan.
const B = world();
const sig = (w) => w.towns.list.map((t) => `${t.kind}:${t.slot}:${(t.lots || []).map((L) => `${L.style}${L.x.toFixed(2)}`).join()}:${(t.cx || 0).toFixed(2)}`).join('|');
check('deterministic', sig(A) === sig(B));

// City-gen's geometry for the largest village and the first city.
const tris = (levels) => levels.map((L) => ((L.solid ? L.solid.idx.length : 0) + (L.glass ? L.glass.idx.length : 0)) / 3);
const village = towns.list.filter((t) => t.kind !== 'city').sort((a, b) => b.lots.length - a.lots.length)[0];
if (village) {
  const t0 = performance.now();
  const lv = buildTown({ kind: village.kind, lots: village.lots, church: village.church, lamps: village.lamps, details: TOWNS.detail });
  const ms = performance.now() - t0;
  const finite = lv.every((L) => L.solid.pos.every(Number.isFinite));
  check('village builds', finite, `${village.lots.length} lots: ${tris(lv).map((x) => `${(x / 1000).toFixed(0)}k`).join(' / ')} tris, ${ms.toFixed(0)} ms`);
}
const city = towns.list.find((t) => t.kind === 'city');
if (city) {
  const t0 = performance.now();
  const lv = buildTown({ kind: 'city', size: city.size, seed: city.seed, density: city.density });
  const ms = performance.now() - t0;
  check('city builds', tris(lv)[0] < 400000, `${city.size.toFixed(0)} m: ${(tris(lv)[0] / 1000).toFixed(0)}k tris, ${ms.toFixed(0)} ms`);
}

console.log(bad ? `\n${bad} FAILED\n` : '\nall ok\n');
process.exit(bad ? 1 : 0);
