/**
 * score.js — near-miss scoring for Traffic mode.
 *
 * Closer passes pay more, oncoming passes pay more still, consecutive passes
 * build a multiplier that decays unless refreshed.
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
   * @param {Array<{gap:number, oncoming:boolean}>} passes  completed this frame
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

      // The chain is REFILLED, not extended: a late pass is worth as much as an
      // early one, so there is no reason to hold back and wait.
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
      return Number(localStorage.getItem('highroads.best')) || 0;
    } catch {
      return 0;
    }
  }

  static saveBest(value) {
    try {
      localStorage.setItem('highroads.best', String(Math.round(value)));
    } catch {
      /* nothing worth doing */
    }
  }
}
