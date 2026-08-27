/**
 * xsec.mjs — prints terrain cross-sections across the corridor.
 *
 * Ground profile each side of the road at every station, so the shape the
 * player sees is read, not guessed.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import { WORLD, ROAD, CHUNK } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';

const seed = process.argv[2] || WORLD.seed;
const startS = Number(process.argv[3] || 200);
const count = Number(process.argv[4] || 12);
const stepS = 80;

const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const chunks = new ChunkManager({ scene: new THREE.Scene(), world: null, RAPIER: null, path, terrain, foliage: new Map() });
path.ensureLength(startS + count * stepS + 600);

const UP = new THREE.Vector3(0, 1, 0);
const right = new THREE.Vector3(), p = new THREE.Vector3();
const cols = [-90, -60, -30, -14, 0, 14, 30, 60, 90];

console.log(`\nseed "${seed}" — ground height relative to the road plane, metres\n`);
process.stdout.write('    s   grade  cover |');
for (const c of cols) process.stdout.write(String(c).padStart(7));
console.log('\n' + '-'.repeat(22 + cols.length * 7));

let prev = null;
for (let i = 0; i < count; i++) {
  const s = startS + i * stepS;
  const f = path.frameAt(s);
  right.crossVectors(f.tan, UP).normalize();
  const grade = prev === null ? 0 : (f.pos.y - prev) / stepS;
  prev = f.pos.y;
  process.stdout.write(`${s.toFixed(0).padStart(5)}  ${(grade * 100).toFixed(1).padStart(5)}%  ${f.cover.toFixed(1).padStart(5)} |`);
  for (const c of cols) {
    chunks.sampleGround(f, right, c, p);
    process.stdout.write((p.y - f.pos.y).toFixed(1).padStart(7));
  }
  console.log();
}
console.log('\ncover > 0 means the alignment sits below the natural surface (a cutting).');
