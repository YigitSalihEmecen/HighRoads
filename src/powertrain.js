/**
 * powertrain.js — the engine simulator, wired in as the car's actual drivetrain.
 *
 * This replaces the previous hand-rolled synth *and* the previous torque model.
 * Doing only one of those would have been worse than doing neither: a sound
 * simulator running its own drivetrain alongside the game's produces an engine
 * note for a car that isn't the one you're driving — its rpm, its gear and its
 * shifts all drift away from what the wheels are doing.
 *
 * So the simulator owns the powertrain outright:
 *
 *        game (raycast vehicle)                  engine_sim (Drivetrain)
 *        ──────────────────────                  ───────────────────────
 *        forward speed  ─────────────────────▶   wheel omega  ω_w
 *                                                     │ torsional spring
 *                                                     │ + backlash
 *                                                     ▼
 *        drive force    ◀─────────────────────   propshaft torque  Tp
 *
 * Each frame the real wheel speed — from Rapier, over actual terrain, including
 * wheelspin and airtime — is written into the drivetrain, and the torque the
 * driveline transmits back is handed to the tyre model as drive force. The
 * simulator's compliant driveline is then not a decoration on top of the game;
 * it *is* the game's driveline, so lash clunks, shuffle, clutch slip and engine
 * braking are all things the car does rather than things you merely hear.
 *
 * The one piece deliberately left to the host is the tyre contact patch. The
 * simulator's own `_stepVehicle` integrates a point-mass car with lumped drag
 * and braking; we already model all of that per wheel with a friction circle,
 * so that method is overridden to stop it double-counting.
 */

import { EngineSim } from '../engine_sim/src/engine-sim.js';

/** Air density used by the simulator's drag term, for unit conversion. */
const RHO_AIR = 1.225;

/**
 * Stall upshift.
 *
 * The simulator's automatic upshifts on rpm, which is right for an engine and a
 * gearbox that were designed for each other. This game lets any engine go in any
 * car, and the drivetrain deliberately stays the CAR's — so a 1.2 litre V-twin
 * ends up pulling a 1180 kg sports car through a 3.62 first gear. Measured, it
 * asymptotes at 8790 rpm and 82 km/h and never reaches the upshift threshold at
 * all: not slow, stuck. Forcing the shift by hand took it straight to 107 km/h,
 * because second gear puts the engine back where it makes torque.
 *
 * So: near the top of the rev range, with the throttle open, making no further
 * progress — change up. A real automatic does exactly this; it shifts when
 * acceleration stops, not only when the tachometer says so. Every combination
 * that pulls properly reaches its normal upshift long before this can fire.
 */
const STALL_FRAC = 0.86;    // of redline
const STALL_RATE = 220;     // rpm/s below which the engine counts as plateaued
const STALL_TIME = 0.7;     // s it must persist
const STALL_COOLDOWN = 1.2; // s before it may fire again

/**
 * Builds a drivetrain profile from a car's own derived parameters, so the
 * simulator's inertias and ratios describe the vehicle actually on screen
 * rather than one of its five built-in presets.
 */
