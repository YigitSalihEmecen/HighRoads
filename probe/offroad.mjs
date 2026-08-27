/**
 * offroad.mjs — checks the ground off the paved surface.
 *
 * Probes everywhere the player can drive and reports voids beneath the
 * wheels.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { WORLD, ROAD, ROUTE, CHUNK } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';

const seed = process.argv[2] || WORLD.seed;
const S_MAX = Number(process.argv[3] || 2600);
const S_MIN = 200;

// Matches `main.js:RECOVER_MARGIN`:
const RECOVER_MARGIN = 12;

// How far out to demand ground, metres. Deliberately past
// `CHUNK.recoverLateral`: the sweep once stopped at the recovery bound and
// skipped every sample outside it, so it could not fail and reported 0 holes
// while 12.4% of the ground within 300 m did not exist.
const PROBE_OUT = 600;

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });
world.timestep = WORLD.fixedStep;
const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const chunks = new ChunkManager({
  scene: new THREE.Scene(), world, RAPIER, path, terrain, foliage: new Map(),
});
path.ensureLength(S_MAX + 600);

const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
const UP = new THREE.Vector3(0, 1, 0);
const right = new THREE.Vector3();
/** High enough to clear the tallest cut face, deep enough to find a canyon. */
const START = 900;
const REACH = 3000;

let bad = 0;
const check = (label, pass, detail = '') => {
  if (!pass) bad++;
  console.log(`  [${pass ? ' ok ' : 'FAIL'}] ${label.padEnd(38)} ${detail}`);
};

console.log(`\nseed "${seed}" — ground off the road, s = ${S_MIN}..${S_MAX}\n`);

// ---- corridor width the guard is delivering --------------------------------

const reach = { left: 0, right: 0 };
let minReach = Infinity, minAt = 0;
const widths = [];
for (let s = S_MIN; s <= S_MAX; s += 2.5) {
  path.corridorAt(s, reach);
  for (const w of [reach.left, reach.right]) {
    widths.push(w);
    if (w < minReach) { minReach = w; minAt = s; }
  }
}
widths.sort((a, b) => a - b);
const pct = (p) => widths[Math.floor(widths.length * p)];
// Measured floor, not a design one: with `ROUTE.foldSmooth` = 6 this delivers
// 73.0-94.4 m across five seeds, so 70 is a regression bar with slack.
check('corridor stays usefully wide', minReach >= 70,
  `min ${minReach.toFixed(1)} m @ s=${minAt.toFixed(0)}, bar 70 m`);
console.log(`         corridor width  p1 ${pct(0.01).toFixed(0)} m · ` +
  `p10 ${pct(0.10).toFixed(0)} m · median ${pct(0.5).toFixed(0)} m`);

// The fix also caps the turn rate the guard will believe, and a cap on a safety
// limit can trade one bug for a worse one — so measure it directly. A cell is
// inverted when its XZ footprint has changed sign (the row in front crossed the
// row behind).
let cells = 0, inverted = 0, minDepth = Infinity, minDepthAt = null;
{
  const nv = chunks.lateral.length;
  const nu = CHUNK.segmentsU;
  for (let index = 2; index < 22; index++) {
    const s0 = index * CHUNK.length;
    const origin = path.frameAt(s0).pos.clone();
    const { positions } = chunks._buildTerrain(s0, s0 + CHUNK.length, origin);
    const nominal = CHUNK.length / nu;
    for (let j = 0; j < nu; j++) {
      for (let i = 0; i < nv - 1; i++) {
        const a = (j * nv + i) * 3;
        const b = a + 3;
        const c = a + nv * 3;
        // Longitudinal depth of this cell at its own lateral offset, measured
        // in the plane. `ds * (1 + v * kappa)` is what the guard bounds.
        const ex = positions[b] - positions[a], ez = positions[b + 2] - positions[a + 2];
        const fx = positions[c] - positions[a], fz = positions[c + 2] - positions[a + 2];
        // (e x f).y for e = +column (right) and f = +row (tangent). Positive is
        // an upward face normal — the winding `_buildTerrain` documents.
        const area = ez * fx - ex * fz;
        const width = Math.hypot(ex, ez);
        cells++;
        if (area <= 0) inverted++;
        if (width > 1e-4) {
          const depth = area / width / nominal;   // fraction of nominal depth
          if (depth < minDepth) { minDepth = depth; minDepthAt = { index, i, j }; }
        }
      }
    }
  }
}
// NOT zero: `frameAt` interpolates the limits between road samples, so a row
// can sit between frames whose maxima both under-read the rotation. The old
// baseline was 239-580 inverted of 117,120 cells; anything above is bugs #58/#59
// coming back.
check('sheet folds no more than it used to', inverted <= 580,
  `${inverted} inverted of ${cells} cells (was 239-580)`);
console.log(`         thinnest cell ${(minDepth * 100).toFixed(0)}% of nominal depth`);

// ---- is there ground under every reachable point ---------------------------

let probes = 0, holes = 0, outside = 0;
let firstHole = null;
let loadedFor = -1e9;

for (let s = S_MIN + 0.137; s <= S_MAX; s += 5) {
  // Stream exactly the window the game keeps alive: building every chunk at once
  // puts sheets in the world that can never coexist.
  if (s - loadedFor > CHUNK.length * 0.5) { chunks.update(s, 99); world.step(); loadedFor = s; }

  const f = path.frameAt(s);
  right.crossVectors(f.tan, UP).normalize();
  path.corridorAt(s, reach);

  for (let v = -PROBE_OUT; v <= PROBE_OUT; v += 5) {
    const av = Math.abs(v);
    if (av <= ROAD.halfWidth) continue;                  // surface.mjs owns this
    const edge = v < 0 ? reach.left : reach.right;
    if (av > Math.min(CHUNK.recoverLateral, edge - RECOVER_MARGIN)) outside++;

    // Offset off the mesh lattice: a ray straight down a shared triangle edge can
    // miss both faces on floating-point grounds alone.
    const off = v + 0.091;
    ray.origin = { x: f.pos.x + right.x * off, y: f.pos.y + START, z: f.pos.z + right.z * off };
    probes++;
    if (!world.castRay(ray, START + REACH, true)) {
      holes++;
      if (!firstHole) firstHole = { s: Math.round(s), v, edge: edge.toFixed(0) };
    }
  }
}

const rate = probes ? (holes / probes) * 100 : 0;
check('no holes inside the drivable area', holes === 0,
  `${holes} / ${probes} probes (${rate.toFixed(2)}%)` +
  (firstHole ? `  first {s:${firstHole.s}, v:${firstHole.v}, edge:${firstHole.edge}}` : ''));
console.log(`         ${outside} of them beyond the recovery bound — probed anyway, see PROBE_OUT`);

console.log(`\n  [${bad ? 'FAIL' : ' ok '}] off-road ground\n`);
process.exit(bad ? 1 : 0);
