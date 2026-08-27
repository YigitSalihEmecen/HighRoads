/**
 * path.js — the infinite road spline.
 *
 * Control points come from a noise-driven heading integrator, interpolated
 * by Catmull-Rom. Catmull-Rom is local, so the spline extends forever without
 * a rebuild. An arc-length table carries a Frenet-style frame and banking.
 */

import * as THREE from 'three';
import { ROAD, ROUTE } from './config.js';
import { clamp, lerp } from './util.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Samples per control-point segment. ~2.5 m each at 46 m spacing. */
const SAMPLES_PER_SEGMENT = Math.max(2, Math.round(ROAD.ctrlSpacing / ROAD.sampleStep));

// CURV wants the tightest honest estimate; FOLD wants the longest: the fold
// guard only cares how tight the best nearby corner is.
const CURV_WINDOW = 4;
const FOLD_WINDOW = 10;

/** Half-width of the average before the running maximum, in road samples. */
const FOLD_SMOOTH = ROUTE.foldSmooth;

/** Half-width, in road samples, of the average that builds the relaxed heading. */
const RELAX_SMOOTH = Math.max(1, Math.round(ROUTE.relaxWindow / (2 * ROAD.sampleStep)));

export class RoadPath {
  constructor(terrain, seed) {
    this.terrain = terrain;
    this.seed = seed;

    /** Control points (world space). */
    this.ctrl = [];
    /** Densely sampled positions with cumulative arc length. */
    this.pts = [];
    /** Per-sample orientation frames; lags `pts` by FOLD_WINDOW. */
    this.frames = [];

    this.framedUpTo = -1;
    /** Current tangent heading, radians, 0 = -Z. */
    this.heading = 0;
    /** The slowly drifting compass the router is trying to follow. */
    this.bearing = 0;
    this.lastTurn = 0;
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

  /** Route personality at a point, blended from two slow noise fields. */
  _character(s) {
    const t = this.terrain;
    const f = ROUTE.characterScale;
    // One field says how hard to avoid moving earth, the other whether to
    // prefer height or depth.
    const direct = t.nA(s / f, 41.7);        // -1..1
    const seek = t.nB(s / f + 5.3, 88.1);    // -1..1

    return {
      // 1 at its most careful, (1 - directness) at its most bloody-minded.
      earth: ROUTE.wEarthwork * (1 - ROUTE.directness * Math.max(0, direct)),
      // > 0 seeks high ground, < 0 seeks low ground.
      seek: ROUTE.wSeek * seek,
      // Always some appetite for a hillside, more on half the cycle.
      shelf: ROUTE.wShelf * (0.55 + 0.45 * Math.max(0, -direct)),
    };
  }

  /** Doubles-back penalty at (x, z): 0 when clear, 1 at zero separation. */
  _selfProximity(x, z) {
    const spacing = ROAD.ctrlSpacing;
    const n = this.ctrl.length;
    // Control points are evenly spaced in ARC LENGTH, so the band is an index
    // range and no distances have to be accumulated.
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

  /**
   * Road segments of a DIFFERENT pass of the road than station `s`, within
   * `range` of (x, z). Pairs are appended to `out` as [a, b, a, b, ...]; the
   * return value is the count of pairs.
   */
  /**
   * Distance from (x, z) to the nearest carriageway of ANY pass, and the road's
   * height there. Writes `{dist, y}` into `out`; `dist` is Infinity when out of
   * range. Distance is to the POLYLINE, not the control points — at 46 m
   * spacing a point on the carriageway can be 23 m from the nearest of them.
   */
  roadNear(x, z, sHint, range, out = { dist: Infinity, y: 0 }) {
    const spacing = ROAD.ctrlSpacing;
    const span = Math.ceil((range + ROUTE.selfFar) / spacing);
    const iHint = sHint / spacing;
    const lo = Math.max(0, Math.floor(iHint - span));
    const hi = Math.min(this.ctrl.length - 2, Math.ceil(iHint + span));
    let best = Infinity;
    let bestY = 0;
    for (let i = lo; i <= hi; i++) {
      const a = this.ctrl[i];
      const b = this.ctrl[i + 1];
      const ex = b.x - a.x, ez = b.z - a.z;
      const len2 = ex * ex + ez * ez;
      let t = len2 > 1e-9 ? ((x - a.x) * ex + (z - a.z) * ez) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (a.x + ex * t);
      const dz = z - (a.z + ez * t);
      const d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; bestY = a.y + (b.y - a.y) * t; }
    }
    out.dist = best === Infinity ? Infinity : Math.sqrt(best);
    out.y = bestY;
    return out;
  }

  foreignSegments(s, x, z, range, out) {
    const spacing = ROAD.ctrlSpacing;
    const iSelf = s / spacing;
    const near = (ROUTE.selfNear + 120) / spacing;
    const far = ROUTE.selfFar / spacing;
    const r2 = range * range;
    const lo = Math.max(0, Math.floor(iSelf - far));
    const hi = Math.min(this.ctrl.length - 2, Math.ceil(iSelf + far));
    let n = 0;
    for (let i = lo; i <= hi; i++) {
      // Both ends have to be foreign, or a segment straddling the band edge
      // would reach back onto the road being driven.
      if (Math.abs(i - iSelf) < near || Math.abs(i + 1 - iSelf) < near) continue;      const a = this.ctrl[i];
      const b = this.ctrl[i + 1];
      const dax = a.x - x, daz = a.z - z;
      const dbx = b.x - x, dbz = b.z - z;
      if (dax * dax + daz * daz > r2 && dbx * dbx + dbz * dbz > r2) continue;
      out[n * 2] = a;
      out[n * 2 + 1] = b;
      n++;
    }
    return n;
  }

  /** Natural ground the router routes over. Coarser than the mesh. */
  _ground(x, z) {
    return this.terrain.height(x, z, ROUTE.lod);
  }

  /** Cost of a span: lower is better, metres-ish. Only the ORDER matters here. */
  _spanCost(prev, x, y, z, heading, turn, grade, ch) {
    const spacing = ROAD.ctrlSpacing;

    // ---- earthwork ------------------------------------------------------
    // Mean |natural − road| over stations and probes. Contours the road.
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
    // Ground either side at the end of the span, at two distances: a shelf is
    // local, a valley is not, and one probe cannot see both.
    const D = ROUTE.corridor;
    const gl = this._ground(x - right.x * D, z - right.z * D) - y;
    const gr = this._ground(x + right.x * D, z + right.z * D) - y;
    const fl = this._ground(x - right.x * D * 2.4, z - right.z * D * 2.4) - y;
    const fr = this._ground(x + right.x * D * 2.4, z + right.z * D * 2.4) - y;

    // Height sought relative to the country around, so `seek` means ridge or
    // valley rather than merely high or low.
    const stand = -(fl + fr) * 0.5;

    /**
     * A genuine shelf: one side up AND the other down. Zero for a ridge top
     * (both fall) and for a valley floor (both rise).
     */
    const shelf = Math.max(
      Math.min(Math.max(0, gl), Math.max(0, -gr)),
      Math.min(Math.max(0, gr), Math.max(0, -gl))
    );

    // How much vertical range there is out here at all. A plain scores zero.
    const relief = Math.max(gl, gr, fl, fr, 0) - Math.min(gl, gr, fl, fr, 0);

    // ---- the engineering ------------------------------------------------
    const gradeN = Math.abs(grade) / ROAD.maxGrade;
    const turnN = Math.abs(turn) / this.maxTurn;
    const turnDelta = Math.abs(turn - this.lastTurn) / this.maxTurn;

    // Deviation from the intended bearing. `1 - cos` so small corrections are
    // free and it grows hard past a right angle.
    const off = 1 - Math.cos(heading - this.bearing);

    // Coming back alongside road already laid. Squared, so the penalty is
    // negligible at the edge of the exclusion and overwhelming inside it.
    const self = this._selfProximity(x, z);

    // Earthwork is free up to the budget and quadratic past it.
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
   * Every candidate is legal by construction — turn bounded by `maxCurvature`,
   * elevation clamped to `maxGrade` / `maxGradeChange` before scoring — so the
   * router only ever picks among roads that could be built.
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
    // gets there.
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
      // — the balanced cut-and-fill line — then clamp to a legal profile.
      const want = this._ground(x, z) + ROUTE.rideHeight;
      let grade = (want - prev.y) / spacing;
      grade = clamp(grade, this.grade - ROAD.maxGradeChange, this.grade + ROAD.maxGradeChange);
      grade = clamp(grade, -ROAD.maxGrade, ROAD.maxGrade);
      const y = prev.y + grade * spacing;

      const cost = this._spanCost(prev, x, y, z, heading, turn, grade, ch);
      // Straight on is the incumbent and has to be beaten by a margin, or the
      // argmin flickers and the road develops a tremor.
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
    const first = this.pts.length === 0;    for (let k = first ? 0 : 1; k <= SAMPLES_PER_SEGMENT; k++) {
      const t = 1 / 3 + (k / SAMPLES_PER_SEGMENT) / 3;
      const p = curve.getPoint(t, new THREE.Vector3());
      const prev = this.pts[this.pts.length - 1];
      const s = prev ? prev.s + p.distanceTo(prev.p) : 0;
      this.pts.push({ p, s });
    }

    this.nextSegment++;
  }

  /**
   * Builds orientation frames for every sample that now has FOLD_WINDOW
   * neighbours on both sides.
   */
  _buildFrames() {
    const last = this.pts.length - 1 - FOLD_WINDOW;

    const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _x = new THREE.Vector3();
    /** Signed curvature at sample `i` over a +/-`w` window. See the constants. */
    const curvatureAt = (i, w) => {
      const a = this.pts[i - w];
      const b = this.pts[i];
      const c = this.pts[i + w];
      _t1.subVectors(b.p, a.p).normalize();
      _t2.subVectors(c.p, b.p).normalize();
      _x.crossVectors(_t1, _t2);
      // Only the vertical component matters: banking responds to yaw rate, not
      // to the pitch change from climbing a hill.
      return Math.asin(clamp(_x.y, -1, 1)) / Math.max(1e-3, c.s - a.s);
    };

    for (let i = Math.max(this.framedUpTo + 1, FOLD_WINDOW); i <= last; i++) {
      const a = this.pts[i - CURV_WINDOW];
      const c = this.pts[i + CURV_WINDOW];

      const tan = new THREE.Vector3().subVectors(c.p, a.p).normalize();
      const curv = curvatureAt(i, CURV_WINDOW);

    // right = tangent x up  (with forward = -Z, that resolves to +X).
    const right = new THREE.Vector3().crossVectors(tan, WORLD_UP).normalize();

    // Bank into the corner: rotating `right` by -bank about the tangent lifts
    // the outside edge of the turn.
    const bank = clamp(curv * ROAD.bankGain, -ROAD.maxBank, ROAD.maxBank);
    right.applyAxisAngle(tan, -bank).normalize();

    const up = new THREE.Vector3().crossVectors(right, tan).normalize();

    // How much ground sits over the centreline here. Positive means the
    // alignment is below the natural surface — a cutting.
    const here = this.pts[i];
      const cover = this.terrain.base(here.p.x, here.p.z) - here.p.y;

      this.frames[i] = {
        tan, right, up, bank, curv,
        foldL: 0, foldR: 0,
        relaxDev: 0, relaxL: 0, relaxR: 0,
        cover,
      };
      this.framedUpTo = i;
    }

    // The leading samples never get a symmetric window; mirror the first real
    // frame back onto them so s = 0 is addressable.
    if (this.framedUpTo >= FOLD_WINDOW && !this.frames[0]) {
      for (let i = 0; i < FOLD_WINDOW; i++) {
        const f = this.frames[FOLD_WINDOW];
        this.frames[i] = {
          tan: f.tan.clone(),
          right: f.right.clone(),
          up: f.up.clone(),
          bank: f.bank,
          curv: f.curv,
          foldL: f.foldL,
          foldR: f.foldR,
          relaxDev: f.relaxDev || 0,
          relaxL: f.relaxL || 0,
          relaxR: f.relaxR || 0,
          cover: f.cover,
        };
      }
    }

    this._buildFoldLimits();
  }

  /**
   * Per-frame curvature limits for the terrain's fold guard, one per side.
   *
   * Built from the ACTUAL frame-to-frame rotation, not `curv`: `curv` is a
   * smoothed +/-10 m average, smaller than the pointwise rate the fold guard
   * enforces, so feeding it relaxes the very limit it exists to enforce. The
   * guard's 0.7 margin then means a quad can lose at most 70% of its depth.
   *
   * A running MAXIMUM over a window, split by sign — only the inside of a bend
   * folds, the outside spreads — so each side is protected against the tightest
   * nearby turn while a straight, or the outside of a bend, is left alone.
   */
  _buildFoldLimits() {
    const frames = this.frames;
    const pts = this.pts;
    const last = this.framedUpTo;
    if (last < 1) return;

    // Turn ANGLE across each step, signed, and the arc length it took. Positive
    // turns left, which compresses negative `v` — the same convention `curv`
    // uses. Kept as an angle so the smoothing below can just sum them.
    if (!this._rowTurn) { this._rowTurn = []; this._rowDs = []; }
    const turn = this._rowTurn;
    const step = this._rowDs;
    const cross = _foldCross;
    for (let i = Math.max(0, turn.length - 1); i < last; i++) {
      const a = frames[i];
      const b = frames[i + 1];
      if (!a || !b) { turn[i] = 0; step[i] = 1; continue; }
      cross.crossVectors(a.tan, b.tan);
      turn[i] = Math.asin(clamp(cross.y, -1, 1));
      step[i] = Math.max(1e-3, pts[i + 1].s - pts[i].s);
    }
    turn.length = last;
    step.length = last;

    // Prefix sums, so the windowed rate below is two subtractions rather than a
    // second nested loop over `FOLD_SMOOTH`.
    if (!this._turnSum) { this._turnSum = [0]; this._dsSum = [0]; }
    const turnSum = this._turnSum;
    const dsSum = this._dsSum;
    for (let i = turnSum.length - 1; i < last; i++) {
      turnSum[i + 1] = turnSum[i] + turn[i];
      dsSum[i + 1] = dsSum[i] + step[i];
    }
    turnSum.length = last + 1;
    dsSum.length = last + 1;

    /**
     * Turn rate at step `i`, averaged over `ROUTE.foldSmooth` steps either side.
     * The single-step difference it replaces reached twice the design curvature
     * on roughness alone.
     */
    const rateAt = (i) => {
      const lo = Math.max(0, i - FOLD_SMOOTH);
      const hi = Math.min(last, i + FOLD_SMOOTH + 1);
      const ds = dsSum[hi] - dsSum[lo];
      return ds > 1e-6 ? (turnSum[hi] - turnSum[lo]) / ds : 0;
    };

    // Running maximum either side, capped. Recomputed from `foldFrom` so that
    // extending the road revisits the frames whose window now reaches further.
    const from = Math.max(0, (this.foldFrom || 0) - FOLD_WINDOW - FOLD_SMOOTH);
    for (let i = from; i <= last; i++) {
      let l = 0;
      let r = 0;
      const lo = Math.max(0, i - FOLD_WINDOW);
      const hi = Math.min(turn.length - 1, i + FOLD_WINDOW);
      for (let j = lo; j <= hi; j++) {
        const k = rateAt(j);
        if (k > l) l = k;
        else if (-k > r) r = -k;
      }
      const f = frames[i];
      if (f) { f.foldL = l; f.foldR = r; }
    }

    this._buildRelaxed(from, last);
    this.foldFrom = last;
  }

  /**
   * The RELAXED heading field, and the curvature limits that go with it.
   *
   * The fold guard bounds `v * kappa` and only ever had `v` to squeeze, so hard
   * corners ended the sheet ~94 m out. `kappa` is not fixed: it is the rate the
   * LATERAL direction turns, and that direction is a choice. Near the road it
   * stays `right` (earthwork must be square to it); far out it rotates toward a
   * heading that turns slowly, so the effective curvature falls.
   *
   * `relaxDev` is an ANGLE (`theta~ - theta`), not a vector: rotating by
   * `b * relaxDev` makes the effective curvature exactly
   * `(1-b)*kappa + b*kappa~`, which a vector lerp only approximates.
   * `relaxL`/`relaxR` bound how far that direction carries the sheet.
   */
  _buildRelaxed(from, last) {
    const frames = this.frames;
    const turnSum = this._turnSum;

    // Prefix sum OF the prefix sum, so a windowed mean of `turnSum` — which is
    // the heading, up to the constant this all cancels — is O(1) per sample.
    if (!this._turnSum2) this._turnSum2 = [0];
    const sum2 = this._turnSum2;
    for (let i = sum2.length - 1; i <= last; i++) sum2[i + 1] = sum2[i] + turnSum[i];
    sum2.length = last + 2;

    /** Heading at `i` minus the windowed mean heading — the relax angle. */
    const devAt = (i) => {
      const lo = Math.max(0, i - RELAX_SMOOTH);
      const hi = Math.min(last, i + RELAX_SMOOTH);
      const n = hi - lo + 1;
      return (sum2[hi + 1] - sum2[lo]) / n - turnSum[i];
    };

    const lo0 = Math.max(0, from - RELAX_SMOOTH);
    if (!this._relaxDev) this._relaxDev = [];
    const dev = this._relaxDev;
    for (let i = lo0; i <= last; i++) dev[i] = devAt(i);
    dev.length = last + 1;

    // NEGATED on the way out: `turn[i]` is `asin(cross(tan_i, tan_{i+1}).y)`,
    // which with forward = -Z is `theta_i - theta_{i+1}`, so `turnSum`
    // accumulates MINUS the heading. lateralAt needs the other sign to advance
    // a heading BY.
    for (let i = lo0; i <= last; i++) {
      if (frames[i]) frames[i].relaxDev = -dev[i];
    }

    // Turn rate of the relaxed heading, under the same signed running maximum.
    for (let i = lo0; i <= last; i++) {
      let l = 0;
      let r = 0;
      const a = Math.max(0, i - FOLD_WINDOW);
      const b = Math.min(last - 1, i + FOLD_WINDOW);
      for (let j = a; j <= b; j++) {
        const ds = Math.max(1e-3, this.pts[j + 1].s - this.pts[j].s);
        // d(theta~)/ds = d(theta)/ds + d(dev)/ds, and the first term is `turn`.
        const k = (turnSum[j + 1] - turnSum[j] + (dev[j + 1] - dev[j])) / ds;
        if (k > l) l = k;
        else if (-k > r) r = -k;
      }
      const f = frames[i];
      if (f) { f.relaxL = l; f.relaxR = r; }
    }
  }

  /**
   * How far the terrain sheet reaches either side at arc length `s`, metres.
   * The inverse of the fold guard.
   *
   * @returns {{left: number, right: number}} distances from the centreline
   */
  corridorAt(s, out = { left: 0, right: 0 }) {
    const f = this.frameAt(s, _reachFrame);
    // The RELAXED limits, not the road's own: `lateralAt` turns the lateral
    // direction toward the relaxed heading as the offset grows, so what bounds
    // the sheet is how hard THAT turns.
    out.left = f.relaxL > 1e-7 ? ROUTE.foldMargin / f.relaxL : Infinity;
    out.right = f.relaxR > 1e-7 ? ROUTE.foldMargin / f.relaxR : Infinity;
    return out;
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
    out.foldL = lerp(fa.foldL, fb.foldL, t);
    out.foldR = lerp(fa.foldR, fb.foldR, t);
    out.relaxDev = lerp(fa.relaxDev || 0, fb.relaxDev || 0, t);
    out.relaxL = lerp(fa.relaxL || 0, fb.relaxL || 0, t);
    out.relaxR = lerp(fa.relaxR || 0, fb.relaxR || 0, t);
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
   * Projects a world position onto the spline, returning arc length. Searches
   * a window around `sHint`, so this stays O(window) no matter how long the
   * road gets.
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
function window1d(src, r, wantAll) {  const n = src.length;
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
    foldL: 0,
    foldR: 0,
    /** Relaxed heading offset (radians) and its curvature limits; see _buildRelaxed. */
    relaxDev: 0,
    relaxL: 0,
    relaxR: 0,
    cover: 0,
    s: 0,
  };
}

/** Scratch for `_buildFoldLimits`, which runs once per sample per extension. */
const _foldCross = new THREE.Vector3();
const _reachFrame = makeFrame();

const _scratchFrame = makeFrame();
const _v = new THREE.Vector3();
