/**
 * Roof integrity. Inside the sealed middle of a bore the mountain must be
 * unbroken: every terrain vertex over the arch has to survive the mouth test,
 * or there is open sky above the carriageway. At the portals the opposite is
 * required — the quads must go, or the bore ends against a wall of rock.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import { ROAD, WORLD, CHUNK } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';

const seed = process.argv[2] || WORLD.seed;
const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const chunks = new ChunkManager({
  scene: new THREE.Scene(), world: null, RAPIER: null, path, terrain, foliage: new Map(),
});
path.ensureLength(4600);

function boreHeightAt(v) {
  const hw = ROAD.tunnelHalfWidth, av = Math.abs(v);
  if (av > hw) return -1;
  const wallH = ROAD.tunnelCrown * 0.45;
  const t = av / hw;
  return wallH + Math.sqrt(Math.max(0, 1 - t * t)) * (ROAD.tunnelCrown - wallH);
}

const UP = new THREE.Vector3(0, 1, 0);
const right = new THREE.Vector3(), p = new THREE.Vector3();
const frame = { };
let sealedMouths = 0, sealedProbes = 0, portalKept = 0, portalProbes = 0;
let worstEdge = 0;            // how far the surviving edge sits above the cut line
const shellTop = ROAD.tunnelRoof + ROAD.tunnelShellExtra;

for (let s = 60; s < 4000; s += 1) {
  const f = path.frameAt(s);
  if (f.tunnel <= 0) continue;
  right.crossVectors(f.tan, UP).normalize();
  // Must be the SAME boundary the mouth rule uses, or the probe reports the
  // sliver between the two thresholds as a fault that is not there.
  const TUNNEL_EPS = 1e-4;
  const sealed = f.tunnel >= 1 - TUNNEL_EPS;
  for (const v of chunks.lateral) {
    const arch = boreHeightAt(v);
    if (arch < 0) continue;
    chunks.sampleGround(f, right, v, p);
    const cut = f.pos.y + arch + ROAD.tunnelRoof;
    const isMouth = f.tunnel > TUNNEL_EPS && f.tunnel < 1 - TUNNEL_EPS && Math.abs(v) <= ROAD.tunnelHalfWidth;
    if (sealed) {
      sealedProbes++;
      // Sealed middle: nothing cut, and nothing hanging below the arch either.
      if (isMouth || p.y < cut - 1e-6) sealedMouths++;
    } else {
      portalProbes++;
      if (!isMouth) portalKept++;
      // How high above the cut line the nearest surviving surface sits — the
      // shell has to reach at least this far or the roof line shows sky.
      if (!isMouth) worstEdge = Math.max(worstEdge, p.y - cut);
    }
  }
}
console.log(`seed "${seed}"`);
console.log(`  sealed middle : ${sealedMouths} / ${sealedProbes} vertices cut away   (must be 0 — each is open sky over the road)`);
console.log(`  portal ramps  : ${portalKept} / ${portalProbes} vertices kept        (rock standing in the mouth)`);
console.log(`  surviving edge reaches ${worstEdge.toFixed(2)} m above the cut line; shell covers ${shellTop.toFixed(2)} m`);
console.log(worstEdge > shellTop ? '  -> SHELL TOO SHORT: a strip of sky along the roof line' : '  -> shell clears the ragged edge');
