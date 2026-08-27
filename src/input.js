/**
 * input.js — keyboard, gamepad, touch and tilt as one input state.
 *
 * Keys ramp instead of switching hard. An analogue source — gamepad stick or
 * tilt — overrides the ramped value rather than mixing with it.
 */

import { clamp, moveTowards } from './util.js';

const KEY_RISE = 4.2;
const KEY_FALL = 6.5;

/** Full lock at 10°, 2° dead band — the wider centre so wrist wobble does not steer. */
const TILT_RANGE = 10;
const TILT_DEAD = 2.0;
/** x·|x|^(k−1) curve at 1.6: flattens the centre and still reaches full lock at the ends. */
const TILT_EXPO = 1.6;
/** A sample older than this is stale: the sensor stopped, so let go of the car. */
const TILT_TIMEOUT = 0.5;
const STORE_KEY = 'highroads.tilt';
const INVERT_KEY = 'highroads.tiltInvert';

/** Own object: it owns a listener, a permission state and a calibration. */
export class TiltSteering {
  constructor() {
    this.on = false;
    this.value = 0;
    this.zero = null;
    /** Seconds since the last event, so a dead sensor releases the wheel. */
    this.age = TILT_TIMEOUT;
    this._raw = 0;
    this._onOrient = (e) => this._read(e);
  }

