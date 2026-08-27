/**
 * chunks.js — streaming terrain, road ribbon, colliders and props.
 *
 * Terrain is generated in road space: a chunk is a strip of the spline at
 * arc length u with lateral offset v. This carves the corridor, keeps seams
 * exact, and streams the ring of chunks with the car.
 */

import * as THREE from 'three';
import { CHUNK, ROAD, ROUTE, GRASS, GROUND, ROCKS, TREES, BUSHES, TERRAIN_COLORS } from './config.js';
import { clamp, lerp, smoothstep, smin, smax, mulberry32, hashInt } from './util.js';
import {
  FOLIAGE, SHRUBS, TREE_NAMES, SHRUB_NAMES, vegetation, suitability, guildAffinity,
} from './foliage.js';
import { makeFrame } from './path.js';
import { createGrassAssets } from './env/grass.js';
import { createGroundAssets } from './env/ground.js';
import { createRoadAssets } from './env/road.js';
import { createRockAssets } from './env/rocks.js';
import { createTreeAssets } from './env/trees.js';
import { createBushAssets } from './env/bushes.js';

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

  // Far field: geometric, capped at 34 m so the ridge noise stays sampled well
  // enough not to alias into spikes.
  let step = CHUNK.nearStep;
  while (v < CHUNK.halfExtent) {
    step = Math.min(step * 1.32, 34);
    v = Math.min(v + step, CHUNK.halfExtent);
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

    // A tier is a plain descriptor; everything that differs is a number, so
    // `_buildGrass` is one function.
    this.rockQueue = [];
    this.canopyQueue = [];
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
          queue: [],
        });
      }
    }
  }

  advanceTime(dt) {
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

  /** Single source of truth for ground height — mesh, props, respawn all agree. */
  sampleGround(frame, rightFlat, v, out) {
    // Nominal (pre-guard) offset, used by the horizon falloff.
    const nominal = Math.abs(v);
    v = lateralAt(frame, rightFlat, v, _latDir);
    const av = Math.abs(v);
    const x = frame.pos.x + _latDir.x * v;
    const z = frame.pos.z + _latDir.z * v;

    // Bank flattens out past the verge so the cross-slope does not tilt the
    // hillside with it.
    const bankFade = 1 - smoothstep(EDGE, EDGE + CHUNK.bankRunout, av);
    const yRoad = frame.pos.y + v * Math.tan(frame.bank) * bankFade;

    const yNatural = this.terrain.height(x, z, av);

    // Cut and fill: the natural surface clamped between a plane rising at the
    // cut slope and one falling at the fill slope. The ramp starts at zero
    // gradient and the clamp is a smooth min/max, so joins round instead of
    // creasing.
    const t = Math.max(0, av - EDGE);
    const ramp = (t * t) / (t + ROAD.shoulderRound);
    const ceiling = yRoad + ROAD.cutSlope * ramp;
    const floorY = yRoad - ROAD.fillSlope * ramp;

    // Blend width tied to a quarter of the gap: on the carriageway the floor
    // and ceiling are the same plane, so a fixed k compounds to ~1 m of terrain
    // standing on the road.
    const k = Math.min(ROAD.slopeBlend, (ceiling - floorY) * 0.25);
    let y = smax(smin(yNatural, ceiling, k), floorY, k);

    // Where the road doubles back, carve for the OTHER pass too, sunk below
    // this road's own fill line so the correction cannot touch its carriageway.
    const fo = this._foreign;
    if (fo.s !== frame.s) this._gatherForeign(frame);
    if (fo.n) {
      // Plain minimum over the segments first: smoothing inside the loop would
      // compound by k/4 per segment.
      let fCeil = Infinity;
      for (let i = 0; i < fo.n; i++) {
        const a = fo.list[i * 2];
        const b = fo.list[i * 2 + 1];
        // Closest point on the segment, in plan; `t` doubles as the interpolant
        // for the road's height there.
        const ex = b.x - a.x;
        const ez = b.z - a.z;
        const len2 = ex * ex + ez * ez;
        let f = len2 > 1e-6 ? ((x - a.x) * ex + (z - a.z) * ez) / len2 : 0;
        f = f < 0 ? 0 : (f > 1 ? 1 : f);
        const fx = x - (a.x + ex * f);
        const fz = z - (a.z + ez * f);
        const c = a.y + (b.y - a.y) * f - CHUNK.foreignSink
          + CHUNK.foreignSlope * Math.sqrt(fx * fx + fz * fz);
        if (c < fCeil) fCeil = c;
      }
      // Same k as the cut-fill clamp: on the carriageway these degrade to exact
      // min/max. The floor then guarantees the result is this road's plane.
      y = smin(y, smax(fCeil, floorY, k), k);
    }

    // Drainage ditch hugging the verge, only where the road is at grade.
    const dt = clamp((av - EDGE) / CHUNK.ditchWidth, 0, 1);
    if (dt > 0 && dt < 1) {
      const fit = 1 - smoothstep(1.5, 8.0, Math.abs(yNatural - yRoad));
      y -= CHUNK.ditchDepth * Math.sin(Math.PI * dt) * fit;
    }

    // Horizon falloff, keyed on the NOMINAL offset: the guard moves `v`, and
    // the last few columns of the sheet must fall off whatever the guard did.
    if (nominal > CHUNK.horizonFalloff) {
      y -= smoothstep(CHUNK.horizonFalloff, CHUNK.halfExtent, nominal) * CHUNK.horizonDrop;
    }

    out.set(x, y, z);
    return out;
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
    this.sampleGround(f, this._rightFlat, v, out);
    return out;
  }

  /**
   * The world-space ground under everything else.
   *
   * Road space degenerates at distance R inside a turn — rows 2.5 m apart have
   * already crossed — so the far field ends as a plain world-space grid of
   * `terrain.height`, drawn and collided UNDER the sheets.
   */
  _updateApron(carS) {
    const step = CHUNK.apronStep;
    const half = Math.round(CHUNK.apronHalf / step) * step;

    const f = this.path.frameAt(carS, this._frame);
    // Snap the centre to the sample lattice so the apron does not shimmer as
    // the car moves.
    const cx = Math.round(f.pos.x / step) * step;
    const cz = Math.round(f.pos.z / step) * step;

    const a = this.apron;
    if (a && a.cx === cx && a.cz === cz) return;
    // Hysteresis: rebuild only once the car has left the middle of the apron.
    if (a && Math.abs(cx - a.cx) < CHUNK.apronMove && Math.abs(cz - a.cz) < CHUNK.apronMove) return;

    const n = (half * 2) / step + 1;
    const count = n * n;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const indices = new Uint32Array((n - 1) * (n - 1) * 6);
    const c = this._color;

    for (let j = 0; j < n; j++) {
      const z = cz - half + j * step;
      for (let i = 0; i < n; i++) {
        const x = cx - half + i * step;
        // The LOD arg is the apron's own resolution, not a lateral offset.
        let y = this.terrain.height(x, z, CHUNK.apronDetail) - CHUNK.apronSink;

        // Duck under the carriageway: the apron carries no earthwork, so in a
        // cutting its natural surface can stand metres above the road. Cut down
        // to the road's plane, and slightly below, on a shallow ramp.
        this.path.roadNear(x, z, carS, CHUNK.apronHalf, _apronRoad);
        if (_apronRoad.dist < Infinity) {
          const cap = _apronRoad.y - CHUNK.apronRoadSink
            + _apronRoad.dist * CHUNK.foreignSlope;
          if (cap < y) y = cap;
        }

        const k = (j * n + i) * 3;
        positions[k] = x - cx;
        positions[k + 1] = y;
        positions[k + 2] = z - cz;
      }
    }

    // Normals from the finished grid, then colour — the palette keys off
    // flatness, so it has to come after the heights are all in.
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = (j * n + i) * 3;
        const xi = Math.min(n - 1, i + 1), xd = Math.max(0, i - 1);
        const zi = Math.min(n - 1, j + 1), zd = Math.max(0, j - 1);
        const dx = (positions[(j * n + xi) * 3 + 1] - positions[(j * n + xd) * 3 + 1])
          / Math.max(1e-3, (xi - xd) * step);
        const dz = (positions[(zi * n + i) * 3 + 1] - positions[(zd * n + i) * 3 + 1])
          / Math.max(1e-3, (zi - zd) * step);
        const ny = 1 / Math.sqrt(1 + dx * dx + dz * dz);
        this._groundColor(cx + positions[k], cz + positions[k + 2],
          positions[k + 1] + CHUNK.apronSink, ny, CHUNK.halfExtent, c);
        colors[k] = c.r; colors[k + 1] = c.g; colors[k + 2] = c.b;
      }
    }

    let t = 0;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const p = j * n + i;
        // Same winding as `_buildTerrain`: +column then +row is an upward face.
        indices[t++] = p; indices[t++] = p + 1; indices[t++] = p + n;
        indices[t++] = p + 1; indices[t++] = p + n + 1; indices[t++] = p + n;
      }
    }

    if (a) this._disposeApron();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, this.matTerrain);
    mesh.position.set(cx, 0, cz);
    mesh.receiveShadow = true;
    // No shadow casting: a coarse copy of ground the sheets already draw.
    mesh.castShadow = false;
    mesh.renderOrder = -1;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);

    let collider = null;
    if (this.world) {
      collider = this.world.createCollider(
        this.RAPIER.ColliderDesc.trimesh(positions, indices)
          .setTranslation(cx, 0, cz)
          .setFriction(1.0)
          .setRestitution(0.0));
    }
    this.apron = { cx, cz, mesh, collider };
  }

  _disposeApron() {
    const a = this.apron;
    if (!a) return;
    this.scene.remove(a.mesh);
    a.mesh.geometry.dispose();
    if (a.collider && this.world) this.world.removeCollider(a.collider, false);
    this.apron = null;
  }

  // -------------------------------------------------------------- lifecycle --

  /** Streams chunks in and out around the vehicle's arc length. */
  update(carS, budget = CHUNK.buildPerFrame) {
    this._updateApron(carS);
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
    while (this.pending.length && built < budget) {
      const i = this.pending.shift();
      this._build(i);
      built++;
    }

    // Scenery on a frame where no ground was built: either half stays under a
    // frame budget.
    if (!built) for (let k = 0; k < budget; k++) if (!this._flushProps()) break;

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
      // cheapest to build — the scatter already ran.
      this._updateCanopy(carS, 1);
      this._updateGrass(carS, GRASS.buildPerFrame);
      this._updateRocks(carS, 1);
    } else {
      // Eviction still has to run every frame, or a departed chunk keeps its
      // cover.
      this._updateCanopy(carS, 0);
      this._updateGrass(carS, 0);
      this._updateRocks(carS, 0);
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
    while (this._flushProps());
  }

  _dispose(chunk) {
    for (const obj of chunk.objects) {
      this.scene.remove(obj);
      // Only terrain and road geometry belong to this chunk; prop geometries
      // and materials are shared and must survive.
      if (obj.userData.ownsGeometry) obj.geometry.dispose();
      if (obj.isInstancedMesh) obj.dispose();
    }
    if (chunk.collider) this.world.removeCollider(chunk.collider, false);
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
    this.path.ensureLength(s1 + ROUTE.selfFar);

    // Chunk-local origin preserves float precision far from the world origin.
    const origin = this.path.frameAt(s0, this._frame).pos.clone();

    const objects = [];
    const terrainData = this._buildTerrain(s0, s1, origin);

    const terrainMesh = new THREE.Mesh(terrainData.geometry, this.matTerrain);
    terrainMesh.position.copy(origin);
    terrainMesh.castShadow = true;
    terrainMesh.receiveShadow = true;
    terrainMesh.userData.ownsGeometry = true;
    terrainMesh.matrixAutoUpdate = false;
    terrainMesh.updateMatrix();
    this.scene.add(terrainMesh);
    objects.push(terrainMesh);

    const roadMesh = new THREE.Mesh(this._buildRoad(s0, s1, origin), this.matRoad);
    roadMesh.position.copy(origin);
    roadMesh.receiveShadow = true;
    roadMesh.userData.ownsGeometry = true;
    roadMesh.matrixAutoUpdate = false;
    roadMesh.updateMatrix();
    this.scene.add(roadMesh);
    objects.push(roadMesh);

    // Static trimesh collider; the origin-relative buffer serves both passes.
    const desc = this.RAPIER.ColliderDesc.trimesh(terrainData.positions, terrainData.indices)
      .setTranslation(origin.x, origin.y, origin.z)
      .setFriction(1.0)
      .setRestitution(0.0);
    const collider = this.world.createCollider(desc);

    const extraColliders = [];

    const chunk = {
      index, objects, collider, origin, props: false, extraColliders,
      // The renderer's own buffers, so scattered cover sits on the visible
      // surface (and colour) by construction, not by agreement.
      sheet: {
        positions: terrainData.positions,
        colors: terrainData.colors,
      },
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

  _flushProps() {
    while (this.propQueue.length) {
      const job = this.propQueue.shift();
      const chunk = this.chunks.get(job.index);
      // The chunk may have streamed back out before this ran.
      if (!chunk || chunk.props) continue;
      for (const obj of this._buildProps(job.index, job.s0, job.s1, job.origin)) {
        obj.position.copy(job.origin);
        obj.matrixAutoUpdate = false;
        obj.updateMatrix();
        this.scene.add(obj);
        chunk.objects.push(obj);
      }
      chunk.props = true;
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------- terrain --

  _buildTerrain(s0, s1, origin) {
    const nu = CHUNK.segmentsU;
    const nv = this.lateral.length;
    const rows = nu + 1;
    const vertCount = rows * nv;

    /**
     * GHOST ROWS: sample one row past each end and compute normals over the
     * extended mesh, so boundary normals are computed by the same rule as every
     * other vertex — the neighbouring chunk's answer agrees exactly.
     */
    const extRows = rows + 2;
    const extPos = new Float32Array(extRows * nv * 3);
    const indices = new Uint32Array(nu * (nv - 1) * 6);

    const lateralAbs = new Float32Array(vertCount);
    const worldY = new Float32Array(vertCount);

    const p = new THREE.Vector3();
    const frame = makeFrame();
    const rightFlat = new THREE.Vector3();
    const dS = (s1 - s0) / nu;

    for (let e = 0; e < extRows; e++) {
      const j = e - 1;                       // -1 .. nu+1
      const s = s0 + j * dS;
      this.path.frameAt(s, frame);
      rightFlat.crossVectors(frame.tan, WORLD_UP).normalize();

      const interior = j >= 0 && j <= nu;
      for (let i = 0; i < nv; i++) {
        const v = this.lateral[i];
        this.sampleGround(frame, rightFlat, v, p);

        const ke = e * nv + i;
        extPos[ke * 3 + 0] = p.x - origin.x;
        extPos[ke * 3 + 1] = p.y - origin.y;
        extPos[ke * 3 + 2] = p.z - origin.z;

        if (interior) {
          const k = j * nv + i;
          lateralAbs[k] = Math.abs(v);
          worldY[k] = p.y;
        }
      }
    }

    // Winding +column/+row: a,b,c must give an upward face or the whole world
    // is backface-culled and lit from below.
    const extIdx = new Uint32Array((extRows - 1) * (nv - 1) * 6);
    let e2 = 0;
    for (let j = 0; j < extRows - 1; j++) {
      for (let i = 0; i < nv - 1; i++) {
        const a = j * nv + i;
        const b = a + 1;
        const c = a + nv;
        const d = c + 1;
        extIdx[e2++] = a; extIdx[e2++] = b; extIdx[e2++] = c;
        extIdx[e2++] = b; extIdx[e2++] = d; extIdx[e2++] = c;
      }
    }
    const ext = new THREE.BufferGeometry();
    ext.setAttribute('position', new THREE.BufferAttribute(extPos, 3));
    ext.setIndex(new THREE.BufferAttribute(extIdx, 1));
    ext.computeVertexNormals();

    // Drop the ghosts; slice copies, which is what the renderer and Rapier want.
    const from = nv * 3;
    const to = (nu + 2) * nv * 3;
    const positions = extPos.slice(from, to);
    const normals = ext.attributes.normal.array.slice(from, to);
    ext.dispose();

    let t = 0;
    for (let j = 0; j < nu; j++) {
      for (let i = 0; i < nv - 1; i++) {
        const a = j * nv + i;
        const b = a + 1;
        const c = a + nv;
        const d = c + 1;
        indices[t++] = a; indices[t++] = b; indices[t++] = c;
        indices[t++] = b; indices[t++] = d; indices[t++] = c;
      }
    }
    const trimmed = t === indices.length ? indices : indices.slice(0, t);

    const colors = new Float32Array(vertCount * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(trimmed, 1));

    this._colorTerrain(geometry, colors, lateralAbs, worldY, positions, origin);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();

    return { geometry, positions, indices: trimmed, colors };
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

    out.lerp(this._dirt, (1 - smoothstep(EDGE - 0.4, EDGE + 4.5, av)) * 0.9);

    return 0.92 + fine * 0.16;
  }

  _colorTerrain(geometry, colors, lateralAbs, worldY, positions, origin) {
    const normals = geometry.attributes.normal.array;
    const c = this._color;

    for (let k = 0; k < lateralAbs.length; k++) {
      // Fold-squeezed slivers have unreliable normals; magnitude keeps a bad
      // sliver from painting a grass slope as a cliff.
      const ny = Math.abs(normals[k * 3 + 1]);
      const x = positions[k * 3] + origin.x;
      const z = positions[k * 3 + 2] + origin.z;

      const jitter = this._groundColor(x, z, worldY[k], ny, lateralAbs[k], c);
      colors[k * 3 + 0] = c.r * jitter;
      colors[k * 3 + 1] = c.g * jitter;
      colors[k * 3 + 2] = c.b * jitter;
    }
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
        positions[k * 3 + 1] = frame.pos.y + col.v * slope + ROAD_LIFT - origin.y;
        positions[k * 3 + 2] = frame.pos.z + rightFlat.z * col.v - origin.z;

        if (col.kind === PAINT || (col.kind === CENTER && dash)) c.copy(paint);
        else c.copy(asphalt).multiplyScalar(0.85 + wear * 0.32);

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
  _buildProps(index, s0, s1, origin) {
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
      const kinds = [...chosen.keys()];

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
        if (placed >= TREES.nearCap && far >= TREES.farCap) break;

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

        const paired = placed < TREES.nearCap;
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
              p.y + origin.y, Math.abs(cv), placed < TREES.nearCap);
          }
        }
      }
    }

    // ---- the understorey -------------------------------------------------

    if (this.bushes) {
      const chosen = commit(SHRUB_NAMES, this.bushes.library, BUSHES.picks);
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

        // Sunk a little, so no shrub is ever seen standing on a stalk.
        p.y -= height * 0.05;
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
  _buildGrass(index, s0, s1, origin, tier = this.grassTiers[0]) {
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
    const coverAt = (j, a, mid, width) => {
      const key = (j >> 2) * 512 + Math.round(mid / 6);
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      // Sheet data is origin-relative; put the origin back on (trap #19).
      const wx = positions[a * 3] + origin.x;
      const wy = positions[a * 3 + 1] + origin.y;
      const wz = positions[a * 3 + 2] + origin.z;
      const gv = (positions[(a + 1) * 3 + 1] - positions[a * 3 + 1]) / Math.max(1e-4, width);
      const gu = (positions[(a + nv) * 3 + 1] - positions[a * 3 + 1]) / rowLen;
      vegetation(this.terrain, wx, wz,
        wy - this.terrain.continent(wx, wz), Math.hypot(gu, gv), mid, field);
      memo.set(key, field[tier.cover]);
      return field[tier.cover];
    };

    for (let j = 0; j < nu; j++) {
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

        const cover = coverAt(j, a, mid, width);
        if (cover <= 0.02) { bare++; continue; }

        const w = (rowLen * usable * thin(mid) * cover) / (bz * bz);
        if (w <= 0) continue;

        total += w;
        cells.push(a, i, width);            // vertex index, column, cell width
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
    const p = this._cA;
    let placed = 0;

    for (let n = 0; n < samples; n++) {
      const target = rng() * total;
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
      placed++;
    }

    if (!placed) return null;

    const mesh = new THREE.InstancedMesh(this.grass.geometry, tier.material, placed);
    // Swap buffers in; `subarray` is a view, so the trim costs nothing.
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(mats.subarray(0, placed * 16), 16);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colours.subarray(0, placed * 3), 3);
    // A 78 m cascade cannot resolve a 60 cm blade, so no cast.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    // The shader shrinks and leans tufts; three knows nothing about either, so
    // skip the cull.
    mesh.frustumCulled = false;
    mesh.userData.grass = true;
    return mesh;
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
      if (wanted && !chunk.rocks && !chunk.rocksEmpty && !this.rockQueue.includes(i)) {
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
  _updateGrass(carS, budget) {
    if (!this.grass) return;
    const center = Math.floor(carS / CHUNK.length);

    for (const tier of this.grassTiers) {
      const lo = center - tier.behind;
      const hi = center + tier.ahead;
      const emptyKey = tier.key + 'Empty';

      for (const [i, chunk] of this.chunks) {
        const wanted = i >= lo && i <= hi;
        if (wanted && !chunk[tier.key] && !chunk[emptyKey] && !tier.queue.includes(i)) {
          tier.queue.push(i);
        } else if (!wanted && chunk[tier.key]) {
          const mesh = chunk[tier.key];
          this.scene.remove(mesh);
          mesh.dispose();
          const at = chunk.objects.indexOf(mesh);
          if (at >= 0) chunk.objects.splice(at, 1);
          chunk[tier.key] = null;
        }
      }

      // Nearest first, at most `budget` a frame.
      tier.queue.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
      while (tier.queue.length && budget > 0) {
        const i = tier.queue.shift();
        const chunk = this.chunks.get(i);
        if (!chunk || chunk[tier.key] || i < lo || i > hi) continue;
        const s0 = i * CHUNK.length;
        const mesh = this._buildGrass(i, s0, s0 + CHUNK.length, chunk.origin, tier);
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
        budget--;
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
