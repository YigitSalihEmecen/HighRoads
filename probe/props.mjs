/**
 * props.mjs — measures the canopy and understorey.
 *
 * Reports triangle cost, float, ground contact and canopy gaps, and checks
 * the in-view total against the budget.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { WORLD, CHUNK, TREES, BUSHES } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';
import { TREE_FORMS, SHRUBS } from '../src/foliage.js';

const seed = process.argv[2] || WORLD.seed;
const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const scene = new THREE.Scene();
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });
const chunks = new ChunkManager({ scene, world, RAPIER, path, terrain });

let bad = 0;
const check = (label, pass, detail = '') => {
  if (!pass) bad++;
  console.log(`  [${pass ? ' ok ' : 'FAIL'}] ${label.padEnd(34)} ${detail}`);
};

console.log(`\nseed "${seed}" — canopy and understorey\n`);

// ---- the library ------------------------------------------------------------

const tri = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
const species = [...chunks.trees.library.keys()];
console.log('  species        near tris/variant      far tris/variant');
let worstBase = 0;
let worstTall = 0;
for (const name of species) {
  const variants = chunks.trees.library.get(name);
  const counts = variants.map((v) => tri(v.geometry));
  const cheap = chunks.trees.far.get(name);
  // Normalised: unit tall, standing exactly on y = 0.
  for (const v of variants) {
    v.geometry.computeBoundingBox();
    const bb = v.geometry.boundingBox;
    worstBase = Math.max(worstBase, Math.abs(bb.min.y));
    worstTall = Math.max(worstTall, Math.abs(bb.max.y - bb.min.y - 1));
  }
  console.log(`  ${name.padEnd(14)} ${counts.join(' / ').padEnd(22)} ` +
    `${cheap.map((v) => tri(v.geometry)).join(' / ')}`);
}
const shrubs = [...chunks.bushes.library.keys()];
console.log('\n  shrub          tris/variant');
for (const name of shrubs) {
  console.log(`  ${name.padEnd(14)} ${chunks.bushes.library.get(name).map((v) => tri(v.geometry)).join(' / ')}`);
}
console.log('');

check('every species has variants',
  species.length === Object.keys(TREE_FORMS).length &&
  species.every((n) => chunks.trees.library.get(n).length === TREES.variants),
  `${species.length} species x ${TREES.variants}`);
check('every shrub has variants',
  shrubs.length === Object.keys(SHRUBS).length &&
  shrubs.every((n) => chunks.bushes.library.get(n).length === BUSHES.variants),
  `${shrubs.length} shrubs x ${BUSHES.variants}`);
// A face wound the wrong way is not drawn (`side: FrontSide`), and a tree with
// all its faces wrong looks like one with transparent parts in it — `tube` and
// `tier` were both inside out and nothing else caught it. Signed volume: an
// inside-out conifer reads -0.043 where the same geometry reads +0.043.
const solidity = (geo) => {
  const p = geo.attributes.position.array;
  const n = geo.attributes.normal.array;
  let v = 0, flipped = 0;
  for (let o = 0; o < p.length; o += 9) {
    const ax = p[o], ay = p[o+1], az = p[o+2];
    const bx = p[o+3], by = p[o+4], bz = p[o+5];
    const cx = p[o+6], cy = p[o+7], cz = p[o+8];
    v += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) +
      az * (bx * cy - by * cx)) / 6;
    const ux = bx-ax, uy = by-ay, uz = bz-az, vx = cx-ax, vy = cy-ay, vz = cz-az;
    if ((uy*vz-uz*vy) * n[o] + (uz*vx-ux*vz) * n[o+1] + (ux*vy-uy*vx) * n[o+2] < 0) {
      flipped++;
    }
  }
  return { v, flipped };
};
// Winding is half the question; the hole test is the other. An edge used by one
// face rather than two is a rim; most rims are fine (a lump buried in a bigger
// one), so test whether the rim can be SEEN: fan rays off it and count the ones
// that reach open air. PARITY is the wrong test here — two interpenetrating
// solids cross both surfaces on the way out, so every rim inside an overlap
// would read as a hole.
const DIRS = [];
for (let i = 0; i < 24; i++) {
  const y = 1 - (i + 0.5) / 12;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const a = i * 2.39996;
  DIRS.push([Math.cos(a) * r, y, Math.sin(a) * r]);
}
const clear = (ox, oy, oz, dx, dy, dz, p) => {
  // Möller–Trumbore. Only "does it hit anything", so it returns on the first.
  for (let o = 0; o < p.length; o += 9) {
    const e1x = p[o+3]-p[o], e1y = p[o+4]-p[o+1], e1z = p[o+5]-p[o+2];
    const e2x = p[o+6]-p[o], e2y = p[o+7]-p[o+1], e2z = p[o+8]-p[o+2];
    const hx = dy*e2z-dz*e2y, hy = dz*e2x-dx*e2z, hz = dx*e2y-dy*e2x;
    const a = e1x*hx + e1y*hy + e1z*hz;
    if (a > -1e-12 && a < 1e-12) continue;
    const f = 1 / a;
    const sx = ox-p[o], sy = oy-p[o+1], sz = oz-p[o+2];
    const u = f * (sx*hx + sy*hy + sz*hz);
    if (u < 0 || u > 1) continue;
    const qx = sy*e1z-sz*e1y, qy = sz*e1x-sx*e1z, qz = sx*e1y-sy*e1x;
    const v = f * (dx*qx + dy*qy + dz*qz);
    if (v < 0 || u + v > 1) continue;
    if (f * (e2x*qx + e2y*qy + e2z*qz) > 1e-5) return false;
  }
  return true;
};
const Q = 1e6;
const seeThrough = (geo) => {
  const p = geo.attributes.position.array;
  const key = (o) => `${Math.round(p[o]*Q)},${Math.round(p[o+1]*Q)},${Math.round(p[o+2]*Q)}`;
  const edges = new Map();
  for (let o = 0; o < p.length; o += 9) {
    const k = [key(o), key(o + 3), key(o + 6)];
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3];
      const id = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(id, (edges.get(id) || 0) + 1);
    }
  }
  let holes = 0;
  for (const [id, n] of edges) {
    if (n === 2) continue;
    const [a, b] = id.split('|').map((t) => t.split(',').map(Number));
    const mx = (a[0]+b[0])/2/Q, my = (a[1]+b[1])/2/Q, mz = (a[2]+b[2])/2/Q;
    let escaped = 0;
    // Two, not one: a ray or two can graze a rim in the covering surface's plane.
    for (const d of DIRS) if (clear(mx, my, mz, d[0], d[1], d[2], p) && ++escaped > 1) break;
    if (escaped > 1) holes++;
  }
  return holes;
};

let worstVol = Infinity, flippedTotal = 0, worstVolName = '', holesTotal = 0;
for (const name of species) {
  for (const src of [chunks.trees.library, chunks.trees.far]) {
    for (const proto of src.get(name)) {
      const r = solidity(proto.geometry);
      if (r.v < worstVol) { worstVol = r.v; worstVolName = name; }
      flippedTotal += r.flipped;
      holesTotal += seeThrough(proto.geometry);
    }
  }
}
for (const name of shrubs) {
  for (const proto of chunks.bushes.library.get(name)) {
    const r = solidity(proto.geometry);
    if (r.v < worstVol) { worstVol = r.v; worstVolName = name; }
    flippedTotal += r.flipped;
    holesTotal += seeThrough(proto.geometry);
  }
}
check('every proto is wound outward', worstVol > 0,
  `thinnest ${worstVolName} encloses ${worstVol.toFixed(4)}`);
check('baked normals agree with the winding', flippedTotal === 0,
  `${flippedTotal} faces disagree`);
check('no proto has a see-through gap', holesTotal === 0,
  `${holesTotal} rims in open air`);
check('protos stand on y = 0', worstBase < 1e-4, `worst ${worstBase.toExponential(1)}`);
check('protos are unit tall', worstTall < 1e-4, `worst ${worstTall.toExponential(1)}`);
check('near mesh inside its budget', chunks.trees.trianglesPerTree <= 340,
  `mean ${chunks.trees.trianglesPerTree.toFixed(0)} tris/tree`);
// The far tier's per-species mean is not what binds: `dead` costs ~3x any
// other species out there (its skeleton is its silhouette) and is 1-3% of the
// trees placed. The weighted figure is measured once the scatter has run.
check('no far species is near-tier priced',
  species.every((n) => tri(chunks.trees.far.get(n)[0].geometry) <
    tri(chunks.trees.library.get(n)[0].geometry)),
  `dearest ${Math.max(...species.map((n) => tri(chunks.trees.far.get(n)[0].geometry)))} tris`);
// The tiers must be the SAME TREE or the cross-fade is a visible size change.
let worstLod = 0;
for (const n of species) {
  const a = chunks.trees.library.get(n), b = chunks.trees.far.get(n);
  for (let v = 0; v < a.length; v++) {
    worstLod = Math.max(worstLod, Math.abs(b[v].radius / a[v].radius - 1));
  }
}
check('the two tiers are the same tree', worstLod < 0.18,
  `worst crown radius mismatch ${(worstLod * 100).toFixed(0)}%`);
// 95, not 40: a shrub is a rounded dome now, not four alpha cards, and the main
// lump has to be `detail: 1` or it reads as granite — see `env/bushes.js`.
check('shrubs are cheap', chunks.bushes.trianglesPerBush <= 145,
  `mean ${chunks.bushes.trianglesPerBush.toFixed(0)} tris/bush`);

// ---- determinism ------------------------------------------------------------

const again = new ChunkManager({ scene: new THREE.Scene(), world, RAPIER, path, terrain });
let drift = 0;
for (const name of species) {
  const a = chunks.trees.library.get(name)[0].geometry.attributes.position.array;
  const b = again.trees.library.get(name)[0].geometry.attributes.position.array;
  if (a.length !== b.length) { drift = Infinity; break; }
  for (let i = 0; i < a.length; i++) drift = Math.max(drift, Math.abs(a[i] - b[i]));
}
check('the library is deterministic', drift === 0, `worst vertex drift ${drift}`);
again.dispose();

// ---- the scatter ------------------------------------------------------------

path.ensureLength(3000);
for (let i = 0; i < 24; i++) chunks._build(i);
world.step();
const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

const m = new THREE.Matrix4(), pos = new THREE.Vector3();
const q = new THREE.Quaternion(), sc = new THREE.Vector3();
let nearN = 0, farN = 0, bushN = 0, batches = 0, missed = 0;
let nearTris = 0, farTris = 0, bushTris = 0;
let closest = Infinity;
const floats = [];
const perChunk = [];
let scatterMs = 0;

// Perpendicular distance to the centreline. NOT `lateralOffset` minimised over
// `s`: that collapses toward zero for a point ahead of the station it is handed.
const toRoad = (wp, s0, s1) => {
  let best = Infinity;
  for (let s = s0 - 80; s <= s1 + 80; s += 2) {
    const f = path.frameAt(s);
    const d = Math.hypot(wp.x - f.pos.x, wp.z - f.pos.z);
    if (d < best) best = d;
  }
  return best;
};

const measure = (mesh, origin, s0, s1) => {
  for (let k = 0; k < mesh.count; k++) {
    mesh.getMatrixAt(k, m);
    m.decompose(pos, q, sc);
    const wp = pos.clone().add(origin);
    // Project at the instance's own station, not the chunk midpoint: a hint 60 m
    // out reports a lateral 60 m of curvature wrong.
    const best = toRoad(wp, s0, s1);
    if (best < closest) closest = best;

    ray.origin = { x: wp.x, y: wp.y + 60, z: wp.z };
    const hit = world.castRay(ray, 200, true);
    if (!hit) { missed++; continue; }
    floats.push(Math.abs(wp.y + 60 - (hit.timeOfImpact ?? hit.toi) - wp.y));
  }
};

for (let i = 2; i < 20; i++) {
  const s0 = i * CHUNK.length, s1 = s0 + CHUNK.length;
  const chunk = chunks.chunks.get(i);
  const origin = chunk.origin;
  // Chunk-lifetime tier (far trees and shrubs). Timed on its own — the
  // verification below rays every instance and costs far more than the scatter.
  const t0 = performance.now();
  const objs = chunks._buildProps(i, s0, s1, origin);
  scatterMs += performance.now() - t0;
  for (const mesh of objs) {
    batches++;
    const t = tri(mesh.geometry) * mesh.count;
    if (mesh.material === chunks.trees.farMaterial) {
      farN += mesh.count; farTris += t;
    } else { bushN += mesh.count; bushTris += t; }
    measure(mesh, origin, s0, s1);
  }
  // Car-relative tier: the grown canopy, whose recipe `_buildProps` cached.
  let n = 0;
  for (const spec of chunk.canopySpec || []) {
    batches++;
    n += spec.matrices.length;
    nearN += spec.matrices.length;
    nearTris += tri(spec.geometry) * spec.matrices.length;
    for (const mat of spec.matrices) {
      mat.decompose(pos, q, sc);
      const wp = pos.clone().add(origin);
      const best = toRoad(wp, s0, s1);
      if (best < closest) closest = best;
      ray.origin = { x: wp.x, y: wp.y + 60, z: wp.z };
      const hit = world.castRay(ray, 200, true);
      if (!hit) { missed++; continue; }
      floats.push(Math.abs(wp.y + 60 - (hit.timeOfImpact ?? hit.toi) - wp.y));
    }
  }
  perChunk.push(n);
}
const ms = scatterMs / 18;

const mean = perChunk.reduce((a, b) => a + b, 0) / perChunk.length;
const sd = Math.sqrt(perChunk.reduce((a, b) => a + (b - mean) ** 2, 0) / perChunk.length);
floats.sort((a, b) => a - b);
const p99 = floats.length ? floats[Math.floor(floats.length * 0.99)] : 0;
const fmean = floats.reduce((a, b) => a + b, 0) / (floats.length || 1);

console.log('');
check('trees placed', nearN > 0,
  `${nearN} near (${Math.min(...perChunk)}..${Math.max(...perChunk)} per chunk), ` +
  `${farN} far, ${bushN} shrubs`);
check('per-chunk cap held', Math.max(...perChunk) <= TREES.nearCap,
  `max ${Math.max(...perChunk)} of ${TREES.nearCap}`);
check('draw batches per chunk', batches / 18 <= TREES.picks * 2 + BUSHES.picks,
  `${(batches / 18).toFixed(1)} of ${TREES.picks * 2 + BUSHES.picks}`);
console.log(`         of which ${(TREES.picks + BUSHES.picks)} live with the chunk ` +
  `and ${TREES.picks} come and go with the car`);
check('scatter cost', ms < 25, `${ms.toFixed(1)} ms per chunk`);
check('nothing on the carriageway', closest >= CHUNK.plantClear - 0.5,
  `closest ${closest.toFixed(1)} m, clear ${CHUNK.plantClear} m`);
check('mean float off the collider', fmean < 0.05, `${(fmean * 1000).toFixed(1)} mm`);
check('p99 float off the collider', p99 < 0.25,
  `${(p99 * 1000).toFixed(0)} mm (${missed} rays missed)`);
// A clustered scatter is LUMPY; a uniform one is not, and that is the failure
// this catches — a CV near zero means the field and the clusters stopped doing
// anything and the woods went back to being a wash.
check('the scatter is not uniform', sd / Math.max(1, mean) > 0.25,
  `spread ${(sd / Math.max(1, mean) * 100).toFixed(0)}% of mean ${mean.toFixed(0)}`);

// Two windows, because there are two lifetimes: the grown canopy lives across
// `TREES.behind+ahead+1` chunks; far trees and shrubs across the chunk window.
const chunkWin = CHUNK.behind + CHUNK.ahead + 1;
const canopyWin = TREES.behind + TREES.ahead + 1;
// Both windows shrank with the fog wall, so the in-view tri count came down;
// 500,000 is what the real number lands inside.
const inView = Math.round(nearTris * canopyWin / 18) +
  Math.round((farTris + bushTris) * chunkWin / 18);
console.log(`\n  per chunk: ${Math.round(nearTris / 18).toLocaleString()} near · ` +
  `${Math.round(farTris / 18).toLocaleString()} far · ` +
  `${Math.round(bushTris / 18).toLocaleString()} shrub`);
console.log(`  alive at once: ${Math.round(nearTris * canopyWin / 18).toLocaleString()} near ` +
  `(${canopyWin} chunks) + ${Math.round((farTris + bushTris) * chunkWin / 18).toLocaleString()} ` +
  `far and shrub (${chunkWin} chunks)`);
// What a far tree costs AVERAGED OVER THE ONES ACTUALLY PLACED, which is the
// figure the budget is built from — see the library check above.
check('far tier inside its budget', farTris / Math.max(1, farN) <= 90,
  `${(farTris / Math.max(1, farN)).toFixed(0)} tris per placed far tree`);
check('foliage inside its budget', inView <= 500000,
  `${inView.toLocaleString()} triangles, budget 500,000 (terrain sheet ~109,000)`);

console.log(`\n  [${bad ? 'FAIL' : ' ok '}] foliage\n`);
process.exit(bad ? 1 : 0);
