/**
 * towns.js — settlements along the road, built by City-gen (`city_gen/`).
 *
 * The road is cut into `TOWNS.slot`-metre slots and each slot rolls, from the
 * seed alone, one of: nothing, a HAMLET (a few houses lining one side), a
 * VILLAGE (both sides — the road is its high street — maybe a second row
 * behind a lane, maybe a church, street lamps), or a CITY, a whole City-gen
 * layout far off on the horizon. A roll that finds no room (a bend, land
 * standing far off the road, a lake, another road) is simply nothing.
 *
 * Settlements need flat ground, and the ground is a pure function of position
 * (terrainfield.js), so a settlement is a term in that function: `carve()`
 * pulls the natural surface to the road's level beside a village, or to one
 * level under a city, blending back over `blend`. The plan is made when the
 * road is generated, before the tiles there are built; anything already built
 * is rebuilt (`onChange`). `clear()` is how much of a place a settlement owns,
 * and the vegetation field (foliage.js) plants nothing there.
 *
 * Lots are decided here (they need the road and the levelled ground); the
 * buildings are generated in a worker (`env/towns.worker.js`) and come back as
 * merged, vertex-coloured buffers: two draw calls per level of detail. A
 * village is a THREE.LOD — City-gen detail `TOWNS.detail[0]` near, `[1]` past
 * `lodDistance`. Windows and lamps glow at night (`setNight`).
 *
 * No colliders, like the trees.
 */
import * as THREE from 'three';
import { TOWNS, ROAD, TILES } from './config.js';
import { smoothstep, hashInt, mulberry32 } from './util.js';
import { STYLE } from '../city_gen/lib/citygen.js';
import { buildTown } from './env/towns.worker.js';

const EDGE = ROAD.halfWidth + ROAD.shoulder;
/** Spatial index cell for `carve`/`clear`, metres. */
const CELL = 512;
/** Village centreline sample spacing, metres. */
const STEP = 8;
/** A church's lot along and across the road. */
const CHURCH = [36, 50];
/** A city's ground sits this far under its asphalt: 5 cm z-fights 700 m away. */
const CITY_SINK = 0.6;

/** City-gen styles by biome: the open edge of a settlement, and its centre (terraces). */
const MIX = {
  warm: { edge: [['mediterranean', 4], ['suburban', 1]], centre: [['mediterranean', 3], ['haussmann', 1]] },
  cold: { edge: [['tudor', 3], ['suburban', 2]], centre: [['tudor', 2], ['victorian', 1]] },
  mild: { edge: [['suburban', 4], ['tudor', 1.5], ['victorian', 1]], centre: [['victorian', 2], ['haussmann', 1.2], ['tudor', 1]] },
};
const CLIMATE = { mediterranean: 'warm', savanna: 'warm', alpine: 'cold', boreal: 'cold', birchwood: 'cold' };

const range = (rng, [a, b]) => a + (b - a) * rng();
function weighted(rng, items) {
  let total = 0;
  for (const [, w] of items) total += w;
  let x = rng() * total;
  for (const [v, w] of items) if ((x -= w) <= 0) return v;
  return items[items.length - 1][0];
}

