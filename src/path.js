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
import { ROAD } from './config.js';
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
    /** Last sample whose tunnel flag is final. See _markTunnels. */
    this.markedUpTo = -1;
    this.heading = 0;
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

  /** Arc length whose tunnel flags are settled and will not change again. */
  get markedLength() {
    return this.markedUpTo >= 0 ? this.pts[this.markedUpTo].s : 0;
  }

  // ------------------------------------------------------------- building --

  _addControlPoint() {
    const i = this.ctrl.length;
    const t = this.terrain;

    let x, z;
    if (i === 0) {
      x = 0;
      z = 0;
    } else {
      // Integrate heading with a two-octave noise curvature signal. The second
      // octave breaks up the rhythm so corners don't arrive metronomically.
      const k =
        (t.nA(i * ROAD.curveFreq, 77.7) * 0.78 + t.nB(i * ROAD.curveFreq * 2.7, 12.3) * 0.32) *
        ROAD.maxCurvature;
      this.heading += clamp(k, -ROAD.maxCurvature, ROAD.maxCurvature) * ROAD.ctrlSpacing;

      const prev = this.ctrl[i - 1];
      x = prev.x + Math.sin(this.heading) * ROAD.ctrlSpacing;
      z = prev.z - Math.cos(this.heading) * ROAD.ctrlSpacing;
    }

    // Elevation: chase the neighbourhood-averaged terrain, low-passed, then
    // hard-clamped to a legal gradient. Where the clamp bites, the road ends up
    // cutting into a hillside or standing on fill — which is the good part.
    const target = t.roadElevation(x, z) + 0.9;
    let y;
    if (i === 0) {
      y = target;
      this.grade = 0;
    } else {
      const prevY = this.ctrl[i - 1].y;
      y = lerp(prevY, target, 1 - ROAD.elevationSmoothing);

      // Gradient, limited twice: absolute steepness, and how fast it is allowed
      // to change. The second is the vertical curve — without it the profile
      // can go from climbing hard to falling hard within one span, and vertical
      // acceleration (v^2 x curvature) launches the car off the crest.
      let grade = (y - prevY) / ROAD.ctrlSpacing;
      grade = clamp(grade, this.grade - ROAD.maxGradeChange, this.grade + ROAD.maxGradeChange);
      grade = clamp(grade, -ROAD.maxGrade, ROAD.maxGrade);
      this.grade = grade;
      y = prevY + grade * ROAD.ctrlSpacing;
    }

    this.ctrl.push(new THREE.Vector3(x, y, z));
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
      // alignment is below the natural surface — a cutting, or a tunnel.
      const cover = this.terrain.base(b.p.x, b.p.z) - b.p.y;

      this.frames[i] = { tan, right, up, bank, curv, cover, tunnel: 0 };
      this.framedUpTo = i;
    }

    this._markTunnels();

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
          tunnel: 0,
        };
      }
    }
  }

  /**
   * Promotes sustained deep cuttings into tunnels.
   *
   * This is a MORPHOLOGICAL filter on the cover signal, and it is deliberately
   * stateless: the answer for a sample is a pure function of the cover values
   * within a bounded window around it, so it does not matter when — or how many
   * times — it is computed.
   *
   * The previous version grew runs incrementally and committed one only once it
   * looked "settled" relative to the generation frontier. That made the result
   * depend on the order samples happened to be framed in, and it froze runs
   * mid-mountain: measured, 32 m of road where the rock was 11–14 m deep but no
   * bore had been marked. Outside a bore the cut-and-fill clamp flattens the
   * corridor to road level, so those 32 m became a 15 m vertical cliff straight
   * across the carriageway at the tunnel exit. That is the "roof does not
   * integrate with the terrain" artefact: not a seam, a missing tunnel.
   *
   * Four steps, all standard 1-D morphology:
   *
   *   1. threshold   cover >= tunnelCover
   *   2. CLOSE       dilate then erode by tunnelBridge/2 — merges runs split by
   *                  a shallow spot too short to be worth surfacing for
   *   3. OPEN        erode then dilate by tunnelMinLength/2 — deletes runs too
   *                  short to be worth boring
   *   4. ramp        distance to the nearest non-bore sample, over tunnelPortal
   *
   * Results are only written where they are final — at least `support` samples
   * inside the recomputed window at both ends — and `markedUpTo` records how
   * far that reaches. `ensureLength` waits on it, so no chunk is ever built
   * against a flag that might still change.
   */
  _markTunnels() {
    const f = this.frames;
    if (this.framedUpTo < CURV_WINDOW) return;

    const rad = (metres) => Math.max(1, Math.round(metres / ROAD.sampleStep));
    const bridgeR = rad(ROAD.tunnelBridge * 0.5);
    const minR = rad(ROAD.tunnelMinLength * 0.5);
    const portalR = rad(ROAD.tunnelPortal);
    const support = 2 * bridgeR + 2 * minR + portalR + 4;

    const from = Math.max(CURV_WINDOW, this.framedUpTo - 900);
    const n = this.framedUpTo - from + 1;
    if (n < 2 * support + 2) return;

    let a = new Uint8Array(n);
    if (ROAD.tunnels) {
      for (let k = 0; k < n; k++) {
        const fr = f[from + k];
        a[k] = fr && fr.cover >= ROAD.tunnelCover ? 1 : 0;
      }
    }

    a = erode(dilate(a, bridgeR), bridgeR);   // close short shallow spots
    a = dilate(erode(a, minR), minR);         // open away short runs

    // Distance (in samples) to the nearest sample that is not a bore.
    const dist = new Int32Array(n);
    let run = 0;
    for (let k = 0; k < n; k++) { run = a[k] ? run + 1 : 0; dist[k] = run; }
    run = 0;
    for (let k = n - 1; k >= 0; k--) {
      run = a[k] ? run + 1 : 0;
      if (run < dist[k]) dist[k] = run;
    }

    const lo = from + support;
    const hi = this.framedUpTo - support;
    for (let i = lo; i <= hi; i++) {
      if (!f[i]) continue;
      // dist === 1 is the outermost bore sample, which must read as 0.
      f[i].tunnel = clamp(((dist[i - from] - 1) * ROAD.sampleStep) / ROAD.tunnelPortal, 0, 1);
    }
    if (hi > this.markedUpTo) this.markedUpTo = hi;
  }

  /**
   * Grows the spline until arc length `sTarget` is not merely sampled but
   * has FINAL tunnel flags. Waiting on `length` instead lets a chunk be built
   * against a flag the next pass will change, and a chunk carries its terrain
   * hole and its bore geometry from the moment it is built.
   */
  ensureLength(sTarget) {
    let guard = 0;
    while (this.markedLength < sTarget && guard++ < 4096) {
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
    out.tunnel = lerp(fa.tunnel || 0, fb.tunnel || 0, t);
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
    tunnel: 0,
    s: 0,
  };
}

const _scratchFrame = makeFrame();
const _v = new THREE.Vector3();
