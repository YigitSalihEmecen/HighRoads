/**
 * perf.js — a per-frame profiler, off unless the URL has `?perf`.
 *
 *   PERF.begin(); ...; PERF.lap('physics'); ...; PERF.lap('render'); PERF.end();
 *
 * Laps accumulate milliseconds per named section; `PERF.report()` returns
 * mean / p95 / max per section and the frame total, plus the worst frames.
 * When off, every call is a single boolean test.
 */
const ON = typeof location !== 'undefined' && /[?&]perf\b/.test(location.search);

class Perf {
  constructor() {
    this.on = ON;
    this.frames = [];         // [{ name: ms }]
    this._cur = null;
    this._t = 0;
  }
  begin() {
    if (!this.on) return;
    this._cur = {};
    this._t = performance.now();
  }
  lap(name) {
    if (!this.on || !this._cur) return;
    const t = performance.now();
    this._cur[name] = (this._cur[name] || 0) + (t - this._t);
    this._t = t;
  }
  /** Time a nested call without disturbing the lap clock. */
  add(name, ms) {
    if (!this.on || !this._cur) return;
    this._cur[name] = (this._cur[name] || 0) + ms;
  }
  end() {
    if (!this.on || !this._cur) return;
    let total = 0;
    for (const k in this._cur) if (!k.startsWith('.')) total += this._cur[k];
    this._cur.total = total;
    this.frames.push(this._cur);
    if (this.frames.length > 20000) this.frames.shift();
    this._cur = null;
  }
  reset() { this.frames.length = 0; }
  report() {
    const names = new Set();
    for (const f of this.frames) for (const k in f) names.add(k);
    const out = {};
    for (const n of names) {
      const v = this.frames.map(f => f[n] || 0).sort((a, b) => a - b);
      const mean = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
      out[n] = { mean: +mean.toFixed(3), p95: +v[Math.floor(v.length * 0.95)].toFixed(3),
                 max: +v[v.length - 1].toFixed(2) };
    }
    return { frames: this.frames.length, sections: out };
  }
}

export const PERF = new Perf();
