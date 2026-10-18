/**
 * powertrain.js — the engine simulator wired in as the drivetrain.
 *
 * engine_sim owns gear, rpm and torque. The game supplies the road speed
 * under the driven wheels and how much force their tyres can transmit; the
 * bridge models the driven wheel itself (engine_sim's `_stepVehicle`, the one
 * hook overridden) and returns the force the tyres actually put down. One
 * source of truth keeps the sound with the car:
 *
 *  - gripping, the wheel turns with the road, so rpm is road speed through
 *    the gear and the propshaft torque is what pushes the car;
 *  - past the grip limit the wheel spins up on its own inertia — the revs
 *    flare and the car gets only what the tyres can carry (a burnout);
 *  - in the air the engine spins the wheels freely and they bite on landing;
 *  - reverse is first gear run backwards, loaded like any other gear.
 */

import { EngineSim } from '../engine_sim/src/engine-sim.js';
import { WORLD } from './config.js';
import { smoothstep } from './util.js';

// Air density for converting the simulator's drag area.
const RHO_AIR = 1.225;

// Stall upshift: near redline, throttle open, rpm plateaued — the simulator
// never reaches its threshold with an underpowered engine in a heavy car.
const STALL_FRAC = 0.86;    // of redline
const STALL_RATE = 220;     // rpm/s below which the engine counts as plateaued
const STALL_TIME = 0.7;     // s it must persist
const STALL_COOLDOWN = 1.2; // s before it may fire again

// A spinning tyre carries a little less than a gripping one (kinetic friction).
const KINETIC = 0.94;
// Driven wheel + tyre + half-shaft inertia, kg·m² per m² of radius — engine_sim's own figure.
const WHEEL_J_PER_R2 = 13;
// Traction control: wheelspin (m/s past the road) where it starts and finishes
// cutting, the deepest cut, and how fast it acts (1/s). Some slip is allowed —
// that is where a tyre makes its most force.
const TC_FROM = 1.5, TC_TO = 5, TC_DEPTH = 0.85, TC_RATE = 15;
// Reverse speed limiter, m/s: fades the throttle out between these.
const REVERSE_FROM = 10, REVERSE_TO = 12.5;
// engine_sim derives `launchRate` once from the preset it was built with;
// `setCar` recomputes it via `_retuneLaunch` for the car actually on screen.
const LAUNCH_RATE_FRAC = 0.9;

// Builds a drivetrain profile from the car's own derived parameters, so the
// simulator's inertias and resistances describe the vehicle actually on screen.
// The car's ratio table is only a starting point: engine_sim redesigns the
// gearbox for whichever engine is fitted (engine_sim/src/gearbox.js) — gear
// count from the engine, ratios from this car's mass, wheels and drag. A fixed
// table per car stranded every swapped-in engine whose power band did not suit
// it, short of its top gears.
function vehicleProfile(V, spec) {
  // Our ratio table carries reverse at 0 and neutral at 1; the simulator wants
  // forward ratios only, indexed from first.
  const forward = V.gearRatios.slice(2);
  const g = Math.abs(WORLD.gravity);

  return {
    label: spec.name,
    mass: V.mass,
    wheelRadius: V.wheelRadius,
    finalDrive: V.finalDrive,
    gearRatios: forward,
    gearbox: spec.gearbox || 'auto',
    shiftTimeMs: spec.shiftTimeMs || 160,

    // The game's own resistances, so the gearbox is designed against the road
    // the car actually drives on. Our drag coefficient is the lumped
    // 0.5·ρ·Cd·A (force = k·v²), the simulator wants Cd·A; rolling resistance
    // is a flat force in vehicle.js (a quarter of V.rollingResistance per
    // wheel), here as a coefficient under the game's gravity.
    gravity: g,
    dragArea: V.dragCoefficient / (0.5 * RHO_AIR),
    rollingResistance: V.rollingResistance / (V.mass * g),
    brakeForce: V.brakeForce.reduce((a, b) => a + b, 0),
  };
}