function vehicleProfile(V, spec) {
  // Our ratio table carries reverse at 0 and neutral at 1; the simulator wants
  // forward ratios only, indexed from first.
  const forward = V.gearRatios.slice(2);

  // Gear-mesh whine frequency is tooth count × shaft speed. Real gearsets use
  // fewer teeth as the ratio shortens, which is why each gear whines at its own
  // pitch; deriving from the ratio reproduces that ordering.
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

    /** Wheel angular velocity handed to the drivetrain, rad/s. */
    this._ww = 0;
    /** Longitudinal force at the contact patch, newtons. */
    this.force = 0;

    // Mirrors of simulator state, so the HUD and the rest of the game never
    // have to reach into engine_sim internals.
    this.rpm = 0;
    this.maxRpm = 7000;
    this.gear = 1;
    this.load = 0;
    this.limiter = false;
    this.reverse = false;
    this.params = null;

    this._car = null;
    /** Stall-upshift bookkeeping. See STALL_FRAC. */
    this._stallFor = 0;
    this._stallCool = 0;
    this._prevRpm = 0;
    /** 'stock' follows the car's own engine; anything else overrides it. */
    this.engineChoice = 'stock';
    /** Gearbox mode. Manual holds the gear until the driver asks. */
    this.autoShift = true;
    /** Mix levels, mirrored so the UI can read them back. */
    // Gearbox whine and the mechanical layer are the two that go shrill at
    // high rpm, so both come down; sub and exhaust carry the weight instead.
    this.mix = { exhaust: 1.0, intake: 0.6, mechanical: 0.34, transmission: 0.22,
                 turbo: 0.5, transients: 0.4, sub: 1.0 };
    this.tone = { rumble: 1.1, brightness: 0.72 };
    /** Three-band compressor amount: 0 bypasses it, 1 is the simulator's tune. */
    this.dynamics = 1;
    /**
     * Five-band EQ, in dB, applied on top of the simulator's own voicing:
     * 60 sub, 200 body, 800 honk, 2.5k rasp, 8k air.
     *
     * Some engines in the roster put a lot of energy around 800 Hz and 2.5 kHz
     * at particular revs — a V10 or flat-plane V8 near its peak lands harmonics
     * right in the band the ear is most sensitive to, and it turns shrill. The
     * cut is static rather than dynamic because the offending band is a
     * property of the voicing, not of the moment.
     */
    this.eq = [1.5, 1.0, -5.5, -6.5, -3.5];
  }

  // ---------------------------------------------------------- gearbox ----

  setAutoShift(on) {
    this.autoShift = !!on;
    if (this.sim) this.sim.setAutoShift(this.autoShift);
    return this.autoShift;
  }

  /** Returns false if the simulator refused (it guards against over-revving). */
  shiftUp() {
    return this.sim ? this.sim.shiftUp() !== false : false;
  }

  shiftDown() {
    return this.sim ? this.sim.shiftDown() !== false : false;
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

  /** Any engine in any car. The drivetrain profile stays the car's own. */
  setEngine(id) {
    this.engineChoice = id || 'stock';
    if (this._car) this.setCar(this._car);
    return this.engineId();
  }

  engineId() {
    const stock = (this._car && this._car.spec.engine) || 'i4';
    return this.engineChoice === 'stock' ? stock : this.engineChoice;
  }

  /**
   * Must be called from a user gesture — Web Audio will not start otherwise.
   * `audioContext` is optional and exists so the whole drivetrain can be
   * exercised headlessly against engine_sim's own Web Audio mock.
   */
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

    // Hand the wheels over to the host before anything steps. `_stepVehicle` is
    // overridden per instance rather than by editing engine_sim, so that project
    // stays intact and its own test suite keeps passing.
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
    // Dynamics are the simulator's job now.
    //
    // This used to reach into `sim.comp` — a single full-range compressor — and
    // pull its threshold down to tame the transient peaks that read as
    // "overblown" at high rpm. That node no longer exists: the simulator now
    // runs a three-band compressor whose high band (above 2 kHz) sits at a
    // -30 dB threshold with 5:1 and a 2 ms attack, which is the same problem
    // solved properly rather than by squashing the whole mix to reach it.
    //
    // Its default is the tuned setting, so the correct migration is to ask for
    // exactly that and stop hand-tuning. `sim.comp` was behind an `if`, so had
    // this been left alone it would simply have stopped doing anything the day
    // the submodule moved — silently, which is the worst way for it to go.
    this.sim.setDynamics(this.dynamics);
    this.ready = true;
    this.setMuted(this.muted);
  }

  /** Reconfigures the simulator for a different vehicle from the roster. */
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
    // reapplied or swapping car silently puts a manual gearbox back into auto.
    this.sim.setAutoShift(this.autoShift);

    // maxRpm for the tachometer comes from the engine profile, not our config,
    // now that the engine is a real profile with its own redline.
    const p = this.sim.profile;
    if (p && p.redlineRpm) this.maxRpm = p.redlineRpm;
  }

  /**
   * One simulator step per rendered frame, then the resulting torque is held
   * constant across the physics substeps that follow. The drivetrain sub-steps
   * internally at 0.5 ms, so it is not the thing being under-sampled here.
   *
   * @returns {number} longitudinal force at the contact patch, newtons
   */
  update(dt, state) {
    if (!this.sim) return 0;

    const V = this._car.V;
    const p = this.sim.physics;

    // Reverse is not a gear the simulator has. Rather than fake one, the
    // gearbox goes to neutral — the engine idles and revs against no load,
    // which is honest — and the host supplies a modest reversing force itself.
    // Neutral is used for two things: reverse (which the simulator has no gear
    // for, so the engine idles honestly against no load and the host supplies a
    // reversing force) and the garage preview, where the car is parked and the
    // point is to hear the engine rev freely rather than bog against a stopped
    // driveline.
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

    // Propshaft torque → wheel torque → contact-patch force. Driveline
    // efficiency is charged on the driving side only; on the overrun those same
    // losses help retard the car, so applying it there would double-count.
    const Tp = p.Tp || 0;
    const wheelTorque = Tp > 0 ? Tp * p.fd * p.eff : Tp * p.fd;
    let force = wheelTorque / p.r;

    if (this.reverse) {
      // Neutral transmits nothing, so reverse gets its own simple term.
      force = -state.throttle * V.mass * 3.2;
    }

    this.force = Number.isFinite(force) ? force : 0;
    return this.force;
  }

  /**
   * Changes up when the engine is at the top of its range, the driver is asking
   * for more, and nothing is happening. See STALL_FRAC for why this exists.
   */
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

  /**
   * A throttle blip, for the garage. Returns the throttle to feed this frame;
   * shaped as a single hump so it sounds like a driver blipping the pedal
   * rather than a step input.
   */
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

  /** Gear label for the HUD. */
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
