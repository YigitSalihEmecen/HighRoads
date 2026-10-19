/**
 * pops.mjs — does the ground change where the player can see it?
 *
 *   node probe/pops.mjs [seed] [seconds] [speed m/s]
 *
 * Drives the focus along the road exactly as stream.mjs does and reports
 * (1) tiles the road's growth invalidated while they were in view — each is a
 * hillside reshaping itself on screen — and (2) how far the DRAWN ground
 * stands above the road ribbon ahead, by distance: a coarse tile bridging a
 * cutting is the road driving into the mountain. (3) is the level-of-detail
 * swap: how far a new tile's vertices jump from the ground drawn there the
 * frame before, as an angle seen from the car.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { WORLD, TOWNS, ROAD } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';
import { WorldTiles } from '../src/worldtiles.js';

if (!process.env.TOWNS) TOWNS.enabled = false;
const seed = process.argv[2] || WORLD.seed;
const secs = Number(process.argv[3] || 60);
const speed = Number(process.argv[4] || 40);

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });
const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const chunks = new ChunkManager({ scene: new THREE.Scene(), world, RAPIER, path, terrain });
const tiles = chunks.tiles;
const S0 = 400;
chunks.preload(S0);
const focus = new THREE.Vector3().copy(path.frameAt(S0).pos);
chunks.focus = focus;
for (let i = 0; i < 300; i++) chunks.update(S0);

const VIEW = 1200;
let inView = 0, total = 0;
const inval = tiles._invalidate.bind(tiles);
tiles._invalidate = (x0, z0, x1, z1) => {
  const before = new Set(tiles.tiles.keys());
  inval(x0, z0, x1, z1);
  for (const k of before) if (!tiles.tiles.has(k)) {
    total++;
    const old = tiles._retired.find((r) => tiles._key(r.l, r.i, r.j) === k);
    if (old && old.dist(focus.x, focus.z) < VIEW) inView++;
  }
};

/** Highest DRAWN ground at (x, z): a tile being replaced is still on screen beside its successor. */
function drawnTop(x, z) {
  let top = -Infinity;
  const all = [...tiles.tiles.values(), ...(tiles._retired || [])];
  for (const t of all) {
    const sz = WorldTiles.size(t.l);
    if (x < t.i * sz || x >= (t.i + 1) * sz || z < t.j * sz || z >= (t.j + 1) * sz) continue;
    const step = sz / 32, V = 33;
    const fx = (x - t.i * sz) / step, fz = (z - t.j * sz) / step;
    const vi = Math.min(31, Math.floor(fx)), vj = Math.min(31, Math.floor(fz));
    const u = fx - vi, w = fz - vj, p = t.cpos;
    const ya = p[(vj * V + vi) * 3 + 1], yb = p[(vj * V + vi + 1) * 3 + 1];
    const yc = p[((vj + 1) * V + vi) * 3 + 1], yd = p[((vj + 1) * V + vi + 1) * 3 + 1];
    const y = u + w <= 1 ? ya + (yb - ya) * u + (yc - ya) * w : yd + (yc - yd) * (1 - u) + (yb - yd) * (1 - w);
    if (y > top) top = y;
  }
  return top;
}

