/**
 * barriers.mjs — where chunks.js:_buildBarriers puts guardrail and fence.
 *
 * Over several kilometres: how much of each kind (vertices); that every post
 * stands off the carriageway; that a run is the same run whichever chunk
 * window looks at it (`barrierRuns` is pure in the station — the guard
 * against a rail that stops dead at a chunk seam); that every run has a
 * hazard (a sharp bend's outside, or a drop) inside it; and the cost a chunk.
 * LIST=1 prints each chunk's runs and their extent, to find one to look at.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import { WORLD, CHUNK, ROAD, BARRIERS } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';
import { barrierRuns } from '../src/env/barriers.js';

const seed = process.argv[2] || WORLD.seed;
const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const chunks = new ChunkManager({ scene: new THREE.Scene(), world: null, RAPIER: null, path, terrain });
let bad = 0;
const check = (label, pass, detail = '') => {
  if (!pass) bad++;
  console.log(`  [${pass ? ' ok ' : 'FAIL'}] ${label.padEnd(36)} ${detail}`);
};
console.log(`\nseed "${seed}" — roadside barriers, ${ROAD.lanesPerSide * 2} lanes\n`);

const N = 60;
path.ensureLength((N + 2) * CHUNK.length + 2000);
const verts = { steel: 0, wood: 0 };
let onRoad = 0, sampled = 0;
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const objects = [];
  const origin = path.frameAt(i * CHUNK.length).pos.clone();
  chunks._buildBarriers(i * CHUNK.length, (i + 1) * CHUNK.length, origin, objects, []);
  const here = [];
  for (const o of objects) {
    const kind = o.userData.barrier;
    const pos = o.geometry.getAttribute('position');
    // Every vertex off the asphalt (sampled), measured against the road it stands beside.
    for (let k = 0; k < pos.count; k += 7) {
      const x = pos.getX(k) + origin.x, z = pos.getZ(k) + origin.z;
      if (chunks.field.roadDistance(x, z) < ROAD.halfWidth + 0.3) onRoad++;
      sampled++;
    }
    // The run's rough extent, for LIST.
    const box = new THREE.Box3().setFromBufferAttribute(pos);
    here.push(`${kind} ~${box.getSize(new THREE.Vector3()).length().toFixed(0)} m`);
    verts[kind] += pos.count;
  }
  if (process.env.LIST && here.length) console.log(`  s=${i * CHUNK.length}  ${here.join(', ')}`);
}
const ms = (performance.now() - t0) / N;
console.log(`  vertices — steel ${verts.steel}, wood ${verts.wood}\n`);
check('barriers placed', verts.steel + verts.wood > 0, '');
check('nothing on the carriageway', onRoad === 0, `${onRoad} of ${sampled} vertices inside ${(ROAD.halfWidth + 0.3).toFixed(1)} m`);
// Time-sliced in the scatter job (chunks.js:_propsJob), so a budget, not a frame.
check('placement cost', ms < 5, `${ms.toFixed(2)} ms/chunk`);

// The run logic against a synthetic hazard: windows of every offset agree.
const haz = (k) => (k >= 40 && k < 46) || (k >= 52 && k < 54) || k === 90 || (k >= 200 && k < 260);
const B = { ...BARRIERS };
const key = (r) => `${r.a}:${r.b}:${r.wood}`;
const whole = new Map(barrierRuns(0, 400, haz, B, 1, 0.5).map((r) => [key(r), r]));
let disagree = 0;
for (let w = 0; w < 400; w += 7) for (const r of barrierRuns(w, w + 30, haz, B, 1, 0.5)) if (!whole.has(key(r))) disagree++;
check('a run is one run in every window', disagree === 0, `${whole.size} runs, ${disagree} disagreements`);
const runs = [...whole.values()];
check('gaps bridged, short hazards dropped', runs.length === 2 && runs[0].a <= 40 - 4 && runs[0].b >= 53 + 4,
  runs.map((r) => `${r.a}..${r.b}`).join(' '));
check('every run holds a hazard', runs.every((r) => { for (let k = r.a; k <= r.b; k++) if (haz(k)) return true; return false; }), '');

console.log(bad ? `\n${bad} FAILED\n` : '\nall ok\n');
process.exit(bad ? 1 : 0);
