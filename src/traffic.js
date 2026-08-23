/**
 * traffic.js — other cars on the road.
 *
 * TRAFFIC IS NOT SIMULATED, AND THAT IS THE DESIGN.
 *
 * Every previous version of this file tried to make traffic real rigid bodies
 * so collisions would "just work", and every one of them failed in the same
 * way: a body that is driven by writing its velocity has effectively infinite
 * mass, so the solver's contact impulse is never consumed and compounds frame
 * over frame. The measured results were a struck car reaching 6920 km/h, the
 * player ejected 35 m vertically, wrecks leaving at several hundred metres per
 * second, and — after each was patched — cars that simply stopped and sat
 * there. Releasing control just before contact bounded the damage without
 * curing it, because the underlying object still had two masters.
 *
 * So traffic has ONE master. There are no traffic rigid bodies and no traffic
 * colliders anywhere in the world. A car is a position on the spline, `(s, v)`,
 * a speed, and a mesh. Nothing the solver does can touch it, which means:
 *
 *   - it cannot be launched, cannot gain energy, cannot come to rest in the
 *     middle of the road;
 *   - the player's suspension rays cannot find "ground" on its roof (the bug
 *     that arrived twice by different routes);
 *   - eight cars cost eight matrices per frame instead of eight rigid bodies.
 *
 * Hitting one still has to feel like hitting something, and it does — but the
 * exchange is computed directly. The overlap test is two boxes in road space;
 * the response is the closed-form impulse for two masses meeting at a closing
 * speed, applied to the player's body and nowhere else. The other car takes
 * its half as a scripted spin-out. Because the struck car is scripted it can be
 * moved out of the way immediately, so no penetration ever persists and there
 * is nothing for a solver to recover from.
 *
 * What IS simulated is the behaviour, because that is the part you feel: a
 * car-following model so traffic bunches and releases, awareness of the player
 * coming up behind, and lane changes to overtake or to pull aside when flashed.
 *
 * Lanes are numbered outward from the centreline. Positive offsets run with the
 * player, negative ones come the other way.
 */

import * as THREE from 'three';
import { ROAD, TRAFFIC, SCORE } from './config.js';
import { makeFrame } from './path.js';
import { clamp, lerp, damp, mulberry32, hashInt, hashString } from './util.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Lane centres, inner first. Sign gives direction of travel. */
function laneOffsets() {
  const half = ROAD.laneWidth * 0.5;
  return [half, half + ROAD.laneWidth];
}

export class Traffic {
  constructor({ scene, path, chunks, models, roster }) {
    this.scene = scene;
    this.path = path;
    this.chunks = chunks;
    this.models = models;
    this.roster = roster.filter((c) => models.has(c.id));

    this.cars = [];
    this.lanes = laneOffsets();
    // Seeded from the world, not from a constant: with a fixed seed every seed
    // string produced the same nine cars in the same order, which a soak test
    // across three worlds made obvious by returning identical numbers.
    this.rng = mulberry32(hashInt(0x51ed) ^ hashString(path.seed || ''));
    this._nextId = 0;

    /** Impact bookkeeping, read by the game for audio and camera feedback. */
    this.lastImpact = 0;
    /** Rises on every genuine collision. Traffic mode ends a run on a change. */
    this.impacts = 0;
    /**
     * Near misses completed this frame, drained by the scorer. A pass is only
     * emitted once the car is properly astern, so the gap recorded is the
     * closest the two ever actually got rather than wherever they happened to
     * be on the frame the test ran.
     */
    this.passes = [];
    /** Whether cars are wanted at all — Zen mode turns them off. */
    this.enabled = true;

    this._pos = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._ax = new THREE.Vector3();
    this._ay = new THREE.Vector3();
    this._az = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._vel = new THREE.Vector3();
    this._spunQ = new THREE.Quaternion();
    // frameAt() allocates a frame when not given one, and this file calls it
    // three times per car per frame. Reused scratch keeps the update pass free
    // of garbage, which is the same rule the rest of the hot path follows.
    this._fA = makeFrame();
    this._fB = makeFrame();
    this._fC = makeFrame();
  }

  /* ------------------------------------------------------------- spawning -- */

  /**
   * Clones a roster model. Geometries and materials are shared with the
   * original, so a clone costs a few matrices rather than a copy of the car.
   */
  _instance(spec) {
    const src = this.models.get(spec.id);
    const group = new THREE.Group();
    group.add(src.body.clone(true));
    const wheels = ['FL', 'FR', 'BL', 'BR'].map((k) => {
      const w = src.wheels[k].clone(true);
      group.add(w);
      return w;
    });
    return { group, wheels, metrics: src.metrics };
  }

