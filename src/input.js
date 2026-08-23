/**
 * input.js — keyboard + gamepad, normalised into one analogue-ish state.
 *
 * Keys are ramped rather than binary. A digital key jammed straight into a
 * steering angle feels awful; a short ramp with a faster release gives most of
 * the feel of an analogue stick, and the gamepad path simply overrides it.
 */

import { clamp, moveTowards } from './util.js';

const KEY_RISE = 4.2;   // per second, toward the pressed value
const KEY_FALL = 6.5;   // per second, back to neutral

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
    const host = root.getElementById ? root.getElementById('touch') : null;
    if (!host) return false;

    const isTouch =
      typeof window !== 'undefined' &&
      ('ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0);
    if (!isTouch) return false;
    document.body.classList.add('touch');

    for (const btn of host.querySelectorAll('.tbtn')) {
      const hold = btn.dataset.hold;
      const tap = btn.dataset.tap;

      const down = (e) => {
        e.preventDefault();
        btn.setPointerCapture && btn.setPointerCapture(e.pointerId);
        btn.classList.add('on');
        if (hold) this.touch[hold] = 1;
        if (tap) this.pressed.add(tap);
      };
      const up = (e) => {
        e.preventDefault();
        btn.classList.remove('on');
        if (hold) this.touch[hold] = 0;
      };

      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('pointerleave', up);
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
