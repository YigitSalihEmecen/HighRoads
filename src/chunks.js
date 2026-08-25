/**
 * chunks.js — infinite streaming terrain, road ribbon, colliders and props.
 *
 * THE KEY IDEA: terrain is generated in *road space*, not world space.
 *
 * A chunk is a strip of the spline, parameterised by (u, v) where u is arc
 * length along the road and v is lateral offset from the centreline. Every
 * vertex row is placed on the spline frame at its own u. This buys three
 * things for free:
 *
 *   1. Carving is a 1D blend on |v| instead of a mesh-boolean against a curve.
 *      Near the centreline the height *is* the road height; far away it's pure
 *      noise; in between, a smoothstep produces the cut-and-fill slopes.
 *   2. Chunk seams are exact. Neighbouring chunks share the same u values at
 *      the boundary, so their boundary rows are bit-identical — no cracks.
 *   3. Resolution follows the player. Lateral spacing is 2 m on the asphalt and
 *      tens of metres out at the fog line, where nobody is looking closely.
 *
 * The price is that the parameterisation folds if the road ever curves tighter
 * than the corridor is wide, which is why ROAD.maxCurvature is a hard limit and
 * not a taste preference.
 */

import * as THREE from 'three';
import { CHUNK, ROAD, ROUTE, GRASS, GROUND, ROCKS, TERRAIN_COLORS } from './config.js';
import { clamp, lerp, smoothstep, smin, smax, mulberry32, hashInt } from './util.js';
import { FOLIAGE, FOLIAGE_GROUPS, GROUP_OF, suitability } from './foliage.js';
import { makeFrame } from './path.js';
import { createGrassAssets } from './env/grass.js';
import { createGroundAssets } from './env/ground.js';
import { createRockAssets } from './env/rocks.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const ROAD_LIFT = 0.035;

/** Painted on for one `dashLength`, off for the next. */
function dashOn(s, half) {
  return Math.floor(s / half) % 2 === 0;
} // visual asphalt sits just above the collision surface

/** Where the paved surface ends and the verge begins. */
const EDGE = ROAD.halfWidth + ROAD.shoulder;

/**
 * Lateral sample positions. Dense across the road and verge, then geometric so
 * the far field costs almost nothing.
 */
function buildLateralOffsets() {
  // Road surface and verge: fixed columns so the painted edges land exactly.
  // Every entry derived, and strictly increasing. Mixing derived values with
  // literals silently breaks that ordering the moment the road width changes —
  // and the binary search that finds a column assumes it is sorted.
  const half = [
    0, ROAD.laneWidth * 0.5, ROAD.laneWidth, ROAD.laneWidth * 1.5,
    ROAD.halfWidth, ROAD.halfWidth + 0.9, EDGE, EDGE + 1.4, EDGE + 2.8,
  ];
  let v = half[half.length - 1];

  // Drivable band: uniform, and no coarser than the longitudinal rows. Letting
  // this grow geometrically produced 12–16 m columns against 2.5 m rows, and
  // triangles that long and thin read as random ridges to a suspension ray —
  // the car catches on edges that are not really there.
  while (v < CHUNK.nearBand) {
    v = Math.min(v + CHUNK.nearStep, CHUNK.nearBand);
    half.push(v);
  }

  // Far field: geometric, capped so the ridge noise stays sampled well enough
  // not to alias into spikes.
  //
  // The cap was 55 m, which was the right answer for a world whose mountains
  // topped out at 300 m. They now reach past a kilometre (`noise.js:continent`
  // and `mountainH`), and a hillside three times as steep sampled at the same
  // spacing is three times the angle between neighbouring faces: measured, the
  // 200–420 m band went from 19.5 degrees at the 99th percentile to 41.3. That
  // is not aliasing — the features out there are hundreds of metres across and
  // 55 m samples them honestly — it is simply that the ground now turns faster
  // than the mesh can follow. Thirty-four metres costs eleven percent more
  // terrain vertices, which against a scene whose grass alone is three times
  // the whole sheet is not a number worth defending.
  let step = CHUNK.nearStep;
  while (v < CHUNK.halfExtent) {
    step = Math.min(step * 1.32, 34);
    v = Math.min(v + step, CHUNK.halfExtent);
    half.push(v);
  }

  const left = half.slice(1).reverse().map((x) => -x);
  return left.concat(half);
}

/**
 * Road ribbon columns. Duplicated v positions give each painted stripe a hard
 * edge — without the duplicate, vertex colours would smear the line across the
 * whole lane.
 */
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
 * from the curve's centre of rotation, which sits at a lateral distance of
 * R = 1/|curvature| on the *inside* of the turn. A vertex placed beyond that
 * point has passed through the centre and comes back out the other side: the
 * mesh folds through itself, producing inverted normals and degenerate
 * triangles. The outside of the bend has no such limit.
 *
 * The compression must therefore asymptote below L = 0.7*R — rows are spaced
 * ds*(1 + v*kappa) apart, so a column sitting at R would have zero longitudinal
 * extent, and the resulting slivers yield garbage normals even though they
 * never technically invert. 0.7 keeps every quad at >=30% of its nominal depth.
 *
 * `foldL` and `foldR` are the two curvature limits, one per side, and they come
 * from the ACTUAL frame-to-frame rotation rather than from `curv` — see
 * `path.js:_buildFoldLimits` for why that distinction is the difference between
 * this working and this not working. Everything below assumes they are honest.
 *
 * ── the shape of the mapping ────────────────────────────────────────────────
 *
 * What matters is how it behaves WELL SHORT of the limit, and that is where the
 * previous version — v' = L*(1 - e^(-|v|/L)) — was the largest single source of
 * visible terrain artefacts. The exponential starts bending immediately: at
 * |v| = 0.35*L it has already taken 16% off, so a road that is all but straight
 * still had its far corridor squeezed. Since L is inversely proportional to
 * curvature and a straight has curvature wandering through zero, adjacent rows
 * 2.5 m apart could carry a 2.8 km radius each way — both of them "straight" by
 * any sane reading — and the guard would leave the far column alone on one row
 * and pull it 87 METRES inboard on the next. The sheet was being sheared by a
 * quantity that has no business existing there at all, and what it looked like
 * on screen was chunks that did not line up.
 *
 * The replacement is a soft minimum against L rather than an exponential
 * approach to it:
 *
 *     v' = |v| / (1 + (|v|/L)^p)^(1/p),   p = 6
 *
 * Same guarantees — strictly increasing, strictly below L, C-infinity — but the
 * correction is O((|v|/L)^p), so it is numerically invisible until |v| is a real
 * fraction of the radius, and its sensitivity to curvature falls with the FIFTH
 * power of it instead of the first. The same pair of rows above now disagree by
 * 0.1 m. On a genuinely tight corner (R = 165 m, the ROAD.maxCurvature limit) it
 * still clamps the 700 m corridor edge to 115 m, which is what it is for.
 *
 * Curvature is a function of arc length alone, so neighbouring chunks compute an
 * identical correction at a shared boundary and seams stay exact.
 */
