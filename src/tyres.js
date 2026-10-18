/**
 * tyres.js — the sound of the tyres on the ground.
 *
 * Synthesised on the powertrain's AudioContext, like wind.js. Each of the
 * four wheels is read for what it is touching (tarmac, verge gravel, grass),
 * how fast it is really turning (wheelspin included) and how hard it is
 * slipping; those become the gains and filters of four noise layers:
 *
 *   road   – pink noise roar + tread hum, chopped at the wheels' rotation rate
 *   gravel – stone crackle (sparse grains, rate follows speed) over a crunch bed
 *   grass  – soft low swish with a slow flutter
 *   squeal – detuned tone + noise on tarmac when a tyre lets go
 */

import { ROAD } from './config.js';
import { clamp, smoothstep } from './util.js';

const T = {
  volume: 0.5,
  /** Rolling circumference of a tyre, m: sets the rotation rate of the hum. */
  circumference: 2.0,
  /** Seconds of smoothing on speed and surface weights, so a bump is not a click. */
  smoothing: 0.08,
  rampTime: 0.04,
  /** Layer levels at full tilt. */
  roadLevel: 0.55,
  gravelLevel: 0.7,
  grassLevel: 0.45,
  squealLevel: 0.28,
  /** m/s: a wheel is silent below `start` and at full roar by `full`. */
  start: 0.3,
  full: 45,
};

const rand = () => Math.random() * 2 - 1;

function makeBuffer(ctx, seconds, fill) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  fill(data, n);
  let peak = 1e-6;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(data[i]));
  for (let i = 0; i < n; i++) data[i] *= 0.9 / peak;
  return buffer;
}

// Paul Kellet's pink filter: -3 dB/octave, which is where tyre roar lives.
function pinkFill(data, n) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rand();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    data[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
}

// Sparse random clicks with a short ringing tail: one stone each. Played back
// faster, the grains come faster, as they do when the car does.
function grainFill(data, n) {
  const perSecond = 140;
  const p = perSecond / (n / 4);
  let ring = 0;
  let amp = 0;
  for (let i = 0; i < n; i++) {
    if (Math.random() < p) amp = 0.3 + Math.random() * 0.7;
    ring = ring * 0.6 + rand() * amp;
    amp *= 0.82;
    data[i] = ring;
  }
}

export class TyreSound {
  constructor() {
    this.ctx = null;
    this.volume = T.volume;
    this.muted = false;
    this._speed = 0;
    this._road = 1;
    this._gravel = 0;
    this._grass = 0;
    this._slip = 0;
    this._flutter = 0;
  }

  start(ctx) {
    if (this.ctx || !ctx) return;
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(ctx.destination);

    const pink = makeBuffer(ctx, 6, pinkFill);
    const grains = makeBuffer(ctx, 4, grainFill);

    const loop = (buffer) => {
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.loop = true;
      // Staggered start so layers sharing a buffer are not in phase.
      s.start(0, Math.random() * buffer.duration);
      return s;
    };
    const filter = (type, f, q = 0.7) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const gain = (v = 0) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    this._sources = [];
    const src = (buffer) => {
      const s = loop(buffer);
      this._sources.push(s);
      return s;
    };

    // ---- road: roar, low rumble, tread hum --------------------------------
    this.roadRoar = filter('bandpass', 600, 0.6);
    this.roadRumble = filter('lowpass', 160, 0.9);
    this.roadHum = filter('bandpass', 1100, 5);
    this.roadGain = gain();
    // The wheels' rotation chops the roar: a tyre is not a smooth source.
    this.roadChop = gain(1);
    this.chopLfo = ctx.createOscillator();
    this.chopLfo.frequency.value = 1;
    const chopDepth = gain(0.22);
    this.chopLfo.connect(chopDepth).connect(this.roadChop.gain);
    this.chopLfo.start();
    const roadSrc = src(pink);
    roadSrc.connect(this.roadRoar).connect(this.roadChop);
    roadSrc.connect(this.roadRumble).connect(this.roadChop);
    const humGain = gain(0.5);
    roadSrc.connect(this.roadHum).connect(humGain).connect(this.roadChop);
    this.roadChop.connect(this.roadGain).connect(this.master);

    // ---- gravel: stone crackle over a crunch bed ----------------------------
    this.grainSrc = src(grains);
    this.grainSrc.playbackRate.value = 0.6;
    const grainBand = filter('bandpass', 2800, 0.8);
    const grainHigh = filter('highpass', 900, 0.7);
    this.gravelGain = gain();
    this.grainSrc.connect(grainHigh).connect(grainBand).connect(this.gravelGain);
    this.crunchFilter = filter('bandpass', 1400, 0.9);
    const crunchGain = gain(0.55);
    src(pink).connect(this.crunchFilter).connect(crunchGain).connect(this.gravelGain);
    this.gravelGain.connect(this.master);

    // ---- grass: low swish, flutter set from update() ---------------------
    this.grassFilter = filter('lowpass', 500, 0.5);
    this.grassHigh = filter('highpass', 90, 0.7);
    this.grassFlutter = gain(1);
    this.grassGain = gain();
    src(pink).connect(this.grassFilter).connect(this.grassHigh)
      .connect(this.grassFlutter).connect(this.grassGain).connect(this.master);

    // ---- squeal: two detuned voices with a wobble, plus a hiss ------------
    this.squealGain = gain();
    this.squealBand = filter('bandpass', 900, 3);
    this.squealOscs = [0, 1].map((i) => {
      const o = ctx.createOscillator();
      o.type = i ? 'triangle' : 'sawtooth';
      o.frequency.value = 900 * (i ? 1.51 : 1);
      o.connect(this.squealBand);
      o.start();
      return o;
    });
    this.wobble = ctx.createOscillator();
    this.wobble.frequency.value = 9;
    const wobbleDepth = gain(18);
    this.wobble.connect(wobbleDepth);
    this.squealOscs.forEach((o) => wobbleDepth.connect(o.frequency));
    this.wobble.start();
    const squealHiss = filter('bandpass', 2200, 5);
    const hissGain = gain(0.6);
    src(pink).connect(squealHiss).connect(hissGain).connect(this.squealBand);
    this.squealBand.connect(this.squealGain).connect(this.master);
  }

