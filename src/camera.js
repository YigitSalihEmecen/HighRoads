/**
 * camera.js — chase rig with critically-damped smoothing.
 *
 * The camera never hard-attaches to the chassis. It tracks a *flattened* copy
 * of the car's heading, so body roll and suspension pitch don't propagate into
 * the view — which is the difference between "planted" and "nauseating".
 */

import * as THREE from 'three';
import { CAMERA } from './config.js';
import { clamp, damp, smoothstep } from './util.js';

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
      // Leaving: keep where the rig is and let it sweep round to the chase
      // position, briefly stiffened so it arrives promptly. Cutting from an
      // orbit straight to the bumper is disorienting at the exact moment the
      // player takes control.
      this.initialised = true;
      this._snapFor = CAMERA.snapTime;
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
      this.position.x = damp(this.position.x, this._desired.x, k, dt);
      this.position.y = damp(this.position.y, this._desired.y, k * 1.4, dt);
      this.position.z = damp(this.position.z, this._desired.z, k, dt);

      const ka = CAMERA.aimDamp * boost;
      this.lookAt.x = damp(this.lookAt.x, this._target.x, ka, dt);
      this.lookAt.y = damp(this.lookAt.y, this._target.y, ka, dt);
      this.lookAt.z = damp(this.lookAt.z, this._target.z, ka, dt);
    }

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
    const r = cfg.dist * scale;

    this._desired
      .set(Math.sin(this._orbit) * r, cfg.height * scale, Math.cos(this._orbit) * r)
      .add(vehicle.renderPos);
    this._target.copy(vehicle.renderPos).addScaledVector(WORLD_UP, cfg.aim * scale);

    if (!this.initialised) {
      this.position.copy(this._desired);
      this.lookAt.copy(this._target);
      this.initialised = true;
    } else {
      // Eased, so switching car does not cut — the rig slides to the new framing.
      this.position.x = damp(this.position.x, this._desired.x, 5, dt);
      this.position.y = damp(this.position.y, this._desired.y, 5, dt);
      this.position.z = damp(this.position.z, this._desired.z, 5, dt);
      this.lookAt.x = damp(this.lookAt.x, this._target.x, 7, dt);
      this.lookAt.y = damp(this.lookAt.y, this._target.y, 7, dt);
      this.lookAt.z = damp(this.lookAt.z, this._target.z, 7, dt);
    }

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
