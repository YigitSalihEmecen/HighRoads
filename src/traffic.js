/**
 * traffic.js — the other cars on the road.
 *
 * Traffic is not a rigid-body simulation. Each car is a point in road space
 * (s, v) with a speed, driven by a driver model; the mesh is placed from that.
 * The collision response is scripted, so a struck car cannot compound
 * impulses against the player body (see `_resolvePlayer`).
 *
 * Drivers:
 *  - follow with the Intelligent Driver Model (Treiber 2000): smooth
 *    approach, a time headway, hard braking only when something appears;
 *  - slow for corners they can see coming, braking at a comfortable rate;
 *  - keep right and overtake on the left when it pays and the gap is safe
 *    for whoever is behind in that lane (MOBIL's safety criterion) — the
 *    player included — signalling before they move;
 *  - pull aside when flashed, and when the player comes at them in their
 *    lane, brake, flash and swerve if there is room.
 * Each has a personality: desired speed, headway, how hard they accelerate.
 *
 * Every car is a different generated model from the `Fleet` (models.js).
 */

import * as THREE from 'three';
import { ROAD, TRAFFIC, SCORE } from './config.js';
import { makeFrame } from './path.js';
import { clamp, lerp, damp, mulberry32, hashInt, hashString } from './util.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const KEYS = ['FL', 'FR', 'BL', 'BR'];

const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Lane centres, inner first. Sign gives direction of travel. Lane 1 is the
 * cruising lane; a two-lane road has lane 0 alone, and no one changes lanes.
 */
function laneOffsets() {
  const half = ROAD.laneWidth * 0.5;
  return ROAD.lanesPerSide > 1 ? [half, half + ROAD.laneWidth] : [half];
}

/** Indicator lamps: one geometry, two shared materials swapped per blink. */
const MARKER_GEO = new THREE.BoxGeometry(0.14, 0.055, 0.03);
const MARKER_ON = new THREE.MeshStandardMaterial({ color: 0xffa21f, emissive: 0xff8a00, emissiveIntensity: 6 });

export class Traffic {
  /**
   * @param {object} opts.fleet  models.Fleet (or anything with acquire/release)
   */
  constructor({ scene, path, chunks, fleet }) {
    this.scene = scene;
    this.path = path;
    this.chunks = chunks;
    this.fleet = fleet;

    this.cars = [];
    this.lanes = laneOffsets();
    // Seeded from the world: a shared seed shares its traffic.
    this.rng = mulberry32(hashInt(0x51ed) ^ hashString(path.seed || ''));
    this._phase = this.rng() * 100;
    this._nextId = 0;
    this._clock = 0;

    /** Impact bookkeeping, read by the game for audio and camera feedback. */
    this.lastImpact = 0;
    /** Rises on every genuine collision. Traffic mode ends a run on a change. */
    this.impacts = 0;
    /**
     * Near misses completed this frame, drained by the scorer. Emitted only
     * once the car is astern, so the gap is the closest they ever got.
     */
    this.passes = [];
    /** Whether cars are wanted at all — Zen mode turns them off. */
    this.enabled = true;
    /** Night: everyone drives with lamps on. Set by the game from the sky. */
    this.lightsOn = false;

    this._pos = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._ax = new THREE.Vector3();
    this._ay = new THREE.Vector3();
    this._az = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._vel = new THREE.Vector3();
    this._yawQ = new THREE.Quaternion();
    this._fwd = new THREE.Vector3();
    // Reused scratch for frameAt(); it allocates when not given a frame.
    this._fA = makeFrame();
    this._fB = makeFrame();
    this._fC = makeFrame();
  }

  /* ------------------------------------------------------------- spawning -- */

