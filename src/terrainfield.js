/**
 * terrainfield.js — the ground as a pure function of world position.
 *
 * ── why this exists ─────────────────────────────────────────────────────────
 *
 * The terrain used to be generated in ROAD space: rows of vertices fanned out
 * sideways from the centreline, 700 m each way, one sheet per 120 m chunk. That
 * parameterisation degenerates by construction — rows converge on the inside
 * of every bend and diverge on the outside — and three separate guards (the
 * fold guard, the relaxed heading, the world-space apron underneath) were
 * spent holding it together. From the road it mostly held. From any height it
 * did not: neighbouring chunks' sheets crossed each other, folded strips showed
 * as dark creases, and the world visibly ended at the sheet edge (see
 * `probe/vista.mjs`).
 *
 * The fix is to stop asking the road where the ground is. Here the ground is
 * `height(x, z)`: the natural surface from `noise.js`, clamped to the road by a
 * DISTANCE FIELD to the road rather than by a lateral coordinate. A function of
 * world position cannot fold, cannot overlap itself and cannot leave a gap; the
 * mesh that samples it (`worldtiles.js`) is a plain grid. That is the standard
 * answer for streamed procedural terrain — chunked LOD / geometry clipmaps over
 * a heightfield — and the road becomes something cut INTO the field rather than
 * the coordinate system it is built in.
 *
 * ── the carve ───────────────────────────────────────────────────────────────
 *
 * Exactly the cut-and-fill rule the road-space sheet used (`ROAD.cutSlope`,
 * `fillSlope`, `shoulderRound`, `slopeBlend`, the ditch), evaluated with the
 * DISTANCE to the nearest point of the centreline instead of `|v|`.
 *
 * Where the route doubles back, more than one pass of the road is in range. Each
 * pass produces its own clamped height and the results are blended with weights
 * that fall off exponentially with distance (`CARVE_FALLOFF`). On a carriageway
 * the own pass's weight dominates the next one (≥ 160 m away by the router's
 * self-clearance invariant) by e^-13, so the road is exact; between two passes
 * the blend is smooth, so there is no seam where "nearest road" switches. This
 * replaces the foreign-segment clamp and every bug it accumulated (#55, #57, #60).
 *
 * The octave budget of `noise.js:height` is keyed on distance from the road, as
 * it always was — so the field is identical at every mesh resolution and a tile
 * changing level of detail changes only how finely it samples, never the shape.
 */

import * as THREE from 'three';
import { ROAD, CHUNK, WATER } from './config.js';
import { clamp, smoothstep, smin, smax, hashInt, mulberry32 } from './util.js';

const EDGE = ROAD.halfWidth + ROAD.shoulder;
const UP = new THREE.Vector3(0, 1, 0);

/** Below this, a pass is refined against the dense spline samples. */
const NEAR = 96;
/** Beyond this no road influences the ground. */
const FAR = 650;
/** Metres over which another pass's weight falls by e. */
const CARVE_FALLOFF = 12;
/** Dense spatial-hash cell, metres. */
const DCELL = 32;
/** Coarse (control-point) spatial-hash cell, metres. */
const CCELL = 200;
/** The terrain sits this far under the paved lanes; the road ribbon has its own collider. */
export const ROAD_SINK = 0.16;

const key = (i, j) => i * 73856093 ^ j * 19349663;

export class TerrainField {
  /**
   * @param {object} terrain `noise.js:createTerrain` result
   * @param {import('./path.js').RoadPath} path
   */
  constructor(terrain, path, seed = 1) {
    this.terrain = terrain;
    this.path = path;
    this.seed = seed;
    this._dense = new Map();     // cell -> [sample index, ...]
    this._denseUpTo = 0;         // samples indexed (segments [i, i+1] for i < this)
    this._coarse = new Map();    // cell -> [ctrl index, ...]
    this._coarseUpTo = 0;
    this._frame = null;
    this._passes = [];
    for (let i = 0; i < 8; i++) this._passes.push({ d: Infinity, j: 0, t: 0, y: 0, dense: false });
    this._nPass = 0;
    this._cand = [];
    /** Listeners told the bounding box of every newly indexed stretch of road. */
    this.onGrow = [];
    this.lakes = new Lakes(this, seed);
  }

  // ------------------------------------------------------------ indexing --