export class Towns {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {import('./path.js').RoadPath} o.path
   * @param {import('./terrainfield.js').TerrainField} o.field
   * @param {object} o.terrain noise.js terrain
   * @param {object|null} o.biomes biomes.js sampler
   * @param {(x0, z0, x1, z1) => void} o.onChange the ground changed in this box
   */
  constructor({ scene, path, field, terrain, biomes = null, onChange = () => {} }) {
    this.scene = scene;
    this.path = path;
    this.field = field;
    this.terrain = terrain;
    this.biomes = biomes;
    this.onChange = onChange;
    this.seed = field.seed >>> 0;
    /** Every settlement planned so far, in road order. Plans are tiny and kept: the ground depends on them. */
    this.list = [];
    this.next = 1;               // slot 0 is the title screen's road
    this._cells = new Map();
    this._cellKey = null;
    this._cellList = null;
    this._line = { v: 0, st: 0, y: 0 };
    this._frame = null;
    this._grown = [];
    field.onGrow.push((x0, z0, x1, z1) => this._grown.push([x0, z0, x1, z1]));

    this.night = { value: 0 };
    this.solid = this._material({ roughness: 0.88, metalness: 0, side: THREE.DoubleSide, shadowSide: THREE.BackSide });
    this.glass = this._material({ roughness: 0.18, metalness: 0.35, polygonOffset: true, polygonOffsetFactor: -1 });

    this._jobs = new Map();
    this._id = 0;
    this.worker = null;
    if (typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./env/towns.worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = ({ data }) => {
          const t = this._jobs.get(data.id);
          this._jobs.delete(data.id);
          if (t) this._apply(t, data.levels);
        };
        // A worker that cannot start builds nothing: build here instead.
        this.worker.onerror = (err) => {
          console.warn('[towns] worker failed, building on the main thread:', err.message);
          this.worker = null;
          for (const t of this._jobs.values()) t.pending = false;
          this._jobs.clear();
        };
      } catch (err) { this.worker = null; }
    }
  }

  // ------------------------------------------------------------- the field --

  /** The natural ground at (x, z) with every settlement's levelling applied. */
  carve(x, z, y) {
    const list = this._at(x, z);
    if (!list) return y;
    for (let n = 0; n < list.length; n++) {
      const t = list[n];
      const B = t.box;
      if (x < B[0] || z < B[1] || x > B[2] || z > B[3]) continue;
      if (t.kind === 'city') {
        const m = 1 - smoothstep(0, t.blend, this._cityOut(t, x, z));
        y += (t.level - CITY_SINK - y) * m;
      } else {
        const L = this._nearest(t, x, z);
        const m = this._band(t, L, TOWNS.blend);
        y += (L.y - 0.25 - y) * m;
      }
    }
    return y;
  }

  /** How much of (x, z) a settlement occupies, 0..1: nothing grows where it is 1. */
  clear(x, z) {
    const list = this._at(x, z);
    if (!list) return 0;
    let c = 0;
    for (let n = 0; n < list.length; n++) {
      const t = list[n];
      const B = t.box;
      if (x < B[0] || z < B[1] || x > B[2] || z > B[3]) continue;
      const k = t.kind === 'city'
        ? 1 - smoothstep(0, 25, this._cityOut(t, x, z))
        : this._band(t, this._nearest(t, x, z), 6);
      if (k > c) c = k;
    }
    return c;
  }

  _at(x, z) {
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    const k = ci * 73856093 ^ cj * 19349663;
    if (k !== this._cellKey) {
      this._cellKey = k;
      this._cellList = this._cells.get(k) || null;
    }
    return this._cellList;
  }

  /** Distance outside a city's square, metres (0 inside). */
  _cityOut(t, x, z) {
    const dx = x - t.cx, dz = z - t.cz;
    const lx = dx * t.cos - dz * t.sin, lz = dx * t.sin + dz * t.cos;
    return Math.hypot(Math.max(Math.abs(lx) - t.hs, 0), Math.max(Math.abs(lz) - t.hs, 0));
  }

  /** A village's own claim on a point already projected onto its centreline. */
  _band(t, L, wide) {
    const W = L.v >= 0 ? t.W[1] : t.W[0];
    if (W <= 0) return 0;
    return (1 - smoothstep(W, W + wide, Math.abs(L.v))) *
      smoothstep(0, t.pad, L.st) * smoothstep(0, t.pad, t.len - L.st);
  }

  /** Nearest point of a village's centreline: signed offset `v`, station `st`, road height `y`. */
  _nearest(t, x, z) {
    const P = t.pts, n = P.length / 3;
    let best = Infinity, bi = 0, bu = 0;
    for (let i = 0; i < n - 1; i++) {
      const ax = P[i * 3], az = P[i * 3 + 1];
      const ex = P[i * 3 + 3] - ax, ez = P[i * 3 + 4] - az;
      let u = ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez);
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const dx = x - ax - ex * u, dz = z - az - ez * u;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; bi = i; bu = u; }
    }
    const ax = P[bi * 3], az = P[bi * 3 + 1];
    const ex = P[bi * 3 + 3] - ax, ez = P[bi * 3 + 4] - az;
    const len = Math.hypot(ex, ez);
    const L = this._line;
    // Right = (−tan.z, tan.x), as everywhere in the field.
    L.v = ((x - ax) * -ez + (z - az) * ex) / len;
    L.st = (bi + bu) * STEP;
    L.y = P[bi * 3 + 2] + (P[bi * 3 + 5] - P[bi * 3 + 2]) * bu;
    return L;
  }

  _register(t) {
    const B = t.box;
    for (let ci = Math.floor(B[0] / CELL); ci <= Math.floor(B[2] / CELL); ci++) {
      for (let cj = Math.floor(B[1] / CELL); cj <= Math.floor(B[3] / CELL); cj++) {
        const k = ci * 73856093 ^ cj * 19349663;
        let cell = this._cells.get(k);
        if (!cell) { cell = []; this._cells.set(k, cell); }
        cell.push(t);
      }
    }
    this._cellKey = null;
    this.list.push(t);
    this.onChange(B[0], B[1], B[2], B[3]);
  }

  _unregister(t) {
    for (const cell of this._cells.values()) {
      const i = cell.indexOf(t);
      if (i >= 0) cell.splice(i, 1);
    }
    this._cellKey = null;
    this.list.splice(this.list.indexOf(t), 1);
    this._drop(t);
    t.dead = true;
    this.onChange(t.box[0], t.box[1], t.box[2], t.box[3]);
  }

  // -------------------------------------------------------------- planning --

  _frameAt(s) {
    if (!this._frame) {
      this._frame = {
        pos: new THREE.Vector3(), tan: new THREE.Vector3(), right: new THREE.Vector3(),
        up: new THREE.Vector3(), bank: 0, curv: 0, foldL: 0, foldR: 0,
        relaxDev: 0, relaxL: 0, relaxR: 0, s: 0,
      };
    }
    return this.path.frameAt(s, this._frame);
  }

  /** Plans every slot the generated road now covers, with room to look past it. */
  plan() {
    const path = this.path;
    if (path.framedUpTo < 1) return;
    const sEnd = path.pts[path.framedUpTo].s;
    while ((this.next + 1) * TOWNS.slot + 400 < sEnd) this._planSlot(this.next++);
  }

  _planSlot(k) {
    const rng = mulberry32(hashInt(this.seed * 31 + k * 7919));
    const kind = weighted(rng, Object.entries(TOWNS.mix));
    if (kind === 'city') this._planCity(k, rng);
    else if (kind !== 'none') this._planVillage(k, rng, kind);
  }

  _planVillage(k, rng, kind) {
    const len = range(rng, kind === 'hamlet' ? TOWNS.hamletLength : TOWNS.villageLength);
    const pad = TOWNS.blend + 10;
    for (let attempt = 0; attempt < 6; attempt++) {
      const sc = k * TOWNS.slot + pad + len / 2 + rng() * (TOWNS.slot - len - pad * 2);
      const s0 = sc - len / 2, s1 = sc + len / 2;
      if (!this._straight(s0 - 40, s1 + 40)) continue;
      const relief = [-1, 1].map((side) => this._relief(s0, s1, side));
      const fits = [-1, 1].filter((side, i) => relief[i] <= TOWNS.maxRelief);
      if (!fits.length) continue;
      // A road along a hillside rarely has level land both sides: a village
      // takes the steeper side too, within reason, one row deep (`steep`).
      const other = -fits[0];
      const both = kind === 'village' && (fits.length === 2 || relief[other > 0 ? 1 : 0] <= TOWNS.maxRelief * 1.6);
      const sides = both ? [-1, 1] : [fits[Math.floor(rng() * fits.length)]];
      const steep = both && fits.length === 1 ? other : 0;
      this._layVillage({ kind, k, rng, sc, s0, s1, pad, sides, steep });
      return;
    }
  }

  _straight(s0, s1) {
    for (let s = s0; s <= s1; s += 10) if (Math.abs(this._frameAt(s).curv) > TOWNS.maxCurv) return false;
    return true;
  }

  /** How far the land beside the road stands off its level (Infinity: another road or a lake is there). */
  _relief(s0, s1, side) {
    let worst = 0;
    for (let s = s0; s <= s1; s += 40) {
      const f = this._frameAt(s);
      const rx = -f.tan.z, rz = f.tan.x;
      for (const v of [25, 45]) {
        const x = f.pos.x + rx * side * v, z = f.pos.z + rz * side * v;
        worst = Math.max(worst, Math.abs(this.terrain.height(x, z, v) - f.pos.y));
        if (this.field.roadDistance(x, z) < v - 4 || this.field.lakes.at(x, z)) return Infinity;
      }
    }
    return worst;
  }

  _layVillage({ kind, k, rng, sc, s0, s1, pad, sides, steep }) {
    const village = kind === 'village';
    // The centreline, `pad` past each end, as [x, z, y] every STEP metres.
    const pts = [];
    for (let s = s0 - pad; s <= s1 + pad + 1e-6; s += STEP) {
      const f = this._frameAt(s);
      pts.push(f.pos.x, f.pos.z, f.pos.y);
    }
    const o = this._frameAt(sc).pos.clone();
    const climate = CLIMATE[this.biomes ? this.biomes.biomeAt(o.x, o.z).a : ''] || 'mild';
    const mix = MIX[climate];
    const plan = sides.map((side) => ({ side, rows: village && side !== steep && rng() < TOWNS.backRow ? 2 : 1 }));
    const flat = sides.filter((side) => side !== steep);
    const churchSide = village && rng() < TOWNS.church ? flat[Math.floor(rng() * flat.length)] : 0;

    // Rows decide how far out the village reaches, which the levelling needs
    // BEFORE the lots read their ground: depths are drawn first, lots after.
    const v0 = EDGE + TOWNS.verge;
    const deep = (st) => st.lot.depth[1] + st.lot.front + (st.attached ? 0 : 3);
    const maxDeep = Math.max(...Object.values(MIX).flatMap((m) => [...m.edge, ...m.centre]).map(([id]) => deep(STYLE[id])));
    const W = [0, 0];
    for (const p of plan) {
      const rows = v0 + p.rows * (maxDeep + 8) + (p.rows - 1) * TOWNS.backGap;
      W[p.side > 0 ? 1 : 0] = Math.max(rows, p.side === churchSide ? v0 + CHURCH[1] : 0) + TOWNS.flat;
    }

    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
      z0 = Math.min(z0, pts[i + 1]); z1 = Math.max(z1, pts[i + 1]);
    }
    const reach = Math.max(W[0], W[1]) + TOWNS.blend;
    const t = {
      kind, slot: k, seed: hashInt(this.seed ^ (k * 2654435761)), s0, s1, sc, sides,
      pts: new Float64Array(pts), len: (pts.length / 3 - 1) * STEP, pad, W,
      box: [x0 - reach, z0 - reach, x1 + reach, z1 + reach],
      origin: o, radius: (s1 - s0) / 2 + reach, lots: [], lamps: [], church: null,
    };
    this._register(t);

    const field = this.field;
    field.beginRegion(t.box[0], t.box[1], t.box[2], t.box[3]);
    const corner = new THREE.Vector3();
    /** Road length a lot `w` wide takes at `vFront`..+`d`: less on the outside of a bend, more inside. */
    const span = (s, side, vFront, d, w) => w / Math.max(0.5, 1 + side * (vFront + d / 2) * this._frameAt(s).curv);
    /** A lot `w` wide along the road at station `s`, `d` deep from `vFront`. Null if it does not fit. */
    const lot = (s, side, vFront, w, d) => {
      const f = this._frameAt(s);
      const rx = -f.tan.z, rz = f.tan.x;
      const vc = side * (vFront + d / 2);
      const cx = f.pos.x + rx * vc, cz = f.pos.z + rz * vc;
      // Front (+z after `angle`) faces the road.
      const angle = Math.atan2(-side * rx, -side * rz);
      const ux = Math.cos(angle), uz = -Math.sin(angle);   // local +x
      const fx = -side * rx, fz = -side * rz;               // local +z
      let hi = -Infinity, lo = Infinity;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        corner.set(cx + ux * a * w / 2 + fx * b * d / 2, 0, cz + uz * a * w / 2 + fz * b * d / 2);
        if (field.roadDistance(corner.x, corner.z) < vFront - 2) return null;
        if (field.lakes.at(corner.x, corner.z)) return null;
        const y = field.height(corner.x, corner.z);
        hi = Math.max(hi, y); lo = Math.min(lo, y);
      }
      return {
        x: cx - o.x, z: cz - o.z, y: hi - o.y, drop: hi - lo + 0.6, w, d, angle,
        // Which way along the road local +x runs: decides a terrace's open ends.
        along: Math.sign(f.tan.x * ux + f.tan.z * uz) || 1,
      };
    };

    if (churchSide) {
      const c = lot(sc, churchSide, v0, CHURCH[0], CHURCH[1]);
      if (c) { t.church = { ...c, seed: hashInt(t.seed + 77) }; t.churchAt = [churchSide, sc - 20, sc + 20]; }
    }

    for (const { side, rows } of plan) {
      let vFront = v0;
      for (let row = 0; row < rows; row++) {
        let deepest = 0;
        let s = s0 + rng() * 6;
        while (s < s1) {
          const C = t.churchAt;
          if (row === 0 && C && C[0] === side && s + 8 > C[1] && s < C[2]) { s = C[2] + 2; continue; }
          const central = village && row === 0 && Math.abs(s - sc) < (s1 - s0) * 0.25;
          const st = STYLE[weighted(rng, central ? mix.centre : mix.edge)];
          // Attached styles come as terraces, the ends open; one alone is open both sides.
          const n = st.attached ? 1 + Math.floor(rng() * (central ? 4 : 2)) : 1;
          const run = [];
          for (let i = 0; i < n; i++) {
            const w = range(rng, st.lot.width);
            const d = deep(st) + (st.attached ? 0 : rng() * 8);
            const ds = span(s, side, vFront, d, w);
            if (s + ds > s1) break;
            const L = lot(s + ds / 2, side, vFront, w, d);
            s += ds;
            if (!L) break;
            run.push({ ...L, style: st.id, seed: hashInt(t.seed + t.lots.length * 977 + run.length), floors: 0 });
            deepest = Math.max(deepest, d);
          }
          run.forEach((L, i) => {
            const lo = i === 0, hi = i === run.length - 1;
            if (run.length === 1) L.corner = 'both';
            else if (lo || hi) L.corner = (lo === (L.along > 0)) ? 'left' : 'right';
            delete L.along;
            t.lots.push(L);
          });
          s += range(rng, village ? TOWNS.gap : TOWNS.hamletGap);
        }
        vFront += deepest + TOWNS.backGap;
      }
    }

    // Street lamps, alternating sides through a village, on a hamlet's house side.
    for (let s = s0 + 10, n = 0; s < s1; s += TOWNS.lampStep, n++) {
      const side = sides[n % sides.length];
      const f = this._frameAt(s);
      const v = side * (EDGE + 0.9);
      const x = f.pos.x - f.tan.z * v, z = f.pos.z + f.tan.x * v;
      t.lamps.push([x - o.x, field.height(x, z) - o.y, z - o.z]);
    }
    field.endRegion();
    if (!t.lots.length && !t.church) this._unregister(t);
  }

  _planCity(k, rng) {
    if (!TOWNS.cities) return;
    const size = range(rng, TOWNS.citySize);
    const hs = size / 2 + 16;                       // City-gen's ring road is 16 m wide
    const dMax = Math.min(TOWNS.cityDist[1], TILES.radius - hs - 120);
    if (dMax < TOWNS.cityDist[0]) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      const f = this._frameAt(k * TOWNS.slot + rng() * TOWNS.slot);
      const side = rng() < 0.5 ? -1 : 1;
      const D = TOWNS.cityDist[0] + (dMax - TOWNS.cityDist[0]) * rng();
      const rx = -f.tan.z, rz = f.tan.x;
      // Its grid squared to the road it is seen from.
      const angle = Math.atan2(f.tan.x, f.tan.z);
      const t = {
        kind: 'city', slot: k, seed: hashInt(this.seed ^ (k * 40503)), size, hs, blend: TOWNS.cityBlend,
        cx: f.pos.x + rx * side * D, cz: f.pos.z + rz * side * D, angle,
        cos: Math.cos(angle), sin: Math.sin(angle), density: range(rng, TOWNS.cityDensity), level: 0,
      };
      if (!this._cityClear(t)) continue;
      // Land: sampled over the square, levelled to its mean if it varies little.
      let lo = Infinity, hi = -Infinity, sum = 0, n = 0, wet = false;
      for (let a = -1; a <= 1; a += 0.5) {
        for (let b = -1; b <= 1; b += 0.5) {
          const [x, z] = this._cityPoint(t, a * hs, b * hs);
          const y = this.terrain.height(x, z, 650);
          lo = Math.min(lo, y); hi = Math.max(hi, y); sum += y; n++;
          if (this.field.lakes.at(x, z)) wet = true;
        }
      }
      if (wet || hi - lo > TOWNS.cityRelief) continue;
      t.level = sum / n;
      const r = hs * Math.SQRT2 + t.blend;
      t.box = [t.cx - r, t.cz - r, t.cx + r, t.cz + r];
      t.origin = new THREE.Vector3(t.cx, t.level, t.cz);
      t.radius = r;
      this._register(t);
      return;
    }
  }

  /** A city-local point (x along its first axis, z along its second) in the world. */
  _cityPoint(t, lx, lz) {
    return [t.cx + lx * t.cos + lz * t.sin, t.cz - lx * t.sin + lz * t.cos];
  }

  /**
   * No road within a city's levelling of any of it: a 5 × 5 grid over the
   * square, each point clear by more than the grid's half-spacing ever hides.
   */
  _cityClear(t) {
    for (let a = -1; a <= 1; a += 0.5) {
      for (let b = -1; b <= 1; b += 0.5) {
        const [x, z] = this._cityPoint(t, a * t.hs, b * t.hs);
        if (this.field.roadDistance(x, z) < t.blend + 50) return false;
      }
    }
    return true;
  }

  /** Road generated after a city was planned may come too close: then the city goes. */
  _recheck() {
    if (!this._grown.length) return;
    const boxes = this._grown;
    this._grown = [];
    for (const t of this.list.slice()) {
      if (t.kind !== 'city') continue;
      const m = 700;
      const hit = boxes.some(([x0, z0, x1, z1]) =>
        t.cx + m > x0 && t.cx - m < x1 && t.cz + m > z0 && t.cz - m < z1);
      if (hit && !this._cityClear(t)) this._unregister(t);
    }
  }

  // -------------------------------------------------------------- building --

  /** Plans new road, then builds what is near `(fx, fz)` and frees what is far. */
  update(fx, fz) {
    if (!TOWNS.enabled) return;
    this.field.sync();
    this.plan();
    this._recheck();
    for (const t of this.list) {
      const d = Math.hypot(t.origin.x - fx, t.origin.z - fz) - t.radius;
      if (d < TOWNS.buildRadius) { if (!t.object && !t.pending) this._request(t); }
      else if (d > TOWNS.keep && t.object) this._drop(t);
    }
  }

  _request(t) {
    t.pending = true;
    const msg = t.kind === 'city'
      ? { id: ++this._id, kind: 'city', size: t.size, seed: t.seed, density: t.density }
      : { id: ++this._id, kind: t.kind, lots: t.lots, church: t.church, lamps: t.lamps, details: TOWNS.detail };
    if (this.worker) {
      this._jobs.set(msg.id, t);
      this.worker.postMessage(msg);
    } else {
      this._apply(t, buildTown(msg));
    }
  }

  _apply(t, levels) {
    t.pending = false;
    if (t.dead || !levels) return;
    const groups = levels.map((L, i) => {
      const g = new THREE.Group();
      for (const [P, mat] of [[L.solid, this.solid], [L.glass, this.glass]]) {
        if (!P) continue;
        const mesh = new THREE.Mesh(geometry(P), mat);
        mesh.castShadow = i === 0 && mat === this.solid && t.kind !== 'city';
        mesh.receiveShadow = true;
        g.add(mesh);
      }
      return g;
    });
    let obj = groups[0];
    if (groups.length > 1) {
      obj = new THREE.LOD();
      groups.forEach((g, i) => obj.addLevel(g, i * TOWNS.lodDistance));
    }
    obj.position.copy(t.origin);
    if (t.kind === 'city') obj.rotation.y = t.angle;
    obj.updateMatrixWorld(true);
    t.object = obj;
    this.scene.add(obj);
  }

  _drop(t) {
    if (!t.object) return;
    this.scene.remove(t.object);
    t.object.traverse((m) => { if (m.isMesh) m.geometry.dispose(); });
    t.object = null;
  }

  setNight(v) { this.night.value = v; }

  dispose() {
    for (const t of this.list) this._drop(t);
    if (this.worker) this.worker.terminate();
    this.solid.dispose();
    this.glass.dispose();
  }

  /** Vertex-coloured standard material plus City-gen's per-vertex warm emission, lit at night. */
  _material(opts) {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, ...opts });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = this.night;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float emit;\nvarying float vEmit;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEmit = emit * 2.0;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vEmit;\nuniform float uNight;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' +
          'totalEmissiveRadiance += (vEmit > 1.5 ? diffuseColor.rgb * 3.0 : vec3(1.0, 0.72, 0.42)) * min(vEmit, 1.0) * uNight * 2.2;');
    };
    m.customProgramCacheKey = () => 'towns';
    return m;
  }
}

function geometry(P) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(P.nor, 3, true));
  g.setAttribute('color', new THREE.BufferAttribute(P.col, 3, true));
  g.setAttribute('emit', new THREE.BufferAttribute(P.emit, 1, true));
  g.setIndex(new THREE.BufferAttribute(P.idx, 1));
  g.computeBoundingSphere();
  return g;
}
