/**
 * wind.js — the sound of the car moving through air.
 *
 * Speed-dependent filtered white noise from two filters and two gains. A
 * sampled loop has a period the ear can find; noise has none.
 */

import { WIND } from './config.js';
import { clamp } from './util.js';

// One-pole integration tilts white noise to roughly -6 dB/octave, so the energy
// sits where air actually is; loops because noise has no phase to match.
function noiseBuffer(ctx, seconds) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.028 * white) / 1.028;
    data[i] = last;
    const a = Math.abs(last);
    if (a > peak) peak = a;
  }
  // Normalise so buffer level is independent of the integration coefficient.
  const k = peak > 1e-6 ? 0.9 / peak : 1;
  for (let i = 0; i < n; i++) data[i] *= k;
  return buffer;
}

export class Wind {
  constructor() {
    this.ctx = null;
    this.volume = WIND.volume;
    this.muted = false;
    this._speed = 0;
    // Smoothed speed, so a physics hitch is not a gust.
    this._eased = 0;
  }

  // Builds the graph on the given context. Safe to call twice; second is a no-op.
  start(ctx) {
    if (this.ctx || !ctx) return;
    this.ctx = ctx;

    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer(ctx, WIND.bufferSeconds);
    source.loop = true;

    // rush: low-passed, the body of the sound.
    this.rushFilter = ctx.createBiquadFilter();
    this.rushFilter.type = 'lowpass';
    this.rushFilter.frequency.value = WIND.rushCutoff[0];
    this.rushFilter.Q.value = 0.7;
    this.rushGain = ctx.createGain();
    this.rushGain.gain.value = 0;

    // whistle: a narrow band that climbs in pitch.
    this.whistleFilter = ctx.createBiquadFilter();
    this.whistleFilter.type = 'bandpass';
    this.whistleFilter.frequency.value = WIND.whistleFreq[0];
    this.whistleFilter.Q.value = WIND.whistleQ;
    this.whistleGain = ctx.createGain();
    this.whistleGain.gain.value = 0;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;

    source.connect(this.rushFilter).connect(this.rushGain).connect(this.master);
    source.connect(this.whistleFilter).connect(this.whistleGain).connect(this.master);
    this.master.connect(ctx.destination);

    source.start();
    this.source = source;
  }

  /**

   * @param {number} dt      seconds
   * @param {number} speed   road speed, m/s
   */
  update(dt, speed) {
    if (!this.ctx) return;
    // One-pole toward the real speed, so a dropped frame is not a click.
    const k = 1 - Math.exp(-dt / Math.max(1e-3, WIND.smoothing));
    this._eased += (Math.abs(speed) - this._eased) * k;
    const v = this._eased;

    const t = clamp((v - WIND.startSpeed) / Math.max(1, WIND.fullSpeed - WIND.startSpeed), 0, 1);
    const shaped = Math.pow(t, WIND.exponent);

    // Ramps rather than assignments: a `.value` write steps at a block
    // boundary, which is an audible edge on a broadband parameter.
    const now = this.ctx.currentTime;
    const ramp = WIND.rampTime;
    const set = (param, value) => {
      param.cancelScheduledValues(now);
      param.setTargetAtTime(value, now, ramp);
    };

    set(this.rushGain.gain, shaped * WIND.rushLevel);
    set(this.rushFilter.frequency,
      WIND.rushCutoff[0] + (WIND.rushCutoff[1] - WIND.rushCutoff[0]) * t);

    // The whistle arrives late and then climbs hard with speed.
    const w = clamp((t - WIND.whistleFrom) / Math.max(1e-3, 1 - WIND.whistleFrom), 0, 1);
    set(this.whistleGain.gain, w * w * WIND.whistleLevel);
    set(this.whistleFilter.frequency,
      WIND.whistleFreq[0] + (WIND.whistleFreq[1] - WIND.whistleFreq[0]) * w);
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    return this.volume;
  }

  setMuted(muted) {
    this.muted = !!muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  dispose() {
    if (this.source) {
      try { this.source.stop(); } catch (err) { /* already stopped */ }
      this.source.disconnect();
    }
    this.ctx = null;
  }
}
