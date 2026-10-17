/**
 * autodrive.js — a virtual driver.
 *
 * It drives through the player's own controls: it writes the wheel and the
 * pedals into `Input` and presses the shift keys (Q/E) itself, with the
 * gearbox put in manual by pressing G. Nothing in the car is bypassed, so the
 * car does exactly what it would do for a person making the same inputs.
 *
 * Calm keeps to the cruising lane, plans gentle braking and short-shifts.
 * Aggressive takes the passing lane, corners near the grip limit and holds
 * each gear to the redline.
 */

import { WORLD, ROAD } from './config.js';
import { makeFrame } from './path.js';
import { clamp, moveTowards } from './util.js';

const MODES = {
  calm: {
    label: 'Calm',
    grip: 0.4,            // share of the cornering limit used
    brakeAccel: 2.4,      // m/s² of braking planned for a corner
    cruise: 95 / 3.6,
    throttleMax: 0.55, throttleRate: 0.7, brakeMax: 0.45, brakeRate: 1.2,
    steerRate: 2.0,       // wheel travel, full lock per second
    look: [6, 0.12],      // heading lookahead, m + s·speed
    lane: 1,              // the cruising lane
    headway: 3.0,         // seconds behind a leader
    laneRate: 0.9,        // m/s across
    upshift: 0.5, lug: 0.26, kickdown: 0.32, revCeiling: 0.62, brakeDown: 0.45, shiftGap: 1.2,
  },
  aggressive: {
    label: 'Aggressive',
    grip: 0.6,
    brakeAccel: 6.5,
    cruise: Infinity,
    throttleMax: 1, throttleRate: 6, brakeMax: 1, brakeRate: 8,
    steerRate: 6,
    look: [5, 0.08],
    lane: 0,              // the passing lane
    headway: 1.1,
    laneRate: 2.6,
    upshift: 0.93, lug: 0.45, kickdown: 0.62, revCeiling: 0.9, brakeDown: 0.85, shiftGap: 0.35,
  },
};

/** Keys and touch buttons that mean the person wants the car back. */
const TAKEOVER_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];

const CAR_HALF_LEN = 2.3;
const CAR_HALF_WID = 1.0;

const _f = makeFrame();

export class AutoDrive {
  constructor() {
    this.on = false;
    this.mode = 'calm';
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.laneV = null;
    this.lane = 1;
    this._think = 0;
    this._shiftWait = 0;
    this._restoreAuto = false;
    this._engaging = false;
    this._input = null;
  }

  get m() {
    return MODES[this.mode];
  }

  /** The bottom-centre switch: engage/disengage and the mode. */
  bind(root = document) {
    const toggle = root.getElementById('ad-toggle');
    const mode = root.getElementById('ad-mode');
    if (!toggle || !mode) return;
    this._el = { toggle, mode };
    const tap = (btn, fn) => btn.addEventListener('click', (e) => {
      fn();
      // A focused button would take the Space bar (handbrake) as a click.
      btn.blur();
      e.preventDefault();
    });
    tap(toggle, () => (this.on ? this.disengage() : this.engage()));
    tap(mode, () => this.setMode(this.mode === 'calm' ? 'aggressive' : 'calm'));
    this._render();
  }

  setMode(mode) {
    this.mode = mode;
    this._render();
  }

  engage() {
    this.on = true;
    this.laneV = null;
    this._engaging = true;
    this._render();
  }

  disengage() {
    if (!this.on) return;
    this.on = false;
    // Hand the gearbox back the way it was found.
    if (this._restoreAuto && this._input) this._input.pressed.add('KeyG');
    this._restoreAuto = false;
    this._render();
  }

  _render() {
    if (!this._el) return;
    this._el.toggle.classList.toggle('on', this.on);
    this._el.toggle.setAttribute('aria-pressed', String(this.on));
    this._el.mode.textContent = this.m.label;
    this._el.mode.classList.toggle('hot', this.mode === 'aggressive');
  }

  _userDriving(input) {
    const t = input.touch;
    return input.held(...TAKEOVER_KEYS) || !!(t.left || t.right || t.throttle || t.brake || t.handbrake);
  }

