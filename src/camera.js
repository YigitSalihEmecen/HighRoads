/**
 * camera.js — chase rig with critically-damped smoothing.
 *
 * The camera never hard-attaches to the chassis. It tracks a *flattened* copy
 * of the car's heading, so body roll and suspension pitch don't propagate into
 * the view — which is the difference between "planted" and "nauseating".
 */

import * as THREE from 'three';
import { ATMOSPHERE, CAMERA, TITLE } from './config.js';
import { clamp, damp, dampTrack, smoothstep } from './util.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Compass bearing of the sun, from the world's fixed sun direction. The title
 * rig uses it to pick which side of the car to stand on — see `_seedOrbit`.
 */
const SUN_YAW = Math.atan2(ATMOSPHERE.sunDir.x, ATMOSPHERE.sunDir.z);

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
    /** Title-screen mode: orbit the parked car instead of following it. */
    this.title = false;
    // Seeded properly by `_seedOrbit` on the first title frame, from the sun.
    // `TITLE.angles[0]` is only a value to hold until then; the key this used
    // to read — a `startAngle` key in TITLE — does not exist and evaluated to
    // undefined,
    // which made `_orbit += spin * dt` NaN for however many frames ran before
    // the seeding. The config audit in AGENT_CONTEXT §5 found it.
    this._orbit = TITLE.angles[0];
    /**
     * The fly-in. `_introT` runs 0 -> 1 across `TITLE.introTime` seconds the
     * first time the chase rig updates after Drive; while it is under 1 the rig
     * INTERPOLATES between the orbit pose it was left in and the chase pose it
     * is heading for, instead of damping toward the latter. See beginIntro().
     */
    this._introT = 1;
    this._introPos = new THREE.Vector3();
    this._introLook = new THREE.Vector3();

    /**
     * The part of the screen the title interface is NOT using, in CSS pixels,
     * and the size of the car standing in it. Both are pushed in every frame by
     * `main.js` — see `Game._frameTitle`.
     */
    this._rect = null;
    this._vw = 1;
    this._vh = 1;
    this._subjectR = 2.4;
    this._subjectH = 1.5;

    this._camRight = new THREE.Vector3();
    this._camUp = new THREE.Vector3();
    /** Where the title rig actually points, once the framing offset is on. */
    this._aim = new THREE.Vector3();

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
   * Title-screen framing.
   *
   * The car on the title screen is the real vehicle, parked on the real road in
   * the real scene, so what you are choosing is exactly what you will drive —
   * paint and all, because paint is a live material property and there is no
   * second copy of the model anywhere to disagree with it.
   */
  setTitle(on) {
    if (this.title === on) return;
    this.title = on;
    if (on) {
      this.initialised = false;      // arriving: frame the car immediately
      this._introT = 1;              // cancel any fly-in still in flight
      this._orbitSeeded = false;     // and pick the lit side again
    }
  }

  /**
   * Hands the title rig the rectangle it has to put the car in.
   *
   * Measured from the DOM by `main.js` rather than assumed, because the free
   * area is a shape that changes with the orientation, with the safe area, and
   * with whether a drawer happens to be open. A rig tuned by hand against one
   * of those puts the car behind a panel the moment another changes.
   *
   * @param {number} vw,vh   viewport, CSS pixels
   * @param {?{left:number,top:number,right:number,bottom:number}} rect
   * @param {?object} metrics  the model's measurements, for the fit
   */
  frameTitle(vw, vh, rect, metrics) {
    this._vw = Math.max(1, vw);
    this._vh = Math.max(1, vh);
    this._rect = rect || null;
    if (metrics) {
      // The DIAGONAL, not the longer side: the rig shows the car from every
      // angle, and three-quarter on is where its silhouette is widest. Fitting
      // to the length alone frames it beautifully side-on and runs it off both
      // edges of the screen a second and a half later.
      const len = (metrics.bodyHalfLength || 2.2) * 2;
      const wid = (metrics.bodyHalfWidth || 1.0) * 2;
      this._subjectR = Math.hypot(len, wid) * 0.5;
      this._subjectH = metrics.bodyHeight || 1.5;
    }
  }

  /**
   * Drive: fly in rather than cut.
   *
   * Bug #39 was the first version of this question and it was answered the
   * wrong way twice. Sweeping across the world was right while the garage was
   * the same road from another angle; cutting was right while the title screen
   * was a separate studio scene, because sweeping between two places is a lurch
   * through nothing. The title screen is back in the world, so it is the first
   * answer again — but as a scripted move, not as damping.
   *
   * Damping cannot do this. Its rate is tuned for a camera that is already
   * roughly where it belongs and needs to stay there under a car that is
   * moving; asked to cross fifteen metres it either takes several seconds or
   * arrives with a snap, and neither is a shot. An interpolation over a fixed
   * duration is: it leaves at rest, arrives at rest, and takes exactly as long
   * as it was told to.
   */
  beginIntro(seconds = TITLE.introTime) {
    this._introPos.copy(this.camera.position);
    // The OFFSET aim, not the damper's state: the fly-in has to start from
    // where the camera was actually pointing, which on the title screen is a
    // framing offset away from where the rig was tracking.
    this._introLook.copy(this._aim);
    this._introT = 0;
    this._introDur = Math.max(0.01, seconds);
    // The blend needs somewhere to blend FROM, so the rig counts as framed.
    this.initialised = true;
    this.position.copy(this._introPos);
  }

  /** True while the fly-in is still running — the run has not really begun. */
  get flyingIn() {
    return this._introT < 1;
  }

  /** How far through the fly-in, 0..1. Exposed for the render probe. */
  get introT() {
    return this._introT;
  }

  cycle() {
    this.mode = (this.mode + 1) % CAM_MODES.length;
    this.snap();
    return CAM_MODES[this.mode];
  }

  /**
   * Cut to wherever the rig belongs, on the next frame.
   *
   * For DISCONTINUOUS car motion — a respawn, a recovery, a teleport — and it is
   * not a nicety. The chase rig damps, and `dampTrack` reads the goal's own
   * travel as a velocity to lead: a 12 m jump inside a 16 ms frame is a goal
   * moving at 750 m/s, so the damper computes 79 m of lead and then spends the
   * best part of a second crawling back from it. What that looks like on screen
   * is a long sweeping move into place — which is to say, exactly like the
   * title screen's fly-in, played every time the player presses R.
   *
   * A teleport has no travel to follow, so the honest answer is to stop
   * following. `_seedGoals` runs on the next update and clears the bogus
   * history with it.
   */
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
    } else if (this._introT < 1) {
      // The fly-in. Two smoothsteps rather than one: a single Hermite leaves
      // and arrives with zero velocity but a jerk at both ends, and on a move
      // this long that reads as the camera being pushed rather than flown.
      this._introT = Math.min(1, this._introT + dt / this._introDur);
      const e = smoothstep(0, 1, this._introT);
      const k = smoothstep(0, 1, e);
      this.position.lerpVectors(this._introPos, this._desired, k);
      this.lookAt.lerpVectors(this._introLook, this._target, k);
    } else {
      // Position lags a touch more than the aim: the car leads the frame into
      // a corner instead of sitting dead centre.
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

    // A little roll into the corner, driven by lateral slip.
    this.camera.rotateZ(clamp(vehicle.slip * Math.sign(vehicle.wheels[2].slipLat) * 0.05, -0.06, 0.06));

    this._applyFov(dt, speedT, vehicle);
  }

  /**
   * The title orbit — a slow turn around the parked car, IN THE WORLD.
   *
   * Two things make this more than "point the camera at the car".
   *
   * FIT. The distance is solved so the car fills `TITLE.fill` of the free
   * rectangle on whichever axis binds, exactly as a studio rig would solve it,
   * so a monster truck and a hatchback are the same size on screen and neither
   * one overflows a phone held upright.
   *
   * PLACE. The car then has to land inside that rectangle rather than at the
   * centre of the screen, and the correction has to be applied along the
   * CAMERA's own right and up vectors, not the world's, because the rig is
   * orbiting. A point offset by `o` along one of those projects `o/(dist*tan)`
   * of a half-screen away from centre; aiming one way moves the subject the
   * other, which is why the horizontal term is negated and the vertical one is
   * not — screen Y counts downward while world Y counts up, so that sign has
   * already been paid.
   *
   * The orbit is taken about the CAR's heading rather than the world axes, so
   * an angle from `TITLE.angles` means the same three-quarter view on every
   * seed instead of whichever side of the car the road happens to be pointing.
   */
  _updateTitle(dt, vehicle) {
    this._orbit += TITLE.spin * dt;

    const vw = this._vw;
    const vh = this._vh;
    const cam = this.camera;
    cam.aspect = vw / vh;
    cam.fov = this.fov = damp(this.fov, TITLE.fov, 3, dt);
    cam.updateProjectionMatrix();

    // Fall back to a band across the middle if the interface has not been laid
    // out yet — on the very first frame every panel has zero size.
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

    // Orbit in the car's own frame. `renderFwd` is flattened first: on a banked
    // or climbing road the raw forward vector tips the whole orbit with it.
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
      // Eased, so switching to a taller car slides the framing rather than
      // cutting to it. The orbit is a moving goal like any other; the car is
      // parked here, but the CAMERA is not.
      this._track(this.position, this._prevDesired, this._desired, 5, dt);
      this._track(this.lookAt, this._prevTarget, this._target, 7, dt);
    }
    this._seedGoals();

    cam.position.copy(this.position);
    cam.up.copy(WORLD_UP);
    cam.lookAt(this.lookAt);
    cam.updateMatrixWorld();

    /**
     * Slide the aim so the car lands at the free area's centre, not the
     * screen's — see the note above for why this runs on the camera's basis.
     *
     * INTO A SEPARATE VECTOR, and that is not a style choice. `this.lookAt` is
     * the damper's own state: it is read back as the starting point of the next
     * frame's `dampTrack`. Adding the offset to it applies the offset once per
     * frame on top of a value the damper only ever pulls a FRACTION of the way
     * back, so the steady state is not `target + offset`, it is
     * `target + offset/(1 - e^(-k·dt))` — three and a half times the offset at
     * 20 fps and nine times at 60. The first version of this did exactly that,
     * and the car left the screen entirely.
     */
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

  /**
   * Which side of the car to start on.
   *
   * This is the one thing the studio had that the road does not: control of the
   * light. The world's sun is where the world's sun is, and half the compass
   * headings put the car in silhouette against its own sky — which is exactly
   * the objection that sent the title screen into a studio in the first place.
   *
   * It does not need a studio to fix, it needs the photographer to move. The
   * rig has four angles that make a good car shot — front and rear three-
   * quarter, either side — and it simply starts on whichever of them faces the
   * sun. So the car is lit on every seed, and it is still a three-quarter view
   * rather than whatever angle the light happened to demand.
   *
   * The orbit then carries it round through the dark side over the following
   * twenty seconds, which is fine: a car turning through its own shadow reads
   * as a car turning, and by then the player has looked at it.
   *
   * @param {number} carYaw  the car's heading, radians
   * @returns {number} the orbit phase, radians from directly in front
   */
  _seedOrbit(carYaw) {
    let best = TITLE.angles[0];
    let bestDot = -2;
    for (const a of TITLE.angles) {
      // The camera stands at `carYaw + a`; it is on the lit side when that
      // bearing agrees with the bearing of the sun.
      const dot = Math.cos(carYaw + a - SUN_YAW);
      if (dot > bestDot) { bestDot = dot; best = a; }
    }
    return best;
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
