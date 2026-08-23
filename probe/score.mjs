/**
 * The near-miss mechanic, exercised directly.
 *
 * Pure logic — no physics, no DOM — so the shape of the reward curve can be
 * checked rather than eyeballed: does closer pay more, does oncoming pay more,
 * does the chain build and then decay, and does the cooldown stop two cars
 * abreast paying twice for one decision?
 */
globalThis.localStorage = undefined;   // exercise the try/catch path too
import { SCORE } from '../src/config.js';
import { ScoreRun } from '../src/score.js';

const dt = 1 / 60;
const pass = (gap, oncoming = false) => [{ gap, oncoming }];
const ok = (b) => (b ? ' ok ' : 'FAIL');

// --- closer pays more -------------------------------------------------------
const points = [];
for (const gap of [0.1, 1.0, 2.0, 2.5, 3.5]) {
  const r = new ScoreRun();
  r.update(dt, pass(gap), 40);
  points.push(r.score);
}
const monotonic = points[0] > points[1] && points[1] > points[2] && points[2] > points[3];
console.log(`  [${ok(monotonic)}] closer pays more            ${points.slice(0, 4).join(' > ')}`);
console.log(`  [${ok(points[4] === 0)}] outside range pays nothing  gap 3.5 m -> ${points[4]}`);

// --- oncoming pays more -----------------------------------------------------
const same = new ScoreRun(); same.update(dt, pass(0.5), 40);
const onc = new ScoreRun(); onc.update(dt, pass(0.5, true), 40);
const ratio = onc.score / same.score;
console.log(`  [${ok(Math.abs(ratio - SCORE.oncomingBonus) < 0.02)}] oncoming pays more          ${same.score} vs ${onc.score}  (x${ratio.toFixed(2)})`);

// --- the chain builds, holds, then decays ----------------------------------
{
  const r = new ScoreRun();
  const mults = [];
  for (let i = 0; i < 4; i++) {
    r.update(dt, pass(0.4), 40);
    mults.push(r.multiplier);
    for (let k = 0; k < Math.round(1.0 / dt); k++) r.update(dt, [], 40);   // 1 s gap
  }
  const builds = mults.join(',') === '2,3,4,5';
  console.log(`  [${ok(builds)}] chain builds per pass       x${mults.join(' x')}`);

  // Let it run dry.
  let elapsed = 0;
  while (r.multiplier > 1 && elapsed < 20) { r.update(dt, [], 40); elapsed += dt; }
  const decayed = Math.abs(elapsed - (SCORE.chainTime - 1.0)) < 0.2;
  console.log(`  [${ok(decayed)}] chain decays to x1          after ${elapsed.toFixed(2)} s idle (expect ${(SCORE.chainTime - 1).toFixed(2)})`);
}

// --- refill keeps it alive ---------------------------------------------------
{
  const r = new ScoreRun();
  r.update(dt, pass(0.4), 40);
  for (let i = 0; i < 40; i++) {
    for (let k = 0; k < Math.round((SCORE.chainTime - 0.5) / dt); k++) r.update(dt, [], 40);
    r.update(dt, pass(0.4), 40);
  }
  console.log(`  [${ok(r.multiplier === SCORE.chainMax)}] refill before it expires    x${r.multiplier} after 41 passes (cap ${SCORE.chainMax})`);
}

// --- cooldown: two cars abreast is one decision ------------------------------
{
  const a = new ScoreRun();
  a.update(dt, [{ gap: 0.4, oncoming: false }, { gap: 0.4, oncoming: false }], 40);
  console.log(`  [${ok(a.passes === 1)}] cooldown blocks a double    ${a.passes} pass scored from 2 simultaneous`);
}

// --- too slow to count -------------------------------------------------------
{
  const r = new ScoreRun();
  r.update(dt, pass(0.3), SCORE.minSpeed - 1);
  console.log(`  [${ok(r.score === 0)}] crawling past scores nothing ${r.score}`);
}
