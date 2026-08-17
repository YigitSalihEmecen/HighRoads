/**
 * traffic.js — other cars on the road.
 *
 * Traffic is kinematic, not simulated. Running nine more raycast vehicles would
 * cost nine more drivetrains and give nothing back: nobody sees an AI car's
 * suspension travel, and an AI that can spin off into a ditch is a bug, not a
 * feature. Each car instead rides the spline directly — position from (s, lane
 * offset), height from the same ground function the terrain uses — and carries
 * a kinematic Rapier body so the player can still hit it.
 *
 * What is simulated is the *behaviour*, because that is the part you feel:
 *
 *   - a car-following model, so traffic bunches and releases rather than
 *     driving through itself;
 *   - awareness of the player behind, which is what makes it feel like other
 *     drivers rather than scenery moving at a fixed speed;
 *   - lane changes, both to overtake and to pull aside when flashed.
 *
 * Lanes are numbered outward from the centreline. Positive offsets run with the
 * player, negative ones come the other way.
 */

import * as THREE from 'three';
import { ROAD, TRAFFIC } from './config.js';
import { clamp, lerp, damp, smoothstep, mulberry32, hashInt } from './util.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Collision groups, packed as Rapier expects: membership in the high 16 bits,
 * filter in the low 16. Group 1 is traffic, group 0 is everything else.
 */
const TRAFFIC_GROUP = (0x0002 << 16) | 0xffff;

/** Lane centres, inner first. Sign gives direction of travel. */
function laneOffsets() {
  const half = ROAD.laneWidth * 0.5;
  return [half, half + ROAD.laneWidth];
}

export class Traffic {
  constructor({ scene, world, RAPIER, path, chunks, models, roster }) {
    this.scene = scene;
    this.world = world;
    this.RAPIER = RAPIER;
    this.path = path;
    this.chunks = chunks;
    this.models = models;
    this.roster = roster.filter((c) => models.has(c.id));

    this.cars = [];
    this.lanes = laneOffsets();
    this.rng = mulberry32(hashInt(0x51ed) ^ 7);
    this._nextId = 0;

    this._pos = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._frame = null;
  }

  /* ------------------------------------------------------------- spawning -- */

  /**
   * Clones a roster model. Geometries and materials are shared with the
   * original, so a clone costs a few matrices rather than a copy of the car.
   */
  _instance(spec) {
    const src = this.models.get(spec.id);
    const group = new THREE.Group();
    const body = src.body.clone(true);
    group.add(body);

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

    const { RAPIER, world } = this;
    const rb = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    const m = inst.metrics;
    // Solid, but in their own collision group.
    //
    // Traffic has to be hittable, yet it must never appear to the suspension:
    // a wheel ray that lands on a passing car finds "ground" three feet in the
    // air and the spring throws the player off the road. Membership TRAFFIC,
    // filter TRAFFIC — so cars collide with each other and with the player's
    // chassis, while the wheel rays (which query the default group) skip them
    // entirely.
    const col = RAPIER.ColliderDesc.cuboid(m.bodyHalfWidth * 0.9, m.bodyHeight * 0.42, m.bodyHalfLength * 0.95)
      .setTranslation(0, m.bodyHeight * 0.5, 0)
      .setCollisionGroups(TRAFFIC_GROUP);
    world.createCollider(col, rb);

    const cruise = lerp(TRAFFIC.speedMin, TRAFFIC.speedMax, this.rng());
    const car = {
      id: this._nextId++,
      spec,
      inst,
      rb,
      s,
      dir,                       // +1 with the player, -1 oncoming
      lane: laneIndex,
      v: dir * this.lanes[laneIndex],
      vSmooth: dir * this.lanes[laneIndex],
      speed: cruise,
      cruise,
      spin: 0,
      changeCooldown: 0,
      yielding: 0,
    };
    this.cars.push(car);
    return car;
  }

  _despawn(car) {
    this.scene.remove(car.inst.group);
    this.world.removeRigidBody(car.rb);
    const i = this.cars.indexOf(car);
    if (i >= 0) this.cars.splice(i, 1);
  }

  dispose() {
    for (const c of this.cars.slice()) this._despawn(c);
  }

  /* --------------------------------------------------------------- update -- */

