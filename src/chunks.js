/**
 * chunks.js — streaming terrain, road ribbon, colliders and props.
 *
 * Terrain is generated in road space: a chunk is a strip of the spline at
 * arc length u with lateral offset v. This carves the corridor, keeps seams
 * exact, and streams the ring of chunks with the car.
 */

import * as THREE from 'three';
import { CHUNK, ROAD, ROUTE, GRASS, GROUND, ROCKS, TREES, BUSHES, TERRAIN_COLORS, TILES } from './config.js';
import { clamp, lerp, smoothstep, smin, smax, mulberry32, hashInt } from './util.js';
import {
  FOLIAGE, SHRUBS, TREE_NAMES, SHRUB_NAMES, vegetation, suitability, guildAffinity, setEcology,
} from './foliage.js';
import { createBiomes, BIOMES } from './biomes.js';
import { makeFrame } from './path.js';
import { createGrassAssets } from './env/grass.js';
import { createGroundAssets } from './env/ground.js';
import { createRoadAssets } from './env/road.js';
import { createRockAssets } from './env/rocks.js';
import { createTreeAssets } from './env/trees.js';
import { createBushAssets } from './env/bushes.js';
import { TerrainField, ROAD_SINK } from './terrainfield.js';
import { PERF } from './perf.js';
import { WorldTiles } from './worldtiles.js';
import { WaterSystem } from './env/water.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const ROAD_LIFT = 0.035;

function dashOn(s, half) {
  return Math.floor(s / half) % 2 === 0;
}

const EDGE = ROAD.halfWidth + ROAD.shoulder;

function buildLateralOffsets() {
  // Every entry derived and strictly increasing: a literal would break the
  // sort the binary search below assumes.
  const half = [
    0, ROAD.laneWidth * 0.5, ROAD.laneWidth, ROAD.laneWidth * 1.5,
    ROAD.halfWidth, ROAD.halfWidth + 0.9, EDGE, EDGE + 1.4, EDGE + 2.8,
  ];
  let v = half[half.length - 1];

  // Drivable band: uniform, and no coarser than the longitudinal rows.
  while (v < CHUNK.nearBand) {
    v = Math.min(v + CHUNK.nearStep, CHUNK.nearBand);
    half.push(v);
  }

  // Beyond the near band: geometric, capped at 6 m. This grid is no longer
  // DRAWN (the ground is `worldtiles.js`); it is the scatter's sampling grid,
  // so it only has to reach as far as anything is planted from it, and be fine
  // enough that a tuft interpolated on it sits on the drawn surface.
  let step = CHUNK.nearStep;
  while (v < CHUNK.scatterExtent) {
    step = Math.min(step * 1.18, 6);
    v = Math.min(v + step, CHUNK.scatterExtent);
    half.push(v);
  }

  const left = half.slice(1).reverse().map((x) => -x);
  return left.concat(half);
}

const ASPHALT = 0;
const PAINT = 1;
const CENTER = 2;
function buildRoadColumns() {
  const hw = ROAD.halfWidth;
  const lane = ROAD.laneWidth;
  const w = 0.2;          // painted line width
  const gap = 0.16;       // between the two centre lines

  // Duplicated v positions give each painted stripe a hard edge; without the
  // duplicate, vertex colours smear the line across the whole lane.
  const cols = [];
  const push = (v, kind) => cols.push({ v, kind });

  // Skirt: the edge again, dropped, so the ribbon never shows a gap against
  // the terrain beside it from any angle.
  cols.push({ v: -hw, kind: ASPHALT, drop: 0.45 });
  push(-hw, PAINT);                       // left edge line
  push(-hw + w, PAINT);
  push(-hw + w, ASPHALT);

  push(-lane - w * 0.5, ASPHALT);         // outer lane divider, dashed
  push(-lane - w * 0.5, CENTER);
  push(-lane + w * 0.5, CENTER);
  push(-lane + w * 0.5, ASPHALT);

  push(-gap - w, ASPHALT);                // solid double line down the middle
  push(-gap - w, PAINT);
  push(-gap, PAINT);
  push(-gap, ASPHALT);
  push(gap, ASPHALT);
  push(gap, PAINT);
  push(gap + w, PAINT);
  push(gap + w, ASPHALT);

  push(lane - w * 0.5, ASPHALT);          // near-side lane divider, dashed
  push(lane - w * 0.5, CENTER);
  push(lane + w * 0.5, CENTER);
  push(lane + w * 0.5, ASPHALT);

  push(hw - w, ASPHALT);                  // right edge line
  push(hw - w, PAINT);
  push(hw, PAINT);
  cols.push({ v: hw, kind: ASPHALT, drop: 0.45 });

  // Wear across each lane, as geometry columns so the vertex colour carries
  // it: the two wheel paths polished a little lighter, and a dark oil strip
  // down the middle where engines drip. Lane centres are at ±lane/2 and
  // ±lane·1.5; none of these offsets lands on a painted line.
  const tones = [];
  for (const c of [lane * 0.5, lane * 1.5]) {
    for (const sgn of [-1, 1]) {
      tones.push({ v: sgn * c, tone: 0.80 });            // oil strip
      tones.push({ v: sgn * c - 0.42, tone: 0.97 });
      tones.push({ v: sgn * c + 0.42, tone: 0.97 });
      tones.push({ v: sgn * c - 0.86, tone: 1.08 });     // wheel paths
      tones.push({ v: sgn * c + 0.86, tone: 1.08 });
    }
  }
  for (const t of tones) {
    if (Math.abs(t.v) > hw - w - 0.05) continue;
    let i = 0;
    while (i < cols.length && cols[i].v <= t.v) i++;
    // Never split a painted stripe: only insert between asphalt columns.
    if (i > 0 && cols[i - 1].kind !== ASPHALT) continue;
    cols.splice(i, 0, { v: t.v, kind: ASPHALT, tone: t.tone });
  }
  return cols;
}

/**
 * Guards the road-space parameterisation against folding.
 *
 * Rows of vertices fan out sideways from the spline, so on a bend they radiate
 * from the curve's centre of rotation, which sits R = 1/|curvature| from the
 * axis on the INSIDE of the turn. A vertex past that point folds the mesh
 * through itself. `foldL`/`foldR` are the two limits, built from the actual
 * frame-to-frame rotation (see `path.js:_buildFoldLimits`).
 */
const FOLD_P = 6;
/** Scratch for `lateralAt`, which runs once per sheet vertex. */
const _latDir = new THREE.Vector3();
/** Scratch for the apron's road clamp. */
const _apronRoad = { dist: Infinity, y: 0 };

function foldSafeOffset(v, k) {
  if (k < 1e-7) return v;

  const L = ROUTE.foldMargin / k;
  const u = Math.abs(v) / L;
  // Below ~0.4*L the correction is under a part in a thousand; skipping it
  // there keeps a pow() out of the hot path.
  if (u < 0.4) return v;
  return v / Math.pow(1 + Math.pow(u, FOLD_P), 1 / FOLD_P);
}

/**
 * Where the sheet's column `v` actually goes, and along what direction.
 * Writes a unit XZ direction into `outDir` and returns the offset to travel
 * along it.
 */
function lateralAt(frame, rightFlat, v, outDir) {
  const av = Math.abs(v);
  const k = v < 0 ? frame.foldL : frame.foldR;
  const kr = v < 0 ? frame.relaxL : frame.relaxR;

  // b is a function of the offset ALONE, and that is load-bearing: the
  // direction's turn rate is (1-b)*kappa + b*kappaRelaxed + (db/ds)*relaxDev,
  // and a schedule in |v| has db/ds = 0 identically.
  const b = smoothstep(CHUNK.relaxBand[0], CHUNK.relaxBand[1], av);

  if (b <= 0) {
    outDir.copy(rightFlat);
    return foldSafeOffset(v, k);
  }

  const a = b * (frame.relaxDev || 0);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  // right(theta) is (cos theta, 0, sin theta), so advancing the heading by `a`
  // is this rotation of the flat lateral vector.
  outDir.set(rightFlat.x * ca - rightFlat.z * sa, 0, rightFlat.x * sa + rightFlat.z * ca);
  return foldSafeOffset(v, (1 - b) * k + b * kr);
}

export class ChunkManager {
  constructor({ scene, world, RAPIER, path, terrain, anisotropy = 1 }) {
    this.scene = scene;
    this.anisotropy = anisotropy;
    this.world = world;
    this.RAPIER = RAPIER;
    this.path = path;
    this.terrain = terrain;

    this.lateral = buildLateralOffsets();
    this.roadCols = buildRoadColumns();
    this.chunks = new Map();
    this.pending = [];
    this.propQueue = [];
    /** Seconds since boot, for the wind. Advanced by the game loop. */
    this.time = 0;

    this._frame = makeFrame();
    this._rightFlat = new THREE.Vector3();
    this._propFrame = makeFrame();
    this._propRight = new THREE.Vector3();
    this._cA = new THREE.Vector3();
    this._cB = new THREE.Vector3();
    this._cC = new THREE.Vector3();
    this._cD = new THREE.Vector3();
    this._mat = new THREE.Matrix4();
    this._quat = new THREE.Quaternion();
    this._pos = new THREE.Vector3();
    this._scl = new THREE.Vector3();
    this._color = new THREE.Color();
    // Cached per row because this is a pure function of `s`; sampling out of row
    // order re-gathers and gets the identical answer, which keeps seams exact.
    this._foreign = { s: NaN, n: 0, list: [] };
    /** Reused by every call to `foliage.js:vegetation`; the grass scatter asks it once per cell. */
    this._field = {};
    /** Coarse field cache, cleared per grass chunk. See `_buildGrass`. */
    this._coverMemo = new Map();
    this._grassLow = new THREE.Color(TERRAIN_COLORS.grassLow);
    this._grassHigh = new THREE.Color(TERRAIN_COLORS.grassHigh);
    this._grassDeep = new THREE.Color(TERRAIN_COLORS.grassDeep);
    this._grassDry = new THREE.Color(TERRAIN_COLORS.grassDry);
    this._scrub = new THREE.Color(TERRAIN_COLORS.scrub);
    this._rock = new THREE.Color(TERRAIN_COLORS.rock);
    this._peak = new THREE.Color(TERRAIN_COLORS.peak);
    this._dirt = new THREE.Color(TERRAIN_COLORS.dirt);
    this._snow = new THREE.Color(TERRAIN_COLORS.snow);

    this._buildSharedAssets();

    /**
     * The ground: a pure function of world position (terrainfield.js), drawn
     * as world-space LOD tiles (worldtiles.js). Replaces the road-space sheets
     * and the apron under them — see terrainfield.js for why.
     */
    this.field = new TerrainField(terrain, path, hashInt(Math.round(terrain.continent(0, 0) * 1000)));
    // The road carve changes the field near new road: drop cached scatter heights.
    this.field.onGrow.push(() => { if (this._gyCache) this._gyCache.clear(); });
    this.tiles = new WorldTiles({
      scene, field: this.field, material: this.matTerrain, world, RAPIER,
      color: (x, z, y, ny, d, out) => this._groundColor(x, z, y, ny, d, out),
    });
    /** Where the tiles are centred. main.js points this at the car; null = the road at carS. */
    this.focus = null;

    /** What kind of country each place is (biomes.js) — read by every scatter. */
    this.biomes = createBiomes(terrain, this.field.seed);
    this.field.lakes.biomeChance = (x, z) => this.biomes.mix(this.biomes.biomeAt(x, z), 'lake');
    setEcology(this.biomes, (x, z) => this.field.lakes.shoreU(x, z));
    this._tint = [1, 1, 1];
    /** Lake surfaces (env/water.js). */
    this.water = new WaterSystem({ scene, field: this.field });
    this._sand = new THREE.Color(TERRAIN_COLORS.sand);
    this._mud = new THREE.Color(TERRAIN_COLORS.mud);

    // A tier is a plain descriptor; everything that differs is a number, so
    // `_buildGrass` is one function.
    this.rockQueue = [];
    this.canopyQueue = [];
    this.sheetQueue = [];
    this.grassTiers = [];
    if (this.grass) {
      this.grassTiers.push({
        key: 'grass',
        material: this.grass.material,
        behind: GRASS.chunkRadius,
        ahead: GRASS.chunkRadius,
        halfExtent: GRASS.halfExtent,
        denseTo: GRASS.denseTo,
        farScale: GRASS.farScale,
        density: GRASS.density,
        maxSlope: GRASS.maxSlope,
        sizeMul: 1,
        widthMul: 1,
        /** Which of `vegetation()`'s densities gates this tier. */
        cover: 'ground',
        height: GRASS.height,
        widthRatio: GRASS.widthRatio,
        lift: [1.20, 1.55],
        // Offsets the per-chunk seed, so the two tiers do not land tuft-on-tuft.
        salt: 0x517cc1b7,
        reach: GRASS.fadeEnd,
        queue: [],
      });
      if (GRASS.wood.enabled && this.grass.woodMaterial) {
        // Same function, geometry and shader — the only non-number is `cover`,
        // gated on `floor` rather than `ground` (density that rises with canopy).
        const W = GRASS.wood;
        this.grassTiers.push({
          key: 'grassWood',
          material: this.grass.woodMaterial,
          behind: W.behind,
          ahead: W.ahead,
          halfExtent: W.halfExtent,
          denseTo: W.halfExtent,
          farScale: 1,
          density: W.density,
          maxSlope: W.maxSlope,
          sizeMul: 1,
          widthMul: 1,
          cover: 'floor',
          height: W.height,
          widthRatio: W.widthRatio,
          lift: W.lift,
          salt: 0x71ab39d5,
          reach: W.fadeOut[1],
          queue: [],
        });
      }
      if (GRASS.far.enabled) {
        const F = GRASS.far;
        this.grassTiers.push({
          key: 'grassFar',
          material: this.grass.farMaterial,
          behind: F.behind,
          ahead: F.ahead,
          halfExtent: F.halfExtent,
          // Constant card size across the whole band: this tier IS the middle
          // distance, so cards stay the same size instead of growing outward.
          denseTo: F.halfExtent,
          farScale: 1,
          // Area-preserving density: bigger cards cover more ground per
          // instance, so the count falls with the square of the scale.
          density: (GRASS.density * F.coverage) / (F.widthScale * F.heightScale),
          maxSlope: F.maxSlope,
          sizeMul: F.heightScale,
          // Wider than tall, so the far tier reads as ground cover.
          widthMul: F.widthScale / F.heightScale,
          cover: 'ground',
          height: GRASS.height,
          widthRatio: GRASS.widthRatio,
          lift: [1.20, 1.55],
          salt: 0x2f9e3c11,
          reach: F.fadeOut[1],
          queue: [],
        });
      }
    }
  }

