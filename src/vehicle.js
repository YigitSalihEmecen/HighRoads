/**
 * vehicle.js — a raycast vehicle controller built on top of a Rapier rigid body.
 *
 * Rapier provides exactly three things here: a rigid body with a mass/inertia
 * tensor, an impulse API, and a ray query against the terrain trimeshes. The
 * chassis collider exists only so a genuine crash has something to hit — it is
 * excluded from every suspension ray and plays no part in normal driving. All
 * of the vehicle dynamics below are hand-rolled.
 *
 * PER WHEEL, PER SUBSTEP:
 *
 *   1. SUSPENSION.  Cast a ray from the wheel anchor down the chassis' local
 *      -Y. Compression x = (restLength + radius) - hitDistance, and the spring
 *      is Hooke plus a viscous damper:
 *
 *          F = k·x  +  c·ẋ          ẋ = -(contact point velocity · up)
 *
 *      with separate bump/rebound damping (rebound stiffer, as on a real car)
 *      and a force ceiling so a hard landing can't launch the chassis.
 *      Because the force is colinear with the ray, applying it at the contact
 *      patch or at the anchor produces identical torque — we use the contact.
 *
 *   2. ANTI-ROLL.  Per axle, the normalised travel difference between left and
 *      right pushes the compressed corner up and the extended corner down. This
 *      adjusts the stored wheel *load*, so lateral grip responds to weight
 *      transfer rather than merely resisting body roll cosmetically.
 *
 *   3. TYRE FORCES.  Build a wheel frame (Ackermann-steered forward × contact
 *      normal), project the contact-point velocity into it, then:
 *         lateral      — a slip-angle Magic Formula, Fy = D·sin(C·atan(B·α)).
 *                        Force builds with slip angle, peaks around 8°, then
 *                        eases off. That falloff is the feel of the front axle
 *                        going light; below walking pace it blends to plain
 *                        velocity cancellation, where slip angle is undefined.
 *         longitudinal — engine force through the gearbox, minus braking and
 *                        rolling resistance, with traction control capping
 *                        drive at the friction left over after cornering.
 *      Both are then clipped to a friction circle of radius μ·Fz·dt, which is
 *      what makes power oversteer, lock-ups and understeer emerge on their own
 *      instead of being special-cased.
 *
 *      Forces are applied slightly *above* the contact patch. Weight transfer
 *      survives; the roll moment that would otherwise trip the car does not.
 */

import * as THREE from 'three';
import { WORLD } from './config.js';
import { clamp, lerp, sign, smoothstep, moveTowards } from './util.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);

export class RaycastVehicle {
  /**
   * @param {object}  opts.params  full parameter set from cars.buildCarParams —
   *                               geometry measured from the model, rates
   *                               derived from mass. Held per instance as
   *                               `this.V`, never read from module config.
   * @param {object}  opts.model   { body, wheels } from assets.loadCarModel
   */
  constructor({ RAPIER, world, scene, params, model }) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.scene = scene;
    this.V = params;
    this.model = model;

    this._buildBody();
    this._buildWheels();
    this._buildVisuals(model);

    // ---- driver-facing state -------------------------------------------
    this.steer = 0;
    this.driveForce = 0;
    /** Driver has selected reverse; the simulator idles in neutral. */
    this.reverse = false;
    /** 0 on tarmac, 1 fully on the verge. */
    this.offRoad = 0;
    this.headlightsOn = false;
    this._beams = null;
    this.speed = 0;
    this.forwardSpeed = 0;
    this.groundedCount = 0;
    this.slip = 0;        // 0..1, drives skid audio and drift feedback

    this.upsideDownFor = 0;

    /** Pinned in place for the title screen — see setParked. */
    this.parked = false;
    this.parkedQuat = new THREE.Quaternion();
    this.parkedPos = new THREE.Vector3();

    // ---- scratch (reused every substep; the physics loop allocates zero) --
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.linvel = new THREE.Vector3();
    this.angvel = new THREE.Vector3();
    this.com = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.fwd = new THREE.Vector3(0, 0, -1);
    this.rightV = new THREE.Vector3(1, 0, 0);

