/**
 * vehicle.js — a raycast vehicle controller on a Rapier rigid body.
 *
 * Rapier provides the body, impulses and ray queries. The chassis collider is
 * excluded from every suspension ray. All dynamics are hand-rolled per wheel
 * per substep: suspension, tyre, drive.
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
    /** Steering lock available this frame, radians. See `_updateSteering`. */
    this.steerLimit = 0;

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
    // Suspension rays see the world but not other cars. The mask keeps the
    // springs from finding "ground" on a traffic car's roof.
    this._rayGroups = (0x0001 << 16) | 0xfffd;
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._c = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._e = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();

    // ---- render interpolation -------------------------------------------
    // The display clock differs from the fixed physics step. Blend the previous
    // step's transform with the current one by the leftover accumulator.
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
   * Snapshots the transform before each world.step().
   */
  /**
   * Pins the car for the title screen.
   *
   * Horizontal velocity and rotation are cancelled each step; vertical motion
   * is kept so the suspension still settles on the ground.
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
      // Zero velocity and position, not velocity alone; the solver drift would
      // creep the car away. Height is left alone so the suspension settles.
      const t = this.body.translation();
      this.body.setTranslation({ x: this.parkedPos.x, y: t.y, z: this.parkedPos.z }, true);
      this.body.setLinvel({ x: 0, y: Math.min(0, this.body.linvel().y), z: 0 }, true);
      this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.body.setRotation(this.parkedQuat, true);
    }

    // Cap the chassis speed at the start of a step. A deep contact resolved in
    // one step can hand back unreal velocity; removing it is a correction.
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

    // Solid-box inertia, with roll and yaw axes inflated: a real car carries
    // mass at the ends and high up, so it resists yaw and roll more than a
    // uniform slab does.
    const w = hx * 2, h = hy * 2, l = hz * 2;
    const Ix = (m / 12) * (h * h + l * l);
    const Iy = (m / 12) * (w * w + l * l) * 1.6;
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

    // Density 0: mass comes from setAdditionalMassProperties, so the collider
    // cannot fight the chosen inertia tensor. The box is raised to the bodywork.
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

  /**
   * Takes the model's groups back after the showroom has borrowed them.
   *
   * The showroom re-parents the body and wheel groups onto its turntable.
   */
  reattachModel() {
    this.group.add(this.model.body);
    for (let i = 0; i < this.wheelMeshes.length; i++) this.group.add(this.wheelMeshes[i]);
    // Poses are rewritten by syncVisuals; this only unparents the groups.
  }

  /** Removes this vehicle from the scene and the physics world. */
  dispose() {
    this.scene.remove(this.group);
    this.world.removeRigidBody(this.body);
  }

  // ----------------------------------------------------------------- rays --

  /**
   * Wraps Rapier's ray query; `timeOfImpact` was renamed from `toi`.
   */
  _castRay(origin, dir, maxToi) {
    this._ray.origin = origin;
    this._ray.dir = dir;

    const hit = this.world.castRayAndGetNormal(
      this._ray,
      maxToi,
      true,
      // Ray casts hit sensors unless excluded.
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
   * Steering authority comes from grip, not a hand-drawn curve. For a
   * steady-state turn:
   *
   *     delta_max = atan( L * a_max / v^2 )
   *
   * a_max includes downforce, which raises the limit at speed.
   */
  _updateSteering(dt, input) {
    const V = this.V;
    const L = V.wheelbaseHalf * 2;
    const v2 = Math.max(this.forwardSpeed * this.forwardSpeed, 1);
    const aGrip =
      V.tyreFriction *
      (Math.abs(WORLD.gravity) + (V.downforce * v2) / V.mass) *
      V.steerGripMargin;

    // The limit is the lower of grip and rollover.
    const aMax = Math.min(aGrip, V.rolloverAccel);
    const gripSteer = Math.atan((L * aMax) / v2);

    // The steady-state assumption fails in a slide. Open the lock toward full
    // as chassis slip grows; the term is zero when straight.
    const betaSigned = Math.atan2(
      this.linvel.dot(this.rightV), Math.max(Math.abs(this.forwardSpeed), 1)
    );
    const beta = Math.abs(betaSigned);
    const slide = smoothstep(V.slideOpenFrom, V.slideOpenTo, beta);
    // Proportional to the limit, never a jump to full lock.
    const base = clamp(gripSteer, V.minSteer, V.maxSteer);
    const opened = Math.min(V.maxSteer, base * V.slideLockGain);
    let maxSteer = lerp(base, opened, slide);

    /**
     * Countersteering is not turn-in. Steering that opposes the slip points the
     * front wheels down the velocity vector, which recovers a slide.
     * `slideOpen` opens the lock symmetrically on |beta|; the sign matters —
     * input opposing the slip deserves full lock.
     */
    const counter = input.steer * betaSigned < 0
      ? smoothstep(V.counterFrom, V.counterTo, beta) : 0;
    if (counter > 0) {
      maxSteer = Math.max(maxSteer, lerp(base, V.maxSteer * V.counterLock, counter));
    }

    // Scale the slew rate with the available lock; never damp a correction.
    // The floor sits at a quarter rate at speed.
    const scale = clamp(maxSteer / V.maxSteer, 0.25, 1);
    const rate = (Math.abs(input.steer) < 0.05 ? V.steerReturnRate : V.steerRate)
      * lerp(scale, 1, counter);

    /**
     * The lock available this frame.
     *
     * `input.steer` is normalised, so controllers asking for an angle divide
     * by this rather than by `V.maxSteer`. See `probe/drive.mjs`.
     */
    this.steerLimit = maxSteer;

    const target = input.steer * maxSteer;
    this.steer = clamp(moveTowards(this.steer, target, rate * dt), -maxSteer, maxSteer);
  }

  /**
   * Maps the two pedals onto the current gear. In reverse the pedals swap.
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

      // Velocity of the contact point: v + w x r
      const r = this._c.subVectors(w.contact, this.com);
      w.pointVel.copy(this.angvel).cross(r).add(this.linvel);

      // A positive compression rate means the spring is compressing.
      const compressRate = -w.pointVel.dot(this.up);
      const damper = compressRate > 0 ? V.damperBump : V.damperRebound;

      // F = k*x + c*xdot, one-sided: a suspension pushes, never pulls.
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

    // The bar lifts the compressed corner and pushes the extended one down.
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
   * The engine simulator in `powertrain.js` writes the contact-patch force via
   * `setDriveForce()` once per frame. This file handles only the tyre outwards.
   */
  setDriveForce(force) {
    this.driveForce = Number.isFinite(force) ? force : 0;
  }

  /**
   * How much of the car is off the asphalt, 0..1. Set by the game.
   */
  setSurface(offRoad) {
    this.offRoad = clamp(offRoad, 0, 1);
  }

  /**
   * Head lamps: two spot lights built lazily when first switched on.
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

  /** Repaints the second colour. `null` restores the model's own swatch. */
  setTrimColor(hex) {
    if (this.model && this.model.setTrimColor) this.model.setTrimColor(hex);
  }

  // ---------------------------------------------------------------- tyres --

  /**
   * Ackermann geometry: the inside wheel of a turn must steer further than
   * the outside one.
   */
  _wheelSteer(w) {
    return this._wheelSteerAngle(w, this.steer);
  }

  _wheelSteerAngle(w, d) {
    if (!w.steered) return 0;
    if (Math.abs(d) < 1e-4) return 0;

    const L = this.V.wheelbaseHalf * 2;
    const R = L / Math.tan(Math.abs(d)); // turn radius at the axle centreline
    // Steering left pivots about a centre to the left; the inner wheel is left.
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
    // Slip angle is undefined near a standstill; below walking pace, blend to
    // velocity cancellation to keep a parked car parked.
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
      // The rear runs more peak grip and less stiffness: the front lets go first.
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

      // Traction control caps drive (never braking) at the friction left after
      // cornering. The handbrake disables it so drifts survive.
      if (driveImpulse !== 0 && !input.handbrake) {
        const remaining = Math.sqrt(Math.max(0, maxImpulse * maxImpulse - lat * lat));
        const budget = remaining * V.tractionControl;
        if (Math.abs(driveImpulse) > budget) driveImpulse = sign(driveImpulse) * budget;
      }

      let brakeForce = drive.brake * V.brakeForce[i];
      if (input.handbrake && w.rear) brakeForce = Math.max(brakeForce, V.handbrakeForce);
      // Loose surfaces drag far harder than tarmac.
      brakeForce += V.rollingResistance * 0.25 * (1 + this.offRoad * V.offRoadDrag);
      // Clamp to the impulse that exactly arrests this wheel.
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

      // Skid feedback comes from slip angle past the tyre's peak.
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
    // Downforce presses the car into the road as speed rises.
    const df = V.downforce * this.forwardSpeed * this.forwardSpeed * dt;
    this.body.applyImpulse(this._b.copy(this.up).multiplyScalar(-df), true);
  }


  // ------------------------------------------------------------ stability --

  _stability(dt, input) {
    const V = this.V;
    const tilt = this.up.dot(WORLD_UP);
    const airborne = this.groundedCount === 0;

    // Self-righting: strong in the air, inactive during normal cornering roll.
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

    // Slide containment: beyond a generous slip angle a yaw damper fades in,
    // so a spin hands the driver the car back without affecting normal drifts.
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
   * so travel, steering and spin are all local.
   */
  syncVisuals(alpha = 1) {
    // Re-read: the cached transform is from before the final world.step().
    this._readState();

    // Blend the last two physics steps; `alpha` is the leftover accumulator.
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
    // Local forward is -Z, so yaw = atan2(-forward.x, -forward.z).
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
