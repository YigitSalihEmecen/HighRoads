/**
 * What does the car actually meet along the carriageway?
 *
 * At every station, from a point one car-height above the road plane, cast
 * straight down. The first surface found is what the wheels land on. Anything
 * appreciably above road level is a step the car hits; nothing at all is a hole
 * it falls through.
 *
 * Was `tunnel.mjs`. The tunnels are gone, but the question never belonged to
 * them: this is the guarantee that the carriageway is drivable end to end, and
 * it is the thing that catches a terrain change quietly burying the road.
 *
 * It probes THE WINDOW THE GAME KEEPS ALIVE, not the whole route at once, and
 * that distinction turned out to matter. Building every chunk simultaneously —
 * which is what this did — puts thirty-five terrain sheets in the world where
 * the manager only ever holds nine. Each sheet reaches 700 m either side of its
 * own 120 m of road, so a chunk two kilometres away can lie across the
 * carriageway here; it reported 33,110 steps against a road the height function
 * and the drawn mesh both agreed was perfectly flat. Every one of them was a
 * collision between two chunks that can never coexist.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { WORLD, ROAD, CHUNK } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';

const seed = process.argv[2] || WORLD.seed;
const S_MAX = Number(process.argv[3] || 4000);
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });
world.timestep = WORLD.fixedStep;
const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const chunks = new ChunkManager({
  scene: new THREE.Scene(), world, RAPIER, path, terrain, foliage: new Map(),
});

path.ensureLength(S_MAX + 600);

const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
const UP = new THREE.Vector3(0, 1, 0);
const START = 2.6;   // one car-height above the road plane
const REACH = 12;    // how far down to look before calling it a hole

/** Streams the world to where the car would be, exactly as the game does. */
function loadAround(s) {
  chunks.update(s, 99);
  world.step();
}

function scan(sLo, sHi, label) {
  let steps = 0, holes = 0, n = 0, worstStep = 0, worstAt = 0, firstHole = null;
  const right = new THREE.Vector3();
  // Offset off the mesh lattice. A ray aimed exactly down a shared triangle
  // edge — every chunk seam is one, every 2.5 m row is one — can miss both
  // faces on floating-point grounds alone, which reads as a hole that is not
  // there. Verified: 141 such misses on the lattice, 0 a few centimetres off it.
  let loadedFor = -1e9;
  for (let s = sLo + 0.137; s <= sHi; s += 0.5) {
    // Re-stream every half-chunk, so every probe is taken against the set of
    // sheets that would actually be in the world at that moment.
    if (s - loadedFor > CHUNK.length * 0.5) { loadAround(s); loadedFor = s; }
    const f = path.frameAt(s);
    right.crossVectors(f.tan, UP).normalize();
    for (let v = -ROAD.halfWidth + 0.573; v <= ROAD.halfWidth - 0.5; v += 0.5) {
      const roadY = f.pos.y + v * Math.tan(f.bank);
      ray.origin = {
        x: f.pos.x + right.x * v, y: roadY + START, z: f.pos.z + right.z * v,
      };
      const hit = world.castRay(ray, START + REACH, true);
      n++;
      if (!hit) { holes++; if (firstHole === null) firstHole = { s, v }; continue; }
      const h = START - (hit.timeOfImpact ?? hit.toi);
      if (h > 0.30) {
        steps++;
        if (h > worstStep) { worstStep = h; worstAt = s; }
      }
    }
  }
  const tag = steps || holes ? 'FAIL' : ' ok ';
  console.log(
    `  [${tag}] ${label.padEnd(28)} probes ${String(n).padStart(6)}  ` +
    `steps>30cm ${String(steps).padStart(5)} (worst ${worstStep.toFixed(2)} m @ s=${worstAt.toFixed(0)})  ` +
    `holes ${String(holes).padStart(5)}${firstHole ? ` (first @ s=${firstHole.s.toFixed(0)} v=${firstHole.v.toFixed(1)})` : ''}`
  );
  return { steps, holes };
}

console.log(`seed "${seed}" — carriageway over ${S_MAX} m\n`);
const t = scan(60, S_MAX, 'whole route');
process.exit(t.steps + t.holes ? 1 : 0);
