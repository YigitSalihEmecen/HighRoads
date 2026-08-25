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

/**
 * Half-widths, in samples, of the two symmetric windows the frames are built
 * from. At ROAD.sampleStep = 2.5 m these are +/-10 m and +/-25 m.
 *
 * ORIENTATION and CURVATURE want the tightest honest estimate: the ribbon's
 * lateral direction is measured against `tan`, and smoothing that skews the
 * carriageway on a bend; banking is `curv * bankGain`, and a banking that lags
 * the corner is worse than no banking at all — measured, widening this window
 * alone took one seed's worst lane error from 5.8 m to 16.8 m, because through
 * an S-bend the smoothed curvature still says "left" while the road has already
 * gone right, and the cross-slope then throws the car off the outside.
 *
 * THE FOLD WINDOW is the exception, and it is a different question. The terrain
 * fold guard does not care where the corner is, only how tight the tightest
 * thing nearby is — see `chunks.js:foldSafeOffset`. A short-window curvature
 * estimate is a second derivative of a spline through 46 m control points, so
 * it carries the spline's own roughness: measured, it swung 38% in a single
 * 2.5 m step, the road going from a 963 m radius to a 697 m one and back, which
 * is not a thing that happens to a road. The guard turns that into tens of
 * metres of lateral shear between adjacent rows 700 m out, which is a torn
 * sheet. Fifty metres of window removes it, and a guard lagging a corner by
 * 25 m costs nothing at all.
 *
 * The estimate stays exact for a circular arc at any width — the angle between
 * two successive chord directions IS the total turn across them — so widening
 * costs no peak curvature, only the sharpness of the transitions.
 */
const CURV_WINDOW = 4;
const FOLD_WINDOW = 10;

/**
 * Half-width of the average taken BEFORE the running maximum, in road samples.
 * See `ROUTE.foldSmooth` for why it exists, what it is worth, and why it is not
 * larger (bug #64).
 */
