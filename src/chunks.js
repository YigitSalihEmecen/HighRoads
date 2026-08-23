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
import { CHUNK, ROAD, TERRAIN_COLORS } from './config.js';
import { clamp, lerp, smoothstep, smin, smax, mulberry32, hashInt } from './util.js';
import { FOLIAGE, FOLIAGE_GROUPS, GROUP_OF, suitability } from './foliage.js';
import { makeFrame } from './path.js';

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
  let step = CHUNK.nearStep;
  while (v < CHUNK.halfExtent) {
    step = Math.min(step * 1.32, 55);
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
 * Height of the bore's inner surface at lateral offset v, or -1 outside it.
 *
 * The terrain hole and the tunnel geometry MUST be derived from the same
 * silhouette. Cutting the hole on a flat height threshold across a fixed band
 * instead tears ragged holes up the hillside wherever the ground happens to dip
 * below that height, and — because the band was wider than the bore — leaves a
 * strip either side with no geometry at all for the car to fall through.
 */
function boreHeightAt(v) {
  const hw = ROAD.tunnelHalfWidth;
  const av = Math.abs(v);
  if (av > hw) return -1;
  const wallH = ROAD.tunnelCrown * 0.45;
  // Semi-ellipse springing from the wall top; below that it is a plain wall.
  const t = av / hw;
  return wallH + Math.sqrt(Math.max(0, 1 - t * t)) * (ROAD.tunnelCrown - wallH);
}

/** Half-width of the sill slab — the widest the bore's footprint ever gets. */
const SILL = ROAD.tunnelHalfWidth + ROAD.tunnelSill;

/**
 * "There is a bore here." ONE constant, used by every consumer of the tunnel
 * factor: the terrain clearance, the mouth, the ground query and the lining
 * sweep.
 *
 * It has to be shared. Three of those used to test slightly different numbers
 * (0.0005, 0.01, 0.5), and each disagreement opened a band of road where one
 * rule was in force and another was not. The worst of them lifted the terrain
 * clear of the arch without removing it, leaving an 8.8 m wall — the arch
 * height exactly — standing across the carriageway on the approach to a portal.
 */
const TUNNEL_EPS = 1e-4;

/**
 * Height above the road plane that the terrain must be held clear of, so the
 * mountain can never reach down into the bore.
 *
 * This REPLACES cutting the roof away on a height test. The old rule removed
 * any terrain quad that hung below the arch, which is correct but only as
 * reliable as the grid: it depended on where vertices happened to land, and a
 * dip in the rock cover mid-tunnel opened real sky over the carriageway.
 * Pushing the surface up instead cannot fail — there is no case left in which
 * terrain and bore occupy the same space — and it costs one `max`.
 *
 * The clearance tapers to nothing between the arch and the edge of the sill so
 * the lift blends into the hillside rather than standing on a step.
 */
function boreClearance(v) {
  const av = Math.abs(v);
  const arch = boreHeightAt(v);
  if (arch >= 0) return arch + ROAD.tunnelRoof;

  // Outside the bore the requirement decays to nothing over `tunnelBerm`, on a
  // smoothstep so both ends are C1. The old taper ran out over the 2.5 m sill,
  // which put a 62-degree shoulder either side of every tunnel — a berm with a
  // crease down it, running the length of the bore. Spread over tens of metres
  // it reads as the hillside the tunnel is bored through, which is the point.
  const wallTop = ROAD.tunnelCrown * 0.45 + ROAD.tunnelRoof;
  const t = clamp((av - ROAD.tunnelHalfWidth) / ROAD.tunnelBerm, 0, 1);
  return wallTop * (1 - smoothstep(0, 1, t));
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
 * Rather than truncating (which collapses columns onto each other), the inside
 * is compressed asymptotically:  v' = L·(1 - e^(-|v|/L)),  L = 0.7·R.  That maps
 * [0, inf) onto [0, L) smoothly and monotonically, so no column can approach the
 * centre. The 0.7 margin matters: rows are spaced Δs·(1 + v·κ) apart, so a
 * column sitting at R would have zero longitudinal extent, and the resulting
 * sliver triangles yield garbage normals even though they never technically
 * invert. Capping at 0.7·R keeps every quad at ≥30% of its nominal depth.
 * Near the road the correction is negligible (<1% at the kerb) and it vanishes
 * entirely on straights, where R is effectively infinite.
 *
 * Curvature is a function of arc length alone, so neighbouring chunks compute
 * an identical correction at a shared boundary and seams stay exact.
 */
function foldSafeOffset(v, curv) {
  const k = Math.abs(curv);
  if (k < 1e-7) return v;

  // Turning left (curv > 0) puts the centre of rotation at negative v.
  const insideSign = -Math.sign(curv);
  if (Math.sign(v) !== insideSign) return v;

  const L = 0.7 / k;
  return insideSign * L * (1 - Math.exp(-Math.abs(v) / L));
}

/* ------------------------------------------------------------------------- */

export class ChunkManager {
  constructor({ scene, world, RAPIER, path, terrain, foliage }) {
    this.scene = scene;
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

    this._buildSharedAssets();
  }

  // ------------------------------------------------------------- materials --

  _buildSharedAssets() {
    // Smooth-shaded, deliberately. Flat shading is what made the landscape
    // read as faceted and cartoonish: it draws every triangle of a 2.4 m mesh
    // as a distinct plate, so a hillside becomes a mosaic no matter how good
    // the underlying field is. Interpolated normals let the same geometry read
    // as a continuous surface, and the vertex colours gradate with it.
    this.matTerrain = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: false,
      roughness: 0.97,
      metalness: 0.0,
    });

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

    // Bore lining. Lit only by whatever spills in from the portals, so it
    // wants to be light enough not to read as a black hole.
    this.matTunnel = new THREE.MeshStandardMaterial({
      color: 0x6b6560,
      roughness: 0.95,
      metalness: 0.0,
      // Two-sided: the portal ring is seen from outside, the lining from
      // within, and one mesh carries both.
      side: THREE.DoubleSide,
    });

  }

  // ------------------------------------------------------------- sampling --

  /**
   * The single source of truth for ground height, shared by the mesh builder,
   * the prop scatterer and the respawn logic. Anything that disagrees with this
   * function will visibly float or sink.
   */
  sampleGround(frame, rightFlat, v, out) {
    v = foldSafeOffset(v, frame.curv);
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
    // is the road disappearing into the ground, and — because a portal is
    // precisely where the hillside crosses road level — it is also the wall a
    // car hits at a tunnel mouth.
    //
    // Tying k to a quarter of the gap makes the smoothing vanish exactly where
    // there is nothing to smooth. On the carriageway it degrades to a hard
    // clamp and the surface is the road plane, to the bit. Out on the slopes
    // the gap is metres wide and the full blend is back.
    const k = Math.min(ROAD.slopeBlend, (ceiling - floorY) * 0.25);
    let y = smax(smin(yNatural, ceiling, k), floorY, k);

    // Tunnels. The mountain is left intact right across the corridor, so the
    // terrain sheet becomes the lid over the bore and the hillside reads as
    // solid rock rather than a trench with a pipe in it. Nothing here has to
    // avoid the road: the car is underneath, on the bore floor, and the only
    // opening is the mouth — cut out of the index buffer where the rock is
    // thinner than the bore is tall.
    if (frame.tunnel > TUNNEL_EPS) {
      // Both the clamp release and the headroom come in on the SAME eased ramp.
      // Switching the headroom on as a step put an 8.8 m riser — the arch
      // height exactly — between one row and the next at every portal.
      const ramp = smoothstep(0, 1, frame.tunnel);
      y = lerp(y, yNatural, ramp);
      const clear = boreClearance(v);
      if (clear > 0) y = Math.max(y, yRoad + clear * ramp);
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
   * Inside a tunnel this returns the bore floor, because the corridor is kept
   * at road level there — respawn and the fell-out-of-the-world check both
   * call this and both want the driveable surface.
   */
  groundAt(s, v, out = new THREE.Vector3()) {
    const f = this.path.frameAt(s, this._frame);
    this._rightFlat.crossVectors(f.tan, WORLD_UP).normalize();
    this.sampleGround(f, this._rightFlat, v, out);
    // In a tunnel the terrain is the mountain overhead — and, since the bore
    // clearance lift, it is held at least an arch's height above the road even
    // where the mountain itself is thin. Everything that asks this question
    // (respawn, traffic placement, the fell-out-of-the-world check) wants the
    // surface the car drives on, which is the bore floor.
    //
    // The threshold is "any bore at all", not "mostly a bore". At 0.5 the two
    // answers differed by the full arch height right where a portal is, so a
    // respawn or a traffic car landed on the roof: measured as an 8.92 m
    // discrepancy, which is exactly tunnelCrown + tunnelRoof.
    if (f.tunnel > TUNNEL_EPS) out.y = f.pos.y + v * Math.tan(f.bank);
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
      }
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

    for (const m of [this.matTerrain, this.matRoad, this.matFoliage, this.matTunnel]) m.dispose();
    for (const f of this.foliage.values()) f.geometry.dispose();
  }

  // ---------------------------------------------------------------- build --

  _build(index) {
    const s0 = index * CHUNK.length;
    const s1 = s0 + CHUNK.length;

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
    for (const item of this._buildTunnels(s0, s1, origin)) {
      if (item._collider) { extraColliders.push(item._collider); continue; }
      item.position.copy(origin);
      item.matrixAutoUpdate = false;
      item.updateMatrix();
      this.scene.add(item);
      objects.push(item);
    }

    const chunk = { index, objects, collider, origin, props: false, extraColliders };
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

    const positions = new Float32Array(vertCount * 3);
    const colors = new Float32Array(vertCount * 3);
    const indices = new Uint32Array(nu * (nv - 1) * 6);

    // Kept alongside the positions so colouring can use them without re-deriving.
    const lateralAbs = new Float32Array(vertCount);
    const worldY = new Float32Array(vertCount);
    // Vertices sitting inside a tunnel mouth. The bore needs somewhere to open.
    const mouth = new Uint8Array(vertCount);

    const p = new THREE.Vector3();
    const frame = makeFrame();
    const rightFlat = new THREE.Vector3();

    for (let j = 0; j <= nu; j++) {
      const s = lerp(s0, s1, j / nu);
      this.path.frameAt(s, frame);
      rightFlat.crossVectors(frame.tan, WORLD_UP).normalize();

      for (let i = 0; i < nv; i++) {
        const v = this.lateral[i];
        this.sampleGround(frame, rightFlat, v, p);

        const k = j * nv + i;
        positions[k * 3 + 0] = p.x - origin.x;
        positions[k * 3 + 1] = p.y - origin.y;
        positions[k * 3 + 2] = p.z - origin.z;
        lateralAbs[k] = Math.abs(v);
        worldY[k] = p.y;
        // The mouth is a ROAD-SPACE rectangle, not a height test.
        //
        // Terrain is now held clear of the bore everywhere (boreClearance), so
        // nothing has to be removed to keep the carriageway open. What does
        // have to be removed is the rock FACE at each end — the two rows over
        // which the surface climbs from the cut-and-fill level to the mountain
        // — because that face stands square across the bore. Those are exactly
        // the rows where the tunnel factor is in transition, and a quad goes if
        // any corner is one of them. The result is a hole of fixed, known size:
        // bore width across, one portal length deep, with an edge that cannot
        // sit more than a cell of cut slope above the arch.
        mouth[k] =
          frame.tunnel > TUNNEL_EPS && frame.tunnel < 1 - TUNNEL_EPS &&
          Math.abs(v) <= ROAD.tunnelHalfWidth
            ? 1
            : 0;
      }
    }

    // Winding: +row is the tangent, +column is `right`, and up = right x tangent.
    // Counter-clockwise (a,b,c) therefore yields an upward face normal — get
    // this backwards and the whole world is backface-culled and lit from below.
    let t = 0;
    for (let j = 0; j < nu; j++) {
      for (let i = 0; i < nv - 1; i++) {
        const a = j * nv + i;
        const b = a + 1;
        const c = a + nv;
        const d = c + 1;
        // Any corner inside a mouth removes the quad, which is what lets the
        // bore break through the hillside instead of ending against it.
        if (mouth[a] || mouth[b] || mouth[c] || mouth[d]) continue;
        indices[t++] = a; indices[t++] = b; indices[t++] = c;
        indices[t++] = b; indices[t++] = d; indices[t++] = c;
      }
    }
    const trimmed = t === indices.length ? indices : indices.slice(0, t);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(trimmed, 1));
    geometry.computeVertexNormals();
    this._seamNormals(geometry, positions, nv, nu, s0, s1);

    this._colorTerrain(geometry, colors, lateralAbs, worldY, positions, origin);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();

    return { geometry, positions, indices: trimmed };
  }

  /**
   * Rewrites the normals on a chunk's first and last rows.
   *
   * `computeVertexNormals` only sees one chunk, so boundary vertices average
   * the triangles on their own side and end up tilted. With flat shading that
   * was invisible; smooth-shaded it draws a hard crease across the world every
   * 120 m. Re-deriving the boundary normal from the analytic surface either
   * side of the seam makes both chunks agree.
   */
  _seamNormals(geometry, positions, nv, nu, s0, s1) {
    const normals = geometry.attributes.normal.array;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    const c = new THREE.Vector3(), d = new THREE.Vector3();
    const n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    const eps = (s1 - s0) / nu;

    for (const row of [0, nu]) {
      const sRow = row === 0 ? s0 : s1;
      for (let i = 1; i < nv - 1; i++) {
        const k = row * nv + i;
        // Central differences across the seam, in both directions.
        this.groundAt(sRow - eps, this.lateral[i], a);
        this.groundAt(sRow + eps, this.lateral[i], b);
        this.groundAt(sRow, this.lateral[i - 1], c);
        this.groundAt(sRow, this.lateral[i + 1], d);
        e1.subVectors(b, a);
        e2.subVectors(d, c);
        n.crossVectors(e2, e1).normalize();
        if (n.y < 0) n.negate();
        normals[k * 3] = n.x;
        normals[k * 3 + 1] = n.y;
        normals[k * 3 + 2] = n.z;
      }
    }
    geometry.attributes.normal.needsUpdate = true;
  }

  /**
   * Vertex colours from altitude, slope and distance to the road. Normals are
   * already computed, so slope comes free from normal.y — no extra sampling.
   */
  _colorTerrain(geometry, colors, lateralAbs, worldY, positions, origin) {
    const normals = geometry.attributes.normal.array;
    const grassLow = new THREE.Color(TERRAIN_COLORS.grassLow);
    const grassHigh = new THREE.Color(TERRAIN_COLORS.grassHigh);
    const rock = new THREE.Color(TERRAIN_COLORS.rock);
    const peak = new THREE.Color(TERRAIN_COLORS.peak);
    const dirt = new THREE.Color(TERRAIN_COLORS.dirt);
    const c = this._color;

    for (let k = 0; k < lateralAbs.length; k++) {
      const y = worldY[k];
      // Far out on the inside of a bend the fold guard squeezes columns into
      // slivers whose computed normals are unreliable. Here the normal only
      // drives colour, so take the magnitude: a bad sliver can then never paint
      // a grass slope as a cliff.
      const ny = Math.abs(normals[k * 3 + 1]);
      const av = lateralAbs[k];

      // Altitude gradient, plus a low-frequency mottle so large flat areas
      // don't read as a single flat wash of colour.
      const x = positions[k * 3] + origin.x;
      const z = positions[k * 3 + 2] + origin.z;
      const mottle = this.terrain.nC(x * 0.014, z * 0.014) * 0.5 + 0.5;

      const alt = smoothstep(15, 95, y);
      c.copy(grassLow).lerp(grassHigh, clamp(alt * 0.85 + mottle * 0.35, 0, 1));

      // Steep faces expose rock. 0.86 -> 0.55 in normal.y is roughly 30-57 deg.
      c.lerp(rock, smoothstep(0.86, 0.55, ny));
      c.lerp(peak, smoothstep(88, 132, y) * 0.85);

      // Gravel verge fading into the vegetation.
      c.lerp(dirt, (1 - smoothstep(EDGE - 0.4, EDGE + 4.5, av)) * 0.9);

      // Slight per-vertex value jitter keeps the flat-shaded facets distinct.
      const jitter = 0.92 + mottle * 0.16;
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
    if (this.foliage.size === 0) return [];

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

  /**
   * The tunnel lining.
   *
   * Inside a tunnel the cut-and-fill clamp is released so the mountain stays
   * solid overhead — which means there is no ground at road level for the car
   * to drive on. The bore supplies it: a closed profile swept along the
   * alignment, giving floor, walls and an arched roof in one mesh, with its own
   * collider. The floor is the only surface the suspension ever touches; the
   * terrain above is a separate sheet the car passes beneath.
   *
   * Winding matches the terrain's, which puts every normal on the *inside* of
   * the tube — correct, because that is the only side anyone ever sees.
   */
  _buildTunnels(s0, s1, origin) {
    // The bore must cover EVERY row the mouth removed, or the hole starts
    // before the floor does and the car drops through it. Two things guarantee
    // that: scan finer than the terrain's row spacing, and on a threshold below
    // the one the mouth uses; then pad each span outward. Pads clamp to the
    // chunk, and neighbouring chunks abut, so the join stays covered.
    const scan = 1;
    const step = 3;
    const pad = 6;
    const spans = [];
    let run = null;

    for (let s = s0; s <= s1 + 1e-6; s += scan) {
      const t = this.path.frameAt(Math.min(s, s1), this._frame).tunnel;
      if (t > TUNNEL_EPS) {
        if (!run) run = { a: s, b: s };
        run.b = Math.min(s + scan, s1);
      } else if (run) {
        spans.push(run);
        run = null;
      }
    }
    if (run) spans.push(run);
    if (!spans.length) return [];
    for (const sp of spans) {
      // Does the bore actually END here, or was the span merely cut off by the
      // edge of this chunk? The difference decides two things: whether to pad
      // (a real portal needs the lining to reach past the over-cut terrain) and
      // whether to cap (only a real portal gets a ring of rock around it).
      sp.openA = this.path.frameAt(sp.a - scan, this._frame).tunnel <= TUNNEL_EPS;
      sp.openB = this.path.frameAt(sp.b + scan, this._frame).tunnel <= TUNNEL_EPS;
      sp.a = sp.openA ? Math.max(s0, sp.a - pad) : s0;
      sp.b = sp.openB ? Math.min(s1, sp.b + pad) : s1;
      // Snap to a GLOBAL station grid. Chunk length is a whole number of steps,
      // so two chunks meeting at a boundary put a row at exactly the same arc
      // length and therefore generate bit-identical vertices there — the joint
      // is seamless rather than merely close.
      sp.a = Math.floor(sp.a / step) * step;
      sp.b = Math.ceil(sp.b / step) * step;
    }

    const hw = ROAD.tunnelHalfWidth;
    const wallH = ROAD.tunnelCrown * 0.45;
    const crown = ROAD.tunnelCrown;
    // The sill runs wider than the bore so that whatever the terrain grid's
    // quantisation does to the hole, there is always floor beneath it.
    const sill = hw + ROAD.tunnelSill;

    // Closed cross-section: floor, both walls and the arch. The terrain above
    // is now solid rock, so the bore has to supply the driveable surface as
    // well as the lining. Starting on the right and running the loop this way
    // puts every normal on the inside, which is the only side ever seen.
    const profile = [[sill, 0], [hw, 0], [hw, wallH]];
    const ARCH = 9;
    for (let i = 1; i < ARCH; i++) {
      const a = (i / ARCH) * Math.PI;
      profile.push([Math.cos(a) * hw, wallH + Math.sin(a) * (crown - wallH)]);
    }
    profile.push([-hw, wallH], [-hw, 0], [-sill, 0]);
    const nvProfile = profile.length;
    // Closing segment back to the start is the floor, sill to sill.
    profile.push([sill, 0]);

    const out = [];
    for (const span of spans) {
      const rows = Math.max(2, Math.round((span.b - span.a) / step) + 1);
      const nv = profile.length;
      const verts = new Float32Array(rows * nv * 3);
      const idx = new Uint32Array((rows - 1) * (nv - 1) * 6 + 2 * (nvProfile - 1) * 6);

      const frame = makeFrame();
      const rightFlat = new THREE.Vector3();

      for (let j = 0; j < rows; j++) {
        const s = lerp(span.a, span.b, j / (rows - 1));
        this.path.frameAt(s, frame);
        rightFlat.crossVectors(frame.tan, WORLD_UP).normalize();
        const slope = Math.tan(frame.bank);

        for (let i = 0; i < nv; i++) {
          const [v, hy] = profile[i];
          const k = (j * nv + i) * 3;
          verts[k] = frame.pos.x + rightFlat.x * v - origin.x;
          verts[k + 1] = frame.pos.y + v * slope + hy - origin.y;
          verts[k + 2] = frame.pos.z + rightFlat.z * v - origin.z;
        }
      }

      let t = 0;
      for (let j = 0; j < rows - 1; j++) {
        for (let i = 0; i < nv - 1; i++) {
          const i2 = i + 1;
          const a = j * nv + i;
          const b = j * nv + i2;
          const c = (j + 1) * nv + i;
          const d = (j + 1) * nv + i2;
          idx[t++] = a; idx[t++] = b; idx[t++] = c;
          idx[t++] = b; idx[t++] = d; idx[t++] = c;
        }
      }

      // The bore is a SOLID shell, not a single sheet.
      //
      // A one-sided lining has nothing behind it, so anywhere the terrain hole
      // overshoots the arch — and with a grid it always overshoots somewhere —
      // you see straight through into the void. Sweeping a second profile
      // offset radially outward and capping both ends turns the tube into a
      // closed solid: any gap in the hillside now reveals rock, and the mouth
      // has real thickness instead of being one triangle deep.
      const shellVerts = [];
      const shellIdx = [];
      // The shell reaches past the terrain's cut edge so any gap shows rock
      // rather than sky. With the mouth now a fixed road-space rectangle, that
      // edge can only be one grid cell of cut slope above the clearance line,
      // so a fixed overshoot genuinely covers it — it is no longer a race
      // against however far the hillside happened to rise.
      const shell = ROAD.tunnelRoof + ROAD.tunnelShellExtra;
      const outer = profile.map(([v, hy]) => {
        // Radial from the tube's axis, for EVERY point including the floor.
        //
        // The floor used to be left where it was, on the reasoning that the
        // shell should sit flush on the slab. What that actually did was sweep
        // the floor a second time in the same place — and since the lining
        // material is double-sided, both copies draw and fight for the depth
        // buffer. Measured: 11.4% of every bore's triangles were coincident,
        // which is the shimmer along the tunnel floor. Offsetting the floor
        // too makes the shell a genuine closed solid with rock under the road
        // as well as over it, and no face is ever drawn twice.
        const dx = v, dy = hy - wallH;
        const len = Math.max(0.001, Math.hypot(dx, dy));
        return [v + (dx / len) * shell, hy + (dy / len) * shell];
      });

      for (let j = 0; j < rows; j++) {
        const sRow = lerp(span.a, span.b, j / (rows - 1));
        this.path.frameAt(sRow, frame);
        rightFlat.crossVectors(frame.tan, WORLD_UP).normalize();
        const slope = Math.tan(frame.bank);
        for (let i = 0; i < nv; i++) {
          const [v, hy] = outer[i];
          shellVerts.push(
            frame.pos.x + rightFlat.x * v - origin.x,
            frame.pos.y + v * slope + hy - origin.y,
            frame.pos.z + rightFlat.z * v - origin.z
          );
        }
      }
      // Outward-facing: reverse the winding used for the inner lining.
      for (let j = 0; j < rows - 1; j++) {
        for (let i = 0; i < nv - 1; i++) {
          const a = j * nv + i, b = j * nv + i + 1;
          const c = (j + 1) * nv + i, d = (j + 1) * nv + i + 1;
          shellIdx.push(a, c, b, b, c, d);
        }
      }

      // End caps joining inner rim to outer rim — the visible mouth.
      //
      // ONLY at an end that is really the end of the bore. A span clipped by a
      // chunk boundary used to get one too, which put a raised ring of rock
      // around the bore in the middle of the tunnel, once every 120 m. It is
      // the same mistake as capping the collider there, one layer up.
      const capIdx = [];
      const capRows = [];
      if (span.openA) capRows.push([0, false]);
      if (span.openB) capRows.push([rows - 1, true]);
      for (const [row, flip] of capRows) {
        for (let i = 0; i < nv - 1; i++) {
          const ai = row * nv + i, bi = row * nv + i + 1;          // inner
          const ao = ai, bo = bi;                                  // outer (offset later)
          capIdx.push([ai, bi, ao, bo, flip ? 1 : 0]);
        }
      }

      const geo = new THREE.BufferGeometry();
      const innerCount = verts.length / 3;
      const allVerts = new Float32Array(verts.length + shellVerts.length);
      allVerts.set(verts, 0);
      allVerts.set(shellVerts, verts.length);

      const caps = [];
      for (const [ai, bi, ao, bo, flip] of capIdx) {
        const AO = ao + innerCount, BO = bo + innerCount;
        if (flip) caps.push(ai, AO, bi, bi, AO, BO);
        else caps.push(ai, bi, AO, bi, BO, AO);
      }

      const allIdx = new Uint32Array(t + shellIdx.length + caps.length);
      allIdx.set(idx.subarray(0, t), 0);
      for (let i = 0; i < shellIdx.length; i++) allIdx[t + i] = shellIdx[i] + innerCount;
      allIdx.set(caps, t + shellIdx.length);

      geo.setAttribute('position', new THREE.BufferAttribute(allVerts, 3));
      geo.setIndex(new THREE.BufferAttribute(allIdx, 1));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();

      const mesh = new THREE.Mesh(geo, this.matTunnel);
      mesh.userData.ownsGeometry = true;
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      out.push(mesh);

      // Collide against the swept lining ONLY — never the portal rings. The
      // rings are decorative trim that flares outward into the rock, and a span
      // is clipped to its chunk, so a tunnel crossing a chunk boundary grows a
      // pair of them back to back in the middle of the bore. As collision
      // geometry that is a bulkhead across the carriageway: the car drives into
      // a tunnel at 209 km/h and stops dead against thin air.
      const desc = this.RAPIER.ColliderDesc.trimesh(verts, idx.subarray(0, t))
        .setTranslation(origin.x, origin.y, origin.z)
        .setFriction(1.0)
        .setRestitution(0.0);
      out.push({ _collider: this.world.createCollider(desc) });
    }

    return out;
  }

  _setMatrix(worldPos, origin, sx, sy, sz, yaw) {
    this._pos.set(worldPos.x - origin.x, worldPos.y - origin.y, worldPos.z - origin.z);
    this._quat.setFromAxisAngle(WORLD_UP, yaw);
    this._scl.set(sx, sy, sz);
    this._mat.compose(this._pos, this._quat, this._scl);
    return this._mat;
  }
}