  advanceTime(dt) {
    // Smoothed frame time for the streaming budget (see update()).
    this._frameMs = this._frameMs ? this._frameMs + (dt * 1000 - this._frameMs) * 0.1 : dt * 1000;
    this.time += dt;
    if (this.grass) this.grass.setTime(this.time);
    if (this.trees) this.trees.setTime(this.time);
    if (this.bushes) this.bushes.setTime(this.time);
  }

  _buildSharedAssets() {
    this.ground = createGroundAssets({ anisotropy: this.anisotropy });
    this.matTerrain = this.ground.material;
    this.apron = null;

    this.road = createRoadAssets({ anisotropy: this.anisotropy });
    this.matRoad = this.road.material;

    // Null where switched off; both come back texture-less rather than throwing
    // when there is no canvas, so the headless probes run the real scatter.
    this.trees = TREES.enabled ? createTreeAssets() : null;
    this.bushes = BUSHES.enabled ? createBushAssets() : null;

    this.grass = GRASS.enabled ? createGrassAssets({ anisotropy: this.anisotropy }) : null;

    /** Procedural stone. See env/rocks.js — texture for the verge, not scenery. */
    this.rocks = ROCKS.enabled ? createRockAssets() : null;
  }

  /**
   * Refreshes `_foreign` for the row at `frame.s`. Control-point segments, not
   * spline samples: an exact perpendicular against a 46 m polyline is both
   * closer to the truth and far cheaper than re-framing per vertex.
   */
  _gatherForeign(frame) {
    const fo = this._foreign;
    fo.s = frame.s;
    fo.n = this.path.foreignSegments(
      frame.s, frame.pos.x, frame.pos.z, CHUNK.halfExtent + 120, fo.list);
  }

  /**
   * Ground at road-space (s, v), via the frame at s. Single source of truth:
   * the drawn tiles, the scatter grid and respawn all evaluate
   * `this.field` — a function of world position only.
   */
  sampleGround(frame, rightFlat, v, out) {
    v = lateralAt(frame, rightFlat, v, _latDir);
    const x = frame.pos.x + _latDir.x * v;
    const z = frame.pos.z + _latDir.z * v;
    out.set(x, this.field.height(x, z), z);
    return out;
  }

  /**
   * Terrain height for scatter, from a 2 m world-aligned lattice of
   * `field.height` samples — the same spacing and alignment as the finest
   * terrain tiles, so near the car a prop stands on the drawn surface. Each
   * lattice point is evaluated once and cached: grass alone plants tens of
   * thousands of tufts a chunk, and a full field evaluation per tuft cost
   * ~390 ms. The cache is dropped when it grows past a few chunks' worth,
   * and whenever the road grows (the carve changes the field near it).
   * `G` is the lattice spacing: callers pass a coarser one far from the road,
   * where the tiles drawing the ground are coarse too.
   */
  _groundY(x, z, G = 2) {
    const fx = x / G, fz = z / G;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const u = fx - ix, w = fz - iz;
    const caches = this._gyCache || (this._gyCache = new Map());
    let c = caches.get(G);
    if (!c) { c = new Map(); caches.set(G, c); }
    if (c.size > 200000) c.clear();
    const at = (i, k) => {
      const key = i * 4194304 + k;
      let y = c.get(key);
      if (y === undefined) { y = this.field.height(i * G, k * G); c.set(key, y); }
      return y;
    };
    const a = at(ix, iz), b = at(ix + 1, iz), d = at(ix, iz + 1), e = at(ix + 1, iz + 1);
    return (a * (1 - u) + b * u) * (1 - w) + (d * (1 - u) + e * u) * w;
  }

  /**
   * Height of the *triangulated* surface at (s, v): the mesh is a chord across
   * each quad, so props interpolate the same triangle the renderer draws.
   */
  meshGroundPoint(s, s0, s1, v, out) {
    const nu = CHUNK.segmentsU;
    const lat = this.lateral;

    // Row indices either side of s.
    const fj = clamp(((s - s0) / (s1 - s0)) * nu, 0, nu);
    const j0 = Math.min(Math.floor(fj), nu - 1);
    const fu = fj - j0;

    // Column indices either side of v (the lateral table is non-uniform).
    let i0 = 0;
    let hi = lat.length - 1;
    while (i0 < hi - 1) {
      const mid = (i0 + hi) >> 1;
      if (lat[mid] <= v) i0 = mid;
      else hi = mid;
    }
    i0 = Math.min(i0, lat.length - 2);
    const span = lat[i0 + 1] - lat[i0];
    const fv = span > 1e-6 ? clamp((v - lat[i0]) / span, 0, 1) : 0;

    const sA = lerp(s0, s1, j0 / nu);
    const sB = lerp(s0, s1, (j0 + 1) / nu);

    const corner = (sRow, col, target) => {
      this.path.frameAt(sRow, this._propFrame);
      this._propRight.crossVectors(this._propFrame.tan, WORLD_UP).normalize();
      return this.sampleGround(this._propFrame, this._propRight, lat[col], target);
    };

    const a = corner(sA, i0, this._cA);
    const b = corner(sA, i0 + 1, this._cB);
    const c = corner(sB, i0, this._cC);
    const d = corner(sB, i0 + 1, this._cD);

    // Interpolate the whole position onto the same triangle the renderer draws
    // (split a,b,c / b,d,c, matching _buildTerrain's index order).
    if (fu + fv <= 1) {
      out.copy(a);
      out.x += fv * (b.x - a.x) + fu * (c.x - a.x);
      out.y += fv * (b.y - a.y) + fu * (c.y - a.y);
      out.z += fv * (b.z - a.z) + fu * (c.z - a.z);
    } else {
      const alpha = fu + fv - 1;
      const beta = 1 - fv;
      out.copy(b);
      out.x += alpha * (d.x - b.x) + beta * (c.x - b.x);
      out.y += alpha * (d.y - b.y) + beta * (c.y - b.y);
      out.z += alpha * (d.z - b.z) + beta * (c.z - b.z);
    }
    return out;
  }

  /** Ground height at an arbitrary (s, v). Allocates a frame; not for hot loops. */
  groundAt(s, v, out = new THREE.Vector3()) {
    const f = this.path.frameAt(s, this._frame);
    this._rightFlat.crossVectors(f.tan, WORLD_UP).normalize();
    if (Math.abs(v) <= ROAD.halfWidth) {
      // On the carriageway the surface is the road ribbon (and its collider),
      // which sits ROAD_SINK + ROAD_LIFT above the terrain under it.
      out.set(f.pos.x + this._rightFlat.x * v, f.pos.y + v * Math.tan(f.bank) + ROAD_LIFT,
        f.pos.z + this._rightFlat.z * v);
      return out;
    }
    this.sampleGround(f, this._rightFlat, v, out);
    return out;
  }

  // -------------------------------------------------------------- lifecycle --

  /** Streams chunks in and out around the vehicle's arc length. */
  update(carS, budget = CHUNK.buildPerFrame) {
    // Every stage below shares ONE frame budget: once streaming has spent
    // CHUNK.frameBudgetMs this frame, the remaining builds wait for the next.
    // Without it a tile, a prop scatter, a grass chunk and a rock scatter could
    // all land in the same frame (a 97 ms hitch, probe/stream.mjs).
    const frameT0 = performance.now();
    // Scaled by the smoothed frame time: ~30 % of a frame, never under the
    // configured floor. At 60 fps that is the floor (5 ms); a device running
    // at 20 fps gets 15 ms, so streaming keeps pace with the car instead of
    // receiving a third of the throughput.
    const B = Math.max(CHUNK.frameBudgetMs, Math.min(0.3 * (this._frameMs || 16.7), 40));
    const spent = () => performance.now() - frameT0;
    {
      const fp = this.focus || this.path.frameAt(carS, this._frame).pos;
      const t0 = PERF.on ? performance.now() : 0;
      this.tiles.update(fp.x, fp.z, TILES.buildPerFrame,
        Math.max(TILES.msPerFrame, Math.min(0.25 * (this._frameMs || 16.7), 30)));
      if (PERF.on) PERF.add('.tiles', performance.now() - t0);
      this.water.update(fp.x, fp.z, this.time);
    }
    const center = Math.floor(carS / CHUNK.length);
    // The spline is undefined before s = 0, so a negative chunk would collapse
    // onto s = 0 and generate a degenerate, uncollidable mesh.
    const lo = Math.max(0, center - CHUNK.behind);
    const hi = center + CHUNK.ahead;

    this.path.ensureLength((hi + 2) * CHUNK.length);

    // Drop stale requests so a fast transition cannot consume the budget on old
    // chunks before the new window is filled.
    this.pending = this.pending.filter((i) => i >= lo && i <= hi && !this.chunks.has(i));
    for (let i = lo; i <= hi; i++) {
      if (!this.chunks.has(i) && !this.pending.includes(i)) this.pending.push(i);
    }

    // Nearest-first, with the current chunk first, so a teleport immediately
    // gets a collidable surface.
    this.pending.sort((a, b) => {
      const da = a === center ? -1 : Math.abs(a - center);
      const db = b === center ? -1 : Math.abs(b - center);
      return da - db;
    });

    let built = 0;
    let tp = PERF.on ? performance.now() : 0;
    while (this.pending.length && built < budget) {
      const i = this.pending.shift();
      this._build(i);
      built++;
    }
    if (PERF.on) { const t = performance.now(); PERF.add('.chunkBuild', t - tp); tp = t; }

    // Sheets advance every frame (at least a sliver, so they always finish),
    // then scenery if the frame still has budget.
    this._stepSheets(center, Math.max(1.5, B - spent()));
    if (PERF.on) { const t = performance.now(); PERF.add('.sheets', t - tp); tp = t; }
    if (!built && spent() < B) this._flushProps(frameT0 + B);
    if (PERF.on) { const t = performance.now(); PERF.add('.props', t - tp); tp = t; }

    for (const [i, chunk] of this.chunks) {
      if (i < lo || i > hi) {
        this._dispose(chunk);
        this.chunks.delete(i);
        const q = this.propQueue.findIndex((j) => j.index === i);
        if (q >= 0) this.propQueue.splice(q, 1);
        for (const tier of this.grassTiers) {
          const g = tier.queue.indexOf(i);
          if (g >= 0) tier.queue.splice(g, 1);
        }
        const r = this.rockQueue.indexOf(i);
        if (r >= 0) this.rockQueue.splice(r, 1);
        const c = this.canopyQueue.indexOf(i);
        if (c >= 0) this.canopyQueue.splice(c, 1);
      }
    }

    // Ground cover only on a frame that did no other building, so two heavy
    // scatters never land in the same frame as a terrain build.
    if (!built) {
      // Canopy first: its absence is a hole in the world, and it is the
      // cheapest to build — the scatter already ran. Each later stage builds
      // only while the frame is under budget (eviction runs regardless).
      this._updateCanopy(carS, spent() < B ? 1 : 0);
      if (PERF.on) { const t = performance.now(); PERF.add('.canopy', t - tp); tp = t; }
      this._updateGrass(carS, spent() < B ? frameT0 + B : 0);
      if (PERF.on) { const t = performance.now(); PERF.add('.grass', t - tp); tp = t; }
      this._updateRocks(carS, spent() < B ? 1 : 0);
      if (PERF.on) { const t = performance.now(); PERF.add('.rocks', t - tp); tp = t; }
    } else {
      // Eviction still has to run every frame, or a departed chunk keeps its
      // cover.
      this._updateCanopy(carS, 0);
      this._updateGrass(carS, 0);
      this._updateRocks(carS, 0);
    }
    this._cullGrass(carS);
  }