  /** A pooled model in its own group, with four indicator lamps at the corners. */
  _instance(entry) {
    const model = entry.model;
    const m = model.metrics;
    const group = new THREE.Group();
    model.body.rotation.set(0, 0, 0);
    group.add(model.body);
    const wheels = KEYS.map((k) => {
      const w = model.wheels[k];
      w.rotation.set(0, 0, 0, 'YXZ');
      group.add(w);
      return w;
    });

    // Lamps sit ON the body: found once per pooled model by casting at its corners.
    if (!entry.markerSpots) {
      group.updateMatrixWorld(true);
      entry.markerSpots = this._markerSpots(model);
    }
    const marker = ([mx, my, mz]) => {
      const mesh = new THREE.Mesh(MARKER_GEO, MARKER_ON);
      mesh.visible = false;
      mesh.position.set(mx, my, mz);
      group.add(mesh);
      return mesh;
    };
    const [fl, rl, fr, rr] = entry.markerSpots;
    const markers = { left: [marker(fl), marker(rl)], right: [marker(fr), marker(rr)] };
    model.body.add(entry.proxy.mesh);
    return { group, wheels, markers, model, proxy: entry.proxy.mesh, detail: [model.body.children[0], ...wheels], metrics: m };
  }

  /** Where the body's skin is at each corner, lamp height: [FL, RL, FR, RR] as [x, y, z]. */
  _markerSpots(model) {
    const m = model.metrics;
    const y = Math.min(0.95, Math.max(0.55, m.bodyHeight * 0.52));
    const front = m.bodyFrontZ ?? -m.bodyHalfLength;
    const rear = m.bodyRearZ ?? m.bodyHalfLength;
    const ray = this._ray || (this._ray = new THREE.Raycaster());
    const spots = [];
    for (const side of [-1, 1]) {
      for (const [z0, dir] of [[front - 1, 1], [rear + 1, -1]]) {
        const x = side * m.bodyHalfWidth * 0.7;
        ray.set(this._pos.set(x, y, z0), this._n.set(0, 0, dir));
        ray.far = 3;
        const hit = ray.intersectObject(model.body, true)[0];
        const z = hit ? hit.point.z - dir * 0.015 : (dir > 0 ? front + 0.05 : rear - 0.05);
        spots.push([x, y, z]);
      }
    }
    return spots;
  }

  _spawn(s, laneIndex, dir, { fast = false } = {}) {
    const entry = this.fleet.acquire(this.rng);
    if (!entry) return null;
    const inst = this._instance(entry);
    this.scene.add(inst.group);

    const m = inst.metrics;
    const rng = this.rng;
    // Personality: 0 = Sunday driver, 1 = in a hurry. Skewed toward the middle.
    const hurry = clamp((rng() + rng() + rng()) / 3 + (fast ? 0.35 : 0), 0, 1);
    const style = entry.build && entry.build.style;
    const classPace = style === 'offroad' ? 0.88 : style === 'supercar' || style === 'wedge' ? 1.1 : 1;
    const v0 = lerp(TRAFFIC.speedMin, TRAFFIC.speedMax, clamp(hurry * 0.85 + rng() * 0.2, 0, 1)) * classPace;

    const car = {
      id: this._nextId++,
      entry,
      inst,
      s,
      dir,                              // +1 with the player, -1 oncoming
      lane: laneIndex,
      v: dir * this.lanes[laneIndex],
      latVel: 0,
      laneFrom: 0,
      laneT: 1,
      laneDur: TRAFFIC.laneChangeTime,
      pendingLane: -1,
      signal: 0,
      signalT: 0,
      hazard: false,

      speed: 0,
      accel: 0,
      v0,
      headway: TRAFFIC.headway * lerp(1.35, 0.7, hurry),
      aMax: TRAFFIC.accel * lerp(0.75, 1.45, hurry),
      bComf: TRAFFIC.decel * lerp(0.85, 1.2, hurry),
      jam: TRAFFIC.jamGap * lerp(1.2, 0.8, hurry),
      polite: lerp(0.6, 0.1, hurry),
      think: rng() * 0.5,
      cooldown: 0,
      yielding: 0,
      flashT: 0,
      leaderIsPlayer: false,

      pitch: 0, pitchV: 0, roll: 0, rollV: 0,
      heading: null,
      spin: 0,
      steer: 0,
      brake: 0,
      mass: entry.mass || 1500,

      // Footprint used by the overlap test, in road space.
      halfLen: m.bodyHalfLength,
      halfWid: m.bodyHalfWidth,

      /** Seconds of scripted spin-out left; 0 means under control, −1 flags removal. */
      spun: 0,
      spunYaw: 0,
      spunRate: 0,
      spunDrift: 0,
    };
    car.speed = Math.min(v0, this._cornerLimit(car)) * (fast ? 1 : 0.92);

    this._place(car, 0);
    this.cars.push(car);
    return car;
  }

