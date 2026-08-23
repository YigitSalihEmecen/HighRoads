/**
 * Tree scatter. Loads the real OBJ models off disk (the game fetches them) and
 * builds a stretch of chunks with scenery, checking that trees land on the
 * drawn surface rather than the analytic one, and that the per-chunk budget
 * holds now that canopy is the only group left.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import fs from 'node:fs';
import { WORLD, CHUNK } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';
import { foliageModelNames } from '../src/foliage.js';
import { parseOBJ } from '../src/assets.js';

const DIR = 'assets/Forest_Assets/Ultimate Nature Pack by Quaternius/OBJ';
const foliage = new Map();
for (const name of foliageModelNames()) {
  const file = `${DIR}/${name}.obj`;
  if (!fs.existsSync(file)) { console.log(`  missing model: ${name}`); continue; }
  const geo = parseOBJ(fs.readFileSync(file, 'utf8'));
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  geo.computeBoundingBox();
  foliage.set(name, {
    geometry: geo,
    height: geo.boundingBox.max.y - geo.boundingBox.min.y,
    radius: Math.max(geo.boundingBox.max.x - geo.boundingBox.min.x, geo.boundingBox.max.z - geo.boundingBox.min.z) / 2,
  });
}

const seed = process.argv[2] || WORLD.seed;
const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const scene = new THREE.Scene();
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });
const chunks = new ChunkManager({ scene, world, RAPIER, path, terrain, foliage });
path.ensureLength(3000);
// Real chunks, so there is a real terrain collider to measure against. Going
// back through (s, v) instead is a trap: the placement already ran the offset
// through the fold guard, so re-deriving v from the world position and feeding
// it back applies the compression twice and reports metres of float that are
// not there.
for (let i = 0; i < 26; i++) chunks._build(i);
world.step();
const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

let instances = 0, batches = 0, worstFloat = 0, missed = 0;
const floats = [];
const m = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
const surf = new THREE.Vector3();
const perChunk = [];

for (let i = 1; i < 20; i++) {
  const s0 = i * CHUNK.length, s1 = s0 + CHUNK.length;
  const origin = path.frameAt(s0).pos.clone();
  const objs = chunks._buildProps(i, s0, s1, origin);
  let n = 0;
  for (const mesh of objs) {
    batches++;
    n += mesh.count;
    for (let k = 0; k < mesh.count; k++) {
      mesh.getMatrixAt(k, m);
      m.decompose(pos, q, sc);
      const wp = pos.clone().add(origin);
      // Ground truth: drop a ray onto the collider the player actually drives on.
      ray.origin = { x: wp.x, y: wp.y + 40, z: wp.z };
      const hit = world.castRay(ray, 120, true);
      if (!hit) { missed++; continue; }
      const groundY = wp.y + 40 - (hit.timeOfImpact ?? hit.toi);
      const err = Math.abs(groundY - wp.y);
      if (err > worstFloat) worstFloat = err;
      floats.push(err);
    }
  }
  instances += n;
  perChunk.push(n);
}
const ok = (b) => (b ? ' ok ' : 'FAIL');
const cap = 52;
console.log(`seed "${seed}" — ${foliage.size} tree models loaded, 19 chunks scattered\n`);
console.log(`  [${ok(foliage.size > 20)}] models available               ${foliage.size}`);
console.log(`  [${ok(instances > 0)}] trees placed                   ${instances} (${Math.min(...perChunk)}..${Math.max(...perChunk)} per chunk, cap ${cap})`);
console.log(`  [${ok(Math.max(...perChunk) <= cap)}] per-chunk budget held          max ${Math.max(...perChunk)}`);
console.log(`  [${ok(batches / 19 <= 4)}] draw batches per chunk         ${(batches / 19).toFixed(1)}`);
floats.sort((a, b) => a - b);
const p99 = floats.length ? floats[Math.floor(floats.length * 0.99)] : 0;
const mean = floats.reduce((a, b) => a + b, 0) / (floats.length || 1);
console.log(`  [${ok(mean < 0.05)}] mean float off the collider     ${(mean * 1000).toFixed(1)} mm`);
console.log(`  [${ok(p99 < 0.25)}] p99 float off the collider      ${(p99 * 1000).toFixed(0)} mm  (worst ${worstFloat.toFixed(2)} m, ${missed} rays missed)`);
