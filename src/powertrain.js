/**
 * powertrain.js — the engine simulator wired in as the drivetrain.
 *
 * engine_sim owns gear, rpm and torque. The game vehicle supplies wheel
 * speed; the bridge returns the torque the physics applies. One source of
 * truth keeps the audio with the car.
 */

import { EngineSim } from '../engine_sim/src/engine-sim.js';

// Air density for converting the simulator's drag area.
const RHO_AIR = 1.225;

// Stall upshift: near redline, throttle open, rpm plateaued — the simulator
// never reaches its threshold with an underpowered engine in a heavy car.
const STALL_FRAC = 0.86;    // of redline
const STALL_RATE = 220;     // rpm/s below which the engine counts as plateaued
const STALL_TIME = 0.7;     // s it must persist
const STALL_COOLDOWN = 1.2; // s before it may fire again

// Launch authority: `_stepVehicle` is overridden so the drivetrain never sees
// the load on the wheels, which leaves the clutch model stuck half open at a
// standing start. Below LAUNCH_FADE the host asserts a floor on drive force.
const LAUNCH_FADE = 7.0;
// Peak torque is not on tap at idle; 0.72 is roughly what `torqueFactor`
// returns just above idle for the roster's engines.
const LAUNCH_TORQUE_FRAC = 0.72;
// engine_sim derives `launchRate` once from the preset it was built with;
// `setCar` recomputes it via `_retuneLaunch` for the car actually on screen.
const LAUNCH_RATE_FRAC = 0.9;

// Builds a drivetrain profile from the car's own derived parameters, so the
// simulator's inertias and ratios describe the vehicle actually on screen.
function vehicleProfile(V, spec) {
  // Our ratio table carries reverse at 0 and neutral at 1; the simulator wants
  // forward ratios only, indexed from first.
  const forward = V.gearRatios.slice(2);

  // Deriving gear teeth from each ratio reproduces the whine ordering real
  // gearsets have (fewer teeth as the ratio shortens).
  const gearTeeth = forward.map((r) => Math.max(16, Math.min(46, Math.round(12 + r * 7.5))));

  return {
    label: spec.name,
    mass: V.mass,
    wheelRadius: V.wheelRadius,
    finalDrive: V.finalDrive,
    gearRatios: forward,
    gearTeeth,
    gearbox: spec.gearbox || 'auto',
    shiftTimeMs: spec.shiftTimeMs || 160,

    // These feed the simulator's own vehicle integration, which we replace
    // below. Kept physically sensible anyway so nothing reads a nonsense value:
    // our drag coefficient is the lumped 0.5·ρ·Cd·A, the simulator wants Cd·A.
    dragArea: V.dragCoefficient / (0.5 * RHO_AIR),
    rollingResistance: 0.014,
    brakeForce: V.brakeForce.reduce((a, b) => a + b, 0),
  };
}

export class Powertrain {
  constructor() {
    this.sim = null;
    this.ready = false;
    this.muted = false;
    this.volume = 0.62;

    // Wheel angular velocity handed to the drivetrain, rad/s.
    this._ww = 0;
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
    this._ww = 0;
    this.force = 0;
    this.reverse = false;
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

  // Any engine in any car. The drivetrain profile stays the car's own.
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
      volume: this.volume,
    });

    // Hand the wheels over to the host. `_stepVehicle` is overridden per instance
    // so engine_sim stays intact and its own test suite keeps passing.
    const dt = this.sim.physics;
    dt._stepVehicle = () => {
      dt.ww = this._ww;
    };

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
    if (!this.sim) return;

    const profile = vehicleProfile(car.V, car.spec);
    this.sim.vehicle = profile;
    this.sim.vehicleId = car.spec.id;
    this.sim.physics.setVehicle(profile);
    if (this.sim.transmission && this.sim.transmission.setVehicle) {
      this.sim.transmission.setVehicle(profile);
    }
    this.sim.setEngineType(this.engineId());
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
    // engine doing it rather than like one number.
    p.launchFlareRpm = Math.max(900, (eng.redlineRpm - eng.idleRpm) * 0.45);
  }

  // One simulator step per rendered frame, then the torque is held across the
  // physics substeps that follow. The drivetrain sub-steps at 0.5 ms internally.
  update(dt, state) {
    if (!this.sim) return 0;

    const V = this._car.V;
    const p = this.sim.physics;

    // Reverse is not a gear the simulator has: the gearbox goes to neutral, the
    // engine idles against no load, and the host supplies a reversing force.
    // Neutral also covers the garage preview, where the engine revs freely.
    this.reverse = state.reverse;
    if (this.reverse || state.neutral) {
      if (p.gear !== 0) p.selectGear(0);
    } else if (p.gear === 0 && !p.shifting && this.autoShift) {
      p.selectGear(1);
    }

    // The wheels are driven by the game, not by the simulator's point mass.
    this._ww = state.wheelSpeed / V.wheelRadius;

    this.sim.setThrottle(state.throttle);
    this.sim.setBrake(state.brake);
    this.sim.update(dt);

    this._stallUpshift(dt, p, state.throttle);

    const params = (this.params = this.sim._lastParams);
    this.rpm = p.rpm;
    this.gear = p.gear;
    this.load = params ? params.load : 0;
    this.limiter = p.limiterCut > 0;

    // Propshaft torque → wheel torque → contact-patch force. Driveline efficiency
    // is charged on the driving side only; the same losses retard on the overrun.
    const Tp = p.Tp || 0;
    const wheelTorque = Tp > 0 ? Tp * p.fd * p.eff : Tp * p.fd;
    let force = wheelTorque / p.r;

    if (this.reverse) {
      // Neutral transmits nothing, so reverse gets its own simple term.
      force = -state.throttle * V.mass * 3.2;
    } else if (!state.neutral) {
      force = Math.max(force, this._launchFloor(p, state.throttle, state.wheelSpeed));
    }

    this.force = Number.isFinite(force) ? force : 0;
    return this.force;
  }

  // Floor on drive force at a standing start — see LAUNCH_FADE. Returns 0 the
  // moment the car moves, leaves first, or the pedal is off, and never exceeds
  // LAUNCH_TORQUE_FRAC of peak torque through the gear actually selected.
  _launchFloor(p, throttle, wheelSpeed) {
    if (!(throttle > 0.02) || p.gear !== 1 || p.shifting) return 0;

    const speed = Math.abs(wheelSpeed);
    if (speed >= LAUNCH_FADE) return 0;
    // Linear fade: at rest the floor is fully in, by LAUNCH_FADE it is gone.
    const fade = 1 - speed / LAUNCH_FADE;

    const eng = this.sim.profile;
    const ratio = Math.abs(p.ratios[0] * p.fd);
    if (!eng || !(ratio > 0)) return 0;

    const torque = eng.peakTorque * LAUNCH_TORQUE_FRAC * throttle;
    return (torque * ratio * p.eff) / p.r * fade;
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
