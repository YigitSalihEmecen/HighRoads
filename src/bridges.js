/**
 * bridges.js — gaps in the land, and the bridges Bridge-gen (`bridge_gen/`) builds over them.
 *
 * The router plans each crossing (`path.js:_planCrossing`): a straight run of
 * road at a steady grade, and a gap — gorge, canyon or valley — square-ish to
 * it under the middle. The router routes over ground that has no gap, so the
 * road keeps its height across; this module cuts the gap and bridges it.
 *
 * THE GAP is a term in the natural ground (`carve`, `TerrainField.sample`):
 * a channel along the gap's line, its rim just under the road, its floor
 * `depth` lower in a V, U or flat-floored section, cut back at `wall` beyond
 * the rim where the land stands higher, wandering once clear of the bridge
 * and closing up at its `reach`. A river runs in most (`river`). Over the
 * crossing's own run the road's FILL is withheld (`open`), so the field does
 * not build an embankment across the gap the bridge is there to span.
 *
 * VALLEY BRIDGES are the land's own: the router keeps the road's grade over
 * whatever is under it, and wherever that leaves the road `valley.on` metres
 * over the natural ground it crosses on a bridge instead of an embankment
 * (`_scan`, a pure function of the road, walked in order as it is laid). Its
 * fill is withheld the same way, so the valley stays the valley, and the
 * piers stand on it. These follow the road's bends and banking.
 *
 * THE BRIDGE is chosen by its length and depth and the country (the world
 * biome, the region's biome) — timber trestle, stone arch, truss, girder
 * viaduct, tied arch, cable-stayed, suspension, and on a hillside a solid
 * stone causeway — with every parameter rolled
 * from the crossing's seed, so no two are the same. Bridge-gen builds it
 * straight along local X with its real ground under it (`P.ground`); each
 * vertex is then put on the road: station `sC + x`, the road's own height
 * and banking there (vertical shears, so piers stay plumb), its deck just under the
 * ribbon. The ribbon (chunks.js) carries on over it, so the road is seamless;
 * the bridge's own asphalt shows as its shoulders.
 *
 * Colliders: the deck to its parapets, and a wall along each edge.
 */
import * as THREE from 'three';
import { BRIDGES, ROAD, TILES, TERRAIN } from './config.js';
import { clamp, lerp, smoothstep, smin, mulberry32, hashInt } from './util.js';
import { buildBridge, TYPES, BASE } from '../bridge_gen/src/bridges.js';
import { bakeTextures, makeMaterials } from '../bridge_gen/src/textures.js';

/** The bridge's deck top, against the centreline: the ribbon rides 3.5 cm over it, the deck 6 cm under that. */
const DECK = -0.025;
/** Spatial index cell for `carve`, metres. */
const CELL = 400;
/** Bridge-gen parts the ribbon covers. */
const HIDDEN = ['paint'];

const FALLBACK = {
  stone: 0x9a948a, cobble: 0x7d776f, planks: 0x7a5b3e, timber: 0x6b4f36, steel: 0x6f7b80,
  concrete: 0xa9a59c, asphalt: 0x3f3e3b, rope: 0xa08a62, cable: 0x5d6266,
};
const STEEL = ['#5d6b70', '#6f7b80', '#7d878c', '#b4432f', '#2f5d50', '#e4e1d8', '#3d4f6b', '#8b3a2b', '#4a4f55'];
const WOODY = ['boreal', 'alpine', 'birchwood', 'autumn', 'broadleaf', 'wetland'];
const STONY = ['mediterranean', 'savanna', 'meadow', 'blossom', 'erg', 'reg'];

const SHAPES = {
  V: (t) => 1 - t,
  U: (t) => 1 - t ** 4,
  Flat: (t) => 1 - smoothstep(0.55, 1, t),
};

/** Bridge-gen's materials, baked on the GPU at boot (null renderer: plain colours, for Node). */
export async function createBridgeMaterials(renderer) {
  if (!renderer) return null;
  try {
    return makeMaterials(await bakeTextures(renderer, null, { maxRes: BRIDGES.texRes }), renderer);
  } catch (err) {
    console.warn('[bridges] texture bake failed, plain materials:', err && err.message);
    return null;
  }
}

