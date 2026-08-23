/**
 * Can you see the sky from inside a tunnel?
 *
 * The one artefact a height metric cannot catch is a hole. This fires rays
 * upward and outward from just above the bore floor, against BOTH the terrain
 * collider and the tunnel shell (which is normally visual-only, so the probe
 * gives it a collider of its own). Any ray that escapes in the sealed middle of
 * a bore is a gap the player would see daylight through.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { WORLD, ROAD, CHUNK } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';

const seed = process.argv[2] || WORLD.seed;
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });
const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const chunks = new ChunkManager({ scene: new THREE.Scene(), world, RAPIER, path, terrain, foliage: new Map() });
path.ensureLength(4400);
for (let i = 0; i <= 34; i++) chunks._build(i);

// Give the shell and end caps colliders too — in the game they are visual only,
// but a hole in them is exactly what "you can see sky" means.
let shells = 0;
for (const chunk of chunks.chunks.values()) {
  for (const obj of chunk.objects) {
    if (obj.material !== chunks.matTunnel) continue;
    const g = obj.geometry;
    const pos = g.attributes.position.array;
    const idx = g.index.array;
    const verts = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      verts[i] = pos[i] + chunk.origin.x;
      verts[i + 1] = pos[i + 1] + chunk.origin.y;
      verts[i + 2] = pos[i + 2] + chunk.origin.z;
    }
    world.createCollider(RAPIER.ColliderDesc.trimesh(verts, Uint32Array.from(idx)));
    shells++;
  }
}
world.step();

const runs = [];
let cur = null;
for (let s = 0; s < 4000; s += 1) {
  const t = path.frameAt(s).tunnel;
  if (t >= 1) { if (!cur) cur = { a: s, b: s }; cur.b = s; } else if (cur) { runs.push(cur); cur = null; }
}
if (cur) runs.push(cur);

const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
const UP = new THREE.Vector3(0, 1, 0), right = new THREE.Vector3();
// A fan of directions: straight up plus outward toward each shoulder.
const dirs = [];
for (let a = -70; a <= 70; a += 10) dirs.push(THREE.MathUtils.degToRad(a));

let leaks = 0, probes = 0;
const first = [];
for (const run of runs) {
  for (let s = run.a + 1; s <= run.b - 1; s += 1.0) {
    const f = path.frameAt(s);
    right.crossVectors(f.tan, UP).normalize();
    for (let v = -6; v <= 6; v += 2) {
      const ox = f.pos.x + right.x * v, oz = f.pos.z + right.z * v;
      for (const a of dirs) {
        ray.origin = { x: ox, y: f.pos.y + 0.6, z: oz };
        ray.dir = { x: right.x * Math.sin(a), y: Math.cos(a), z: right.z * Math.sin(a) };
        probes++;
        if (!world.castRay(ray, 400, true)) {
          leaks++;
          if (first.length < 6) first.push(`s=${s.toFixed(0)} v=${v} ${(a * 57.3).toFixed(0)}deg`);
        }
      }
    }
  }
}
const ok = leaks === 0 ? ' ok ' : 'FAIL';
console.log(`  [${ok}] ${seed.padEnd(14)} ${runs.length} sealed bore(s), ${shells} shell meshes  ` +
  `sky leaks ${String(leaks).padStart(5)} / ${probes} rays` + (first.length ? `   e.g. ${first.join(', ')}` : ''));
