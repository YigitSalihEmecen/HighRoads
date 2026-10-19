/**
 * chunks.js — streaming terrain, road ribbon, colliders and props.
 *
 * Terrain is generated in road space: a chunk is a strip of the spline at
 * arc length u with lateral offset v. This carves the corridor, keeps seams
 * exact, and streams the ring of chunks with the car.
 */

import * as THREE from 'three';
import { CHUNK, ROAD, ROAD_SURFACE, ROUTE, GRASS, GROUND, TREES, BUSHES, SIGNS, TERRAIN_COLORS, TILES, TOWNS, TERRAIN, BARRIERS, BRIDGES, WORLD_BIOME } from './config.js';
import { clamp, lerp, smoothstep, smin, smax, mulberry32, hashInt } from './util.js';
import {
  FOLIAGE, SHRUBS, TREE_NAMES, SHRUB_NAMES, vegetation, suitability, guildAffinity, setEcology,
} from './foliage.js';
import { createBiomes, BIOMES } from './biomes.js';
import { makeFrame } from './path.js';
import { createGrassAssets } from './env/grass.js';
import { createGroundAssets } from './env/ground.js';
import { createRoadAssets } from './env/road.js';
import { createBarrierMaterials, BarrierMesher, barrierRuns } from './env/barriers.js';
import { createTreeAssets } from './env/legacy/trees.js';
import { createTreeGenAssets } from './env/treegen.js';
import { Forest } from './forest.js';
import { TerrainField, ROAD_SINK, FAR as CARVE_REACH } from './terrainfield.js';
import { PERF } from './perf.js';
import { InstanceCuller } from './instcull.js';
import { WorldTiles } from './worldtiles.js';
import { WaterSystem } from './env/water.js';
import { Towns } from './towns.js';
import { Bridges } from './bridges.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const ROAD_LIFT = 0.035;

function dashOn(s, half) {
  return Math.floor(s / half) % 2 === 0;
}

const EDGE = ROAD.halfWidth + ROAD.shoulder;
/** The sun's side, flat (the default sun's azimuth): the slopes that dry out. Fixed, so a sky change never repaints the hills. */
const SUNWARD = [-0.432, -0.902];
/** World normal-y over which steep ground goes to bare rock (a world biome may move it). */
const ROCK_SLOPE = [0.87, 0.7];
const GRASS_COL = WORLD_BIOME.grassCol || null;

/**
 * The road's along-coordinate is handed to the shader modulo this, so it
 * stays precise in a float. A multiple of the chunk length (no chunk straddles
 * a wrap) and of every road-space period env/road.js uses.
 */
const ROAD_S_PERIOD = 7680;
/** Section cells start this far past each `sectionCell` multiple: off the dash and row grids. */
const SEAM_SHIFT = 1.37;

/**
 * Resurfacing age of each carriageway at `s` — [left, right], 0 fresh .. 1
 * old. A pure function of `s`: a seam where each `sectionCell` starts and
 * one at a hashed point inside it (`roadSeam`).
 */
function roadAges(s, out) {
  const S = ROAD_SURFACE;
  const c = Math.floor((s - SEAM_SHIFT) / S.sectionCell);
  const id = c * 2 + (s >= roadSeam(c) ? 1 : 0);
  const pick = (h) => S.ages[Math.floor((h / 4294967296) * S.ages.length)];
  const h = hashInt(id * 0x27d4eb2f + 0x165667b1);
  out[1] = pick(hashInt(h + 1));
  out[0] = (h / 4294967296) < S.fullWidth ? out[1] : pick(hashInt(h + 2));
  return out;
}
function roadSeam(c) {
  const L = ROAD_SURFACE.sectionCell;
  return c * L + SEAM_SHIFT + L * (0.2 + 0.6 * (hashInt(c * 0x9e3779b1 + 7) / 4294967296));
}