    this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this._rayFilter =
      (RAPIER.QueryFilterFlags && RAPIER.QueryFilterFlags.EXCLUDE_SENSORS) || undefined;
    // Suspension rays must see the world but NOT other cars. Membership bit 0,
    // mask everything except traffic's bit 1. Without this the springs find
    // "ground" on a traffic car's roof during a collision and throw the player
    // ten metres into the air — the same launch bug as before, via a different
    // route now that traffic cars are solid rather than sensors.
    this._rayGroups = (0x0001 << 16) | 0xfffd;
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._c = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._e = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();

    // ---- render interpolation -------------------------------------------
    // Physics advances in fixed 8.33 ms steps but frames arrive on the display's
    // clock, so at the moment we draw, the simulation is somewhere *between*
    // two steps. Drawing the raw body state instead snaps the car to whichever
    // step happened last, which at 60 m/s is a ~0.5 m jump every frame — the
    // stutter reads as the car teleporting. We keep the previous step's
    // transform and blend by the leftover accumulator.
    this.prevPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion();
    this.prevSteer = 0;
    this.hasPrev = false;

    /** Interpolated transform — what the camera and the meshes should use. */
    this.renderPos = new THREE.Vector3();
    this.renderQuat = new THREE.Quaternion();
    this.renderUp = new THREE.Vector3(0, 1, 0);
    this.renderFwd = new THREE.Vector3(0, 0, -1);
    this.renderRight = new THREE.Vector3(1, 0, 0);
  }

  /**
   * Snapshot the transform about to be superseded. Must be called immediately
   * before each world.step(), so `prev` and the post-step state bracket exactly
   * one substep.
   */
  /**
   * Pins the car for the title screen.
   *
   * Horizontal velocity and all rotation are cancelled every step, while
   * vertical motion is left alone so the suspension still settles onto whatever
   * the ground is doing. Without this the car simply rolls away down the road
   * whenever the seed happens to put a gradient under it, and the player is
   * choosing a paint colour for something disappearing into the distance.
   */
  setParked(on) {
    this.parked = !!on;
    if (on) {
      const t = this.body.translation();
      const r = this.body.rotation();
      this.parkedPos.set(t.x, t.y, t.z);
      this.parkedQuat.set(r.x, r.y, r.z, r.w);
    }
  }

  beginStep() {
    if (this.parked) {
      // Velocity AND position. Zeroing the velocity alone leaves the drift that
      // accumulates inside each step — gravity acts, the solver integrates, and
      // the car creeps a few millimetres per step before the next reset catches
      // it. Measured on a 4.7% grade that was 11 cm in five seconds, which over
      // the time it takes to choose a car is the length of the bonnet. Height is
      // left alone so the suspension still settles onto the road.
      const t = this.body.translation();
      this.body.setTranslation({ x: this.parkedPos.x, y: t.y, z: this.parkedPos.z }, true);
      this.body.setLinvel({ x: 0, y: Math.min(0, this.body.linvel().y), z: 0 }, true);
      this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.body.setRotation(this.parkedQuat, true);
    }

    // A hard ceiling on how fast the chassis may be travelling, in any
    // direction, at the start of a step.
    //
    // Nothing in this game legitimately exceeds it — the fastest car tops out
    // well below. What does exceed it is a solver artefact: a deep contact
    // resolved in a single step can hand back hundreds of metres per second,
    // and the car leaves for the horizon and never comes back. Physically the
    // energy was never there, so removing it is a correction, not a cheat.
    const lv = this.body.linvel();
    const sp = Math.hypot(lv.x, lv.y, lv.z);
    if (sp > this.V.maxChassisSpeed) {
      const k = this.V.maxChassisSpeed / sp;
      this.body.setLinvel({ x: lv.x * k, y: lv.y * k, z: lv.z * k }, true);
    }
    const av = this.body.angvel();
    const aw = Math.hypot(av.x, av.y, av.z);
    if (aw > 12) {
      const k = 12 / aw;
      this.body.setAngvel({ x: av.x * k, y: av.y * k, z: av.z * k }, true);
    }

    const t = this.body.translation();
    const r = this.body.rotation();
    this.prevPos.set(t.x, t.y, t.z);
    this.prevQuat.set(r.x, r.y, r.z, r.w);
    this.prevSteer = this.steer;
    for (const w of this.wheels) {
      w.prevSuspLen = w.suspLen;
      w.prevSpin = w.spin;
    }
    this.hasPrev = true;
  }

  // ------------------------------------------------------------ rigid body --

  _buildBody() {
    const { RAPIER, world } = this;
    const { hx, hy, hz } = this.V.chassis;
    const m = this.V.mass;

    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 5, 0)
      .setLinearDamping(this.V.linearDamping)
      .setAngularDamping(this.V.angularDamping)
      .setCanSleep(false)
      .setCcdEnabled(true);

    // Solid-box inertia, with the roll axis inflated: a real car carries mass
    // high (engine, occupants, roof) so it resists roll more than a uniform
    // slab of the same footprint would.
    const w = hx * 2, h = hy * 2, l = hz * 2;
    const Ix = (m / 12) * (h * h + l * l);
    const Iy = (m / 12) * (w * w + l * l);
    const Iz = (m / 12) * (w * w + h * h) * 1.6;

    desc.setAdditionalMassProperties(
      m,
      this.V.comOffset,
      { x: Ix, y: Iy, z: Iz },
      { x: 0, y: 0, z: 0, w: 1 }
    );

    this.body = world.createRigidBody(desc);
    this.comLocal = new THREE.Vector3(
      this.V.comOffset.x,
      this.V.comOffset.y,
      this.V.comOffset.z
    );

    // Density 0: mass comes entirely from setAdditionalMassProperties above, so
    // the collider's shape doesn't quietly fight our chosen inertia tensor.
    // The body origin is the contact plane, so the box has to be raised to sit
    // around the actual bodywork rather than straddling the road surface.
    const col = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(0, this.V.chassisCentreY, 0)
      .setDensity(0)
      .setFriction(0.4)
      .setRestitution(0.05);
    this.collider = world.createCollider(col, this.body);
  }

  _buildWheels() {
    const V = this.V;
    const mk = (x, z, steered, rear) => ({
      local: new THREE.Vector3(x, V.anchorHeight, z),
      steered,
      rear,
      grounded: false,
      compression: 0,
      suspLen: V.restLength,
      prevSuspLen: V.restLength,
      load: 0,
      spin: 0,
      prevSpin: 0,
      slipLat: 0,
      slipAngle: 0,
      slipAmount: 0,
      contact: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      pointVel: new THREE.Vector3(),
    });

    // Order must match this.V.driveBias / brakeForce: FL, FR, RL, RR.
    this.wheels = [
      mk(-V.trackHalf, -V.wheelbaseHalf, true, false),
      mk(V.trackHalf, -V.wheelbaseHalf, true, false),
      mk(-V.trackHalf, V.wheelbaseHalf, false, true),
      mk(V.trackHalf, V.wheelbaseHalf, false, true),
    ];
  }

  _buildVisuals(model) {
    this.group = new THREE.Group();
    this.group.add(model.body);

    // Wheel order must match _buildWheels: FL, FR, RL, RR.
    this.wheelMeshes = ['FL', 'FR', 'BL', 'BR'].map((key) => {
      const mesh = model.wheels[key];
      this.group.add(mesh);
      return mesh;
    });

    this.scene.add(this.group);
  }

  /** Removes this vehicle from the scene and the physics world. */
  dispose() {
    this.scene.remove(this.group);
    this.world.removeRigidBody(this.body);
  }

  // ----------------------------------------------------------------- rays --

  /**
   * Wraps Rapier's ray query and papers over the field rename between
   * versions (`toi` became `timeOfImpact` in 0.14).
   */
  _castRay(origin, dir, maxToi) {
    this._ray.origin = origin;
    this._ray.dir = dir;

    const hit = this.world.castRayAndGetNormal(
      this._ray,
      maxToi,
      true,
      // Ray casts hit sensors unless told not to, and would otherwise find
      // "ground" on anything that happens to be alongside.
      this._rayFilter,
      this._rayGroups,
      undefined,
      this.body // never let a suspension ray hit our own chassis
    );
    if (!hit) return null;

    const toi = hit.timeOfImpact !== undefined ? hit.timeOfImpact : hit.toi;
    return { toi, normal: hit.normal };
  }

  // --------------------------------------------------------------- update --

  /** One physics substep. Called at the fixed rate, before world.step(). */
  update(dt, input) {
    this._readState();
    this._updateSteering(dt, input);

    const drive = this._resolveDirection(input);
    this._suspension(dt);
    this._antiRoll();
    this._tyres(dt, drive, input);
    this._aero(dt);
    this._stability(dt, input);
    this._integrateWheelSpin(dt, input);

    this.throttle = drive.throttle;
  }

  _readState() {
    const rb = this.body;
    const t = rb.translation();
    const r = rb.rotation();
    const lv = rb.linvel();
    const av = rb.angvel();

    this.pos.set(t.x, t.y, t.z);
    this.quat.set(r.x, r.y, r.z, r.w);
    this.linvel.set(lv.x, lv.y, lv.z);
    this.angvel.set(av.x, av.y, av.z);

    // World centre of mass — every point-velocity below is measured from here.
    this.com.copy(this.comLocal).applyQuaternion(this.quat).add(this.pos);

    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    this.fwd.set(0, 0, -1).applyQuaternion(this.quat);
    this.rightV.set(1, 0, 0).applyQuaternion(this.quat);

    this.speed = this.linvel.length();
    this.forwardSpeed = this.linvel.dot(this.fwd);
  }

  /**
   * Steering authority is derived from grip rather than from a hand-drawn
   * curve. For a steady-state turn v²/R = a_max, and Ackermann gives
   * R = L/tan(δ), so the largest angle the car can actually follow is
   *
   *     δ_max = atan( L · a_max / v² )
   *
   * a_max includes downforce, which genuinely raises the limit at speed. Let
   * the player exceed this and the front tyres are asked for more than they
   * have: the wheel turns, the car understeers straight on, and it feels
   * completely disconnected from its front axle. The grip margin keeps enough
   * headroom to still provoke a slide deliberately.
   */
  _updateSteering(dt, input) {
    const V = this.V;
    const L = V.wheelbaseHalf * 2;
    const v2 = Math.max(this.forwardSpeed * this.forwardSpeed, 1);
    const aGrip =
      V.tyreFriction *
      (Math.abs(WORLD.gravity) + (V.downforce * v2) / V.mass) *
      V.steerGripMargin;

    // Whichever limit arrives first: sliding, or tipping over. For a sports car
    // that is grip; for a van or a monster truck it is roll.
    const aMax = Math.min(aGrip, V.rolloverAccel);
    const gripSteer = Math.atan((L * aMax) / v2);

    // ...but the whole derivation assumes a STEADY-STATE turn, and once the car
    // is sideways that assumption is gone. In a slide the front wheels are being
    // pointed down the velocity vector, not used to generate more lateral force,
    // so neither the grip ceiling nor the rollover ceiling applies to them.
    //
    // Enforcing it anyway is what made a slide unrecoverable. Measured on the
    // old tune at 108 km/h, the rollover limit capped the lock at 4.3 deg — a
    // driver trying to catch a 190 deg/s spin had essentially no countersteer,
    // and none of it was their fault. Opening the lock toward full as the
    // chassis slip angle grows hands the car back, and costs nothing when
    // straight because the term is zero there.
    const beta = Math.abs(
      Math.atan2(this.linvel.dot(this.rightV), Math.max(Math.abs(this.forwardSpeed), 1))
    );
    const slide = smoothstep(V.slideOpenFrom, V.slideOpenTo, beta);
    // Proportional: a fixed multiple of the limit that already applied, never a
    // jump to full lock. The steering ratio stays continuous — the wheel means
    // the same thing throughout, there is just more of it to use.
    const base = clamp(gripSteer, V.minSteer, V.maxSteer);
    const opened = Math.min(V.maxSteer, base * V.slideLockGain);
    const maxSteer = lerp(base, opened, slide);

    // Scale the slew rate with the available lock so time-to-full-lock stays
    // roughly constant instead of snapping instantly at speed.
    const scale = clamp(maxSteer / V.maxSteer, 0.25, 1);
    const rate = (Math.abs(input.steer) < 0.05 ? V.steerReturnRate : V.steerRate) * scale;

    const target = input.steer * maxSteer;
    this.steer = clamp(moveTowards(this.steer, target, rate * dt), -maxSteer, maxSteer);
  }

  /**
   * Maps the two pedals onto the current gear. In reverse the pedals swap, so
   * "brake" still means "slow down" from the driver's point of view.
   */
  _resolveDirection(input) {
    const nearlyStopped = Math.abs(this.forwardSpeed) < 0.8;

    if (this.reverse) {
      if (input.throttle > 0.1 && this.forwardSpeed > -0.5) this.reverse = false;
    } else if (input.brake > 0.5 && nearlyStopped && input.throttle < 0.1) {
      this.reverse = true;
    }

    return this.reverse
      ? { throttle: input.brake, brake: input.throttle }
      : { throttle: input.throttle, brake: input.brake };
  }

  // ----------------------------------------------------------- suspension --

  _suspension(dt) {
    const V = this.V;
    const maxToi = V.restLength + V.wheelRadius;
    const down = this._a.copy(this.up).negate();

    this.groundedCount = 0;

    for (const w of this.wheels) {
      const anchor = this._b.copy(w.local).applyQuaternion(this.quat).add(this.pos);
      const hit = this._castRay(anchor, down, maxToi);

      if (!hit) {
        w.grounded = false;
        w.compression = 0;
        w.load = 0;
        // Droop to full extension so the wheel visibly hangs in the air.
        w.suspLen = V.restLength;
        continue;
      }

      w.grounded = true;
      this.groundedCount++;

      w.contact.copy(anchor).addScaledVector(down, hit.toi);
      w.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
      if (w.normal.dot(this.up) < 0) w.normal.negate();

      w.compression = clamp(maxToi - hit.toi, 0, V.restLength);
      w.suspLen = clamp(hit.toi - V.wheelRadius, 0, V.restLength);

      // Velocity of the contact point: v + ω × r
      const r = this._c.subVectors(w.contact, this.com);
      w.pointVel.copy(this.angvel).cross(r).add(this.linvel);

      // ẋ > 0 means the spring is compressing.
      const compressRate = -w.pointVel.dot(this.up);
      const damper = compressRate > 0 ? V.damperBump : V.damperRebound;

      // F = k·x + c·ẋ, one-sided: a suspension can push but never pull.
      w.load = clamp(V.springK * w.compression + damper * compressRate, 0, V.maxSpringForce);
    }
  }

  _antiRoll() {
    this._axleAntiRoll(0, 1, this.V.antiRollFront);
    this._axleAntiRoll(2, 3, this.V.antiRollRear);
  }

  _axleAntiRoll(iL, iR, k) {
    const a = this.wheels[iL];
    const b = this.wheels[iR];
    const tL = a.grounded ? a.compression / this.V.restLength : 0;
    const tR = b.grounded ? b.compression / this.V.restLength : 0;

    // The bar twists to resist the difference: it lifts the compressed corner
    // and pushes the extended one down.
    const f = (tL - tR) * k;
    if (a.grounded) a.load = Math.max(0, a.load + f);
    if (b.grounded) b.load = Math.max(0, b.load - f);
  }

  /** Applies the (post-anti-roll) suspension loads as impulses. */
  _applySuspension(dt) {
    for (const w of this.wheels) {
      if (!w.grounded || w.load <= 0) continue;
      const impulse = this._d.copy(this.up).multiplyScalar(w.load * dt);
      this.body.applyImpulseAtPoint(impulse, w.contact, true);
    }
  }

  // ----------------------------------------------------------- powertrain --

  /**
   * Drive force is no longer computed here. The engine simulator in
   * `powertrain.js` owns the whole driveline — torque curve, clutch, gearbox,
   * torsional compliance — and writes the resulting contact-patch force in via
   * `setDriveForce()` once per frame. What remains in this file is everything
   * from the tyre outwards.
   */
  setDriveForce(force) {
    this.driveForce = Number.isFinite(force) ? force : 0;
  }

  /**
   * How much of the car is off the asphalt, 0..1. Set once per frame by the
   * game, which is the only thing that knows where the road is.
   */
  setSurface(offRoad) {
    this.offRoad = clamp(offRoad, 0, 1);
  }

  /**
   * Head lamps: emissive on the lamp faces plus two spot lights that actually
   * throw light down the road. Built lazily, because a car that never turns
   * them on should not pay for two shadowless spots in the scene graph.
   */
  setHeadlights(on, flash) {
    this.headlightsOn = on;
    if (this.model && this.model.setHeadlights) this.model.setHeadlights(on, flash);

    if (!this._beams && (on || flash)) {
      this._beams = [];
      const m = this.V;
      for (const side of [-1, 1]) {
        const spot = new THREE.SpotLight(0xfff2d6, 0, 130, 0.42, 0.45, 1.1);
        spot.position.set(side * m.trackHalf * 0.72, m.bodyHeight * 0.45, -m.wheelbaseHalf - 0.6);
        spot.target.position.set(side * m.trackHalf * 0.5, -0.6, -40);
        this.group.add(spot);
        this.group.add(spot.target);
        this._beams.push(spot);
      }
    }
    if (this._beams) {
      const power = flash ? 9 : on ? 5 : 0;
      for (const b of this._beams) b.intensity = power;
    }
  }

  /** Drives the rear lamps. 0 = coasting glow, 1 = full brake. */
  setBrakeLight(t) {
    if (this.model && this.model.setBrake) this.model.setBrake(t);
  }

  /** Repaints the bodywork. */
  setColor(hex) {
    if (this.model && this.model.setColor) this.model.setColor(hex);
  }

  // ---------------------------------------------------------------- tyres --

  /**
   * Ackermann steering geometry: the inside wheel of a turn traces a tighter
   * circle than the outside one, so it must be steered further. Parallel
   * steering makes the front axle scrub and — because the visible wheel angle
   * then disagrees with the path the car actually takes — is a large part of
   * why a car can feel disconnected from its front wheels.
   */
  _wheelSteer(w) {
    return this._wheelSteerAngle(w, this.steer);
  }

  _wheelSteerAngle(w, d) {
    if (!w.steered) return 0;
    if (Math.abs(d) < 1e-4) return 0;

    const L = this.V.wheelbaseHalf * 2;
    const R = L / Math.tan(Math.abs(d)); // turn radius at the axle centreline
    // Steering left (d > 0) pivots about a centre to the left, so the left
    // wheel (local.x < 0) is the inner one.
    const inner = d > 0 === w.local.x < 0;
    const radius = inner ? R - this.V.trackHalf : R + this.V.trackHalf;
    return Math.sign(d) * Math.atan(L / Math.max(radius, 0.4));
  }

  _tyres(dt, drive, input) {
    const V = this.V;
    // Suspension impulses go in first so the loads used below are final.
    this._applySuspension(dt);

    const mLat = V.mass * V.lateralGripMass;
    const mLong = V.mass * 0.25;
    // Slip angle is atan(v_lat / v_long) — undefined at a standstill and wildly
    // noisy just above it. Below walking pace we blend back to plain velocity
    // cancellation, which is what keeps a parked car parked.
    const slipBlend = smoothstep(V.slipBlendSpeed[0], V.slipBlendSpeed[1], this.speed);
    let slipAccum = 0;

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      if (!w.grounded) {
        w.slipAmount = 0;
        w.slipLat = 0;
        w.slipAngle = 0;
        continue;
      }

      // Wheel frame, projected onto the contact plane so forces stay tangential.
      const steer = this._wheelSteer(w);
      const wf = this._c.copy(this.fwd);
      if (steer !== 0) wf.applyAxisAngle(this.up, steer);
      wf.addScaledVector(w.normal, -wf.dot(w.normal));
      if (wf.lengthSq() < 1e-8) continue;
      wf.normalize();
      const wr = this._d.crossVectors(wf, w.normal).normalize();

      const vf = w.pointVel.dot(wf);
      const vr = w.pointVel.dot(wr);
      w.slipLat = vr;

      const maxImpulse = V.tyreFriction * lerp(1, V.offRoadGrip, this.offRoad) * w.load * dt;

      // ---- lateral: Magic Formula ------------------------------------------
      // The rear runs slightly more peak grip and slightly less cornering
      // stiffness than the front: crisp turn-in, and the front lets go first.
      const handbrakeCut = w.rear && input.handbrake ? V.handbrakeGripMul : 1;
      const surface = lerp(1, V.offRoadGrip, this.offRoad);
      const peak = V.tyreFriction * w.load * handbrakeCut * surface * (w.rear ? V.rearGripBias : 1);
      const B = w.rear ? V.corneringStiffnessRear : V.corneringStiffnessFront;

      const alpha = Math.atan2(-vr, Math.max(Math.abs(vf), 0.8));
      w.slipAngle = alpha;
      const magic = peak * Math.sin(V.tyreShape * Math.atan(B * alpha));

      const lat = lerp(-vr * mLat * handbrakeCut, magic * dt, slipBlend);

      // ---- longitudinal ----------------------------------------------------
      let driveImpulse = this.driveForce * V.driveBias[i] * dt;

      // Traction control caps *drive* (never braking) at the friction left over
      // once the tyre has paid for cornering. The margin still permits wheelspin
      // and power-on rotation; the handbrake disables it so drifts survive.
      if (driveImpulse !== 0 && !input.handbrake) {
        const remaining = Math.sqrt(Math.max(0, maxImpulse * maxImpulse - lat * lat));
        const budget = remaining * V.tractionControl;
        if (Math.abs(driveImpulse) > budget) driveImpulse = sign(driveImpulse) * budget;
      }

      let brakeForce = drive.brake * V.brakeForce[i];
      if (input.handbrake && w.rear) brakeForce = Math.max(brakeForce, V.handbrakeForce);
      // Loose surfaces drag far harder than tarmac.
      brakeForce += V.rollingResistance * 0.25 * (1 + this.offRoad * V.offRoadDrag);
      // Clamp to the impulse that exactly arrests this wheel, so braking
      // settles at a standstill instead of buzzing around zero.
      const brakeImpulse = -sign(vf) * Math.min(Math.abs(vf) * mLong, brakeForce * dt);

      let lon = driveImpulse + brakeImpulse;
      let latOut = lat;

      // ---- friction circle -------------------------------------------------
      const mag = Math.hypot(latOut, lon);
      let clampSlip = 0;
      if (mag > maxImpulse && mag > 1e-6) {
        const scale = maxImpulse / mag;
        latOut *= scale;
        lon *= scale;
        clampSlip = 1 - scale;
      }

      // Skid feedback comes from slip angle past the tyre's peak, not just from
      // the circle clamp — a tyre can be sliding audibly while still inside it.
      const alphaPeak = 1.86 / B;
      const angleSlip = smoothstep(alphaPeak * 1.1, alphaPeak * 3.0, Math.abs(alpha));
      w.slipAmount = Math.max(clampSlip, angleSlip);
      slipAccum += w.slipAmount;

      const impulse = this._e.copy(wf).multiplyScalar(lon).addScaledVector(wr, latOut);
      // Applied above the patch: keeps weight transfer, tames the roll moment.
      const at = this._a.copy(w.contact).addScaledVector(this.up, V.frictionAnchorLift);
      this.body.applyImpulseAtPoint(impulse, at, true);
    }

    this.slip = clamp(slipAccum / 4, 0, 1);
  }

  // ----------------------------------------------------------------- aero --

  _aero(dt) {
    const V = this.V;
    if (this.speed > 0.2) {
      const drag = this._a.copy(this.linvel).multiplyScalar(-V.dragCoefficient * this.speed * dt);
      this.body.applyImpulse(drag, true);
    }
    // Downforce presses the car into the road as speed rises, which is what
    // keeps high-speed sweepers stable without simply raising grip everywhere.
    const df = V.downforce * this.forwardSpeed * this.forwardSpeed * dt;
    this.body.applyImpulse(this._b.copy(this.up).multiplyScalar(-df), true);
  }


  // ------------------------------------------------------------ stability --

  _stability(dt, input) {
    const V = this.V;
    const tilt = this.up.dot(WORLD_UP);
    const airborne = this.groundedCount === 0;

    // Self-righting: strong in the air, and on the ground only once the car is
    // already tipping past the point of no return. In between it does nothing,
    // so normal body roll through a corner is untouched.
    if (tilt < 0.999) {
      const gain = airborne
        ? V.uprightTorque * 1.5
        : V.uprightTorque * smoothstep(0.95, 0.5, tilt);
      if (gain > 0) {
        const torque = this._a.crossVectors(this.up, WORLD_UP);
        torque.multiplyScalar(gain * V.mass * 0.35 * dt);
        this.body.applyTorqueImpulse(torque, true);
      }
    }

    // A little mid-air yaw authority so jumps can be lined up on landing.
    if (airborne && Math.abs(input.steer) > 0.05) {
      const yaw = this._b.copy(this.up).multiplyScalar(
        input.steer * V.airControl * V.mass * 0.12 * dt
      );
      this.body.applyTorqueImpulse(yaw, true);
    }

    // Slide containment. See VEHICLE.driftAngle: beyond a generous chassis slip
    // angle the car is no longer drifting, it is spinning, and countersteer has
    // nothing left to work with because every tyre is far past its peak. A yaw
    // damper faded in over that band gives the driver the car back without
    // touching how it behaves at ordinary drift angles.
    if (!airborne && this.speed > 4) {
      const vFwd = this.linvel.dot(this.fwd);
      const vSide = this.linvel.dot(this.rightV);
      const beta = Math.abs(Math.atan2(vSide, Math.abs(vFwd)));
      const over = smoothstep(V.driftAngle, V.spinAngle, beta);
      if (over > 0) {
        const yawRate = this.angvel.dot(this.up);
        this._d.copy(this.up).multiplyScalar(-yawRate * over * V.spinRecovery * V.mass * dt);
        this.body.applyTorqueImpulse(this._d, true);
      }
    }

    // Hard cap on tumbling — a trimesh edge case should never end the session.
    const spin = this.angvel.length();
    if (spin > 7) {
      this._c.copy(this.angvel).multiplyScalar(7 / spin);
      this.body.setAngvel(this._c, true);
    }

    this.upsideDownFor = tilt < 0.1 ? this.upsideDownFor + dt : 0;
  }

  _integrateWheelSpin(dt, input) {
    const V = this.V;
    for (const w of this.wheels) {
      if (input.handbrake && w.rear) continue; // locked wheels don't turn
      const v = w.grounded ? w.pointVel.dot(this.fwd) : this.forwardSpeed;
      w.spin += (v / V.wheelRadius) * dt;
    }
  }

  // -------------------------------------------------------------- visuals --

  /**
   * Called once per rendered frame. Wheels are children of the chassis group,
   * so suspension travel is just a local -Y offset and steering/spin are local
   * rotations — no world-space bookkeeping needed.
   */
  syncVisuals(alpha = 1) {
    // Re-read: the cached transform is from before the final world.step().
    this._readState();

    // Blend between the last two physics steps. `alpha` is the unconsumed
    // fraction of a substep still sitting in the accumulator.
    const a = this.hasPrev ? clamp(alpha, 0, 1) : 1;
    this.renderPos.lerpVectors(this.prevPos, this.pos, a);
    this.renderQuat.copy(this.prevQuat).slerp(this.quat, a);

    this.renderUp.set(0, 1, 0).applyQuaternion(this.renderQuat);
    this.renderFwd.set(0, 0, -1).applyQuaternion(this.renderQuat);
    this.renderRight.set(1, 0, 0).applyQuaternion(this.renderQuat);

    this.group.position.copy(this.renderPos);
    this.group.quaternion.copy(this.renderQuat);

    const steer = lerp(this.prevSteer, this.steer, a);
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      const mesh = this.wheelMeshes[i];

      const suspLen = lerp(w.prevSuspLen, w.suspLen, a);
      mesh.position.set(w.local.x, w.local.y - suspLen, w.local.z);

      this._q.setFromAxisAngle(AXIS_Y, this._wheelSteerAngle(w, steer));
      this._q2.setFromAxisAngle(AXIS_X, -lerp(w.prevSpin, w.spin, a));
      mesh.quaternion.copy(this._q).multiply(this._q2);
    }
  }

  // ---------------------------------------------------------------- reset --

  /** Drops the car back onto the road, upright and pointing along the tangent. */
  respawn(position, forward) {
    // Local forward is -Z, so a yaw of θ points the car at (-sinθ, 0, -cosθ).
    const yaw = Math.atan2(-forward.x, -forward.z);
    const q = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, yaw);

    this.body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

    this.steer = 0;
    this.reverse = false;
    this.driveForce = 0;
    this.slip = 0;
    this.upsideDownFor = 0;
    this.parkedPos.copy(position);
    this.parkedQuat.copy(q);
    for (const w of this.wheels) {
      w.compression = 0;
      w.suspLen = this.V.restLength;
      w.load = 0;
      w.grounded = false;
    }
    this._readState();
  }


}
