/**
 * Traffic soak. Drives a synthetic player down the road for several minutes of
 * simulated time and watches for the things that were actually wrong: cars
 * appearing in plain sight, cars stopping dead, cars occupying the same metre
 * of road, and impacts that hand the player an absurd velocity.
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

// Stand-in models: the real ones come from FBX, but traffic only ever reads
// `metrics` and clones the meshes.
const mk = (id, mass, len, wid) => [id, {
  body: new THREE.Group(),
  wheels: { FL: new THREE.Group(), FR: new THREE.Group(), BL: new THREE.Group(), BR: new THREE.Group() },
  metrics: {
    trackHalf: wid * 0.82, wheelbaseHalf: len * 0.62, wheelRadius: 0.36, wheelWidth: 0.26,
    bodyHeight: 1.45, bodyHalfWidth: wid, bodyHalfLength: len,
  },
}];
const models = new Map([
  mk('sport', 1180, 2.1, 0.92), mk('van', 1820, 2.6, 1.0), mk('pickup', 1950, 2.7, 1.05),
]);
const roster = [
  { id: 'sport', mass: 1180 }, { id: 'van', mass: 1820 }, { id: 'pickup', mass: 1950 },
];

// A player body that records what traffic does to it.
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

const traffic = new Traffic({ scene: new THREE.Scene(), path, chunks, models, roster });

const dt = 1 / 60;
const steps = Math.round(MINUTES * 60 * 60);
let playerS = 120;
const playerSpeed = 42;                 // ~150 km/h, faster than all traffic
path.ensureLength(playerS + playerSpeed * MINUTES * 60 + 3000);

let minSpawnDist = Infinity;
let worstOverlap = 0, overlapEvents = 0;
let stalledFrames = 0, movingSamples = 0;
const stallSince = new Map();
let longestStall = 0;
let counts = [];
let laneErrWorst = 0;
let seen = new Set();
let passes = 0, oncomingPasses = 0, closest = Infinity;

for (let i = 0; i < steps; i++) {
  playerS += playerSpeed * dt;
  path.ensureLength(playerS + 2000);
  const f = path.frameAt(playerS);
  vehicle.vel.set(f.tan.x * playerSpeed, 0, f.tan.z * playerSpeed);

  traffic.update(dt, {
    s: playerS, v: ROAD.laneWidth * 0.5, speed: playerSpeed, flashing: false, vehicle,
  });

  for (const c of traffic.cars) {
    if (!seen.has(c.id)) { seen.add(c.id); minSpawnDist = Math.min(minSpawnDist, c.s - playerS); }
    if (c.spun === 0) {
      movingSamples++;
      if (c.speed < 1.0) {
        stalledFrames++;
        const t0 = stallSince.get(c.id) ?? i;
        stallSince.set(c.id, t0);
        longestStall = Math.max(longestStall, (i - t0) * dt);
      } else stallSince.delete(c.id);
      // Only settled cars: a lane change deliberately eases across a full
      // lane width, so sampling mid-transition measures the feature, not an error.
      if (c.changeCooldown <= 0) {
        laneErrWorst = Math.max(laneErrWorst, Math.abs(c.v - c.dir * traffic.lanes[c.lane]));
      }
    }
  }
  for (const p of traffic.passes) {
    passes++;
    if (p.oncoming) oncomingPasses++;
    closest = Math.min(closest, p.gap);
  }

  // Same-lane overlap.
  for (let a = 0; a < traffic.cars.length; a++) {
    for (let b = a + 1; b < traffic.cars.length; b++) {
      const A = traffic.cars[a], B = traffic.cars[b];
      if (A.dir !== B.dir || A.lane !== B.lane || A.spun || B.spun) continue;
      const pen = (A.halfLen + B.halfLen) - Math.abs(A.s - B.s);
      if (pen > 0) { overlapEvents++; worstOverlap = Math.max(worstOverlap, pen); }
    }
  }
  if (i % 60 === 0) counts.push(traffic.cars.length);
}

const ok = (b) => (b ? ' ok ' : 'FAIL');
console.log(`seed "${seed}" — ${MINUTES} min at ${(playerSpeed * 3.6).toFixed(0)} km/h, ${seen.size} cars spawned\n`);
console.log(`  [${ok(minSpawnDist >= TRAFFIC.spawnMin - 1)}] nearest spawn to the player      ${minSpawnDist.toFixed(0)} m  (floor ${TRAFFIC.spawnMin} m)`);
console.log(`  [${ok(longestStall < 2.5)}] longest a healthy car sat still   ${longestStall.toFixed(2)} s`);
console.log(`  [${ok(stalledFrames / movingSamples < 0.02)}] share of car-frames below 1 m/s   ${(100 * stalledFrames / movingSamples).toFixed(2)} %`);
console.log(`  [${ok(overlapEvents === 0)}] same-lane overlaps                ${overlapEvents} (worst ${worstOverlap.toFixed(2)} m)`);
console.log(`  [${ok(laneErrWorst < 0.35)}] worst settled lane error          ${laneErrWorst.toFixed(3)} m`);
console.log(`  [${ok(Math.min(...counts) >= TRAFFIC.count - 2)}] population range                  ${Math.min(...counts)}..${Math.max(...counts)} (target ${TRAFFIC.count})`);
console.log(`  [${ok(passes > 0)}] near misses detected              ${passes} (${oncomingPasses} oncoming), closest ${closest === Infinity ? 'n/a' : closest.toFixed(2) + ' m'}`);
if (impulses.length) {
  console.log(`  [${ok(Math.max(...impulses) <= TRAFFIC.maxImpactDv + 1e-6)}] impacts ${impulses.length}, player dv max ${Math.max(...impulses).toFixed(2)} m/s, mean ${(impulses.reduce((a, b) => a + b, 0) / impulses.length).toFixed(2)} m/s`);
} else {
  console.log('  [ -- ] no impacts (player stayed in its lane)');
}
