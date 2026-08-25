/**
 * camera.js — chase rig with critically-damped smoothing.
 *
 * The camera never hard-attaches to the chassis. It tracks a *flattened* copy
 * of the car's heading, so body roll and suspension pitch don't propagate into
 * the view — which is the difference between "planted" and "nauseating".
 */

import * as THREE from 'three';
import { CAMERA } from './config.js';
import { clamp, damp, dampTrack, smoothstep } from './util.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export const CAM_MODES = ['chase', 'close', 'hood'];

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.mode = 0;

    this.position = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.heading = new THREE.Vector3(0, 0, -1);
    this.fov = CAMERA.fov;
    this.initialised = false;
    /** Damped speed factor — the rig reacts to this, never to raw speed. */
    this.speedT = 0;
    /** Title-screen mode: orbit the car instead of following it. */
    this.garage = false;
    this._orbit = 2.2;
    /** Seconds of stiffened damping left after leaving the garage. */
    this._snapFor = 0;

    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._target = new THREE.Vector3();
    /**
     * Where the rig WANTED to be last frame.
     *
     * The smoother needs both ends of the goal's travel across the frame, not
     * just where it ended up — see util.dampTrack. Without the previous goal
     * the lag the camera settles at is a function of frame time, and at 230
     * km/h that is half a metre of difference between a 60 fps frame and a
     * 30 fps one, which is the camera springing at the car and back.
     */
    this._prevDesired = new THREE.Vector3();
    this._prevTarget = new THREE.Vector3();
  }

  /**
   * Advances one axis of the rig. Splitting it out keeps the two call sites
   * (driving and garage) from drifting apart — they had the same bug.
   */
  _track(vec, prev, goal, rate, dt) {
    vec.x = dampTrack(vec.x, prev.x, goal.x, rate, dt);
    vec.y = dampTrack(vec.y, prev.y, goal.y, rate, dt);
    vec.z = dampTrack(vec.z, prev.z, goal.z, rate, dt);
  }

  /** Seeds both goal histories, so the first frame has no goal velocity. */
  _seedGoals() {
    this._prevDesired.copy(this._desired);
    this._prevTarget.copy(this._target);
  }

  /**
   * Title-screen framing. The car being chosen is the real vehicle, sitting on
   * the real road in the real scene, so the picker shows exactly what will be
   * driven — including the paint, which is a live material property.
   */
  setGarage(on) {
    if (this.garage === on) return;
    this.garage = on;
    if (on) {
      this.initialised = false;      // arriving: frame the car immediately
    } else {
      /**
       * Leaving: SNAP.
       *
       * Bug #39 is the opposite of this — resetting `initialised` made the rig
       * teleport from the orbit to the bumper, and the fix was to sweep. That
       * was right while the garage was the same road seen from a different
       * angle, where a cut looked like a glitch. The title screen is now its
       * own scene (showroom.js), so this transition is a cut between two
       * places, and sweeping a camera that was never in the world produces a
       * lurch from wherever the last chase position happened to be.
       */
      this.initialised = false;
      this._snapFor = 0;
    }
  }

  cycle() {
    this.mode = (this.mode + 1) % CAM_MODES.length;
    this.initialised = false; // snap position rather than sweep across the world
    return CAM_MODES[this.mode];
  }

  update(dt, vehicle) {
    if (this.garage) {
      this._updateGarage(dt, vehicle);
      return;
    }
    const mode = CAM_MODES[this.mode];

    if (mode === 'hood') {
      this._updateHood(dt, vehicle);
      return;
    }

    const cfg = mode === 'close' ? CAMERA.close : CAMERA.chase;

    // Scale the rig to the vehicle so every car is framed the same way.
    const bodyH = (vehicle.V && vehicle.V.bodyHeight) || CAMERA.bodyRef;
    const sizeT = bodyH / CAMERA.bodyRef;
    const hScale = clamp(sizeT, 1, CAMERA.heightScaleMax);
    const dScale = clamp(sizeT, 1, CAMERA.distScaleMax);

    // Flattened heading: keeps the horizon level under body roll.
    this._fwd.copy(vehicle.renderFwd);
    this._fwd.y *= 0.35;
    this._fwd.normalize();

    // Reversing shouldn't spin the camera around; hold the last forward heading.
    if (vehicle.forwardSpeed > -1.0) {
      this.heading.lerp(this._fwd, 1 - Math.exp(-6 * dt)).normalize();
    }

    // Two-stage easing. smoothstep against a high reference speed makes the
    // pull-back gradual across the whole range instead of finishing early, and
    // damping it again means a stab of throttle cannot yank the camera — the
    // rig drifts outward over a second or so rather than snapping.
    const speedTarget = smoothstep(0, CAMERA.speedRef, Math.abs(vehicle.forwardSpeed));
    this.speedT = damp(this.speedT, speedTarget, CAMERA.speedLag, dt);
    const speedT = this.speedT;

    this._desired
      .copy(vehicle.renderPos)
      .addScaledVector(this.heading, -(cfg.dist * dScale + speedT * CAMERA.distGain))
      .addScaledVector(WORLD_UP, cfg.height * hScale + speedT * CAMERA.heightGain);

    this._target
      .copy(vehicle.renderPos)
      .addScaledVector(this.heading, cfg.ahead + speedT * 4)
      .addScaledVector(WORLD_UP, CAMERA.aimHeight * hScale);

    if (!this.initialised) {
      this.position.copy(this._desired);
      this.lookAt.copy(this._target);
      this._seedGoals();
      this.initialised = true;
    } else {
      // Position lags a touch more than the aim: the car leads the frame into
      // a corner instead of sitting dead centre.
      let boost = 1;
      if (this._snapFor > 0) {
        this._snapFor = Math.max(0, this._snapFor - dt);
        boost = CAMERA.snapBoost;
      }
      const k = CAMERA.posDamp * (1 + speedT * 0.5) * boost;
      // Y is stiffer than X/Z, so it gets its own call rather than sharing one.
      this.position.x = dampTrack(this.position.x, this._prevDesired.x, this._desired.x, k, dt);
      this.position.y = dampTrack(this.position.y, this._prevDesired.y, this._desired.y, k * 1.4, dt);
      this.position.z = dampTrack(this.position.z, this._prevDesired.z, this._desired.z, k, dt);

      this._track(this.lookAt, this._prevTarget, this._target, CAMERA.aimDamp * boost, dt);
    }
    this._seedGoals();

    this.camera.position.copy(this.position);
    this.camera.up.copy(WORLD_UP);
    this.camera.lookAt(this.lookAt);

    // A little roll into the corner, driven by lateral slip.
    this.camera.rotateZ(clamp(vehicle.slip * Math.sign(vehicle.wheels[2].slipLat) * 0.05, -0.06, 0.06));

    this._applyFov(dt, speedT, vehicle);
  }

  /** Slow orbit around a stationary car, three-quarter view, slightly low. */
  _updateGarage(dt, vehicle) {
    const cfg = CAMERA.garage;
    this._orbit += cfg.spin * dt;

    const bodyH = (vehicle.V && vehicle.V.bodyHeight) || CAMERA.bodyRef;
    const scale = clamp(bodyH / CAMERA.bodyRef, 1, CAMERA.distScaleMax);

    // Responsive framing for mobile:
    const aspect = this.camera.aspect || 1.0;
    // On portrait screens (aspect < 1.0), the narrow horizontal FOV cuts off the sides of the car.
    // Scale distance and lift look-at aim so the car is positioned gracefully in the upper open half of the screen.
    const portraitDist = aspect < 1.0 ? clamp(1.2 / aspect, 1.0, 1.7) : 1.0;
    const portraitAim = aspect < 1.0 ? cfg.aim * 1.6 : cfg.aim;

    const r = cfg.dist * scale * portraitDist;

    this._desired
      .set(
        Math.sin(this._orbit) * r,
        cfg.height * scale * (aspect < 1.0 ? 1.2 : 1.0),
        Math.cos(this._orbit) * r
      )
      .add(vehicle.renderPos);
    this._target.copy(vehicle.renderPos).addScaledVector(WORLD_UP, portraitAim * scale);

    if (!this.initialised) {
      this.position.copy(this._desired);
      this.lookAt.copy(this._target);
      this._seedGoals();
      this.initialised = true;
    } else {
      // Eased, so switching car does not cut — the rig slides to the new
      // framing. The orbit is a moving goal like any other, so it tracks the
      // same way; the car is parked here, but the CAMERA is not.
      this._track(this.position, this._prevDesired, this._desired, 5, dt);
      this._track(this.lookAt, this._prevTarget, this._target, 7, dt);
    }
    this._seedGoals();

    this.camera.position.copy(this.position);
    this.camera.up.copy(WORLD_UP);
    this.camera.lookAt(this.lookAt);

    this.speedT = 0;
    this.fov = damp(this.fov, CAMERA.fov - 6, 3, dt);
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
  }

  _updateHood(dt, vehicle) {
    // Rigidly mounted — this one *should* transmit roll and suspension motion.
    const eye = ((vehicle.V && vehicle.V.bodyHeight) || 1.45) * 0.62;
    this._desired.set(0, eye, -0.35).applyQuaternion(vehicle.renderQuat).add(vehicle.renderPos);
    this._fwd.copy(vehicle.renderFwd);
    this._up.copy(vehicle.renderUp);

    this.camera.position.copy(this._desired);
    this.camera.up.copy(this._up);
    this.camera.lookAt(this._desired.clone().addScaledVector(this._fwd, 20));

    this.speedT = damp(this.speedT, smoothstep(0, CAMERA.speedRef, Math.abs(vehicle.forwardSpeed)), CAMERA.speedLag, dt);
    this._applyFov(dt, this.speedT, vehicle);
  }

  _applyFov(dt, speedT, vehicle) {
    const target = CAMERA.fov + speedT * CAMERA.fovSpeedGain + vehicle.slip * 2;
    this.fov = damp(this.fov, target, 2.2, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