  /** Builds `count` chunks immediately — used once, before the first frame. */
  preload(carS, count = CHUNK.preload) {
    const center = Math.floor(carS / CHUNK.length);
    this.path.ensureLength((center + count + 2) * CHUNK.length);
    const lo = Math.max(0, center - CHUNK.behind);
    const hi = center + CHUNK.ahead;
    // Same window `update()` maintains, so nothing is absent at the first frame.
    for (let i = lo; i <= Math.min(hi, lo + count - 1); i++) {
      if (!this.chunks.has(i)) this._build(i);
    }
    this._stepSheets(center, Infinity);
    const fp = this.path.frameAt(carS, this._frame).pos;
    this.tiles.preload(fp.x, fp.z);
    while (this._flushProps());
  }

  _dispose(chunk) {
    for (const obj of chunk.objects) {
      this.scene.remove(obj);
      // Only terrain and road geometry belong to this chunk; prop geometries
      // and materials are shared and must survive.
      if (obj.userData.ownsGeometry) obj.geometry.dispose();
      if (obj.isInstancedMesh) obj.dispose();
      const half = obj.userData.half;
      if (half) { half.geometry.dispose(); half.dispose(); }
    }
    if (chunk.collider && this.world) this.world.removeCollider(chunk.collider, false);
    if (chunk.extraColliders) {
      for (const c of chunk.extraColliders) this.world.removeCollider(c, false);
    }
  }

  dispose() {
    for (const chunk of this.chunks.values()) this._dispose(chunk);
    this.chunks.clear();
    this.pending.length = 0;
    this.propQueue.length = 0;
    this.canopyQueue.length = 0;

    this.tiles.dispose();
    this.water.dispose();
    this.road.dispose();
    if (this.trees) this.trees.dispose();
    if (this.bushes) this.bushes.dispose();
    if (this.ground) this.ground.dispose();
    if (this.grass) this.grass.dispose();
    if (this.rocks) this.rocks.dispose();
  }

  // ---------------------------------------------------------------- build --

  _build(index) {
    const s0 = index * CHUNK.length;
    const s1 = s0 + CHUNK.length;

    // Extend early so the foreign-road clamp's answer is a pure function of
    // position, not of how much route happened to be generated yet.
    let tq = PERF.on ? performance.now() : 0;
    const lapq = (name) => { if (PERF.on) { const t = performance.now(); PERF.add(name, t - tq); tq = t; } };
    this.path.ensureLength(s1 + ROUTE.selfFar);
    lapq('..route');

    // Chunk-local origin preserves float precision far from the world origin.
    const origin = this.path.frameAt(s0, this._frame).pos.clone();

    const objects = [];
    // The scatter's sampling grid. Not drawn, not collided — the ground the
    // player sees and drives on is `this.tiles`.
    // Built over the next frames by _stepSheets (preload finishes it at once).
    this.sheetQueue.push({ index, gen: this._sheetJob(s0, s1, origin), box: this._sheetBox(s0, s1) });

    const roadGeo = this._buildRoad(s0, s1, origin);
    lapq('..road');
    const roadMesh = new THREE.Mesh(roadGeo, this.matRoad);
    roadMesh.position.copy(origin);
    roadMesh.receiveShadow = true;
    roadMesh.userData.ownsGeometry = true;
    roadMesh.matrixAutoUpdate = false;
    roadMesh.updateMatrix();
    this.scene.add(roadMesh);
    objects.push(roadMesh);

    // The carriageway's own collider: the car drives on the ribbon it sees.
    // The terrain under the lanes is sunk ROAD_SINK below it (terrainfield.js),
    // so the two never fight and nothing pokes through the tarmac.
    let collider = null;
    if (this.world) {
      collider = this.world.createCollider(
        this.RAPIER.ColliderDesc.trimesh(roadGeo.userData.colPos, roadGeo.userData.colIdx)
          .setTranslation(origin.x, origin.y, origin.z)
          .setFriction(1.0)
          .setRestitution(0.0));
    }
    lapq('..roadCollider');

    const extraColliders = [];

    const chunk = {
      index, objects, collider, origin, props: false, extraColliders,
      // The scatter grid ({ positions, colors }); null until _stepSheets
      // has finished it. Nothing scatters on a chunk before that.
      sheet: null,
      /** The near canopy's recipe and its live meshes (short-lived; see `_updateCanopy`). */
      canopySpec: null,
      canopy: null,
      /** Live ground-cover meshes, or null; they come and go with the car. */
      grass: null,
      grassFar: null,
      grassWood: null,
      /** True once the chunk is known to have nowhere to put any. */
      grassEmpty: false,
      grassFarEmpty: false,
      grassWoodEmpty: false,
      rocks: null,
      rocksEmpty: false,
    };
    this.chunks.set(index, chunk);
    this.propQueue.push({ index, s0, s1, origin });
  }

  /**
   * Advance the scatter of the nearest chunk whose sheet is ready, until
   * `untilT`. Returns true if a job is running or finished this call.
   */
  _flushProps(untilT = Infinity) {
    if (!this.propJob) {
      for (let q = 0; q < this.propQueue.length; q++) {
        const job = this.propQueue[q];
        const chunk = this.chunks.get(job.index);
        // The chunk may have streamed back out before this ran.
        if (!chunk || chunk.props) { this.propQueue.splice(q--, 1); continue; }
        if (!chunk.sheet) continue;             // its sheet is still being built
        this.propQueue.splice(q, 1);
        this.propJob = { ...job,
          gen: this._propsJob(job.index, job.s0, job.s1, job.origin),
          box: this._scatterBox(job.s0, job.s1, Math.max(CHUNK.scatterExtent, TREES.distantExtent || 0)) };
        break;
      }
      if (!this.propJob) return false;
    }
    const job = this.propJob;
    const chunk = this.chunks.get(job.index);
    if (!chunk || chunk.props) { this.propJob = null; return true; }
    const r = this._drive(job, untilT);
    if (!r.done) return true;
    this.propJob = null;
    for (const obj of r.value) {
      obj.position.copy(job.origin);
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
      this.scene.add(obj);
      chunk.objects.push(obj);
    }
    chunk.props = true;
    return true;
  }


  // -------------------------------------------------------------- terrain --

  /**
   * The scatter grid for one chunk: road-space rows × lateral columns of
   * ground positions (origin-relative, trap #19) and their colours, sampled
   * from the terrain field. Everything planted interpolates this grid; the
   * drawn tiles sample the same field, so the two agree to the interpolation
   * error of a 2-6 m cell.
   */
  /**
   * The sheet as a RESUMABLE job: yields after every row, so `_stepSheets`
   * can spread one chunk's ~6,000 field samples over several frames under a
   * time budget (it was a 40-55 ms hitch at every chunk boundary,
   * probe/stream.mjs). The caller opens the field region around each slice;
   * the generator's return value is `{ positions, colors }`.
   */
  *_sheetJob(s0, s1, origin) {
    const nu = CHUNK.segmentsU;
    const nv = this.lateral.length;
    const rows = nu + 1;
    const vertCount = rows * nv;
    const positions = new Float32Array(vertCount * 3);
    const colors = new Float32Array(vertCount * 3);
    const p = new THREE.Vector3();
    const frame = makeFrame();
    const rightFlat = new THREE.Vector3();
    const dS = (s1 - s0) / nu;

    for (let j = 0; j <= nu; j++) {
      yield;
      this.path.frameAt(s0 + j * dS, frame);
      rightFlat.crossVectors(frame.tan, WORLD_UP).normalize();
      for (let i = 0; i < nv; i++) {
        this.sampleGround(frame, rightFlat, this.lateral[i], p);
        const k = (j * nv + i) * 3;
        positions[k] = p.x - origin.x;
        positions[k + 1] = p.y - origin.y;
        positions[k + 2] = p.z - origin.z;
      }
    }
    // Colour, with flatness from the grid's own differences.
    const c = this._color;
    for (let j = 0; j < rows; j++) {
      yield;
      for (let i = 0; i < nv; i++) {
        const k = j * nv + i;
        const i1 = Math.min(nv - 1, i + 1), i0 = Math.max(0, i - 1);
        const j1 = Math.min(rows - 1, j + 1), j0 = Math.max(0, j - 1);
        const ax = positions[(j * nv + i1) * 3] - positions[(j * nv + i0) * 3];
        const ay = positions[(j * nv + i1) * 3 + 1] - positions[(j * nv + i0) * 3 + 1];
        const az = positions[(j * nv + i1) * 3 + 2] - positions[(j * nv + i0) * 3 + 2];
        const bx = positions[(j1 * nv + i) * 3] - positions[(j0 * nv + i) * 3];
        const by = positions[(j1 * nv + i) * 3 + 1] - positions[(j0 * nv + i) * 3 + 1];
        const bz = positions[(j1 * nv + i) * 3 + 2] - positions[(j0 * nv + i) * 3 + 2];
        const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        const wx = positions[k * 3] + origin.x, wz = positions[k * 3 + 2] + origin.z;
        const jit = this._groundColor(wx, wz, positions[k * 3 + 1] + origin.y,
          Math.abs(ny / nl), Math.abs(this.lateral[i]), c);
        colors[k * 3] = c.r * jit; colors[k * 3 + 1] = c.g * jit; colors[k * 3 + 2] = c.b * jit;
      }
    }
    return { positions, colors };
  }

  /** The region a chunk's sheet samples in (its road ± the scatter extent). */
  _sheetBox(s0, s1) {
    const f = this._regionFrame || (this._regionFrame = makeFrame());
    const a = this.path.frameAt(s0, f).pos.clone(), b = this.path.frameAt(s1, f).pos;
    const r = CHUNK.scatterExtent + 20;
    return [Math.min(a.x, b.x) - r, Math.min(a.z, b.z) - r, Math.max(a.x, b.x) + r, Math.max(a.z, b.z) + r];
  }

  /** The whole sheet at once (preload, probes). */
  _buildSheet(s0, s1, origin) {
    const box = this._sheetBox(s0, s1);
    this.field.beginRegion(box[0], box[1], box[2], box[3]);
    const gen = this._sheetJob(s0, s1, origin);
    let r;
    do { r = gen.next(); } while (!r.done);
    this.field.endRegion();
    return r.value;
  }

  /**
   * Advance pending sheets, nearest chunk first, for at most `budgetMs`.
   * A chunk's scatter (props, grass, rocks) waits for its sheet.
   */
  _stepSheets(center, budgetMs) {
    const t0 = performance.now();
    this.sheetQueue.sort((a, b) => Math.abs(a.index - center) - Math.abs(b.index - center));
    while (this.sheetQueue.length) {
      const job = this.sheetQueue[0];
      const chunk = this.chunks.get(job.index);
      if (!chunk) { this.sheetQueue.shift(); continue; }
      const box = job.box;
      this.field.beginRegion(box[0], box[1], box[2], box[3]);
      let r;
      do { r = job.gen.next(); } while (!r.done && performance.now() - t0 < budgetMs);
      this.field.endRegion();
      if (r.done) { chunk.sheet = r.value; this.sheetQueue.shift(); }
      if (performance.now() - t0 >= budgetMs) return;
    }
  }

