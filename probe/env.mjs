/**
 * What does the procedurally generated scenery cost, and does it land where it
 * is supposed to?
 *
 * `grass.mjs` already answers those questions for the near tier of ground
 * cover. This one covers everything else in `src/env/`: the far grass tier, the
 * stone scatter, and the geometry the rock generator builds — the three things
 * that are new enough to have no measurement at all otherwise.
 *
 * The interesting number in all of it is the TRIANGLE BUDGET. The tree scatter
 * was switched off for spending 1,030,000 triangles on 468 instances, so
 * anything added here has to be able to say what it costs next to the 109,000
 * the whole terrain sheet uses.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { WORLD, CHUNK, GRASS, ROCKS, ROAD } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';
import { createRockAssets } from '../src/env/rocks.js';

const seed = process.argv[2] || 'highroads-01';
let bad = 0;
const check = (ok, label, detail) => {
  if (!ok) bad++;
  console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${label.padEnd(42)} ${detail}`);
};

console.log(`\nseed "${seed}" — procedural environment assets\n`);

/* ---------------------------------------------------------------- rocks -- */

const rocks = createRockAssets();
let rockTris = 0;
let rockVariants = 0;
let worstFloat = 0;
let worstSpan = 0;
for (const [name, cls] of Object.entries(rocks.classes)) {
  for (const g of cls.variants) {
    const pos = g.attributes.position.array;
    rockTris += pos.length / 9;
    rockVariants++;
    let minY = Infinity, maxXZ = 0;
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i + 1] < minY) minY = pos[i + 1];
      const h = Math.hypot(pos[i], pos[i + 2]);
      if (h > maxXZ) maxXZ = h;
    }
    worstFloat = Math.max(worstFloat, Math.abs(minY));
    worstSpan = Math.max(worstSpan, Math.abs(maxXZ - 0.5));
  }
}
check(rockVariants > 0, 'rock variants built',
  `${rockVariants} across ${Object.keys(rocks.classes).length} classes`);
check(rockTris / rockVariants < 130, 'triangles per rock',
  `${(rockTris / rockVariants).toFixed(0)} mean, ${rockTris} for the whole library`);
// A rock whose lowest vertex is not on y = 0 either floats or is buried, and
// the scatter has no way to know which.
check(worstFloat < 1e-5, 'every rock stands on y = 0',
  `worst offset ${(worstFloat * 1000).toFixed(3)} mm`);
// If the horizontal half-extent is not 0.5, "a 40 cm rock" is not 40 cm.
check(worstSpan < 1e-5, 'every rock normalised to unit width',
  `worst error ${(worstSpan * 1000).toFixed(3)} mm`);
rocks.dispose();

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
for (let i = 0; i < 40; i++) chunks.update(CHUNK.length * 2);

const EDGE = ROAD.halfWidth + ROAD.shoulder;
const tier = chunks.grassTiers.find((t) => t.key === 'grassFar');