const pick = (rng, list) => list[Math.floor(rng() * list.length)];

/**
 * What to build over a crossing: Bridge-gen's params, from its length `L`,
 * its depth and the country. Weights, then a seeded roll among them.
 * `hill`: the share of a dry valley bridge's deck whose high side is all but
 * on the ground (0 for a gap), where a solid stone causeway does best.
 */
export function design(L, depth, region, rng, curved = false, hill = 0) {
  const W = TERRAIN.biome;
  const woody = WOODY.includes(region) || W === 'snow' || W === 'fall';
  const stony = STONY.includes(region) || W === 'desert' || W === 'fall';
  // Short gaps are timber's (L counts the abutments: a 25 m gap is a ~50 m
  // bridge): a trestle nearly always, stone now and then.
  const short = L <= 75 && depth <= 30;
  const weights = {
    wood: short ? 4 * (woody ? 1.5 : 1) : L <= 110 && depth <= 30 ? (woody ? 1.2 : 0.5) : 0,
    // Low and long, a stone arcade; it follows a bend as well as a girder does.
    stone: L <= 260 && depth <= 42 ? (short ? 0.5 : 1) * (stony ? 2 : 0.8) * (curved && depth < 25 ? 1.6 : 1) : 0,
    truss: L >= 48 && L <= 280 ? (woody ? 1.5 : 1) * (short ? 0.3 : 1) : 0,
    girder: L > 200 ? 1.6 : short ? 0.2 : 1,
    arch: L >= 60 && L <= 320 && !curved ? (short ? 0.3 : 1.2) : 0,
    stayed: L >= 200 && !curved ? (L > 320 ? 1.6 : 1) : 0,
    suspension: L >= 340 && !curved ? 2.2 : 0,
    causeway: depth <= 26 && L <= 400 ? (hill > 0.12 ? 14 * hill : depth <= 14 && hill > 0 ? 0.6 : 0) * (stony ? 1.4 : 1) : 0,
  };
  let u = rng() * Object.values(weights).reduce((a, b) => a + b, 0), type = 'girder';
  for (const [k, w] of Object.entries(weights)) if ((u -= w) <= 0 && w > 0) { type = k; break; }

  const r = (a, b) => lerp(a, b, rng());
  const P = {
    type, steelColor: pick(rng, STEEL), seed: 1 + Math.floor(rng() * 998),
    // Long ones carry a concrete barrier: a railing is a post every 2 m (and most of a long build).
    railing: L < 220 && rng() < (ROAD.lanesPerSide < 2 ? 0.6 : 0.3) ? 'Railing' : 'Barrier', sidewalk: 0,
  };
  const spans = (a, b) => Math.max(1, Math.round(L / r(a, b)));
  if (type === 'wood') Object.assign(P, { spans: spans(6, 10) });
  else if (type === 'causeway') Object.assign(P, { buttress: r(7, 13), parapet: r(0.8, 1.2) });
  else if (type === 'stone') {
    Object.assign(P, { spans: spans(14, 28), archRise: r(0.32, 0.5), parapet: r(0.8, 1.2), sidewalk: rng() < 0.5 ? 0 : r(0.6, 1.1) });
  } else if (type === 'truss') {
    const n = spans(45, 80);
    Object.assign(P, {
      spans: n, trussHeight: clamp((L / n) * r(0.1, 0.14), 6.5, 13), trussStyle: pick(rng, ['Warren', 'Pratt', 'Howe']),
      trussMaterial: woody && L / n < 60 && rng() < 0.6 ? 'Timber' : 'Steel',
    });
  } else if (type === 'girder') {
    const n = spans(28, 48);
    Object.assign(P, { spans: n, girderDepth: clamp(L / n / 18, 1.4, 3.2) * r(0.9, 1.15), sidewalk: rng() < 0.3 ? r(1, 1.6) : 0 });
  } else if (type === 'arch') {
    Object.assign(P, {
      spans: L > 200 && rng() < 0.5 ? 2 : 1, archRise: r(0.14, 0.2), hangerSpacing: r(5, 9),
      hangerPattern: rng() < 0.5 ? 'Network' : 'Vertical', sidewalk: rng() < 0.5 ? r(1, 1.8) : 0,
    });
  } else if (type === 'stayed') {
    const one = L < 320 || rng() < 0.25;
    const mainRatio = r(0.45, 0.6);
    Object.assign(P, {
      pylons: one ? '1' : '2', pylonShape: rng() < 0.5 ? 'H' : 'A', stayLayout: pick(rng, ['Fan', 'Semi-fan', 'Harp']),
      mainRatio, staySpacing: r(8, 14), towerMaterial: rng() < 0.7 ? 'Concrete' : 'Steel',
      towerHeight: (one ? L / 2 : (L * mainRatio) / 2) * r(0.42, 0.6), sidewalk: rng() < 0.5 ? r(1, 1.8) : 0,
    });
  } else {
    const mainRatio = r(0.55, 0.7);
    Object.assign(P, {
      mainRatio, towerHeight: L * mainRatio * r(0.17, 0.23), hangerSpacing: r(8, 14),
      stiffening: rng() < 0.6 ? 'Truss' : 'Box girder', towerMaterial: rng() < 0.5 ? 'Concrete' : 'Steel',
      sidewalk: rng() < 0.5 ? r(1, 1.8) : 0,
    });
  }
  return P;
}