  /** Index any road generated since the last call. Cheap when nothing changed. */
  sync() {
    const path = this.path;
    const pts = path.pts;
    const upTo = Math.max(0, path.framedUpTo);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = this._denseUpTo; i < upTo; i++) {
      const a = pts[i].p, b = pts[i + 1].p;
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
      const z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z);
      for (let ci = Math.floor(x0 / DCELL); ci <= Math.floor(x1 / DCELL); ci++) {
        for (let cj = Math.floor(z0 / DCELL); cj <= Math.floor(z1 / DCELL); cj++) {
          const k = key(ci, cj);
          let cell = this._dense.get(k);
          if (!cell) { cell = []; this._dense.set(k, cell); }
          cell.push(i);
        }
      }
      if (x0 < minX) minX = x0; if (z0 < minZ) minZ = z0;
      if (x1 > maxX) maxX = x1; if (z1 > maxZ) maxZ = z1;
    }
    if (upTo > this._denseUpTo) {
      this._denseUpTo = upTo;
      this.lakes.recheck(minX, minZ, maxX, maxZ);
      for (const fn of this.onGrow) fn(minX, minZ, maxX, maxZ);
    }
    const ctrl = path.ctrl;
    for (let i = this._coarseUpTo; i < ctrl.length - 1; i++) {
      const a = ctrl[i], b = ctrl[i + 1];
      for (let ci = Math.floor(Math.min(a.x, b.x) / CCELL); ci <= Math.floor(Math.max(a.x, b.x) / CCELL); ci++) {
        for (let cj = Math.floor(Math.min(a.z, b.z) / CCELL); cj <= Math.floor(Math.max(a.z, b.z) / CCELL); cj++) {
          const k = key(ci, cj);
          let cell = this._coarse.get(k);
          if (!cell) { cell = []; this._coarse.set(k, cell); }
          cell.push(i);
        }
      }
    }
    this._coarseUpTo = Math.max(this._coarseUpTo, ctrl.length - 1);
  }

  /**
   * Every pass of the road within FAR of (x, z), nearest point of each, into
   * `this._passes[0.._nPass)`. Near passes are measured against the dense
   * spline samples (centimetre-accurate); far ones against the control
   * polyline, whose chord error (≤ 1.6 m) is irrelevant hundreds of metres out.
   */
  /**
   * Precompute the candidate road segments for every point of a rectangle, so
   * a tile's thousand samples share one spatial lookup. `endRegion()` after.
   */
  beginRegion(x0, z0, x1, z1) {
    const dense = [];
    this._collect(this._dense, DCELL, x0 - NEAR, z0 - NEAR, x1 + NEAR, z1 + NEAR, dense);
    const coarse = [];
    this._collect(this._coarse, CCELL, x0 - FAR, z0 - FAR, x1 + FAR, z1 + FAR, coarse);
    this._region = { x0, z0, x1, z1, dense, coarse };
  }

  endRegion() { this._region = null; }

  _collect(map, cell, x0, z0, x1, z1, out) {
    out.length = 0;
    for (let ci = Math.floor(x0 / cell); ci <= Math.floor(x1 / cell); ci++) {
      for (let cj = Math.floor(z0 / cell); cj <= Math.floor(z1 / cell); cj++) {
        const c = map.get(key(ci, cj));
        if (c) for (let n = 0; n < c.length; n++) out.push(c[n]);
      }
    }
    out.sort((a, b) => a - b);
    // dedupe in place
    let w = 0;
    for (let n = 0; n < out.length; n++) if (n === 0 || out[n] !== out[n - 1]) out[w++] = out[n];
    out.length = w;
    return out;
  }

  _gather(x, z) {
    const R = this._region;
    if (R && x >= R.x0 && x <= R.x1 && z >= R.z0 && z <= R.z1) return this._gatherFrom(x, z, R.dense, R.coarse);
    this._collect(this._dense, DCELL, x - NEAR, z - NEAR, x + NEAR, z + NEAR, this._cand);
    const dense = this._cand;
    this._cand2 = this._cand2 || [];
    this._collect(this._coarse, CCELL, x - FAR, z - FAR, x + FAR, z + FAR, this._cand2);
    return this._gatherFrom(x, z, dense, this._cand2);
  }

  /** `dense`/`coarse` are sorted, de-duplicated segment indices. */
  _gatherFrom(x, z, dense, coarse) {
    const pts = this.path.pts;
    let np = 0;
    const NEAR2 = (NEAR + 2) * (NEAR + 2);
    {
      let last = -1e9, cur = null;
      for (let n = 0; n < dense.length; n++) {
        const i = dense[n];
        const a = pts[i].p, b = pts[i + 1].p;
        // cheap reject before the projection
        const ax = a.x - x, az = a.z - z;
        if (ax * ax + az * az > NEAR2 + 50) { continue; }
        if (i - last > 20 || !cur) {
          if (np >= this._passes.length) break;
          cur = this._passes[np++];
          cur.d = Infinity; cur.dense = true;
        }
        last = i;
        const ex = b.x - a.x, ez = b.z - a.z;
        const len2 = ex * ex + ez * ez;
        let t = len2 > 1e-9 ? (-ax * ex - az * ez) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = ax + ex * t, dz = az + ez * t;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < cur.d) { cur.d = d; cur.j = i; cur.t = t; }
      }
      let w = 0;
      for (let n = 0; n < np; n++) if (this._passes[n].d <= NEAR) {
        if (w !== n) { const tmp = this._passes[w]; this._passes[w] = this._passes[n]; this._passes[n] = tmp; }
        w++;
      }
      np = w;
    }
    const ctrl = this.path.ctrl;
    const FAR2 = (FAR + 50) * (FAR + 50);
    {
      let last = -1e9, cur = null;
      for (let n = 0; n < coarse.length; n++) {
        const i = coarse[n];
        const a = ctrl[i], b = ctrl[i + 1];
        const ax = a.x - x, az = a.z - z;
        if (ax * ax + az * az > FAR2) continue;
        if (i - last > 2 || !cur) {
          if (np >= this._passes.length) break;
          cur = this._passes[np++];
          cur.d = Infinity; cur.dense = false;
        }
        last = i;
        const ex = b.x - a.x, ez = b.z - a.z;
        const len2 = ex * ex + ez * ez;
        let t = len2 > 1e-9 ? (-ax * ex - az * ez) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = ax + ex * t, dz = az + ez * t;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < cur.d) { cur.d = d; cur.j = i; cur.t = t; cur.y = a.y + (b.y - a.y) * t; }
      }
    }
    let w = 0;
    for (let n = 0; n < np; n++) {
      const p = this._passes[n];
      if (!p.dense && (p.d < NEAR - 4 || p.d > FAR)) continue;
      if (w !== n) { const tmp = this._passes[w]; this._passes[w] = p; this._passes[n] = tmp; }
      w++;
    }
    this._nPass = w;
    return w;
  }

  /** Distance from (x, z) to the nearest carriageway centreline, metres (≤ FAR). */
  roadDistance(x, z) {
    const n = this._gather(x, z);
    let d = FAR;
    for (let i = 0; i < n; i++) if (this._passes[i].d < d) d = this._passes[i].d;
    return d;
  }

  // -------------------------------------------------------------- height --

  /**
   * The ground at (x, z). Writes `{y, natural, d, s, v}` into `out` when given:
   * `d` distance to the nearest centreline, `s`/`v` that road's station and
   * signed lateral offset (NaN if no road is within NEAR).
   */
  sample(x, z, out) {
    // Settle any lake here FIRST: settling asks roadDistance(), which reuses
    // the pass buffer this call is about to fill.
    this.lakes.at(x, z);
    const n = this._gather(x, z);
    let dMin = FAR;
    for (let i = 0; i < n; i++) if (this._passes[i].d < dMin) dMin = this._passes[i].d;

    // Octave budget keyed on road distance, exactly as the road-space sheet
    // keyed it on |v| — so the field is resolution-independent.
    const natural0 = this.terrain.height(x, z, dMin);
    const natural = this.lakes.carve(x, z, natural0, dMin);

    let num = 0, den = 0, sOut = NaN, vOut = NaN;
    for (let i = 0; i < n; i++) {
      const P = this._passes[i];
      let yRoad, av = P.d, bankY = 0, sink = 0;
      if (P.dense) {
        const pts = this.path.pts;
        const a = pts[P.j], b = pts[P.j + 1];
        const s = a.s + (b.s - a.s) * P.t;
        const f = this.path.frameAt(s, this._frameScratch());
        const rx = -f.tan.z, rz = f.tan.x;           // tan × up, flattened — chunks.js's rightFlat
        const rl = Math.hypot(rx, rz) || 1;
        const v = ((x - f.pos.x) * rx + (z - f.pos.z) * rz) / rl;
        av = Math.abs(v);
        const bankFade = 1 - smoothstep(EDGE, EDGE + CHUNK.bankRunout, av);
        bankY = v * Math.tan(f.bank) * bankFade;
        yRoad = f.pos.y + bankY;
        sink = ROAD_SINK * (1 - smoothstep(ROAD.halfWidth - 0.6, ROAD.halfWidth + 0.9, av));
        if (P.d === dMin) { sOut = s; vOut = v; }
      } else {
        yRoad = P.y;
      }

      const t = Math.max(0, av - EDGE);
      const ramp = (t * t) / (t + ROAD.shoulderRound);
      const ceiling = yRoad + ROAD.cutSlope * ramp;
      const floorY = yRoad - ROAD.fillSlope * ramp;
      const k = Math.min(ROAD.slopeBlend, (ceiling - floorY) * 0.25);
      let y = smax(smin(natural, ceiling, k), floorY, k);

      const dt = clamp((av - EDGE) / CHUNK.ditchWidth, 0, 1);
      if (dt > 0 && dt < 1) {
        const fit = 1 - smoothstep(1.5, 8.0, Math.abs(natural - yRoad));
        y -= CHUNK.ditchDepth * Math.sin(Math.PI * dt) * fit;
      }
      y -= sink;

      const w = Math.exp(-(P.d - dMin) / CARVE_FALLOFF);
      num += w * y;
      den += w;
    }
    const y = den > 0 ? num / den : natural;
    if (out) {
      out.y = y; out.natural = natural; out.d = dMin; out.s = sOut; out.v = vOut;
    }
    return y;
  }

  height(x, z) { return this.sample(x, z, null); }

  _frameScratch() {
    if (!this._frame) {
      this._frame = {
        pos: new THREE.Vector3(), tan: new THREE.Vector3(), right: new THREE.Vector3(),
        up: new THREE.Vector3(), bank: 0, curv: 0, foldL: 0, foldR: 0,
        relaxDev: 0, relaxL: 0, relaxR: 0, s: 0,
      };
    }
    return this._frame;
  }
}

