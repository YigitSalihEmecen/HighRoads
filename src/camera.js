/**
 * camera.js — chase camera on critically damped springs.
 *
 * The rig's yaw, pitch, pivot height and distance each ride a spring; the
 * pivot's X/Z is locked to the car. Body roll and suspension do not move the view.
 */

import * as THREE from 'three';
import { ATMOSPHERE, CAMERA, TITLE } from './config.js';
import { clamp, damp, dampTrack, smoothstep, spring } from './util.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Sun bearing from the world direction — the title orbit starts on the lit side. */
const SUN_YAW = Math.atan2(ATMOSPHERE.sunDir.x, ATMOSPHERE.sunDir.z);

export const CAM_MODES = ['close', 'chase', 'hood'];

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.mode = 0;

    this.position = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.heading = new THREE.Vector3(0, 0, -1);
    this.fov = CAMERA.fov;
    this.initialised = false;
    this.speedT = 0;
    this.title = false;
    // Hold value; `_seedOrbit` seeds it from the sun on the first title frame.
    this._orbit = TITLE.angles[0];
    /** Fly-in progress; while under 1 the rig interpolates orbit pose to chase pose. */
    this._introT = 1;
    this._introPos = new THREE.Vector3();
    this._introLook = new THREE.Vector3();

    /** Free-screen rect and subject size, pushed each frame by main.js. */
    this._rect = null;
    this._vw = 1;
    this._vh = 1;
    this._subjectR = 2.4;
    this._subjectH = 1.5;

    this._camRight = new THREE.Vector3();
    this._camUp = new THREE.Vector3();
    this._aim = new THREE.Vector3();

    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._pivot = new THREE.Vector3();
    /** Chase-rig spring states; seeded from the car whenever `_rigSeeded` is cleared. */
    this._rigSeeded = false;
    this._yawGoal = 0;
    this._yaw = { x: 0, v: 0 };
    this._pitch = { x: 0, v: 0 };
    this._pivotY = { x: 0, v: 0 };
    this._dist = { x: 0, v: 0 };
    this._climb = 0;
    this._roll = 0;
    this._desired = new THREE.Vector3();
    this._target = new THREE.Vector3();
    // dampTrack needs both ends of the goal's travel; else the settled lag varies with frame rate.
    this._prevDesired = new THREE.Vector3();
    this._prevTarget = new THREE.Vector3();
  }

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

  setTitle(on) {
    if (this.title === on) return;
    this.title = on;
    this._rigSeeded = false;
    if (on) {
      this.initialised = false;
      this._introT = 1;
      this._orbitSeeded = false;
    }
  }

  frameTitle(vw, vh, rect, metrics) {
    this._vw = Math.max(1, vw);
    this._vh = Math.max(1, vh);
    this._rect = rect || null;
    if (metrics) {
      // Fit the diagonal: three-quarter-on is where the silhouette is widest.
      const len = (metrics.bodyHalfLength || 2.2) * 2;
      const wid = (metrics.bodyHalfWidth || 1.0) * 2;
      this._subjectR = Math.hypot(len, wid) * 0.5;
      this._subjectH = metrics.bodyHeight || 1.5;
    }
  }

  beginIntro(seconds = TITLE.introTime) {
    this._introPos.copy(this.camera.position);
    // From the offset aim, not the damper state: the title camera points a framing offset off-track.
    this._introLook.copy(this._aim);
    this._introT = 0;
    this._introDur = Math.max(0.01, seconds);
    // The blend needs a from-pose, so the rig counts as framed.
    this.initialised = true;
    this.position.copy(this._introPos);
  }

  get flyingIn() {
    return this._introT < 1;
  }

  get introT() {
    return this._introT;
  }

  cycle() {
    this.mode = (this.mode + 1) % CAM_MODES.length;
    this.snap();
    return CAM_MODES[this.mode];
  }

  /** A teleport would read as travel to the springs and swing the rig — cut, and reseed next frame. */
  snap() {
    this.initialised = false;
    this._rigSeeded = false;
  }

  update(dt, vehicle) {
    if (this.title) {
      this._updateTitle(dt, vehicle);
      return;
    }
    const mode = CAM_MODES[this.mode];

    if (mode === 'hood') {
      this._updateHood(dt, vehicle);
      return;
    }

    const cfg = mode === 'close' ? CAMERA.close : CAMERA.chase;
    const zoom = cfg.zoom ?? 1;

    const bodyH = (vehicle.V && vehicle.V.bodyHeight) || CAMERA.bodyRef;
    const sizeT = bodyH / CAMERA.bodyRef;
    const hScale = clamp(sizeT, 1, CAMERA.heightScaleMax);
    const dScale = clamp(sizeT, 1, CAMERA.distScaleMax);

    const fwd = vehicle.renderFwd;
    const vel = vehicle.linvel;

    // Reversing shouldn't spin the camera around; hold the last forward heading.
    if (vehicle.forwardSpeed > -1.0 || !this._rigSeeded) {
      const fl = Math.hypot(fwd.x, fwd.z) || 1;
      let hx = fwd.x / fl;
      let hz = fwd.z / fl;
      // Lean toward the direction of travel: a slide rotates the body, not the shot.
      const vh = Math.hypot(vel.x, vel.z);
      const w = vh > 1e-3 && vel.x * hx + vel.z * hz > 0 ? CAMERA.travelAlign * smoothstep(3, 15, vh) : 0;
      if (w > 0) {
        hx += (vel.x / vh - hx) * w;
        hz += (vel.z / vh - hz) * w;
      }
      this._yawGoal = Math.atan2(hx, hz);
    }
    const pitchGoal = Math.asin(clamp(fwd.y, -1, 1)) * CAMERA.pitchFollow;

    const speedTarget = smoothstep(0, CAMERA.speedRef, Math.abs(vehicle.forwardSpeed));
    this.speedT = damp(this.speedT, speedTarget, CAMERA.speedLag, dt);
    const speedT = this.speedT;
    const distGoal = cfg.dist * dScale + speedT * CAMERA.distGain * zoom
      + Math.abs(vehicle.forwardSpeed) * CAMERA.pullTime;

    if (!this._rigSeeded) {
      this._rigSeeded = true;
      this._yaw.x = this._yawGoal; this._yaw.v = 0;
      this._pitch.x = pitchGoal; this._pitch.v = 0;
      this._pivotY.x = vehicle.renderPos.y; this._pivotY.v = vel.y;
      this._dist.x = distGoal; this._dist.v = 0;
      this._climb = vel.y;
      this._roll = 0;
    }

    // Springs on the rig's angles and pivot height, not on world position:
    // speed adds no lag, while steering, slides and bumps are eased out.
    const yawNow = this._yaw.x;
    const yaw = spring(this._yaw, yawNow + Math.atan2(Math.sin(this._yawGoal - yawNow), Math.cos(this._yawGoal - yawNow)),
      0, CAMERA.yawRate, dt);
    const pitch = spring(this._pitch, pitchGoal, 0, CAMERA.pitchRate, dt);
    this._climb = damp(this._climb, vel.y, CAMERA.climbRate, dt);
    const pivotY = spring(this._pivotY, vehicle.renderPos.y, this._climb, CAMERA.heightRate, dt);
    const dist = spring(this._dist, distGoal, 0, CAMERA.distRate, dt);

    const cp = Math.cos(pitch);
    this.heading.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
    this._pivot.set(vehicle.renderPos.x, pivotY, vehicle.renderPos.z);

    this._desired
      .copy(this._pivot)
      .addScaledVector(this.heading, -dist)
      .addScaledVector(WORLD_UP, cfg.height * hScale + speedT * CAMERA.heightGain * zoom);

    this._target
      .copy(this._pivot)
      .addScaledVector(this.heading, cfg.ahead + speedT * 4)
      .addScaledVector(WORLD_UP, CAMERA.aimHeight * hScale);

    if (this.initialised && this._introT < 1) {
      // Double smoothstep: a single Hermite jerks at both ends of a move this long.
      this._introT = Math.min(1, this._introT + dt / this._introDur);
      const e = smoothstep(0, 1, this._introT);
      const k = smoothstep(0, 1, e);
      this.position.lerpVectors(this._introPos, this._desired, k);
      this.lookAt.lerpVectors(this._introLook, this._target, k);
    } else {
      this.position.copy(this._desired);
      this.lookAt.copy(this._target);
    }
    this.initialised = true;

    this.camera.position.copy(this.position);
    this.camera.up.copy(WORLD_UP);
    this.camera.lookAt(this.lookAt);

    const rollGoal = clamp(vehicle.slip * Math.sign(vehicle.wheels[2].slipLat) * CAMERA.slipRoll, -0.06, 0.06);
    this._roll = damp(this._roll, rollGoal, CAMERA.rollRate, dt);
    this.camera.rotateZ(this._roll);

    this._applyFov(dt, speedT, vehicle, zoom);
  }

  /** Distance solved so the car fills TITLE.fill; the aim offset runs on the camera's own axes (horizontal negated). */
  _updateTitle(dt, vehicle) {
    this._orbit += TITLE.spin * dt;

    const vw = this._vw;
    const vh = this._vh;
    const cam = this.camera;
    cam.aspect = vw / vh;
    cam.fov = this.fov = damp(this.fov, TITLE.fov, 3, dt);
    cam.updateProjectionMatrix();

    // First frame: no layout yet, so fall back to a band across the middle.
    let left, top, right, bottom;
    const r = this._rect;
    if (r && r.right - r.left > vw * 0.08 && r.bottom - r.top > vh * 0.08) {
      ({ left, top, right, bottom } = r);
    } else {
      left = vw * 0.08; right = vw * 0.92;
      top = vh * 0.16; bottom = vh * 0.7;
    }
    const bandW = right - left;
    const bandH = bottom - top;

    const tanV = Math.tan((cam.fov * Math.PI) / 180 * 0.5);
    const tanH = tanV * cam.aspect;

    const needV = (this._subjectH * 1.35) / (2 * tanV * (bandH / vh) * TITLE.fill);
    const needH = (this._subjectR * 2) / (2 * tanH * (bandW / vw) * TITLE.fill);
    const dist = Math.max(needV, needH, TITLE.minDistance);

    // Orbit in the car's frame; renderFwd is flattened so banking doesn't tip the orbit.
    this._fwd.copy(vehicle.renderFwd);
    this._fwd.y = 0;
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(0, 0, -1);
    this._fwd.normalize();
    const carYaw = Math.atan2(this._fwd.x, this._fwd.z);
    if (!this._orbitSeeded) {
      this._orbitSeeded = true;
      this._orbit = this._seedOrbit(carYaw);
    }
    const yaw = carYaw + this._orbit;

    const lift = this._subjectH * TITLE.aimHeight;
    this._target.copy(vehicle.renderPos).addScaledVector(WORLD_UP, lift);
    this._desired.set(
      Math.sin(yaw) * dist * TITLE.orbitRadius,
      dist * TITLE.eyeLift,
      Math.cos(yaw) * dist * TITLE.orbitRadius
    ).add(this._target);

    if (!this.initialised) {
      this.position.copy(this._desired);
      this.lookAt.copy(this._target);
      this._seedGoals();
      this.initialised = true;
    } else {
      // Eased, so switching cars slides the framing rather than cutting to it.
      this._track(this.position, this._prevDesired, this._desired, 5, dt);
      this._track(this.lookAt, this._prevTarget, this._target, 7, dt);
    }
    this._seedGoals();

    cam.position.copy(this.position);
    cam.up.copy(WORLD_UP);
    cam.lookAt(this.lookAt);
    cam.updateMatrixWorld();

    // Offset in a separate vector: added to the damped lookAt it compounds to target + offset/(1 − e^(−k·dt)).
    this._camRight.setFromMatrixColumn(cam.matrixWorld, 0);
    this._camUp.setFromMatrixColumn(cam.matrixWorld, 1);
    const dx = -(((left + right) * 0.5 - vw * 0.5) / (vw * 0.5)) * tanH * dist;
    const dy = (((top + bottom) * 0.5 - vh * 0.5) / (vh * 0.5)) * tanV * dist;
    this._aim.copy(this.lookAt)
      .addScaledVector(this._camRight, dx)
      .addScaledVector(this._camUp, dy);
    cam.lookAt(this._aim);

    this.speedT = 0;
  }

  _seedOrbit(carYaw) {
    let best = TITLE.angles[0];
    let bestDot = -2;
    for (const a of TITLE.angles) {
      // Lit side: the stand bearing agrees with the sun's bearing.
      const dot = Math.cos(carYaw + a - SUN_YAW);
      if (dot > bestDot) { bestDot = dot; best = a; }
    }
    return best;
  }

  _updateHood(dt, vehicle) {
    // Rigidly mounted — this one *should* transmit roll and suspension motion.
    const V = vehicle.V;
    const bodyH = (V && V.bodyHeight) || 1.45;
    const half = (V && V.bodyHalfLength) || 2.0;
    const eye = bodyH * 0.62;
    const fwd = -(half * 0.5 + 0.3);
    this._desired.set(0, eye, fwd).applyQuaternion(vehicle.renderQuat).add(vehicle.renderPos);
    this._fwd.copy(vehicle.renderFwd);
    this._up.copy(vehicle.renderUp);

    this.camera.position.copy(this._desired);
    this.camera.up.copy(this._up);
    this.camera.lookAt(this._desired.clone().addScaledVector(this._fwd, 20));

    this.speedT = damp(this.speedT, smoothstep(0, CAMERA.speedRef, Math.abs(vehicle.forwardSpeed)), CAMERA.speedLag, dt);
    this._applyFov(dt, this.speedT, vehicle, 1);
  }

  _applyFov(dt, speedT, vehicle, zoom = 1) {
    const target = CAMERA.fov + speedT * CAMERA.fovSpeedGain * zoom + vehicle.slip * 2;
    this.fov = damp(this.fov, target, 2.2, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
