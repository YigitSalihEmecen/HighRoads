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
 * Launch authority.
 *
 * engine_sim's launch controller models a driver feeding a clutch: it slips,
 * watches ROAD SPEED catch the crank, and takes the slip out as the car gets
 * going. That is right for a car, and it is exactly wrong for the one case this
 * game creates constantly — a car that cannot get going. `_stepVehicle` is
 * overridden here, so the drivetrain never sees the load on the wheels; it only
 * sees that wheel speed is not rising. A stationary car therefore leaves
 * `geared` pinned at zero, the demanded rpm never moves, and the clutch sits
 * half open transmitting a fraction of what the engine makes — forever.
 *
 * Measured with the drivetrain stepped against a pinned wheel speed, full
 * throttle, first gear, on the nine-car roster:
 *
 *     manual / DCT cars   5.0 – 8.4 m/s^2 for the first 0.6 s
 *     torque-converter autos  12 – 17 m/s^2 essentially at once
 *
 * and at a third throttle the manual cars plateau at 1.3 – 2.8 m/s^2 and stay
 * there. Gravity here is 16 m/s^2, so a 10% grade costs 1.6 m/s^2: that plateau
 * is a car that cannot pull away up a slope, which is the reported symptom, and
 * the difference between the two rows is the clutch model rather than the
 * engine.
 *
 * The fix is on this side of the bridge, where it belongs. Below `LAUNCH_FADE`
 * the host asserts a floor on drive force: what first gear can actually deliver
 * at the engine's own torque, scaled by the pedal. It is a FLOOR, not a
 * replacement — above it the simulator's number wins, so gear ratios, boost,
 * lash and engine braking all still come from the drivetrain — and it fades out
 * completely by walking-to-jogging speed, so nothing above a standing start is
 * touched. The tyres still have the last word: the force goes through the same
 * friction circle and traction control as any other, so this cannot conjure
 * grip, only stop the clutch model from being the thing that limits a launch.
 */
/** Road speed, m/s, by which the floor has faded to nothing. */
const LAUNCH_FADE = 7.0;
/**
 * Fraction of peak engine torque the floor assumes is available. Peak torque is
 * not on tap at idle; 0.72 is roughly what `torqueFactor` returns a little above
 * idle for the roster's engines, so the floor stays inside what the engine could
 * really make rather than inventing torque.
 */
const LAUNCH_TORQUE_FRAC = 0.72;
/**
 * Wind-up rate cap for the simulator's own launch ramp, as a multiple of the
 * rate the car will sustain in first. engine_sim derives this once in its
 * constructor from the preset it was built with and never revisits it, so
 * across the roster it was out by up to 2x in both directions — the Muscle car
 * was being wound up at twice the rate it could pull and the Hatchback at three
 * quarters of it. `setCar` recomputes it for the car actually on screen.
 */
const LAUNCH_RATE_FRAC = 0.9;

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
    //
    // `mechanical` is OFF, and deliberately so. That layer is engine_sim's
    // MechanicalLayer — valvetrain clatter, injector clicks, timing-chain
    // chordal action and block bending modes, all of it built from pink noise
    // through band-passes. On a real car those are quiet details you notice
    // standing beside the bonnet; through a chase camera at 200 km/h, over a
    // whole session, the band-passed noise is just a broadband hiss sitting on
    // top of the note. Nothing else depends on it: the clunks, lash impacts and
    // shift bangs are the `transients` bus, which stays.
    //
    // Gearbox whine also goes shrill at high rpm, so it stays low; sub and
    // exhaust carry the weight instead.
    this.mix = { exhaust: 1.0, intake: 0.6, mechanical: 0.0, transmission: 0.22,
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

    this._retuneLaunch();
  }

  /**
   * Re-derives the drivetrain's launch constants for the car and engine now
   * fitted. See LAUNCH_RATE_FRAC: engine_sim computes `launchRate` once, in its
   * constructor, from whichever preset it happened to be built with, and
   * neither `setVehicle` nor `setEngine` revisits it — so every car after the
   * first was being launched to somebody else's schedule. Both fields are read
   * live inside its launch controller, so writing them is enough; engine_sim
   * itself stays untouched, as with `_stepVehicle`.
   */
  _retuneLaunch() {
    const p = this.sim && this.sim.physics;
    const eng = this.sim && this.sim.profile;
    if (!p || !eng || !p.ratios || !p.ratios.length) return;

    //   F = T·ratio1·eff/r ,  a = F/m ,  d(gearedRpm)/dt = (a/r)·ratio1·60/2pi
    const ratio1 = Math.abs(p.ratios[0] * p.fd) || 1;
    const accel = (eng.peakTorque * ratio1 * p.eff) / p.r / Math.max(1, p.vehicle.mass);
    const gearedRate = (accel / p.r) * ratio1 * (60 / (2 * Math.PI));
    p.launchRate = Math.min(12000, Math.max(400, gearedRate * LAUNCH_RATE_FRAC));

    // How far above idle the driver holds it while the clutch takes up. A flat
    // 2400 rpm is most of the usable range on a 4600 rpm diesel and a third of
    // it on a 9500 rpm twin — scaling it off the engine's own span makes a
    // launch sound like the engine doing it rather than like one number.
    p.launchFlareRpm = Math.max(900, (eng.redlineRpm - eng.idleRpm) * 0.45);
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
    } else if (!state.neutral) {
      force = Math.max(force, this._launchFloor(p, state.throttle, state.wheelSpeed));
    }

    this.force = Number.isFinite(force) ? force : 0;
    return this.force;
  }

  /**
   * Floor on drive force at a standing start. See LAUNCH_FADE for the whole
   * argument; the short version is that the drivetrain's clutch model cannot
   * see the load on the wheels, so left alone it is what limits a launch.
   *
   * Returns 0 the moment the car is moving, or out of first, or off the pedal —
   * so this is a launch aid and nothing else. It also cannot exceed what the
   * engine makes: the ceiling is `LAUNCH_TORQUE_FRAC` of peak torque through
   * the gear actually selected.
   *
   * @returns {number} newtons at the contact patch, never negative
   */
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
