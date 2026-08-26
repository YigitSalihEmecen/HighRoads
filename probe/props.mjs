/**
 * The canopy and the understorey: what it costs, where it lands, and whether it
 * is sitting on the ground.
 *
 * It used to load OBJ models off disk and SKIP when the trees were switched
 * off, which they were, for the whole life of the file. There are no models any
 * more — `env/trees.js` grows every geometry at boot — so this now runs the
 * real thing, and the questions it has to answer changed with it:
 *
 *   THE TRIANGLE BUDGET is the reason trees were off. It is arithmetic and it
 *   is checked here, per species and in total, against the terrain sheet it has
 *   to share a frame with.
 *   DRAW CALLS are the binding constraint on how many species a chunk may show,
 *   so the batch count per chunk is checked against what the config promises.
 *   FLOAT is the old question and still the right one: props are placed on the
 *   DRAWN surface, and a ray onto the collider is the only way to know they
 *   are.
 *   THE FIELD is the new question. A scatter that places the right number of
 *   trees uniformly has failed at the thing it was rewritten to do, so the
 *   variance across chunks is measured — a clustered scatter is lumpy by
 *   construction and a uniform one is not.
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
  // Normalised: unit tall, standing exactly on y = 0. Placement multiplies by a
  // height in metres and knows nothing about the archetype.
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
check('protos stand on y = 0', worstBase < 1e-4, `worst ${worstBase.toExponential(1)}`);
check('protos are unit tall', worstTall < 1e-4, `worst ${worstTall.toExponential(1)}`);
check('near mesh inside its budget', chunks.trees.trianglesPerTree <= 340,
  `mean ${chunks.trees.trianglesPerTree.toFixed(0)} tris/tree`);
// The far tier is the same builder at a lower subdivision, so the question is
// not its ratio to the near tier — it is what one costs, because five times as
// many of them are alive over nine chunks instead of seven.
check('far tier inside its budget', chunks.trees.trianglesPerFarTree <= 70,
  `mean ${chunks.trees.trianglesPerFarTree.toFixed(0)} tris/tree, ` +
  `1:${(chunks.trees.trianglesPerTree / chunks.trees.trianglesPerFarTree).toFixed(1)} vs near`);
// The two tiers have to be the SAME TREE or the cross-fade is a visible change
// of size — the complaint the whole rewrite answers. Same seed, same envelope,
// so the crown radii should agree to a few per cent.
let worstLod = 0;
for (const n of species) {
  const a = chunks.trees.library.get(n), b = chunks.trees.far.get(n);
  for (let v = 0; v < a.length; v++) {
    worstLod = Math.max(worstLod, Math.abs(b[v].radius / a[v].radius - 1));
  }
}
check('the two tiers are the same tree', worstLod < 0.18,
  `worst crown radius mismatch ${(worstLod * 100).toFixed(0)}%`);
// 95, not 40. A shrub is a rounded dome now rather than four alpha cards, and
// the main lump has to be `detail: 1` or it reads as a chunk of granite — see
// `env/bushes.js`. `BUSHES.cap` came down from 450 to 150 to pay for it, so the
// per-chunk cost is roughly what the cards cost.
check('shrubs are cheap', chunks.bushes.trianglesPerBush <= 95,
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

/**
 * Perpendicular distance from a world point to the centreline, metres.
 *
 * NOT `path.lateralOffset` minimised over `s`, which is what this did first and
 * which reports nonsense: `lateralOffset` is the dot with the `right` axis at
 * the station it is handed, so for a point sixty metres ahead there is always
 * some station where `right` is nearly perpendicular to the offset and the dot
 * collapses to zero. It read 0.1 m for trees a hundred metres off the road.
 */
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
    // Project against the station the instance is actually at, not the chunk
    // midpoint: `lateralOffset` takes the frame at the `s` it is handed, and
    // a hint 60 m out reports a lateral that is 60 m of road curvature wrong.
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
  // Chunk-lifetime tier: far trees and shrubs, built and returned directly.
  // Timed on its own: the verification below rays every instance and walks the
  // centreline to measure clearance, which costs far more than the scatter.
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
// A clustered scatter is LUMPY. A uniform one is not, and that is the failure
// this catches: a coefficient of variation near zero means the field and the
// clusters stopped doing anything and the woods went back to being a wash.
check('the scatter is not uniform', sd / Math.max(1, mean) > 0.25,
  `spread ${(sd / Math.max(1, mean) * 100).toFixed(0)}% of mean ${mean.toFixed(0)}`);

// Two windows, because there are two lifetimes. The grown canopy is alive for
// `TREES.behind + ahead + 1` chunks; the far trees and shrubs for the chunk
// window itself.
const chunkWin = CHUNK.behind + CHUNK.ahead + 1;
const canopyWin = TREES.behind + TREES.ahead + 1;
// The grown-canonical window and the chunk window both shrank with the fog
// wall (ahead 6→4 / 4 chunks = 480 m), so the in-view tri count came back
// down from the 2× experiment. 500,000 is the budget that real number lands
// inside, not a looser target for the old one.
const inView = Math.round(nearTris * canopyWin / 18) +
  Math.round((farTris + bushTris) * chunkWin / 18);
console.log(`\n  per chunk: ${Math.round(nearTris / 18).toLocaleString()} near · ` +
  `${Math.round(farTris / 18).toLocaleString()} far · ` +
  `${Math.round(bushTris / 18).toLocaleString()} shrub`);
console.log(`  alive at once: ${Math.round(nearTris * canopyWin / 18).toLocaleString()} near ` +
  `(${canopyWin} chunks) + ${Math.round((farTris + bushTris) * chunkWin / 18).toLocaleString()} ` +
  `far and shrub (${chunkWin} chunks)`);
check('foliage inside its budget', inView <= 500000,
  `${inView.toLocaleString()} triangles, budget 500,000 (terrain sheet ~109,000)`);

console.log(`\n  [${bad ? 'FAIL' : ' ok '}] foliage\n`);
process.exit(bad ? 1 : 0);