  _spawn(s, laneIndex, dir) {
    const spec = this.roster[Math.floor(this.rng() * this.roster.length)];
    const inst = this._instance(spec);
    this.scene.add(inst.group);

    const m = inst.metrics;
    const cruise = lerp(TRAFFIC.speedMin, TRAFFIC.speedMax, this.rng());
    const car = {
      id: this._nextId++,
      spec,
      inst,
      s,
      dir,                              // +1 with the player, -1 oncoming
      lane: laneIndex,
      v: dir * this.lanes[laneIndex],
      vSmooth: dir * this.lanes[laneIndex],
      speed: cruise,
      cruise,
      spin: 0,
      changeCooldown: 0,
      yielding: 0,
      mass: spec.mass || 1500,

      // Footprint used by the overlap test, in road space.
      halfLen: m.bodyHalfLength,
      halfWid: m.bodyHalfWidth,

      /** Seconds of scripted spin-out left; 0 means under control. */
      spun: 0,
      /** Yaw rate and lateral drift while spun, both decaying. */
      spunYaw: 0,
      spunRate: 0,
      spunDrift: 0,
    };

    this._place(car, 0);
    this.cars.push(car);
    return car;
  }

  _despawn(car) {
    this.scene.remove(car.inst.group);
    const i = this.cars.indexOf(car);
    if (i >= 0) this.cars.splice(i, 1);
  }

  dispose() {
    for (const c of this.cars.slice()) this._despawn(c);
  }

