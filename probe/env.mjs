/**
 * env.mjs — measures the scenery outside the near grass tier.
 *
 * Covers the far grass tier, trees, bushes and ground detail.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { WORLD, CHUNK, GRASS, ROAD } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';

const seed = process.argv[2] || 'highroads-01';
let bad = 0;
const check = (ok, label, detail) => {
  if (!ok) bad++;
  console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${label.padEnd(42)} ${detail}`);
};

console.log(`\nseed "${seed}" — procedural environment assets\n`);

/* -------------------------------------------------------------- scatter -- */

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });
world.timestep = WORLD.fixedStep;
const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const chunks = new ChunkManager({
  scene: new THREE.Scene(), world, RAPIER, path, terrain, foliage: new Map(),
});
// The window the game would actually hold, built the way the game builds it.
chunks.preload(CHUNK.length * 2);
// Until streaming is idle: it now runs under a per-frame time budget
// (CHUNK.frameBudgetMs), so a fixed 40 frames no longer finishes it.
for (let i = 0; i < 3000; i++) {
  chunks.update(CHUNK.length * 2);
  if (i > 40 && !chunks.pending.length && !chunks.sheetQueue.length && !chunks.propQueue.length
      && !chunks.propJob && chunks.grassTiers.every((t) => !t.queue.length && !t.job)) break;
}

const tier = chunks.grassTiers.find((t) => t.key === 'grassFar');

if (!tier) {
  check(false, 'far grass tier exists', 'GRASS.far.enabled is off');
} else {
  let inst = 0, cost = 0, worstLat = 0, onRoad = 0, tallest = 0;
  const chunkCount = 4;
  for (let i = 2; i < 2 + chunkCount; i++) {
    const s0 = i * CHUNK.length;
    // The sheet is built over several frames in the game (chunks._stepSheets);
    // finish it here so the timing is the scatter alone.
    chunks._ensureSheet(i);
    const t0 = performance.now();
    const mesh = chunks._buildGrass(i, s0, s0 + CHUNK.length, chunks.chunks.get(i).origin, tier);
    cost += performance.now() - t0;
    if (!mesh) continue;
    inst += (mesh.userData.total ?? mesh.count);
    const m = mesh.instanceMatrix.array;
    const origin = chunks.chunks.get(i).origin;
    for (let k = 0; k < (mesh.userData.total ?? mesh.count); k++) {
      const o = k * 16;
      tallest = Math.max(tallest, m[o + 5]);
      const x = m[o + 12] + origin.x;
      const z = m[o + 14] + origin.z;
      const s = path.projectPoint(new THREE.Vector3(x, 0, z), s0 + CHUNK.length * 0.5);
      const lat = Math.abs(path.lateralOffset(new THREE.Vector3(x, 0, z), s));
      worstLat = Math.max(worstLat, lat);
      if (lat < ROAD.halfWidth) onRoad++;
    }
  }
  const perChunk = inst / chunkCount;
  check(inst > 0, 'far tier places anything at all', `${inst} over ${chunkCount} chunks`);
  check(perChunk < 9000, 'far tier instance budget',
    `${perChunk.toFixed(0)} per chunk, ${(perChunk * (tier.behind + tier.ahead + 1)).toFixed(0)} alive ` +
    `(${(perChunk * (tier.behind + tier.ahead + 1) * 4).toFixed(0)} triangles)`);
  check(cost / chunkCount < 12, 'far tier scatter cost',
    `${(cost / chunkCount).toFixed(1)} ms per chunk`);
  check(onRoad === 0, 'none of it on the carriageway', `${onRoad} of ${inst}`);
  check(worstLat <= GRASS.far.halfExtent + 2, 'none beyond the far band',
    `furthest ${worstLat.toFixed(1)} m of ${GRASS.far.halfExtent}`);
  check(tallest <= GRASS.height[1] * GRASS.far.heightScale * 1.05,
    'card height inside the tier scale',
    `tallest ${tallest.toFixed(2)} m at x${GRASS.far.heightScale} height, ` +
    `x${GRASS.far.widthScale} width`);
  // The tiers must overlap: the near one still full size where the far one grows.
  check(GRASS.far.fadeIn[0] < GRASS.fadeStart && GRASS.far.fadeIn[1] > GRASS.fadeStart,
    'the tiers overlap rather than abut',
    `far grows in ${GRASS.far.fadeIn[0]}..${GRASS.far.fadeIn[1]} m, near fades ` +
    `${GRASS.fadeStart}..${GRASS.fadeEnd} m`);
  check(GRASS.far.fadeOut[0] > GRASS.far.halfExtent,
    'far tier outlives its own lateral band',
    `fades at ${GRASS.far.fadeOut[0]} m, band is ${GRASS.far.halfExtent} m`);
}

/* ------------------------------------------------------------ tyre effects -- */

