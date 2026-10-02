/**
 * ground.mjs — is the ground one cohesive surface?
 *
 * Replaces offroad.mjs, terrain.mjs and cliff.mjs, which measured the
 * road-space sheets (folds, corridor width, faceting by lateral band, seam
 * steps). The ground is now world-space LOD tiles over a pure height function
 * (terrainfield.js / worldtiles.js), so the questions become:
 *
 *   coverage     every point within the tile radius has a drawn surface
 *   seams        where tiles of different levels meet, the height gap is
 *                smaller than the skirt that hides it
 *   carriageway  the drawn terrain never pokes up through the road ribbon,
 *                and never drops far enough below it to show a gap
 *   colliders    a ray straight down hits ground everywhere the player may
 *                drive (the recovery bound), at every stop along the route
 *   faceting     angle between adjacent face normals, by distance from the
 *                focus — the old terrain.mjs table, on the new mesh
 *
 *   node probe/ground.mjs [seed] [s_max]
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { WORLD, ROAD, CHUNK, TILES } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';
import { WorldTiles } from '../src/worldtiles.js';

const seed = process.argv[2] || WORLD.seed;
const S_MAX = Number(process.argv[3] || 3000);

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });
const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const chunks = new ChunkManager({ scene: new THREE.Scene(), world, RAPIER, path, terrain });
path.ensureLength(S_MAX + 3000);
const tiles = chunks.tiles;

let bad = 0;
const check = (label, pass, detail = '') => {
  if (!pass) bad++;
  console.log(`  [${pass ? ' ok ' : 'FAIL'}] ${label.padEnd(44)} ${detail}`);
};
console.log(`\nseed "${seed}" — world-space ground, s = 200..${S_MAX}\n`);

const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
const UP = new THREE.Vector3(0, 1, 0);
const right = new THREE.Vector3();
let holes = 0, probes = 0, colMiss = 0, colProbes = 0;
let poke = 0, gap = 0, roadN = 0, worstPoke = 0, worstGap = 0;
let seamWorst = 0, seamOver = 0, seamN = 0;
const facet = new Map();   // band -> angles
const t0 = performance.now();
let builds = 0;

for (let s = 200; s <= S_MAX; s += 400) {
  const f = path.frameAt(s);
  const fx = f.pos.x, fz = f.pos.z;
  const before = tiles.built;
  tiles.preload(fx, fz);
  builds += tiles.built - before;
  world.step();

  // coverage: random points over the whole tile radius
  for (let n = 0; n < 3000; n++) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * (TILES.radius - 80);
    const y = tiles.surfaceAt(fx + Math.cos(a) * r, fz + Math.sin(a) * r);
    probes++;
    if (!Number.isFinite(y)) holes++;
  }

  // colliders: a grid out to the recovery bound around the focus
  for (let dx = -150; dx <= 150; dx += 7.3) {
    for (let dz = -150; dz <= 150; dz += 7.3) {
      if (dx * dx + dz * dz > 150 * 150) continue;
      ray.origin = { x: fx + dx + 0.137, y: 2000, z: fz + dz + 0.211 };
      colProbes++;
      if (!world.castRay(ray, 5000, true)) colMiss++;
    }
  }

  // carriageway: drawn terrain vs the ribbon, along 300 m around the focus
  for (let ss = s - 150; ss <= s + 150; ss += 0.7) {
    const g = path.frameAt(ss);
    right.crossVectors(g.tan, UP).normalize();
    for (let v = -ROAD.halfWidth + 0.31; v < ROAD.halfWidth; v += 0.53) {
      const x = g.pos.x + right.x * v, z = g.pos.z + right.z * v;
      const ribbon = g.pos.y + v * Math.tan(g.bank) + 0.035;
      const y = tiles.surfaceAt(x, z);
      if (!Number.isFinite(y)) continue;
      roadN++;
      const d = y - ribbon;
      if (d > 0.0) { poke++; worstPoke = Math.max(worstPoke, d); }
      if (d < -0.9) { gap++; worstGap = Math.max(worstGap, -d); }
    }
  }

  // seams: for every built tile, compare its edge with whatever is across it
  for (const tile of tiles.tiles.values()) {
    const S = WorldTiles.size(tile.l);
    const x0 = tile.i * S, z0 = tile.j * S;
    const step = S / 32;
    for (let k = 0; k <= 32; k += 4) {
      for (const [ex, ez, ox, oz] of [[x0 + k * step, z0, 0, -0.01], [x0, z0 + k * step, -0.01, 0]]) {
        const mine = tiles.surfaceAt(ex + 0.001, ez + 0.001);
        const other = tiles.surfaceAt(ex + ox, ez + oz);
        if (!Number.isFinite(mine) || !Number.isFinite(other)) continue;
        seamN++;
        const dgap = Math.abs(mine - other);
        if (dgap > seamWorst) seamWorst = dgap;
        if (dgap > TILES.skirt * step + 1.5) seamOver++;
      }
    }
  }

  // faceting: adjacent-face angle on level tiles, by distance band
  for (const tile of tiles.tiles.values()) {
    const p = tile.cpos, V = 33;
    const S = WorldTiles.size(tile.l);
    const cx = tile.i * S + S / 2 - fx, cz = tile.j * S + S / 2 - fz;
    const dist = Math.hypot(cx, cz);
    const band = dist < 80 ? '0-80' : dist < 200 ? '80-200' : dist < 420 ? '200-420' : dist < 700 ? '420-700' : '700+';
    const arr = facet.get(band) || []; facet.set(band, arr);
    const n = (a, b, c) => {
      const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
      const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      return [nx / l, ny / l, nz / l];
    };
    for (let j = 0; j < 31; j += 3) {
      for (let i = 0; i < 31; i += 3) {
        const a = j * V + i;
        const n1 = n(a, a + V, a + 1), n2 = n(a + 1, a + V, a + V + 1), n3 = n(a + 1, a + V + 1, a + 2);
        arr.push(Math.acos(Math.min(1, n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2])) * 180 / Math.PI);
        arr.push(Math.acos(Math.min(1, n2[0] * n3[0] + n2[1] * n3[1] + n2[2] * n3[2])) * 180 / Math.PI);
      }
    }
  }
}
const ms = performance.now() - t0;

check('no holes anywhere in the tile radius', holes === 0, `${holes} of ${probes} probes`);
check('LOD seams stay inside their skirts', seamOver === 0, `worst ${seamWorst.toFixed(2)} m over ${seamN} edge samples`);
check('terrain never pokes through the road', poke === 0, `${poke} of ${roadN} (worst ${worstPoke.toFixed(3)} m)`);
check('no visible gap under the road edge', gap === 0, `${gap} of ${roadN} (worst ${worstGap.toFixed(2)} m)`);
check('collidable ground everywhere near the car', colMiss === 0, `${colMiss} of ${colProbes} rays missed`);
console.log(`\n         faceting (adjacent-face angle):`);
for (const band of ['0-80', '80-200', '200-420', '420-700', '700+']) {
  const a = (facet.get(band) || []).sort((x, y) => x - y);
  if (!a.length) continue;
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  console.log(`         ${band.padEnd(8)} mean ${mean.toFixed(2)}°  p99 ${a[Math.floor(a.length * 0.99)].toFixed(2)}°`);
}
console.log(`\n         ${builds} tiles built in ${(ms / 1000).toFixed(1)} s (incl. probing) — ${(ms / Math.max(1, builds)).toFixed(1)} ms/tile upper bound`);
console.log(`\n  ${bad ? 'FAIL' : 'PASS'}`);
process.exit(bad ? 1 : 0);
