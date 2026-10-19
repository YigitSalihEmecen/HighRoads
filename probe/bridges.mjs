/**
 * bridges.mjs — gaps across the road and the bridges over them (bridges.js, path.js:_planCrossing).
 *
 * How many and how varied, gap and valley bridges both; that the road is
 * straight and unbanked over every gap bridge; that the gap is open under the deck (no embankment) while the road
 * lands on solid ground at both ends; that the deck sits just under the
 * ribbon; that `groundAt` reads the deck on the shoulders; that no guardrail
 * runs onto a bridge; that the plan is a function of the seed alone; and what
 * a bridge's worst build step costs. LIST=1 prints each crossing.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import { WORLD, ROAD, CHUNK } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';

const seed = process.argv[2] || WORLD.seed;
const KM = Number(process.env.KM || 100);

function world() {
  const terrain = createTerrain(seed);
  const path = new RoadPath(terrain, seed);
  const chunks = new ChunkManager({ scene: new THREE.Scene(), world: null, RAPIER: null, path, terrain });
  path.ensureLength(KM * 1000 + 2500);
  chunks.field.sync();
  chunks.bridges.update(1e9, 1e9);
  return { path, chunks, B: chunks.bridges, field: chunks.field };
}

let bad = 0;
const check = (label, pass, detail = '') => {
  if (!pass) bad++;
  console.log(`  [${pass ? ' ok ' : 'FAIL'}] ${label.padEnd(38)} ${detail}`);
};
console.log(`\nseed "${seed}" — bridges over ${KM} km\n`);

const A = world();
const { path, chunks, B, field } = A;
const list = B.spans.filter((c) => c.s1 < KM * 1000);
const gaps = list.filter((c) => c.kind === 'gap'), valleys = list.filter((c) => c.kind === 'valley');
const f = path.frameAt(0);

let worstAt = null, worstStep = '';
let straight = 0, filled = 0, dry = 0, lift = [Infinity, -Infinity], shoulder = 0, buildMs = 0, maxTris = 0, rivers = 0;
const types = new Map(), noDeck = [];
for (const c of list) {
  // Straight and level from abutment to abutment.
  let worst = 0;
  for (let s = c.s0; s <= c.s1; s += 2) {
    path.frameAt(s, f);
    worst = Math.max(worst, Math.abs(f.curv), Math.abs(f.bank));
  }
  if (c.kind === 'gap' && worst > 1e-4) straight++;
  // The gap under the middle (a valley: the natural ground, no embankment), land at the ends.
  path.frameAt(c.sC, f);
  const smp = {};
  field.sample(f.pos.x, f.pos.z, smp);
  // (A valley's ground may sit UNDER natural: another pass of the road cutting by.)
  // Another pass of the road under or beside it (an overpass) fills as usual.
  const others = field._passes.slice(0, field._nPass).filter((p) => p.dense && p.d < 60).length - 1;
  if (c.kind === 'gap' ? f.pos.y - smp.y < c.depth * 0.5 : smp.y > smp.natural + 0.3 && !others) {
    filled++;
    if (process.env.WHY) console.log(`    filled ${c.kind} s ${c.s0.toFixed(0)}..${c.s1.toFixed(0)}: ground ${smp.y.toFixed(1)} natural ${smp.natural.toFixed(1)} road ${f.pos.y.toFixed(1)}`);
  }
  for (const [e, s] of [[1, c.s0 - 8], [2, c.s1 + 8]]) {
    if (c.clipped & e) continue;
    path.frameAt(s, f);
    const off = f.pos.y - field.height(f.pos.x, f.pos.z);
    // Another pass close by (the road crossing over itself) carves its own ground there.
    if (field._passes.slice(0, field._nPass).filter((p) => p.dense && p.d < 60).length > 1) continue;
    // Hanging is the fault; an abutment on a low embankment, or into a cutting, is how a bridge meets the land.
    if (off > 5) {
      dry++;
      if (process.env.WHY) console.log(`    end ${c.kind} s ${c.s0.toFixed(0)}..${c.s1.toFixed(0)} at ${s.toFixed(0)}: road ${off.toFixed(1)} m over ground`);
    }
  }
  // The shoulder over the gap reads the deck.
  path.frameAt(c.sC, f);
  const v = ROAD.halfWidth + 1;
  if (Math.abs(chunks.groundAt(c.sC, v).y - (f.pos.y + v * Math.tan(f.bank))) > 0.1) shoulder++;

  // The game runs the build a step a frame: the worst step is the hitch.
  const job = B._buildJob(c);
  let steps = 0;
  for (;;) {
    const t0 = performance.now();
    const done = job.next().done;
    const ms = performance.now() - t0;
    if (ms > buildMs) { buildMs = ms; worstStep = `${c.kind} ${c.design ? c.design.type : '?'} ${(2 * c.half).toFixed(0)} m, step ${steps}`; }
    steps++;
    if (done) break;
  }
  let tris = 0;
  c.object.traverse((m) => { if (m.isMesh) tris += m.geometry.index.count / 3; });
  maxTris = Math.max(maxTris, tris);
  if (c.object.children.some((m) => m.material === chunks.water.material)) rivers++;
  // The deck's surface, against the road at its station.
  const deckMat = B.mats[['stone', 'causeway'].includes(c.design.type) ? 'cobble' : c.design.type === 'wood' || c.design.trussMaterial === 'Timber' && c.design.type === 'truss' ? 'planks' : 'asphalt'];
  const deck = c.object.children.find((m) => m.material === deckMat);
  if (deck) {
    const p = deck.geometry.attributes.position, v = new THREE.Vector3();
    let top = -Infinity;
    for (let i = 0; i < p.count; i += 3) {
      v.fromBufferAttribute(p, i).add(c.object.position);
      // projectPoint snaps to the segment AFTER the nearest sample (up to a
      // sample off on a bend); two Newton steps along the flat tangent fix it.
      let s = path.projectPoint(v, c.sC, c.half + 20, c.half + 20);
      for (let it = 0; it < 2; it++) {
        path.frameAt(s, f);
        const h = Math.hypot(f.tan.x, f.tan.z);
        s += ((v.x - f.pos.x) * f.tan.x + (v.z - f.pos.z) * f.tan.z) / h;
      }
      if (s < c.s0 + 2 || s > c.s1 - 2) continue;
      path.frameAt(s, f);
      const lat = path.lateralOffset(v, s);
      if (Math.abs(lat) > ROAD.halfWidth + ROAD.shoulder + 2) continue;
      const dy = v.y - f.pos.y - lat * Math.tan(f.bank);
      if (dy > top) { top = dy; worstAt = [c.design.type, s.toFixed(1), lat.toFixed(2), dy.toFixed(3)]; }
    }
    if (top > -Infinity) lift = [Math.min(lift[0], top), Math.max(lift[1], top)];
    else noDeck.push(c.design.type);
  } else noDeck.push(c.design.type);
  const kind = c.design.type + (c.design.type === 'truss' ? `/${c.design.trussMaterial}` : '');
  types.set(kind, (types.get(kind) || 0) + 1);
  if (process.env.LIST) {
    const over = c.kind === 'gap' ? `gap ${c.span.toFixed(0).padStart(3)} × ${c.depth.toFixed(0).padStart(2)} m ${c.shapeName.padEnd(4)}${c.river ? ' river' : ''}`
      : `valley, ${c.depth.toFixed(0)} m high${c.curved ? ', curved' : ''}, hill ${c.hill.toFixed(2)}`;
    console.log(`    s≈${c.sC.toFixed(0).padStart(6)}  ${kind.padEnd(13)} L ${(2 * c.half).toFixed(0).padStart(4)} m, ${over}, ${Math.round(tris)} tris`);
  }
  B._drop(c);
}

const per10 = (gaps.length / KM) * 10;
check('gap crossings per 10 km', per10 >= 1 && per10 <= 4, per10.toFixed(1));
check('valley bridges', valleys.length > 0, `${valleys.length} (${((valleys.length / KM) * 10).toFixed(1)} per 10 km)`);
check('bridge kinds', types.size >= 4, [...types].map(([k, n]) => `${k} ${n}`).join(', '));
check('gap bridges straight and unbanked', straight === 0, `${straight} of ${gaps.length} bent`);
check('open under the deck, no embankment', filled === 0, `${filled} filled`);
check('land at both ends', dry === 0, `${dry} of ${list.length * 2} ends over 5 m above the ground (${list.filter((c) => c.clipped).length} cut short by a gap's run)`);
check('deck just under the ribbon', !noDeck.length && lift[0] > -0.12 && lift[1] < 0.035, `${lift[0].toFixed(3)}..${lift[1].toFixed(3)} m${noDeck.length ? `, no deck: ${noDeck}` : ''}${lift[1] >= 0.035 ? ` (${worstAt})` : ''}`);
check('shoulder reads the deck', shoulder === 0, `${shoulder}`);
check('build cost', buildMs < 60, `${buildMs.toFixed(0)} ms worst step (${worstStep}), ${Math.round(maxTris)} tris worst`);
check('rivers', rivers > 0, `${rivers} of ${gaps.filter((c) => c.river).length} planned`);

// No guardrail on a bridge: every chunk a bridge touches, its barrier vertices off the span.
let onDeck = 0;
for (const c of list.slice(0, 6)) {
  for (let i = Math.floor(c.s0 / CHUNK.length); i <= Math.floor(c.s1 / CHUNK.length); i++) {
    const s0 = i * CHUNK.length, origin = path.frameAt(s0).pos.clone();
    const objects = [];
    chunks._buildBarriers(s0, s0 + CHUNK.length, origin, objects, []);
    for (const m of objects) {
      const p = m.geometry.attributes.position, v = new THREE.Vector3();
      for (let k = 0; k < p.count; k += 7) {
        v.fromBufferAttribute(p, k).add(origin);
        const s = path.projectPoint(v, s0 + 60, 120, 120);
        if (s > c.s0 + 2 && s < c.s1 - 2) onDeck++;
      }
      m.geometry.dispose();
    }
  }
}
check('no guardrail on a bridge', onDeck === 0, `${onDeck} vertices`);

const sig = (w) => w.B.spans.map((c) => {
  w.B._build(c);
  const k = `${c.sC.toFixed(2)}:${c.design.type}:${c.design.spans}:${c.design.steelColor}`;
  w.B._drop(c);
  return k;
}).join('|');
check('deterministic', sig(A) === sig(world()));

console.log(bad ? `\n${bad} failing\n` : '\nall bridge checks pass\n');
process.exit(bad ? 1 : 0);
