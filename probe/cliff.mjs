/**
 * cliff.mjs — measures longitudinal steps in the terrain sheet.
 *
 * Reports the height change per terrain row across the corridor.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import { WORLD, ROAD, CHUNK } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';

const seeds = process.argv.slice(2);
if (!seeds.length) seeds.push(WORLD.seed, 'bravo', 'charlie', 'delta', 'echo');
const dS = CHUNK.length / CHUNK.segmentsU;
const UP = new THREE.Vector3(0, 1, 0);

for (const seed of seeds) {
  const terrain = createTerrain(seed);
  const path = new RoadPath(terrain, seed);
  const chunks = new ChunkManager({ scene: new THREE.Scene(), world: null, RAPIER: null, path, terrain, foliage: new Map() });
  path.ensureLength(4200);

  const right = new THREE.Vector3(), p = new THREE.Vector3();
  const cols = chunks.lateral.filter((v) => Math.abs(v) <= 60);
  let prev = null;
  let worst = 0, worstAt = 0, worstV = 0, over = 0;

  for (let s = 120; s < 4000; s += dS) {
    const f = path.frameAt(s);
    right.crossVectors(f.tan, UP).normalize();
    const row = cols.map((v) => chunks.sampleGround(f, right, v, p).y - f.pos.y);
    if (prev) {
      for (let i = 0; i < cols.length; i++) {
        const d = Math.abs(row[i] - prev[i]);
        if (d > 8) over++;
        if (d > worst) { worst = d; worstAt = s; worstV = cols[i]; }
      }
    }
    prev = row;
  }
  const ok = worst < 8 ? ' ok ' : 'FAIL';
  console.log(`  [${ok}] ${seed.padEnd(14)} worst step ${worst.toFixed(1).padStart(5)} m ` +
    `at s=${worstAt.toFixed(0).padStart(4)} v=${worstV.toFixed(1).padStart(6)}   ` +
    `over 8 m: ${String(over).padStart(3)}`);
}