if (!tier) {
  check(false, 'far grass tier exists', 'GRASS.far.enabled is off');
} else {
  let inst = 0, cost = 0, worstLat = 0, onRoad = 0, tallest = 0;
  const chunkCount = 4;
  for (let i = 2; i < 2 + chunkCount; i++) {
    const s0 = i * CHUNK.length;
    const t0 = performance.now();
    const mesh = chunks._buildGrass(i, s0, s0 + CHUNK.length, chunks.chunks.get(i).origin, tier);
    cost += performance.now() - t0;
    if (!mesh) continue;
    inst += mesh.count;
    const m = mesh.instanceMatrix.array;
    const origin = chunks.chunks.get(i).origin;
    for (let k = 0; k < mesh.count; k++) {
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
  // The two tiers have to hand over: the near one must still be full size where
  // the far one starts growing, or there is a band with nothing in it.
  check(GRASS.far.fadeIn[0] < GRASS.fadeStart && GRASS.far.fadeIn[1] > GRASS.fadeStart,
    'the tiers overlap rather than abut',
    `far grows in ${GRASS.far.fadeIn[0]}..${GRASS.far.fadeIn[1]} m, near fades ` +
    `${GRASS.fadeStart}..${GRASS.fadeEnd} m`);
  check(GRASS.far.fadeOut[0] > GRASS.far.halfExtent,
    'far tier outlives its own lateral band',
    `fades at ${GRASS.far.fadeOut[0]} m, band is ${GRASS.far.halfExtent} m`);
}

/* ------------------------------------------------------------ the stone -- */

let rInst = 0, rTris = 0, rCost = 0, rWorstLat = 0, rOnRoad = 0, rBatches = 0;
const rChunks = 4;
for (let i = 2; i < 2 + rChunks; i++) {
  const s0 = i * CHUNK.length;
  const origin = chunks.chunks.get(i).origin;
  const t0 = performance.now();
  const meshes = chunks._buildRocks(i, s0, s0 + CHUNK.length, origin);
  rCost += performance.now() - t0;
  if (!meshes) continue;
  rBatches += meshes.length;
  for (const mesh of meshes) {
    rInst += mesh.count;
    rTris += (mesh.geometry.attributes.position.array.length / 9) * mesh.count;
    const m = mesh.instanceMatrix.array;
    for (let k = 0; k < mesh.count; k++) {
      const p = new THREE.Vector3(m[k * 16 + 12] + origin.x, 0, m[k * 16 + 14] + origin.z);
      const s = path.projectPoint(p, s0 + CHUNK.length * 0.5);
      const lat = Math.abs(path.lateralOffset(p, s));
      rWorstLat = Math.max(rWorstLat, lat);
      if (lat < EDGE - 0.5) rOnRoad++;
    }
  }
}
check(rInst > 0, 'stone places anything at all', `${rInst} over ${rChunks} chunks`);
check(rOnRoad === 0, 'no stone on the carriageway or shoulder',
  `${rOnRoad} of ${rInst} inside ${EDGE.toFixed(1)} m`);
check(rWorstLat <= ROCKS.band[1] + 2, 'stone stays inside its band',
  `furthest ${rWorstLat.toFixed(1)} m of ${ROCKS.band[1]}`);
check(rTris / rChunks < 40000, 'stone triangle budget',
  `${(rTris / rChunks).toFixed(0)} per chunk, ` +
  `${((rTris / rChunks) * (ROCKS.behind + ROCKS.ahead + 1)).toFixed(0)} alive against ~109,000 of terrain`);
check(rBatches / rChunks < 16, 'draw batches per chunk', `${(rBatches / rChunks).toFixed(1)}`);
check(rCost / rChunks < 8, 'stone scatter cost', `${(rCost / rChunks).toFixed(1)} ms per chunk`);

/* ------------------------------------------------------------ tyre effects -- */

/**
 * Smoke and rubber, driven directly rather than through a browser.
 *
 * `fx.js` has no dependency on the renderer beyond building meshes, so the whole
 * emission path can be exercised against a stub vehicle. That matters more than
 * it sounds: the effects are keyed to `wheel.slipAmount`, and what that number
 * actually REACHES is a property of the tyre model, not of anything visible. A
 * threshold set above it produces an effect that silently never happens, which
 * is exactly what the first tuning did — and a screenshot cannot tell you that,
 * because a screenshot of no smoke looks like a screenshot taken at the wrong
 * moment.
 */
const { TyreFX } = await import('../src/fx.js');
const { FX } = await import('../src/config.js');

const fxScene = new THREE.Scene();
const fx = new TyreFX(fxScene);

/** A car doing a standing burnout: rears well past their peak, barely moving. */
const stub = {
  forwardSpeed: 1.2,
  fwd: new THREE.Vector3(0, 0, 1),
  V: { wheelWidth: 0.28 },
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

// Two seconds at 60 Hz, rolling forward at walking pace so marks have somewhere
// to go.
for (let f = 0; f < 120; f++) {
  for (const w of stub.wheels) w.contact.z += stub.forwardSpeed / 60;
  fx.update(1 / 60, stub);
}

const livePuffs = [...fx._sBirth.array].filter((v, i) => i % 2 === 0 && v > fx.time - FX.smoke.life).length;
const liveMarks = [...fx.marks.mark.array].filter((v, i) => i % 2 === 0 && v > fx.time - FX.marks.life).length / 4;

check(livePuffs > 0, 'a burnout makes smoke',
  `${livePuffs} puffs alive after 2 s at slip ${stub.wheels[2].slipAmount} ` +
  `(threshold ${FX.smoke.minSlip})`);
check(livePuffs <= FX.smoke.max, 'the puff pool is a pool',
  `${livePuffs} of ${FX.smoke.max}, cursor wraps`);
check(liveMarks > 0, 'a burnout leaves rubber',
  `${liveMarks} quads over ${(stub.forwardSpeed * 2).toFixed(1)} m of travel`);
// The marks are laid between the previous contact point and this one, so two
// wheels 1.6 m apart must produce two separate lines and not one wide one.
check(liveMarks >= 2, 'both driven wheels mark separately', `${liveMarks} quads`);

// Nothing at all when the tyres are gripping — which is most of the time.
fx.reset();
for (const w of stub.wheels) w.slipAmount = 0.05;
for (let f = 0; f < 60; f++) fx.update(1 / 60, stub);
const quietPuffs = [...fx._sBirth.array].filter((v, i) => i % 2 === 0 && v > fx.time - FX.smoke.life).length;
check(quietPuffs === 0, 'a gripping tyre makes nothing', `${quietPuffs} puffs`);

// And nothing at speed: the cloud would be a hundred metres behind by the time
// it existed. See FX.smoke.speedFade.
fx.reset();
for (const w of stub.wheels) w.slipAmount = 0.6;
stub.forwardSpeed = 50;
for (let f = 0; f < 60; f++) fx.update(1 / 60, stub);
const fastPuffs = [...fx._sBirth.array].filter((v, i) => i % 2 === 0 && v > fx.time - FX.smoke.life).length;
const fastMarks = [...fx.marks.mark.array].filter((v, i) => i % 2 === 0 && v > fx.time - FX.marks.life).length / 4;
check(fastPuffs === 0, 'no smoke at speed', `${fastPuffs} puffs at 180 km/h`);
check(fastMarks > 0, 'but rubber at speed', `${fastMarks} quads — a high-speed slide still marks`);

fx.dispose();

console.log(`\n  [${bad ? 'FAIL' : ' ok '}] procedural environment\n`);
process.exit(bad ? 1 : 0);
