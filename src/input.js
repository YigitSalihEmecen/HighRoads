/**
 * input.js — keyboard, gamepad, touch and tilt, normalised into one
 * analogue-ish state.
 *
 * Keys are ramped rather than binary. A digital key jammed straight into a
 * steering angle feels awful; a short ramp with a faster release gives most of
 * the feel of an analogue stick, and the two ANALOGUE sources — a gamepad stick
 * and the phone's own attitude — simply override it. Overriding rather than
 * blending is the right call for a reason worth stating: an analogue axis
 * already carries the player's intent at every instant, and mixing a ramp into
 * it can only add lag to something that had none.
 *
 * ── tilt ────────────────────────────────────────────────────────────────────
 *
 * The two arrow buttons are a digital steering input on a device that has a
 * perfectly good analogue one in it. `TiltSteering` below reads
 * `deviceorientation` and turns it into the same -1..+1 the stick produces.
 *
 * Three things about it are not obvious and all three have to be right:
 *
 *   WHICH AXIS depends on how the phone is being held. `gamma` is roll about
 *   the screen's long axis and `beta` is pitch about its short one, and which
 *   of those means "steer" swaps when the device rotates — so the axis and its
 *   sign come from `screen.orientation.angle`, not from an assumption about
 *   landscape.
 *
 *   THE ZERO IS WHEREVER THE PLAYER IS HOLDING IT. Nobody holds a phone flat,
 *   and a game that assumes they do steers left forever. The neutral attitude
 *   is captured when tilt is switched on and can be recaptured at any time.
 *
 *   iOS NEEDS PERMISSION, FROM INSIDE A TAP. Safari has gated motion and
 *   orientation behind `DeviceOrientationEvent.requestPermission()` since iOS
 *   13, it requires transient activation, and it requires HTTPS. That is the
 *   same constraint the audio has (`Powertrain.start`, trap #12) and it is why
 *   `enable()` returns a promise and is called from a click handler.
 */

import { clamp, moveTowards } from './util.js';

const KEY_RISE = 4.2;   // per second, toward the pressed value
const KEY_FALL = 6.5;   // per second, back to neutral

/**
 * Degrees of tilt either side of neutral for full lock, and the dead band in
 * the middle.
 *
 * TEN, not fifteen, and the history of the number is worth one line: the
 * original was twenty-two, cut to fifteen, and a player on a modern iPhone
 * still found themselves winding the phone hard over to get the lock they
 * wanted. Full lock at ten degrees of roll is a firm wrist, not an arm, and
 * the expo below is what is left after that — a small gesture does most of the
 * work and the extreme stays easy to reach.
 *
 * The dead band is small — 1.2° — because a car that will not hold a straight
 * line is the failure mode everyone remembers about tilt steering, and it is
 * nearly always a missing dead band rather than a noisy sensor.
 */
const TILT_RANGE = 10;
const TILT_DEAD = 1.2;
/**
 * Curve applied inside the range. `x * |x|^(k-1)`, which keeps the middle of
 * the travel fine for lane corrections and still reaches full lock at the ends.
 * Linear tilt feels twitchy on centre and short at the extremes, because a
 * wrist does not move linearly.
 *
 * 1.1, down from 1.25, chasing the same "too much phone for too little
 * steering" report that cut the range. At six degrees of roll — a normal
 * steering lean — t = (6 − 1.2) / (10 − 1.2) = 0.55, and 0.55^1.1 ≈ 0.52, so
 * half lock is a comfortable gesture and the last few degrees of the range
 * still sharpen to the corners instead of flattening out.
 */
const TILT_EXPO = 1.1;
/** A sample older than this is stale: the sensor stopped, so let go of the car. */
const TILT_TIMEOUT = 0.5;
const STORE_KEY = 'highroads.tilt';
const INVERT_KEY = 'highroads.tiltInvert';

/**
 * The phone's attitude, as a steering axis.
 *
 * Deliberately its own object rather than four more fields on `Input`: it owns
 * a listener, a permission state and a calibration, and none of those have
 * anything to say to the keyboard.
 */