  _despawn(car) {
    this.scene.remove(car.inst.group);
    const model = car.inst.model;
    model.body.rotation.set(0, 0, 0);
    model.setBrake(0);
    model.setHeadlights(false, false);
    for (const o of car.inst.detail) o.visible = true;
    car.inst.proxy.visible = false;
    this.fleet.release(car.entry);
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
    this._clock += dt;
    if (!this.enabled) {
      if (this.cars.length) this.dispose();
      return;
    }
    if (dt <= 0) return;
    this._player = this._playerState(player);
    this._maintainPopulation(player);

    const sorted = this.cars.slice().sort((a, b) => a.s - b.s);

    for (const car of sorted) {
      car.cooldown = Math.max(0, car.cooldown - dt);
      car.flashT = Math.max(0, car.flashT - dt);

      if (car.spun > 0) {
        this._advanceSpun(car, dt);
      } else {
        this._drive(car, dt);
      }
      this._place(car, dt);
      this._lod(car);
      this._lamps(car);
    }

    this._separate(sorted);
    if (player.vehicle) {
      this._resolvePlayer(dt, player);
      this._trackPasses(player);
    }
  }

  /** The player in road terms: where, which way along the road, how fast, and how long. */
  _playerState(player) {
    const out = this._ps || (this._ps = {});
    out.s = player.s;
    out.v = player.v;
    out.flashing = !!player.flashing;
    const ch = player.vehicle ? player.vehicle.V.chassis : { hx: 0.9, hz: 2.2 };
    out.halfLen = ch.hz;
    out.halfWid = ch.hx;
    let along = player.speed || 0;
    if (player.vehicle && player.vehicle.body) {
      const f = this.path.frameAt(player.s, this._fC);
      // The chassis as it sits, not as if it pointed down the road: a car
      // drifting sideways is short along the road and wide across it.
      const fwd = player.vehicle.fwd;
      if (fwd) {
        const c = Math.min(1, Math.abs(fwd.x * f.tan.x + fwd.z * f.tan.z) / Math.max(Math.hypot(fwd.x, fwd.z), 1e-6));
        const sn = Math.sqrt(1 - c * c);
        out.halfLen = ch.hz * c + ch.hx * sn;
        out.halfWid = ch.hz * sn + ch.hx * c;
      }
      const lv = player.vehicle.body.linvel();
      along = lv.x * f.tan.x + lv.y * f.tan.y + lv.z * f.tan.z;
    }
    out.along = along;                   // signed: + is the direction of increasing s
    return out;
  }

  /** One driver's decisions for this frame: lanes, then the throttle. */
  _drive(car, dt) {
    const P = this._player;

    // ---- think: lane choice, a couple of times a second -------------------
    car.think -= dt;
    if (car.think <= 0) {
      car.think = 0.35 + this.rng() * 0.3;
      if (car.laneT >= 1 && car.pendingLane < 0 && car.cooldown <= 0) this._considerLanes(car);
    }
    this._reactToPlayer(car, dt);

    // ---- indicator, then the manoeuvre ---------------------------------------
    if (car.pendingLane >= 0) {
      car.signalT -= dt;
      if (car.signalT <= 0) {
        car.laneFrom = car.v;
        car.lane = car.pendingLane;
        car.pendingLane = -1;
        car.laneT = 0;
      }
    }
    const target = car.dir * this.lanes[car.lane];
    const before = car.v;
    if (car.laneT < 1) {
      car.laneT = Math.min(1, car.laneT + dt / car.laneDur);
      car.v = lerp(car.laneFrom, target, smoother(car.laneT));
      if (car.laneT >= 0.9) car.signal = 0;
      if (car.laneT >= 1) car.cooldown = TRAFFIC.changeCooldown * (1 + this.rng());
    } else {
      car.v = damp(car.v, target, 2.5, dt);
    }
    car.latVel = (car.v - before) / dt;

    // ---- throttle and brake: IDM against whoever is ahead in the path ------
    const lead = this._leader(car, car.v);
    let a = this._idm(car, car.speed, lead.gap, lead.speed);
    // Mid-change, respect the lane being entered too.
    if (car.laneT < 1 || car.pendingLane >= 0) {
      const into = car.pendingLane >= 0 ? car.pendingLane : car.lane;
      const l2 = this._leader(car, car.dir * this.lanes[into]);
      a = Math.min(a, this._idm(car, car.speed, l2.gap, l2.speed));
    }
    car.leaderIsPlayer = lead.player;
    a = clamp(a, -TRAFFIC.emergencyDecel, car.aMax);

    car.accel = damp(car.accel, a, 6, dt);
    car.speed = Math.max(0, car.speed + car.accel * dt);
    if (car.speed === 0 && car.accel < 0) car.accel = 0;
    car.s += car.speed * car.dir * dt;
  }

