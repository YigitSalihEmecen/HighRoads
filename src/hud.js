/**
 * hud.js — instrument cluster, trip computer and transient toasts.
 *
 * The DOM lives in index.html; this module only pushes values into it. Text
 * nodes are written only when the displayed value actually changes, because
 * assigning textContent every frame forces a layout pass and shows up in the
 * profile long before the renderer does.
 */

import { clamp } from './util.js';

export class HUD {
  constructor() {
    this.root = document.getElementById('hud');
    this.speedEl = document.getElementById('speed-val');
    this.gearEl = document.getElementById('gear');
    this.modeEl = document.getElementById('gear-mode');
    this.tripEl = document.getElementById('trip-km');
    this.altEl = document.getElementById('trip-alt');
    this.statsEl = document.getElementById('stats');
    this.toastEl = document.getElementById('toast');

    this.fillEl = document.getElementById('tach-fill');
    this.redEl = document.getElementById('tach-red');

    // ---- Traffic mode ----------------------------------------------------
    this.scoreEl = document.getElementById('score');
    this.chainEl = document.getElementById('chain');
    this.multEl = document.getElementById('mult');
    this.chainBar = document.querySelector('#chain-bar i');
    this.awardEl = document.getElementById('award');
    this._scorePop = 0;
    this._awardTimer = 0;
    this._lastScore = -1;
    this._lastMult = -1;

    // Measure the arc rather than hard-coding it — the path is authored in the
    // stylesheet's coordinate space and may be edited independently.
    this.arcLen = this.fillEl.getTotalLength();
    this.fillEl.style.strokeDasharray = `${this.arcLen} ${this.arcLen}`;
    this.fillEl.style.strokeDashoffset = String(this.arcLen);

    const redFrom = 0.88;
    this.redEl.style.strokeDasharray = `${this.arcLen * (1 - redFrom)} ${this.arcLen}`;
    this.redEl.style.strokeDashoffset = String(-this.arcLen * redFrom);

    this._last = { speed: -1, gear: '', trip: '', alt: '', stats: '', mode: '' };
    this._toastTimer = 0;
    this._gearFlash = 0;

    this._fpsFrames = 0;
    this._fpsTime = 0;
    this._fps = 0;
  }

  show() {
    this.root.classList.add('live');
  }

  hide() {
    this.root.classList.remove('live');
  }

  /** Traffic mode gets a score readout; Zen mode is just the instruments. */
  setMode(mode) {
    this.root.classList.toggle('traffic', mode === 'traffic');
  }

  /**
   * Score, multiplier and the chain timer.
   *
   * The chain bar is a CSS transform rather than a width so it never triggers
   * layout — this runs every frame, and the whole reason the readouts below
   * only write text when a value changes is that assigning to a live DOM node
   * shows up in a profile long before the renderer does.
   */
  updateRun(dt, run) {
    if (!this.scoreEl) return;

    if (run.lastAward > 0) {
      this._scorePop = 0.16;
      this.scoreEl.classList.add('pop');
      this.awardEl.textContent =
        `+${run.lastAward}` + (run.lastOncoming ? '  ONCOMING' : '');
      this.awardEl.classList.toggle('oncoming', run.lastOncoming);
      this.awardEl.classList.add('show');
      this._awardTimer = 0.9;
    }
    if (this._scorePop > 0) {
      this._scorePop -= dt;
      if (this._scorePop <= 0) this.scoreEl.classList.remove('pop');
    }
    if (this._awardTimer > 0) {
      this._awardTimer -= dt;
      if (this._awardTimer <= 0) this.awardEl.classList.remove('show');
    }

    const score = Math.round(run.score);
    if (score !== this._lastScore) {
      this.scoreEl.textContent = score.toLocaleString();
      this._lastScore = score;
    }
    if (run.multiplier !== this._lastMult) {
      this.multEl.textContent = 'x' + run.multiplier;
      this._lastMult = run.multiplier;
    }
    this.chainEl.classList.toggle('live', run.chain > 0);
    this.chainBar.style.transform = `scaleX(${run.chainFraction.toFixed(3)})`;
  }

  toast(message, seconds = 1.6) {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('show');
    this._toastTimer = seconds;
  }

  /**
   * @param {number} dt
   * @param {object} s { speedKmh, rpm, maxRpm, gear, tripMeters, altitude, chunks }
   */
  update(dt, s) {
    // --- fps, averaged over half-second windows ---------------------------
    this._fpsFrames++;
    this._fpsTime += dt;
    if (this._fpsTime >= 0.5) {
      this._fps = Math.round(this._fpsFrames / this._fpsTime);
      this._fpsFrames = 0;
      this._fpsTime = 0;
    }

    const speed = Math.round(s.speedKmh);
    if (speed !== this._last.speed) {
      this.speedEl.textContent = String(speed);
      this._last.speed = speed;
    }

    if (s.gear !== this._last.gear) {
      this.gearEl.textContent = s.gear;
      this._last.gear = s.gear;
      this._gearFlash = 0.22;
      this.gearEl.classList.add('shift');
    }
    if (this._gearFlash > 0) {
      this._gearFlash -= dt;
      if (this._gearFlash <= 0) this.gearEl.classList.remove('shift');
    }

    const mode = s.autoShift ? 'AUTO' : 'MANUAL';
    if (mode !== this._last.mode) {
      this.modeEl.textContent = mode;
      this.modeEl.classList.toggle('manual', !s.autoShift);
      this._last.mode = mode;
    }

    const t = clamp(s.rpm / s.maxRpm, 0, 1);
    this.fillEl.style.strokeDashoffset = String(this.arcLen * (1 - t));

    const trip = (s.tripMeters / 1000).toFixed(2);
    if (trip !== this._last.trip) {
      this.tripEl.textContent = trip;
      this._last.trip = trip;
    }

    const alt = String(Math.round(s.altitude));
    if (alt !== this._last.alt) {
      this.altEl.textContent = alt;
      this._last.alt = alt;
    }

    const stats = `${this._fps} FPS · ${s.chunks} CHUNKS`;
    if (stats !== this._last.stats) {
      this.statsEl.textContent = stats;
      this._last.stats = stats;
    }

    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.toastEl.classList.remove('show');
    }
  }
}
