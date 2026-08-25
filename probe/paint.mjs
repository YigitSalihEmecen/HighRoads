/**
 * Both paint slots, on every car in the roster.
 *
 * `assets.js` splits the bodywork by ATLAS CELL: the largest flat colour is the
 * car's paint, the next largest is its second colour. Nothing about that is
 * declared anywhere — it is discovered from the geometry at load — so a model
 * that happens to use one cell for almost everything, or an atlas whose cells
 * stop lining up with the 16x16 grid, would silently produce a car with a
 * second colour control that does nothing at all. There is no visual signal
 * when that happens: the swatch highlights, and the car does not change.
 *
 * So this counts the triangles that actually landed in each slot.
 */
// FBXLoader reaches for the DOM to build texture images; same stub the other
// probes use, hoisted so it is in place before three is imported.
globalThis.document = {
  createElement: (t) => ({
    tagName: t, style: {}, setAttribute() {}, getContext: () => null,
    addEventListener(e, c) { if (e === 'load') setTimeout(c, 0); },
    removeEventListener() {}, set src(v) {}, get src() { return ''; },
  }),
  createElementNS: (n, t) => globalThis.document.createElement(t),
};
globalThis.self = globalThis;
import fs from 'node:fs';
import { CARS } from '../src/cars.js';
import { buildCarFromObject } from '../src/assets.js';

const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
const loader = new FBXLoader();

/** Slot indices, mirroring assets.js. */
const SLOT = { body: 0, paint: 1, trim: 2, head: 3, tail: 4 };
const NAMES = ['body', 'paint', 'trim', 'head', 'tail'];

let bad = 0;
const check = (label, pass, detail = '') => {
  if (!pass) bad++;
  console.log(`  [${pass ? ' ok ' : 'FAIL'}] ${label.padEnd(34)} ${detail}`);
};

console.log('  triangles landing in each material slot, per car:\n');
console.log(`  ${'car'.padEnd(11)}${NAMES.map((n) => n.padStart(8)).join('')}   paint / trim share`);

for (const spec of CARS) {
  const buf = fs.readFileSync(`assets/car_models/Fbx/${spec.file}`);
  const root = loader.parse(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  // No texture in Node, so the stock trim colour cannot be sampled here; the
  // split itself does not depend on it.
  const model = buildCarFromObject(root, null, spec.file);

  const tris = new Array(NAMES.length).fill(0);
  model.body.traverse((o) => {
    if (!o.isMesh) return;
    for (const g of o.geometry.groups) {
      const i = g.materialIndex || 0;
      if (i < tris.length) tris[i] += g.count / 3;
    }
  });
  const total = tris.reduce((a, b) => a + b, 0) || 1;
  console.log(`  ${spec.id.padEnd(11)}${tris.map((t) => String(t).padStart(8)).join('')}` +
    `   ${((100 * tris[SLOT.paint]) / total).toFixed(0)}% / ${((100 * tris[SLOT.trim]) / total).toFixed(0)}%`);

  spec._tris = tris;
  spec._total = total;
}

console.log('');
for (const spec of CARS) {
  const t = spec._tris;
  check(`${spec.id}: paint slot is populated`, t[SLOT.paint] > 0, `${t[SLOT.paint]} tris`);
  check(`${spec.id}: second colour is populated`, t[SLOT.trim] > 0, `${t[SLOT.trim]} tris`);
  // Both lamp pairs must survive the extra slot's renumbering — getting the
  // slot indices out of step would light the bodywork instead of the lamps.
  check(`${spec.id}: both lamp pairs found`, t[SLOT.head] > 0 && t[SLOT.tail] > 0,
    `${t[SLOT.head]} front, ${t[SLOT.tail]} rear`);
}

console.log(`\n  [${bad ? 'FAIL' : ' ok '}] ${CARS.length} cars checked` + (bad ? `  — ${bad} problem(s)` : ''));
process.exit(bad ? 1 : 0);