  /** Desired speed: the driver's own, capped by the corners in sight. */
  _cornerLimit(car) {
    let limit = Infinity;
    for (const d of [25, 60, 110]) {
      const f = this.path.frameAt(car.s + car.dir * d, this._fB);
      const k = Math.abs(f.curv);
      if (k < 1e-5) continue;
      const vc = Math.sqrt(TRAFFIC.cornerAccel / k);
      // Arrive at the corner's speed braking comfortably from here.
      limit = Math.min(limit, Math.sqrt(vc * vc + 2 * car.bComf * Math.max(0, d - 15)));
    }
    return limit;
  }

  /** Intelligent Driver Model acceleration for `speed` with a leader `gap` metres ahead at `lead` m/s. */
  _idm(car, speed, gap, lead) {
    const v0 = Math.max(1, Math.min(car.v0 * (car.yielding > 0 ? TRAFFIC.yieldSlow : 1), this._cornerLimitCached(car)));
    const free = 1 - Math.pow(speed / v0, 4);
    if (!Number.isFinite(gap)) return car.aMax * free;
    const dv = speed - lead;
    const sStar = car.jam + Math.max(0, speed * car.headway + (speed * dv) / (2 * Math.sqrt(car.aMax * car.bComf)));
    return car.aMax * (free - Math.pow(sStar / Math.max(gap, 0.2), 2));
  }

  /** The corner limit costs three spline lookups; a quarter-second old answer is fine. */
  _cornerLimitCached(car) {
    if (car._climT === undefined || this._clock - car._climT > 0.25) {
      car._clim = this._cornerLimit(car);
      car._climT = this._clock;
    }
    return car._clim;
  }

  /** Is something at lateral offset `ov` (half-width `hw`) in a path at `laneV`? */
  _inPath(ov, hw, laneV, myHalfWid) {
    return Math.abs(ov - laneV) < hw + myHalfWid + 0.35;
  }

  /**
   * The nearest thing ahead in the path at lateral offset `laneV`: another car
   * (either direction — a spun car is an obstacle) or the player.
   * Returns bumper-to-bumper gap and its speed along this car's direction.
   */
  _leader(car, laneV) {
    let gap = Infinity, speed = 0, player = false;
    for (const o of this.cars) {
      if (o === car) continue;
      const d = (o.s - car.s) * car.dir;
      if (d <= 0 || d > 220) continue;
      if (!this._inPath(o.v, o.halfWid, laneV, car.halfWid)) continue;
      const g = d - car.halfLen - o.halfLen;
      if (g < gap) { gap = g; speed = o.speed * o.dir * car.dir; }
    }
    const P = this._player;
    if (P) {
      const d = (P.s - car.s) * car.dir;
      if (d > 0 && d < 220 && this._inPath(P.v, P.halfWid, laneV, car.halfWid)) {
        const g = d - car.halfLen - P.halfLen;
        if (g < gap) { gap = g; speed = P.along * car.dir; player = true; }
      }
    }
    return { gap, speed, player };
  }

