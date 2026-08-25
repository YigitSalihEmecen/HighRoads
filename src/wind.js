/**
 * wind.js — the noise of moving through air.
 *
 * The one sound a driving game cannot get from an engine simulator, and the
 * cheapest immersion in the project: at 200 km/h a car is loud in a way that
 * has nothing to do with combustion, and without it speed reads entirely as a
 * number on the dashboard and a change in the pitch of the exhaust.
 *
 * ── why it is synthesised, not sampled ──────────────────────────────────────
 *
 * Same reason everything else here is generated: a loop is a file, a file has a
 * length, and a length is a period the ear finds. Filtered white noise has no
 * period at all. It is also a handful of nodes — two filters and two gains —
 * against an asset that would be the largest thing in the repository.
 *
 * ── two bands, because wind noise is two things ─────────────────────────────
 *
 * RUSH is the broadband roar of the boundary layer over the body: low-passed
 * noise, present from walking pace, and what most of the loudness is.
 *
 * WHISTLE is the narrow band that comes off edges — mirrors, seals, the A-pillar
 * — and it behaves quite differently. It arrives late, it climbs in pitch with
 * speed, and it is the part the ear reads as "fast" rather than as "loud". One
 * band alone gives either a dull hiss that never becomes urgent or a kettle
 * that is wrong at every speed but one.
 *
 * ── the speed law ───────────────────────────────────────────────────────────
 *
 * Aeroacoustic power goes roughly as the sixth power of velocity, which is a
 * true statement and a terrible mapping: it puts everything below 150 km/h at
 * silence and everything above it at the same deafening level. What is wanted
 * is the PERCEPTUAL curve — amplitude, not power, and gentle enough that the
 * whole speed range is expressive. `WIND.exponent` is a little over two, which
 * is amplitude going as v^2 with a tilt, and it was chosen by listening.
 *
 * ── it must start inside a user gesture ─────────────────────────────────────
 *
 * Same rule as the powertrain, and for the same reason: Web Audio will not
 * start a context outside one. This module does not create a context — it is
 * handed the one `engine_sim` already made, so there is exactly one clock and
 * one output bus in the process.
 */

import { WIND } from './config.js';
import { clamp } from './util.js';

/**
 * Fills a buffer with brown-ish noise.
 *
 * Not white. White noise is flat in power per hertz, so most of its energy sits
 * in the top two octaves and it reads as a hiss — a cymbal, not a gale. A
 * one-pole integration tilts it to roughly -6 dB per octave, which puts the
 * weight at the bottom where air actually is, and leaves the filters below
 * shaping something that already sounds like wind.
 *
 * Ten seconds, and it loops. Long enough that no repeat is audible, and the
 * loop point costs nothing because a noise signal has no phase to match.
 */
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
  // Normalise: the integration's gain depends on the coefficient above, and a
  // buffer whose level moves when that is tuned makes every gain below a lie.
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
    /** Smoothed speed, so a physics hitch is not a gust. */
    this._eased = 0;
  }

  /**
   * Builds the graph on an existing context. Call inside the user gesture that
   * starts the run — see the file header.
   *
   * Safe to call twice; the second call is a no-op.
   */
  start(ctx) {
    if (this.ctx || !ctx) return;
    this.ctx = ctx;

    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer(ctx, WIND.bufferSeconds);
    source.loop = true;

    // ---- rush: low-passed, the body of the sound ------------------------
    this.rushFilter = ctx.createBiquadFilter();
    this.rushFilter.type = 'lowpass';
    this.rushFilter.frequency.value = WIND.rushCutoff[0];
    this.rushFilter.Q.value = 0.7;
    this.rushGain = ctx.createGain();
    this.rushGain.gain.value = 0;

    // ---- whistle: a narrow band that climbs in pitch ---------------------
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
    // One-pole toward the real speed. The car's own velocity is already smooth,
    // but a dropped frame or a collision impulse is not, and a filter cutoff
    // that jumps is a click.
    const k = 1 - Math.exp(-dt / Math.max(1e-3, WIND.smoothing));
    this._eased += (Math.abs(speed) - this._eased) * k;
    const v = this._eased;

    const t = clamp((v - WIND.startSpeed) / Math.max(1, WIND.fullSpeed - WIND.startSpeed), 0, 1);
    const shaped = Math.pow(t, WIND.exponent);

    // Ramps rather than assignments: a `.value` write lands at a block boundary
    // and steps, which on a parameter this broadband is an audible edge.
    const now = this.ctx.currentTime;
    const ramp = WIND.rampTime;
    const set = (param, value) => {
      param.cancelScheduledValues(now);
      param.setTargetAtTime(value, now, ramp);
    };

    set(this.rushGain.gain, shaped * WIND.rushLevel);
    set(this.rushFilter.frequency,
      WIND.rushCutoff[0] + (WIND.rushCutoff[1] - WIND.rushCutoff[0]) * t);

    // The whistle arrives late and then climbs hard — see the header.
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
