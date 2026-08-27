/**
 * grass.mjs — measures the near ground-cover tier.
 *
 * Reports tuft count, cost, and float off the collider.
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { WORLD, CHUNK, ROAD, GRASS } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';

const seed = process.argv[2] || WORLD.seed;
await RAPIER.init();

const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });
world.timestep = WORLD.fixedStep;
const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const chunks = new ChunkManager({
  scene: new THREE.Scene(), world, RAPIER, path, terrain, foliage: new Map(),
});

let bad = 0;
const check = (label, pass, detail = '') => {
  if (!pass) bad++;
  console.log(`  [${pass ? ' ok ' : 'FAIL'}] ${label.padEnd(38)} ${detail}`);
};

console.log(`\nseed "${seed}" — ground cover\n`);

// Build the chunks the car would have around it, then scatter grass into them.
chunks.preload(CHUNK.length * 2);
for (let i = 0; i < 40; i++) chunks.update(CHUNK.length * 2);

const times = [];
const counts = [];
for (let i = 1; i <= 6; i++) {
  const s0 = i * CHUNK.length;
  const chunk = chunks.chunks.get(i);
  if (!chunk) continue;
  const t0 = performance.now();
  const mesh = chunks._buildGrass(i, s0, s0 + CHUNK.length, chunk.origin);
  times.push(performance.now() - t0);
  counts.push(mesh ? mesh.count : 0);
  if (mesh) mesh.dispose();
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const perChunk = mean(counts);
const live = GRASS.chunkRadius * 2 + 1;
const tris = perChunk * live * 4;

console.log(`  per chunk: ${counts.map((c) => c.toLocaleString()).join(', ')}`);
console.log(`  chunks carrying grass: ${live}  (radius ${GRASS.chunkRadius})\n`);

// A frame budget, not an absolute: this runs once per chunk boundary, so at
// 240 km/h it is a dropped-frame ceiling every 1.8 s.
check('scatter cost per chunk', mean(times) < 20,
  `${mean(times).toFixed(1)} ms mean, ${Math.max(...times).toFixed(1)} ms worst`);
check('instances alive', perChunk * live < 120000,
  `${Math.round(perChunk * live).toLocaleString()} (${Math.round(perChunk).toLocaleString()} per chunk)`);
check('triangles alive', tris < 600000,
  `${Math.round(tris).toLocaleString()}  — terrain is ~109,000 for comparison`);

const band = (GRASS.halfExtent - (ROAD.halfWidth + ROAD.shoulder - 0.35)) * 2;
const actual = perChunk / (CHUNK.length * band);
check('density matches config', actual <= GRASS.density * 1.05,
  `${actual.toFixed(2)}/m^2 placed against ${GRASS.density.toFixed(2)} asked (thinning is expected)`);

{
  const chunk = chunks.chunks.get(2);
  const mesh = chunks._buildGrass(2, 2 * CHUNK.length, 3 * CHUNK.length, chunk.origin);
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  let onRoad = 0, outside = 0, minLat = Infinity, maxLat = 0, sHint = 2 * CHUNK.length;
  let minH = Infinity, maxH = 0;
  const scl = new THREE.Vector3();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    p.setFromMatrixPosition(m).add(chunk.origin);
    scl.setFromMatrixScale(m);
    minH = Math.min(minH, scl.y); maxH = Math.max(maxH, scl.y);
    const s = path.projectPoint(p, sHint);
    const lat = Math.abs(path.lateralOffset(p, s));
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    if (lat < ROAD.halfWidth) onRoad++;
    if (lat > GRASS.halfExtent + 1) outside++;
  }
  check('none on the carriageway', onRoad === 0,
    `${onRoad} of ${mesh.count}, closest ${minLat.toFixed(2)} m (road half-width ${ROAD.halfWidth})`);
  check('none beyond the band', outside === 0,
    `${outside}, furthest ${maxLat.toFixed(1)} m of ${GRASS.halfExtent}`);
  // Cards grow with lateral distance (GRASS.farScale), so the ceiling is the
  // configured maximum times that boost, not the configured maximum.
  const hiLimit = GRASS.height[1] * GRASS.farScale;
  check('heights inside the configured range',
    minH >= GRASS.height[0] - 1e-3 && maxH <= hiLimit + 1e-3,
    `${minH.toFixed(2)}..${maxH.toFixed(2)} m against ${GRASS.height[0]}..${hiLimit.toFixed(2)} (x${GRASS.farScale} at the edge)`);
  mesh.dispose();
}

// Two edges, hidden two different ways. SIDEWAYS by the density taper reaching
// zero at the band edge (the distance fade cannot: a tuft beside the car is
// only as far off as the band is wide); UP THE ROAD by the fade, which must
// reach further than the band is wide.
check('density taper reaches zero at the edge', GRASS.denseTo < GRASS.halfExtent,
  `full to ${GRASS.denseTo} m, zero at ${GRASS.halfExtent} m`);
check('fade outlives the lateral band', GRASS.fadeEnd > GRASS.halfExtent,
  `fades out by ${GRASS.fadeEnd} m, band is ${GRASS.halfExtent} m wide`);
check('fade is gradual', GRASS.fadeEnd - GRASS.fadeStart >= 20,
  `${GRASS.fadeStart}..${GRASS.fadeEnd} m`);

console.log(`\n  [${bad ? 'FAIL' : ' ok '}] ground cover` + (bad ? `  — ${bad} problem(s)` : ''));
process.exit(bad ? 1 : 0);