  /** The nearest same-direction car behind in a lane, for the safety test; the player counts. */
  _follower(car, laneV) {
    let gap = Infinity, speed = 0, who = null;
    for (const o of this.cars) {
      if (o === car || o.dir !== car.dir || o.spun) continue;
      const d = (car.s - o.s) * car.dir;
      if (d <= 0 || d > 160) continue;
      if (!this._inPath(o.v, o.halfWid, laneV, car.halfWid)) continue;
      const g = d - car.halfLen - o.halfLen;
      if (g < gap) { gap = g; speed = o.speed; who = o; }
    }
    const P = this._player;
    if (P) {
      const d = (car.s - P.s) * car.dir;
      if (d > 0 && d < 220 && this._inPath(P.v, P.halfWid, laneV, car.halfWid)) {
        const g = d - car.halfLen - P.halfLen;
        if (g < gap) { gap = g; speed = P.along * car.dir; who = 'player'; }
      }
    }
    return { gap, speed, who };
  }

  /**
   * MOBIL's safety criterion: entering `lane` must not make whoever is behind
   * there brake harder than `safeDecel`, and must leave room ahead. The player
   * is held to a time gap, because nobody knows how hard a player will brake.
   */
  _laneSafe(car, lane) {
    const laneV = car.dir * this.lanes[lane];
    const ahead = this._leader(car, laneV);
    if (ahead.gap < car.jam + car.speed * 0.5) return false;
    const behind = this._follower(car, laneV);
    if (!Number.isFinite(behind.gap)) return true;
    if (behind.gap < 4) return false;
    if (behind.who === 'player') {
      const closing = behind.speed - car.speed;
      return closing <= 0 || behind.gap / closing > 3.5;
    }
    const a = this._idm(behind.who, behind.speed, behind.gap, car.speed);
    return a > -TRAFFIC.safeDecel;
  }

  _beginChange(car, lane, { signal = TRAFFIC.signalTime, duration = TRAFFIC.laneChangeTime } = {}) {
    if (lane >= this.lanes.length || lane === car.lane || car.pendingLane >= 0 || car.laneT < 1) return false;
    car.pendingLane = lane;
    car.signal = Math.sign(this.lanes[lane] - this.lanes[car.lane]);
    car.signalT = signal;
    // Faster cars change lanes more briskly; a fixed time looks lazy at 110 and frantic at 50.
    car.laneDur = duration * clamp(25 / Math.max(10, car.speed), 0.7, 1.25);
    return true;
  }

  /** Overtake when the passing lane pays; otherwise keep right. */
  _considerLanes(car) {
    if (this.lanes.length < 2) return;
    const other = 1 - car.lane;
    const here = this._leader(car, car.v);
    const there = this._leader(car, car.dir * this.lanes[other]);
    const aHere = this._idm(car, car.speed, here.gap, here.speed);
    const aThere = this._idm(car, car.speed, there.gap, there.speed);

    if (car.lane === 1) {
      const blocked = Number.isFinite(here.gap) && here.speed < car.v0 - 2 && here.gap < 90;
      if (blocked && aThere - aHere > TRAFFIC.overtakeGain * (1 + car.polite) && this._laneSafe(car, 0)) {
        this._beginChange(car, 0);
      }
    } else if (car.yielding <= 0 && aThere >= aHere - 0.2 && this._laneSafe(car, 1)) {
      this._beginChange(car, 1);
    }
  }

