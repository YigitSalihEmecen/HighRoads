/**
 * score.js — near-miss scoring for Traffic mode.
 *
 * The mechanic is the familiar one and the shape matters more than the numbers:
 * threading past another car pays, closer pays more, and consecutive passes
 * build a multiplier that bleeds away unless it is refreshed. What makes it a
 * game rather than a readout is that the multiplier is a *decision* — the chain
 * is worth more than any single pass, so the player keeps hunting for one more
 * gap instead of backing off, which is exactly the behaviour that gets them hit.
 *
 * Two details that are not decoration:
 *
 *   ONCOMING TRAFFIC PAYS MORE. It arrives at the sum of both speeds, so the
 *   same lateral gap is a fraction of the time to judge and react to. Paying
 *   the same for it would make the safe half of the road the optimal one.
 *
 *   THERE IS A COOLDOWN. Without one, driving between two cars abreast scores
 *   twice in the same instant, and a queue in both lanes is a jackpot for a
 *   single decision. One decision, one payment.
 *
 * This module owns no DOM and no game state beyond the run: it takes passes and
 * a speed, and reports numbers.
 */

import { SCORE } from './config.js';
import { clamp, lerp } from './util.js';

export class ScoreRun {
  constructor() {
    this.reset();
    this.best = ScoreRun.loadBest();
  }

  reset() {
    this.score = 0;
    this.multiplier = 1;
    this.chain = 0;          // seconds of chain left
    this.passes = 0;
    this.bestGap = Infinity;
    this._cooldown = 0;
    /** Set for one frame when a pass scores, for the HUD to animate. */
    this.lastAward = 0;
    this.lastOncoming = false;
  }

  /** Fraction of the chain timer remaining, 0..1 — drives the HUD bar. */
  get chainFraction() {
    return clamp(this.chain / SCORE.chainTime, 0, 1);
  }

  /**
   * @param {number} dt
   * @param {Array<{gap:number, oncoming:boolean}>} passes  completed this frame
   * @param {number} speed  m/s
   */
  update(dt, passes, speed) {
    this.lastAward = 0;
    this._cooldown = Math.max(0, this._cooldown - dt);

    if (this.chain > 0) {
      this.chain -= dt;
      if (this.chain <= 0) {
        this.chain = 0;
        this.multiplier = 1;
      }
    }

    if (speed < SCORE.minSpeed) return;

    for (const p of passes) {
      if (p.gap > SCORE.nearRange) continue;
      if (this._cooldown > 0) continue;

      // Closer is worth more, linearly across the scoring band.
      const t = clamp(p.gap / SCORE.nearRange, 0, 1);
      let points = lerp(SCORE.best, SCORE.worst, t);
      if (p.oncoming) points *= SCORE.oncomingBonus;

      const award = Math.round(points * this.multiplier);
      this.score += award;
      this.passes++;
      this.bestGap = Math.min(this.bestGap, p.gap);
      this.lastAward = award;
      this.lastOncoming = p.oncoming;

      // The chain is refilled, not extended: a late pass is worth as much as an
      // early one, so there is never a reason to hold back and wait.
      this.chain = SCORE.chainTime;
      this.multiplier = Math.min(SCORE.chainMax, this.multiplier + SCORE.chainStep);
      this._cooldown = SCORE.cooldown;
    }
  }

  /** Called when the run ends. Returns true if this was a personal best. */
  finish() {
    const record = this.score > this.best;
    if (record) {
      this.best = this.score;
      ScoreRun.saveBest(this.best);
    }
    return record;
  }

  // localStorage is best-effort: a private window or blocked site data must not
  // take the game down with it.
  static loadBest() {
    try {
      return Number(localStorage.getItem('fastroads.best')) || 0;
    } catch {
      return 0;
    }
  }

  static saveBest(value) {
    try {
      localStorage.setItem('fastroads.best', String(Math.round(value)));
    } catch {
      /* nothing worth doing */
    }
  }
}
