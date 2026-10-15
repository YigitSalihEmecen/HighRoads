/**
 * traffic.mjs — traffic soak.
 *
 * Drives a synthetic player for minutes and watches for spawn, overlap, dead
 * stops and absurd impacts.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import { WORLD, ROAD, TRAFFIC, CHUNK } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';
import { Traffic } from '../src/traffic.js';

const seed = process.argv[2] || WORLD.seed;
const MINUTES = Number(process.argv[3] || 4);

const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const chunks = new ChunkManager({
  scene: new THREE.Scene(), world: null, RAPIER: null, path, terrain, foliage: new Map(),
});

// A stand-in for models.Fleet: three body sizes, enough cars that the pool never runs dry.
const mk = (i, len, wid) => ({
  seed: 'p' + i, mass: 1100 + 120 * (i % 7), build: { style: ['sedan', 'suv', 'hatch'][i % 3] },
  model: {
    body: new THREE.Group(),
    wheels: { FL: new THREE.Group(), FR: new THREE.Group(), BL: new THREE.Group(), BR: new THREE.Group() },
    metrics: {
      trackHalf: wid * 0.82, wheelbaseHalf: len * 0.62, wheelRadius: 0.36, wheelWidth: 0.26,
      bodyHeight: 1.45, bodyHalfWidth: wid, bodyHalfLength: len, bodyFrontZ: -len, bodyRearZ: len,
    },
    camber: { tilt: [0, 0, 0, 0], lift: 0 },
    setBrake() {}, setHeadlights() {}, setColor() {}, setTrimColor() {},
  },
});
const pool = Array.from({ length: 24 }, (_, i) => mk(i, [2.1, 2.6, 2.7][i % 3], [0.92, 1.0, 1.05][i % 3]));
const fleet = {
  free: pool.slice(), busy: new Set(),
  acquire(rng) { if (!this.free.length) return null; const e = this.free.splice(Math.floor(rng() * this.free.length), 1)[0]; this.busy.add(e); return e; },
  release(e) { if (this.busy.delete(e)) this.free.push(e); },
};

let impulses = [];
const PLAYER_MASS = 1250;
const vehicle = {
  V: { mass: PLAYER_MASS, chassis: { hx: 0.95, hy: 0.34, hz: 2.15 } },
  vel: new THREE.Vector3(),
  body: {
    linvel() { return { x: vehicle.vel.x, y: 0, z: vehicle.vel.z }; },
    applyImpulse(i) {
      const dv = Math.hypot(i.x, i.y, i.z) / PLAYER_MASS;
      impulses.push(dv);
      vehicle.vel.x += i.x / PLAYER_MASS;
      vehicle.vel.z += i.z / PLAYER_MASS;
    },
    applyTorqueImpulse() {},
  },
};

const traffic = new Traffic({ scene: new THREE.Scene(), path, chunks, fleet });

const dt = 1 / 60;
const steps = Math.round(MINUTES * 60 * 60);
let playerS = 120;
const playerSpeed = Number(process.argv[4] || 42);   // default ~150 km/h, faster than all traffic
const playerLane = Number(process.argv[5] || 0);
path.ensureLength(playerS + playerSpeed * MINUTES * 60 + 3000);

let minSpawnDist = Infinity, nearestBehind = -Infinity;
let worstOverlap = 0, overlapEvents = 0;
let stalledFrames = 0, movingSamples = 0;
const stallSince = new Map();
let longestStall = 0;
let counts = [];
let laneErrWorst = 0;
let seen = new Set();
let passes = 0, oncomingPasses = 0, closest = Infinity;
let changes = 0, unsignalled = 0;
const signalled = new Set();

for (let i = 0; i < steps; i++) {
  playerS += playerSpeed * dt;
  path.ensureLength(playerS + 2000);
  const f = path.frameAt(playerS);
  vehicle.vel.set(f.tan.x * playerSpeed, 0, f.tan.z * playerSpeed);

  traffic.update(dt, {
    s: playerS, v: traffic.lanes[playerLane], speed: playerSpeed, flashing: false, vehicle,
  });

  for (const c of traffic.cars) {
    c.age = (c.age || 0) + dt;
    if (c.signal && c.lastLane === c.lane) signalled.add(c.id + ':' + c.lane);
    if (c.lastLane !== undefined && c.lastLane !== c.lane) {
      changes++;
      if (!signalled.has(c.id + ':' + c.lastLane)) unsignalled++;
    }
    c.lastLane = c.lane;
    if (!seen.has(c.id)) {
      seen.add(c.id);
      const d = c.s - playerS;
      if (d > 0) minSpawnDist = Math.min(minSpawnDist, d); else nearestBehind = Math.max(nearestBehind, d);
    }
    if (c.spun === 0) {
      movingSamples++;
      if (c.speed < 1.0) {
        stalledFrames++;
        const t0 = stallSince.get(c.id) ?? i;
        stallSince.set(c.id, t0);
        longestStall = Math.max(longestStall, (i - t0) * dt);
      } else stallSince.delete(c.id);
      // Only settled cars: a lane change eases across a lane mid-transition.
      if (c.laneT >= 1 && c.pendingLane < 0 && c.age > 3) {
        laneErrWorst = Math.max(laneErrWorst, Math.abs(c.v - c.dir * traffic.lanes[c.lane]));
      }
    }
  }
  for (const p of traffic.passes) {
    passes++;
    if (p.oncoming) oncomingPasses++;
    closest = Math.min(closest, p.gap);
  }

  for (let a = 0; a < traffic.cars.length; a++) {
    for (let b = a + 1; b < traffic.cars.length; b++) {
      const A = traffic.cars[a], B = traffic.cars[b];
      if (A.dir !== B.dir || A.spun || B.spun) continue;
      if (Math.abs(A.v - B.v) > A.halfWid + B.halfWid) continue;
      const pen = (A.halfLen + B.halfLen) - Math.abs(A.s - B.s);
      if (pen > 0) { overlapEvents++; worstOverlap = Math.max(worstOverlap, pen); }
    }
  }
  if (i % 60 === 0) counts.push(traffic.cars.length);
}

const ok = (b) => (b ? ' ok ' : 'FAIL');
console.log(`seed "${seed}" — ${MINUTES} min at ${(playerSpeed * 3.6).toFixed(0)} km/h, ${seen.size} cars spawned\n`);
console.log(`  [${ok(minSpawnDist >= TRAFFIC.spawnMin - 1)}] nearest spawn ahead               ${minSpawnDist.toFixed(0)} m  (floor ${TRAFFIC.spawnMin} m)`);
console.log(`  [${ok(nearestBehind <= -TRAFFIC.spawnBehind * 0.85)}] nearest spawn behind              ${nearestBehind === -Infinity ? 'none' : nearestBehind.toFixed(0) + ' m'}`);
console.log(`  [${ok(longestStall < 2.5)}] longest a healthy car sat still   ${longestStall.toFixed(2)} s`);
console.log(`  [${ok(stalledFrames / movingSamples < 0.02)}] share of car-frames below 1 m/s   ${(100 * stalledFrames / movingSamples).toFixed(2)} %`);
console.log(`  [${ok(overlapEvents === 0)}] overlapping cars                ${overlapEvents} (worst ${worstOverlap.toFixed(2)} m)`);
console.log(`  [${ok(laneErrWorst < 0.35)}] worst settled lane error          ${laneErrWorst.toFixed(3)} m`);
console.log(`  [${ok(Math.min(...counts) >= Math.floor(TRAFFIC.count * (1 - TRAFFIC.wave)) - 2)}] population range                  ${Math.min(...counts)}..${Math.max(...counts)} (target ${TRAFFIC.count} ±${Math.round(TRAFFIC.wave * 100)}%)`);
console.log(`  [${ok(changes > 0 && unsignalled <= changes * 0.25)}] lane changes, unsignalled         ${changes}, ${unsignalled} (evasive swerves only)`);
console.log(`  [${ok(fleet.busy.size === traffic.cars.length)}] fleet bookkeeping                 ${fleet.busy.size} out, ${traffic.cars.length} on road`);
console.log(`  [${ok(passes > 0)}] near misses detected              ${passes} (${oncomingPasses} oncoming), closest ${closest === Infinity ? 'n/a' : closest.toFixed(2) + ' m'}`);
if (impulses.length) {
  console.log(`  [${ok(Math.max(...impulses) <= TRAFFIC.maxImpactDv + 1e-6)}] impacts ${impulses.length}, player dv max ${Math.max(...impulses).toFixed(2)} m/s, mean ${(impulses.reduce((a, b) => a + b, 0) / impulses.length).toFixed(2)} m/s`);
} else {
  console.log('  [ -- ] no impacts (player stayed in its lane)');
}
