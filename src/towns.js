/**
 * towns.js — cities on the horizon, built by City-gen (`city_gen/`).
 *
 * The road is cut into `TOWNS.slot`-metre slots and each slot rolls, from the
 * seed alone, a CITY (`TOWNS.cityChance`): a whole City-gen layout far off
 * beside the road, never on it. A roll that finds no room (a lake, another
 * road, land too broken to level) is simply nothing. (Hamlets and villages
 * along the road were removed: no settlement touches the road itself.)
 *
 * A city needs level ground, and the ground is a pure function of position
 * (terrainfield.js), so a city is a term in that function: `carve()` pulls
 * the natural surface to one level under it, blending back over `cityBlend`.
 * The plan is made when the road is generated, before the tiles there are
 * built; anything already built is rebuilt (`onChange`). `clear()` is how much
 * of a place a city owns, and the vegetation field (foliage.js) plants
 * nothing there.
 *
 * The buildings are generated in a worker (`env/towns.worker.js`) and come
 * back as merged, vertex-coloured buffers: two draw calls a city. Windows
 * glow at night (`setNight`).
 *
 * No colliders, like the trees.
 */
import * as THREE from 'three';
import { TOWNS, TILES } from './config.js';
import { smoothstep, hashInt, mulberry32 } from './util.js';
import { buildTown } from './env/towns.worker.js';

/** Spatial index cell for `carve`/`clear`, metres. */
const CELL = 512;
/** A city's ground sits this far under its asphalt: 5 cm z-fights 700 m away. */
const CITY_SINK = 0.6;

const range = (rng, [a, b]) => a + (b - a) * rng();

export class Towns {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {import('./path.js').RoadPath} o.path
   * @param {import('./terrainfield.js').TerrainField} o.field
   * @param {object} o.terrain noise.js terrain
   * @param {(x0, z0, x1, z1) => void} o.onChange the ground changed in this box
   */
  constructor({ scene, path, field, terrain, onChange = () => {} }) {
    this.scene = scene;
    this.path = path;
    this.field = field;
    this.terrain = terrain;
    this.onChange = onChange;
    this.seed = field.seed >>> 0;
    /** Every settlement planned so far, in road order. Plans are tiny and kept: the ground depends on them. */
    this.list = [];
    this.next = 1;               // slot 0 is the title screen's road
    this._cells = new Map();
    this._cellKey = null;
    this._cellList = null;
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

  /** The natural ground at (x, z) with every city's levelling applied. */
  carve(x, z, y) {
    const list = this._at(x, z);
    if (!list) return y;
    for (let n = 0; n < list.length; n++) {
      const t = list[n];
      const B = t.box;
      if (x < B[0] || z < B[1] || x > B[2] || z > B[3]) continue;
      const m = 1 - smoothstep(0, t.blend, this._cityOut(t, x, z));
      y += (t.level - CITY_SINK - y) * m;
    }
    return y;
  }

  /** How much of (x, z) a city occupies, 0..1: nothing grows where it is 1. */
  clear(x, z) {
    const list = this._at(x, z);
    if (!list) return 0;
    let c = 0;
    for (let n = 0; n < list.length; n++) {
      const t = list[n];
      const B = t.box;
      if (x < B[0] || z < B[1] || x > B[2] || z > B[3]) continue;
      const k = 1 - smoothstep(0, 25, this._cityOut(t, x, z));
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
    if (rng() < TOWNS.cityChance) this._planCity(k, rng);
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
      // Clear of every other city's levelling too: overlapping, the later
      // one levels the earlier one's streets to its own height.
      if (this.list.some((u) => Math.hypot(u.cx - t.cx, u.cz - t.cz) < u.radius + r)) continue;
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
    const msg = { id: ++this._id, kind: 'city', size: t.size, seed: t.seed, density: t.density };
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
    const L = levels[0];
    const obj = new THREE.Group();
    for (const [P, mat] of [[L.solid, this.solid], [L.glass, this.glass]]) {
      if (!P) continue;
      const mesh = new THREE.Mesh(geometry(P), mat);
      mesh.receiveShadow = true;
      obj.add(mesh);
    }
    obj.position.copy(t.origin);
    obj.rotation.y = t.angle;
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
