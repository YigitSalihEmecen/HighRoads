/**
 * signs.mjs — where chunks.js:_buildSigns puts road signs, against a stub
 * library (the real one needs a canvas; probe/signs.html is its contact sheet).
 *
 * Over a few kilometres of road: signs per km by role, that every chevron
 * stands on the outside of a bend sharp enough to have one, that nothing
 * stands on the carriageway or shoulder, that roadside signs face the
 * traffic they are for, and that the same chunk places the same signs.
 * LIST=1 prints every chunk's signs, to find one to look at (render.mjs teleport).
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import { WORLD, CHUNK, ROAD, SIGNS } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';

const seed = process.argv[2] || WORLD.seed;
const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const scene = new THREE.Scene();

const ROLES = ['chevron', 'curve', 'speed', 'warn', 'guide', 'marker', 'pennant', 'portal', 'cantilever'];
const box = (role) => role === 'portal' ? new THREE.Box3(new THREE.Vector3(-11.5, 0, -0.5), new THREE.Vector3(11.5, 6.5, 0.5))
  : role === 'cantilever' ? new THREE.Box3(new THREE.Vector3(-5.2, 0, -0.5), new THREE.Vector3(4.9, 6.5, 0.5))
    : new THREE.Box3(new THREE.Vector3(-0.6, 0, -0.1), new THREE.Vector3(0.6, 3.2, 0.1));
const roles = new Map(ROLES.map((r) => [r,
  (r === 'chevron' || r === 'curve' ? [1, -1] : [0]).map((dir) => ({ role: r, dir, box: box(r), tris: 0 }))]));
const signs = {
  roles,
  instance(variant) { const o = new THREE.Object3D(); o.userData.variant = variant; return o; },
};

const chunks = new ChunkManager({ scene, world: null, RAPIER: null, path, terrain, signs });
let bad = 0;
const check = (label, pass, detail = '') => {
  if (!pass) bad++;
  console.log(`  [${pass ? ' ok ' : 'FAIL'}] ${label.padEnd(34)} ${detail}`);
};
console.log(`\nseed "${seed}" — road signs\n`);

const N = 60;
const placed = [];
const frame = path.frameAt(0);
path.ensureLength((N + 2) * CHUNK.length + 2000);
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const objects = [];
  chunks._buildSigns(i, i * CHUNK.length, (i + 1) * CHUNK.length, objects);
  for (const o of objects) placed.push({ i, o });
  if (process.env.LIST && objects.length) console.log(`  s=${i * CHUNK.length}  ${objects.map((o) => o.userData.variant.role).join(' ')}`);
}
const ms = (performance.now() - t0) / N;
const km = (N * CHUNK.length) / 1000;

const by = {};
for (const { o } of placed) by[o.userData.variant.role] = (by[o.userData.variant.role] || 0) + 1;
console.log(`  ${km.toFixed(1)} km: ${placed.length} signs — ${Object.entries(by).map(([r, n]) => `${r} ${n}`).join(', ')}\n`);
check('signs per km', placed.length / km >= 5 && placed.length / km <= 40, `${(placed.length / km).toFixed(1)}`);
check('several kinds', Object.keys(by).length >= 5, `${Object.keys(by).length} roles`);
check('placement cost', ms < 2, `${ms.toFixed(2)} ms/chunk`);

const EDGE = ROAD.halfWidth + ROAD.shoulder;
let onRoad = 0, wrongSide = 0, flat = 0, facing = 0, roadside = 0, off = 0, worst = 0;
const fwd = new THREE.Vector3();
for (const { o } of placed) {
  const v = o.userData.variant;
  if (v.role === 'portal') continue;
  const s = path.projectPoint(o.position, 0, 1e9, 1e9);
  path.frameAt(s, frame);
  const right = new THREE.Vector3().crossVectors(frame.tan, new THREE.Vector3(0, 1, 0)).normalize();
  const lat = new THREE.Vector3().subVectors(o.position, frame.pos).dot(right);
  const dy = o.position.y + SIGNS.sink - frame.pos.y;
  if (Math.abs(dy) > 1.5) off++;
  if (Math.abs(dy) > Math.abs(worst)) worst = dy;
  if (v.role === 'cantilever') continue;
  roadside++;
  if (Math.abs(lat) - 0.6 < EDGE) onRoad++;
  if (v.role === 'chevron' && Math.sign(lat) !== Math.sign(frame.curv)) wrongSide++;
  if (v.role === 'chevron' && Math.abs(frame.curv) < SIGNS.bendCurv * 0.8) flat++;
  // Local +z is the face: towards the player (-tan) on the right, either way on the left.
  fwd.set(0, 0, 1).applyEuler(o.rotation);
  if (lat > 0 && fwd.dot(frame.tan) > -0.9) facing++;
}
check('nothing on the carriageway', onRoad === 0, `${onRoad} of ${roadside} inside ${EDGE} m`);
check('foot level with the road', off === 0, `${off} more than 1.5 m off (ditch + bank), worst ${worst.toFixed(1)} m`);
check('chevrons on the outside', wrongSide === 0, `${wrongSide} on the inside`);
check('chevrons only on bends', flat === 0, `${flat} on straights`);
check('right verge faces the player', facing === 0, `${facing} turned away`);

const busiest = placed.reduce((m, p) => placed.filter((q) => q.i === p.i).length > placed.filter((q) => q.i === m).length ? p.i : m, 0);
const again = [];
chunks._buildSigns(busiest, busiest * CHUNK.length, (busiest + 1) * CHUNK.length, again);
const first = placed.filter((p) => p.i === busiest).map((p) => p.o);
check('deterministic', again.length > 0 && again.length === first.length &&
  again.every((o, k) => o.position.distanceTo(first[k].position) < 1e-9), `${again.length} signs in chunk ${busiest}, twice`);

console.log(bad ? `\n  ${bad} FAILED\n` : '\n  all ok\n');
process.exit(bad ? 1 : 0);