  /** True where the API exists at all. False on a desktop, and in Node. */
  static get supported() {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  static get needsPermission() {
    return TiltSteering.supported &&
      typeof DeviceOrientationEvent.requestPermission === 'function';
  }

  static get remembered() {
    try {
      const v = localStorage.getItem(STORE_KEY);
      return v === null ? null : v === '1';
    } catch (err) {
      return null;
    }
  }

  static remember(on) {
    try { localStorage.setItem(STORE_KEY, on ? '1' : '0'); } catch (err) {}
  }

  /** Devices disagree on which physical rotation gamma/beta describe — a manual escape hatch. */
  static get inverted() {
    try {
      return localStorage.getItem(INVERT_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  static setInverted(on) {
    try { localStorage.setItem(INVERT_KEY, on ? '1' : '0'); } catch (err) {}
  }

  /** iOS needs permission from a user gesture; resolves false rather than throwing when the browser declines. */
  async enable() {
    if (!TiltSteering.supported) return false;
    if (TiltSteering.needsPermission) {
      try {
        if (await DeviceOrientationEvent.requestPermission() !== 'granted') return false;
      } catch (err) {
        return false;
      }
    }
    if (!this.on) {
      window.addEventListener('deviceorientation', this._onOrient);
      this.on = true;
    }
    // Zero on the next sample — none exists yet, and a stale zero is worse than none.
    this.zero = null;
    this.age = TILT_TIMEOUT;
    this.value = 0;
    return true;
  }

  disable() {
    if (this.on) window.removeEventListener('deviceorientation', this._onOrient);
    this.on = false;
    this.value = 0;
    this.zero = null;
  }

  recentre() {
    this.zero = null;
  }

  /** gamma/beta and which one "steers" swap with device rotation; screen.orientation.angle picks. */
  _read(e) {
    if (e.gamma === null && e.beta === null) return;
    const angle = (typeof screen !== 'undefined' && screen.orientation &&
      typeof screen.orientation.angle === 'number') ? screen.orientation.angle : 0;
    const beta = e.beta || 0;
    const gamma = e.gamma || 0;
    let axis;
    // Landscape signs keyed to screen.orientation.angle; iOS 17+ had them mirrored (tip left sent the car right).
    if (angle === 90) axis = beta;
    else if (angle === 270 || angle === -90) axis = -beta;
    else if (angle === 180) axis = -gamma;
    else axis = gamma;

    if (this.zero === null) this.zero = axis;
    this._raw = axis;
    this.age = 0;
  }

  update(dt) {
    if (!this.on) { this.value = 0; return; }
    this.age += dt;
    if (this.age > TILT_TIMEOUT || this.zero === null) { this.value = 0; return; }

    // Wrap into -180..180 before subtracting, so a zero captured near the wrap
    // does not send the wheel hard over.
    let d = this._raw - this.zero;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;

    const mag = Math.abs(d);
    if (mag <= TILT_DEAD) { this.value = 0; return; }
    const t = Math.min(1, (mag - TILT_DEAD) / (TILT_RANGE - TILT_DEAD));
    // Positive `steer` is LEFT (see Input), and tipping the device left is a
    // negative roll, so the sign flips here and nowhere else.
    this.value = -Math.sign(d) * Math.pow(t, TILT_EXPO) * (TiltSteering.inverted ? -1 : 1);
  }
}

export class Input {
  constructor(target = window) {
    /** Steering: +1 is left, matching a rotation about +Y. */
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = false;

    this.keys = new Set();
    this.pressed = new Set();

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      const code = e.code;
      this.keys.add(code);
      this.pressed.add(code);
      if (code.startsWith('Arrow') || code === 'Space') e.preventDefault();
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => {
      this.keys.clear();
      this.handbrake = false;
    };

    this.touch = { left: 0, right: 0, throttle: 0, brake: 0, handbrake: 0, flash: 0 };

    this.tilt = new TiltSteering();

    target.addEventListener('keydown', this._onKeyDown, { passive: false });
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
  }

  get flashHeld() {
    return this.held('KeyF') || !!this.touch.flash;
  }

  /** Buttons are hold or tap; pointer capture means a finger sliding off still releases it. */
  bindTouch(root = document) {
    const isTouch =
      typeof window !== 'undefined' &&
      ('ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0 || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches));
    if (!isTouch) return false;
    document.body.classList.add('touch');

    if (this._touchBound) return true;
    const host = root.getElementById ? root.getElementById('touch') : null;
    if (!host) return false;
    this._touchBound = true;

    for (const btn of host.querySelectorAll('.tbtn')) {
      const hold = btn.dataset.hold;
      const tap = btn.dataset.tap;

      const down = (e) => {
        e.preventDefault();
        try {
          if (btn.setPointerCapture && e.pointerId != null) {
            btn.setPointerCapture(e.pointerId);
          }
        } catch (_) {}
        btn.classList.add('on');
        if (hold) this.touch[hold] = 1;
        if (tap) this.pressed.add(tap);
      };
      const up = (e) => {
        e.preventDefault();
        try {
          if (btn.releasePointerCapture && e.pointerId != null && btn.hasPointerCapture && btn.hasPointerCapture(e.pointerId)) {
            btn.releasePointerCapture(e.pointerId);
          }
        } catch (_) {}
        btn.classList.remove('on');
        if (hold) this.touch[hold] = 0;
      };

      btn.addEventListener('pointerdown', down, { passive: false });
      btn.addEventListener('pointerup', up, { passive: false });
      btn.addEventListener('pointercancel', up, { passive: false });
      btn.addEventListener('lostpointercapture', up, { passive: false });
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    return true;
  }

  /** Cleared at the end of the frame — clearing inside update() threw every press away. */
  endFrame() {
    this.pressed.clear();
  }

  consume(code) {
    if (this.pressed.has(code)) {
      this.pressed.delete(code);
      return true;
    }
    return false;
  }

  held(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  update(dt) {
    const t = this.touch;
    const left = this.held('KeyA', 'ArrowLeft') || t.left ? 1 : 0;
    const right = this.held('KeyD', 'ArrowRight') || t.right ? 1 : 0;
    const up = this.held('KeyW', 'ArrowUp') || t.throttle ? 1 : 0;
    const down = this.held('KeyS', 'ArrowDown') || t.brake ? 1 : 0;

    const steerTarget = left - right;
    const steerRate = steerTarget === 0 ? KEY_FALL : KEY_RISE;
    this.steer = moveTowards(this.steer, steerTarget, steerRate * dt);

    this.throttle = moveTowards(this.throttle, up, (up ? KEY_RISE : KEY_FALL) * 1.8 * dt);
    this.brake = moveTowards(this.brake, down, (down ? KEY_RISE : KEY_FALL) * 2.4 * dt);
    this.handbrake = this.held('Space') || !!this.touch.handbrake;

    this._pollGamepad();

    // Tilt last, and it wins; a held arrow button still overrides it as a fallback.
    this.tilt.update(dt);
    if (this.tilt.on && !left && !right && this.tilt.age <= 0.5) {
      this.steer = this.tilt.value;
    }

    this.steer = clamp(this.steer, -1, 1);
    this.throttle = clamp(this.throttle, 0, 1);
    this.brake = clamp(this.brake, 0, 1);
  }

  /** Standard-mapping pad: triggers on 6/7, steering on the left stick. */
  _pollGamepad() {
    if (!navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;

      const dead = (v) => (Math.abs(v) < 0.12 ? 0 : v);
      const stick = dead(pad.axes[0] ?? 0);
      if (stick !== 0) this.steer = -stick;

      // Shoulder buttons shift, matching the E/Q keys.
      if (pad.buttons[5]?.pressed && !this._padUp) this.pressed.add('KeyE');
      if (pad.buttons[4]?.pressed && !this._padDown) this.pressed.add('KeyQ');
      this._padUp = !!pad.buttons[5]?.pressed;
      this._padDown = !!pad.buttons[4]?.pressed;

      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      if (rt > 0.02) this.throttle = rt;
      if (lt > 0.02) this.brake = lt;
      if (pad.buttons[0]?.pressed) this.handbrake = true;
      return; // first connected pad wins
    }
  }

  dispose(target = window) {
    target.removeEventListener('keydown', this._onKeyDown);
    target.removeEventListener('keyup', this._onKeyUp);
    target.removeEventListener('blur', this._onBlur);
  }
}
