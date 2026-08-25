/**
 * path.js — the infinite road spline.
 *
 * The road is a chain of control points laid down by a noise-driven heading
 * integrator, interpolated with THREE.CatmullRomCurve3 (centripetal
 * parameterisation, which is what stops overshoot on tight control polygons).
 *
 * Because Catmull-Rom is *local* — a segment depends only on the four points
 * around it — the curve can be extended forever without ever rebuilding what
 * came before. We build a 4-point curve per segment and sample only its middle
 * third, which is exactly the piece bounded by the correct neighbours.
 *
 * On top of the raw samples we bake an arc-length table with a full Frenet-like
 * frame (tangent / right / up) plus a banking angle derived from curvature.
 * Everything downstream — terrain, road ribbon, props, respawn — addresses the
 * world as (s, v): distance along the road, offset across it.
 */

import * as THREE from 'three';
import { ROAD, ROUTE } from './config.js';
import { clamp, lerp } from './util.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** How many samples per control-point segment. ~2.5 m each at 46 m spacing. */
const SAMPLES_PER_SEGMENT = Math.max(2, Math.round(ROAD.ctrlSpacing / ROAD.sampleStep));

/** Half-width of the symmetric window used to smooth curvature into banking. */
const CURV_WINDOW = 4;

export class RoadPath {
  constructor(terrain, seed) {
    this.terrain = terrain;
    this.seed = seed;

    /** Control points (world space). */
    this.ctrl = [];
    /** Densely sampled positions with cumulative arc length. */
    this.pts = [];
    /** Per-sample orientation frames; lags `pts` by CURV_WINDOW. */
    this.frames = [];

    this.framedUpTo = -1;
    /** Current tangent heading, radians, 0 = -Z. */
    this.heading = 0;
    /** The slowly drifting compass the router is trying to follow. */
    this.bearing = 0;
    /** Turn taken on the last span, for the turn-change cost. */
    this.lastTurn = 0;
    /** Largest turn one span may take, from the curvature limit. */
    this.maxTurn = ROAD.maxCurvature * ROAD.ctrlSpacing;
    /** Next control-point segment to sample (segment i spans ctrl[i]..ctrl[i+1]). */
    this.nextSegment = 1;

    // Seed the control polygon and enough samples for the first frames.
    for (let i = 0; i < 4; i++) this._addControlPoint();
    this.ensureLength(ROAD.ctrlSpacing * 2);
  }

  /** Arc length covered by fully framed samples. */
  get length() {
    return this.framedUpTo >= 0 ? this.pts[this.framedUpTo].s : 0;
  }

  // ------------------------------------------------------------- building --

  /**
   * The route's personality at a point, blended from two slow noise fields.
   *
   * Returns the weights the cost function should use here, not a mode name.
   * Blending weights rather than switching between named modes is deliberate:
   * a discrete mode change lands as a kink in the alignment at the exact
   * station it happens, and there is no natural place to put one on an infinite
   * road. Weights that drift produce a road that is *becoming* a valley road
   * for a kilometre before it is one.
   */
  _character(s) {
    const t = this.terrain;
    const f = ROUTE.characterScale;
    // Two independent fields: one says how hard to avoid moving earth, the
    // other whether to prefer height or depth.
    const direct = t.nA(s / f, 41.7);        // -1..1
    const seek = t.nB(s / f + 5.3, 88.1);    // -1..1

    return {
      // 1 at its most careful, (1 - directness) at its most bloody-minded.
      earth: ROUTE.wEarthwork * (1 - ROUTE.directness * Math.max(0, direct)),
      // > 0 seeks high ground, < 0 seeks low ground.
      seek: ROUTE.wSeek * seek,
      // Always some appetite for a hillside, more on half the cycle. Never
      // zero: a stretch of road with no shelf at all is the flat default this
      // whole block exists to get away from.
      shelf: ROUTE.wShelf * (0.55 + 0.45 * Math.max(0, -direct)),
    };
  }