  /**
   * Ground colour at one point, into `out`. Extracted so the terrain mesh and
   * the grass standing in it are painted by the SAME function.
   *
   * @returns {number} the value jitter applied, so callers can reuse it
   */
  _groundColor(x, z, y, ny, av, out) {
    // Two mottles, ~70 m and ~350 m, put patches inside regions rather than a
    // single graded wash.
    const fine = this.terrain.nC(x * 0.014, z * 0.014) * 0.5 + 0.5;
    const broad = this.terrain.nB(x * 0.0029, z * 0.0029) * 0.5 + 0.5;

    // Height above the LOCAL base, not absolute: the map rises and falls by
    // hundreds of metres.
    const rel = y - this.terrain.continent(x, z);

    const alt = smoothstep(20, 210, rel);
    out.copy(this._grassDeep).lerp(this._grassLow, smoothstep(0.28, 0.62, broad + alt * 0.25));
    out.lerp(this._grassHigh, clamp(alt * 0.9 + (fine - 0.5) * 0.4, 0, 1));

    // Sun-bleached patches, weighted to higher, flatter ground.
    const dry = clamp((fine - 0.42) * 2.1, 0, 1) * lerp(0.35, 1, smoothstep(0.45, 0.9, ny))
      * lerp(0.5, 1, alt);
    out.lerp(this._grassDry, dry * 0.62);

    // Scrub where grass cannot hold: moderately steep, or high.
    const steep = smoothstep(0.92, 0.68, ny);
    out.lerp(this._scrub, Math.max(steep * 0.55, smoothstep(150, 330, rel) * 0.45));

    out.lerp(this._rock, smoothstep(0.86, 0.55, ny));
    // Peak and snow only where the ground is flat enough to hold them.
    out.lerp(this._peak, smoothstep(300, 520, rel) * 0.8);
    out.lerp(this._snow, smoothstep(430, 640, rel) * smoothstep(0.52, 0.86, ny));

    // The biome's own cast: straw in savanna, cold blue-green in the boreal
    // forest. Blended across a border like everything else biome-driven.
    {
      const B = this.biomes.biomeAt(x, z);
      const ta = BIOMES[B.a].tint, tb = BIOMES[B.b].tint, t = B.t;
      out.r *= ta[0] + (tb[0] - ta[0]) * t;
      out.g *= ta[1] + (tb[1] - ta[1]) * t;
      out.b *= ta[2] + (tb[2] - ta[2]) * t;
    }
    // Lakes: wet mud under the water, a pale beach around it.
    const u = this.field.lakes.shoreU(x, z);
    if (u < 1.5) {
      out.lerp(this._mud, 1 - smoothstep(0.75, 1.0, u));
      out.lerp(this._sand, smoothstep(0.86, 1.0, u) * (1 - smoothstep(1.08, 1.32, u)) * 0.85);
    }

    out.lerp(this._dirt, (1 - smoothstep(EDGE - 0.4, EDGE + 4.5, av)) * 0.9);

    return 0.92 + fine * 0.16;
  }

