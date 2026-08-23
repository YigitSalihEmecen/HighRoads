/**
 * How faceted is the ground?
 *
 * "Pointy" is a statement about the angle between neighbouring faces, so that
 * is what gets measured: build the terrain on the exact lattice the mesh uses,
 * take a normal per cell, and report the angle between horizontally adjacent
 * normals. A smooth hillside has neighbours a couple of degrees apart; a
 * faceted one has spikes of tens of degrees, and those spikes are what the eye
 * reads as a crease.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import { WORLD, ROAD, CHUNK } from '../src/config.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';

import { createTerrain } from '../src/noise.js';

const BANDS = [[0, 80, 'near   0-80 m'], [80, 200, 'mid   80-200 m'],
               [200, 420, 'far  200-420 m'], [420, 700, 'edge 420-700 m']];
const seeds = ['fastroads-01', 'bravo', 'charlie'];
const acc = BANDS.map(() => []);

for (const seed of seeds) {
  const terrain = createTerrain(seed);
  const path = new RoadPath(terrain, seed);
  const chunks = new ChunkManager({
    scene: new THREE.Scene(), world: null, RAPIER: null, path, terrain, foliage: new Map(),
  });
  path.ensureLength(3200);

  const lat = chunks.lateral;
  const UP = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3(), p = new THREE.Vector3();
  const dS = CHUNK.length / CHUNK.segmentsU;

  for (let s = 200; s < 3000; s += dS * 4) {
    // Two rows, so a cell normal can be built from both directions.
    const rows = [];
    for (const sr of [s, s + dS]) {
      const f = path.frameAt(sr);
      right.crossVectors(f.tan, UP).normalize();
      const h = new Float64Array(lat.length);
      for (let i = 0; i < lat.length; i++) h[i] = chunks.sampleGround(f, right, lat[i], p).y;
      rows.push(h);
    }
    const normals = [];
    for (let i = 0; i < lat.length - 1; i++) {
      const dv = lat[i + 1] - lat[i];
      const dhv = rows[0][i + 1] - rows[0][i];
      const dhu = rows[1][i] - rows[0][i];
      // normal of the cell, from the two edge slopes
      const n = new THREE.Vector3(-dhv / dv, 1, -dhu / dS).normalize();
      normals.push({ n, av: Math.abs((lat[i] + lat[i + 1]) / 2) });
    }
    for (let i = 0; i < normals.length - 1; i++) {
      if (Math.sign(lat[i]) !== Math.sign(lat[i + 1]) && lat[i] !== 0) continue;
      const ang = THREE.MathUtils.radToDeg(Math.acos(
        THREE.MathUtils.clamp(normals[i].n.dot(normals[i + 1].n), -1, 1)));
      const av = normals[i].av;
      for (let b = 0; b < BANDS.length; b++) {
        if (av >= BANDS[b][0] && av < BANDS[b][1]) { acc[b].push(ang); break; }
      }
    }
  }
}

const pct = (a, q) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : 0;
console.log('terrain faceting  (angle between adjacent face normals, degrees)');
console.log('  band              n        mean      p99       max');
for (let b = 0; b < BANDS.length; b++) {
  const a = acc[b].slice().sort((x, y) => x - y);
  const mean = a.reduce((x, y) => x + y, 0) / (a.length || 1);
  console.log(`  ${BANDS[b][2].padEnd(16)} ${String(a.length).padStart(6)}  ` +
    `${mean.toFixed(2).padStart(8)}  ${pct(a, 0.99).toFixed(2).padStart(7)}  ${(a[a.length - 1] || 0).toFixed(2).padStart(8)}`);
}
