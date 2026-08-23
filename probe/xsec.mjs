/**
 * Terrain cross-sections through a tunnel. Prints the ground profile across the
 * corridor at stations through a bore, so the shape the player actually sees
 * can be read rather than guessed at.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import { WORLD, ROAD, CHUNK } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';

const seed = process.argv[2] || WORLD.seed;
const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const chunks = new ChunkManager({ scene: new THREE.Scene(), world: null, RAPIER: null, path, terrain, foliage: new Map() });
path.ensureLength(3000);

let run = null;
for (let s = 0; s < 2600; s += 2.5) {
  const t = path.frameAt(s).tunnel;
  if (t > 0) { if (!run) run = { a: s, b: s }; run.b = s; } else if (run) break;
}
if (!run) { console.log('no tunnel'); process.exit(0); }
console.log(`tunnel ${run.a.toFixed(0)}..${run.b.toFixed(0)} m\n`);

const UP = new THREE.Vector3(0, 1, 0);
const right = new THREE.Vector3(), p = new THREE.Vector3();
const cols = [0, 5, 9, 9.4, 11, 11.7, 14, 20, 30, 45, 60, 90];
const at = [run.a - 12, run.a - 4, run.a + 1, run.a + 4, run.a + 10, run.a + 30,
            (run.a + run.b) / 2, run.b - 30, run.b - 4, run.b + 4, run.b + 12];

process.stdout.write('   s     tun  cover |');
for (const c of cols) process.stdout.write(String(c).padStart(7));
console.log('\n' + '-'.repeat(24 + cols.length * 7));
for (const s of at) {
  const f = path.frameAt(s);
  right.crossVectors(f.tan, UP).normalize();
  process.stdout.write(`${s.toFixed(0).padStart(5)}  ${f.tunnel.toFixed(2)}  ${f.cover.toFixed(1).padStart(5)} |`);
  for (const c of cols) {
    chunks.sampleGround(f, right, c, p);
    process.stdout.write((p.y - f.pos.y).toFixed(1).padStart(7));
  }
  console.log();
}
console.log('\n(height above the road plane, metres, at lateral offsets across the corridor)');
console.log(`arch crown ${ROAD.tunnelCrown} m, bore half-width ${ROAD.tunnelHalfWidth} m, sill edge ${(ROAD.tunnelHalfWidth + ROAD.tunnelSill).toFixed(1)} m`);