  /**
   * One frame of driving. Call after `input.update` and before the one-shot
   * keys are handled, so the shift presses land this frame.
   *
   * @param game {input, vehicle, path, carS, powertrain, traffic}
   */
  drive(dt, game) {
    const { input, powertrain } = game;
    this._input = input;
    if (!this.on) return;
    if (this._userDriving(input)) {
      this.disengage();
      return;
    }

    if (this._engaging) {
      this._engaging = false;
      this.steer = input.steer;
      this.throttle = input.throttle;
      this.brake = input.brake;
      this._shiftWait = 0.3;
      if (powertrain.autoShift) {
        // Manual gearbox: the shifts below are this driver's own.
        input.pressed.add('KeyG');
        this._restoreAuto = true;
      }
    }

    const v = game.vehicle;
    const speed = Math.max(0, v.forwardSpeed);
    const lat = game.path.lateralOffset(v.pos, game.carS);

    this._chooseLane(dt, game, speed, lat);
    this._steer(dt, game, speed, lat);
    this._pedals(dt, game, speed, lat);
    this._shift(dt, powertrain, input);

    input.steer = this.steer;
    input.throttle = this.throttle;
    input.brake = this.brake;
    input.handbrake = false;
  }

  // ---------------------------------------------------------------- lanes --

  _lanes(game) {
    return game.traffic ? game.traffic.lanes : [ROAD.laneWidth * 0.5];
  }

  /** Nearest car ahead in the path at offset `laneV`, or null. */
  _leader(game, laneV, lat) {
    const cars = game.traffic && game.traffic.enabled ? game.traffic.cars : [];
    let best = null;
    let bestGap = 240;
    for (const c of cars) {
      if (c.dir !== 1) continue;
      const reach = c.halfWid + CAR_HALF_WID + 0.4;
      if (Math.abs(c.v - laneV) > reach && Math.abs(c.v - lat) > reach) continue;
      const gap = c.s - game.carS - c.halfLen - CAR_HALF_LEN;
      if (gap > -CAR_HALF_LEN && gap < bestGap) {
        bestGap = gap;
        best = c;
      }
    }
    return best ? { car: best, gap: Math.max(0, bestGap) } : null;
  }

  /** Room to move into lane `laneV`: nothing alongside, nothing closing from behind. */
  _laneClear(game, laneV, speed) {
    const ahead = Math.max(30, speed * this.m.headway * 1.3);
    for (const c of game.traffic.cars) {
      if (c.dir !== 1 || Math.abs(c.v - laneV) > c.halfWid + CAR_HALF_WID + 0.6) continue;
      const d = c.s - game.carS;
      const behind = 10 + Math.max(0, c.speed - speed) * 3;
      if (d > -behind && d < ahead) return false;
    }
    return true;
  }

  _chooseLane(dt, game, speed, lat) {
    const lanes = this._lanes(game);
    const m = this.m;
    if (this.laneV === null) {
      // Join whichever lane the car is nearest.
      this.lane = lanes.reduce((b, l, i) => (Math.abs(l - lat) < Math.abs(lanes[b] - lat) ? i : b), 0);
      this.laneV = lat;
    }

    this._think -= dt;
    const settled = Math.abs(this.laneV - lanes[this.lane]) < 0.3;
    if (lanes.length > 1 && settled && this._think <= 0) {
      this._think = 0.5;
      const home = Math.min(m.lane, lanes.length - 1);
      const other = 1 - this.lane;
      const lead = this._leader(game, lanes[this.lane], lanes[this.lane]);
      const blocked = lead && lead.gap < 20 + speed * m.headway + Math.max(0, speed - lead.car.speed) * 4 &&
        lead.car.speed < Math.min(m.cruise, speed + 2) - 1;
      if (blocked && this._laneClear(game, lanes[other], speed)) {
        const there = this._leader(game, lanes[other], lanes[other]);
        if (!there || there.gap > lead.gap + 15) this.lane = other;
      } else if (this.lane !== home && !blocked && this._laneClear(game, lanes[home], speed)) {
        this.lane = home;
      }
    }
    this.laneV = moveTowards(this.laneV, lanes[this.lane], m.laneRate * dt);
  }

  // ------------------------------------------------------------- steering --

  /**
   * Stanley-style lane keeping (as `probe/drive.mjs`): heading to the road
   * ahead, a cross-track term that softens with speed, and the Ackermann
   * angle for the bend as feed-forward.
   */
  _steer(dt, game, speed, lat) {
    const { vehicle: v, path } = game;
    const m = this.m;
    const f = path.frameAt(game.carS + m.look[0] + m.look[1] * speed, _f);
    const cross = v.fwd.x * f.tan.z - v.fwd.z * f.tan.x;
    const headingErr = Math.atan2(-cross, v.fwd.x * f.tan.x + v.fwd.z * f.tan.z);
    // Positive steer is left, toward -v.
    const crossTrack = Math.atan2(2.2 * (lat - this.laneV), speed + 4);
    const ff = v.V.wheelbaseHalf * 2 * path.frameAt(game.carS + 12, _f).curv;
    const lock = Math.max(1e-3, v.steerLimit || v.V.maxSteer);
    const target = clamp((headingErr + crossTrack + ff) / lock, -1, 1);
    this.steer = moveTowards(this.steer, target, m.steerRate * dt);
  }

