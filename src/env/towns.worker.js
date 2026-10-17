/**
 * env/towns.worker.js — settlements built by City-gen (`city_gen/`, a
 * submodule, consumed through its plain-ESM bundle `lib/citygen.js`, which
 * needs neither three nor the DOM — so it runs here, off the main thread).
 *
 * `towns.js` decides every lot (where, how high, which way it faces) and posts
 * the plan; this builds each level of detail into City-gen's merged buffers
 * and hands them back packed: normals in bytes, colours in shorts, emission
 * in a byte. A city is ~200k triangles; packed, ~9 MB instead of 17.
 *
 * Imported directly (not as a worker) by `towns.js` where there is no Worker
 * — the probes — so `buildTown` is the whole contract.
 */
import {
  Builder, color, generateLot, generateLandmark, generateBlock, layoutCity, buildRoads, CURB,
} from '../../city_gen/lib/citygen.js';

const FOOTING = color('#A39B8E');
const POLE = color('#3B3D3F');
const LAMP = color('#F6E7C8');

/** Every level of detail of one settlement; see `towns.js:_request` for `msg`. */
export function buildTown(msg) {
  if (msg.kind === 'city') return [city(msg)];
  return msg.details.map((detail) => village(msg, detail));
}

function village(m, detail) {
  const b = new Builder();
  for (const lot of m.lots) {
    footing(b, lot);
    generateLot(b, lot, { detail, heightScale: 1 });
  }
  if (m.church) {
    const c = m.church;
    footing(b, c);
    b.setFrame(c.x, c.z, c.angle, c.y + CURB);
    generateLandmark(b, { kind: 'church', seed: c.seed, width: c.w - 4, depth: c.d - 4, detail });
  }
  for (const [x, y, z] of m.lamps) {
    b.setFrame(x, z, 0, y);
    b.prism(b.solid, 0, -0.4, 0, 0.09, 6.6, 5, POLE);
    b.box(b.glass, -0.24, 6.2, -0.24, 0.24, 6.45, 0.24, LAMP, 1);
  }
  return pack(b);
}

/** A lot on a slope stands on a stone footing down to its lowest corner. */
function footing(b, lot) {
  b.setFrame(lot.x, lot.z, lot.angle, lot.y);
  b.box(b.solid, -lot.w / 2, -lot.drop, -lot.d / 2, lot.w / 2, CURB, lot.d / 2, FOOTING);
}

function city(m) {
  const layout = layoutCity({
    size: m.size, seed: m.seed, blockMin: 55, blockMax: 120, parks: 0.12,
    density: m.density, district: 'auto', landmarks: true,
  });
  const b = new Builder();
  for (const j of layout.blocks) {
    generateBlock(b, {
      width: j.w, depth: j.d, seed: j.seed, detail: 0, district: j.district,
      heightScale: j.heightScale, park: j.park, landmark: j.landmark,
    }, j.x, j.z);
  }
  buildRoads(b, layout, 0);
  return pack(b);
}

function pack(b) {
  return { solid: packPart(b.solid), glass: packPart(b.glass) };
}

function packPart(p) {
  const n = p.pos.length / 3;
  if (!n) return null;
  const nor = new Int8Array(n * 3);
  const col = new Uint16Array(n * 3);
  const emit = new Uint8Array(n);
  for (let i = 0; i < n * 3; i++) {
    nor[i] = Math.round(p.nor[i] * 127);
    col[i] = Math.round(Math.min(Math.max(p.col[i], 0), 1) * 65535);
  }
  for (let i = 0; i < n; i++) emit[i] = Math.round(Math.min(p.emit[i], 2) * 127.5);
  return {
    pos: new Float32Array(p.pos), nor, col, emit,
    idx: n > 65535 ? new Uint32Array(p.idx) : new Uint16Array(p.idx),
  };
}

const transfers = (levels) => levels.flatMap((L) => [L.solid, L.glass])
  .filter(Boolean).flatMap((P) => [P.pos.buffer, P.nor.buffer, P.col.buffer, P.emit.buffer, P.idx.buffer]);

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = ({ data }) => {
    let levels = null;
    try { levels = buildTown(data); } catch (err) { console.warn('[towns] build failed:', err); }
    self.postMessage({ id: data.id, levels }, levels ? transfers(levels) : []);
  };
}