// Smoke and rubber, driven directly rather than through a browser — the
  // effects key on `wheel.slipAmount`, which only the tyre model decides, and a
  // threshold set above it silently never fires.
  const { TyreFX } = await import('../src/fx.js');
const { FX } = await import('../src/config.js');

const fxScene = new THREE.Scene();
const fx = new TyreFX(fxScene);

/** A car doing a standing burnout: rears well past peak slip, barely moving. */
const stub = {
  forwardSpeed: 1.2,
  fwd: new THREE.Vector3(0, 0, 1),
  V: { wheelWidth: 0.28, driveBias: [0, 0, 0.5, 0.5] },
  driveSlip: 6,
  wheels: [0, 1, 2, 3].map((i) => ({
    grounded: true,
    rear: i >= 2,
    // Measured on the real car at full throttle from rest — see FX.smoke.minSlip.
    slipAmount: i >= 2 ? 0.44 : 0.0,
    contact: new THREE.Vector3(i === 2 ? -0.8 : 0.8, 0, 0),
    normal: new THREE.Vector3(0, 1, 0),
    pointVel: new THREE.Vector3(0, 0, -6),
  })),
};

function run(seconds) {
  const steps = Math.round(seconds * 60);
  for (let f = 0; f < steps; f++) {
    for (const w of stub.wheels) w.contact.z += stub.forwardSpeed / 60;
    fx.update(1 / 60, stub);
  }
}

// Two seconds rolling forward at walking pace, so marks have somewhere to go.
run(2);

const livePuffs = [...fx._sBirth.array].filter((v, i) => i % 3 === 0 && v > fx.time - FX.smoke.life).length;
const liveMarks = [...fx.marks.mark.array].filter((v, i) => i % 2 === 0 && v > fx.time - FX.marks.life).length / 4;

check(livePuffs > 0, 'a burnout makes smoke',
  `${livePuffs} puffs alive after 2 s at slip ${stub.wheels[2].slipAmount} ` +
  `(threshold ${FX.smoke.minSlip})`);
check(livePuffs <= FX.smoke.max, 'the puff pool is a pool',
  `${livePuffs} of ${FX.smoke.max}, cursor wraps`);
check(liveMarks > 0, 'a burnout leaves rubber',
  `${liveMarks} quads over ${(stub.forwardSpeed * 2).toFixed(1)} m of travel`);
// The marks are laid between consecutive contact points, so two wheels 1.6 m
// apart must produce two separate lines and not one wide one.
check(liveMarks >= 2, 'both driven wheels mark separately', `${liveMarks} quads`);

// Nothing at all when the tyres are gripping — which is most of the time.
fx.reset();
for (const w of stub.wheels) w.slipAmount = 0.05;
run(1);
const quietPuffs = [...fx._sBirth.array].filter((v, i) => i % 3 === 0 && v > fx.time - FX.smoke.life).length;
check(quietPuffs === 0, 'a gripping tyre makes nothing', `${quietPuffs} puffs`);

// A slip of a few frames — a steering flick, a shift — must leave nothing: a
// lone quad reads as a dark square on the road (the flashing black rectangles).
fx.reset();
let blipMarks = 0;
for (let blip = 0; blip < 20; blip++) {
  for (const w of stub.wheels) w.slipAmount = w.rear ? 0.6 : 0;
  stub.forwardSpeed = 25;
  run(4 / 60);
  for (const w of stub.wheels) w.slipAmount = 0;
  run(20 / 60);
}
blipMarks = [...fx.marks.mark.array].filter((v, i) => i % 2 === 0 && v > fx.time - FX.marks.life).length / 4;
check(blipMarks === 0, 'momentary slips leave no lone marks', `${blipMarks} quads from 20 four-frame blips`);
stub.forwardSpeed = 1.2;

// A fast slide still smokes, spread thinner along the road — see FX.smoke.speedFade.
const slide = (speed) => {
  fx.reset();
  for (const w of stub.wheels) w.slipAmount = 0.6;
  stub.forwardSpeed = speed;
  for (let f = 0; f < 60; f++) {
    for (const w of stub.wheels) w.contact.z += stub.forwardSpeed / 60;
    fx.update(1 / 60, stub);
  }
  return [...fx._sBirth.array].filter((v, i) => i % 3 === 0 && v > fx.time - FX.smoke.life).length;
};
const slowPuffs = slide(1.2);
const fastPuffs = slide(50);
const fastMarks = [...fx.marks.mark.array].filter((v, i) => i % 2 === 0 && v > fx.time - FX.marks.life).length / 4;
check(fastPuffs > 0 && fastPuffs < slowPuffs * 0.6, 'a fast slide smokes, thinner', `${fastPuffs} puffs at 180 km/h against ${slowPuffs} at a crawl`);
check(fastMarks > 0, 'but rubber at speed', `${fastMarks} quads — a high-speed slide still marks`);

fx.dispose();

console.log(`\n  [${bad ? 'FAIL' : ' ok '}] procedural environment\n`);
process.exit(bad ? 1 : 0);