  /**
   * How badly a candidate at (x, z) doubles back on the road already laid.
   *
   * 0 when clear, rising to 1 at zero separation. See ROUTE.selfClear — this is
   * a structural constraint, not a stylistic one: two stretches of road within
   * a few hundred metres of each other have terrain sheets that disagree about
   * which of them the ground belongs to.
   */
  _selfProximity(x, z) {
    const spacing = ROAD.ctrlSpacing;
    const n = this.ctrl.length;
    // Control points are evenly spaced in ARC LENGTH, so the band converts to a
    // simple index range and no distances have to be accumulated.
    const lo = Math.max(0, n - Math.ceil(ROUTE.selfFar / spacing));
    const hi = n - Math.ceil(ROUTE.selfNear / spacing);
    let worst = 0;
    for (let i = lo; i < hi; i++) {
      const c = this.ctrl[i];
      const dx = c.x - x;
      const dz = c.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= ROUTE.selfClear * ROUTE.selfClear) continue;
      const t = 1 - Math.sqrt(d2) / ROUTE.selfClear;
      if (t > worst) worst = t;
    }
    return worst;
  }

  /** Natural ground the router routes over. Coarser than the mesh — see ROUTE.lod. */
  _ground(x, z) {
    return this.terrain.height(x, z, ROUTE.lod);
  }

  /**
   * Cost of running a span from `prev` to (x, y, z) on the given heading.
   *
   * Lower is better and the units are metres-ish: the earthwork term is a real
   * mean vertical error over the corridor, and every other term is scaled
   * against it. Nothing here is normalised globally, because only the ORDER of
   * the candidates matters — this is an argmin, not a measurement.
   */
  _spanCost(prev, x, y, z, heading, turn, grade, ch) {
    const spacing = ROAD.ctrlSpacing;

    // ---- earthwork ------------------------------------------------------
    // Mean |natural − road| over a grid of stations along the span and probes
    // across the corridor. This is the term that makes the road contour.
    let earth = 0;
    let n = 0;
    const right = { x: Math.cos(heading), z: Math.sin(heading) };
    for (let a = 1; a <= ROUTE.stations; a++) {
      const t = a / ROUTE.stations;
      const cx = lerp(prev.x, x, t);
      const cz = lerp(prev.z, z, t);
      const cy = lerp(prev.y, y, t);
      for (let b = 0; b < ROUTE.probes; b++) {
        // Spread across the corridor, both sides, skipping the centreline
        // (which the elevation choice has already fitted).
        const f = (b + 0.5) / ROUTE.probes;
        const v = (f * 2 - 1) * ROUTE.corridor;
        earth += Math.abs(this._ground(cx + right.x * v, cz + right.z * v) - cy);
        n++;
      }
    }
    earth /= Math.max(1, n);

    // ---- the view -------------------------------------------------------
    // Ground either side at the end of the span. Read at two distances: a shelf
    // is a local thing and a valley is not, and one probe cannot see both.
    const D = ROUTE.corridor;
    const gl = this._ground(x - right.x * D, z - right.z * D) - y;
    const gr = this._ground(x + right.x * D, z + right.z * D) - y;
    const fl = this._ground(x - right.x * D * 2.4, z - right.z * D * 2.4) - y;
    const fr = this._ground(x + right.x * D * 2.4, z + right.z * D * 2.4) - y;

    // Height sought relative to the country around, so `seek` means ridge or
    // valley rather than merely high or low.
    const stand = -(fl + fr) * 0.5;

    /**
     * A genuine shelf: one side up AND the other down. `min(rise, fall)` is
     * zero for a ridge top (both fall) and zero for a valley floor (both rise),
     * and only positive where the road is cut into a slope — which is the
     * cross-section being asked for.
     */
    const shelf = Math.max(
      Math.min(Math.max(0, gl), Math.max(0, -gr)),
      Math.min(Math.max(0, gr), Math.max(0, -gl))
    );

    // How much vertical range there is out here at all. A plain scores zero and
    // the router goes looking for somewhere with a shape to it.
    const relief = Math.max(gl, gr, fl, fr, 0) - Math.min(gl, gr, fl, fr, 0);

    // ---- the engineering ------------------------------------------------
    const gradeN = Math.abs(grade) / ROAD.maxGrade;
    const turnN = Math.abs(turn) / this.maxTurn;
    const turnDelta = Math.abs(turn - this.lastTurn) / this.maxTurn;

    // Deviation from the intended bearing. `1 - cos` rather than the raw angle
    // so it is flat near zero (small corrections are free) and grows hard past
    // a right angle.
    const off = 1 - Math.cos(heading - this.bearing);

    // Coming back alongside road already laid. Squared, so the penalty is
    // negligible at the edge of the exclusion and overwhelming inside it.
    const self = this._selfProximity(x, z);

    // Earthwork is free up to the budget and quadratic past it — see
    // ROUTE.earthFree for why minimising it outright is the wrong objective.
    const over = Math.max(0, earth - ROUTE.earthFree);

    return (
      ch.earth * over * over +
      ROUTE.wGrade * gradeN * gradeN +
      ROUTE.wTurn * turnN * turnN +
      ROUTE.wTurnChange * turnDelta * turnDelta +
      ROUTE.wBearing * off +
      ROUTE.wSelf * self * self -
      ch.seek * stand -
      ch.shelf * shelf -
      ROUTE.wRelief * relief
    );
  }

  /**
   * Lays down the next control point by choosing, rather than by wandering.
   *
   * Every candidate is legal by construction — the turn is bounded by
   * `maxCurvature` and the elevation is clamped to `maxGrade` and
   * `maxGradeChange` before it is ever scored — so the router only ever picks
   * among roads that could be built. It cannot produce an alignment the rest of
   * the project has to defend against.
   */
  _addControlPoint() {
    const i = this.ctrl.length;
    const t = this.terrain;

    if (i === 0) {
      this.grade = 0;
      this.lastTurn = 0;
      this.bearing = 0;
      this.heading = 0;
      this.ctrl.push(new THREE.Vector3(0, this._ground(0, 0) + ROUTE.rideHeight, 0));
      return;
    }

    const prev = this.ctrl[i - 1];
    const spacing = ROAD.ctrlSpacing;
    const s = i * spacing;

    // The compass. Drifts slowly and blindly; the terrain decides how the road
    // gets there. See ROUTE.wBearing for why this has to exist at all.
    this.bearing += t.nA(s * ROUTE.bearingDrift, 19.4) * ROAD.maxCurvature * spacing;

    const ch = this._character(s);
    let best = null;

    for (let c = 0; c < ROUTE.candidates; c++) {
      const frac = ROUTE.candidates === 1 ? 0 : (c / (ROUTE.candidates - 1)) * 2 - 1;
      const turn = frac * this.maxTurn;
      const heading = this.heading + turn;
      const x = prev.x + Math.sin(heading) * spacing;
      const z = prev.z - Math.cos(heading) * spacing;

      // Elevation is an OUTPUT, not an input. Aim at the natural surface here
      // — which on a hillside is the balanced cut-and-fill line — then clamp to
      // a legal profile. The old generator chased a neighbourhood average,
      // which oversmooths: it floats the road over dips and buries it in rises,
      // and both of those are earthwork the router is trying to avoid.
      const want = this._ground(x, z) + ROUTE.rideHeight;
      let grade = (want - prev.y) / spacing;
      grade = clamp(grade, this.grade - ROAD.maxGradeChange, this.grade + ROAD.maxGradeChange);
      grade = clamp(grade, -ROAD.maxGrade, ROAD.maxGrade);
      const y = prev.y + grade * spacing;

      const cost = this._spanCost(prev, x, y, z, heading, turn, grade, ch);
      // Straight on is the incumbent and has to be beaten by a margin, or the
      // argmin flickers between near-equal candidates and the road develops a
      // tremor. See ROUTE.hysteresis.
      const bias = c === (ROUTE.candidates - 1) / 2 ? 1 - ROUTE.hysteresis : 1;
      if (!best || cost * bias < best.score) {
        best = { score: cost * bias, x, y, z, heading, turn, grade };
      }
    }

    this.heading = best.heading;
    this.lastTurn = best.turn;
    this.grade = best.grade;
    this.ctrl.push(new THREE.Vector3(best.x, best.y, best.z));
  }

  /** Samples one control-point segment onto the arc-length table. */
  _extendSamples() {
    const i = this.nextSegment;
    while (this.ctrl.length < i + 3) this._addControlPoint();

    const curve = new THREE.CatmullRomCurve3(
      [this.ctrl[i - 1], this.ctrl[i], this.ctrl[i + 1], this.ctrl[i + 2]],
      false,
      'centripetal',
      0.5
    );

    // With four points the curve spans three segments; [1/3, 2/3] is the middle
    // one — the only stretch with correct neighbours on both sides.
    const first = this.pts.length === 0;
    for (let k = first ? 0 : 1; k <= SAMPLES_PER_SEGMENT; k++) {
      const t = 1 / 3 + (k / SAMPLES_PER_SEGMENT) / 3;
      const p = curve.getPoint(t, new THREE.Vector3());
      const prev = this.pts[this.pts.length - 1];
      const s = prev ? prev.s + p.distanceTo(prev.p) : 0;
      this.pts.push({ p, s });
    }

    this.nextSegment++;
  }

  /**
   * Builds orientation frames for every sample that now has CURV_WINDOW
   * neighbours on both sides, so curvature can be measured symmetrically.
   */
  _buildFrames() {
    const last = this.pts.length - 1 - CURV_WINDOW;

    for (let i = Math.max(this.framedUpTo + 1, CURV_WINDOW); i <= last; i++) {
      const a = this.pts[i - CURV_WINDOW];
      const b = this.pts[i];
      const c = this.pts[i + CURV_WINDOW];

      const tan = new THREE.Vector3().subVectors(c.p, a.p).normalize();

      // Signed curvature over the window: the turn angle divided by arc length.
      const t1 = new THREE.Vector3().subVectors(b.p, a.p).normalize();
      const t2 = new THREE.Vector3().subVectors(c.p, b.p).normalize();
      const cross = new THREE.Vector3().crossVectors(t1, t2);
      // Only the vertical component matters: banking responds to yaw rate, not
      // to the pitch change from climbing a hill.
      const angle = Math.asin(clamp(cross.y, -1, 1));
      const arc = Math.max(1e-3, c.s - a.s);
      const curv = angle / arc;

      // right = tangent x up  (with forward = -Z, that resolves to +X).
      const right = new THREE.Vector3().crossVectors(tan, WORLD_UP).normalize();

      // Bank into the corner: rotating `right` by -bank about the tangent lifts
      // the outside edge of the turn.
      const bank = clamp(curv * ROAD.bankGain, -ROAD.maxBank, ROAD.maxBank);
      right.applyAxisAngle(tan, -bank).normalize();

      const up = new THREE.Vector3().crossVectors(right, tan).normalize();

      // How much ground sits over the centreline here. Positive means the
      // alignment is below the natural surface — a cutting.
      const cover = this.terrain.base(b.p.x, b.p.z) - b.p.y;

      this.frames[i] = { tan, right, up, bank, curv, cover };
      this.framedUpTo = i;
    }

    // The leading samples never get a symmetric window; mirror the first real
    // frame back onto them so s = 0 is addressable.
    if (this.framedUpTo >= CURV_WINDOW && !this.frames[0]) {
      for (let i = 0; i < CURV_WINDOW; i++) {
        const f = this.frames[CURV_WINDOW];
        this.frames[i] = {
          tan: f.tan.clone(),
          right: f.right.clone(),
          up: f.up.clone(),
          bank: f.bank,
          curv: f.curv,
          cover: f.cover,
        };
      }
    }
  }

  /** Grows the spline until arc length `sTarget` is sampled and framed. */
  ensureLength(sTarget) {
    let guard = 0;
    while (this.length < sTarget && guard++ < 4096) {
      this._extendSamples();
      this._buildFrames();
    }
    this._buildFrames();
  }

  // ------------------------------------------------------------- sampling --

  /** Binary search for the sample index at or before arc length `s`. */
  _indexAt(s) {
    let lo = 0;
    let hi = this.framedUpTo;
    if (hi < 1) return 0;
    s = clamp(s, 0, this.pts[hi].s);

    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.pts[mid].s <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Fills `out` with the interpolated frame at arc length `s`.
   * `out` is reused by callers to keep this allocation-free in hot loops.
   */
  frameAt(s, out = makeFrame()) {
    const i = this._indexAt(s);
    const j = Math.min(i + 1, this.framedUpTo);
    const a = this.pts[i];
    const b = this.pts[j];
    const span = Math.max(1e-6, b.s - a.s);
    const t = clamp((s - a.s) / span, 0, 1);

    const fa = this.frames[i];
    const fb = this.frames[j] || fa;

    out.pos.lerpVectors(a.p, b.p, t);
    out.tan.lerpVectors(fa.tan, fb.tan, t).normalize();
    out.right.lerpVectors(fa.right, fb.right, t);
    // Gram-Schmidt: lerping two frames leaves them slightly non-orthogonal, but
    // it preserves the bank roll, which re-deriving from WORLD_UP would discard.
    out.right.addScaledVector(out.tan, -out.right.dot(out.tan)).normalize();
    out.up.crossVectors(out.right, out.tan).normalize();
    out.bank = lerp(fa.bank, fb.bank, t);
    out.curv = lerp(fa.curv, fb.curv, t);
    out.cover = lerp(fa.cover || 0, fb.cover || 0, t);
    out.s = s;
    return out;
  }

  /** Convenience: world position at (s, lateral offset v), on the road plane. */
  pointAt(s, v, out = new THREE.Vector3()) {
    const f = this.frameAt(s, _scratchFrame);
    return out.copy(f.pos).addScaledVector(f.right, v);
  }

  /**
   * Projects a world position onto the spline, returning arc length.
   * Searches a window around `sHint`, so this stays O(window) no matter how
   * long the road gets.
   */
  projectPoint(pos, sHint, back = 70, forward = 120) {
    const lo = this._indexAt(Math.max(0, sHint - back));
    const hi = this._indexAt(sHint + forward);

    let bestI = lo;
    let bestD = Infinity;
    for (let i = lo; i <= hi; i++) {
      const p = this.pts[i].p;
      const dx = pos.x - p.x;
      const dz = pos.z - p.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }

    // Refine by projecting onto the segment leaving the best sample.
    const a = this.pts[bestI];
    const b = this.pts[Math.min(bestI + 1, this.framedUpTo)];
    const ax = b.p.x - a.p.x;
    const az = b.p.z - a.p.z;
    const len2 = ax * ax + az * az;
    let t = 0;
    if (len2 > 1e-6) {
      t = clamp(((pos.x - a.p.x) * ax + (pos.z - a.p.z) * az) / len2, 0, 1);
    }
    return a.s + (b.s - a.s) * t;
  }

  /** Signed lateral offset of a world position from the centreline. */
  lateralOffset(pos, s) {
    const f = this.frameAt(s, _scratchFrame);
    _v.subVectors(pos, f.pos);
    return _v.dot(f.right);
  }
}

/**
 * 1-D binary dilation / erosion over a window of +-r samples, via a prefix sum
 * so the cost is independent of the radius.
 */
function window1d(src, r, wantAll) {
  const n = src.length;
  const sum = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) sum[i + 1] = sum[i] + src[i];
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - r);
    const hi = Math.min(n - 1, i + r);
    const count = sum[hi + 1] - sum[lo];
    out[i] = wantAll ? (count === hi - lo + 1 ? 1 : 0) : (count > 0 ? 1 : 0);
  }
  return out;
}
const dilate = (src, r) => window1d(src, r, false);
const erode = (src, r) => window1d(src, r, true);

export function makeFrame() {
  return {
    pos: new THREE.Vector3(),
    tan: new THREE.Vector3(),
    right: new THREE.Vector3(),
    up: new THREE.Vector3(),
    bank: 0,
    curv: 0,
    cover: 0,
    s: 0,
  };
}

const _scratchFrame = makeFrame();
const _v = new THREE.Vector3();