  // --------------------------------------------------------------- pedals --

  /** The fastest the car may take a bend of curvature `k`, from its grip and downforce. */
  _cornerSpeed(V, k) {
    if (k < 1e-5) return Infinity;
    const g = Math.abs(WORLD.gravity);
    const c = this.m.grip * V.tyreFriction;
    // k·v² = c·(g + D·v²/m), capped by rollover.
    const den = k - (c * V.downforce) / V.mass;
    const vGrip = den > 0 ? Math.sqrt((c * g) / den) : Infinity;
    return Math.min(vGrip, Math.sqrt((V.rolloverAccel * Math.min(1, this.m.grip * 1.5)) / k));
  }

  _targetSpeed(game, speed, lat) {
    const m = this.m;
    const V = game.vehicle.V;
    let target = m.cruise;
    // Every bend within braking reach, each judged by the speed it allows
    // here once the planned braking is subtracted.
    const reach = 30 + (speed * speed) / (2 * m.brakeAccel);
    for (let d = 0; d <= reach; d += 6) {
      const k = Math.abs(game.path.frameAt(game.carS + d, _f).curv);
      const vc = this._cornerSpeed(V, k);
      if (vc === Infinity) continue;
      target = Math.min(target, Math.sqrt(vc * vc + 2 * m.brakeAccel * Math.max(0, d - 8)));
    }

    const lead = this._leader(game, this.laneV, lat);
    if (lead) {
      // Brake to the leader's speed by the time the gap closes to `want`.
      const want = 6 + speed * m.headway;
      const vl = Math.max(0, lead.car.speed);
      const room = lead.gap - want;
      target = Math.min(target, room > 0
        ? Math.sqrt(vl * vl + 1.4 * m.brakeAccel * room)
        : vl * Math.max(0, lead.gap / want));
    }
    return target;
  }

  _pedals(dt, game, speed, lat) {
    const m = this.m;
    const err = this._targetSpeed(game, speed, lat) - speed;
    let th;
    let br;
    if (this.mode === 'aggressive') {
      th = clamp(err / 2, 0, 1);
      br = err < -0.8 ? clamp(-err / 4, 0, 1) : 0;
    } else {
      th = clamp(0.1 + err * 0.06, 0, m.throttleMax);
      br = err < -1.5 ? clamp(-err * 0.06, 0, m.brakeMax) : 0;
    }
    // Running wide of the lane: lift before it becomes a slide.
    const wide = Math.abs(lat - this.laneV);
    if (wide > 2.0) th *= clamp(1 - (wide - 2.0), 0, 1);
    // Never hold the brake hard at a standstill: that selects reverse.
    if (speed < 1.5) br = Math.min(br, 0.4);
    if (br > 0) th = 0;

    this.throttle = moveTowards(this.throttle, Math.min(th, m.throttleMax), m.throttleRate * dt);
    this.brake = moveTowards(this.brake, Math.min(br, m.brakeMax), m.brakeRate * dt);
  }

  // ------------------------------------------------------------- gearbox --

  /**
   * Reads the revs each gear would give at this road speed and presses E or
   * Q. Calm short-shifts and only drops a gear when the engine labours;
   * aggressive holds to the redline and drops gears on the brakes.
   */
  _shift(dt, powertrain, input) {
    this._shiftWait = Math.max(0, this._shiftWait - dt);
    const p = powertrain.sim && powertrain.sim.physics;
    if (!p || p.shifting || this._shiftWait > 0 || powertrain.reverse || powertrain.autoShift || p.gear < 1) return;
    const m = this.m;
    const red = powertrain.maxRpm;
    const g = p.gear;
    const now = p.gearedRpm(g) / red;
    const up = g < p.gearCount ? p.gearedRpm(g + 1) / red : 0;
    const down = g > 1 ? p.gearedRpm(g - 1) / red : Infinity;

    let key = null;
    if (g < p.gearCount && (now > m.upshift || powertrain.limiter) && this.brake < 0.05 && up > m.lug + 0.04) {
      key = 'KeyE';
    } else if (down < m.revCeiling && (
      now < m.lug ||
      (this.throttle > m.throttleMax * 0.9 && now < m.kickdown) ||
      (this.brake > 0.15 && down < m.brakeDown))) {
      key = 'KeyQ';
    }
    if (key) {
      input.pressed.add(key);
      this._shiftWait = m.shiftGap;
    }
  }
}