  /** Being flashed from behind, or met head-on in the wrong lane. */
  _reactToPlayer(car, dt) {
    const P = this._player;
    if (!P) return;
    const d = (P.s - car.s) * car.dir;          // + ahead of this car
    const inMyLane = this._inPath(P.v, P.halfWid, car.v, car.halfWid);

    if (car.dir > 0 && d < 0 && -d < TRAFFIC.noticeRange && P.flashing && inMyLane) {
      // Flashed from behind: let them by.
      car.yielding = 2;
      if (car.lane === 0 && this.lanes.length > 1 && this._laneSafe(car, 1)) this._beginChange(car, 1, { signal: 0.5 });
    } else {
      car.yielding = Math.max(0, car.yielding - dt);
    }

    // Head-on: the player is ahead, in this lane, and closing.
    const closing = car.speed - P.along * car.dir;
    if (d > 0 && inMyLane && closing > 3) {
      const ttc = (d - car.halfLen - P.halfLen) / closing;
      if (ttc < TRAFFIC.alarmTime && P.along * car.dir < 0) {
        if (car.flashT <= 0) car.flashT = 1.4;
        // Swerve away from the player if the other lane is the clearer one.
        const other = 1 - car.lane;
        if (other >= this.lanes.length) return;
        const away = Math.abs(P.v - car.dir * this.lanes[other]) > Math.abs(P.v - car.v);
        if (away && car.laneT >= 1 && car.pendingLane < 0 && this._leader(car, car.dir * this.lanes[other]).gap > 8) {
          this._beginChange(car, other, { signal: 0, duration: 1.6 });
        }
      }
    }
  }

  /** Past `TRAFFIC.lodDistance` along the road a car is its one-mesh proxy (models.js). */
  _lod(car) {
    const d = Math.abs(car.s - this._player.s);
    const far = d > TRAFFIC.lodDistance + (car.far ? -10 : 0);
    if (far === car.far) return;
    car.far = far;
    for (const o of car.inst.detail) o.visible = !far;
    car.inst.proxy.visible = far;
  }

  /* ------------------------------------------------------------- lamps -- */

  _lamps(car) {
    const model = car.inst.model;
    const braking = car.spun > 0 ? 0 : car.accel < -0.6 ? 1 : car.speed < 0.5 ? 0.7 : 0;
    car.brake += (braking - car.brake) * 0.25;
    model.setBrake(car.brake);
    const flash = car.flashT > 0 && Math.sin(car.flashT * 22) > 0;
    model.setHeadlights(this.lightsOn, flash);

    // 1.5 Hz, the regulation rate.
    const on = Math.sin(this._clock * Math.PI * 3 + car.id) > 0;
    const left = car.hazard || car.signal < 0;
    const right = car.hazard || car.signal > 0;
    // Unlit, a marker is a sliver of amber plastic nobody sees: not drawn.
    for (const m of car.inst.markers.left) m.visible = left && on && !car.far;
    for (const m of car.inst.markers.right) m.visible = right && on && !car.far;
  }

  /* ----------------------------------------------------------- population -- */

  /**
   * Keeps a band of road around the player populated. Density swells and
   * thins along the road, so there are busy stretches and empty ones.
   *
   * Cars appear beyond `spawnMin`, in the haze. Same-direction cars also come
   * up from behind when the player is slower than they are.
   */
  _maintainPopulation(player) {
    for (const car of this.cars.slice()) {
      const rel = car.s - player.s;
      if (rel > TRAFFIC.ahead + 120 || rel < -TRAFFIC.behind) this._despawn(car);
      else if (car.spun < 0) this._despawn(car);
    }

    const x = player.s / 1700 + this._phase;
    const wave = Math.sin(x) * Math.cos(x * 0.41 + 1.3);
    const want = Math.round(TRAFFIC.count * (1 + TRAFFIC.wave * wave));

    let guard = 0;
    while (this.cars.length < want && guard++ < 30) {
      const P = this._player;
      const slow = P && P.along < TRAFFIC.speedMin;
      let dir = this.rng() < TRAFFIC.oncomingShare ? -1 : 1;
      let s, fast = false;
      if (dir > 0 && slow && this.rng() < 0.35) {
        s = player.s - TRAFFIC.spawnBehind * (0.9 + this.rng() * 0.2);
        fast = true;
      } else {
        s = player.s + lerp(TRAFFIC.spawnMin, TRAFFIC.ahead, this.rng());
      }
      if (s < 40) continue;

      // Most traffic cruises in the outer lane.
      const lane = this.lanes.length > 1 && this.rng() < 0.7 ? 1 : 0;
      const clash = this.cars.some(
        (c) => c.dir === dir && c.lane === lane && Math.abs(c.s - s) < 45
      );
      if (clash) continue;
      if (!this._spawn(s, lane, dir, { fast })) break;
    }
  }