function buildLateralOffsets() {
  // Every entry derived and strictly increasing: a literal would break the
  // sort the binary search below assumes. Lane centres and joints, then the edge.
  const half = [];
  for (let k = 0; k * ROAD.laneWidth * 0.5 < ROAD.halfWidth - 1e-6; k++) half.push(k * ROAD.laneWidth * 0.5);
  half.push(ROAD.halfWidth, ROAD.halfWidth + 0.9, EDGE, EDGE + 1.4, EDGE + 2.8);
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
  const w = ROAD.lineWidth;
  const gap = ROAD.centreGap;
  const ins = ROAD.edgeInset;

  // Duplicated v positions give each painted stripe a hard edge; without the
  // duplicate, vertex colours smear the line across the whole lane.
  const cols = [];
  const push = (v, kind) => cols.push({ v, kind });
  const dividers = [];
  for (let l = 1; l < ROAD.lanesPerSide; l++) dividers.push(l * lane);

  // Skirt: the edge again, dropped, so the ribbon never shows a gap against
  // the terrain beside it from any angle. Its top is its OWN column, asphalt
  // and darker: sharing the paint's column painted the whole face as a lit
  // white curb, and sharing the top's vertex averaged a vertical normal into
  // the outer strip — the edge read as blocky, patched-together tiles.
  cols.push({ v: -hw, kind: ASPHALT, drop: 0.45, tone: 0.7 });
  cols.push({ v: -hw, kind: ASPHALT, tone: 0.7 });
  push(-hw, ASPHALT);
  push(-hw + ins, ASPHALT);               // left edge line, inset
  push(-hw + ins, PAINT);
  push(-hw + ins + w, PAINT);
  push(-hw + ins + w, ASPHALT);

  for (const d of [...dividers].reverse()) {   // lane dividers, dashed
    push(-d - w * 0.5, ASPHALT);
    push(-d - w * 0.5, CENTER);
    push(-d + w * 0.5, CENTER);
    push(-d + w * 0.5, ASPHALT);
  }

  push(-gap - w, ASPHALT);                // solid double line down the middle
  push(-gap - w, PAINT);
  push(-gap, PAINT);
  push(-gap, ASPHALT);
  push(gap, ASPHALT);
  push(gap, PAINT);
  push(gap + w, PAINT);
  push(gap + w, ASPHALT);

  for (const d of dividers) {
    push(d - w * 0.5, ASPHALT);
    push(d - w * 0.5, CENTER);
    push(d + w * 0.5, CENTER);
    push(d + w * 0.5, ASPHALT);
  }

  push(hw - ins - w, ASPHALT);            // right edge line, inset
  push(hw - ins - w, PAINT);
  push(hw - ins, PAINT);
  push(hw - ins, ASPHALT);
  push(hw, ASPHALT);
  cols.push({ v: hw, kind: ASPHALT, tone: 0.7 });
  cols.push({ v: hw, kind: ASPHALT, drop: 0.45, tone: 0.7 });

  // Wear across each lane, as geometry columns so the vertex colour carries
  // it: the two wheel paths polished a little lighter, and a dark oil strip
  // down the middle where engines drip. Lane centres are at ±lane·(l + ½);
  // none of these offsets lands on a painted line.
  const tones = [];
  for (let l = 0; l < ROAD.lanesPerSide; l++) {
    const c = lane * (l + 0.5);
    for (const sgn of [-1, 1]) {
      tones.push({ v: sgn * c, tone: 0.80 });            // oil strip
      tones.push({ v: sgn * c - 0.42, tone: 0.97 });
      tones.push({ v: sgn * c + 0.42, tone: 0.97 });
      tones.push({ v: sgn * c - 0.86, tone: 1.08 });     // wheel paths
      tones.push({ v: sgn * c + 0.86, tone: 1.08 });
    }
  }
  for (const t of tones) {
    if (Math.abs(t.v) > hw - ins - w - 0.05) continue;
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
  constructor({ scene, world, RAPIER, path, terrain, anisotropy = 1, trees = null, signs = null, bridgeMaterials = null }) {
    this.scene = scene;
    this._treeAssets = trees;
    /** env/signs.js library, built by main.js; null = no signs (and in the probes). */
    this.signs = SIGNS.enabled ? signs : null;
    this._signFrame = makeFrame();
    /** Guardrail and fence materials; the geometry is per chunk (`_buildBarriers`). */
    this.barriers = BARRIERS.enabled ? createBarrierMaterials() : null;
    /** Station -> hazard, per side: neighbouring chunks look at the same stations. */
    this._hazard = [new Map(), new Map()];
    this._signForeign = [];
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
    this._lush = new THREE.Color(TERRAIN_COLORS.lush);
    this._shade = new THREE.Color(TERRAIN_COLORS.shade);
    this._bracken = new THREE.Color(TERRAIN_COLORS.bracken);
    this._heather = new THREE.Color(TERRAIN_COLORS.heather);
    this._fresh = new THREE.Color(TERRAIN_COLORS.fresh);
    this._rush = new THREE.Color(TERRAIN_COLORS.rush);
    this._tpiCache = new Map();

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
      color: (x, z, y, ny, d, out, nx, nz, bare) => this._groundColor(x, z, y, ny, d, out, nx, nz, bare),
    });
    /** Where the tiles are centred. main.js points this at the car; null = the road at carS. */
    this.focus = null;

    /** What kind of country each place is (biomes.js) — read by every scatter. */
    this.biomes = createBiomes(terrain, this.field.seed);
    this.field.lakes.biomeChance = (x, z) => this.biomes.mix(this.biomes.biomeAt(x, z), 'lake');
    /** Hamlets, villages and far cities (towns.js); they level the ground, so the field asks them. */
    this.towns = TOWNS.enabled ? new Towns({
      scene, path, field: this.field, terrain,
      onChange: (x0, z0, x1, z1) => {
        this.tiles._invalidate(x0, z0, x1, z1);
        if (this._gyCache) this._gyCache.clear();
      },
    }) : null;
    this.field.towns = this.towns;
    setEcology(this.biomes, (x, z) => this.field.lakes.shoreU(x, z),
      this.towns ? (x, z) => this.towns.clear(x, z) : null);
    this._tint = [1, 1, 1];
    /** Lake surfaces (env/water.js). */
    this.water = new WaterSystem({ scene, field: this.field });
    /** Gaps cut across the road and the bridges over them (bridges.js); a term in the field, like the cities. */
    this.bridges = BRIDGES.enabled ? new Bridges({
      scene, path, field: this.field, terrain, biomes: this.biomes, world, RAPIER,
      materials: bridgeMaterials, water: this.water,
      onChange: (x0, z0, x1, z1) => {
        this.tiles._invalidate(x0, z0, x1, z1);
        if (this._gyCache) this._gyCache.clear();
      },
    }) : null;
    this.field.bridges = this.bridges;
    this._sand = new THREE.Color(TERRAIN_COLORS.sand);
    this._mud = new THREE.Color(TERRAIN_COLORS.mud);

    // A tier is a plain descriptor; everything that differs is a number, so
    // `_buildGrass` is one function.
    this.canopyQueue = [];
    this.sheetQueue = [];
    /** Per-instance view culling for the legacy trees (instcull.js). */
    this.culler = new InstanceCuller();
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
  }

  _buildSharedAssets() {
    this.ground = createGroundAssets({ anisotropy: this.anisotropy });
    this.matTerrain = this.ground.material;
    this.apron = null;

    this.road = createRoadAssets({ anisotropy: this.anisotropy, cover: this.ground.material.userData.uniforms });
    this.matRoad = this.road.material;

    // Null where switched off; both come back texture-less rather than throwing
    // when there is no canvas, so the headless probes run the real scatter.
    // TreeGen's library is normally built by main.js across boot frames and
    // handed in; built here at once when it was not (probes).
    const treegen = TREES.generator === 'treegen';
    this.trees = !TREES.enabled ? null
      : treegen ? (this._treeAssets || createTreeGenAssets())
        : createTreeAssets();
    /** TreeGen trees are drawn by the forest, one level of detail each (forest.js). */
    this.forest = this.trees && treegen ? new Forest(this.scene, this.trees) : null;
    /** Shrubs are TreeGen bushes in the same library, so only with the forest. */
    this.bushes = this.forest && BUSHES.enabled;

    this.grass = GRASS.enabled ? createGrassAssets({ anisotropy: this.anisotropy }) : null;
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
    // Road generated since the tiles last synced is not carved yet.
    this.field.sync();
    const f = this.path.frameAt(s, this._frame);
    this._rightFlat.crossVectors(f.tan, WORLD_UP).normalize();
    const span = this.bridges && Math.abs(v) <= ROAD.halfWidth + ROAD.shoulder + 2 ? this.bridges.spanAt(s) : null;
    if (Math.abs(v) <= ROAD.halfWidth || span) {
      // On the carriageway the surface is the road ribbon (and its collider),
      // which sits ROAD_SINK + ROAD_LIFT above the terrain under it; on a
      // bridge, its deck to the parapets.
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
    // Without it a tile, a prop scatter and a grass chunk could
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
      this._growRoad(fp.x, fp.z, 3);
      this.tiles.update(fp.x, fp.z, TILES.buildPerFrame,
        Math.max(TILES.msPerFrame, Math.min(0.25 * (this._frameMs || 16.7), 30)));
      if (PERF.on) PERF.add('.tiles', performance.now() - t0);
      this.water.update(fp.x, fp.z, this.time);
      if (this.towns) {
        const t1 = PERF.on ? performance.now() : 0;
        this.towns.update(fp.x, fp.z);
        if (PERF.on) PERF.add('.towns', performance.now() - t1);
      }
      if (this.bridges) {
        const t1 = PERF.on ? performance.now() : 0;
        this.bridges.update(fp.x, fp.z);
        if (PERF.on) PERF.add('.bridges', performance.now() - t1);
      }
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
    } else {
      // Eviction still has to run every frame, or a departed chunk keeps its
      // cover.
      this._updateCanopy(carS, 0);
      this._updateGrass(carS, 0);
    }
    this._cullGrass(carS);
  }

  /**
   * Grows the road until its end is out of reach of every built tile. New
   * road reshapes the ground within CARVE_REACH of it (the carve, and the
   * octave budget keyed on road distance), so road generated any nearer
   * rebuilt hillsides in full view and left stale ground standing over the
   * new ribbon until the rebuild caught up (probe/pops.mjs). `steps` caps the
   * control points per call: where the road swings back toward the car an
   * uncapped catch-up was a 9 ms frame.
   */
  _growRoad(fx, fz, steps = 512) {
    const R = TILES.radius + CARVE_REACH + ROAD.ctrlSpacing;
    const path = this.path;
    for (let n = 0; n < steps; n++) {
      const e = path.pts[path.framedUpTo].p;
      if (Math.hypot(e.x - fx, e.z - fz) > R) return;
      path.ensureLength(path.length + ROAD.ctrlSpacing);
    }
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
    this._growRoad(fp.x, fp.z);
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
      for (const part of obj.userData.parts || []) {
        if (part.mesh !== obj) { part.mesh.geometry.dispose(); part.mesh.dispose(); }
      }
    }
    if (this.forest) this.forest.removeChunk(chunk.index);
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
    if (this.towns) this.towns.dispose();
    if (this.bridges) this.bridges.dispose();
    this.road.dispose();
    if (this.forest) this.forest.dispose();
    if (this.trees) this.trees.dispose();
    if (this.ground) this.ground.dispose();
    if (this.grass) this.grass.dispose();
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

    if (this.signs) this._buildSigns(index, s0, s1, objects);
    lapq('..signs');

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
    };
    this.chunks.set(index, chunk);
    this.propQueue.push({ index, s0, s1, origin });
  }

  /**
   * Road signs for one chunk, added to its `objects`. A pure function of the
   * road and the chunk index: chevrons along the outside of sharp bends, a
   * warning `curveLead` before a bend starts (and, back to the player, the
   * oncoming side's), and one feature roll, kept `spacing` from the rest.
   * Facing +1 = towards the player, -1 = towards oncoming traffic.
   */
  /**
   * Guardrail and fence for one chunk (env/barriers.js): on the outside of a
   * bend sharper than `BARRIERS.curv`, and wherever the ground `probe` metres
   * past the edge lies `drop` below the road. Steel on a dual carriageway; on
   * a country road timber for `woodShare` of runs, steel where the fall is big.
   */
  _buildBarriers(s0, s1, origin, objects, colliders) {
    const job = this._barrierJob(s0, s1, origin, objects, colliders);
    while (!job.next().done);
  }

  /** `_buildBarriers` as a resumable job: run in the chunk's scatter, under its frame budget. */
  *_barrierJob(s0, s1, origin, objects, colliders) {
    const B = BARRIERS, step = B.step;
    const f = this._signFrame, g = this._cA;
    const k0 = Math.ceil(s0 / step), k1 = Math.ceil(s1 / step) - 1;
    const woodShare = B.woodShare[Math.min(1, ROAD.lanesPerSide - 1)];
    const v = ROAD.halfWidth + B.offset;
    const mesher = new BarrierMesher();
    const rng = mulberry32(hashInt(k0 * 0x45d9f3b + 0x1b873593));
    for (const side of [-1, 1]) {
      const memo = this._hazard[side > 0 ? 1 : 0];
      const drop = (k) => {
        this.path.frameAt(k * step, f);
        return f.pos.y - this.groundAt(k * step, side * (ROAD.halfWidth + B.probe + B.offset), g).y;
      };
      const hazard = (k) => {
        if (k < 0) return false;
        let h = memo.get(k);
        if (h === undefined) {
          const fall = drop(k);
          h = fall > B.drop || (Math.sign(f.curv) === side && Math.abs(f.curv) > B.curv);
          if (memo.size > 50000) memo.clear();
          memo.set(k, h);
        }
        return h;
      };
      for (const run of barrierRuns(k0, k1, hazard, B, side, woodShare)) {
        yield;
        // The chunk's posts, plus the next one to carry its last span to.
        const a = Math.max(run.a, k0), b = Math.min(run.b, k1 + 1);
        if (b <= a) continue;
        let wood = run.wood;
        if (wood) for (let k = a; k <= b; k++) if (drop(k) > B.steelDrop) { wood = false; break; }
        // A bridge has its own parapets: the run stops at each end of one, turned down there.
        const onBridge = (k) => !!(this.bridges && this.bridges.spanAt(k * step, 6));
        for (let pa = a; pa <= b; pa++) {
          if (onBridge(pa)) continue;
          let pb = pa;
          while (pb < b && !onBridge(pb + 1)) pb++;
          const head = pa === a ? run.a >= k0 : true, tail = pb === b ? run.b <= k1 : true;
          this._barrierPiece(pa, pb, k1, side, v, origin, wood, head, tail, mesher, rng, colliders);
          pa = pb;
        }
      }
    }
    const geos = mesher.finish();
    for (const [kind, geo] of Object.entries(geos)) {
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, this.barriers[kind]);
      mesh.position.copy(origin);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.ownsGeometry = true;
      mesh.userData.barrier = kind;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.scene.add(mesh);
      objects.push(mesh);
    }
  }

  /** Stations `a..b` of one barrier run (the chunk's posts, `k1` its last), meshed into `mesher`, with colliders. */
  _barrierPiece(a, b, k1, side, v, origin, wood, head, tail, mesher, rng, colliders) {
    const B = BARRIERS, step = B.step;
    const f = this._signFrame, g = this._cA, right = this._rightFlat;
    if (b <= a) return;
    const pts = [];
    for (let k = a; k <= b; k++) {
      const s = k * step;
      this.path.frameAt(s, f);
      right.crossVectors(f.tan, WORLD_UP).normalize();
      const p = this.groundAt(s, side * v, g);
      pts.push({
        x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z,
        ox: right.x * side, oz: right.z * side,
        post: k <= k1, rail: k < b && k <= k1,
      });
    }
    if (wood) mesher.wood(pts, rng);
    else mesher.steel(pts, rng, head, tail);
    if (!this.world || !B.colliders) return;
    // A thin box per span: the player's car stops against it.
    for (let i = 0; i + 1 < pts.length; i++) {
      if (!pts[i].rail) continue;
      const p = pts[i], q = pts[i + 1];
      const dx = q.x - p.x, dz = q.z - p.z, len = Math.hypot(dx, dz);
      const th = Math.atan2(-dz, dx);
      colliders.push(this.world.createCollider(
        this.RAPIER.ColliderDesc.cuboid(len / 2, 0.45, 0.08)
          .setTranslation(origin.x + (p.x + q.x) / 2, origin.y + (p.y + q.y) / 2 + 0.45, origin.z + (p.z + q.z) / 2)
          .setRotation({ x: 0, y: Math.sin(th / 2), z: 0, w: Math.cos(th / 2) })
          .setFriction(0.3)));
    }
  }

  _buildSigns(index, s0, s1, objects) {
    const S = SIGNS;
    const roles = this.signs.roles;
    const rng = mulberry32(hashInt(index * 0x2c1b3c6d + 0x51f15e));
    const f = this._signFrame;
    const curv = (s) => this.path.frameAt(s, f).curv;
    const bent = (s) => s >= 0 && Math.abs(curv(s)) > S.bendCurv;
    const pick = (role, dir = 0) => {
      const list = (roles.get(role) || []).filter((v) => !dir || v.dir === dir);
      return list.length ? list[Math.floor(rng() * list.length)] : null;
    };
    const taken = [];
    const put = (variant, s, side, facing) => {
      if (!variant) return;
      const over = variant.role === 'portal';
      const run = variant.role === 'chevron';
      if (taken.some((t) => Math.abs(t.s - s) < S.spacing && !(run && t.run) && (over || t.over || t.side === side))) return;
      if (this.bridges && this.bridges.spanAt(s, 12)) return;
      const { box } = variant;
      this.path.frameAt(s, f);
      let v, y;
      const right = this._rightFlat.crossVectors(f.tan, WORLD_UP).normalize();
      const rx = right.x, rz = right.z;
      if (variant.role === 'portal') {
        v = 0;
        const a = this.groundAt(s, S.gantryLeg, this._cA).y, b = this.groundAt(s, -S.gantryLeg, this._cB).y;
        y = Math.min(a, b);
        if (f.pos.y - y > S.gantryDrop) return;
      } else {
        // Local +x is the face's right: the road's right when it faces the player.
        // The road is at local -side*facing; a cantilever's column is the far side.
        const toward = -side * facing;
        const reach = variant.role === 'cantilever' ? -(box.max.x - 0.6) : toward > 0 ? box.max.x : -box.min.x;
        v = side * (EDGE + S.clearance + reach);
        y = this.groundAt(s, v, this._cA).y;
        if (variant.role === 'cantilever' && f.pos.y - y > S.gantryDrop) return;
      }
      const span = Math.abs(v) + Math.max(box.max.x, -box.min.x) + 4;
      const corridor = this.path.corridorAt(s);
      if (Math.min(corridor.left, corridor.right) < span) return;
      const x = f.pos.x + rx * v, z = f.pos.z + rz * v;
      if (this.path.foreignSegments(s, x, z, S.foreignRadius, this._signForeign)) return;
      const obj = this.signs.instance(variant);
      obj.position.set(x, y - S.sink, z);
      obj.rotation.y = Math.atan2(-f.tan.x * facing, -f.tan.z * facing);
      if (variant.role !== 'portal' && variant.role !== 'cantilever') {
        // Set by hand and never straightened since.
        obj.rotation.y += (rng() - 0.5) * 0.07;
        obj.rotation.z = (rng() - 0.5) * 0.035;
      }
      obj.updateMatrix();
      obj.matrixAutoUpdate = false;
      this.scene.add(obj);
      objects.push(obj);
      taken.push({ s, side, run, over: over || variant.role === 'cantilever' });
    };

    const step = S.chevronStep;
    // A run of chevrons along the whole of a bend that peaks sharp somewhere near.
    const sharp = (s, sign) => [-60, -30, 0, 30, 60].some((d) => s + d >= 0 && curv(s + d) * sign > S.chevronCurv);
    for (let s = Math.ceil(s0 / step) * step; s < s1; s += step) {
      const sign = Math.sign(curv(s));
      if (bent(s) && sharp(s, sign)) put(pick('chevron', sign), s, sign, 1);
    }
    // A bend starts where the road has run straight for `curveLead` and stays
    // bent for `curveHold`; curvature hovering at the threshold is not a bend.
    const starts = (s, d) => {
      for (let t = 0; t <= S.curveHold; t += 10) if (!bent(s + d * t)) return false;
      for (let t = 10; t <= S.curveLead; t += 10) if (bent(s - d * t)) return false;
      return true;
    };
    for (let s = Math.ceil(s0 / 10) * 10; s < s1; s += 10) {
      const ahead = s + S.curveLead, behind = s - S.curveLead;
      if (starts(ahead, 1)) put(pick('curve', Math.sign(curv(ahead))), s, 1, 1);
      if (behind - S.curveHold >= 0 && starts(behind, -1)) put(pick('curve', -Math.sign(curv(behind))), s, -1, -1);
    }
    if (rng() > S.featureChance) return;

    let r = rng() * Object.values(S.mix).reduce((a, b) => a + b, 0);
    let role = 'back';
    for (const [k, w] of Object.entries(S.mix)) if ((r -= w) < 0) { role = k; break; }
    const s = s0 + 15 + rng() * (s1 - s0 - 30);
    if (role === 'back') put(pick(['speed', 'warn', 'guide'][Math.floor(rng() * 3)]), s, -1, -1);
    else if (role === 'pennant') put(pick(role), s, -1, 1);
    else put(pick(role), s, 1, 1);
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
      if (obj.isInstancedMesh) this.culler.add(obj);
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
    // How bare each vertex is (rock or soil): the grass keeps off it.
    const bare = new Float32Array(vertCount);
    const ext = { rock: 0, soil: 0 };
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
        // The grid's normal may point down (winding): flip it up for the aspect.
        const up = ny < 0 ? -1 : 1;
        const jit = this._groundColor(wx, wz, positions[k * 3 + 1] + origin.y,
          Math.abs(ny / nl), Math.abs(this.lateral[i]), c, up * nx / nl, up * nz / nl, ext);
        colors[k * 3] = c.r * jit; colors[k * 3 + 1] = c.g * jit; colors[k * 3 + 2] = c.b * jit;
        bare[k] = Math.max(ext.rock, ext.soil);
      }
    }
    return { positions, colors, bare };
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
   * A chunk's scatter (props, grass) waits for its sheet.
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
  _groundColor(x, z, y, ny, av, out, nx = 0, nz = 0, bare = null) {
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

    // Where the ground sits in its landscape (topographic position): a crest
    // is exposed, thin-soiled and dry; a hollow gathers water and soil.
    const tpi = this._tpi(x, z);
    // Quartiles are ±3.5 m, the 5th/95th percentiles ±15 m (seed highroads-01).
    const ridge = smoothstep(2, 12, tpi), hollow = smoothstep(-2, -12, tpi);
    // Aspect: a face turned to the sun dries out, one turned away stays cool.
    // sin(slope) × cos(angle to the sun), so flat ground is neither.
    const sunward = nx * SUNWARD[0] + nz * SUNWARD[1];

    // Sun-bleached patches, weighted to higher, flatter, sunnier, exposed ground.
    const dry = clamp((fine - 0.42) * 2.1, 0, 1) * lerp(0.35, 1, smoothstep(0.45, 0.9, ny))
      * lerp(0.5, 1, alt) + clamp(sunward * 1.4, 0, 0.45) + ridge * 0.3 - hollow * 0.4 + TERRAIN.dryness * 0.5;
    out.lerp(this._grassDry, clamp(dry, 0, 1) * 0.62);
    out.lerp(this._lush, clamp(hollow * 0.55 + Math.max(0, -TERRAIN.dryness) * 0.35, 0, 1));
    out.lerp(this._shade, clamp(-sunward * 1.6, 0, 0.5));

    // Plant communities, in patches tens of metres across with soft edges:
    // bracken on slopes, heather on high crests, fresh sward on the flat,
    // rush in the wet hollows.
    const m1 = this.terrain.mask(x, z, 0.012, 311, -97);
    const m2 = this.terrain.mask(x, z, 0.009, -523, 410);
    const m3 = this.terrain.mask(x, z, 0.016, 77, 1203);
    out.lerp(this._bracken, smoothstep(0.6, 0.68, m1) * lerp(0.35, 0.85, smoothstep(0.98, 0.82, ny)) * (1 - hollow));
    out.lerp(this._heather, smoothstep(0.6, 0.68, m2) * clamp(ridge * 0.8 + alt * 0.6, 0, 0.8));
    out.lerp(this._fresh, smoothstep(0.6, 0.68, m3) * (1 - ridge) * 0.55);
    out.lerp(this._rush, hollow * smoothstep(0.45, 0.6, m1) * 0.6);

    // Scrub where grass cannot hold: moderately steep, or high.
    const steep = smoothstep(0.96, 0.8, ny);
    out.lerp(this._scrub, Math.max(steep * 0.55, smoothstep(150, 330, rel) * 0.45));

    // Peak and snow only where the ground is flat enough to hold them.
    out.lerp(this._peak, smoothstep(300, 520, rel) * 0.8);
    const snow = WORLD_BIOME.snowLine === false ? 0 : smoothstep(430, 640, rel) * smoothstep(0.52, 0.86, ny);
    out.lerp(this._snow, snow);

    // The biome's own cast: straw in savanna, cold blue-green in the boreal
    // forest. Blended across a border like everything else biome-driven.
    {
      const B = this.biomes.biomeAt(x, z);
      const ta = BIOMES[B.a].tint, tb = BIOMES[B.b].tint, t = B.t, k = WORLD_BIOME.tintMix ?? 1;
      out.r *= 1 + (ta[0] + (tb[0] - ta[0]) * t - 1) * k;
      out.g *= 1 + (ta[1] + (tb[1] - ta[1]) * t - 1) * k;
      out.b *= 1 + (ta[2] + (tb[2] - ta[2]) * t - 1) * k;
    }
    // Lakes: wet mud under the water, a pale beach around it.
    const u = this.field.lakes.shoreU(x, z);
    if (u < 1.5) {
      out.lerp(this._mud, 1 - smoothstep(0.75, 1.0, u));
      out.lerp(this._sand, smoothstep(0.86, 1.0, u) * (1 - smoothstep(1.08, 1.32, u)) * 0.85);
    }

    const V = GROUND.verge.band;
    out.lerp(this._dirt, (1 - smoothstep(V[0], V[1], av)) * 0.9);

    // BARE ground, which the terrain shader draws (env/ground.js) with crisp,
    // broken edges rather than this colour's smooth wash: rock on steep faces,
    // on high ground and in outcrops along crests; bald, eroded soil on
    // steepish slopes and exposed crests. None on the verge or a beach.
    if (bare) {
      const keep = smoothstep(V[1], V[1] + 3, av) * (u < 1.5 ? smoothstep(1.1, 1.4, u) : 1) * (1 - snow * 0.7);
      // Half the land is flatter than ny 0.99, a tenth steeper than 0.88.
      const RS = WORLD_BIOME.rockSlope || ROCK_SLOPE;
      let rock = smoothstep(RS[0], RS[1], ny + (fine - 0.5) * 0.1);
      // Crest outcrops only where the crest falls away: on a flat top a grey
      // patch with no relief reads as a puddle, not a tor.
      rock = Math.max(rock, ridge * smoothstep(0.66, 0.78, m2) * smoothstep(0.995, 0.95, ny) * 0.85, smoothstep(260, 460, rel) * 0.7);
      const soil = clamp(smoothstep(0.975, 0.88, ny) * smoothstep(0.3, 0.6, m3) + ridge * 0.45 * smoothstep(0.45, 0.7, fine), 0, 1);
      bare.rock = clamp(rock * TERRAIN.rock, 0, 1) * keep;
      bare.soil = clamp(soil * TERRAIN.soil, 0, 1) * (1 - bare.rock) * keep;
    }

    return 0.92 + fine * 0.16;
  }

  /**
   * Topographic position, metres: how far a point stands above (+, a crest)
   * or below (−, a hollow) the mean of the natural ground 120 m around it.
   * Bilinear over a 64 m lattice cached for the session — it is smooth at that
   * scale, and five terrain samples a vertex would double a tile's build.
   */
  _tpi(x, z) {
    const C = 64;
    const fx = x / C, fz = z / C, i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const a = this._tpiAt(i, j), b = this._tpiAt(i + 1, j);
    const c = this._tpiAt(i, j + 1), d = this._tpiAt(i + 1, j + 1);
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  /** Tall-grove weight at (x, z), 0..1 (`TREES.grove`). */
  _grove(x, z) {
    const G = TREES.grove;
    return smoothstep(G.window[0], G.window[1], this.terrain.mask(x, z, G.freq, 6113, -2741));
  }

  /** Height factor for a tree at (x, z): the wood's age, and the grove `tall` it stands in. */
  _heightMul(x, z, tall) {
    const G = TREES.grove;
    const age = smoothstep(0.367, 0.631, this.terrain.mask(x, z, G.ageFreq, -3307, 1559));
    return lerp(G.age[0], G.age[1], age) * lerp(1, G.boost, tall);
  }

  /**
   * A tree's foliage tint, multiplied into its instance colour (the bark
   * ignores most of it, env/treegen.js). A slow field drifts whole woods
   * between yellow-green and blue-green; a coarse cell hash turns some
   * broadleaf stands to gold or copper. Neighbours share both, so a stand
   * reads as one wood, and the next wood over as another.
   */
  _treeTint(x, z, name, rng, out) {
    const m = this.terrain.mask(x, z, 0.0045, 1931, -277);
    const t = smoothstep(0.35, 0.65, m);
    let r = lerp(1.08, 0.88, t), g = lerp(1.06, 0.98, t), b = lerp(0.8, 1.06, t);
    const cell = hashInt(Math.floor(x / 90) * 73856093 ^ Math.floor(z / 90) * 19349663) / 4294967296;
    if (FOLIAGE[name]?.guild !== 'conifer' && cell < TREES.autumnShare) {
      const copper = cell < TREES.autumnShare * 0.4;
      const k = 0.75 + rng() * 0.5;
      r *= lerp(1, copper ? 1.36 : 1.3, k); g *= lerp(1, copper ? 0.84 : 1.0, k); b *= lerp(1, 0.58, k);
    }
    out.r *= r; out.g *= g; out.b *= b;
  }

  _tpiAt(i, j) {
    const key = (i + 0x100000) * 0x200000 + (j + 0x100000);
    let v = this._tpiCache.get(key);
    if (v === undefined) {
      const t = this.terrain, x = i * 64, z = j * 64, R = 120;
      v = t.base(x, z, 3) - 0.25 * (t.base(x + R, z, 3) + t.base(x - R, z, 3) + t.base(x, z + R, 3) + t.base(x, z - R, 3));
      // ponytail: whole-cache clear at 200k entries (~40 km of road); an LRU if a long run ever stutters on it.
      if (this._tpiCache.size > 200000) this._tpiCache.clear();
      this._tpiCache.set(key, v);
    }
    return v;
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
    // Resurfacing seams: a doubled row, so the age steps instead of blending.
    const L = ROAD_SURFACE.sectionCell;
    for (let c = Math.floor((s0 - SEAM_SHIFT) / L); c * L + SEAM_SHIFT < s1; c++) {
      for (const x of [c * L + SEAM_SHIFT, roadSeam(c)]) {
        if (x <= s0 || x >= s1 || Math.abs(x / half - Math.round(x / half)) < 1e-3) continue;
        // The seam's doubled row replaces a regular row at the same station.
        const r = stations.findIndex((st) => !st.mark && !st.seam && Math.abs(st.s - x) < 1e-4);
        if (r >= 0) stations.splice(r, 1);
        stations.push({ s: x, seam: true });
      }
    }
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
      } else if (st.seam) {
        rows.push({ s: st.s, dash: dashOn(st.s, half), side: -1 });
        rows.push({ s: st.s, dash: dashOn(st.s, half), side: 1 });
      } else {
        // The state of the dash this row ENDS. A row at a dash boundary that
        // is not doubled (the chunk's last, s1 — 120 m is a whole number of
        // dashes) otherwise takes the next dash's state, and the paint fades
        // across the last segment of every chunk.
        rows.push({ s: st.s, dash: dashOn(st.s - 1e-4, half) });
      }
    }

    const nu = rows.length;
    const positions = new Float32Array(nu * nv * 3);
    const colors = new Float32Array(nu * nv * 3);
    // Road space for env/road.js: (across, along mod ROAD_S_PERIOD) in metres,
    // and each carriageway's resurfacing age.
    const roadUV = new Float32Array(nu * nv * 2);
    const roadAge = new Float32Array(nu * nv * 2);
    const sBase = Math.floor(s0 / ROAD_S_PERIOD) * ROAD_S_PERIOD;
    const age = [0, 0];
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
      roadAges(s + (rows[j].side || 0) * 1e-3, age);
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
        roadUV[k * 2] = col.v;
        roadUV[k * 2 + 1] = s - sBase;
        roadAge[k * 2] = age[0];
        roadAge[k * 2 + 1] = age[1];
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
    geometry.setAttribute('roadUV', new THREE.BufferAttribute(roadUV, 2));
    geometry.setAttribute('roadAge', new THREE.BufferAttribute(roadAge, 2));
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
    const out = [];
    const chunk = this.chunks.get(index);
    if (!chunk || !chunk.sheet) return out;
    // Barriers first, in this job rather than the chunk's build: a few ms of
    // ground samples that the build frame, already holding the road and its
    // collider, cannot spare (probe/stream.mjs).
    if (this.barriers) yield* this._barrierJob(s0, s1, origin, out, chunk.extraColliders);
    if (!this.trees) return out;

    // Seeded per chunk, so a reload comes back identical instead of reshuffling.
    const rng = mulberry32(hashInt(index) ^ 0x9e3779b9);

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
    /** TreeGen: every placed tree, handed to the forest at the end. */
    const forestTrees = [];
    const toForest = (variant, lone) => forestTrees.push({
      variant, matrix: this._mat.clone(), origin,
      colour: [this._color.r, this._color.g, this._color.b], lone,
    });
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

    const grow = this.forest ? TREES.treegen.scale : 1;
    /** A species' weight, raised inside a tall grove for `grove` species. */
    const weightOf = (name, tall) => FOLIAGE[name].weight * (1 + (FOLIAGE[name].grove || 0) * tall);
    if (this.trees) {
      // The guild field at the chunk's middle, sampled once, only to weight
      // which species the chunk commits to.
      look(lerp(s0, s1, 0.5), 60);
      {
        const mx = p.x + origin.x, mz = p.z + origin.z;
        vegetation(this.terrain, mx, mz,
          p.y + origin.y - this.terrain.continent(mx, mz), 0.1, 60, field);
      }
      const midTall = this._grove(p.x + origin.x, p.z + origin.z);
      const chosen = commit(TREE_NAMES, this.trees.library, TREES.picks,
        (n) => (0.15 + guildAffinity(FOLIAGE[n], field)) * weightOf(n, midTall));
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
        if (field.canopy < lerp(0.16, 0.24, TERRAIN.clumping)) continue;
        const ctall = this._grove(cx, cz);
        const u = rng();
        // Drawn against the field AT THE SEED, not the chunk's picks, so the
        // copse's species is the one that belongs here.
        let best = null, bestW = 0;
        for (const name of kinds) {
          const w = suitability(FOLIAGE[name], field, crelief, cslope, Math.abs(cv)) *
            weightOf(name, ctall) * (0.25 + rng());
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
        this._treeTint(wx, wz, name, rng, this._color);

        // Both tiers take the same matrix, so the cross-fade is one tree at one
        // size, drawn at two subdivisions.
        p.set(wx - origin.x, wy - origin.y, wz - origin.z);
        this._setLocalMatrix(p, height * wobble, height, height * wobble, yaw);

        if (this.forest) {
          // One tree, one record: the forest picks its level per frame. A tree
          // with no near slot is a far-only (lone) one, as in the legacy tiers.
          if (paired || far < TREES.farCap) {
            toForest(variant, !paired);
            if (paired) placed++;
            far++;
          }
          return;
        }

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
        if (clusters.length && rng() < lerp(0.5, 0.97, TERRAIN.clumping)) {
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
        // A tree outside any stand only inside real woodland: open ground
        // dotted with strays read as a scatter, not a landscape of woods.
        // (canopy: median 0.04, 75th percentile 0.11, 90th 0.31 — woods are the top fifth.)
        if (!home && field.canopy < TERRAIN.clumping * 0.18) continue;
        const tall = this._grove(wx, wz);

        // Weighted pick across every committed species that will grow here,
        // with the cluster's own species heavily favoured.
        let total = 0;
        for (let k = 0; k < kinds.length; k++) {
          const name = kinds[k];
          let w = suitability(FOLIAGE[name], field, relief, slope, av) * weightOf(name, tall);
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
        let height = lerp(kind.height[0], kind.height[1], rng() * rng() + 0.15) * grow;
        height *= lerp(1, 1 - TREES.vigour, edgeness) * this._heightMul(wx, wz, tall);
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
          // Packed woods, empty fields: the stand field sharpened by `clumping`.
          const keep = lerp(field.canopy * TREES.distantDensity, smoothstep(0.1, 0.32, field.canopy), TERRAIN.clumping);
          if (drng() > keep) continue;
          let total = 0, pick = null;
          const tall = this._grove(wx, wz);
          for (const name of kinds) {
            const w = suitability(FOLIAGE[name], field, relief, slope, 100) * weightOf(name, tall);
            total += w;
            if (w > 0 && drng() * total < w) pick = name;
          }
          if (!pick) continue;
          const kind = FOLIAGE[pick];
          const height = lerp(kind.height[0], kind.height[1], drng() * drng() + 0.15) * grow *
            this._heightMul(wx, wz, tall);
          p.set(wx - origin.x, wy - origin.y - 0.2, wz - origin.z);
          this._groundColor(wx, wz, wy, 1, smp.d, this._color);
          const gk = TREES.groundTint;
          this._color.r = (1 - gk) + gk * this._color.r * 2;
          this._color.g = (1 - gk) + gk * this._color.g * 2;
          this._color.b = (1 - gk) + gk * this._color.b * 2;
          this._treeTint(wx, wz, pick, drng, this._color);
          const wob = 0.88 + drng() * 0.24;
          this._setLocalMatrix(p, height * wob, height, height * wob, drng() * Math.PI * 2);
          if (this.forest) {
            toForest(this.trees.library.get(pick)[this._lastChosen.get(pick)], false);
          } else {
            const variant = this.trees.far.get(pick)[this._lastChosen.get(pick)];
            push(`f:${pick}`, variant.geometry, this.trees.farMaterial, this._mat, this._color, false, false);
          }
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
      const chosen = commit(SHRUB_NAMES, this.trees.library, BUSHES.picks,
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
        const variant = this.trees.library.get(name)[chosen.get(name)];
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
        this._setLocalMatrix(p, height * wobble, height, height * wobble, rng() * Math.PI * 2);
        toForest(variant, false);
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
    if (this.forest) this.forest.addChunk(index, forestTrees);

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
        this.culler.add(mesh);
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

    const { positions, colors, bare: bareV } = chunk.sheet;
    const lat = this.lateral;
    const nv = lat.length;
    const nu = CHUNK.segmentsU;
    const rowLen = (s1 - s0) / nu;

    // Seeded per chunk, salted off the prop seed so grass and trees differ.
    const rng = mulberry32(hashInt(index) ^ tier.salt);

    // From the middle of the verge: the gravel shoulder carries no tufts.
    const V = GROUND.verge;
    const inner = V.enabled ? (V.band[0] + V.band[1]) / 2 : EDGE - 0.35;
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

        const w = (rowLen * usable * thin(mid) * cover * (1 - (bareV ? bareV[a] : 0))) / (bz * bz);
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
    // The chunk is drawn as PARTS: four 30 m segments along the road × the
    // two sides of it, each its own mesh with its own bounds, so the parts
    // behind or beside the camera cull. (Whole-chunk and half-chunk meshes
    // were measured drawing ~80 % of their tufts out of view.)
    const SEGS = 4, PARTS = SEGS * 2;
    const keyOf = new Uint8Array(samples);
    const bb = [];
    for (let q = 0; q < PARTS; q++) bb.push([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
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
      // A world biome may turn the tufts toward its own (snow: dead straw standing out of it).
      if (GRASS_COL) {
        const [c, k] = GRASS_COL;
        for (let q = 0; q < 3; q++) colours[o + q] += (c[q] * lift - colours[o + q]) * k;
      }
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
      const key = Math.min(SEGS - 1, Math.floor(Math.floor(a / nv) * SEGS / nu)) * 2 + (lat[col] < 0 ? 0 : 1);
      keyOf[placed] = key;
      const B = bb[key];
      if (p.x < B[0]) B[0] = p.x; if (p.x > B[3]) B[3] = p.x;
      if (p.y < B[1]) B[1] = p.y; if (p.y + height > B[4]) B[4] = p.y + height;
      if (p.z < B[2]) B[2] = p.z; if (p.z > B[5]) B[5] = p.z;
      placed++;
    }

    if (!placed) return null;


    // A per-chunk clone of the 8-vertex tuft: the per-instance kind and bloom
    // attributes live on the geometry, so it cannot be shared.
    // Group the instances by part (a stable counting sort keeps road order
    // inside each part, so the fade-reach cull is still a prefix per part).
    const start = new Uint32Array(PARTS + 1);
    for (let k = 0; k < placed; k++) start[keyOf[k] + 1]++;
    for (let q = 0; q < PARTS; q++) start[q + 1] += start[q];
    const ranges = [];
    for (let q = 0; q < PARTS; q++) ranges.push([start[q], start[q + 1]]);
    {
      const m2 = new Float32Array(placed * 16), c2 = new Float32Array(placed * 3);
      const k2 = new Float32Array(placed), b2 = new Float32Array(placed * 3), s2 = new Float32Array(placed);
      const at = start.slice(0, PARTS);
      for (let k = 0; k < placed; k++) {
        if ((k & 4095) === 4095) yield;
        const d = at[keyOf[k]]++;
        const ks = k * 16, ds = d * 16;
        for (let e = 0; e < 16; e++) m2[ds + e] = mats[ks + e];
        c2[d * 3] = colours[k * 3]; c2[d * 3 + 1] = colours[k * 3 + 1]; c2[d * 3 + 2] = colours[k * 3 + 2];
        b2[d * 3] = blooms[k * 3]; b2[d * 3 + 1] = blooms[k * 3 + 1]; b2[d * 3 + 2] = blooms[k * 3 + 2];
        k2[d] = kinds[k]; s2[d] = sOf[k];
      }
      mats.set(m2); colours.set(c2); kinds.set(k2); blooms.set(b2); sOf.set(s2);
    }
    const sArr = sOf.subarray(0, placed);
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
      // The far tier lives past the 78 m shadow box: skip the PCF taps per
      // blade fragment (the canopy shadow map darkens it instead).
      m.receiveShadow = tier.key !== 'grassFar';
      // The shader only SHRINKS tufts (fade) and leans their tips by the wind
      // (< 0.3 m), so the instances' own bounds plus a margin are
      // conservative. Grass used to skip the cull entirely, and every grass
      // chunk was drawn every frame — including the ones behind the camera.
      m.frustumCulled = true;
      m.userData.grass = true;
      return m;
    };
    // The first non-empty part is `mesh` — it holds ALL the chunk's instances
    // in its buffers (probes and eviction see one object) and draws its own
    // range; the other parts are children drawing views of the same arrays.
    const parts = [];
    let mesh = null;
    for (let q = 0; q < PARTS; q++) {
      const [from, to] = ranges[q];
      if (to <= from) continue;
      if (!mesh) {
        mesh = make(0, placed);
        mesh.boundingSphere = sphere(bb[q]);
        parts.push({ mesh, from, to, off: 0 });
        continue;
      }
      const part = make(from, to);
      part.boundingSphere = sphere(bb[q]);
      part.matrixAutoUpdate = false;
      mesh.add(part);
      parts.push({ mesh: part, from, to, off: from });
    }
    // The parent's range starts at 0, so its buffers must hold its own part
    // first: they do (parts are in order and the first non-empty one starts
    // at 0).
    mesh.userData.sSorted = sArr;
    mesh.userData.total = placed;
    mesh.userData.parts = parts;
    mesh.count = parts[0].to - parts[0].from;
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
    for (const part of mesh.userData.parts || []) {
      if (part.mesh !== mesh) { part.mesh.geometry.dispose(); part.mesh.dispose(); }
    }
    mesh.geometry.dispose();
    mesh.dispose();
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
        // Each part draws the prefix of its own range within the fade reach.
        let any = false;
        for (const part of mesh.userData.parts) {
          let lo = part.from, hi = part.to;
          while (lo < hi) { const m = (lo + hi) >> 1; if (sArr[m] <= reach) lo = m + 1; else hi = m; }
          part.mesh.count = lo - part.from;
          if (part.mesh !== mesh) part.mesh.visible = part.mesh.count > 0;
          if (lo > part.from) any = true;
        }
        // `visible` on the parent would hide its children too: only when
        // nothing in any part is in reach.
        mesh.visible = any;
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