const FOLD_P = 6;
function foldSafeOffset(v, foldL, foldR) {
  // A left turn (positive curvature) puts the centre of rotation at negative v,
  // so it is `foldL` that bounds the left side.
  const k = v < 0 ? foldL : foldR;
  if (k < 1e-7) return v;

  const L = 0.7 / k;
  const u = Math.abs(v) / L;
  // Below ~0.4*L the correction is under a part in a thousand; skipping it
  // there keeps a pow() out of the hot path for the overwhelming majority of
  // samples, since most of the world is not inside a hairpin.
  if (u < 0.4) return v;
  return v / Math.pow(1 + Math.pow(u, FOLD_P), 1 / FOLD_P);
}

/* ------------------------------------------------------------------------- */

export class ChunkManager {
  constructor({ scene, world, RAPIER, path, terrain, foliage, anisotropy = 1 }) {
    this.scene = scene;
    /** Texture filtering budget, from the renderer. Grass is the only user. */
    this.anisotropy = anisotropy;
    /** Map of model name -> { geometry, height } from assets.loadFoliage. */
    this.foliage = foliage || new Map();
    this.world = world;
    this.RAPIER = RAPIER;
    this.path = path;
    this.terrain = terrain;

    this.lateral = buildLateralOffsets();
    this.roadCols = buildRoadColumns();
    this.chunks = new Map();
    this.pending = [];
    /**
     * Chunks whose ground exists but whose scenery does not yet. Terrain and
     * its collider must appear the instant a chunk is needed — the car can
     * drive onto it — but nothing depends on the trees being there the same
     * frame, and scattering them is over half the build cost. Deferring that
     * work halves the worst-case frame spike.
     */
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
    /**
     * The foreign-road list for the row currently being sampled, and the arc
     * length it was gathered for. See `sampleGround`.
     *
     * Cached on the row rather than looked up per vertex because it is a pure
     * function of `s` and a row is hundreds of vertices at the same `s` — but
     * it is only ever a CACHE. Anything that samples out of row order simply
     * pays for a re-gather and gets the identical answer, which is what keeps
     * chunk seams exact: two chunks meeting at a shared row gather the same
     * list because they ask the same question.
     */
    this._foreign = { s: NaN, n: 0, list: [] };
    // The terrain palette, allocated once — _groundColor runs per vertex on
    // every chunk and per tuft on tens of thousands of tufts.
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
     * Ground-cover tiers, and the queue of chunks each is waiting to build.
     *
     * Separate from `propQueue` because trees and grass have different
     * LIFETIMES, not just different costs: a tree lives as long as its chunk,
     * grass only as long as the car is near enough to resolve it, so grass is
     * built and thrown away several times over the life of the chunk it belongs
     * to. And separate from each OTHER because the near field and the middle
     * distance are two different problems — see GRASS.far.
     *
     * A tier is a plain descriptor. Everything that differs between the close
     * field and the far one is a number in here, so `_buildGrass` is one
     * function and there is no second scatter to keep in step with the first.
     */
    /** Chunks waiting for their stone. Same lifetime rule as the grass. */
    this.rockQueue = [];
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
        // Offsets the per-chunk seed, so the two tiers do not land tuft-on-tuft.
        salt: 0x517cc1b7,
        queue: [],
      });
      if (GRASS.far.enabled) {
        const F = GRASS.far;
        this.grassTiers.push({
          key: 'grassFar',
          material: this.grass.farMaterial,
          behind: F.behind,
          ahead: F.ahead,
          halfExtent: F.halfExtent,
          // Constant card size across the whole band: the near tier grows its
          // cards outward because it is trying to reach the middle distance,
          // and this tier IS the middle distance.
          denseTo: F.halfExtent,
          farScale: 1,
          // Area-preserving density, times the coverage this tier is allowed.
          // Bigger cards cover more ground per instance, so the count falls
          // with the square of the scale before `coverage` thins it further.
          density: (GRASS.density * F.coverage) / (F.widthScale * F.heightScale),
          maxSlope: F.maxSlope,
          sizeMul: F.heightScale,
          // Wider than it is tall, which is what makes the far tier read as
          // ground cover rather than as a field of spikes. See GRASS.far.
          widthMul: F.widthScale / F.heightScale,
          salt: 0x2f9e3c11,
          queue: [],
        });
      }
    }
  }

  /** Advances anything animated in the shared materials. */
  advanceTime(dt) {
    this.time += dt;
    if (this.grass) this.grass.setTime(this.time);
  }

  // ------------------------------------------------------------- materials --

  _buildSharedAssets() {
    // The terrain material now comes from env/ground.js, which is the same
    // smooth-shaded vertex-coloured standard material it always was plus a
    // procedural detail overlay. The overlay is a multiply on the albedo AFTER
    // the vertex colour, so nothing already decided about the palette changes;
    // it only puts something between one vertex and the next, which past the
    // verge is tens of metres of perfectly smooth interpolation.
    this.ground = createGroundAssets({ anisotropy: this.anisotropy });
    this.matTerrain = this.ground.material;

    this.matRoad = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.68,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    // Every Quaternius model carries its colour in a vertex attribute (baked
    // from the .mtl palette at load), so the entire forest — trunks, leaves,
    // berries, moss, stone — shares exactly one material.
    this.matFoliage = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.0,
      flatShading: false,
    });


    /**
     * Ground cover. Null where it cannot be built — the headless probes have no
     * canvas, so `createGrassAssets` returns a texture-less pair and everything
     * here still runs; `GRASS.enabled` off skips it entirely.
     */
    this.grass = GRASS.enabled ? createGrassAssets({ anisotropy: this.anisotropy }) : null;

    /** Procedural stone. See env/rocks.js — texture for the verge, not scenery. */
    this.rocks = ROCKS.enabled ? createRockAssets() : null;
  }

  // ------------------------------------------------------------- sampling --

  /**
   * Refreshes `_foreign` for the row at `frame.s`.
   *
   * Control-point segments, not spline samples: an exact perpendicular against
   * a 46 m polyline is both closer to the truth and orders of magnitude cheaper
   * than re-framing the road a few hundred times per row. The range is the
   * corridor plus the ramp's own reach, so a road just outside the sheet still
   * pulls the edge of it down toward itself instead of ending in a step.
   */
  _gatherForeign(frame) {
    const fo = this._foreign;
    fo.s = frame.s;
    fo.n = this.path.foreignSegments(
      frame.s, frame.pos.x, frame.pos.z, CHUNK.halfExtent + 120, fo.list);
  }

  /**
   * The single source of truth for ground height, shared by the mesh builder,
   * the prop scatterer and the respawn logic. Anything that disagrees with this
   * function will visibly float or sink.
   */
  sampleGround(frame, rightFlat, v, out) {
    v = foldSafeOffset(v, frame.foldL, frame.foldR);
    const av = Math.abs(v);
    const x = frame.pos.x + rightFlat.x * v;
    const z = frame.pos.z + rightFlat.z * v;

    // Road plane, banked. The bank flattens out past the verge so the cross
    // slope doesn't tilt the entire hillside with it.
    // Cross-slope only applies to the carriageway and its verge; past that the
    // hillside has its own shape. (This referenced the old blend width, which
    // was removed with the smoothstep carve — leaving it undefined turned every
    // height into NaN, which is why the terrain silently vanished.)
    const bankFade = 1 - smoothstep(EDGE, EDGE + CHUNK.bankRunout, av);
    const yRoad = frame.pos.y + v * Math.tan(frame.bank) * bankFade;

    const yNatural = this.terrain.height(x, z, av);

    // Cut and fill. The ground is the natural surface, clamped between a plane
    // rising from the road edge at the cut slope and one falling at the fill
    // slope. One expression covers every case an alignment meets: both sides
    // cut through a valley, one cut and one filled along a mountainside, both
    // filled across a hollow, and a rock cutting through a ridge.
    //
    // Cut and fill, rounded at both ends.
    //
    // The plain version — a linear ramp from the verge edge, hard-clamped
    // against the natural surface — has a corner at each join. Measured, the
    // ground went from 3 degrees to 40 in a single step at the verge, a
    // curvature of 1.54/m, which at 30 m/s is 1389 m/s² straight up. Nothing is
    // standing there; the crease alone is enough to stop a car dead.
    //
    // Two changes remove it. The ramp starts with zero gradient and eases into
    // the cut slope (t²/(t+R) — value and first derivative both zero at the
    // verge), and the clamp becomes a smooth min/max so the top of a cutting
    // and the toe of an embankment round into the hillside instead of meeting
    // it at a corner.
    const t = Math.max(0, av - EDGE);
    const ramp = (t * t) / (t + ROAD.shoulderRound);
    const ceiling = yRoad + ROAD.cutSlope * ramp;
    const floorY = yRoad - ROAD.fillSlope * ramp;

    // THE BLEND WIDTH MUST CLOSE WITH THE GAP IT IS BLENDING.
    //
    // `smin` and `smax` do not agree with `min` and `max` near the crossover —
    // that is the entire point of them — and each contributes up to k/4 of
    // error. On the carriageway the ceiling and the floor are the SAME plane
    // (ramp = 0), so the pair is smoothing a gap of zero width: with a fixed
    // k = 3.5 the two errors compound to +0.875 m of terrain standing on the
    // road wherever the natural surface happens to pass near road level. That
    // is the road disappearing into the ground.
    //
    // Tying k to a quarter of the gap makes the smoothing vanish exactly where
    // there is nothing to smooth. On the carriageway it degrades to a hard
    // clamp and the surface is the road plane, to the bit. Out on the slopes
    // the gap is metres wide and the full blend is back.
    const k = Math.min(ROAD.slopeBlend, (ceiling - floorY) * 0.25);
    let y = smax(smin(yNatural, ceiling, k), floorY, k);

    // ---- other passes of the road ----------------------------------------
    //
    // Everything above carves this sheet for ITS OWN road. Where the route
    // doubles back inside `CHUNK.halfExtent` the sheet also covers somebody
    // else's, and over there it is uncarved hillside standing on a carriageway.
    // See CHUNK.foreignSink for the measurement and the reasoning.
    //
    // The same cut ramp, against the other road's plane, sunk far enough that
    // the two surfaces are never coplanar — and then floored at this road's own
    // fill line, which is what makes it impossible for the correction to touch
    // the carriageway it is standing on. On the carriageway `floorY` IS the
    // road plane, so the guard is exact there rather than merely tight.
    const fo = this._foreign;
    if (fo.s !== frame.s) this._gatherForeign(frame);
    if (fo.n) {
      // The MINIMUM over the segments first, then one smooth clamp. Smoothing
      // inside the loop compounds — thirty segments each conceding up to k/4
      // is nine metres of terrain quietly removed — and a `if (lower) blend`
      // guard is worse still: it steps by exactly k/4 the moment it engages,
      // which is a cliff. A plain minimum over a polyline is continuous, so
      // taking it first leaves exactly one place that needs to be smooth.
      let fCeil = Infinity;
      for (let i = 0; i < fo.n; i++) {
        const a = fo.list[i * 2];
        const b = fo.list[i * 2 + 1];
        // Closest point on the segment, in plan. `t` doubles as the interpolant
        // for the road's height there, so a clamp under a climbing road climbs
        // with it instead of stepping between control points.
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
      // Never below THIS road's own fill line, and blended with the SAME `k`
      // the cut-and-fill clamp uses — which is trap #6 and it has now cost time
      // twice. A smooth minimum disagrees with a real one by up to k/4 AT THE
      // CROSSOVER, and on the carriageway `ceiling`, `floorY` and `y` are all
      // the same plane, so a fixed blend width here concedes that k/4
      // unconditionally: measured, 0.875 m of trench down the middle of the
      // road wherever a foreign segment was in range. The car met it at
      // 175 km/h as a 1361 m/s^2 hit with all four wheels on the ground.
      //
      // Tying the width to the gap makes the smoothing vanish exactly where
      // there is nothing to smooth. On the carriageway `k` is zero, both
      // operations degrade to exact min/max, and the floor guarantees the
      // result is the road plane to the bit. Out on the slopes the gap is
      // metres wide and the full blend is back.
      y = smin(y, smax(fCeil, floorY, k), k);
    }

    // Drainage ditch hugging the verge — but only where the road is roughly at
    // grade. On a tall embankment or a deep cutting a ditch makes no sense.
    const dt = clamp((av - EDGE) / CHUNK.ditchWidth, 0, 1);
    if (dt > 0 && dt < 1) {
      const fit = 1 - smoothstep(1.5, 8.0, Math.abs(yNatural - yRoad));
      y -= CHUNK.ditchDepth * Math.sin(Math.PI * dt) * fit;
    }

    // Horizon falloff: the far edge of the corridor slopes away beneath the
    // eyeline so the world ends out of sight instead of at a visible cut.
    if (av > CHUNK.horizonFalloff) {
      y -= smoothstep(CHUNK.horizonFalloff, CHUNK.halfExtent, av) * CHUNK.horizonDrop;
    }

    out.set(x, y, z);
    return out;
  }

  /**
   * Height of the *triangulated* surface at (s, v).
   *
   * `sampleGround` returns the analytic height, but what the player sees — and
   * what a suspension ray hits — is the mesh, which is a chord across each
   * quad. Between vertices the two disagree by the sagitta of the terrain, and
   * anything placed with the analytic value floats above a valley or sinks into
   * a ridge. Props therefore interpolate across the same triangle the renderer
   * draws: same four corner samples, same diagonal, same winding.
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

    // Interpolate the whole position, not just the height. Placing a prop at
    // the analytic (s, v) while taking its height from the mesh leaves the two
    // disagreeing wherever the road curves or the columns are coarse — the
    // point simply is not on the triangle whose height was read. Interpolating
    // x and z as well puts it on the surface by construction.
    // Quad is split a,b,c / b,d,c, matching _buildTerrain's index order.
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

  /**
   * Ground height at an arbitrary (s, v). Allocates a frame; not for hot loops.
   *
   */
  groundAt(s, v, out = new THREE.Vector3()) {
    const f = this.path.frameAt(s, this._frame);
    this._rightFlat.crossVectors(f.tan, WORLD_UP).normalize();
    this.sampleGround(f, this._rightFlat, v, out);
    return out;
  }

  // -------------------------------------------------------------- lifecycle --

  /** Streams chunks in and out around the vehicle's arc length. */
  update(carS, budget = CHUNK.buildPerFrame) {
    const center = Math.floor(carS / CHUNK.length);
    // The spline is undefined before s = 0 (frameAt clamps), so a negative
    // chunk would collapse every row onto s = 0 and generate a degenerate mesh
    // with no collidable surface. Never build them.
    const lo = Math.max(0, center - CHUNK.behind);
    const hi = center + CHUNK.ahead;

    // The spline must exist before the chunk that samples it does.
    this.path.ensureLength((hi + 2) * CHUNK.length);

    for (let i = lo; i <= hi; i++) {
      if (!this.chunks.has(i) && !this.pending.includes(i)) this.pending.push(i);
    }

    // Nearest-first, so a teleport or a respawn fills the visible gap first.
    this.pending.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));

    let built = 0;
    while (this.pending.length && built < budget) {
      const i = this.pending.shift();
      if (i < lo || i > hi) continue;
      this._build(i);
      built++;
    }

    // Scenery for one already-built chunk, on a frame where no ground was
    // generated. Splitting the two keeps either half under a frame budget.
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
      }
    }

    // Ground cover last, and only on a frame that did no other building —
    // scattering a chunk of it is tens of thousands of surface samples, and
    // landing that in the same frame as a terrain build is the frame spike
    // bug #51 exists to keep the car's motion honest through.
    if (!built) {
      this._updateGrass(carS, GRASS.buildPerFrame);
      this._updateRocks(carS, 1);
    } else {
      // Eviction still has to run every frame, or a chunk that left the window
      // keeps its cover until something else happens to trigger a build.
      this._updateGrass(carS, 0);
      this._updateRocks(carS, 0);
    }
  }

  /** Builds `count` chunks immediately — used once, before the first frame. */
  preload(carS, count = CHUNK.preload) {
    const center = Math.floor(carS / CHUNK.length);
    this.path.ensureLength((center + count + 2) * CHUNK.length);
    for (let i = Math.max(0, center - 1); i < center + count; i++) {
      if (!this.chunks.has(i)) this._build(i);
    }
    // Nothing is on screen yet, so the whole backlog can be paid up front.
    while (this._flushProps());
  }

  _dispose(chunk) {
    for (const obj of chunk.objects) {
      this.scene.remove(obj);
      // Only terrain and road geometry belong to this chunk. Prop geometries
      // and every material are shared globally — disposing those would blank
      // out every other live chunk.
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

    for (const m of [this.matRoad, this.matFoliage]) m.dispose();
    for (const f of this.foliage.values()) f.geometry.dispose();
    if (this.ground) this.ground.dispose();
    if (this.grass) this.grass.dispose();
    if (this.rocks) this.rocks.dispose();
  }

  // ---------------------------------------------------------------- build --

  _build(index) {
    const s0 = index * CHUNK.length;
    const s1 = s0 + CHUNK.length;

    // The foreign-road clamp asks about road up to `ROUTE.selfFar` AHEAD, and
    // an answer that depends on how much of the route has been generated is not
    // a pure function of position — which is bug #27's whole lesson. Routing is
    // greedy and deterministic, so extending it early changes nothing about
    // where it goes; it only makes the question answerable.
    this.path.ensureLength(s1 + ROUTE.selfFar);

    // Chunk-local origin. Keeping vertices relative to it (rather than absolute
    // world space) preserves float precision hundreds of kilometres out.
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

    // Static trimesh collider. Rapier owns the transform, so the same
    // origin-relative vertex buffer serves both rendering and physics.
    const desc = this.RAPIER.ColliderDesc.trimesh(terrainData.positions, terrainData.indices)
      .setTranslation(origin.x, origin.y, origin.z)
      .setFriction(1.0)
      .setRestitution(0.0);
    const collider = this.world.createCollider(desc);

    const extraColliders = [];

    const chunk = {
      index, objects, collider, origin, props: false, extraColliders,
      /**
       * The terrain sheet, kept so ground cover can be scattered ON it rather
       * than re-derived beside it. `positions` and `colors` are the very
       * buffers the renderer draws from, so a tuft placed by interpolating
       * them is on the visible surface and painted the visible colour by
       * construction — there is no second evaluation to disagree.
       */
      sheet: {
        positions: terrainData.positions,
        colors: terrainData.colors,
      },
      /** The live ground-cover meshes, or null. They come and go with the car. */
      grass: null,
      grassFar: null,
      /** True once this chunk is known to have nowhere to put any. */
      grassEmpty: false,
      grassFarEmpty: false,
      /** Procedural stone — same lifetime rule as the grass. */
      rocks: null,
      rocksEmpty: false,
    };
    this.chunks.set(index, chunk);
    this.propQueue.push({ index, s0, s1, origin });
  }

  /** Scatters one deferred chunk's scenery. */
  _flushProps() {
    while (this.propQueue.length) {
      const job = this.propQueue.shift();
      const chunk = this.chunks.get(job.index);
      // The chunk may have streamed back out before we got to it.
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
     * GHOST ROWS.
     *
     * The sheet is sampled one row PAST each end of the chunk and the normals
     * are computed over that extended mesh; only the interior rows are then
     * kept. Nothing else in the build sees them.
     *
     * This replaces a `_seamNormals` pass that re-derived the boundary normal
     * analytically, from central differences of `sampleGround`, and it replaces
     * it because the two answers are not the same answer. Every interior vertex
     * gets the area-weighted average of its six adjacent triangles, which is
     * what `computeVertexNormals` does; an analytic tangent plane agrees with
     * that only where the surface is locally flat. Out in the far field, where
     * a cell is 55 m across and the ground is not flat at 55 m, they disagree
     * by degrees — so the seam row was shaded differently from its own
     * neighbours, on both sides, and the world grew a subtly mismatched line
     * across it every 120 m. It also fed `_colorTerrain`, so the seam was a
     * colour boundary as well as a shading one.
     *
     * With ghost rows the boundary vertices are computed by exactly the same
     * rule as everything else, from exactly the triangles the neighbouring
     * chunk will build. Both sides agree because both are evaluating the same
     * function of position, not because two different derivations were tuned
     * to match.
     */
    const extRows = rows + 2;
    const extPos = new Float32Array(extRows * nv * 3);
    const indices = new Uint32Array(nu * (nv - 1) * 6);

    // Kept alongside the positions so colouring can use them without re-deriving.
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

    // Winding: +row is the tangent, +column is `right`, and up = right x tangent.
    // Counter-clockwise (a,b,c) therefore yields an upward face normal — get
    // this backwards and the whole world is backface-culled and lit from below.
    // Built twice over the same rule: once across every extended row, purely to
    // drive `computeVertexNormals`, and once across the interior rows, which is
    // what gets drawn and collided against.
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

    // Drop the ghosts. `slice` on a typed array copies, which is what both the
    // renderer and Rapier want — a view with a byte offset is a thing to have
    // to think about later.
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
   * Vertex colours from altitude, slope and distance to the road. Normals are
   * already computed, so slope comes free from normal.y — no extra sampling.
   */
  /**
   * The colour of the ground at one point, into `out`.
   *
   * Extracted so the terrain mesh and the grass standing in it are painted by
   * the SAME function rather than by two expressions that agree today. A tuft
   * takes its hue from here, so grass over a rock face goes grey with the rock
   * and grass on a high shoulder pales with the altitude, automatically and
   * permanently — there is no second palette to keep in step.
   *
   * @param {number} x,z    world position
   * @param {number} y      ground height there
   * @param {number} ny     |normal.y| — how flat the ground is
   * @param {number} av     |lateral offset| from the centreline
   * @param {THREE.Color} out
   * @returns {number} the value jitter applied, so callers can reuse it
   */
  _groundColor(x, z, y, ny, av, out) {
    // Two mottles at different scales rather than one. A single low-frequency
    // field can only ever say "more of this way or that way" — it grades, and a
    // grade over a smoothly interpolated mesh is the flat wash this is here to
    // break. Two of them, one about 70 m and one about 350 m, put patches
    // inside regions: a dry bank in a green valley, a green hollow on a dry
    // hillside.
    const fine = this.terrain.nC(x * 0.014, z * 0.014) * 0.5 + 0.5;
    const broad = this.terrain.nB(x * 0.0029, z * 0.0029) * 0.5 + 0.5;

    // Height ABOVE THE LOCAL BASE, not above zero. See TERRAIN_COLORS and
    // noise.js:continent — the map itself now rises and falls by hundreds of
    // metres, so an absolute ramp would paint whole regions at the top of it.
    const rel = y - this.terrain.continent(x, z);

    // Damp low ground to dry high ground, with the broad mottle deciding which
    // way a given hillside leans.
    const alt = smoothstep(20, 210, rel);
    out.copy(this._grassDeep).lerp(this._grassLow, smoothstep(0.28, 0.62, broad + alt * 0.25));
    out.lerp(this._grassHigh, clamp(alt * 0.9 + (fine - 0.5) * 0.4, 0, 1));

    // Sun-bleached patches. Weighted toward higher, flatter ground, which is
    // where a real sward burns off first, and broken up by the fine mottle so
    // it lands as patches rather than as a band.
    const dry = clamp((fine - 0.42) * 2.1, 0, 1) * lerp(0.35, 1, smoothstep(0.45, 0.9, ny))
      * lerp(0.5, 1, alt);
    out.lerp(this._grassDry, dry * 0.62);

    // Scrub takes over where grass cannot hold: moderately steep, or high.
    const steep = smoothstep(0.92, 0.68, ny);
    out.lerp(this._scrub, Math.max(steep * 0.55, smoothstep(150, 330, rel) * 0.45));

    // Steep faces expose rock. 0.86 -> 0.55 in normal.y is roughly 30-57 deg.
    out.lerp(this._rock, smoothstep(0.86, 0.55, ny));
    // Bare stone above the vegetation line, and snow above that — but only
    // where the ground is flat enough to hold it. Snow on a vertical face is
    // the giveaway that a palette is keyed to height alone.
    out.lerp(this._peak, smoothstep(300, 520, rel) * 0.8);
    out.lerp(this._snow, smoothstep(430, 640, rel) * smoothstep(0.52, 0.86, ny));

    // Gravel verge fading into the vegetation.
    out.lerp(this._dirt, (1 - smoothstep(EDGE - 0.4, EDGE + 4.5, av)) * 0.9);

    return 0.92 + fine * 0.16;
  }

  _colorTerrain(geometry, colors, lateralAbs, worldY, positions, origin) {
    const normals = geometry.attributes.normal.array;
    const c = this._color;

    for (let k = 0; k < lateralAbs.length; k++) {
      // Far out on the inside of a bend the fold guard squeezes columns into
      // slivers whose computed normals are unreliable. Here the normal only
      // drives colour, so take the magnitude: a bad sliver can then never paint
      // a grass slope as a cliff.
      const ny = Math.abs(normals[k * 3 + 1]);
      const x = positions[k * 3] + origin.x;
      const z = positions[k * 3 + 2] + origin.z;

      // Slight per-vertex value jitter keeps the flat-shaded facets distinct.
      const jitter = this._groundColor(x, z, worldY[k], ny, lateralAbs[k], c);
      colors[k * 3 + 0] = c.r * jitter;
      colors[k * 3 + 1] = c.g * jitter;
      colors[k * 3 + 2] = c.b * jitter;
    }
  }

  // ----------------------------------------------------------------- road --

  /**
   * The road ribbon.
   *
   * Dashes are painted with vertex colours, which interpolate across a quad —
   * so a dash whose ends fall in the middle of a 2.5 m row fades in and out
   * over that whole row instead of stopping. The fix is the same one the
   * painted edge lines use laterally: emit a *duplicated row* at every dash
   * boundary, one carrying the old colour and one the new. The pair has zero
   * length, so there is nothing for the interpolator to smear across and the
   * dash ends land exactly where the geometry says.
   */
  _buildRoad(s0, s1, origin) {
    const cols = this.roadCols;
    const nv = cols.length;
    const half = ROAD.dashLength;

    // Row schedule: the union of regular subdivisions and dash boundaries. A
    // boundary emits a doubled row; a regular station emits one. They have to
    // be merged rather than interleaved, because the two spacings coincide
    // periodically (2.5 m rows against 3 m dashes meet every 15 m) and a
    // boundary that lands on a regular row must still be doubled.
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

    const asphalt = new THREE.Color(0x37373c);
    const paint = new THREE.Color(0xe9e3d2);
    const frame = makeFrame();
    const rightFlat = new THREE.Vector3();
    const c = this._color;

    for (let j = 0; j < nu; j++) {
      const { s, dash } = rows[j];
      this.path.frameAt(s, frame);
      rightFlat.crossVectors(frame.tan, WORLD_UP).normalize();
      const slope = Math.tan(frame.bank);

      // Asphalt tone wanders slightly along the road: patches, repairs, wear.
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
   * Scatters vegetation across the chunk.
   *
   * Species are chosen per-sample by weighted suitability (see foliage.js),
   * which reads altitude, slope, distance from the road and the biome mask.
   * That is what makes a hillside change from willows in the valley through
   * mixed broadleaf to pines and finally bare rock at the treeline, instead of
   * scattering one uniform forest everywhere.
   *
   * Draw calls are the binding constraint: an InstancedMesh exists per (chunk,
   * model), so each chunk commits to ONE concrete model per species up front,
   * seeded from its own index. Neighbouring chunks draw different models, so
   * the world still varies while the batch count stays bounded.
   */
  _buildProps(index, s0, s1, origin) {
    // Both tests, deliberately. The library is empty when `CHUNK.trees` is off
    // because `foliageModelNames` returned nothing — but a caller that supplies
    // its own foliage map (the probes do) would sail straight past that, and
    // the switch has to mean the same thing everywhere.
    if (!CHUNK.trees || this.foliage.size === 0) return [];

    // Seeded per chunk: a chunk unloaded and reloaded comes back identical, so
    // scenery does not reshuffle itself in the mirror.
    const rng = mulberry32(hashInt(index) ^ 0x9e3779b9);
    const out = [];

    // Commit to a handful of species, and one concrete model for each. Both
    // choices are seeded from the chunk index, so this is stable across reloads
    // and different for every chunk.
    const chosen = new Map();
    for (const def of Object.values(FOLIAGE_GROUPS)) {
      const pool = def.members.filter((n) =>
        FOLIAGE[n].models.some((m) => this.foliage.has(m))
      );
      // Seeded shuffle, then take the group's quota.
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      for (const name of pool.slice(0, def.picks)) {
        const models = FOLIAGE[name].models.filter((m) => this.foliage.has(m));
        chosen.set(name, models[Math.floor(rng() * models.length)]);
      }
    }

    /** modelName -> { matrices, canopy } */
    const batches = new Map();
    const kinds = Object.entries(FOLIAGE).filter(([n]) => chosen.has(n));
    // Triangle budget, enforced per group rather than per species.
    const placed = {};
    for (const g of Object.keys(FOLIAGE_GROUPS)) placed[g] = 0;

    // Cluster seeds for this chunk, placed where the forest field is strong.
    const clusters = [];
    for (let i = 0; i < CHUNK.clusterCount; i++) {
      const cs = lerp(s0, s1, rng());
      const cv = (rng() < 0.5 ? -1 : 1) * lerp(10, CHUNK.propExtent * 0.75, Math.sqrt(rng()));
      const cp = this.groundAt(cs, cv, new THREE.Vector3());
      if (this.terrain.forestDensity(cp.x, cp.z) < 0.25) continue;
      clusters.push({ s: cs, v: cv, r: lerp(14, 38, rng()) });
    }

    const frame = makeFrame();
    const rightFlat = new THREE.Vector3();
    const p = new THREE.Vector3();
    const pA = new THREE.Vector3();
    const pB = new THREE.Vector3();
    const weights = new Array(kinds.length);

    for (let n = 0; n < CHUNK.propSamples; n++) {
      // Half of everything is drawn near a cluster centre rather than
      // independently. Independent draws give a Poisson field — statistically
      // even, and it reads as "scattered to fill space", which is exactly the
      // look being avoided. Clumping around a handful of seeds produces
      // thickets, copses and rock groups with open ground between them.
      let s, v;
      if (clusters.length && rng() < CHUNK.clusterShare) {
        const c = clusters[Math.floor(rng() * clusters.length)];
        s = c.s + (rng() - 0.5) * 2 * c.r;
        v = c.v + (rng() - 0.5) * 2 * c.r;
        if (s < s0 || s > s1) continue;
      } else {
        s = lerp(s0, s1, rng());
        const side = rng() < 0.5 ? -1 : 1;
        // sqrt biases toward the road: a uniform draw over a 200 m band puts
        // almost nothing where the player can actually see it.
        v = side * lerp(7.5, CHUNK.propExtent, Math.sqrt(rng()));
      }
      const lateral = Math.abs(v);
      if (lateral < 7 || lateral > CHUNK.propExtent) continue;

      this.path.frameAt(s, frame);
      rightFlat.crossVectors(frame.tan, WORLD_UP).normalize();
      // Sit on the drawn surface, not the analytic one, or props float.
      this.meshGroundPoint(s, s0, s1, v, p);

      // Local gradient from two lateral probes.
      this.sampleGround(frame, rightFlat, v - 2.5, pA);
      this.sampleGround(frame, rightFlat, v + 2.5, pB);
      const slope = Math.abs(pB.y - pA.y) / 5;

      const region = this.terrain.region(p.x, p.z);
      const density = this.terrain.forestDensity(p.x, p.z);
      const ctx = { altitude: p.y, slope, lateral, region };

      // Weighted pick across every species that will grow here.
      let total = 0;
      for (let k = 0; k < kinds.length; k++) {
        const kind = kinds[k][1];
        const w = suitability(kind, ctx) * kind.weight;
        weights[k] = w;
        total += w;
      }
      if (total <= 0) continue;

      // Forest density gates canopy only, so clearings still keep their scrub.
      let pick = rng() * total;
      let index2 = 0;
      for (; index2 < kinds.length; index2++) {
        pick -= weights[index2];
        if (pick <= 0) break;
      }
      if (index2 >= kinds.length) continue;

      const [kindName, kind] = kinds[index2];
      const group = GROUP_OF[kindName];
      if (placed[group] >= FOLIAGE_GROUPS[group].cap) continue;

      const isCanopy = group === 'canopy';
      // Canopy grows in stands, not as an even sprinkle. `forestDensity` is
      // already two scales multiplied — stands a few hundred metres across,
      // broken up inside — and squaring it sharpens the edges further, so a
      // wood has a boundary and a clearing has nothing in it.
      if (isCanopy && rng() > density * density * CHUNK.standBias) continue;
      placed[group]++;

      const model = chosen.get(kindName);
      const proto = this.foliage.get(model);
      if (!proto) continue;

      // Height in metres -> scale factor for a model authored ~3 units tall.
      const height = lerp(kind.height[0], kind.height[1], rng());
      const scale = height / Math.max(0.01, proto.height);
      // Slight non-uniform squash so a repeated model does not read as clones.
      const wobble = 0.9 + rng() * 0.2;

      let batch = batches.get(model);
      if (!batch) {
        batch = { matrices: [], canopy: isCanopy };
        batches.set(model, batch);
      }
      this._setMatrix(p, origin, scale * wobble, scale, scale * wobble, rng() * Math.PI * 2);
      batch.matrices.push(this._mat.clone());
    }

    for (const [model, batch] of batches) {
      const proto = this.foliage.get(model);
      const mesh = new THREE.InstancedMesh(proto.geometry, this.matFoliage, batch.matrices.length);
      // Grass and flowers are too small to read in a 78 m shadow cascade; the
      // shadow pass cost is real and the visual return is nil.
      mesh.castShadow = batch.canopy;
      mesh.receiveShadow = true;
      batch.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      out.push(mesh);
    }

    return out;
  }

  // ---------------------------------------------------------------- grass --

  /**
   * Scatters one chunk's ground cover, ONTO the terrain sheet rather than
   * beside it.
   *
   * The obvious implementation — draw a random (s, v) and ask
   * `meshGroundPoint` where the ground is — was measured at **591 ms per
   * chunk**. That is not a slow function; it is the right function called far
   * too often. Each call re-derives the surface from scratch: four road frames
   * and four analytic ground samples, every one of them an fBm evaluation, and
   * at thirty thousand tufts a chunk that is a quarter of a million noise
   * evaluations to answer a question the terrain builder answered ten
   * milliseconds earlier and wrote into a buffer.
   *
   * So this reads that buffer. A cell of the terrain grid is chosen with
   * probability proportional to its ground area, and the tuft is placed by
   * interpolating the four corner vertices exactly as `meshGroundPoint` does —
   * same quad, same diagonal, same winding — with the vertex COLOURS
   * interpolated alongside. There are no noise evaluations left in the loop,
   * the cost falls by two orders of magnitude, and the result is more correct
   * than the original: grass is on the surface the renderer draws and painted
   * the colour the renderer paints, by construction rather than by agreement.
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

    // Seeded per chunk, so a chunk that streams out and back comes back with
    // the same field. Offset from the prop seed, or grass would land in
    // exactly the places the trees did.
    const rng = mulberry32(hashInt(index) ^ tier.salt);

    const inner = EDGE - 0.35;             // start just inside the paved edge
    const outer = tier.halfExtent;
    if (!(outer > inner)) return null;

    /**
     * Card size by lateral distance: full size out to `denseTo`, then growing
     * to `farScale` at the edge of the band. See GRASS.farScale — bigger cards
     * cover more ground for the same instance, and the count per unit area is
     * divided by the square of this, so COVERAGE stays flat while the instance
     * count does not follow the field out into the distance.
     *
     * It starts at `denseTo` rather than at the road, because near the car the
     * cards are the thing being looked at and enlarging them there is just
     * coarser grass.
     */
    const span = Math.max(1e-3, outer - tier.denseTo);
    const boost = (av) =>
      lerp(1, tier.farScale, clamp((av - tier.denseTo) / span, 0, 1));

    /**
     * Coverage taper, over the outer quarter of the band only.
     *
     * This is the one thing hiding the sideways edge of the field, so it has to
     * reach zero exactly at `halfExtent` — but it must not start any earlier
     * than it needs to. Tapering across the whole of `denseTo..halfExtent`,
     * which is what this did first, compounds with the size boost above and
     * empties the middle distance: two independent falloffs over the same
     * range, and the field ends up a ribbon along the tarmac again.
     */
    const taperFrom = outer * 0.75;
    const thin = (av) => {
      if (av <= taperFrom) return 1;
      const t = (av - taperFrom) / (outer - taperFrom);
      return Math.max(0, 1 - t * t);
    };

    // ---- cell table ------------------------------------------------------
    // One pass over the grid, collecting the cells that can hold grass and the
    // area each contributes. `cum` is the cumulative weight, so a sample is a
    // binary search rather than a scan.
    const cells = [];
    const cum = [];
    let total = 0;

    for (let j = 0; j < nu; j++) {
      for (let i = 0; i < nv - 1; i++) {
        const av0 = Math.abs(lat[i]);
        const av1 = Math.abs(lat[i + 1]);
        const lo = Math.min(av0, av1);
        const hi = Math.max(av0, av1);
        // Wholly on the carriageway, or wholly outside the band.
        if (hi <= inner || lo >= outer) continue;

        const a = j * nv + i;
        const b = a + 1;
        const c = a + nv;
        const d = c + 1;
        const width = Math.abs(lat[i + 1] - lat[i]);
        if (width < 1e-4) continue;         // duplicated road-marking column
        // Clip the cell to the band so a wide far-field column is not counted
        // as if all of it were plantable.
        const usable = Math.min(hi, outer) - Math.max(lo, inner);
        if (usable <= 0) continue;

        const mid = (lo + hi) * 0.5;
        const bz = boost(mid);
        const w = (rowLen * usable * thin(mid)) / (bz * bz);
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

    /**
     * Instance data is written STRAIGHT into its final buffers.
     *
     * The prop scatter composes a Matrix4 and pushes a clone, which is fine for
     * fifty trees and is thirty thousand object allocations here — measured at
     * roughly half the scatter's total cost, all of it handed to the collector
     * a frame later. A yaw-and-scale matrix is nine non-zero terms anyway, so
     * writing them out is both cheaper and clearer than composing a quaternion
     * to describe a rotation about one axis.
     */
    const mats = new Float32Array(samples * 16);
    const colours = new Float32Array(samples * 3);
    const p = this._cA;
    let placed = 0;

    for (let n = 0; n < samples; n++) {
      // Pick a cell by area.
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

      // Reject anything landing on the carriageway side of the verge. The cell
      // table already dropped the cells that are entirely road, so this only
      // trims the one straddling column.
      const av = Math.abs(lat[col] + fv * (lat[col + 1] - lat[col]));
      if (av < inner || av > outer) continue;

      // Same split as _buildTerrain's index order: a,b,c then b,d,c.
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
      const height = lerp(GRASS.height[0], GRASS.height[1], t * t) * bz;
      const wid = height * GRASS.widthRatio * tier.widthMul * lerp(0.8, 1.25, rng());

      // Sunk slightly, so a root is never visible over a rise.
      p.y -= height * 0.06;

      // T * R_y * S, written out. `p` came straight from the sheet, so it is
      // ALREADY origin-relative and must not have the origin taken off again.
      const yaw = rng() * Math.PI * 2;
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const o16 = placed * 16;
      mats[o16] = cy * wid;      mats[o16 + 2] = -sy * wid;
      mats[o16 + 5] = height;
      mats[o16 + 8] = sy * wid;  mats[o16 + 10] = cy * wid;
      mats[o16 + 12] = p.x; mats[o16 + 13] = p.y; mats[o16 + 14] = p.z;
      mats[o16 + 15] = 1;

      // The ground's own colour, interpolated over the same triangle, lifted:
      // the card texture is luminance only, so this carries the entire hue,
      // and grass is brighter than the soil it stands in.
      const lift = lerp(1.20, 1.55, rng());
      const o = placed * 3;
      colours[o] = (colors[i0 * 3] * w0 + colors[i1 * 3] * w1 + colors[i2 * 3] * w2) * lift;
      colours[o + 1] = (colors[i0 * 3 + 1] * w0 + colors[i1 * 3 + 1] * w1 + colors[i2 * 3 + 1] * w2) * lift;
      colours[o + 2] = (colors[i0 * 3 + 2] * w0 + colors[i1 * 3 + 2] * w1 + colors[i2 * 3 + 2] * w2) * lift;
      placed++;
    }

    if (!placed) return null;

    const mesh = new THREE.InstancedMesh(this.grass.geometry, tier.material, placed);
    // Swap in the buffers rather than copying into the ones the constructor
    // made. `subarray` is a view, so the trim costs nothing.
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(mats.subarray(0, placed * 16), 16);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colours.subarray(0, placed * 3), 3);
    // Never casts. A 78 m shadow cascade cannot resolve a 60 cm blade, and the
    // shadow pass would be another sixty thousand instances for nothing.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    // The shader shrinks tufts with distance and leans them sideways, neither
    // of which three knows about, so let it draw them and skip the cull.
    mesh.frustumCulled = false;
    mesh.userData.grass = true;
    return mesh;
  }

  // ---------------------------------------------------------------- stone --

  /**
   * Scatters one chunk's stone.
   *
   * The whole point of this module is TEXTURE, not scenery — see env/rocks.js.
   * A cut face is a smooth green ramp until there is broken rock spilling out
   * of it, and a verge is a mown edge until there is gravel on it. So the two
   * placement rules that matter are both about slope and about the road:
   *
   *   - the band starts just outside the paved edge and ends at 120 m, because
   *     a 40 cm chip past that is a sub-pixel object with a draw call attached
   *   - the STEEPER the ground, the more likely stone is, and the more of it is
   *     scree rather than boulders. That single rule produces talus under a
   *     cutting, chips along a bank and the occasional stone in a flat field,
   *     without any of those being a separate case
   *
   * Like the grass, it is placed by interpolating the terrain sheet's own
   * vertices — same quad, same diagonal, same winding — so a rock is on the
   * surface the renderer draws rather than on the analytic surface underneath
   * it, and takes the ground's own colour so it belongs to the biome it is in.
   *
   * One InstancedMesh per variant, so the whole chunk's stone is a handful of
   * draw calls. Returns the meshes, or null.
   */
  _buildRocks(index, s0, s1, origin) {
    const chunk = this.chunks.get(index);
    if (!this.rocks || !chunk || !chunk.sheet) return null;

    const { positions, colors } = chunk.sheet;
    const lat = this.lateral;
    const nv = lat.length;
    const nu = CHUNK.segmentsU;
    const rowLen = (s1 - s0) / nu;
    const rng = mulberry32(hashInt(index) ^ 0x9b1c3d77);

    const inner = Math.max(EDGE, ROCKS.band[0]);
    const outer = ROCKS.band[1];
    if (!(outer > inner)) return null;

    // Per-variant instance lists. Flat arrays of [m16..., r, g, b] would be
    // tidier; separate arrays keep the InstancedMesh construction below trivial.
    const buckets = new Map();
    const names = Object.keys(this.rocks.classes);
    // Where this chunk's window into each class's variant library starts. Drawn
    // once, from the chunk's own seed, so a chunk that streams out and back
    // comes back with the same stone in it. See ROCKS.variantsPerChunk.
    const offsets = {};
    for (const k of names) offsets[k] = Math.floor(rng() * this.rocks.classes[k].variants.length);
    const p = this._cA;

    for (let n = 0; n < ROCKS.samples; n++) {
      // Uniform over the grid rather than over area. The far columns are wider,
      // so this biases toward the near ones — which is exactly right here: the
      // verge is where the stone belongs and the far band is where it stops
      // being resolvable.
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

      // Same split as _buildTerrain's index order: a,b,c then b,d,c.
      let i0, i1, i2, w0, w1, w2;
      if (fu + fv <= 1) {
        i0 = a; i1 = b; i2 = c;
        w1 = fv; w2 = fu; w0 = 1 - fv - fu;
      } else {
        i0 = b; i1 = d; i2 = c;
        w1 = fu + fv - 1; w2 = 1 - fv; w0 = 1 - w1 - w2;
      }

      // Slope from the cell's own corners — the gradient of the very triangle
      // the rock will stand on, for four subtractions.
      const ya = positions[a * 3 + 1];
      const gv = (positions[b * 3 + 1] - ya) / width;
      const gu = (positions[c * 3 + 1] - ya) / rowLen;
      const slope = Math.sqrt(gu * gu + gv * gv);

      // The one rule. Flat ground gets the occasional stone; a cut face gets
      // talus. `smoothstep` rather than a threshold so a bank does not have a
      // visible line across it where the rocks start.
      const scree = smoothstep(ROCKS.screeSlope * 0.55, ROCKS.screeSlope, slope);
      const chance = lerp(0.06, 0.92, scree)
        // Thin out with distance from the road: this is roadside dressing.
        * (1 - smoothstep(inner, outer, av) * 0.75);
      if (rng() > chance) continue;

      // Which class. Scree dominates on a face, boulders only on open ground.
      const mix = scree > 0.5 ? ROCKS.screeMix : ROCKS.mix;
      let roll = rng();
      let name = names[0];
      for (const k of names) {
        roll -= mix[k] || 0;
        if (roll <= 0) { name = k; break; }
      }
      const cls = this.rocks.classes[name];
      // A chunk uses a SUBSET of the library, not all of it.
      //
      // Every distinct geometry in a chunk is another InstancedMesh and another
      // draw call, and with fourteen variants across three classes a chunk was
      // touching eleven of them for a hundred-odd rocks — a draw call per nine
      // instances, which is the cost model of not instancing at all. Two
      // variants per class per chunk caps it at six while the whole library
      // still appears across the world, because which two is seeded per chunk.
      const pick = Math.floor(rng() * ROCKS.variantsPerChunk);
      const variant = (offsets[name] + pick) % cls.variants.length;

      p.set(
        positions[i0 * 3] * w0 + positions[i1 * 3] * w1 + positions[i2 * 3] * w2,
        positions[i0 * 3 + 1] * w0 + positions[i1 * 3 + 1] * w1 + positions[i2 * 3 + 1] * w2,
        positions[i0 * 3 + 2] * w0 + positions[i1 * 3 + 2] * w1 + positions[i2 * 3 + 2] * w2
      );

      const size = lerp(cls.spec.size[0], cls.spec.size[1], rng() * rng());
      // Bedded, not dropped: a stone sits partly in the ground it came out of,
      // and one resting exactly on the surface reads as a prop placed there.
      p.y -= size * lerp(0.10, 0.30, rng());

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
      const yaw = rng() * Math.PI * 2;
      const cy = Math.cos(yaw) * size;
      const sy = Math.sin(yaw) * size;
      bucket.mats.push(
        cy, 0, -sy, 0,
        0, size, 0, 0,
        sy, 0, cy, 0,
        p.x, p.y, p.z, 1
      );
      // The ground's own colour, darkened: stone is the same rock the hillside
      // is painted from, and it is never brighter than the soil around it.
      const shade = lerp(0.72, 0.98, rng());
      bucket.cols.push(
        (colors[i0 * 3] * w0 + colors[i1 * 3] * w1 + colors[i2 * 3] * w2) * shade,
        (colors[i0 * 3 + 1] * w0 + colors[i1 * 3 + 1] * w1 + colors[i2 * 3 + 1] * w2) * shade,
        (colors[i0 * 3 + 2] * w0 + colors[i1 * 3 + 2] * w1 + colors[i2 * 3 + 2] * w2) * shade
      );
    }

    if (!buckets.size) return null;
    const meshes = [];
    for (const bucket of buckets.values()) {
      const count = bucket.cols.length / 3;
      const mesh = new THREE.InstancedMesh(bucket.geometry, this.rocks.material, count);
      mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(bucket.mats), 16);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(bucket.cols), 3);
      // Scree never casts. The sun's shadow cascade covers 78 m at 2048 px,
      // which is 4 cm a texel — a 15 cm chip is three texels, so its shadow is
      // noise, and there are more chips than everything else put together.
      mesh.castShadow = bucket.shadow;
      mesh.receiveShadow = true;
      mesh.userData.rock = true;
      meshes.push(mesh);
    }
    return meshes;
  }

  /** Adds and removes stone as the car moves. Mirrors `_updateGrass`. */
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

  /**
   * Adds and removes ground cover as the car moves.
   *
   * Grass has a shorter life than the chunk that holds it: it is invisible long
   * before a chunk streams out, so building it for all nine would be six chunks
   * of geometry nobody can resolve. This runs every frame and is a pure
   * function of which chunk the car is in — the same rule bug #27 had to learn
   * for the tunnel marking it used to carry, for the same reason. Nothing here
   * depends on how the car arrived.
   *
   * The tiers share one budget and the NEAR one is served first, because it is
   * the one whose absence is visible. A far-tier chunk arriving a few frames
   * late is a patch of middle distance that fills in behind the fog.
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

      // Nearest first, and at most `budget` a frame: scattering one chunk is
      // thousands of surface samples and it must not land in one frame beside a
      // terrain build.
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
          // Nothing to place here. Mark it done so the queue does not retry it
          // on every frame for the rest of the chunk's life.
          chunk[tier.key] = null;
          chunk[emptyKey] = true;
        }
        budget--;
      }
    }
  }

  /**
   * Instance transform from a WORLD position, made chunk-local.
   *
   * The distinction matters and has already cost a bug: the terrain sheet's
   * vertex buffer is stored origin-relative, so handing one of its points to
   * this function subtracts the origin a second time and puts the instance a
   * chunk-length away from where it belongs. `_setLocalMatrix` is for points
   * that are already local.
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