export class Powertrain {
  constructor() {
    this.sim = null;
    this.ready = false;
    this.muted = false;
    this.volume = 0.62;

    // The road under the driven wheels, as wheel rad/s (positive = the way the
    // selected gear drives), and the force their tyres can transmit, N.
    this._groundW = 0;
    this._grip = Infinity;
    // Driven-wheel state: spinning past the road, and the force actually put
    // down, averaged over the frame.
    this._spinning = false;
    this._fSum = 0;
    this._tSum = 0;
    this._Jw = 2.8;
    /** Driven wheels' surface speed minus the road's, m/s, in the car's frame (+ = forward). */
    this.wheelSlip = 0;
    /** A high-rev launch's clutch slip as tyre speed, m/s: drawn as wheelspin, never applied. */
    this.launchSlip = 0;
    // Reverse runs the box in first with the automatic suspended.
    this._revHeld = false;
    /** Throttle cut on wheelspin. Off lets the tyres light up. */
    this.tractionControl = true;
    this._tc = 0;
    // Longitudinal force at the contact patch, newtons.
    this.force = 0;

    // Mirrors of simulator state, so we never reach into engine_sim internals.
    this.rpm = 0;
    this.maxRpm = 7000;
    this.gear = 1;
    this.load = 0;
    this.limiter = false;
    this.reverse = false;
    this.params = null;

    this._car = null;
    // Stall-upshift bookkeeping. See STALL_FRAC.
    this._stallFor = 0;
    this._stallCool = 0;
    this._prevRpm = 0;
    // 'stock' follows the car's own engine; anything else overrides it.
    this.engineChoice = 'stock';
    // Manual holds the gear until the driver asks.
    this.autoShift = true;
    this.turbo = false;
    // `mechanical` is OFF deliberately: engine_sim's MechanicalLayer band-passed
    // noise is just a hiss over the note on this game; the transients bus stays.
    this.mix = { exhaust: 1.0, intake: 0.6, mechanical: 0.0, transmission: 0.22,
                 turbo: 0.5, transients: 0.4, sub: 1.0 };
    this.tone = { rumble: 1.1, brightness: 0.72 };
    // Three-band compressor amount: 0 bypasses it, 1 is the simulator's tune.
    this.dynamics = 1;
    // Five-band EQ, dB: 60 sub, 200 body, 800 honk, 2.5k rasp, 8k air. The
    // cuts tame engines whose harmonics land in the ear's most sensitive bands.
    this.eq = [1.5, 1.0, -5.5, -6.5, -3.5];
  }

  // ---------------------------------------------------------- gearbox ----

  setAutoShift(on) {
    this.autoShift = !!on;
    if (this.sim) this.sim.setAutoShift(this.autoShift);
    return this.autoShift;
  }

  setTurbo(on) {
    this.turbo = !!on;
    if (this.sim) this.sim.setTurbo(this.turbo);
    return this.turbo;
  }

  // Returns false if the simulator refused (it guards against over-revving).
  shiftUp() {
    return this.sim ? this.sim.shiftUp() !== false : false;
  }

  shiftDown() {
    return this.sim ? this.sim.shiftDown() !== false : false;
  }

  // Resets the drivetrain and selects first gear, so a respawn never starts a
  // car bogged down in the gear it came off the road in.
  reset(gear = 1) {
    this._groundW = 0;
    this._spinning = false;
    this.wheelSlip = 0;
    this.launchSlip = 0;
    this._tc = 0;
    this.force = 0;
    this.reverse = false;
    if (this._revHeld && this.sim) this.sim.setAutoShift(this.autoShift);
    this._revHeld = false;
    this._stallFor = 0;
    this._stallCool = 0;
    if (this.sim && this.sim.physics) {
      const p = this.sim.physics;
      p.selectGear(gear);
      if (p.shift && p.shift.reset) {
        p.shift.reset();
      }
      p.ww = 0;
      p.wo = 0;
      p.twist = 0;
      p.dtwist = 0;
      p.contact = 0;
      p.Tp = 0;
      if (p.engine && p.engine.idleRpm) {
        p.we = p.engine.idleRpm * (2 * Math.PI / 60);
      }
      this.rpm = p.rpm;
      this.gear = p.gear;
    }
  }