  /**
   * Reads the four wheels. `path` / `s` classify each contact patch by its
   * distance from the centre line.
   *
   * @param {number} dt
   * @param {object|null} vehicle  RaycastVehicle, or null to fall silent
   * @param {object} path          Path (lateralOffset)
   * @param {number} s             arc length hint
   */
  update(dt, vehicle, path, s) {
    if (!this.ctx) return;

    let speed = 0;
    let road = 0;
    let gravel = 0;
    let grass = 0;
    let slip = 0;
    let n = 0;

    if (vehicle) {
      const edge = ROAD.halfWidth + ROAD.shoulder;
      const fwd = vehicle.forwardSpeed;
      const wheels = vehicle.wheels;
      for (let i = 0; i < wheels.length; i++) {
        const w = wheels[i];
        if (!w.grounded) continue;
        n++;
        // A driven wheel under power turns faster than the car is moving.
        const spin = vehicle.V.driveBias[i] > 0 ? vehicle.driveSlip : 0;
        speed += Math.hypot(fwd + spin, w.slipLat);
        slip += w.slipAmount;

        const lat = Math.abs(path.lateralOffset(w.contact, s));
        const toGrass = smoothstep(edge + 2.4, edge + 4.5, lat);
        const toGravel = smoothstep(edge - 0.4, edge + 0.8, lat);
        grass += toGrass;
        gravel += toGravel * (1 - toGrass);
        road += 1 - toGravel;
      }
    }
    if (n) { speed /= n; road /= n; gravel /= n; grass /= n; slip /= n; }
    else { road = this._road; gravel = this._gravel; grass = this._grass; }
    // Airborne wheels make no sound at all.
    const contact = n / 4;

    const k = 1 - Math.exp(-dt / T.smoothing);
    this._speed += (speed * (n ? 1 : 0) - this._speed) * k;
    this._road += (road - this._road) * k;
    this._gravel += (gravel - this._gravel) * k;
    this._grass += (grass - this._grass) * k;
    this._slip += (slip - this._slip) * k;
    this._flutter += (Math.random() - 0.5 - this._flutter) * Math.min(1, dt * 14);

    const v = this._speed;
    const t = clamp((v - T.start) / (T.full - T.start), 0, 1);
    // Louder than linear at the bottom, flattening toward top speed.
    const level = Math.pow(t, 0.65) * contact;
    const now = this.ctx.currentTime;
    const set = (param, value) => {
      param.cancelScheduledValues(now);
      param.setTargetAtTime(value, now, T.rampTime);
    };

    // Loose-surface slides are loud on gravel and grass, and screech only on tarmac.
    const slide = smoothstep(0.15, 0.8, this._slip);
    const loose = this._gravel + this._grass;

    set(this.roadGain.gain, level * this._road * T.roadLevel * (1 + 0.5 * slide));
    set(this.roadRoar.frequency, 380 + 900 * t);
    set(this.roadRumble.frequency, 110 + 120 * t);
    set(this.roadHum.frequency, 700 + 1500 * t);
    set(this.chopLfo.frequency, Math.max(0.5, v / T.circumference));

    set(this.gravelGain.gain,
      level * this._gravel * T.gravelLevel * (1 + 0.8 * slide) * (0.85 + 0.3 * this._flutter));
    set(this.grainSrc.playbackRate, 0.45 + 1.6 * t);
    set(this.crunchFilter.frequency, 900 + 1400 * t);

    set(this.grassGain.gain, level * this._grass * T.grassLevel * (1 + 0.4 * slide));
    set(this.grassFilter.frequency, 320 + 700 * t);
    set(this.grassFlutter.gain, 0.7 + 0.6 * this._flutter);

    // A squeal needs speed, tarmac and a tyre past its limit.
    const squeal = smoothstep(0.2, 0.9, this._slip) * smoothstep(3, 12, v) * this._road * (1 - loose);
    set(this.squealGain.gain, squeal * contact * T.squealLevel);
    const pitch = 780 + 380 * smoothstep(5, 35, v) + 120 * this._slip;
    set(this.squealOscs[0].frequency, pitch);
    set(this.squealOscs[1].frequency, pitch * 1.51);
    set(this.squealBand.frequency, pitch * 1.2);
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
    for (const s of this._sources || []) {
      try { s.stop(); } catch (err) { /* already stopped */ }
      s.disconnect();
    }
    for (const o of [this.chopLfo, this.wobble, ...(this.squealOscs || [])]) {
      if (!o) continue;
      try { o.stop(); } catch (err) { /* already stopped */ }
      o.disconnect();
    }
    this.ctx = null;
  }
}