/**
 * Lakes — still water in natural basins.
 *
 * A lake is seeded on a hashed grid (`WATER.cell` metres): at most one per
 * cell, at a jittered centre, kept with a probability the BIOME sets
 * (`biomes.js:lakeChance`, wetter country holds more water). Its shoreline is
 * a radius modulated by two low harmonics of a seeded angle function, so no two
 * are the same shape and none is a circle.
 *
 * The water level is the natural ground at the centre minus a little, and the
 * basin is CARVED: inside the shoreline the ground is pulled down below the
 * level on a smooth profile, so the lake has a bed and a beach rather than a
 * plane intersecting a hillside. Lakes are refused where any road comes within
 * `WATER.roadClear` of the shore — the road's own carve is never asked to
 * fight a lake for the same ground.
 */
export class Lakes {
  constructor(field, seed) {
    this.field = field;
    this.seed = seed >>> 0;
    this.cache = new Map();
    this.biomeChance = null;    // set by chunks.js: (x, z) -> 0..1
  }

  /** The lake seeded in grid cell (ci, cj), or null. Memoised. */
  lakeIn(ci, cj) {
    const k = ci + ',' + cj;
    if (this.cache.has(k)) return this.cache.get(k);
    let lake = null;
    if (WATER.enabled) {
      const rng = mulberry32(hashInt(ci * 92821 + cj * 68917 + this.seed));
      const cx = (ci + 0.2 + 0.6 * rng()) * WATER.cell;
      const cz = (cj + 0.2 + 0.6 * rng()) * WATER.cell;
      const chance = this.biomeChance ? this.biomeChance(cx, cz) : WATER.chance;
      const roll = rng();
      const r = WATER.radius[0] + (WATER.radius[1] - WATER.radius[0]) * rng() * rng();
      const harm = [rng() * 0.22, rng() * 6.28, rng() * 0.14, rng() * 6.28, rng() * 0.08, rng() * 6.28];
      if (roll < chance) {
        lake = { cx, cz, r, harm, level: 0, ok: false, checked: false };
      }
    }
    this.cache.set(k, lake);
    return lake;
  }

