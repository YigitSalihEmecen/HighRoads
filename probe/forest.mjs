/**
 * forest.mjs — measures the TreeGen canopy (env/treegen.js + forest.js).
 *
 * The library: triangles per level per species, and that the generator is
 * deterministic. The scatter: trees placed, nothing on the carriageway, float
 * off the real collider, and that it is still LUMPY. The forest: what one
 * frame at the start of the road draws at each level of detail, its triangle
 * total, and what the per-frame LOD pass costs on the CPU.
 *
 * Headless, so no billboards are baked; the billboard level is 6 triangles.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { WORLD, CHUNK, TREES, CAMERA } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';
import { createTreeGenAssets } from '../src/env/treegen.js';

TREES.generator = 'treegen';
const seed = process.argv[2] || WORLD.seed;
const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const scene = new THREE.Scene();
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });

let bad = 0;
const check = (label, pass, detail = '') => {
  if (!pass) bad++;
  console.log(`  [${pass ? ' ok ' : 'FAIL'}] ${label.padEnd(34)} ${detail}`);
};
console.log(`\nseed "${seed}" — TreeGen canopy\n`);

// ---- the library ------------------------------------------------------------

let t0 = performance.now();
const trees = createTreeGenAssets();
const buildS = (performance.now() - t0) / 1000;
const levels = trees.specs.map((L, i) => (L.impostor ? 'billboard' : `L${i}`));
console.log(`  species   ${levels.map((l) => l.padStart(16)).join('')}`);
for (const [name, vs] of trees.library) {
  console.log(`  ${name.padEnd(9)} ${trees.specs.map((L, i) =>
    vs.map((v) => v.levels[i].tris).join('/').padStart(16)).join('')}`);
}
console.log(`  mean      ${trees.trianglesPerLevel.map((t) => Math.round(t).toLocaleString().padStart(16)).join('')}\n`);
const mesh = trees.specs.map((L, i) => i).filter((i) => !trees.specs[i].impostor);
check('every level cheaper than the last', mesh.every((i, k) => k === 0 ||
  trees.trianglesPerLevel[i] < trees.trianglesPerLevel[mesh[k - 1]]),
trees.trianglesPerLevel.map((t) => Math.round(t)).join(' > '));
check('nearest level inside its budget', trees.trianglesPerLevel[0] <= 60000,
  `${Math.round(trees.trianglesPerLevel[0]).toLocaleString()} tris/tree, budget 60,000`);
check('library build time', buildS < 12, `${buildS.toFixed(1)} s headless (the boot adds the bakes)`);

const again = createTreeGenAssets({ names: ['oak'] });
const a = trees.library.get('oak')[1].levels[0].parts[0].geometry.attributes.position.array;
const b = again.library.get('oak')[1].levels[0].parts[0].geometry.attributes.position.array;
let drift = a.length === b.length ? 0 : Infinity;
for (let i = 0; i < a.length && drift < Infinity; i++) drift = Math.max(drift, Math.abs(a[i] - b[i]));
check('the library is deterministic', drift === 0, `worst vertex drift ${drift}`);
again.dispose();

// ---- the scatter ------------------------------------------------------------

const chunks = new ChunkManager({ scene, world, RAPIER, path, terrain, trees });
path.ensureLength(3000);
for (let i = 0; i < 24; i++) chunks._build(i);
world.step();
const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
const toRoad = (x, z, s0, s1) => {
  let best = Infinity;
  for (let s = s0 - 80; s <= s1 + 80; s += 2) {
    const f = path.frameAt(s);
    best = Math.min(best, Math.hypot(x - f.pos.x, z - f.pos.z));
  }
  return best;
};

let scatterMs = 0, placed = 0, lone = 0, closest = Infinity, missed = 0;
const floats = [], perChunk = [];
for (let i = 2; i < 20; i++) {
  const s0 = i * CHUNK.length, s1 = s0 + CHUNK.length;
  chunks._ensureSheet(i);
  t0 = performance.now();
  chunks._buildProps(i, s0, s1, chunks.chunks.get(i).origin);
  scatterMs += performance.now() - t0;
  const rec = chunks.forest.chunks.get(i);
  let near = 0;
  for (let k = 0; k < rec.n; k++) {
    placed++;
    if (rec.lone[k]) { lone++; continue; }
    const x = rec.pos[k * 3], y = rec.pos[k * 3 + 1], z = rec.pos[k * 3 + 2];
    const d = toRoad(x, z, s0, s1);
    closest = Math.min(closest, d);
    // Past the near band it is the distant woodland, which has no cap.
    if (d < 170) near++;
    ray.origin = { x, y: y + 60, z };
    const hit = world.castRay(ray, 200, true);
    if (!hit) { missed++; continue; }
    floats.push(Math.abs(60 - (hit.timeOfImpact ?? hit.toi)));
  }
  perChunk.push(near);
}
const mean = perChunk.reduce((s, n) => s + n, 0) / perChunk.length;
const sd = Math.sqrt(perChunk.reduce((s, n) => s + (n - mean) ** 2, 0) / perChunk.length);
floats.sort((p, q) => p - q);
const p99 = floats.length ? floats[Math.floor(floats.length * 0.99)] : 0;

console.log('');
check('trees placed', placed > 0, `${placed} (${lone} far-only), near per chunk ${Math.min(...perChunk)}..${Math.max(...perChunk)}`);
check('per-chunk cap held', Math.max(...perChunk) <= TREES.nearCap, `max ${Math.max(...perChunk)} of ${TREES.nearCap}`);
check('scatter cost', scatterMs / 18 < 25, `${(scatterMs / 18).toFixed(1)} ms per chunk`);
check('nothing on the carriageway', closest >= CHUNK.plantClear - 0.5,
  `closest ${closest.toFixed(1)} m, clear ${CHUNK.plantClear} m`);
check('p99 float off the collider', p99 < 0.25, `${(p99 * 1000).toFixed(0)} mm (${missed} rays missed)`);
check('the scatter is not uniform', sd / Math.max(1, mean) > 0.25,
  `spread ${(sd / Math.max(1, mean) * 100).toFixed(0)}% of mean ${mean.toFixed(0)}`);

// ---- one frame ---------------------------------------------------------------

// Drop the chunks the game would not hold around s = 4.5 chunks.
const center = 4;
for (const k of [...chunks.forest.chunks.keys()]) {
  if (k < center - CHUNK.behind || k > center + CHUNK.ahead) chunks.forest.removeChunk(k);
}
const cam = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, 0.5, CAMERA.far);
const f = path.frameAt(center * CHUNK.length + 60);
cam.position.copy(f.pos).addScaledVector(f.tan, -6).add(new THREE.Vector3(0, 2.2, 0));
cam.lookAt(f.pos.clone().addScaledVector(f.tan, 40).add(new THREE.Vector3(0, 1.5, 0)));
cam.updateProjectionMatrix();
chunks.forest.update(cam, 1080);
const st = { ...chunks.forest.stats };
t0 = performance.now();
for (let i = 0; i < 60; i++) chunks.forest.update(cam, 1080);
const lodMs = (performance.now() - t0) / 60;
console.log(`\n  in view at 1080p: ${st.drawn} of ${st.total} trees — per level ${st.perLevel.join(' / ')}`);
check('canopy triangles in view', st.tris <= 6000000, `${st.tris.toLocaleString()}, budget 6,000,000`);
check('LOD pass cost', lodMs < 4, `${lodMs.toFixed(2)} ms per frame for ${st.total} trees`);

// A row of 15 m oaks straight ahead, 8 m to 600 m out: every level must be
// drawn somewhere along it, nearest first.
chunks.forest.chunks.clear();
const fwd = cam.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
const oak = trees.library.get('oak')[0];
const row = [];
for (let d = 8; d < 600; d *= 1.08) {
  const m = new THREE.Matrix4().makeScale(15, 15, 15)
    .setPosition(fwd.x * d, cam.position.y - 2, fwd.z * d);
  row.push({ variant: oak, matrix: m, origin: cam.position.clone().setY(0), colour: [1, 1, 1], lone: false });
}
chunks.forest.addChunk(-1, row);
chunks.forest.update(cam, 1080);
const lv = chunks.forest.stats.perLevel;
check('every level is drawn along a row', lv.every((n) => n > 0), `${lv.join(' / ')} of ${row.length}`);

console.log(`\n  [${bad ? 'FAIL' : ' ok '}] forest\n`);
process.exit(bad ? 1 : 0);
