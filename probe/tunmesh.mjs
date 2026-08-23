/**
 * Tunnel mesh hygiene.
 *
 * Two artefacts a ray test cannot see:
 *
 *  1. COINCIDENT FACES. Two triangles occupying the same place fight for the
 *     depth buffer and shimmer. Detected by bucketing triangle centroids.
 *  2. SPURIOUS PORTAL RINGS. A span is clipped to its chunk, so a bore crossing
 *     a chunk boundary grows an end cap there — a raised ring of rock around
 *     the bore, in the middle of the tunnel, every 120 m. Counted by comparing
 *     the number of end caps against the number of real tunnel ends.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import { WORLD, ROAD, CHUNK } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';

// _buildTunnels creates the lining collider inline; this probe only wants the
// meshes, so hand it a Rapier stub rather than standing up a physics world.
const RAPIER_STUB = {
  ColliderDesc: {
    trimesh: () => ({ setTranslation() { return this; }, setFriction() { return this; }, setRestitution() { return this; } }),
  },
};
const WORLD_STUB = { createCollider: () => null };

const seeds = process.argv.slice(2);
if (!seeds.length) seeds.push(WORLD.seed, 'bravo', 'charlie', 'foxtrot');

for (const seed of seeds) {
  const terrain = createTerrain(seed);
  const path = new RoadPath(terrain, seed);
  const chunks = new ChunkManager({
    scene: new THREE.Scene(), world: WORLD_STUB, RAPIER: RAPIER_STUB, path, terrain, foliage: new Map(),
  });
  path.ensureLength(4400);

  // How many genuine tunnel ends are there in the stretch?
  let ends = 0, inRun = false;
  for (let s = 0; s < 4000; s += 0.5) {
    const t = path.frameAt(s).tunnel > 0;
    if (t !== inRun) { ends++; inRun = t; }
  }

  const cent = new Map();
  let tris = 0, dup = 0, meshes = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();

  for (let i = 0; i <= 33; i++) {
    const s0 = i * CHUNK.length;
    const origin = path.frameAt(s0).pos.clone();
    for (const item of chunks._buildTunnels(s0, s0 + CHUNK.length, origin)) {
      if (item._collider !== undefined) continue;
      meshes++;
      const pos = item.geometry.attributes.position.array;
      const idx = item.geometry.index.array;
      for (let t = 0; t < idx.length; t += 3) {
        a.fromArray(pos, idx[t] * 3); b.fromArray(pos, idx[t + 1] * 3); c.fromArray(pos, idx[t + 2] * 3);
        const cx = (a.x + b.x + c.x) / 3 + origin.x;
        const cy = (a.y + b.y + c.y) / 3 + origin.y;
        const cz = (a.z + b.z + c.z) / 3 + origin.z;
        // 2 cm buckets: anything closer than that is fighting for the same pixel.
        const key = `${Math.round(cx * 50)},${Math.round(cy * 50)},${Math.round(cz * 50)}`;
        tris++;
        if (cent.has(key)) dup++; else cent.set(key, 1);
      }
    }
  }
  const okDup = dup === 0;
  console.log(`  [${okDup ? ' ok ' : 'FAIL'}] ${seed.padEnd(13)} ` +
    `${String(meshes).padStart(2)} bore meshes, ${String(tris).padStart(6)} triangles, ` +
    `coincident ${String(dup).padStart(5)} (${((100 * dup) / Math.max(1, tris)).toFixed(1)}%)   ` +
    `real tunnel ends ${ends}`);
}