  /** Shoreline radius of `lake` toward angle `a`. */
  radiusAt(lake, a) {
    const h = lake.harm;
    return lake.r * (1 + h[0] * Math.sin(2 * a + h[1]) + h[2] * Math.sin(3 * a + h[3]) + h[4] * Math.sin(5 * a + h[5]));
  }

  /**
   * Settles a lake against the road and the land, once. Needs the road to be
   * indexed around it, so it runs lazily on first use.
   */
  _settle(lake) {
    if (lake.checked) return lake.ok;
    lake.checked = true;
    const f = this.field;
    const t = f.terrain;
    // Road clearance: sample the shoreline.
    const rMax = lake.r * 1.45;
    if (f.roadDistance(lake.cx, lake.cz) < rMax + WATER.roadClear) { lake.ok = false; return false; }
    // The level sits a little under the lowest of the centre and its ring, so
    // the water fills the basin rather than hanging on a slope.
    let lo = t.height(lake.cx, lake.cz, 400);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const rr = this.radiusAt(lake, a) * 0.8;
      lo = Math.min(lo, t.height(lake.cx + Math.cos(a) * rr, lake.cz + Math.sin(a) * rr, 400));
    }
    lake.level = lo - 0.6;
    // A lake needs a BASIN. On a hillside the ring's uphill side stands tens
    // of metres over the level, and carving to it leaves a crater wall.
    let hi = -Infinity;
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2 + 0.3;
      const rr = this.radiusAt(lake, a) * 1.25;
      hi = Math.max(hi, t.height(lake.cx + Math.cos(a) * rr, lake.cz + Math.sin(a) * rr, 400));
    }
    if (hi - lake.level > WATER.maxRim) { lake.ok = false; return false; }
    lake.ok = true;
    return true;
  }

  /** The lake (settled) whose basin contains (x, z), or null. */
  at(x, z) {
    if (!WATER.enabled) return null;
    const ci0 = Math.floor(x / WATER.cell), cj0 = Math.floor(z / WATER.cell);
    for (let ci = ci0 - 1; ci <= ci0 + 1; ci++) {
      for (let cj = cj0 - 1; cj <= cj0 + 1; cj++) {
        const lake = this.lakeIn(ci, cj);
        if (!lake) continue;
        const dx = x - lake.cx, dz = z - lake.cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > (lake.r * 1.45 + WATER.beach) ** 2) continue;
        if (!this._settle(lake)) continue;
        return lake;
      }
    }
    return null;
  }

  /** Distance from the centre of the lake at (x, z) over its shoreline radius; Infinity if none. */
  shoreU(x, z) {
    const lake = this.at(x, z);
    if (!lake) return Infinity;
    const dx = x - lake.cx, dz = z - lake.cz;
    return Math.sqrt(dx * dx + dz * dz) / this.radiusAt(lake, Math.atan2(dz, dx));
  }

  /**
   * New road was generated in this box: any lake near it must be re-checked
   * against it (it may now be too close and has to go).
   */
  recheck(x0, z0, x1, z1) {
    for (const lake of this.cache.values()) {
      if (!lake || !lake.checked) continue;
      const m = lake.r * 1.45 + WATER.roadClear + WATER.beach;
      if (lake.cx + m < x0 || lake.cx - m > x1 || lake.cz + m < z0 || lake.cz - m > z1) continue;
      lake.checked = false;
    }
  }

  /**
   * Natural height with any lake basin carved into it. `u` = distance from
   * the centre over the shoreline radius: < 1 is underwater.
   */
  carve(x, z, natural, roadD) {
    if (!WATER.enabled || roadD < WATER.roadClear * 0.5) return natural;
    const lake = this.at(x, z);
    if (!lake) return natural;
    const dx = x - lake.cx, dz = z - lake.cz;
    const r = this.radiusAt(lake, Math.atan2(dz, dx));
    const u = Math.sqrt(dx * dx + dz * dz) / r;
    // Bed: deepest in the middle, rising to the waterline at u = 1.
    const bed = lake.level - WATER.depth * (1 - smoothstep(0.0, 1.0, u)) - 0.35;
    // Beach: from just under the waterline at the shore up to the natural
    // ground over `WATER.beach` metres, so every shoreline is a gentle shelf.
    const shore = 1 + WATER.beach / r;
    if (u >= shore) return natural;
    const target = u < 1 ? bed : lake.level - 0.35 + (u - 1) / (shore - 1) * 1.6;
    // Never RAISE ground into a lake (a basin in a hollow stays a hollow).
    const blend = smoothstep(shore, 1, u);
    const carved = Math.min(natural, target);
    return natural + (carved - natural) * blend;
  }
}