  /** Zen mode has an empty road; nothing spawns and nothing is drawn. */
  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.dispose();
  }

  /* --------------------------------------------------------------- update -- */

  /**
   * @param {object} player  { s, v, speed, flashing, vehicle }
   */
  update(dt, player) {
    this.passes.length = 0;
    this.lastImpact = Math.max(0, this.lastImpact - dt);
    if (!this.enabled) {
      if (this.cars.length) this.dispose();
      return;
    }
    this._maintainPopulation(player);

    // Sorted once per frame so the follow model reads a stable ordering.
    const sorted = this.cars.slice().sort((a, b) => a.s - b.s);

    for (let i = 0; i < sorted.length; i++) {
      const car = sorted[i];
      car.changeCooldown = Math.max(0, car.changeCooldown - dt);

      if (car.spun > 0) {
        this._advanceSpun(car, dt);
      } else {
        const target = this._targetSpeed(car, sorted, player, dt);
        // Asymmetric: lift off gently, brake hard. Traffic that decelerates as
        // slowly as it accelerates drives straight through the car in front.
        const rate = target < car.speed ? TRAFFIC.brakeRate : TRAFFIC.accelRate;
        car.speed = damp(car.speed, target, rate, dt);
        car.s += car.speed * car.dir * dt;
      }
      this._place(car, dt);
    }

    this._separate(sorted);
    if (player.vehicle) {
      this._resolvePlayer(dt, player);
      this._trackPasses(player);
    }
  }

  /**
   * Watches every car through its closest approach and reports it once it is
   * astern.
   *
   * Sampling the gap on whatever frame the cars happen to be level would make
   * the reward depend on frame rate, and at 250 km/h against oncoming traffic
   * two cars can go from ten metres apart to ten metres past in a single frame.
   * Keeping a running minimum over the whole encounter and emitting at the end
   * measures the encounter rather than a moment of it.
   */
  _trackPasses(player) {
    const halfWid = player.vehicle.V.chassis.hx;
    for (const car of this.cars) {
      const d = car.s - player.s;
      const near = Math.abs(d) < SCORE.passWindow;

      if (near && car.spun <= 0) {
        // Clearance between the two bodies, not between their centrelines.
        const gap = Math.max(0, Math.abs(car.v - player.v) - (car.halfWid + halfWid));
        car.nearMin = car.nearMin === undefined ? gap : Math.min(car.nearMin, gap);
        car.wasNear = true;
      } else if (car.wasNear) {
        if (car.spun <= 0 && car.nearMin !== undefined) {
          this.passes.push({ gap: car.nearMin, oncoming: car.dir < 0 });
        }
        car.wasNear = false;
        car.nearMin = undefined;
      }
    }
  }

  /**
   * Keeps a band of road around the player populated.
   *
   * Cars appear beyond `spawnMin`, which is set past the point where fog and
   * depth of field have taken them: the previous window started 40 m ahead, so
   * cars materialised in plain sight in the middle of the carriageway. Nothing
   * spawns behind — same-direction traffic is slower than the player by
   * construction, so anything behind would never be seen again.
   */
  _maintainPopulation(player) {
    for (const car of this.cars.slice()) {
      const rel = (car.s - player.s) * 1;
      if (rel > TRAFFIC.ahead + 120 || rel < -TRAFFIC.behind) this._despawn(car);
      else if (car.spun < 0) this._despawn(car);
    }

    // Enough attempts to actually fill the band. The spawn window is 160 m and
    // a candidate is rejected if it lands near an existing car IN THE SAME LANE
    // — cars abreast in different lanes are traffic, not a clash, and treating
    // them as one was rejecting most candidates and leaving the road half empty.
    let guard = 0;
    while (this.cars.length < TRAFFIC.count && guard++ < 40) {
      const dir = this.rng() < TRAFFIC.oncomingShare ? -1 : 1;
      const s = player.s + lerp(TRAFFIC.spawnMin, TRAFFIC.ahead, this.rng());
      if (s < 40) continue;

      const lane = this.rng() < 0.62 ? 0 : 1;
      const clash = this.cars.some(
        (c) => c.dir === dir && c.lane === lane && Math.abs(c.s - s) < TRAFFIC.minGap * 1.6
      );
      if (clash) continue;
      this._spawn(s, lane, dir);
    }
  }

  /**
   * Desired speed: cruise, limited by the car in front, by the corner ahead,
   * and modified by whatever the player is doing behind.
   */
  _targetSpeed(car, sorted, player, dt) {
    let target = car.cruise;

    // ---- car in front, same direction and lane --------------------------
    //
    // Scan every car rather than stepping through the sorted list. Stepping
    // breaks as soon as it meets a car in another lane or direction, and with
    // four lanes interleaved that is almost immediately — so most cars saw an
    // infinite gap and drove straight through the one in front.
    let gap = Infinity;
    let leadSpeed = 0;
    for (const other of sorted) {
      if (other === car || other.dir !== car.dir || other.lane !== car.lane) continue;
      const d = (other.s - car.s) * car.dir;
      if (d > 0 && d < gap) { gap = d; leadSpeed = other.spun > 0 ? 0 : other.speed; }
    }

    if (gap < TRAFFIC.minGap * 6) {
      // Follow at a time headway; below the minimum gap, match or undercut.
      const desired = TRAFFIC.minGap + car.speed * TRAFFIC.headway;
      const t = clamp((gap - TRAFFIC.minGap) / Math.max(1, desired - TRAFFIC.minGap), 0, 1);
      target = Math.min(target, lerp(leadSpeed * 0.85, car.cruise, t));
    }
    // Hard floor on separation. The headway model alone converges too slowly
    // once two cars are already inside the minimum gap.
    if (gap < TRAFFIC.minGap) {
      target = Math.min(target, leadSpeed * clamp(gap / TRAFFIC.minGap, 0, 1) * 0.8);
    }

    // ---- corners --------------------------------------------------------
    const look = this.path.frameAt(car.s + car.dir * 45, this._fB);
    const curv = Math.abs(look.curv);
    if (curv > 1e-5) {
      // v = sqrt(a / k) — the same limit the player's steering law uses.
      target = Math.min(target, Math.sqrt(TRAFFIC.cornerAccel / curv));
    }

    // ---- the player -----------------------------------------------------
    if (car.dir > 0) {
      const behind = car.s - player.s;
      const sameSide = player.v * car.dir > -0.5;
      const closing = player.speed > car.speed;

      if (sameSide && behind > 0 && behind < TRAFFIC.noticeRange && closing) {
        const urgency = 1 - behind / TRAFFIC.noticeRange;

        if (player.flashing) {
          // Being flashed: pull over, but only into a lane that is actually
          // free. An unchecked change drops the car on top of whoever is
          // already there.
          car.yielding = 1;
          if (car.lane === 0 && car.changeCooldown <= 0 && this._laneClear(car, 1)) {
            car.lane = 1;
            car.changeCooldown = TRAFFIC.changeCooldown;
          }
          target = Math.min(target, car.cruise * lerp(1, TRAFFIC.yieldSlow, urgency));
        } else if (Math.abs(player.v - car.v) < ROAD.laneWidth * 0.75) {
          // Someone right behind in your lane: most drivers speed up a little.
          target = Math.min(car.cruise * TRAFFIC.pressedBoost, TRAFFIC.speedMax * 1.1);
        }
      } else {
        car.yielding = Math.max(0, car.yielding - dt * 0.5);
      }

      // Drift back to the inner lane once nobody is pushing.
      if (car.yielding <= 0 && car.lane === 1 && car.changeCooldown <= 0 && this.rng() < 0.004) {
        if (this._laneClear(car, 0)) {
          car.lane = 0;
          car.changeCooldown = TRAFFIC.changeCooldown;
        }
      }
    }

    return Math.max(TRAFFIC.speedFloor, target);
  }

  /** Is `lane` free around this car's station, in its own direction? */
  _laneClear(car, lane) {
    const room = TRAFFIC.minGap * 2.2;
    return !this.cars.some(
      (c) => c !== car && c.dir === car.dir && c.lane === lane && Math.abs(c.s - car.s) < room
    );
  }

  /**
   * Last line of defence against two cars occupying the same metre of road.
   *
   * The follow model converges, but it is a controller: give it a step input —
   * a spawn, a spin-out braking hard in front — and it needs time it may not
   * have. Because nothing here is simulated, separation can simply be asserted:
   * push the trailing car back along the road until the gap is legal. It costs
   * one pass over an already-sorted list and it makes overlap impossible rather
   * than unlikely.
   */
  _separate(sorted) {
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        if (b.s - a.s > TRAFFIC.minGap) break;      // sorted: nothing else is near
        if (a.spun || b.spun) continue;
        if (a.dir !== b.dir || a.lane !== b.lane) continue;
        const need = a.halfLen + b.halfLen + 1.5;
        const d = b.s - a.s;
        if (d >= need) continue;
        // The one travelling in +s is ahead when dir is +1, behind when -1.
        const push = (need - d) * 0.5;
        a.s -= push;
        b.s += push;
      }
    }
  }

  /* -------------------------------------------------------------- impacts -- */

  /**
   * Player↔traffic contact, resolved in closed form.
   *
   * Overlap is two boxes in road space — cheap, and stable in a way a world
   * space test on a curved road is not. The response is the textbook impulse
   * for two masses meeting at a closing speed along the contact normal:
   *
   *     j = -(1 + e) · (v_rel · n) · m1·m2/(m1 + m2)
   *
   * applied to the player and to nothing else. The struck car takes its share
   * as a spin-out, and because that is scripted it leaves immediately, so the
   * two never remain interpenetrated and no correction impulse is ever needed.
   * The player's Δv is capped: the cap is not a fudge, it is the difference
   * between a shunt and being deleted from the world by a glancing blow at
   * 300 km/h.
   */
  _resolvePlayer(dt, player) {
    const v = player.vehicle;
    const hitLen = v.V.chassis.hz;
    const hitWid = v.V.chassis.hx;
    const mP = v.V.mass;

    for (const car of this.cars) {
      if (car.spun > 0) continue;                    // already out of the way

      const ds = car.s - player.s;
      const dv = car.v - player.v;
      const overS = car.halfLen + hitLen - Math.abs(ds);
      if (overS <= 0) continue;
      const overV = car.halfWid + hitWid - Math.abs(dv);
      if (overV <= 0) continue;

      // Resolve along the shallower axis — the same rule an AABB solver uses,
      // and it is what tells a rear-end shunt from a side-swipe.
      const frame = this.path.frameAt(car.s, this._fC);
      const sideways = overV < overS;
      const n = this._n;
      if (sideways) {
        n.copy(frame.right).multiplyScalar(dv > 0 ? -1 : 1);
      } else {
        n.copy(frame.tan).multiplyScalar(ds > 0 ? -1 : 1);
      }
      n.y = 0;
      if (n.lengthSq() < 1e-8) continue;
      n.normalize();

      // Closing speed along the normal. The traffic car's velocity is exactly
      // what we told it to do, so there is no state to reconcile.
      const lv = v.body.linvel();
      this._vel.copy(frame.tan).multiplyScalar(car.speed * car.dir);
      const rel =
        (lv.x - this._vel.x) * n.x + (lv.y - this._vel.y) * n.y + (lv.z - this._vel.z) * n.z;
      if (rel > -0.4) continue;                      // separating, or a graze

      const mC = car.mass;
      const reduced = (mP * mC) / (mP + mC);
      let j = -(1 + TRAFFIC.restitution) * rel * reduced;
      j = Math.min(j, TRAFFIC.maxImpactDv * mP);

      v.body.applyImpulse({ x: n.x * j, y: 0, z: n.z * j }, true);
      // A shove that is purely linear reads as a bumper-car nudge. A little
      // yaw, signed by which end took the hit, is what makes it a collision.
      const yaw = sideways ? 0 : (dv > 0 ? -1 : 1) * j * 0.05;
      if (yaw) v.body.applyTorqueImpulse({ x: 0, y: yaw, z: 0 }, true);

      this._spinOut(car, -rel, sideways ? Math.sign(dv) : Math.sign(-ds));
      this.lastImpact = 1;
      this.impacts++;
      // A car that was hit is not a car that was passed cleanly.
      car.wasNear = false;
      car.nearMin = undefined;
    }
  }

  /** Hands a car over to a scripted spin-out. */
  _spinOut(car, closing, side) {
    car.spun = TRAFFIC.spinTime;
    car.spunRate = clamp(closing * 0.10, 0.5, 3.2) * (side || 1);
    car.spunDrift = clamp(closing * 0.28, 1.5, 7) * (side || 1);
    car.speed = Math.max(TRAFFIC.speedFloor, car.speed * 0.55);
  }

  /**
   * A spin-out, animated rather than simulated. The car slews toward the verge,
   * rotating and slowing, then is taken off the board. It never stops in a live
   * lane, never tumbles, and never needs a velocity clamp — none of which could
   * be said of it when the solver owned it.
   */
  _advanceSpun(car, dt) {
    car.spun -= dt;
    car.s += car.speed * car.dir * dt;
    car.speed = Math.max(0, car.speed - TRAFFIC.spinDecel * dt);

    car.spunYaw += car.spunRate * dt;
    car.spunRate = damp(car.spunRate, 0, 1.4, dt);

    // Slide off the carriageway; that is where a spun car belongs, and it
    // clears the lane for everyone behind.
    car.vSmooth += car.spunDrift * dt;
    car.spunDrift = damp(car.spunDrift, 0, 0.8, dt);
    car.vSmooth = clamp(car.vSmooth, -ROAD.halfWidth - 6, ROAD.halfWidth + 6);
    car.v = car.vSmooth;

    if (car.spun <= 0) car.spun = -1;                // flagged for despawn
  }

  /* ------------------------------------------------------------- placement -- */

  /**
   * Puts a car on the road surface, facing along it and leaning with it.
   *
   * The full road frame is used, not just a yaw: a car that stays level while
   * the road climbs and banks under it is one of those things nobody names but
   * everybody notices.
   */
  _place(car, dt) {
    const f = this.path.frameAt(car.s, this._fA);

    if (car.spun === 0) {
      // Lane changes are eased, not teleported.
      const wanted = car.dir * this.lanes[car.lane];
      car.vSmooth = dt > 0 ? damp(car.vSmooth, wanted, TRAFFIC.laneRate, dt) : wanted;
      car.v = car.vSmooth;
    }

    this.chunks.groundAt(car.s, car.v, this._pos);

    // Basis from the road: local -Z is forward, so local +Z is the reverse of
    // travel, and local +Y is the road's own up (which carries the banking).
    this._az.copy(f.tan).multiplyScalar(-car.dir).normalize();
    this._ay.copy(f.up);
    this._ax.crossVectors(this._ay, this._az).normalize();
    this._ay.crossVectors(this._az, this._ax).normalize();
    this._m.makeBasis(this._ax, this._ay, this._az);
    this._q.setFromRotationMatrix(this._m);
    if (car.spunYaw) {
      this._q.multiply(this._spunQ.setFromAxisAngle(WORLD_UP, car.spunYaw));
    }

    const g = car.inst.group;
    g.position.copy(this._pos);
    g.quaternion.copy(this._q);

    // Wheels: sit at the model's own rolling radius and turn with road speed.
    const r = car.inst.metrics.wheelRadius;
    car.spin += (car.speed / r) * dt;
    const wb = car.inst.metrics.wheelbaseHalf;
    const tr = car.inst.metrics.trackHalf;
    const layout = [[-tr, -wb], [tr, -wb], [-tr, wb], [tr, wb]];
    for (let i = 0; i < 4; i++) {
      const w = car.inst.wheels[i];
      w.position.set(layout[i][0], r, layout[i][1]);
      w.rotation.set(-car.spin, 0, 0);
    }
  }
}