const bands = [100, 200, 400, 800, 1600];
const over = bands.map(() => ({ n: 0, bad: 0, max: 0 }));
/** Height of tile `t`'s drawn grid at (x, z), or NaN outside it. */
function tileY(t, x, z) {
  const sz = WorldTiles.size(t.l);
  if (x < t.i * sz || x > (t.i + 1) * sz || z < t.j * sz || z > (t.j + 1) * sz) return NaN;
  const step = sz / 32, V = 33;
  const fx = (x - t.i * sz) / step, fz = (z - t.j * sz) / step;
  const vi = Math.min(31, Math.floor(fx)), vj = Math.min(31, Math.floor(fz));
  const u = fx - vi, w = fz - vj, p = t.cpos;
  const ya = p[(vj * V + vi) * 3 + 1], yb = p[(vj * V + vi + 1) * 3 + 1];
  const yc = p[((vj + 1) * V + vi) * 3 + 1], yd = p[((vj + 1) * V + vi + 1) * 3 + 1];
  return u + w <= 1 ? ya + (yb - ya) * u + (yc - ya) * w : yd + (yc - yd) * (1 - u) + (yb - yd) * (1 - w);
}
const jumps = [];
function measureSwap(before) {
  for (const [k, t] of tiles.tiles) {
    if (before.has(k)) continue;
    const old = [...before.values()].filter((o) => o.l !== t.l);
    if (!old.length) continue;
    let worst = 0;
    for (const o of old) {
      // The finer grid's vertices against the coarser grid's triangles.
      const [fine, coarse] = o.l < t.l ? [o, t] : [t, o];
      const sz = WorldTiles.size(fine.l), step = sz / 32;
      for (let vj = 0; vj <= 32; vj++) for (let vi = 0; vi <= 32; vi++) {
        const x = fine.i * sz + vi * step, z = fine.j * sz + vj * step;
        const yo = tileY(coarse, x, z);
        if (Number.isNaN(yo)) continue;
        const d = Math.max(30, Math.hypot(x - focus.x, z - focus.z));
        worst = Math.max(worst, Math.abs(fine.cpos[(vj * 33 + vi) * 3 + 1] - yo) / d * 1000);
      }
    }
    jumps.push(worst);
  }
}

const f = { pos: new THREE.Vector3(), tan: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };
const dt = 1 / 60;
let s = S0;
for (let n = 0; n < secs * 60; n++) {
  s += speed * dt;
  focus.copy(path.frameAt(s).pos);
  chunks.advanceTime(dt);
  const before = new Map(tiles.tiles);
  chunks.update(s);
  measureSwap(before);
  if (n % 30) continue;
  for (let ds = 20; ds < 1600; ds += 7.3) {
    path.frameAt(s + ds, f);
    const d = Math.hypot(f.pos.x - focus.x, f.pos.z - focus.z);
    const b = bands.findIndex((x) => d < x);
    if (b < 0) continue;
    const rx = -f.tan.z, rz = f.tan.x, rl = Math.hypot(rx, rz);
    for (const v of [-ROAD.halfWidth * 0.8, 0, ROAD.halfWidth * 0.8]) {
      const x = f.pos.x + rx / rl * v, z = f.pos.z + rz / rl * v;
      const y = drawnTop(x, z);
      if (y === -Infinity) continue;
      const e = y - (f.pos.y + v * Math.tan(f.bank));
      const o = over[b];
      o.n++;
      if (e > 0.3) o.bad++;
      if (e > o.max) o.max = e;
    }
  }
}
console.log(`seed ${seed}, ${secs} s at ${speed} m/s`);
console.log(`road growth invalidated ${total} tiles, ${inView} within ${VIEW} m of the car`);
console.log('drawn ground above the road ribbon (> 0.3 m), by distance:');
bands.forEach((b, i) => {
  const o = over[i];
  console.log(`  < ${String(b).padStart(4)} m: ${(100 * o.bad / Math.max(1, o.n)).toFixed(1).padStart(5)} % of ${o.n}, max ${o.max.toFixed(1)} m`);
});
jumps.sort((a, b) => a - b);
const jq = (q) => (jumps[Math.min(jumps.length - 1, Math.floor(jumps.length * q))] || 0).toFixed(1);
console.log(`level-of-detail swaps: ${jumps.length}, worst vertex jump p50 ${jq(0.5)} / p95 ${jq(0.95)} / max ${jq(1)} mrad`);
// Only where the ribbon is drawn (7 chunks, ~800 m) can ground stand over it.
const bad = over.slice(0, 4).reduce((a, o) => a + o.bad, 0);
// 14 is the measured baseline on highroads-01: the road turning back toward the car.
process.exitCode = bad || inView > 30 ? 1 : 0;
