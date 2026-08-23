globalThis.document = { createElement: () => ({ style: {}, getContext: () => null }) };
import { WORLD, ROAD } from '../src/config.js';
import { createTerrain } from '../src/noise.js';
import { RoadPath } from '../src/path.js';

const seed = process.argv[2] || WORLD.seed;
const terrain = createTerrain(seed);
const path = new RoadPath(terrain, seed);
path.ensureLength(3000);
console.log(`tunnelCover = ${ROAD.tunnelCover} m — "deep" means cover >= that\n`);
console.log('    s   cover   deep  tunnel');
let bad = 0;
for (let s = 1150; s <= 1290; s += 2.5) {
  const f = path.frameAt(s);
  const deep = f.cover >= ROAD.tunnelCover;
  const flag = deep && f.tunnel <= 0 ? '   <-- DEEP ROCK BUT NO BORE' : '';
  if (flag) bad++;
  console.log(`${s.toFixed(0).padStart(5)}  ${f.cover.toFixed(1).padStart(6)}   ${deep ? 'yes' : ' no'}   ${f.tunnel.toFixed(2)}${flag}`);
}
console.log(`\n${bad} stations where the rock is deep enough for a bore but none was marked.`);