  // ------------------------------------------------------------- mix -----

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.sim && !this.muted) this.sim.setVolume(this.volume);
    return this.volume;
  }

  setBus(name, value) {
    this.mix[name] = Math.max(0, Math.min(2, value));
    if (this.sim) this.sim.setMix({ [name]: this.mix[name] });
    return this.mix[name];
  }

  setTone(partial) {
    Object.assign(this.tone, partial);
    if (this.sim) this.sim.setTone(this.tone);
    return this.tone;
  }

  setDynamics(amount) {
    this.dynamics = Math.max(0, Math.min(1, amount));
    if (this.sim) this.sim.setDynamics(this.dynamics);
    return this.dynamics;
  }

  // Any engine in any car. The car keeps its mass, wheels and drag; the
  // gearbox is redesigned for the engine (see vehicleProfile).
  setEngine(id) {
    this.engineChoice = id || 'stock';
    if (this._car) this.setCar(this._car);
    return this.engineId();
  }

  engineId() {
    const stock = (this._car && this._car.spec.engine) || 'i4';
    return this.engineChoice === 'stock' ? stock : this.engineChoice;
  }

  // Must be called from a user gesture; `audioContext` lets the whole drivetrain
  // be exercised headlessly against engine_sim's Web Audio mock.
  async start(car, audioContext = null) {
    if (this.sim) {
      this.setCar(car);
      return;
    }
    this._car = car;
    this.sim = new EngineSim(audioContext, {
      engine: this.engineId(),
      vehicle: 'sports',
      turbo: this.turbo,
      volume: this.volume,
    });

    // The driven wheel is the host's: `_stepVehicle` is overridden per instance
    // so engine_sim stays intact and its own test suite keeps passing.
    this.sim.physics._stepVehicle = (h, Tp) => this._stepWheel(h, Tp);

    this.setCar(car);
    await this.sim.start();
    this.sim.setAutoShift(this.autoShift);
    this.sim.setMix(this.mix);
    this.sim.setTone(this.tone);
    this.sim.setEQ(this.eq);
    // Dynamics are the simulator's job now: its three-band compressor already
    // tames the high-rpm transients at its own default, so just ask for it.
    this.sim.setDynamics(this.dynamics);
    this.ready = true;
    this.setMuted(this.muted);
  }

  // Reconfigures the simulator for a different vehicle from the roster.
  setCar(car) {
    this._car = car;
    this.maxRpm = car.V.maxRpm;
    const driven = (car.V.driveBias || [0, 0, 0.5, 0.5]).filter((b) => b > 0).length || 2;
    this._Jw = driven * WHEEL_J_PER_R2 * car.V.wheelRadius * car.V.wheelRadius;
    if (!this.sim) return;

    // Engine first, then the car: the gearbox is designed for the pair.
    this.sim.setEngineType(this.engineId());
    this.sim.vehicleId = car.spec.id;
    this.sim.setVehicleProfile(vehicleProfile(car.V, car.spec));
    // setVehicle resets the shift controller, so the driver's mode has to be
    // reapplied or a manual gearbox silently goes back to auto.
    this.sim.setAutoShift(this.autoShift);

    // The tachometer's maxRpm comes from the engine profile's own redline.
    const p = this.sim.profile;
    if (p && p.redlineRpm) this.maxRpm = p.redlineRpm;

    this._retuneLaunch();
  }

  // Re-derives launch constants for the car and engine now fitted: engine_sim
  // computes `launchRate` once from the preset it was built with, so every car
  // after the first launched to somebody else's schedule.
  _retuneLaunch() {
    const p = this.sim && this.sim.physics;
    const eng = this.sim && this.sim.profile;
    if (!p || !eng || !p.ratios || !p.ratios.length) return;

    //   F = T·ratio1·eff/r ,  a = F/m ,  d(gearedRpm)/dt = (a/r)·ratio1·60/2pi
    const ratio1 = Math.abs(p.ratios[0] * p.fd) || 1;
    const accel = (eng.peakTorque * ratio1 * p.eff) / p.r / Math.max(1, p.vehicle.mass);
    const gearedRate = (accel / p.r) * ratio1 * (60 / (2 * Math.PI));
    p.launchRate = Math.min(12000, Math.max(400, gearedRate * LAUNCH_RATE_FRAC));

    // Holding rpm scales off the engine's own span, so a launch sounds like that
    // engine doing it rather than like one number. A quarter of the span: at
    // 45 % the clutch slipped to ~40 km/h in first and the revs ran ahead of the car.
    p.launchFlareRpm = Math.max(700, (eng.redlineRpm - eng.idleRpm) * 0.25);
  }

  /**
   * The world around the engine, for engine_sim's live inputs (inputs.js):
   * listener distance, enclosure and strain, all 0..1. Smoothed here so a
   * camera cut or a crest does not step the sound. Older engine_sim builds
   * without `setInputs` simply ignore it.
   */
  setSurroundings(dt, { distance = 0, environment = 0, strain = 0 }) {
    if (!this.sim || !this.sim.setInputs) return;
    const s = this._surr || (this._surr = { distance, environment, strain });
    const k = 1 - Math.exp(-4 * dt);
    s.distance += (distance - s.distance) * k;
    s.environment += (environment - s.environment) * k * 0.5;
    s.strain += (strain - s.strain) * k;
    this.sim.setInputs(s);
  }

  /**
   * The driven wheel, once per drivetrain sub-step (0.5 ms), against the
   * propshaft torque. Gripping, it turns with the road and passes the axle
   * torque to the car; when that torque exceeds what the tyres can carry it
   * breaks away and spins on its own inertia until the slip closes again.
   */
  _stepWheel(h, Tp) {
    const p = this.sim.physics;
    const Taxle = Tp > 0 ? Tp * p.fd * p.eff : Tp * p.fd;
    const Tgrip = this._grip * p.r;
    const g = this._groundW;
    let w = p.ww, Troad;
    if (this._spinning) {
      const s0 = w - g;
      Troad = Math.sign(s0) * Tgrip * KINETIC;
      w += (h * (Taxle - Troad)) / this._Jw;
      // Slip closed through zero: the tyre has hooked up again.
      if ((w - g) * s0 <= 0) { w = g; this._spinning = false; }
    } else if (Math.abs(Taxle) > Tgrip) {
      this._spinning = true;
      Troad = Math.sign(Taxle) * Tgrip * KINETIC;
      w = g + (h * (Taxle - Troad)) / this._Jw;
    } else {
      Troad = Taxle;
      w = g;
    }
    p.ww = w;
    this._fSum += (Troad / p.r) * h;
    this._tSum += h;
  }

  /**
   * One simulator step per rendered frame; the force it returns is held across
   * the physics substeps that follow. The drivetrain sub-steps at 0.5 ms.
   *
   * state: { wheelSpeed (m/s along the car, + forward), throttle, brake,
   *          reverse, neutral, grip (N the driven tyres can transmit; omitted = unlimited) }
   */
  update(dt, state) {
    if (!this.sim) return 0;

    const V = this._car.V;
    const p = this.sim.physics;

    // Neutral (the title screen and garage) lets the engine rev freely.
    // Reverse is first gear driven backwards: the automatic is suspended so it
    // cannot change up, and the road speed is mirrored so the drivetrain sees
    // ordinary forward motion.
    this.reverse = state.reverse && !state.neutral;
    if (state.neutral) {
      if (p.gear !== 0) p.selectGear(0);
    } else if (this.reverse) {
      if (!this._revHeld) {
        this._revHeld = true;
        this.sim.setAutoShift(false);
        this._spinning = false;
      }
      if (p.gear !== 1 && !p.shifting) p.selectGear(1);
    } else {
      if (this._revHeld) {
        this._revHeld = false;
        this.sim.setAutoShift(this.autoShift);
        this._spinning = false;
      }
      if (p.gear === 0 && !p.shifting) p.selectGear(1);
    }

    const dir = this.reverse ? -1 : 1;
    this._groundW = (dir * state.wheelSpeed) / V.wheelRadius;
    this._grip = state.grip != null ? Math.max(0, state.grip) : Infinity;
    this._fSum = 0;
    this._tSum = 0;

    // The driver's pedal, as the engine gets it: traction control trims it on
    // last frame's wheelspin; reverse is speed-limited.
    const cut = this.tractionControl ? smoothstep(TC_FROM, TC_TO, Math.abs(this.wheelSlip)) : 0;
    this._tc += (cut - this._tc) * (1 - Math.exp(-TC_RATE * dt));
    let throttle = state.throttle * (1 - TC_DEPTH * this._tc);
    if (this.reverse) throttle *= 1 - smoothstep(REVERSE_FROM, REVERSE_TO, Math.abs(state.wheelSpeed));

    this.sim.setThrottle(throttle);
    this.sim.setBrake(state.brake);
    this.sim.update(dt);

    this._stallUpshift(dt, p, throttle);

    const params = (this.params = this.sim._lastParams);
    this.rpm = p.rpm;
    this.gear = p.gear;
    this.load = params ? params.load : 0;
    this.limiter = p.limiterCut > 0;
    this.wheelSlip = dir * (p.ww - this._groundW) * V.wheelRadius;
    // A hard launch slips the clutch at high revs. The drivetrain keeps that
    // slip in the clutch; the car shows it at the tyres (smoke, marks, squeal).
    const ratio = params ? Math.abs(params.gearRatio) : 0;
    // Pulling away only: a clutch slipping after a shift at speed is not a launch.
    this.launchSlip = ratio > 0 && !params.shiftPhase && throttle > 0.3
      ? dir * throttle * Math.max(0, params.clutchSlip) * (Math.PI / 30) / ratio * V.wheelRadius
        * (1 - smoothstep(6, 16, Math.abs(state.wheelSpeed)))
      : 0;

    // What the tyres put down this frame, averaged over the drivetrain's sub-steps.
    const force = this._tSum > 0 ? (dir * this._fSum) / this._tSum : 0;
    this.force = Number.isFinite(force) ? force : 0;
    return this.force;
  }

  // Changes up when the engine is at the top of its range and nothing is
  // happening — see STALL_FRAC for why this exists.
  _stallUpshift(dt, p, throttle) {
    this._stallCool = Math.max(0, this._stallCool - dt);
    const redline = (this.sim.profile && this.sim.profile.redlineRpm) || this.maxRpm;
    const rate = Math.abs(p.rpm - this._prevRpm) / Math.max(dt, 1e-4);
    this._prevRpm = p.rpm;

    const eligible =
      this.autoShift && !p.shifting && this._stallCool <= 0 &&
      p.gear >= 1 && p.gear < p.gearCount &&
      !this.reverse && !this._spinning &&
      throttle > 0.7 && p.rpm > redline * STALL_FRAC && rate < STALL_RATE;

    if (!eligible) {
      this._stallFor = 0;
      return;
    }
    this._stallFor += dt;
    if (this._stallFor < STALL_TIME) return;
    this._stallFor = 0;
    this._stallCool = STALL_COOLDOWN;
    this.sim.shiftUp();
  }

  // A throttle blip, for the garage; shaped as a single hump so it sounds like a
  // driver blipping the pedal rather than a step input.
  blip(seconds = 0.85) {
    this._blip = seconds;
    this._blipFor = seconds;
  }

  blipThrottle(dt) {
    if (!this._blip || this._blip <= 0) return 0;
    this._blip -= dt;
    const t = 1 - Math.max(0, this._blip) / this._blipFor;
    return Math.sin(Math.min(1, t) * Math.PI) ** 0.7;
  }

  // Gear label for the HUD.
  gearLabel() {
    if (this.reverse) return 'R';
    if (!this.sim || this.gear === 0) return 'N';
    return String(this.gear);
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.sim) this.sim.setVolume(muted ? 0 : this.volume);
    return this.muted;
  }

  toggleMute() {
    return this.setMuted(!this.muted);
  }

  suspend() {
    if (this.sim && this.sim.ctx && this.sim.ctx.state === 'running') this.sim.ctx.suspend();
  }

  resume() {
    if (this.sim && this.sim.ctx && this.sim.ctx.state === 'suspended') this.sim.ctx.resume();
  }

  dispose() {
    if (this.sim) this.sim.dispose();
    this.sim = null;
    this.ready = false;
  }
}
