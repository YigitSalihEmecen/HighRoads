/**
 * camera.js — chase camera with critically damped tracking.
 *
 * The camera tracks a flattened copy of the car heading. Body roll and
 * suspension pitch do not move the view.
 */

import * as THREE from 'three';
import { ATMOSPHERE, CAMERA, TITLE, ROAD } from './config.js';
import { clamp, damp, dampTrack, smoothstep } from './util.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Sun bearing from the world direction — the title orbit starts on the lit side. */
const SUN_YAW = Math.atan2(ATMOSPHERE.sunDir.x, ATMOSPHERE.sunDir.z);

export const CAM_MODES = ['close', 'chase', 'hood', 'cinematic'];

/** Smooth 1D noise in [-1, 1]: three incommensurate sines, cheap and C∞. */
function wobble(t, seed) {
  return (Math.sin(t * 1.0 + seed) * 0.5
        + Math.sin(t * 2.31 + seed * 1.7) * 0.3
        + Math.sin(t * 5.17 + seed * 2.9) * 0.2);
}

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
    this._desired = new THREE.Vector3();
    this._target = new THREE.Vector3();
    // dampTrack needs both ends of the goal's travel; else the settled lag varies with frame rate.
    this._prevDesired = new THREE.Vector3();
    this._prevTarget = new THREE.Vector3();

    // ---- cinematic state --------------------------------------------------
    /** 0..1; shake is trauma² (Eiserloh, GDC 2016). Events add, time drains. */
    this.trauma = 0;
    this._shakeT = 0;
    this._prevSpeed = 0;
    this._accel = 0;
    this._yawRate = 0;
    this._prevHeading = new THREE.Vector3(0, 0, -1);
    this._right = new THREE.Vector3();
    /** Set by main.js: the road, a ground query, and where the car is on it. */
    this.path = null;
    this.groundAt = null;
    /** (x, z) -> terrain height, for the trackside line-of-sight test. */
    this.groundHeight = null;
    this.carS = 0;
    this._shot = null;
    this._shotIdx = 0;
    this._shotPos = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
  }

  /** Add camera trauma (0..1) — a gear change, a landing, an impact. */
  addTrauma(x) {
    this.trauma = Math.min(1, this.trauma + Math.max(0, x));
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

  /** A teleport reads as goal travel to dampTrack and earns a huge lead — cut, and reseed goals next frame. */
  snap() {
    this.initialised = false;
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
    if (mode === 'cinematic' && this.path && this.groundAt) {
      this._updateCinematic(dt, vehicle);
      return;
    }

    const cfg = mode === 'close' ? CAMERA.close : CAMERA.chase;
    const zoom = cfg.zoom ?? 1;

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

    const speedTarget = smoothstep(0, CAMERA.speedRef, Math.abs(vehicle.forwardSpeed));
    this.speedT = damp(this.speedT, speedTarget, CAMERA.speedLag, dt);
    const speedT = this.speedT;

    // ---- the cinematic terms ---------------------------------------------
    // Longitudinal acceleration, smoothed: under throttle the camera falls
    // back from the car, under braking it closes in. This is what makes a
    // launch FEEL like a launch — the car pulls away from the lens.
    if (dt > 0) {
      const a = (vehicle.forwardSpeed - this._prevSpeed) / dt;
      this._accel = damp(this._accel, clamp(a, -25, 25), 4.0, dt);
      // Yaw rate from the heading the rig is following (rad/s, signed).
      const cr = this._prevHeading.x * this.heading.z - this._prevHeading.z * this.heading.x;
      this._yawRate = damp(this._yawRate, clamp(cr / dt, -2, 2), 5.0, dt);
    }
    this._prevSpeed = vehicle.forwardSpeed;
    this._prevHeading.copy(this.heading);
    const lag = clamp(this._accel * CAMERA.accelLag, -CAMERA.accelLagMax * 0.7, CAMERA.accelLagMax);
    this._right.set(-this.heading.z, 0, this.heading.x);
    // Look into the corner: the aim leads by the turn, more at speed.
    const lead = clamp(this._yawRate * Math.abs(vehicle.forwardSpeed) * CAMERA.cornerLead, -4, 4);

    this._desired
      .copy(vehicle.renderPos)
      .addScaledVector(this.heading, -(cfg.dist * dScale + speedT * CAMERA.distGain * zoom + lag))
      // Lower at speed: the ground rushing closer to the lens reads as pace.
      .addScaledVector(WORLD_UP, cfg.height * hScale + speedT * CAMERA.heightGain * zoom
        - speedT * speedT * CAMERA.speedDrop);

    this._target
      .copy(vehicle.renderPos)
      .addScaledVector(this.heading, cfg.ahead + speedT * 4)
      .addScaledVector(this._right, -lead)
      .addScaledVector(WORLD_UP, CAMERA.aimHeight * hScale);

    if (!this.initialised) {
      this.position.copy(this._desired);
      this.lookAt.copy(this._target);
      this._seedGoals();
      this.initialised = true;
    } else if (this._introT < 1) {
      // Double smoothstep: a single Hermite jerks at both ends of a move this long.
      this._introT = Math.min(1, this._introT + dt / this._introDur);
      const e = smoothstep(0, 1, this._introT);
      const k = smoothstep(0, 1, e);
      this.position.lerpVectors(this._introPos, this._desired, k);
      this.lookAt.lerpVectors(this._introLook, this._target, k);
    } else {
      const k = CAMERA.posDamp * (1 + speedT * 0.5);
      // Y is stiffer than X/Z, so it gets its own call rather than sharing one.
      this.position.x = dampTrack(this.position.x, this._prevDesired.x, this._desired.x, k, dt);
      this.position.y = dampTrack(this.position.y, this._prevDesired.y, this._desired.y, k * 1.4, dt);
      this.position.z = dampTrack(this.position.z, this._prevDesired.z, this._desired.z, k, dt);

      this._track(this.lookAt, this._prevTarget, this._target, CAMERA.aimDamp, dt);
    }
    this._seedGoals();

    this.camera.position.copy(this.position);
    this.camera.up.copy(WORLD_UP);
    this.camera.lookAt(this.lookAt);

    this.camera.rotateZ(clamp(vehicle.slip * Math.sign(vehicle.wheels[2].slipLat) * 0.05, -0.06, 0.06));
    // Lean into the turn, like a camera operator bracing against it.
    this.camera.rotateZ(clamp(this._yawRate * speedT * CAMERA.lean, -0.07, 0.07));
    this._shake(dt, speedT);

    this._applyFov(dt, speedT, vehicle, zoom);
  }

  /**
   * Trauma shake plus a speed rumble, applied in the camera's own frame
   * after it has been aimed, so it never feeds back into the damped rig.
   */
  _shake(dt, speedT) {
    this.trauma = Math.max(0, this.trauma - CAMERA.traumaDecay * dt);
    this._shakeT += dt;
    const k = this.trauma * this.trauma * CAMERA.shakeTrauma
            + speedT * speedT * speedT * CAMERA.shakeSpeed;
    if (k <= 1e-5) return;
    const t = this._shakeT * CAMERA.shakeFreq;
    this.camera.translateX(wobble(t, 1.3) * k * 0.6);
    this.camera.translateY(wobble(t, 7.1) * k * 0.45);
    this.camera.rotateX(wobble(t * 1.3, 3.7) * k * 0.05);
    this.camera.rotateY(wobble(t * 1.1, 5.9) * k * 0.05);
    this.camera.rotateZ(wobble(t * 0.9, 9.2) * k * 0.035);
  }

  /**
   * CINEMATIC mode: an auto-directed sequence of shots, cut between rather
   * than flown between, the way a broadcast does it.
   *
   *   trackside  a fixed telephoto on the verge ahead; the car approaches and
   *              blasts past. The lens zooms to hold the car's size, so the
   *              background compresses — the classic motorsport shot.
   *   tracking   a low "camera car" alongside, ground streaking past.
   *   heli       high and behind, the road unrolling ahead.
   */
  _updateCinematic(dt, vehicle) {
    const cam = this.camera;
    const speed = Math.abs(vehicle.forwardSpeed);
    const speedT = smoothstep(0, CAMERA.speedRef, speed);
    this.speedT = speedT;
    const shot = this._shot;
    const kinds = ['trackside', 'tracking', 'heli', 'trackside'];
    let cut = !shot || !this.initialised;
    if (shot) {
      shot.t += dt;
      if (shot.kind === 'trackside') {
        const past = this.carS - shot.s;
        cut = cut || past > 30 || shot.t > 9 || (speed < 3 && shot.t > 4);
      } else {
        cut = cut || shot.t > shot.len;
      }
    }
    if (cut) {
      const kind = kinds[this._shotIdx++ % kinds.length];
      const side = Math.random() < 0.5 ? -1 : 1;
      this._shot = {
        kind, side, t: 0, len: kind === 'heli' ? 7 : 6,
        s: this.carS + clamp(speed * 3.2, 45, 140),
        // On the shoulder, just off the tarmac: further out the verge grass is
        // tall enough to fill a telephoto frame.
        v: side * (ROAD.halfWidth + 1.8 + Math.random() * 2.5),
        h: 2.0 + Math.random() * 1.6,
      };
      if (kind === 'trackside') this._placeTrackside(this._shot);
      this.initialised = true;
      this._cutFrame = true;
    }
    const S = this._shot;
    this._fwd.copy(vehicle.renderFwd);
    this._fwd.y = 0;
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(0, 0, -1);
    this._fwd.normalize();
    this._right.set(-this._fwd.z, 0, this._fwd.x);

    let fovTarget = CAMERA.fov;
    this._target.copy(vehicle.renderPos).addScaledVector(WORLD_UP, 0.8);
    if (S.kind === 'trackside') {
      this._desired.copy(this._shotPos);
      // Telephoto that holds the car's apparent size: fov from distance.
      const d = this._desired.distanceTo(vehicle.renderPos);
      fovTarget = clamp(2 * Math.atan(5.5 / Math.max(1, d)) * 180 / Math.PI, 14, 62);
      this._target.addScaledVector(this._fwd, clamp(speed * 0.06, 0, 2.5));
    } else if (S.kind === 'tracking') {
      this._desired.copy(vehicle.renderPos)
        .addScaledVector(this._right, S.side * 4.6)
        .addScaledVector(this._fwd, 2.2 + Math.sin(S.t * 0.6) * 1.6)
        .addScaledVector(WORLD_UP, 0.75);
      fovTarget = 58;
    } else {
      this._desired.copy(vehicle.renderPos)
        .addScaledVector(this._fwd, -26 + S.t * 1.5)
        .addScaledVector(this._right, S.side * 9)
        .addScaledVector(WORLD_UP, 14 - S.t * 0.6);
      this._target.addScaledVector(this._fwd, 18);
      fovTarget = 46;
    }
    if (this._cutFrame) {
      this.position.copy(this._desired);
      this.lookAt.copy(this._target);
      this.fov = fovTarget;
      this._seedGoals();
      this._cutFrame = false;
    } else if (S.kind === 'trackside') {
      this.position.copy(this._desired);
      this._track(this.lookAt, this._prevTarget, this._target, 9, dt);
    } else {
      this._track(this.position, this._prevDesired, this._desired, 6, dt);
      this._track(this.lookAt, this._prevTarget, this._target, 8, dt);
    }
    this._seedGoals();
    cam.position.copy(this.position);
    cam.up.copy(WORLD_UP);
    cam.lookAt(this.lookAt);
    // A hand-held operator: a little drift even when nothing happens.
    this.trauma = Math.max(this.trauma, S.kind === 'trackside' ? 0.18 : 0.12);
    this._shake(dt, speedT * 0.6);
    this.fov = damp(this.fov, fovTarget, S.kind === 'trackside' ? 6 : 2.5, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  /**
   * Stands the trackside camera on the ground at (s, v) and makes sure it can
   * see the road where the car will come from: if a crest is in the way, the
   * other verge is tried, then the camera is raised over it.
   */
  _placeTrackside(shot) {
    const look = this._tmp2 || (this._tmp2 = new THREE.Vector3());
    const p = this._shotPos;
    for (let attempt = 0; attempt < 2; attempt++) {
      const g = this.groundAt(shot.s, shot.v, this._tmp);
      p.set(g.x, g.y + shot.h, g.z);
      let clear = true;
      for (const back of [20, 40]) {
        const r = this.groundAt(shot.s - back, 0, look);
        const ty = r.y + 0.8;
        for (let k = 1; k < 8; k++) {
          const t = k / 8;
          const x = p.x + (r.x - p.x) * t, z = p.z + (r.z - p.z) * t;
          const yRay = p.y + (ty - p.y) * t;
          const yGnd = this.groundHeight ? this.groundHeight(x, z) : -Infinity;
          if (yGnd > yRay - 0.3) { clear = false; break; }
        }
        if (!clear) break;
      }
      if (clear) return;
      if (attempt === 0) shot.v = -shot.v;
    }
    shot.h += 4;
    p.y += 4;
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
