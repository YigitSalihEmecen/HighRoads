/**
 * stream.mjs — what world streaming costs the main thread, frame by frame.
 *
 *   node probe/stream.mjs [seed] [seconds] [speed m/s]
 *
 * Drives the focus along the road at a steady speed, 60 frames a second, and
 * calls ChunkManager.update exactly as the game does — no renderer, no
 * physics — timing every frame. A hitch is a frame over budget: the report is
 * the distribution (p50/p95/p99/max), how many frames went over 8 and 16 ms,
 * and which stage the worst frames spent their time in.
 */
globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
globalThis.location = { search: '?perf' };
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { WORLD } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';
import { ChunkManager } from '../src/chunks.js';
import { PERF } from '../src/perf.js';

PERF.on = true;   // imports are hoisted above the location stub
const seed = process.argv[2] || WORLD.seed;
const secs = Number(process.argv[3] || 40);
const speed = Number(process.argv[4] || 40);

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });
const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
const chunks = new ChunkManager({ scene: new THREE.Scene(), world, RAPIER, path, terrain });
const S0 = 400;
path.ensureLength(S0 + secs * speed + 3000);
chunks.preload(S0);
const f0 = path.frameAt(S0);
chunks.tiles.preload(f0.pos.x, f0.pos.z);
// settle the start before timing
for (let i = 0; i < 300; i++) { chunks.focus = f0.pos; chunks.update(S0); }

const dt = 1 / 60;
const frames = [];
const focus = new THREE.Vector3();
let s = S0;
for (let n = 0; n < secs * 60; n++) {
  s += speed * dt;
  const f = path.frameAt(s);
  focus.copy(f.pos);
  chunks.focus = focus;
  chunks.advanceTime(dt);
  PERF.begin();
  chunks.update(s);
  PERF.lap('streaming');
  frames.push(PERF._cur);
  PERF.end();
}
const tot = frames.map(f => f.streaming).sort((a, b) => a - b);
const q = (t) => tot[Math.min(tot.length - 1, Math.floor(tot.length * t))].toFixed(2);
const over = (ms) => tot.filter(x => x > ms).length;
console.log(`\nseed "${seed}", ${secs} s at ${speed} m/s (${(speed * 3.6).toFixed(0)} km/h), ${frames.length} frames`);
console.log(`  streaming per frame  p50 ${q(0.5)}  p95 ${q(0.95)}  p99 ${q(0.99)}  max ${tot[tot.length - 1].toFixed(1)} ms`);
console.log(`  frames over  4 ms: ${over(4)}   8 ms: ${over(8)}   16 ms: ${over(16)}   33 ms: ${over(33)}`);
const stages = ['.tiles', '.chunkBuild', '..route', '..road', '..roadCollider', '.sheets', '.props', '.canopy', '.grass', '.rocks'];
const sum = Object.fromEntries(stages.map(k => [k, 0]));
for (const f of frames) for (const k of stages) sum[k] += f[k] || 0;
console.log('  total ms by stage: ' + stages.map(k => `${k.replace(/^\.+/, '')} ${sum[k].toFixed(0)}`).join(', '));
const worst = [...frames].sort((a, b) => b.streaming - a.streaming).slice(0, 6);
console.log('  worst frames:');
for (const f of worst) console.log('   ' + f.streaming.toFixed(1).padStart(6) + ' ms  ' + stages.filter(k => f[k] > 0.5).map(k => `${k.replace(/^\.+/, '')} ${f[k].toFixed(1)}`).join(', '));
// The hitch bar: at 144 km/h no streaming frame may exceed a 60 fps frame.
const ok = over(16) === 0;
console.log(`\n  [${ok ? ' ok ' : 'FAIL'}] no streaming frame over 16 ms at ${(speed * 3.6).toFixed(0)} km/h`);
process.exit(ok ? 0 : 1);
