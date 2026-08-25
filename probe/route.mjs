/**
 * Does the road go anywhere on purpose?
 *
 * "Interesting" is not a measurable quantity, but the things that make an
 * alignment feel intentional are. A road laid down by a noise-driven heading
 * integrator sits in a symmetric hole or on a symmetric bank, because it went
 * wherever the noise said and the cut-and-fill clamp cleaned up after it. A
 * road that was ROUTED sits on the ground: along a hillside with a rise on one
 * side and a drop on the other, down a valley floor, along the lip of a
 * shelf — and it spends far less of its length moving earth.
 *
 * So this classifies the corridor cross-section at every station:
 *
 *   SHELF        ground rises one side, falls the other — a sidehill road
 *   CUTTING      ground above the road on both sides
 *   EMBANKMENT   ground below the road on both sides
 *   LEVEL        neither, within a metre or two
 *
 * and reports the earthwork the alignment implies. Shelf is the interesting
 * one: it is the cross-section of a road that is following the land instead of
 * being imposed on it, and the number to watch.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import * as THREE from 'three';
import * as CONFIG from '../src/config.js';
const { WORLD, ROAD, CHUNK } = CONFIG;
// Read at the router's own detail level where there is one, so the old and new
// generators are compared against the same surface rather than two of them.
const LOD = CONFIG.ROUTE ? CONFIG.ROUTE.lod : 90;
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';

const SEEDS = process.argv[2] ? [process.argv[2]] : ['highroads-01', 'bravo', 'charlie', 'delta'];
const S_MAX = Number(process.argv[3] || 6000);
const STEP = 12;
/** Half-width the cross-section is read at, metres. Beyond the cut/fill ramps. */
const D = 45;
/** Ground within this of road level counts as level, metres. */
const FLAT = 2.5;

const UP = new THREE.Vector3(0, 1, 0);
const right = new THREE.Vector3();

function survey(seed) {
  const terrain = createTerrain(seed);
  const path = new RoadPath(terrain, seed);
  path.ensureLength(S_MAX + 400);
  const ground = (x, z) => terrain.height(x, z, LOD);

  const kind = { shelf: 0, cutting: 0, embankment: 0, level: 0 };
  let earth = 0, n = 0, drop = 0, worstDrop = 0;
  const start = path.frameAt(60).pos.clone();
  let last = null;
  const track = [];
  const grades = [], turns = [];
  let prevHeading = null;

  for (let s = 60; s < S_MAX; s += STEP) {
    const f = path.frameAt(s);
    right.crossVectors(f.tan, UP).normalize();
    const gl = ground(f.pos.x - right.x * D, f.pos.z - right.z * D) - f.pos.y;
    const gr = ground(f.pos.x + right.x * D, f.pos.z + right.z * D) - f.pos.y;

    const upL = gl > FLAT, upR = gr > FLAT;
    const dnL = gl < -FLAT, dnR = gr < -FLAT;
    if ((upL && dnR) || (upR && dnL)) kind.shelf++;
    else if (upL && upR) kind.cutting++;
    else if (dnL && dnR) kind.embankment++;
    else kind.level++;

    // Earthwork proxy: mean |natural − road| across the corridor.
    for (let b = -3; b <= 3; b++) {
      const v = (b / 3) * D;
      earth += Math.abs(ground(f.pos.x + right.x * v, f.pos.z + right.z * v) - f.pos.y);
      n++;
    }
    // Biggest fall beside the carriageway — the "cliff edge" measure.
    const fall = Math.max(-gl, -gr);
    if (fall > 12) drop++;
    worstDrop = Math.max(worstDrop, fall);

    grades.push(Math.abs(Math.asin(Math.max(-1, Math.min(1, f.tan.y)))));
    const h = Math.atan2(f.tan.x, -f.tan.z);
    if (prevHeading !== null) {
      let d = h - prevHeading;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      turns.push(Math.abs(d) / STEP);
    }
    prevHeading = h;
    last = f.pos.clone();
    track.push(last);
  }

  /**
   * Does the road come back alongside itself?
   *
   * THE structural invariant, and the one the cost router made necessary. Every
   * chunk carries terrain 700 m either side while being 120 m long, so two
   * stretches of road passing near each other have sheets that disagree about
   * whose ground it is — one carriageway ends up under the other's hillside.
   *
   * Only pairs that can be LOADED AT ONCE matter. The manager keeps
   * `behind + ahead + 1` chunks alive, so anything further apart than that in
   * arc length can never be in the world simultaneously and is free to be as
   * close as it likes.
   */
  const live = (CHUNK.behind + CHUNK.ahead + 1) * CHUNK.length;
  let minClear = Infinity, clearAt = 0;
  for (let i = 0; i < track.length; i++) {
    for (let j = i + 1; j < track.length; j++) {
      const sep = (j - i) * STEP;
      if (sep < 200) continue;          // this is just the road you are on
      if (sep > live) break;            // cannot both be loaded
      const d = track[i].distanceTo(track[j]);
      if (d < minClear) { minClear = d; clearAt = i * STEP + 60; }
    }
  }

  // Net displacement over arc length. Informational only: an infinite road has
  // nowhere to be, and a meandering one is not a fault.
  const efficiency = last ? last.distanceTo(start) / (S_MAX - 60) : 0;

  const total = kind.shelf + kind.cutting + kind.embankment + kind.level;
  const pct = (v) => ((100 * v) / total).toFixed(0).padStart(3) + '%';
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const p95 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] || 0;

  console.log(
    `  ${seed.padEnd(13)} shelf ${pct(kind.shelf)}  cutting ${pct(kind.cutting)}  ` +
    `embankment ${pct(kind.embankment)}  level ${pct(kind.level)}   ` +
    `earthwork ${(earth / n).toFixed(1).padStart(5)} m   ` +
    `grade p95 ${((p95(grades) * 100) / Math.PI * 180 / 100).toFixed(1).padStart(4)}%   ` +
    `curv p95 ${(p95(turns) * 1000).toFixed(2).padStart(5)} mrad/m   ` +
    `big drops ${pct(drop)} (worst ${worstDrop.toFixed(0)} m)   ` +
    `self-clear ${minClear === Infinity ? '  n/a' : minClear.toFixed(0).padStart(4) + ' m'}` +
    `${minClear < 160 ? ' OVERLAP' : ''}   drift ${efficiency.toFixed(2)}`
  );
  return { shelf: kind.shelf / total, earth: earth / n, clear: minClear };
}

console.log(`\ncorridor cross-section over ${S_MAX} m, read at +-${D} m\n`);
const out = SEEDS.map(survey);
const shelf = out.reduce((a, o) => a + o.shelf, 0) / out.length;
const earth = out.reduce((a, o) => a + o.earth, 0) / out.length;
const worstClear = Math.min(...out.map((o) => o.clear));
console.log(`\n  mean over ${out.length} seed(s): shelf ${(shelf * 100).toFixed(0)}%, ` +
  `earthwork ${earth.toFixed(1)} m, worst self-clearance ${worstClear.toFixed(0)} m`);
process.exit(worstClear < 160 ? 1 : 0);