const FOLD_SMOOTH = ROUTE.foldSmooth;

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

  /**
   * Road SEGMENTS belonging to a different pass of the road than station `s`,
   * within `range` of (x, z). Consecutive control-point pairs are appended to
   * `out` as [a, b, a, b, ...]; the return value is the number of pairs.
   *
   * This is the query behind the terrain's foreign-road clamp (see
   * `chunks.js:sampleGround`). Control points are evenly spaced in ARC LENGTH,
   * so "a different pass of the road" is an index band and no distances have to
   * be accumulated to find it — the same trick `_selfProximity` uses.
   *
   * SEGMENTS, not points, and the difference is the whole thing working. The
   * control points are 46 m apart, so a place standing directly on the foreign
   * carriageway can still be 23 m from the nearest of them — and the cut ramp
   * the clamp uses rises at 62%, so 23 m of error is 2.7 m of terrain left
   * standing over the road. Measured: exactly the 2.6 m step this was written
   * to remove. Distance to the polyline is the quantity that was always meant.
   *
   * The exclusion band is deliberately WIDER than `ROUTE.selfNear`. The index
   * is only an estimate of arc length (the spline is a little longer than the
   * chord through its control points), and the failure mode of excluding too
   * much is that a genuinely separate carriageway 300 m along the road does not
   * get carved for — invisible. The failure mode of excluding too little is
   * cutting a trench across the road you are driving on.
   */
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
      if (Math.abs(i - iSelf) < near || Math.abs(i + 1 - iSelf) < near) continue;
      const a = this.ctrl[i];
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
   * Builds orientation frames for every sample that now has FOLD_WINDOW
   * neighbours on both sides, so curvature can be measured symmetrically.
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

      this.frames[i] = { tan, right, up, bank, curv, foldL: 0, foldR: 0, cover };
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
          cover: f.cover,
        };
      }
    }

    this._buildFoldLimits();
  }

  /**
   * Per-frame curvature limits for the terrain's fold guard, one per side.
   *
   * ── why this is not just `curv` ────────────────────────────────────────────
   *
   * The guard in `chunks.js:foldSafeOffset` exists to stop the terrain sheet
   * turning inside out. Rows of vertices fan out perpendicular to the road, so
   * the longitudinal spacing at lateral offset `v` is `ds * (1 + v * kappa)` and
   * the mesh folds when that reaches zero. `kappa` in that expression is the
   * rate at which THIS ROW'S FRAME rotates into the NEXT ROW'S — nothing else.
   *
   * `curv` is not that number. It is the turn measured over +/-10 m, which is
   * the right estimate for banking and for a corner-speed model and is a
   * SMOOTHED one: where the spline turns sharply over a few metres, the average
   * over twenty is smaller. Feeding it to the guard therefore relaxes exactly
   * the limit the guard exists to enforce, and measured across five seeds the
   * far corridor was folding through itself in 1,240 to 4,353 cells per seed —
   * with the worst row spacing at MINUS 54% of nominal, which is a sheet turned
   * inside out, drawn back-to-front, with garbage normals. It has been doing
   * that since the guard was written.
   *
   * So the limit is built from the actual frame-to-frame rotation, and the
   * guard's 0.7 margin then means what it says: no vertex can pass 70% of the
   * way to the centre of rotation, so no quad can lose more than 70% of its
   * depth, so nothing folds. By construction rather than by estimate.
   *
   * ── why a window, and why two of them ──────────────────────────────────────
   *
   * The frame-to-frame rate is the NOISIEST estimate there is — a second
   * difference of a spline through 46 m control points — and the guard's output
   * is a lateral position hundreds of metres out, so noise in it becomes tens of
   * metres of shear between adjacent rows. A tear, instead of a fold.
   *
   * A running MAXIMUM over a window fixes both at once. It is conservative, so
   * every row in the window is protected against the tightest turn near it; and
   * the maximum of a continuous function over a sliding window is itself
   * continuous, and holds its value across the window's width, so the spikes
   * that caused the shear become plateaux.
   *
   * Two of them because the guard is ONE-SIDED and must stay that way. Only the
   * inside of a bend folds; the outside spreads out. Compressing both sides
   * would mean the world visibly ending 115 m away on the outside of a hairpin.
   * Splitting the running maximum by sign — left turns bound the left side,
   * right turns the right — keeps each side protected against every turn in the
   * window while leaving a straight, or the outside of a bend, completely
   * alone. A stretch that reverses within the window has both limits set, which
   * is correct: within that window, both sides really do fold.
   */
  _buildFoldLimits() {
    const frames = this.frames;
    const pts = this.pts;
    const last = this.framedUpTo;
    if (last < 1) return;

    // Turn ANGLE across each step, signed, and the arc length it took. Positive
    // turns left, which compresses negative `v` — the same convention `curv`
    // uses. Kept as an angle rather than as a rate so the smoothing below can
    // sum them: the total turn across a window is the sum of its steps' turns,
    // exactly, for any shape.
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
     *
     * The single-step difference this replaces was reaching twice the design
     * curvature on roughness alone, and the guard turned that straight into a
     * terrain sheet that stopped 57 m from the road — bug #64. See
     * `ROUTE.foldSmooth`.
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
    this.foldFrom = last;
  }

  /**
   * How far the terrain sheet reaches either side at arc length `s`, metres.
   *
   * The inverse of the fold guard, and the honest answer to "where does the
   * world end here" — which is a question with a different answer every few
   * metres, and one that nothing used to ask. `CHUNK.recoverLateral` assumed a
   * flat 300 m; measured across five seeds the sheet delivers anything from
   * 73 m to `CHUNK.halfExtent`, depending on how hard the road is turning.
   *
   * @returns {{left: number, right: number}} distances from the centreline
   */
  corridorAt(s, out = { left: 0, right: 0 }) {
    const f = this.frameAt(s, _reachFrame);
    out.left = f.foldL > 1e-7 ? ROUTE.foldMargin / f.foldL : Infinity;
    out.right = f.foldR > 1e-7 ? ROUTE.foldMargin / f.foldR : Infinity;
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
    foldL: 0,
    foldR: 0,
    cover: 0,
    s: 0,
  };
}

/** Scratch for `_buildFoldLimits`, which runs once per sample per extension. */
const _foldCross = new THREE.Vector3();
const _reachFrame = makeFrame();

const _scratchFrame = makeFrame();
const _v = new THREE.Vector3();