  /**
   * The road ribbon. Dash boundaries emit a duplicated zero-length row so the
   * vertex colour ends exactly where the geometry says, not faded across a quad.
   */
  _buildRoad(s0, s1, origin) {
    const cols = this.roadCols;
    const nv = cols.length;
    const half = ROAD.dashLength;

    // Row schedule: union of regular rows and dash boundaries, merged because
    // the two spacings coincide periodically and a boundary on a regular row
    // must still be doubled.
    const step = CHUNK.length / CHUNK.segmentsU;
    const stations = [];
    for (let k = 0; k <= CHUNK.segmentsU; k++) stations.push({ s: s0 + k * step, mark: false });
    for (let k = Math.ceil(s0 / half); k * half < s1; k++) stations.push({ s: k * half, mark: true });
    stations.sort((a, b) => a.s - b.s || (a.mark ? -1 : 1));

    const rows = [];
    const EPS = 1e-4;
    for (let i = 0; i < stations.length; i++) {
      const st = stations[i];
      // Drop a regular station that a boundary already covers.
      if (!st.mark && i > 0 && Math.abs(st.s - stations[i - 1].s) < EPS) continue;
      if (st.mark && i + 1 < stations.length && Math.abs(stations[i + 1].s - st.s) < EPS
        && !stations[i + 1].mark) stations[i + 1].s = st.s;

      if (st.mark) {
        rows.push({ s: st.s, dash: dashOn(st.s - half * 0.5, half) });
        rows.push({ s: st.s, dash: dashOn(st.s + half * 0.5, half) });
      } else {
        rows.push({ s: st.s, dash: dashOn(st.s, half) });
      }
    }

    const nu = rows.length;
    const positions = new Float32Array(nu * nv * 3);
    const colors = new Float32Array(nu * nv * 3);
    const indices = new Uint32Array((nu - 1) * (nv - 1) * 6);

    // Neutral-warm grey: env/road.js multiples the base, so a dark, blue base
    // would leave the multiply almost no range to work in.
    const asphalt = new THREE.Color(0x46443f);
    const paint = new THREE.Color(0xe9e3d2);
    const frame = makeFrame();
    const rightFlat = new THREE.Vector3();
    const c = this._color;

    for (let j = 0; j < nu; j++) {
      const { s, dash } = rows[j];
      this.path.frameAt(s, frame);
      rightFlat.crossVectors(frame.tan, WORLD_UP).normalize();
      const slope = Math.tan(frame.bank);

      const wear = this.terrain.nB(s * 0.03, 4.2) * 0.5 + 0.5;

      for (let i = 0; i < nv; i++) {
        const col = cols[i];
        const k = j * nv + i;

        positions[k * 3 + 0] = frame.pos.x + rightFlat.x * col.v - origin.x;
        positions[k * 3 + 1] = frame.pos.y + col.v * slope + ROAD_LIFT - origin.y - (col.drop || 0);
        positions[k * 3 + 2] = frame.pos.z + rightFlat.z * col.v - origin.z;

        if (col.kind === PAINT || (col.kind === CENTER && dash)) c.copy(paint);
        else c.copy(asphalt).multiplyScalar((0.85 + wear * 0.32) * (col.tone || 1));

        colors[k * 3 + 0] = c.r;
        colors[k * 3 + 1] = c.g;
        colors[k * 3 + 2] = c.b;
      }
    }

    let t = 0;
    for (let j = 0; j < nu - 1; j++) {
      for (let i = 0; i < nv - 1; i++) {
        const a = j * nv + i;
        const b = a + 1;
        const cc = a + nv;
        const d = cc + 1;
        indices[t++] = a; indices[t++] = b; indices[t++] = cc;
        indices[t++] = b; indices[t++] = d; indices[t++] = cc;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    // Collider: the drivable surface only (skirt columns 0 and nv-1 left out),
    // and only rows at distinct stations — the doubled dash-boundary rows are
    // zero-area quads a trimesh has no use for.
    const cn = nv - 2;
    const keep = [];
    for (let j = 0; j < nu; j++) if (!keep.length || rows[j].s - rows[keep[keep.length - 1]].s > 1e-3) keep.push(j);
    const cr = keep.length;
    const colPos = new Float32Array(cr * cn * 3);
    for (let jj = 0; jj < cr; jj++) {
      const j = keep[jj];
      for (let i = 0; i < cn; i++) {
        const src = (j * nv + i + 1) * 3, dst = (jj * cn + i) * 3;
        colPos[dst] = positions[src]; colPos[dst + 1] = positions[src + 1]; colPos[dst + 2] = positions[src + 2];
      }
    }
    const colIdx = new Uint32Array((cr - 1) * (cn - 1) * 6);
    let q = 0;
    for (let j = 0; j < cr - 1; j++) {
      for (let i = 0; i < cn - 1; i++) {
        const a = j * cn + i, b = a + 1, cc = a + cn, d = cc + 1;
        colIdx[q++] = a; colIdx[q++] = b; colIdx[q++] = cc;
        colIdx[q++] = b; colIdx[q++] = d; colIdx[q++] = cc;
      }
    }
    geometry.userData.colPos = colPos;
    geometry.userData.colIdx = colIdx;
    return geometry;
  }

  // ---------------------------------------------------------------- props --

  /**
   * Scatters the canopy and the understorey across one chunk.
   *
   * ── what "intentional" means here ───────────────────────────────────────────
   *
   * The previous scatter drew a point, asked which species could live there,
   * and placed one. That is a correct ecology and it produces a wash: trees
   * everywhere the rules allow, at an even density, which reads as a field of
   * scenery objects rather than as woodland. Three things change that, and none
   * of them is a density number.
   *
   *   STANDS, NOT TREES. Most of what gets placed is drawn near one of a handful
   *   of cluster seeds rather than independently. Independent draws give a
   *   Poisson field — statistically even, which is exactly the look being
   *   avoided. This is the standard density-map-plus-clustering answer and it
   *   is the single biggest lever in the file.
   *
   *   A STAND IS A SPECIES. Each cluster commits to one species and draws
   *   `TREES.clusterSpecies` of its members from it. This matters more than the
   *   clumping does: real copses are monocultures at that scale — a birch wood
   *   is birches — and a clump of six different trees is a clump, not a stand.
   *
   *   SEEDS GO WHERE THE FIELD IS STRONG. A cluster centre is rejected unless
   *   the canopy density there is real, so stands land on the ground that
   *   suits them instead of being scattered and then thinned.
   *
   * The understorey then hangs off the EDGE signal — see `foliage.js` — so a
   * wood grows its own fringe, which is most of what stops a tree line reading
   * as a wall.
   *
   * ── what it costs ──────────────────────────────────────────────────────────
   *
   * Draw calls are the binding constraint: an InstancedMesh exists per (chunk,
   * geometry), so each chunk commits up front to `TREES.picks` species and ONE
   * variant of each, seeded from its own index. Neighbouring chunks draw
   * different variants, so the world still varies while the batch count stays
   * bounded at `picks * 2 + BUSHES.picks`.
   *
   * Every tree is placed TWICE — once at each subdivision — and the shader
   * shrinks whichever one is wrong for the distance to nothing. That sounds
   * wasteful and is not: the far tier is fifty triangles and one matrix, and
   * the alternative is deciding the level of detail on the CPU every frame for
   * every instance, per camera position, which is the thing instancing exists
   * to avoid.
   */
  /** Finish chunk `index`'s sheet now if it is still pending (sync callers). */
  _ensureSheet(index) {
    const chunk = this.chunks.get(index);
    if (!chunk || chunk.sheet) return;
    const q = this.sheetQueue.findIndex((j) => j.index === index);
    if (q < 0) return;
    const r = this._drive(this.sheetQueue[q], Infinity);
    chunk.sheet = r.value;
    this.sheetQueue.splice(q, 1);
  }

  /** The whole scatter at once (preload, probes). */
  _buildProps(index, s0, s1, origin) {
    this._ensureSheet(index);
    return this._drive({ gen: this._propsJob(index, s0, s1, origin),
      box: this._scatterBox(s0, s1, Math.max(CHUNK.scatterExtent, TREES.distantExtent || 0)) }, Infinity).value;
  }

  /**
   * One chunk's trees and shrubs as a RESUMABLE job (yields every few dozen
   * samples), driven under the frame budget by `_drive` — a whole scatter in
   * one frame was a 25-45 ms hitch. Returns the objects to add.
   */
  *_propsJob(index, s0, s1, origin) {
    if (!this.trees && !this.bushes) return [];
    const chunk = this.chunks.get(index);
    if (!chunk || !chunk.sheet) return [];

    // Seeded per chunk, so a reload comes back identical instead of reshuffling.
    const rng = mulberry32(hashInt(index) ^ 0x9e3779b9);
    const out = [];

    const p = new THREE.Vector3();
    const field = this._field;

    // Ground read out of the sheet's own buffers (like _buildGrass): no noise
    // evaluation left in the loop, and the result is on the surface the renderer
    // draws. Positions are origin-relative (trap #19).
    const nv = this.lateral.length;
    const nu = CHUNK.segmentsU;
    const rowLen = (s1 - s0) / nu;
    const lat = this.lateral;
    const { positions } = chunk.sheet;

    /** @returns {number} slope at (s, v); `p` is left holding the position. */
    const look = (s, v) => {
      const fj = clamp((s - s0) / rowLen, 0, nu - 1e-4);
      const j = Math.floor(fj);
      const fu = fj - j;

      let lo = 0, hi = nv - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lat[mid] <= v) lo = mid; else hi = mid - 1;
      }
      const i = lo;
      const width = lat[i + 1] - lat[i];
      const fv = width > 1e-6 ? clamp((v - lat[i]) / width, 0, 1) : 0;

      const a = j * nv + i;
      const b = a + 1;
      const c = a + nv;
      const d = c + 1;

      // Same quad split as _buildTerrain: a,b,c then b,d,c.
      let i0, i1, i2, w0, w1, w2;
      if (fu + fv <= 1) {
        i0 = a; i1 = b; i2 = c;
        w1 = fv; w2 = fu; w0 = 1 - fv - fu;
      } else {
        i0 = b; i1 = d; i2 = c;
        w1 = fu + fv - 1; w2 = 1 - fv; w0 = 1 - w1 - w2;
      }
      p.set(
        positions[i0 * 3] * w0 + positions[i1 * 3] * w1 + positions[i2 * 3] * w2,
        positions[i0 * 3 + 1] * w0 + positions[i1 * 3 + 1] * w1 + positions[i2 * 3 + 1] * w2,
        positions[i0 * 3 + 2] * w0 + positions[i1 * 3 + 2] * w1 + positions[i2 * 3 + 2] * w2
      );

      const ya = positions[a * 3 + 1];
      const gv = (positions[b * 3 + 1] - ya) / Math.max(1e-4, width);
      const gu = (positions[c * 3 + 1] - ya) / rowLen;
      return Math.hypot(gu, gv);
    };

    /**
     * Picks `count` species from `names`, seeded, and one variant of each.
     * `rank` makes the pick favour the guild that actually grows here; the
     * weight is multiplied by a random factor rather than sorted on outright.
     */
    const commit = (names, library, count, rank = null) => {
      const pool = names.filter((n) => library.has(n));
      if (rank) {
        const w = new Map(pool.map((n) => [n, rank(n) * (0.35 + rng())]));
        pool.sort((a, b) => w.get(b) - w.get(a));
      } else {
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
      }
      const chosen = new Map();
      for (const name of pool.slice(0, count)) {
        chosen.set(name, Math.floor(rng() * library.get(name).length));
      }
      return chosen;
    };

    /** geometryKey -> { geometry, material, matrices, colours, shadow } */
    const batches = new Map();
    /** species -> the near tier's recipe, handed to the chunk record. */
    const canopy = new Map();
    const push = (key, geometry, material, matrix, colour, shadow, lone) => {
      let b = batches.get(key);
      if (!b) {
        b = { geometry, material, matrices: [], colours: [], shadow, lone: [] };
        batches.set(key, b);
      }
      b.matrices.push(matrix.clone());
      b.colours.push(colour.r, colour.g, colour.b);
      b.lone.push(lone ? 1 : 0);
    };

    // ---- the canopy ------------------------------------------------------

    if (this.trees) {
      // The guild field at the chunk's middle, sampled once, only to weight
      // which species the chunk commits to.
      look(lerp(s0, s1, 0.5), 60);
      {
        const mx = p.x + origin.x, mz = p.z + origin.z;
        vegetation(this.terrain, mx, mz,
          p.y + origin.y - this.terrain.continent(mx, mz), 0.1, 60, field);
      }
      const chosen = commit(TREE_NAMES, this.trees.library, TREES.picks,
        (n) => (0.15 + guildAffinity(FOLIAGE[n], field)) * FOLIAGE[n].weight);
      // The near cap follows the country: open meadow and savanna chunks hold
      // a fraction of a forest's grown trees. Without this nearly every chunk
      // ran into the same cap and the world's density evened out.
      // The local stand mask modulates it again, so a forest biome still has
      // its thin stretches.
      const nearCap = Math.round(TREES.nearCap *
        Math.min(1, Math.max(0.3, 0.25 + 0.6 * (field.canMul ?? 1))) *
        (0.5 + 0.5 * Math.min(1, (field.stand ?? 1) * 1.6)));
      const kinds = [...chosen.keys()];
      this._lastPicks = kinds;
      this._lastChosen = chosen;

      // Cluster seeds where the field is already strong; each commits to one
      // species. Radius on a power law: mostly thickets with the odd wood.
      const clusters = [];
      for (let i = 0; i < TREES.clusterCount && kinds.length; i++) {
        const cs = lerp(s0, s1, rng());
        const cv = (rng() < 0.5 ? -1 : 1) *
          lerp(CHUNK.plantClear + 6, 165, Math.sqrt(rng()));
        const cslope = look(cs, cv);
        const cx = p.x + origin.x, cz = p.z + origin.z;
        const crelief = p.y + origin.y - this.terrain.continent(cx, cz);
        vegetation(this.terrain, cx, cz, crelief, cslope, Math.abs(cv), field);
        if (field.canopy < 0.22) continue;
        const u = rng();
        // Drawn against the field AT THE SEED, not the chunk's picks, so the
        // copse's species is the one that belongs here.
        let best = null, bestW = 0;
        for (const name of kinds) {
          const w = suitability(FOLIAGE[name], field, crelief, cslope, Math.abs(cv)) *
            FOLIAGE[name].weight * (0.25 + rng());
          if (w > bestW) { bestW = w; best = name; }
        }
        if (!best) continue;
        clusters.push({
          s: cs,
          v: cv,
          r: TREES.clusterRadius[0] *
            Math.pow(TREES.clusterRadius[1] / TREES.clusterRadius[0], u * u),
          species: best,
          guild: FOLIAGE[best].guild,
        });
      }

      // Crown-aware spacing on a hash grid sized to the widest crown pair, so a
      // 3x3 neighbourhood is a complete answer and the check stays O(1).
      const GRID = TREES.spacingCell;
      const grid = new Map();
      const cellKey = (a, b) => `${Math.floor(a / GRID)},${Math.floor(b / GRID)}`;
      const roomFor = (cs, cv, cr) => {
        const gi = Math.floor(cs / GRID), gj = Math.floor(cv / GRID);
        for (let a = gi - 1; a <= gi + 1; a++) {
          for (let b = gj - 1; b <= gj + 1; b++) {
            const cell = grid.get(`${a},${b}`);
            if (!cell) continue;
            for (let k = 0; k < cell.length; k += 3) {
              const need = (cr + cell[k + 2]) * TREES.crownGap;
              const dx = cs - cell[k], dz = cv - cell[k + 1];
              if (dx * dx + dz * dz < need * need) return false;
            }
          }
        }
        return true;
      };
      const claim = (cs, cv, cr) => {
        const key = cellKey(cs, cv);
        let cell = grid.get(key);
        if (!cell) { cell = []; grid.set(key, cell); }
        cell.push(cs, cv, cr);
      };

      const weights = new Array(kinds.length);
      let placed = 0;
      let far = 0;

      /** One tree, already sited and sized. Shared by the scatter and coppicing. */
      const plant = (name, height, wobble, yaw, wx, wz, wy, av, paired) => {
        const variant = this.trees.library.get(name)[chosen.get(name)];
        // Stand on the terrain field, not the sheet `look()` interpolates: the
        // scatter sheet is a coarse road-space grid that is no longer drawn,
        // and its chords sat metres off the world-space tiles — every tree
        // floated (or sank). Done here, for accepted trees only.
        wy = this._groundY(wx, wz, 2);

        // Per-instance modulation near 1.0 (hue is baked into the geometry), so
        // individual variation and a hint of the ground's own colour.
        this._groundColor(wx, wz, wy, 1, av, this._color);
        const k = TREES.groundTint;
        const vary = TREES.instanceVary;
        this._color.r = ((1 - k) + k * this._color.r * 2) * (1 + (rng() - 0.5) * vary);
        this._color.g = ((1 - k) + k * this._color.g * 2) * (1 + (rng() - 0.5) * vary);
        this._color.b = ((1 - k) + k * this._color.b * 2) * (1 + (rng() - 0.5) * vary * 1.6);

        // Both tiers take the same matrix, so the cross-fade is one tree at one
        // size, drawn at two subdivisions.
        p.set(wx - origin.x, wy - origin.y, wz - origin.z);
        this._setLocalMatrix(p, height * wobble, height, height * wobble, yaw);

        if (paired) {
          // Stashed as a recipe; the near meshes come and go with the car.
          let spec = canopy.get(name);
          if (!spec) {
            spec = { geometry: variant.geometry, matrices: [], colours: [] };
            canopy.set(name, spec);
          }
          spec.matrices.push(this._mat.clone());
          spec.colours.push(this._color.r, this._color.g, this._color.b);
          placed++;
        }
        if (far < TREES.farCap) {
          // A far tree with no near mesh must fade in only once far enough that
          // its arrival is not seen.
          push(`f:${name}`, this.trees.far.get(name)[chosen.get(name)].geometry,
            this.trees.farMaterial, this._mat, this._color, false, !paired);
          far++;
        }
      };

      for (let n = 0; n < TREES.samples; n++) {
        if ((n & 63) === 63) yield;
        if (placed >= nearCap && far >= TREES.farCap) break;

        let s, v, home = null, edgeness = 0;
        if (clusters.length && rng() < TREES.clusterShare) {
          home = clusters[Math.floor(rng() * clusters.length)];
          // Two averaged uniforms: a flat disc would have a hard edge.
          s = home.s + (rng() + rng() - 1) * home.r;
          v = home.v + (rng() + rng() - 1) * home.r;
          if (s < s0 || s > s1) continue;
          // Thin from the middle out, so the stand gets a fringe.
          edgeness = Math.min(1, Math.hypot(s - home.s, v - home.v) / home.r);
          if (rng() < Math.pow(edgeness, TREES.clusterFalloff)) continue;
        } else {
          s = lerp(s0, s1, rng());
          const side = rng() < 0.5 ? -1 : 1;
          // sqrt biases toward the road, where trees are seen.
          v = side * lerp(CHUNK.plantClear, 165, Math.sqrt(rng()));
          edgeness = 1;
        }
        const lateral = Math.abs(v);
        if (lateral < CHUNK.plantClear || lateral > 165) continue;

        const av = lateral;
        const slope = look(s, v);
        const wx = p.x + origin.x, wy = p.y + origin.y, wz = p.z + origin.z;
        const relief = wy - this.terrain.continent(wx, wz);
        vegetation(this.terrain, wx, wz, relief, slope, av, field);
        // The stand mask gates canopy only; clearings keep their scrub and grass.
        if (rng() > field.canopy) continue;

        // Weighted pick across every committed species that will grow here,
        // with the cluster's own species heavily favoured.
        let total = 0;
        for (let k = 0; k < kinds.length; k++) {
          const name = kinds[k];
          let w = suitability(FOLIAGE[name], field, relief, slope, av) *
            FOLIAGE[name].weight;
          if (home) {
            // A stand is one species; guild-mates are admitted at `clusterMix`,
            // other guilds never, and `dead` has no guild so appears anywhere.
            if (name === home.species) w *= 1 + TREES.clusterSpecies * 6;
            else if (!FOLIAGE[name].guild || FOLIAGE[name].guild === home.guild) {
              w *= TREES.clusterMix;
            } else w = 0;
          }
          weights[k] = w;
          total += w;
        }
        if (total <= 0) continue;

        let pick = rng() * total;
        let ki = 0;
        for (; ki < kinds.length; ki++) {
          pick -= weights[ki];
          if (pick <= 0) break;
        }
        if (ki >= kinds.length) continue;

        const name = kinds[ki];
        const kind = FOLIAGE[name];
        const variant = this.trees.library.get(name)[chosen.get(name)];

        // Height in metres, modulated by VIGOUR (oldest at the stand's heart)
        // and, for a few, sapling height so woodland regenerates underneath.
        let height = lerp(kind.height[0], kind.height[1], rng() * rng() + 0.15);
        height *= lerp(1, 1 - TREES.vigour, edgeness);
        if (rng() < TREES.saplings) height *= 0.30 + rng() * 0.25;
        // Slight non-uniform squash, so a repeated variant does not read as a
        // row of clones.
        const wobble = 0.88 + rng() * 0.24;
        const yaw = rng() * Math.PI * 2;

        const crownR = height * variant.radius;
        if (!roomFor(s, v, crownR)) continue;
        claim(s, v, crownR);

        const paired = placed < nearCap;
        plant(name, height, wobble, yaw, wx, wz, wy, av, paired);

        // Coppicing: a second/third stem from the same stool, always the same
        // species, and placed without the spacing check — touching is the point.
        if (rng() < TREES.coppice) {
          const stems = 1 + (rng() < 0.4 ? 1 : 0);
          for (let c = 0; c < stems; c++) {
            const a = rng() * Math.PI * 2;
            const d = crownR * (0.25 + rng() * 0.35);
            const cs = s + Math.cos(a) * d, cv = v + Math.sin(a) * d;
            if (cs < s0 || cs > s1 || Math.abs(cv) < CHUNK.plantClear) continue;
            look(cs, cv);
            plant(name, height * (0.62 + rng() * 0.26), 0.9 + rng() * 0.2,
              rng() * Math.PI * 2, p.x + origin.x, p.z + origin.z,
              p.y + origin.y, Math.abs(cv), placed < nearCap);
          }
        }
      }
    }

    // ---- the distant woodland --------------------------------------------
    //
    // Everything above stays within 165 m of the road, because that is where
    // trees are SEEN up close and need a near tier. Past it the land was bare,
    // which from a crest or across a valley read as an empty world. This band
    // plants far-tier trees only, out to `TREES.distantExtent`, at the same
    // biome-driven density, on the analytic ground (`this.field`) — the scatter
    // grid stops at 200 m. They are never seen nearer than ~165 m, where the
    // far tier is already what the near tree would have faded to.
    if (this.trees && TREES.distantSamples > 0) {
      const kinds = [...(this._lastPicks || [])];
      if (kinds.length) {
        const drng = mulberry32(hashInt(index) ^ 0x5bd1e995);
        const f0 = this._propFrame, rf = this._propRight;
        let n = 0;
        for (let k = 0; k < TREES.distantSamples && n < TREES.distantCap; k++) {
          if ((k & 31) === 31) yield;
          const s = lerp(s0, s1, drng());
          const side = drng() < 0.5 ? -1 : 1;
          const v = side * lerp(175, TREES.distantExtent, Math.sqrt(drng()));
          this.path.frameAt(s, f0);
          rf.crossVectors(f0.tan, WORLD_UP).normalize();
          const wx = f0.pos.x + rf.x * v, wz = f0.pos.z + rf.z * v;
          const smp = this._distSample || (this._distSample = {});
          const wy = this.field.sample(wx, wz, smp);
          if (smp.d < 165) continue;           // another pass of the road is near
          // Slope off the natural surface: this far out the carve does nothing,
          // and the natural height alone is a third of the cost.
          const n0 = this.terrain.height(wx, wz, smp.d);
          const slope = Math.hypot(this.terrain.height(wx + 3, wz, smp.d) - n0,
            this.terrain.height(wx, wz + 3, smp.d) - n0) / 3;
          const relief = wy - this.terrain.continent(wx, wz);
          vegetation(this.terrain, wx, wz, relief, slope, smp.d, field);
          if (drng() > field.canopy * TREES.distantDensity) continue;
          let total = 0, pick = null;
          for (const name of kinds) {
            const w = suitability(FOLIAGE[name], field, relief, slope, 100) * FOLIAGE[name].weight;
            total += w;
            if (w > 0 && drng() * total < w) pick = name;
          }
          if (!pick) continue;
          const kind = FOLIAGE[pick];
          const height = lerp(kind.height[0], kind.height[1], drng() * drng() + 0.15);
          p.set(wx - origin.x, wy - origin.y - 0.2, wz - origin.z);
          this._groundColor(wx, wz, wy, 1, smp.d, this._color);
          const gk = TREES.groundTint;
          this._color.r = (1 - gk) + gk * this._color.r * 2;
          this._color.g = (1 - gk) + gk * this._color.g * 2;
          this._color.b = (1 - gk) + gk * this._color.b * 2;
          const wob = 0.88 + drng() * 0.24;
          this._setLocalMatrix(p, height * wob, height, height * wob, drng() * Math.PI * 2);
          const variant = this.trees.far.get(pick)[this._lastChosen.get(pick)];
          push(`f:${pick}`, variant.geometry, this.trees.farMaterial, this._mat, this._color, false, false);
          n++;
        }
      }
    }

    // ---- the understorey -------------------------------------------------

    if (this.bushes) {
      // Ranked by what the biome here wants, like the trees.
      look(lerp(s0, s1, 0.5), 50);
      {
        const mx = p.x + origin.x, mz = p.z + origin.z;
        vegetation(this.terrain, mx, mz, p.y + origin.y - this.terrain.continent(mx, mz), 0.1, 50, field);
      }
      const chosen = commit(SHRUB_NAMES, this.bushes.library, BUSHES.picks,
        (n) => (0.08 + guildAffinity(SHRUBS[n], field)) * SHRUBS[n].weight);
      const kinds = [...chosen.keys()];
      const weights = new Array(kinds.length);
      let placed = 0;

      // The canopy's cluster mechanism at a smaller scale: the EDGE signal
      // puts scrub down evenly, and an even scatter along a fringe is a hedge.
      const thickets = [];
      for (let i = 0; i < BUSHES.clusterCount; i++) {
        thickets.push({
          s: lerp(s0, s1, rng()),
          v: (rng() < 0.5 ? -1 : 1) * lerp(CHUNK.plantClear + 4, 150, Math.sqrt(rng())),
          r: lerp(BUSHES.clusterRadius[0], BUSHES.clusterRadius[1], rng() * rng()),
        });
      }

      for (let n = 0; n < BUSHES.samples && kinds.length; n++) {
        if ((n & 63) === 63) yield;
        if (placed >= BUSHES.cap) break;

        let s, v;
        if (rng() < BUSHES.clusterShare) {
          const home = thickets[Math.floor(rng() * thickets.length)];
          s = home.s + (rng() + rng() - 1) * home.r;
          v = home.v + (rng() + rng() - 1) * home.r;
          if (s < s0 || s > s1) continue;
        } else {
          s = lerp(s0, s1, rng());
          const side = rng() < 0.5 ? -1 : 1;
          v = side * lerp(CHUNK.plantClear, 150, Math.sqrt(rng()));
        }
        if (Math.abs(v) < CHUNK.plantClear || Math.abs(v) > 150) continue;

        const av = Math.abs(v);
        const slope = look(s, v);
        const wx = p.x + origin.x, wy = p.y + origin.y, wz = p.z + origin.z;
        const relief = wy - this.terrain.continent(wx, wz);
        vegetation(this.terrain, wx, wz, relief, slope, av, field);
        if (rng() > field.understorey) continue;

        let total = 0;
        for (let k = 0; k < kinds.length; k++) {
          const kind = SHRUBS[kinds[k]];
          const w = suitability(kind, field, relief, slope, av) * kind.weight;
          weights[k] = w;
          total += w;
        }
        if (total <= 0) continue;

        let pick = rng() * total;
        let ki = 0;
        for (; ki < kinds.length; ki++) {
          pick -= weights[ki];
          if (pick <= 0) break;
        }
        if (ki >= kinds.length) continue;

        const name = kinds[ki];
        const kind = SHRUBS[name];
        const variant = this.bushes.library.get(name)[chosen.get(name)];
        const height = lerp(kind.height[0], kind.height[1], rng());
        const wobble = 0.85 + rng() * 0.3;

        // The canopy's rule: a near-1.0 modulation of the baked-in hue.
        this._groundColor(wx, wz, wy, 1, av, this._color);
        const gk = TREES.groundTint;
        const gv = TREES.instanceVary;
        this._color.r = ((1 - gk) + gk * this._color.r * 2) * (1 + (rng() - 0.5) * gv);
        this._color.g = ((1 - gk) + gk * this._color.g * 2) * (1 + (rng() - 0.5) * gv);
        this._color.b = ((1 - gk) + gk * this._color.b * 2) * (1 + (rng() - 0.5) * gv);

        // On the terrain field (see plant()), sunk a little so no shrub is
        // ever seen standing on a stalk.
        p.y = this._groundY(wx, wz, 2) - origin.y - height * 0.05;
        this._setLocalMatrix(p, height * wobble * 1.6, height,
          height * wobble * 1.6, rng() * Math.PI * 2);
        push(`b:${name}`, variant.geometry, this.bushes.material,
          this._mat, this._color, false);
        placed++;
      }
    }

    for (const batch of batches.values()) {
      const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, batch.matrices.length);
      // 78 m cascade at 2048 px is ~4 cm/texel, so nothing under ~0.3 m casts;
      // impostor cards would cast as crossed cards.
      mesh.castShadow = batch.shadow;
      mesh.receiveShadow = true;
      // The shader displaces vertices, so three's bounding sphere is a lie;
      // culling against it pops batches at the screen edge.
      mesh.frustumCulled = false;
      batch.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(batch.colours), 3);
      mesh.instanceColor.needsUpdate = true;
      out.push(mesh);
    }

    chunk.canopySpec = canopy.size ? [...canopy.values()] : null;

    return out;
  }

  /**
   * Adds and removes the GROWN canopy as the car moves. A near tree's lifetime
   * is far shorter than its chunk's, so the grown mesh is built per position
   * from the recipe cached once at chunk build.
   */
  _updateCanopy(carS, budget) {
    if (!this.trees) return;
    const center = Math.floor(carS / CHUNK.length);
    const lo = center - TREES.behind;
    const hi = center + TREES.ahead;

    for (const [i, chunk] of this.chunks) {
      const wanted = i >= lo && i <= hi;
      if (wanted && !chunk.canopy && chunk.canopySpec && !this.canopyQueue.includes(i)) {
        this.canopyQueue.push(i);
      } else if (!wanted && chunk.canopy) {
        for (const mesh of chunk.canopy) {
          this.scene.remove(mesh);
          mesh.dispose();
          const at = chunk.objects.indexOf(mesh);
          if (at >= 0) chunk.objects.splice(at, 1);
        }
        chunk.canopy = null;
      }
    }

    this.canopyQueue.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
    while (this.canopyQueue.length && budget > 0) {
      const i = this.canopyQueue.shift();
      const chunk = this.chunks.get(i);
      if (!chunk || chunk.canopy || !chunk.canopySpec || i < lo || i > hi) continue;
      const meshes = [];
      for (const spec of chunk.canopySpec) {
        const mesh = new THREE.InstancedMesh(spec.geometry, this.trees.material,
          spec.matrices.length);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        spec.matrices.forEach((m, k) => mesh.setMatrixAt(k, m));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(spec.colours), 3);
        mesh.instanceColor.needsUpdate = true;
        mesh.position.copy(chunk.origin);
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        this.scene.add(mesh);
        chunk.objects.push(mesh);
        meshes.push(mesh);
      }
      chunk.canopy = meshes;
      budget--;
    }
  }

  // ---------------------------------------------------------------- grass --

  /**
   * Scatters one chunk's ground cover onto the terrain sheet, interpolating
   * the sheet's own corner vertices (same quad, diagonal and winding as the
   * mesh) so each tuft is on the surface the renderer draws and painted its
   * colour. No noise evaluations are left in the loop.
   *
   * @returns {THREE.InstancedMesh|null}
   */
  /** One chunk's grass at once (probes). */
  _buildGrass(index, s0, s1, origin, tier = this.grassTiers[0]) {
    this._ensureSheet(index);
    return this._drive({ gen: this._grassJob(index, s0, s1, origin, tier),
      box: this._scatterBox(s0, s1, tier.halfExtent) }, Infinity).value;
  }

  /** One chunk's grass as a RESUMABLE job (yields every 1024 samples). */
  *_grassJob(index, s0, s1, origin, tier = this.grassTiers[0]) {
    const chunk = this.chunks.get(index);
    if (!this.grass || !tier || !chunk || !chunk.sheet) return null;

    const { positions, colors } = chunk.sheet;
    const lat = this.lateral;
    const nv = lat.length;
    const nu = CHUNK.segmentsU;
    const rowLen = (s1 - s0) / nu;

    // Seeded per chunk, salted off the prop seed so grass and trees differ.
    const rng = mulberry32(hashInt(index) ^ tier.salt);

    const inner = EDGE - 0.35;             // start just inside the paved edge
    const outer = tier.halfExtent;
    if (!(outer > inner)) return null;

    // Card size grows past `denseTo`; the count scales with its square, so
    // coverage stays flat while the instance count falls with distance.
    const span = Math.max(1e-3, outer - tier.denseTo);
    const boost = (av) =>
      lerp(1, tier.farScale, clamp((av - tier.denseTo) / span, 0, 1));

    // Coverage taper over the outer quarter of the band only: it must reach
    // zero exactly at halfExtent, and start no earlier than it needs to.
    const taperFrom = outer * 0.75;
    const thin = (av) => {
      if (av <= taperFrom) return 1;
      const t = (av - taperFrom) / (outer - taperFrom);
      return Math.max(0, 1 - t * t);
    };

    // One pass over the grid: cells weighted by plantable area, with the
    // foliage field applied once per cell (not per tuft).
    const cells = [];
    const cum = [];
    const field = this._field;
    let total = 0;
    let bare = 0;

    // Field memoised on a coarse grid: its finest feature is ~70 m, so per-cell
    // sampling was paying for resolution the field does not have.
    const memo = this._coverMemo;
    memo.clear();
    // The memo also remembers the bloom share and the biome, for flowers.
    let cFlower = 0, cBiome = null;
    const coverAt = (j, a, mid, width, signed) => {
      // Keyed on the SIGNED offset: the two sides of the road are different
      // ground (the key used |v| and gave both sides the same cover).
      const key = (j >> 2) * 1024 + Math.round(signed / 6) + 512;
      const hit = memo.get(key);
      if (hit !== undefined) { cFlower = hit[1]; cBiome = hit[2]; return hit[0]; }
      // Sheet data is origin-relative; put the origin back on (trap #19).
      const wx = positions[a * 3] + origin.x;
      const wy = positions[a * 3 + 1] + origin.y;
      const wz = positions[a * 3 + 2] + origin.z;
      const gv = (positions[(a + 1) * 3 + 1] - positions[a * 3 + 1]) / Math.max(1e-4, width);
      const gu = (positions[(a + nv) * 3 + 1] - positions[a * 3 + 1]) / rowLen;
      vegetation(this.terrain, wx, wz,
        wy - this.terrain.continent(wx, wz), Math.hypot(gu, gv), mid, field);
      cFlower = tier.cover === 'ground' ? (field.flowers || 0) : 0;
      cBiome = field.biomeA;
      memo.set(key, [field[tier.cover], cFlower, cBiome]);
      return field[tier.cover];
    };
    const cellFlower = [];
    const cellBiome = [];

    for (let j = 0; j < nu; j++) {
      if (j & 1) yield;   // the cell table is a vegetation() call per cell: slice it too
      for (let i = 0; i < nv - 1; i++) {
        const av0 = Math.abs(lat[i]);
        const av1 = Math.abs(lat[i + 1]);
        const lo = Math.min(av0, av1);
        const hi = Math.max(av0, av1);
        if (hi <= inner || lo >= outer) continue;

        const a = j * nv + i;
        const b = a + 1;
        const c = a + nv;
        const d = c + 1;
        const width = Math.abs(lat[i + 1] - lat[i]);
        if (width < 1e-4) continue;         // duplicated road-marking column
        // Clip to the band so a wide far-field column is not wholly plantable.
        const usable = Math.min(hi, outer) - Math.max(lo, inner);
        if (usable <= 0) continue;

        const mid = (lo + hi) * 0.5;
        const bz = boost(mid);

        const cover = coverAt(j, a, mid, width, (lat[i] + lat[i + 1]) * 0.5);
        if (cover <= 0.02) { bare++; continue; }

        const w = (rowLen * usable * thin(mid) * cover) / (bz * bz);
        if (w <= 0) continue;

        total += w;
        cells.push(a, i, width);            // vertex index, column, cell width
        cellFlower.push(cFlower);
        cellBiome.push(cBiome);
        cum.push(total);
      }
    }
    if (!cells.length || total <= 0) return null;

    const samples = Math.round(total * tier.density);
    if (samples <= 0) return null;
    const maxSlopeSq = tier.maxSlope * tier.maxSlope;

    // Instance data written straight into its final buffers — a yaw-scale
    // matrix is nine non-zero terms, and composing Matrix4s here is thirty
    // thousand object allocations a chunk.
    const mats = new Float32Array(samples * 16);
    const colours = new Float32Array(samples * 3);
    // Per-instance atlas kind and head colour (env/grass.js GRASS_KINDS).
    const kinds = new Float32Array(samples);
    const blooms = new Float32Array(samples * 3);
    // Arc length of each tuft, for the per-frame distance cull (sorted below).
    const sOf = new Float32Array(samples);
    // Bounds per HALF of the chunk (rows before / after the middle): each half
    // is drawn as its own mesh so the one behind the camera can be culled.
    const bb = [[Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
                [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]];
    const p = this._cA;
    let placed = 0;

    // Draw every sample position first and sort them: the cell table is laid
    // out row by row along the road, so sorted targets place the tufts in
    // ROAD ORDER. That makes the tufts within the fade reach a prefix of the
    // buffers (_cullGrass), with no reordering pass afterwards.
    const targets = new Float64Array(samples);
    for (let n = 0; n < samples; n++) targets[n] = rng() * total;
    targets.sort();
    for (let n = 0; n < samples; n++) {
      if ((n & 1023) === 1023) yield;
      const target = targets[n];
      let lo2 = 0, hi2 = cum.length - 1;
      while (lo2 < hi2) {
        const mid = (lo2 + hi2) >> 1;
        if (cum[mid] < target) lo2 = mid + 1; else hi2 = mid;
      }
      const a = cells[lo2 * 3];
      const col = cells[lo2 * 3 + 1];
      const width = cells[lo2 * 3 + 2];

      const b = a + 1;
      const c = a + nv;
      const d = c + 1;

      const fu = rng();                     // along the road
      const fv = rng();                     // across it

      // Trims the one straddling column — the table already dropped full-road cells.
      const av = Math.abs(lat[col] + fv * (lat[col + 1] - lat[col]));
      if (av < inner || av > outer) continue;

      // Same quad split as _buildTerrain: a,b,c then b,d,c.
      let i0, i1, i2, w0, w1, w2;
      if (fu + fv <= 1) {
        i0 = a; i1 = b; i2 = c;
        w1 = fv; w2 = fu; w0 = 1 - fv - fu;
      } else {
        i0 = b; i1 = d; i2 = c;
        w1 = fu + fv - 1; w2 = 1 - fv; w0 = 1 - w1 - w2;
      }

      p.set(
        positions[i0 * 3] * w0 + positions[i1 * 3] * w1 + positions[i2 * 3] * w2,
        positions[i0 * 3 + 1] * w0 + positions[i1 * 3 + 1] * w1 + positions[i2 * 3 + 1] * w2,
        positions[i0 * 3 + 2] * w0 + positions[i1 * 3 + 2] * w1 + positions[i2 * 3 + 2] * w2
      );
      // Height from the terrain field, not the sheet: the scatter sheet is a
      // coarse road-space grid that is no longer drawn, and its chords sat
      // metres off the world-space tiles — every prop floated (or sank).
      // Lattice spacing to match the tiles that draw this ground: the far
      // tier lives 110-630 m out, where tiles are 8-16 m cells.
      p.y = this._groundY(p.x + origin.x, p.z + origin.z, tier.key === 'grassFar' ? 8 : 4) - origin.y;

      // Slope straight from the cell's own corners — the gradient of the very
      // triangle the tuft is standing on, for four subtractions.
      const ya = positions[a * 3 + 1];
      const gv = (positions[b * 3 + 1] - ya) / width;
      const gu = (positions[c * 3 + 1] - ya) / rowLen;
      // Squared, to keep a sqrt out of a thirty-thousand-iteration loop.
      if (gu * gu + gv * gv > maxSlopeSq) continue;

      // Biased toward the short end: a field is mostly low, with taller stems
      // standing out of it, not a uniform spread between two limits.
      const t = rng();
      const bz = boost(av) * tier.sizeMul;
      const height = lerp(tier.height[0], tier.height[1], t * t) * bz;
      const wid = height * tier.widthRatio * tier.widthMul * lerp(0.8, 1.25, rng());

      // Sunk slightly, so a root is never visible over a rise.
      p.y -= height * 0.06;

      // T * R_y * S, written out. `p` came straight from the sheet, so it is
      // ALREADY origin-relative and must not have the origin taken off again.
      const yaw = rng() * Math.PI * 2;
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const o16 = placed * 16;
      mats[o16] = cy * wid; mats[o16 + 2] = -sy * wid;
      mats[o16 + 5] = height;
      mats[o16 + 8] = sy * wid; mats[o16 + 10] = cy * wid;
      mats[o16 + 12] = p.x; mats[o16 + 13] = p.y; mats[o16 + 14] = p.z;
      mats[o16 + 15] = 1;

      // Lift: meadow brighter than soil; the woodland floor darker (in shade).
      const lift = lerp(tier.lift[0], tier.lift[1], rng());
      const o = placed * 3;
      colours[o] = (colors[i0 * 3] * w0 + colors[i1 * 3] * w1 + colors[i2 * 3] * w2) * lift;
      colours[o + 1] = (colors[i0 * 3 + 1] * w0 + colors[i1 * 3 + 1] * w1 + colors[i2 * 3 + 1] * w2) * lift;
      colours[o + 2] = (colors[i0 * 3 + 2] * w0 + colors[i1 * 3 + 2] * w1 + colors[i2 * 3 + 2] * w2) * lift;
      // Which tuft. In bloom (the biome's flower share) it is a flower tuft
      // with a head from the biome's palette; otherwise the biome's sward mix
      // of meadow / seed / clover. The woodland floor is long sward and seed.
      const bi = BIOMES[cellBiome[lo2]] || BIOMES.meadow;
      const fl = cellFlower[lo2];
      let kind;
      if (fl > 0 && rng() < fl) {
        kind = 2;
        const bc = bi.bloom[Math.floor(rng() * bi.bloom.length)];
        const k = 0.9 + rng() * 0.2;
        blooms[o] = bc[0] * k; blooms[o + 1] = bc[1] * k; blooms[o + 2] = bc[2] * k;
      } else {
        const mix = tier.cover === 'floor' ? [0.65, 0.35, 0] : (bi.sward || [0.65, 0.2, 0.15]);
        const r = rng() * (mix[0] + mix[1] + mix[2]);
        kind = r < mix[0] ? 0 : r < mix[0] + mix[1] ? 1 : 3;
        // Seed heads: straw, from the ground colour toward a dry gold.
        blooms[o] = 0.62 + colours[o] * 0.25; blooms[o + 1] = 0.52 + colours[o + 1] * 0.2;
        blooms[o + 2] = 0.30 + colours[o + 2] * 0.15;
      }
      kinds[placed] = kind;
      sOf[placed] = s0 + (Math.floor(a / nv) + 1) * rowLen;   // the row's far edge: conservative
      // Bounds as we go (the cull spheres), instead of a pass over every matrix.
      const B = bb[Math.floor(a / nv) < (nu >> 1) ? 0 : 1];
      if (p.x < B[0]) B[0] = p.x; if (p.x > B[3]) B[3] = p.x;
      if (p.y < B[1]) B[1] = p.y; if (p.y + height > B[4]) B[4] = p.y + height;
      if (p.z < B[2]) B[2] = p.z; if (p.z > B[5]) B[5] = p.z;
      placed++;
    }

    if (!placed) return null;


    // A per-chunk clone of the 8-vertex tuft: the per-instance kind and bloom
    // attributes live on the geometry, so it cannot be shared.
    // Split at the middle row: the first half is `mesh`, which holds ALL the
    // chunk's instances in its buffers (probes and eviction see one object),
    // and draws only its own range; the second half is a child drawing a view
    // of the same arrays. Instances are in road order, so both are prefixes.
    const sArr = sOf.subarray(0, placed);
    const sMid = s0 + (nu >> 1) * rowLen;
    let split = 0;
    { let lo = 0, hi = placed; while (lo < hi) { const m = (lo + hi) >> 1; if (sArr[m] <= sMid + 1e-3) lo = m + 1; else hi = m; } split = lo; }
    const sphere = (B) => new THREE.Sphere(
      new THREE.Vector3((B[0] + B[3]) / 2, (B[1] + B[4]) / 2, (B[2] + B[5]) / 2),
      0.5 * Math.hypot(B[3] - B[0], B[4] - B[1], B[5] - B[2]) + 2);
    const make = (from, to) => {
      // A per-mesh clone of the 8-vertex tuft: the per-instance kind and bloom
      // attributes live on the geometry, so it cannot be shared.
      const tuft = this.grass.geometry.clone();
      tuft.setAttribute('aKind', new THREE.InstancedBufferAttribute(kinds.subarray(from, to), 1));
      tuft.setAttribute('aBloom', new THREE.InstancedBufferAttribute(blooms.subarray(from * 3, to * 3), 3));
      const m = new THREE.InstancedMesh(tuft, tier.material, to - from);
      m.userData.ownsGeometry = true;
      // Swap buffers in; `subarray` is a view, so the trim costs nothing.
      m.instanceMatrix = new THREE.InstancedBufferAttribute(mats.subarray(from * 16, to * 16), 16);
      m.instanceColor = new THREE.InstancedBufferAttribute(colours.subarray(from * 3, to * 3), 3);
      // A 78 m cascade cannot resolve a 60 cm blade, so no cast.
      m.castShadow = false;
      m.receiveShadow = true;
      // The shader only SHRINKS tufts (fade) and leans their tips by the wind
      // (< 0.3 m), so the instances' own bounds plus a margin are
      // conservative. Grass used to skip the cull entirely, and every grass
      // chunk was drawn every frame — including the ones behind the camera.
      m.frustumCulled = true;
      m.userData.grass = true;
      return m;
    };
    const mesh = make(0, placed);
    mesh.boundingSphere = sphere(bb[0].every(Number.isFinite) ? bb[0] : bb[1]);
    mesh.userData.sSorted = sArr;
    mesh.userData.total = placed;
    mesh.userData.split = split;
    if (split < placed) {
      const half = make(split, placed);
      half.boundingSphere = sphere(bb[1]);
      half.matrixAutoUpdate = false;
      mesh.add(half);
      mesh.userData.half = half;
    }
    mesh.count = split > 0 ? split : placed;
    if (split === 0) { mesh.boundingSphere = sphere(bb[1]); mesh.userData.split = placed; mesh.userData.half = null; if (mesh.children.length) mesh.remove(mesh.children[0]); }
    return mesh;
  }

  /** The region box for a scatter `extent` metres either side of [s0, s1]. */
  _scatterBox(s0, s1, extent) {
    const f = this._regionFrame || (this._regionFrame = makeFrame());
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k <= 4; k++) {
      const p = this.path.frameAt(s0 + (s1 - s0) * k / 4, f).pos;
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
    }
    const r = extent + 30;
    return [x0 - r, z0 - r, x1 + r, z1 + r];
  }

  /**
   * Resume a resumable build (`{ gen, box }`) inside its field region until it
   * finishes or `untilT` (a performance.now() deadline) passes. The region is
   * opened and closed around every slice: other work samples the field in
   * between. Returns `{ done, value }`.
   */
  _drive(job, untilT) {
    const b = job.box;
    this.field.beginRegion(b[0], b[1], b[2], b[3]);
    let r;
    do { r = job.gen.next(); } while (!r.done && performance.now() < untilT);
    this.field.endRegion();
    return r;
  }

  /** Releases a grass mesh and the half it carries. */
  _disposeGrass(mesh) {
    const half = mesh.userData.half;
    if (half) { half.geometry.dispose(); half.dispose(); }
    mesh.geometry.dispose();
    mesh.dispose();
  }

  /**
   * Scatters one chunk's stone.
   *
   * Stone is placed by interpolating the terrain sheet's vertices like the
   * grass (on the drawn surface), on the shoulder-to-grass band where loose
   * stone collects, denser the steeper the ground. It takes NO ground colour:
   * stone is mineral, and the verge's green on a chip reads as algae.
   */
  _buildRocks(index, s0, s1, origin) {
    this._ensureSheet(index);
    const chunk = this.chunks.get(index);
    if (!this.rocks || !chunk || !chunk.sheet) return null;

    // `colors` deliberately not destructured: stone's hue is ROCKS.palette.
    const { positions } = chunk.sheet;
    const lat = this.lateral;
    const nv = lat.length;
    const nu = CHUNK.segmentsU;
    const rowLen = (s1 - s0) / nu;
    const rng = mulberry32(hashInt(index) ^ 0x9b1c3d77);

    const inner = Math.max(EDGE, ROCKS.band[0]);
    const outer = ROCKS.band[1];
    if (!(outer > inner)) return null;

    const buckets = new Map();
    const names = Object.keys(this.rocks.classes);
    // Seeded window into each class's variants, so a reload comes back the same.
    const offsets = {};
    for (const k of names) offsets[k] = Math.floor(rng() * this.rocks.classes[k].variants.length);
    const p = this._cA;

    for (let n = 0; n < ROCKS.samples; n++) {
      // Uniform over the grid, not area: biases toward the near columns, which
      // is where the verge's stone belongs.
      const j = Math.floor(rng() * nu);
      const i = Math.floor(rng() * (nv - 1));
      const width = Math.abs(lat[i + 1] - lat[i]);
      if (width < 1e-4) continue;

      const fu = rng();
      const fv = rng();
      const av = Math.abs(lat[i] + fv * (lat[i + 1] - lat[i]));
      if (av < inner || av > outer) continue;

      const a = j * nv + i;
      const b = a + 1;
      const c = a + nv;
      const d = c + 1;

      // Same quad split as _buildTerrain: a,b,c then b,d,c.
      let i0, i1, i2, w0, w1, w2;
      if (fu + fv <= 1) {
        i0 = a; i1 = b; i2 = c;
        w1 = fv; w2 = fu; w0 = 1 - fv - fu;
      } else {
        i0 = b; i1 = d; i2 = c;
        w1 = fu + fv - 1; w2 = 1 - fv; w0 = 1 - w1 - w2;
      }

      const ya = positions[a * 3 + 1];
      const gv = (positions[b * 3 + 1] - ya) / width;
      const gu = (positions[c * 3 + 1] - ya) / rowLen;
      const slope = Math.sqrt(gu * gu + gv * gv);

      // Steeper ground is stone and scree; the shoulder-to-grass verge fills in.
      const scree = smoothstep(ROCKS.screeSlope * 0.55, ROCKS.screeSlope, slope);
      const vergeWeight = 1 - smoothstep(inner, inner + 5.5, av);
      const chance = lerp(0.40, 0.96, Math.max(scree, vergeWeight * 0.85));
      if (rng() > chance) continue;

      // Scree dominates on a face; the mix table decides on open ground.
      const mix = scree > 0.5 ? ROCKS.screeMix : ROCKS.mix;
      let roll = rng();
      let name = names[0];
      for (const k of names) {
        roll -= mix[k] || 0;
        if (roll <= 0) { name = k; break; }
      }
      const cls = this.rocks.classes[name];
      // A chunk uses a subset: two variants per class caps draw calls at six,
      // while the whole library still appears because which two is seeded.
      const pick = Math.floor(rng() * ROCKS.variantsPerChunk);
      const variant = (offsets[name] + pick) % cls.variants.length;

      p.set(
        positions[i0 * 3] * w0 + positions[i1 * 3] * w1 + positions[i2 * 3] * w2,
        positions[i0 * 3 + 1] * w0 + positions[i1 * 3 + 1] * w1 + positions[i2 * 3 + 1] * w2,
        positions[i0 * 3 + 2] * w0 + positions[i1 * 3 + 2] * w1 + positions[i2 * 3 + 2] * w2
      );
      // Height from the terrain field, not the sheet: the scatter sheet is a
      // coarse road-space grid that is no longer drawn, and its chords sat
      // metres off the world-space tiles — every prop floated (or sank).
      p.y = this._groundY(p.x + origin.x, p.z + origin.z, 4) - origin.y;

      // The band is in sheet columns; on a bend the interpolated point can land
      // nearer the road than its column says. Ask the field.
      if (this.field.roadDistance(p.x + origin.x, p.z + origin.z) < inner - 0.2) continue;

      const size = lerp(cls.spec.size[0], cls.spec.size[1], rng() * rng());
      // Firmly bedded (38-58% buried) so nothing floats or perches on a corner.
      p.y -= size * lerp(0.38, 0.58, rng());

      const key = name + ':' + variant;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          geometry: cls.variants[variant],
          shadow: cls.spec.shadow !== false,
          mats: [],
          cols: [],
        };
        buckets.set(key, bucket);
      }

      // Orient along the slope normal so the bottom rests against the hill.
      const slopeLen = Math.hypot(gu, gv, 1.0) || 1.0;
      const ny = 1.0 / slopeLen, nx = -gu / slopeLen, nz = -gv / slopeLen;
      const yaw = rng() * Math.PI * 2;
      const cy = Math.cos(yaw), sy = Math.sin(yaw);

      // Orthonormal basis tilted with the terrain slope; right = up x fwd.
      const upX = nx, upY = ny, upZ = nz;
      let fwdX = cy - (cy * upX + sy * upZ) * upX;
      let fwdY = -(cy * upX + sy * upZ) * upY;
      let fwdZ = sy - (cy * upX + sy * upZ) * upZ;
      const fwdLen = Math.hypot(fwdX, fwdY, fwdZ) || 1.0;
      fwdX /= fwdLen; fwdY /= fwdLen; fwdZ /= fwdLen;
      const rX = upY * fwdZ - upZ * fwdY;
      const rY = upZ * fwdX - upX * fwdZ;
      const rZ = upX * fwdY - upY * fwdX;

      bucket.mats.push(
        rX * size, rY * size, rZ * size, 0,
        upX * size, upY * size, upZ * size, 0,
        fwdX * size, fwdY * size, fwdZ * size, 0,
        p.x, p.y, p.z, 1
      );

      // A mineral hue from ROCKS.palette, not the ground's colour: a rock does not
      // photosynthesise, and the verge's green reads as algae.
      const pal = ROCKS.palette[Math.floor(rng() * ROCKS.palette.length)];
      const bright = lerp(ROCKS.shade[0], ROCKS.shade[1], rng());
      bucket.cols.push(pal[0] * bright, pal[1] * bright, pal[2] * bright);
    }

    if (!buckets.size) return null;
    const meshes = [];
    for (const bucket of buckets.values()) {
      const count = bucket.cols.length / 3;
      const mesh = new THREE.InstancedMesh(bucket.geometry, this.rocks.material, count);
      mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(bucket.mats), 16);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(bucket.cols), 3);
      // Scree never casts: a 15 cm chip is ~3 texels of shadow noise.
      mesh.castShadow = bucket.shadow;
      mesh.receiveShadow = true;
      mesh.userData.rock = true;
      meshes.push(mesh);
    }
    return meshes;
  }

  _updateRocks(carS, budget) {
    if (!this.rocks) return;
    const center = Math.floor(carS / CHUNK.length);
    const lo = center - ROCKS.behind;
    const hi = center + ROCKS.ahead;

    for (const [i, chunk] of this.chunks) {
      const wanted = i >= lo && i <= hi;
      if (wanted && chunk.sheet && !chunk.rocks && !chunk.rocksEmpty && !this.rockQueue.includes(i)) {
        this.rockQueue.push(i);
      } else if (!wanted && chunk.rocks) {
        for (const mesh of chunk.rocks) {
          this.scene.remove(mesh);
          mesh.dispose();
          const at = chunk.objects.indexOf(mesh);
          if (at >= 0) chunk.objects.splice(at, 1);
        }
        chunk.rocks = null;
      }
    }

    this.rockQueue.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
    while (this.rockQueue.length && budget > 0) {
      const i = this.rockQueue.shift();
      const chunk = this.chunks.get(i);
      if (!chunk || chunk.rocks || i < lo || i > hi) continue;
      const s0 = i * CHUNK.length;
      const meshes = this._buildRocks(i, s0, s0 + CHUNK.length, chunk.origin);
      if (meshes) {
        for (const mesh of meshes) {
          mesh.position.copy(chunk.origin);
          mesh.matrixAutoUpdate = false;
          mesh.updateMatrix();
          this.scene.add(mesh);
          chunk.objects.push(mesh);
        }
        chunk.rocks = meshes;
      } else {
        chunk.rocks = null;
        chunk.rocksEmpty = true;
      }
      budget--;
    }
  }

  /** Adds and removes ground cover as the car moves. Grass lives shorter than
   * its chunk, so it tracks the car; the near tier is served first because its
   * absence is the visible one, and the far tier fills in behind the fog.
   */
  /**
   * Draw only the tufts that can be seen: the sorted prefix within the tier's
   * fade reach of the car (+ a margin for the camera standing off the car).
   * Camera distance is at least the along-road distance, so this never drops a
   * visible tuft.
   */
  _cullGrass(carS) {
    for (const tier of this.grassTiers) {
      const reach = carS + tier.reach + 20;
      for (const chunk of this.chunks.values()) {
        const mesh = chunk[tier.key];
        if (!mesh || !mesh.userData.sSorted) continue;
        const sArr = mesh.userData.sSorted;
        let lo = 0, hi = sArr.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (sArr[m] <= reach) lo = m + 1; else hi = m; }
        // Two halves, each its own prefix of the drawable range.
        const split = mesh.userData.split, half = mesh.userData.half;
        mesh.count = Math.min(lo, split);
        if (half) { half.count = Math.max(0, lo - split); half.visible = half.count > 0; }
        // `visible` would hide the child too; an empty first half draws nothing.
        mesh.visible = lo > 0;
      }
    }
  }

  _updateGrass(carS, untilT) {
    if (!this.grass) return;
    const center = Math.floor(carS / CHUNK.length);

    for (const tier of this.grassTiers) {
      const lo = center - tier.behind;
      const hi = center + tier.ahead;
      const emptyKey = tier.key + 'Empty';

      for (const [i, chunk] of this.chunks) {
        const wanted = i >= lo && i <= hi;
        if (wanted && chunk.sheet && !chunk[tier.key] && !chunk[emptyKey] && !tier.queue.includes(i)) {
          tier.queue.push(i);
        } else if (!wanted && chunk[tier.key]) {
          const mesh = chunk[tier.key];
          this.scene.remove(mesh);
          this._disposeGrass(mesh);
          const at = chunk.objects.indexOf(mesh);
          if (at >= 0) chunk.objects.splice(at, 1);
          chunk[tier.key] = null;
        }
      }

      // Nearest first; one chunk's grass at a time, resumed until `untilT`
      // (a performance.now() deadline; 0 = eviction only this frame).
      tier.queue.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
      while (performance.now() < untilT) {
        if (!tier.job) {
          let i = -1, chunk = null;
          while (tier.queue.length) {
            i = tier.queue.shift();
            chunk = this.chunks.get(i);
            if (chunk && chunk.sheet && !chunk[tier.key] && i >= lo && i <= hi) break;
            chunk = null;
          }
          if (!chunk) break;
          const s0 = i * CHUNK.length;
          tier.job = { i, gen: this._grassJob(i, s0, s0 + CHUNK.length, chunk.origin, tier),
                       box: this._scatterBox(s0, s0 + CHUNK.length, tier.halfExtent) };
        }
        const job = tier.job;
        const chunk = this.chunks.get(job.i);
        if (!chunk || chunk[tier.key] || job.i < lo || job.i > hi) { tier.job = null; continue; }
        const r = this._drive(job, untilT);
        if (!r.done) break;
        tier.job = null;
        const mesh = r.value;
        if (mesh) {
          mesh.position.copy(chunk.origin);
          mesh.matrixAutoUpdate = false;
          mesh.updateMatrix();
          this.scene.add(mesh);
          chunk.objects.push(mesh);
          chunk[tier.key] = mesh;
        } else {
          // Mark done so the queue does not retry this chunk every frame.
          chunk[tier.key] = null;
          chunk[emptyKey] = true;
        }
      }
    }
  }

  /**
   * Instance transform from a WORLD position, made chunk-local. The sheet's
   * buffers are origin-relative, so `_setMatrix` on one of their points would
   * subtract the origin twice — `_setLocalMatrix` is for already-local points.
   */
  _setMatrix(worldPos, origin, sx, sy, sz, yaw) {
    this._pos.set(worldPos.x - origin.x, worldPos.y - origin.y, worldPos.z - origin.z);
    return this._composeMatrix(sx, sy, sz, yaw);
  }

  /** As above, for a position already relative to the chunk origin. */
  _setLocalMatrix(localPos, sx, sy, sz, yaw) {
    this._pos.copy(localPos);
    return this._composeMatrix(sx, sy, sz, yaw);
  }

  _composeMatrix(sx, sy, sz, yaw) {
    this._quat.setFromAxisAngle(WORLD_UP, yaw);
    this._scl.set(sx, sy, sz);
    this._mat.compose(this._pos, this._quat, this._scl);
    return this._mat;
  }
}