  /**
   * Last line of defence against overlap. Because nothing here is simulated,
   * separation can be asserted: push the pair apart until the gap is legal.
   */
  _separate(sorted) {
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        if (b.s - a.s > 14) break;      // sorted: nothing else is near
        if (a.spun || b.spun) continue;
        if (a.dir !== b.dir) continue;
        if (Math.abs(a.v - b.v) > a.halfWid + b.halfWid + 0.2) continue;
        const need = a.halfLen + b.halfLen + 1.2;
        const d = b.s - a.s;
        if (d >= need) continue;
        const push = (need - d) * 0.5;
        a.s -= push;
        b.s += push;
        // Whoever was behind matches the one in front, or they meet again next frame.
        const back = a.dir > 0 ? a : b, front = back === a ? b : a;
        back.speed = Math.min(back.speed, front.speed);
      }
    }
  }

  /**
   * Watches every car through its closest approach and reports it once astern.
   *
   * A running minimum over the whole encounter avoids frame-rate dependent
   * sampling.
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

  /* -------------------------------------------------------------- impacts -- */

  /**
   * Player-traffic contact, resolved in closed form.
   *
   * Overlap is two boxes in road space. The response is the impulse for two
   * masses meeting at a closing speed along the contact normal:
   *
   *     j = -(1 + e) * (v_rel . n) * m1*m2/(m1 + m2)
   *
   * The player takes it spread over `TRAFFIC.impactTime` (a crumple, not a
   * wall); the struck car takes the equal and opposite share as a change of
   * speed going into its scripted spin-out, so a car rammed from behind is
   * shoved ahead instead of braking into the player. The impulse is capped.
   */
  _resolvePlayer(dt, player) {
    const v = player.vehicle;
    const hitLen = this._player.halfLen;
    const hitWid = this._player.halfWid;
    const mP = v.V.mass;

    for (const car of this.cars) {
      if (car.spun > 0) continue;                    // already out of the way

      const ds = car.s - player.s;
      const dv = car.v - player.v;
      const overS = car.halfLen + hitLen - Math.abs(ds);
      if (overS <= 0) continue;
      const overV = car.halfWid + hitWid - Math.abs(dv);
      if (overV <= 0) continue;

      // Resolve along the shallower axis, as an AABB solver does.
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

      // Closing speed along the normal; the traffic car's velocity is scripted.
      const lv = v.body.linvel();
      this._vel.copy(frame.tan).multiplyScalar(car.speed * car.dir);
      const rel =
        (lv.x - this._vel.x) * n.x + (lv.y - this._vel.y) * n.y + (lv.z - this._vel.z) * n.z;
      if (rel > -0.4) continue;                      // separating, or a graze

      const mC = car.mass;
      const reduced = (mP * mC) / (mP + mC);
      let j = -(1 + TRAFFIC.restitution) * rel * reduced;
      j = Math.min(j, TRAFFIC.maxImpactDv * mP);

      // A little yaw, signed by the end hit, makes the shove read as a crash.
      const yaw = sideways ? 0 : (dv > 0 ? -1 : 1) * j * 0.05;
      v.shove(n.x * j, n.z * j, yaw, TRAFFIC.impactTime);

      this._spinOut(car, -rel, sideways ? Math.sign(dv) : Math.sign(-ds));
      const along = car.speed * car.dir - (j / mC) * (n.x * frame.tan.x + n.z * frame.tan.z);
      car.speed = Math.max(0, along * car.dir);
      this.lastImpact = 1;
      this.impacts++;
      // A car that was hit is not a car that was passed cleanly.
      car.wasNear = false;
      car.nearMin = undefined;
    }
  }

  /** Hands a car over to a scripted spin-out, hazards on. */
  _spinOut(car, closing, side) {
    car.spun = TRAFFIC.spinTime;
    car.spunRate = clamp(closing * 0.10, 0.5, 3.2) * (side || 1);
    car.spunDrift = clamp(closing * 0.28, 1.5, 7) * (side || 1);
    car.signal = 0;
    car.pendingLane = -1;
    car.hazard = true;
  }

  /**
   * A spin-out, animated rather than simulated. The car slews to the verge,
   * rotating and slowing, then is removed.
   */
  _advanceSpun(car, dt) {
    car.spun -= dt;
    car.s += car.speed * car.dir * dt;
    car.speed = Math.max(0, car.speed - TRAFFIC.spinDecel * dt);
    car.accel = -TRAFFIC.spinDecel;

    car.spunYaw += car.spunRate * dt;
    car.spunRate = damp(car.spunRate, 0, 1.4, dt);

    // Slide off the carriageway to clear the lane behind.
    const before = car.v;
    car.v += car.spunDrift * dt;
    car.spunDrift = damp(car.spunDrift, 0, 0.8, dt);
    car.v = clamp(car.v, -ROAD.halfWidth - 6, ROAD.halfWidth + 6);
    car.latVel = (car.v - before) / Math.max(dt, 1e-4);

    if (car.spun <= 0) car.spun = -1;                // flagged for despawn
  }

  /* ------------------------------------------------------------- placement -- */

  /**
   * Puts a car on the road surface, facing along it (plus the yaw of a lane
   * change), leaning with it; the body pitches and rolls on its springs.
   */
  _place(car, dt) {
    const f = this.path.frameAt(car.s, this._fA);
    this.chunks.groundAt(car.s, car.v, this._pos);

    // Basis from the road: local -Z is forward, local +Y is the road's up.
    this._az.copy(f.tan).multiplyScalar(-car.dir).normalize();
    this._ay.copy(f.up);
    this._ax.crossVectors(this._ay, this._az).normalize();
    this._ay.crossVectors(this._az, this._ax).normalize();
    this._m.makeBasis(this._ax, this._ay, this._az);
    this._q.setFromRotationMatrix(this._m);

    // Pointing into a lane change: atan of lateral over forward speed, toward the driver's side.
    const yaw = car.spun ? car.spunYaw : -Math.atan2(car.latVel * car.dir, Math.max(car.speed, 3));
    if (yaw) this._q.multiply(this._yawQ.setFromAxisAngle(WORLD_UP, yaw));

    const g = car.inst.group;
    g.position.copy(this._pos);
    g.quaternion.copy(this._q);

    const m = car.inst.metrics;
    const r = m.wheelRadius;

    if (dt > 0) {
      // Yaw rate from the heading change; lateral acceleration = ω·v.
      this._fwd.set(0, 0, -1).applyQuaternion(this._q);
      let omega = 0;
      if (car.heading) {
        const cross = car.heading.x * this._fwd.z - car.heading.z * this._fwd.x;
        omega = -cross / dt;
        car.heading.copy(this._fwd);
      } else {
        car.heading = this._fwd.clone();
      }
      const aLeft = car.spun ? 0 : omega * car.speed;

      // Body on its springs: a slightly under-damped second-order follower.
      const k = 70, c = 9.5;
      const pitchGoal = clamp(car.accel * 0.0065, -0.045, 0.03);
      const rollGoal = clamp(-aLeft * 0.011, -0.055, 0.055);
      car.pitchV += (k * (pitchGoal - car.pitch) - c * car.pitchV) * dt;
      car.pitch += car.pitchV * dt;
      car.rollV += (k * (rollGoal - car.roll) - c * car.rollV) * dt;
      car.roll += car.rollV * dt;
      car.inst.model.body.rotation.set(car.pitch, 0, car.roll);

      car.steer = damp(car.steer, clamp(yaw * 2.2, -0.45, 0.45), 8, dt);
    }

    // Wheels at the model's own rolling radius, turning with road speed.
    car.spin += (car.speed / r) * dt;
    const wb = m.wheelbaseHalf;
    const tr = m.trackHalf;
    const layout = [[-tr, -wb], [tr, -wb], [-tr, wb], [tr, wb]];
    const cb = car.inst.model.camber;
    for (let i = 0; i < 4; i++) {
      const w = car.inst.wheels[i];
      w.position.set(layout[i][0], r + cb.lift, layout[i][1]);
      w.rotation.set(-car.spin, i < 2 && !car.spun ? car.steer : 0, cb.tilt[i], 'YZX');
    }
  }
}