export class TiltSteering {
  constructor() {
    this.on = false;
    /** -1..+1, or 0 while there is no fresh sample. */
    this.value = 0;
    /** The attitude the player is actually holding the device at. */
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

  /** True where iOS's permission gate is in the way. */
  static get needsPermission() {
    return TiltSteering.supported &&
      typeof DeviceOrientationEvent.requestPermission === 'function';
  }

  /** What the player last chose, or null if they never have. Best-effort. */
  static get remembered() {
    try {
      const v = localStorage.getItem(STORE_KEY);
      return v === null ? null : v === '1';
    } catch (err) {
      return null;
    }
  }

  static remember(on) {
    try { localStorage.setItem(STORE_KEY, on ? '1' : '0'); } catch (err) { /* private window */ }
  }

  /**
   * Whether to steer the opposite way to the axis table in `_read`.
   *
   * This exists because the table cannot be verified without a phone, and it is
   * exactly the kind of thing that is wrong on some devices and right on
   * others — `screen.orientation.angle` is reported consistently, but which
   * physical rotation it describes is a thing implementations have disagreed
   * about. A player who finds the car going the wrong way needs a switch, not a
   * bug report.
   */
  static get inverted() {
    try {
      return localStorage.getItem(INVERT_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  static setInverted(on) {
    try { localStorage.setItem(INVERT_KEY, on ? '1' : '0'); } catch (err) { /* private window */ }
  }

  /**
   * Switches tilt on. MUST BE CALLED FROM A USER GESTURE on iOS.
   *
   * Resolves false rather than throwing when the player declines, when the page
   * is not on HTTPS, or when there is no sensor — every one of those is a
   * perfectly ordinary thing for a browser to do and none of them should take
   * the game down. The caller shows the state it got back.
   */
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
    // Capture the neutral attitude on the next sample, not on this one — there
    // is no sample yet, and zeroing against a stale reading is worse than not
    // zeroing at all.
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

  /** Takes the current attitude as straight ahead. */
  recentre() {
    this.zero = null;
  }

  /**
   * Picks the steering axis out of the event, in screen space.
   *
   * `gamma` rolls about the screen's long axis and `beta` pitches about its
   * short one; rotating the device swaps which of the two the player thinks of
   * as "tipping it left". `screen.orientation.angle` is how far the page has
   * been rotated to stay upright, so it is exactly the correction needed.
   */
  _read(e) {
    if (e.gamma === null && e.beta === null) return;
    const angle = (typeof screen !== 'undefined' && screen.orientation &&
      typeof screen.orientation.angle === 'number') ? screen.orientation.angle : 0;
    const beta = e.beta || 0;
    const gamma = e.gamma || 0;
    let axis;
    // LANDSCAPE SIGNS, AND WHICH SIDE OF THE MIRROR THEY LIVE ON.
    //
    // The table below is keyed to `screen.orientation.angle` (how far the page
    // has been rotated to stay upright). The device-frame attitude attributes
    // do not rotate with the screen, so each orientation is a different mapping
    // of the same gesture, and implementations have historically disagreed on
    // which physical rotation `gamma`/`beta` describe — iOS and Android have
    // shipped swapped semantics at different times. The result is a table that
    // has to be tuned against a real phone and barely anything else.
    //
    // The previous set of landscape signs was the mirror image of this one,
    // shipped from an older device report. A modern iPhone (iOS 17+) steered
    // the wrong way under it: tipping the phone left sent the car right. These
    // landscape branches are the corrected signs — both sides of the landscape
    // mirror flip together so the gesture maps the same no matter which way up
    // the notch is. `TiltSteering.inverted` is the escape hatch for whatever
    // device disagrees next; the table here just has to be right for the one
    // it shipped against.
    if (angle === 90) axis = beta;
    else if (angle === 270 || angle === -90) axis = -beta;
    else if (angle === 180) axis = -gamma;
    else axis = gamma;

    if (this.zero === null) this.zero = axis;
    this._raw = axis;
    this.age = 0;
  }

  /** Advances the staleness clock and recomputes the axis. */
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
    /** One-shot actions consumed by the game loop. */
    this.pressed = new Set();

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      const code = e.code;
      this.keys.add(code);
      this.pressed.add(code);
      // Stop the page scrolling out from under the game.
      if (code.startsWith('Arrow') || code === 'Space') e.preventDefault();
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => {
      this.keys.clear();
      this.handbrake = false;
    };

    /** Set by the on-screen controls; merged with the keyboard each update. */
    this.touch = { left: 0, right: 0, throttle: 0, brake: 0, handbrake: 0, flash: 0 };

    /** The phone's attitude as a steering axis. Off until the player asks. */
    this.tilt = new TiltSteering();

    target.addEventListener('keydown', this._onKeyDown, { passive: false });
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
  }

  /** True if the flash control is held, from either input. */
  get flashHeld() {
    return this.held('KeyF') || !!this.touch.flash;
  }

  /**
   * Binds the on-screen controls.
   *
   * Buttons are either `data-hold` (a continuous input, held while touched) or
   * `data-tap` (a one-shot, injected as the matching key so the rest of the
   * game needs no separate path). Pointer events cover touch, pen and mouse in
   * one listener set, and capture means a finger that slides off the button
   * still releases it — otherwise the throttle sticks on.
   */
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

  /**
   * Drops any one-shot presses nothing consumed. This must be called at the
   * *end* of the frame, not inside update(): the loop runs update() before it
   * reads actions, so clearing there threw every press away before anything
   * could see it — R, C and M silently did nothing.
   */
  endFrame() {
    this.pressed.clear();
  }

  /** True once per physical press. */
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
    // Touch and keyboard are merged rather than switched between, so a phone
    // with a connected keyboard, or a desktop with a touchscreen, works either
    // way round without a mode to get wrong.
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

    // Tilt LAST, and it wins. It is the most analogue source on the device and
    // it is only ever on because the player switched it on; anything that
    // blended it with the arrow ramp would be adding lag to the one input that
    // has none. A held arrow button still overrides it, so the buttons remain a
    // usable override if the sensor misbehaves mid-corner.
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