  /**
   * @param {object} player  { s, v, speed, flashing }
   */
  update(dt, player) {
    this._maintainPopulation(player);

    // Sorted once per frame so the follow model can find the car ahead in O(1)
    // instead of scanning every other car for every car.
    const ahead = this.cars.slice().sort((a, b) => a.s - b.s);

    for (let i = 0; i < ahead.length; i++) {
      const car = ahead[i];
      car.changeCooldown = Math.max(0, car.changeCooldown - dt);

      const target = this._targetSpeed(car, ahead, i, player, dt);
      // Asymmetric: lift off gently, brake hard. Traffic that decelerates as
      // slowly as it accelerates drives straight through the car in front.
      const rate = target < car.speed ? TRAFFIC.brakeRate : TRAFFIC.accelRate;
      car.speed = damp(car.speed, target, rate, dt);

      car.s += car.speed * car.dir * dt;
      this._place(car, dt);
    }
  }

  /** Keeps a band of road around the player populated. */
  _maintainPopulation(player) {
    for (const car of this.cars.slice()) {
      const rel = (car.s - player.s) * 1;
      if (rel > TRAFFIC.ahead + 80 || rel < -TRAFFIC.behind - 80) this._despawn(car);
    }

    let guard = 0;
    while (this.cars.length < TRAFFIC.count && guard++ < 8) {
      const dir = this.rng() < TRAFFIC.oncomingShare ? -1 : 1;
      // Spawn out of sight: ahead of the player for same-direction traffic,
      // and well ahead for oncoming, since it closes fast.
      const span = dir > 0 ? [40, TRAFFIC.ahead] : [TRAFFIC.ahead * 0.5, TRAFFIC.ahead];
      const s = player.s + lerp(span[0], span[1], this.rng());
      if (s < 20) continue;

      const lane = this.rng() < 0.62 ? 0 : 1;
      // Never drop a car on top of another.
      const clash = this.cars.some(
        (c) => c.dir === dir && Math.abs(c.s - s) < TRAFFIC.minGap * 1.6
      );
      if (clash) continue;
      this._spawn(s, lane, dir);
    }
  }

  /**
   * Desired speed: cruise, limited by the car in front, by the corner ahead,
   * and modified by whatever the player is doing behind.
   */
  _targetSpeed(car, sorted, index, player, dt) {
    let target = car.cruise;

    // ---- car in front, same direction and lane --------------------------
    //
    // Scan every car rather than stepping through the sorted list. Stepping
    // breaks as soon as it meets a car in another lane or direction, and with
    // four lanes interleaved that is almost immediately — so most cars saw an
    // infinite gap and drove straight through the one in front. Fourteen cars
    // makes the full scan free.
    let gap = Infinity;
    let leadSpeed = 0;
    for (const other of sorted) {
      if (other === car || other.dir !== car.dir || other.lane !== car.lane) continue;
      const d = (other.s - car.s) * car.dir;
      if (d > 0 && d < gap) { gap = d; leadSpeed = other.speed; }
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
    const look = this.path.frameAt(car.s + car.dir * 45);
    const curv = Math.abs(look.curv);
    if (curv > 1e-5) {
      // v = sqrt(a / k) — the same limit the player's steering law uses.
      target = Math.min(target, Math.sqrt(TRAFFIC.cornerAccel / curv));
    }

    // ---- the player -----------------------------------------------------
    if (car.dir > 0) {
      const behind = (car.s - player.s);
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

  /** Puts a car on the road surface, facing along it. */
  _place(car, dt) {
    const f = this.path.frameAt(car.s);

    // Lane changes are eased, not teleported.
    const wanted = car.dir * this.lanes[car.lane];
    car.vSmooth = damp(car.vSmooth, wanted, TRAFFIC.laneRate, dt);
    car.v = car.vSmooth;

    this.chunks.groundAt(car.s, car.v, this._pos);

    // Heading: along the tangent, reversed for oncoming traffic.
    const tx = f.tan.x * car.dir;
    const tz = f.tan.z * car.dir;
    const yaw = Math.atan2(-tx, -tz);
    this._q.setFromAxisAngle(WORLD_UP, yaw);

    const g = car.inst.group;
    g.position.copy(this._pos);
    g.quaternion.copy(this._q);

    car.rb.setNextKinematicTranslation(this._pos);
    car.rb.setNextKinematicRotation(this._q);

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