export class Bridges {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {import('./path.js').RoadPath} o.path
   * @param {import('./terrainfield.js').TerrainField} o.field
   * @param {object} o.terrain noise.js terrain
   * @param {object} o.biomes biomes.js
   * @param {object} [o.materials] `createBridgeMaterials` (null: plain colours)
   * @param {object} [o.water] env/water.js, whose material the rivers share
   * @param {(x0, z0, x1, z1) => void} o.onChange the ground changed in this box
   */
  constructor({ scene, path, field, terrain, biomes, world = null, RAPIER = null, materials = null, water = null, onChange = () => {} }) {
    Object.assign(this, { scene, path, field, terrain, biomes, world, RAPIER, water, onChange });
    this.mats = materials || Object.fromEntries(Object.entries(FALLBACK).map(([k, c]) =>
      [k, new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: k === 'steel' || k === 'cable' ? 0.5 : 0 })]));
    this._steel = new Map();
    /** Every crossing indexed, in road order (the path's own list, with what this module derives). */
    this.list = [];
    this._announced = 0;
    this._resolved = 0;
    this._cells = new Map();
    this._frame = null;
    /** Every bridge whose stations are known, gap or valley, in road order (by `os0`). */
    this.spans = [];
    this._scanS = BRIDGES.valley.from;
    this._stretch = null;
    this._fresh = [];
  }

  // ------------------------------------------------------------- the field --

  /** The natural ground at (x, z) with every gap cut into it. */
  carve(x, z, y) {
    if (this.list.length < this.path.crossings.length) this._index();
    const cell = this._cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!cell) return y;
    for (let n = 0; n < cell.length; n++) y = this._cut(cell[n], x, z, y);
    return y;
  }

  /**
   * How much of the road's fill to withhold at (x, z) for the pass at station
   * `s`, 0..1: inside a gap, on its own crossing's run. Another pass of the
   * road that strays over the gap fills it as usual.
   */
  open(x, z, s) {
    const c = this.spans[this._before(s)];
    if (!c || s > c.os1) return 0;
    if (c.kind === 'valley') return smoothstep(c.s0, c.s0 + 8, s) * (1 - smoothstep(c.s1 - 8, c.s1, s));
    const rx = x - c.cx, rz = z - c.cz;
    const off = Math.abs(rx * c.az - rz * c.ax);
    return 1 - smoothstep(c.hw, c.hw + BRIDGES.rim, off);
  }

  /** The bridge covering station `s` (± `margin`), or null. */
  spanAt(s, margin = 0) {
    this._resolve();
    const n = this._before(s + margin);
    for (const c of [this.spans[n], this.spans[n - 1]]) if (c && s >= c.s0 - margin && s <= c.s1 + margin) return c;
    return null;
  }

  /** Index of the last span whose open range starts at or before `s` (-1 if none). */
  _before(s) {
    const S = this.spans;
    let lo = -1, hi = S.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (S[mid].os0 <= s) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  _addSpan(c) {
    const n = this._before(c.os0) + 1;
    this.spans.splice(n, 0, c);
  }

  /** Whether any gap's channel comes within `r` of (x, z): lakes keep out of them. */
  nearGap(x, z, r) {
    if (this.list.length < this.path.crossings.length) this._index();
    const cell = this._cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    for (const c of cell || []) {
      const rx = x - c.cx, rz = z - c.cz;
      const along = rx * c.ax + rz * c.az;
      if (Math.abs(along) > (along < 0 ? c.reach[0] : c.reach[1]) + r) continue;
      if (Math.abs(rx * c.az - rz * c.ax) < c.hw + Math.abs(c.wander[0]) + r) return true;
    }
    return false;
  }

  _cut(c, x, z, y) {
    const rx = x - c.cx, rz = z - c.cz;
    const along = rx * c.ax + rz * c.az;
    const reach = along < 0 ? c.reach[0] : c.reach[1];
    const fade = 1 - smoothstep(reach * 0.55, reach, Math.abs(along));
    if (fade <= 0) return y;
    const [wa, wl, wp] = c.wander;
    const d = Math.abs(rx * c.az - rz * c.ax - wa * Math.sin(along / wl + wp) * smoothstep(60, 220, Math.abs(along)));
    if (d > c.hw + 400) return y;
    const rim = this._rim(c, x, z);
    let target;
    if (d < c.hw) {
      target = rim - c.depth * c.shape(d / c.hw);
      if (c.river) target -= BRIDGES.riverDepth * (1 - smoothstep(c.riverW * 0.5, c.riverW, d));
    } else target = rim + (d - c.hw) * BRIDGES.wall;
    return y + (smin(y, target, 3) - y) * fade;
  }

  /** The rim's height near (x, z): the road it crosses, projected square onto its run, less `rimDrop`. */
  _rim(c, x, z) {
    const u = clamp(((x - c.x0) * c.dx + (z - c.z0) * c.dz) / ROAD.ctrlSpacing, 0, c.n);
    const k = Math.min(Math.floor(u), c.n - 1);
    return lerp(c.ys[k], c.ys[k + 1], u - k) - BRIDGES.rimDrop;
  }

  /** Takes up crossings the router has planned since: their section, river and spatial cells. */
  _index() {
    const all = this.path.crossings;
    while (this.list.length < all.length) {
      const c = all[this.list.length];
      const rng = mulberry32(c.seed);
      const shape = c.span < 60 ? (rng() < 0.6 ? 'V' : 'U') : c.span < 200 ? (rng() < 0.5 ? 'U' : 'Flat') : (rng() < 0.3 ? 'U' : 'Flat');
      c.shapeName = shape;
      c.shape = SHAPES[shape];
      c.river = rng() < (TERRAIN.biome === 'desert' ? BRIDGES.riverDry : BRIDGES.river);
      c.riverW = clamp(c.hw * lerp(0.15, 0.3, rng()), 3, 24);
      c.rise = clamp(c.depth * lerp(BRIDGES.riverRise[0], BRIDGES.riverRise[1], rng()), 1.2, BRIDGES.riverRiseMax);
      const r = Math.max(c.reach[0], c.reach[1]) + c.hw + 420;
      c.box = [c.cx - r, c.cz - r, c.cx + r, c.cz + r];
      for (let ci = Math.floor(c.box[0] / CELL); ci <= Math.floor(c.box[2] / CELL); ci++) {
        for (let cj = Math.floor(c.box[1] / CELL); cj <= Math.floor(c.box[3] / CELL); cj++) {
          const k = key(ci, cj);
          let cell = this._cells.get(k);
          if (!cell) this._cells.set(k, cell = []);
          cell.push(c);
        }
      }
      this.list.push(c);
      this.field.lakes.recheck(c.box[0], c.box[1], c.box[2], c.box[3]);
    }
  }

  /** Stations of every crossing whose run the road has reached: the straight from ctrl[i0], `spacing` per point. */
  _resolve() {
    const sp = ROAD.ctrlSpacing;
    while (this._resolved < this.list.length) {
      const c = this.list[this._resolved];
      const est = (c.i0 - 1) * sp;
      if (this.path.length < est + 100) return;
      const p = this.path.ctrl[c.i0];
      const s = this.path.projectPoint(p, est, 400, 400);
      c.runS0 = s;
      c.runS1 = s + (c.n - 2) * sp;
      c.sC = s + (c.n / 2 - 1) * sp;
      c.s0 = c.sC - c.half;
      c.s1 = c.sC + c.half;
      c.kind = 'gap';
      c.os0 = c.runS0;
      c.os1 = c.runS1;
      this._addSpan(c);
      this._resolved++;
    }
  }

  /**
   * Walks the road laid since, `valley.step` at a time, for stretches it
   * crosses high over natural ground, and makes each a valley bridge. Pure:
   * stations in order from `valley.from`, the natural ground (with the gaps)
   * at the centreline, and nothing within a gap crossing's run.
   */
  _scan() {
    const V = BRIDGES.valley;
    const limit = this.path.length - 400;
    while (this._scanS < limit) {
      const s = this._scanS;
      this._scanS += V.step;
      const gap = this.spans[this._before(s + 30)];
      const inGap = gap && gap.kind === 'gap' && s >= gap.os0 - 30 && s <= gap.os1 + 30;
      const d = inGap ? 0 : this._rise(s);
      const cur = this._stretch;
      if (d > V.on) {
        if (!cur) this._stretch = { a: s, b: s };
        else cur.b = s;
      } else if (cur && d > V.off && !inGap) cur.b = s;
      else if (cur && (inGap || s - cur.b > V.merge)) {
        this._stretch = null;
        this._valley(cur.a, cur.b);
      }
    }
  }

  /** How far the road at station `s` stands over the natural ground at its centreline. */
  _rise(s) {
    const f = this._frameAt(s);
    return f.pos.y - this.carve(f.pos.x, f.pos.z, this.terrain.height(f.pos.x, f.pos.z, 0));
  }

  /** A valley bridge over stations a..b, stretched out to where the road lands. */
  _valley(a, b) {
    const V = BRIDGES.valley;
    let s0 = a, s1 = b;
    while (a - s0 < V.pad && this._rise(s0 - V.step) > V.land) s0 -= V.step;
    while (s1 - b < V.pad && this._rise(s1 + V.step) > V.land) s1 += V.step;
    s0 -= 3; s1 += 3;
    // A neighbour's stretch is its own (a gap's whole run); a valley bridge
    // this one would run into takes this one in instead.
    const prev = this.spans[this._before(a)], next = this.spans[this._before(s1)];
    let clipped = 0;
    if (next && next.os0 > a && s1 > next.os0 - 4) { s1 = next.os0 - 4; clipped |= 2; }
    let c = null;
    if (prev && s0 <= prev.os1 + 4) {
      if (prev.kind === 'gap') { s0 = prev.os1 + 4; clipped |= 1; }
      else { c = prev; s0 = prev.s0; this._drop(prev); }
    }
    if (s1 - s0 < V.minLength) return;
    let curv = 0, depth = 0;
    for (let s = s0; s <= s1; s += V.step) {
      curv = Math.max(curv, Math.abs(this._frameAt(s).curv));
      depth = Math.max(depth, this._rise(s));
    }
    const sC = (s0 + s1) / 2, f = this._frameAt(sC);
    const fields = {
      s0, s1, os0: s0, os1: s1, sC, half: (s1 - s0) / 2, curved: curv > 1 / 700, depth, cx: f.pos.x, cz: f.pos.z,
      // Ends cut short by a gap's run (bit 0 start, 1 end): the road between stays on its embankment.
      clipped: (c ? c.clipped & 1 : 0) | clipped,
    };
    if (c) Object.assign(c, fields);
    else {
      c = { kind: 'valley', ...fields, seed: hashInt(this.field.seed ^ Math.round(s0 * 7)), river: false };
      this._addSpan(c);
    }
    // Its fill is gone: everything within an embankment's reach of it.
    const r = c.half + depth * ROAD.fillSlope * 2 + 60;
    this._fresh.push([c.cx - r, c.cz - r, c.cx + r, c.cz + r]);
  }

  // -------------------------------------------------------------- building --

  /** New crossings reshape the ground (`onChange`); builds what is near `(fx, fz)`, frees what is far. */
  update(fx, fz) {
    if (!BRIDGES.enabled) return;
    this._index();
    while (this._announced < this.list.length) {
      const B = this.list[this._announced++].box;
      this.onChange(B[0], B[1], B[2], B[3]);
    }
    this._resolve();
    this._scan();
    for (const B of this._fresh) this.onChange(B[0], B[1], B[2], B[3]);
    this._fresh.length = 0;
    const R = Math.min(BRIDGES.buildRadius, TILES.radius);
    for (const c of this.spans) {
      const d = Math.hypot(c.cx - fx, c.cz - fz) - c.half;
      if (d < R) {
        if (!c.object && !this._job && this.path.length > c.s1 + 30) this._job = this._buildJob(c);
      } else if (d > BRIDGES.keep && c.object) this._drop(c);
    }
    // One bridge at a time, a few milliseconds a frame: Bridge-gen's build is
    // one step (up to ~30 ms for a long viaduct), the fitting one step a part.
    const t0 = performance.now();
    while (this._job && performance.now() - t0 < 4) if (this._job.next().done) this._job = null;
  }

  /** Builds crossing `c`'s bridge at once (the probes). */
  _build(c) {
    for (const _ of this._buildJob(c));
  }

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

  /** Builds crossing `c`'s bridge (and river) and puts it on the road, as a resumable job. */
  *_buildJob(c) {
    const f = this._frameAt(c.sC);
    const origin = f.pos.clone();
    const L = 2 * c.half;
    const rw = ROAD.halfWidth + ROAD.shoulder;
    const region = this.biomes ? this.biomes.biomeAt(c.cx, c.cz).a : 'meadow';
    // The deepest the gap goes under the deck, for the choice of bridge.
    const ground = yield* this._groundProfile(c, rw + 2);
    const depth = -Math.min(...ground.y);
    const hill = c.hill = c.kind === 'valley' && !c.river ? ground.hill : 0;
    // A fresh roll each build: a bridge freed and built again is the same bridge.
    const d = design(L, depth, region, mulberry32(c.seed ^ 0x5bd1e995), c.curved, hill);
    const P = {
      ...BASE, ...TYPES[d.type].defaults, ...d,
      length: L, lanes: 2 * ROAD.lanesPerSide, laneWidth: (2 * rw) / (2 * ROAD.lanesPerSide),
      startElev: 0, endElev: 0, camber: 0, segment: clamp(L / 60, 4, 8),
      ground: (x) => {
        const u = clamp((x - ground.x0) / ground.step, 0, ground.y.length - 1.001);
        const k = Math.floor(u);
        return lerp(ground.y[k], ground.y[k + 1], u - k);
      },
    };
    c.design = P;
    yield;
    const { parts } = buildBridge(P);
    const table = this._stations(c, 70);

    const obj = new THREE.Group();
    obj.position.copy(origin);
    for (const [k, geo] of Object.entries(parts)) {
      if (HIDDEN.includes(k)) { geo.dispose(); continue; }
      yield;
      this._warp(table, geo, origin);
      const mesh = new THREE.Mesh(geo, k === 'steel' ? this._steelMat(P.steelColor) : this.mats[k] || this.mats.concrete);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      obj.add(mesh);
    }
    if (c.river && this.water) {
      const river = yield* this._river(c, origin);
      if (river) obj.add(river);
    }
    obj.updateMatrixWorld(true);
    this.scene.add(obj);
    c.object = obj;
    c.colliders = this._colliders(c, rw + P.sidewalk + 0.45);
  }

  /**
   * The ground under the deck in the bridge's frame (metres below the deck),
   * every 2 m from 25 m before it to 25 m after: the lowest of the centreline
   * and both edges, so no footing hangs over the low side of a skewed gap.
   * `hill`: the share of the deck whose high edge is within 3 m of it while
   * the low side falls away — a road half on its hillside.
   */
  *_groundProfile(c, edge) {
    const step = 2, x0 = -c.half - 25;
    const n = Math.ceil((2 * c.half + 50) / step) + 1;
    const y = new Float32Array(n);
    let deck = 0, side = 0;
    for (let i = 0; i < n; i++) {
      if (i % 40 === 39) yield;
      const fr = this._frameAt(c.sC + x0 + i * step);
      const rx = -fr.tan.z, rz = fr.tan.x, rl = Math.hypot(rx, rz);
      let lo = Infinity, hi = -Infinity;
      for (const v of [-edge, 0, edge]) {
        const h = this.field.height(fr.pos.x + (rx / rl) * v, fr.pos.z + (rz / rl) * v);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
      y[i] = lo - (fr.pos.y + DECK);
      if (Math.abs(x0 + i * step) < c.half) {
        deck++;
        if (hi - (fr.pos.y + DECK) > -3 && y[i] < -4) side++;
      }
    }
    return { x0, step, y, hill: side / Math.max(1, deck) };
  }

  /**
   * The road under a bridge, every metre from `margin` before it to `margin`
   * after: position, flat heading and grade. Bridge-gen's parts reach past
   * the deck (abutments, anchorages), so the margin covers them.
   */
  _stations(c, margin) {
    const x0 = -c.half - margin, n = Math.ceil(2 * (c.half + margin)) + 1;
    const T = new Float64Array(n * 7);
    for (let i = 0; i < n; i++) {
      const f = this._frameAt(c.sC + x0 + i);
      const h = Math.hypot(f.tan.x, f.tan.z) || 1;
      T.set([f.pos.x, f.pos.y, f.pos.z, f.tan.x / h, f.tan.z / h, f.tan.y / h, Math.tan(f.bank)], i * 7);
    }
    return { x0, n, T };
  }

  /**
   * Bridge-gen's straight local frame onto the road: local x is station
   * `sC + x`, z the road's flat right, y up from the deck at that station.
   * Height and banking are shears (y += road(x) + z·tan bank, as the ribbon
   * banks), so normals take their inverse transpose.
   */
  _warp({ x0, n, T }, geo, origin) {
    const pos = geo.attributes.position, nor = geo.attributes.normal;
    const at = new Float64Array(7);
    for (let i = 0; i < pos.count; i++) {
      const u = clamp(pos.getX(i) - x0, 0, n - 1.001), k = Math.floor(u), t = u - k;
      for (let j = 0; j < 7; j++) at[j] = T[k * 7 + j] + (T[k * 7 + 7 + j] - T[k * 7 + j]) * t;
      const px = at[0], py = at[1], pz = at[2], tx = at[3], tz = at[4], grade = at[5], bank = at[6];
      const y = pos.getY(i), z = pos.getZ(i);
      pos.setXYZ(i, px - tz * z - origin.x, py + DECK + y + z * bank - origin.y, pz + tx * z - origin.z);
      const nx = nor.getX(i) - grade * nor.getY(i), ny = nor.getY(i), nz = nor.getZ(i) - bank * nor.getY(i);
      const wx = tx * nx - tz * nz, wz = tz * nx + tx * nz;
      const l = Math.hypot(wx, ny, wz) || 1;
      nor.setXYZ(i, wx / l, ny / l, wz / l);
    }
    pos.needsUpdate = nor.needsUpdate = true;
    geo.computeBoundingSphere();
  }

  /** One steel material per paint colour, sharing the baked maps. */
  _steelMat(color) {
    let m = this._steel.get(color);
    if (!m) {
      const base = this.mats.steel;
      m = base.clone();
      m.onBeforeCompile = base.onBeforeCompile;
      m.color.set(color);
      this._steel.set(color, m);
    }
    return m;
  }

  /**
   * The river: a sheet along the gap, wall to wall, sharing the lakes' water
   * shader, which fades it out wherever the ground stands above it. Each row
   * stands over the channel's bed there by `riverDepth + rise`, so the river
   * fills the floor and runs downhill with the rim — but never deeper than
   * the gap is cut into the land (less a metre), nor over the lower of its
   * banks: where the gap opens into lower country or closes, the water shoals
   * to nothing instead of hanging over the land as a sheet.
   */
  *_river(c, origin) {
    const STEP = 8;
    const reach = Math.min(...c.reach);
    const rows = Math.floor((2 * reach) / STEP) + 1;
    const W = c.hw + 25;
    const COLS = Math.ceil((2 * W) / 5) + 1;
    const pos = new Float32Array(rows * COLS * 3), depth = new Float32Array(rows * COLS);
    const [wa, wl, wp] = c.wander;
    const smp = {};
    for (let j = 0; j < rows; j++) {
      if (j % 12 === 0) yield;
      const along = -reach + j * STEP;
      const wob = wa * Math.sin(along / wl + wp) * smoothstep(60, 220, Math.abs(along));
      const bx = c.cx + c.ax * along + c.az * wob, bz = c.cz + c.az * along - c.ax * wob;
      this.field.sample(bx, bz, smp);
      const bed = smp.y;
      const ex = c.az * W, ez = -c.ax * W;
      const bank = Math.min(this.field.height(bx + ex, bz + ez), this.field.height(bx - ex, bz - ez));
      const h = Math.min(BRIDGES.riverDepth + c.rise, this.terrain.height(bx, bz, smp.d) - bed - 1, bank - bed - 0.5);
      const level = bed + Math.max(h, -0.5);
      for (let i = 0; i < COLS; i++) {
        const off = wob + (i / (COLS - 1) * 2 - 1) * W;
        const x = c.cx + c.ax * along + c.az * off, z = c.cz + c.az * along - c.ax * off;
        const k = j * COLS + i;
        pos[k * 3] = x - origin.x; pos[k * 3 + 1] = level - origin.y; pos[k * 3 + 2] = z - origin.z;
        depth[k] = level - this.field.height(x, z);
      }
    }
    const idx = [];
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < COLS - 1; i++) {
        const a = j * COLS + i, b = a + 1, cc = a + COLS, d = cc + 1;
        if (depth[a] < 0 && depth[b] < 0 && depth[cc] < 0 && depth[d] < 0) continue;
        idx.push(a, cc, b, b, cc, d);
      }
    }
    if (!idx.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.water.material);
    mesh.renderOrder = 2;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /** The deck to its parapets (a strip trimesh), and a wall along each edge every 8 m. */
  _colliders(c, hw) {
    if (!this.world) return [];
    const R = this.RAPIER, out = [];
    const n = Math.ceil((2 * c.half) / 4);
    const pts = [];
    for (let k = 0; k <= n; k++) {
      const f = this._frameAt(c.s0 + (k / n) * 2 * c.half);
      const h = Math.hypot(f.tan.x, f.tan.z) || 1;
      pts.push({ x: f.pos.x, y: f.pos.y + DECK, z: f.pos.z, rx: -f.tan.z / h, rz: f.tan.x / h, b: Math.tan(f.bank) });
    }
    const vtx = new Float32Array(pts.length * 2 * 3), idx = new Uint32Array(n * 6);
    pts.forEach((p, k) => {
      for (const [e, v] of [[0, -hw], [1, hw]]) vtx.set([p.x + p.rx * v, p.y + v * p.b, p.z + p.rz * v], (k * 2 + e) * 3);
    });
    for (let k = 0; k < n; k++) idx.set([k * 2, k * 2 + 2, k * 2 + 1, k * 2 + 1, k * 2 + 2, k * 2 + 3], k * 6);
    out.push(this.world.createCollider(R.ColliderDesc.trimesh(vtx, idx).setFriction(1).setRestitution(0)));
    for (let k = 0; k < n; k += 2) {
      const p = pts[k], q = pts[Math.min(k + 2, n)];
      const dx = q.x - p.x, dz = q.z - p.z, len = Math.hypot(dx, dz);
      const th = Math.atan2(-dz, dx);
      for (const side of [-1, 1]) {
        const v = side * (hw - 0.3);
        out.push(this.world.createCollider(R.ColliderDesc.cuboid(len / 2 + 0.2, 0.6, 0.15)
          .setTranslation((p.x + q.x) / 2 + p.rx * v, (p.y + q.y) / 2 + v * p.b + 0.6, (p.z + q.z) / 2 + p.rz * v)
          .setRotation({ x: 0, y: Math.sin(th / 2), z: 0, w: Math.cos(th / 2) })
          .setFriction(0.3)));
      }
    }
    return out;
  }

  _drop(c) {
    if (!c.object) return;
    this.scene.remove(c.object);
    c.object.traverse((m) => { if (m.isMesh) m.geometry.dispose(); });
    c.object = null;
    if (this.world) for (const col of c.colliders || []) this.world.removeCollider(col, false);
    c.colliders = null;
  }

  dispose() {
    this._job = null;
    for (const c of this.spans) this._drop(c);
    for (const m of this._steel.values()) m.dispose();
  }
}

const key = (i, j) => i * 73856093 ^ j * 19349663;
