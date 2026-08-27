/**
 * util.js — small math helpers and deterministic PRNGs.
 *
 * Dependency-free and allocation-free, so the physics substep loop can call
 * them without making garbage.
 */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a, b, t) => a + (b - a) * t;

export const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** Classic Hermite smoothstep, remapping `edge0..edge1` onto a soft 0..1. */
export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach. `rate` is "per second". */
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

// Exponential smoothing toward a MOVING goal. `damp()` to the goal's
// end-of-frame position settles at lag L = v·dt·e^(−k·dt)/(1 − e^(−k·dt)) —
// frame-rate dependent, so a chase camera sways with frame time. Integrating
// the goal's ramp over the frame (x1 = g1 − v/k + (x0 − g0 + v/k)·e^(−k·dt))
// leaves steady-state lag exactly v/k, with dt gone. One exponent, same cost.
export function dampTrack(current, goalPrev, goal, rate, dt) {
  if (!(dt > 0) || !(rate > 0)) return current;
  const e = Math.exp(-rate * dt);
  const lag = (goal - goalPrev) / dt / rate;
  return goal - lag + (current - goalPrev + lag) * e;
}

export function moveTowards(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + sign(d) * maxDelta;
}

// Alea — small, fast, seedable; seeds the noise permutation tables, which is
// what makes a world reproducible from its seed string.
export function alea(seed) {
  let n = 0xefc8249d;
  const mash = (data) => {
    data = String(data);
    for (let i = 0; i < data.length; i++) {
      n += data.charCodeAt(i);
      let h = 0.02519603282416938 * n;
      n = h >>> 0;
      h -= n;
      h *= n;
      n = h >>> 0;
      h -= n;
      n += h * 0x100000000;
    }
    return (n >>> 0) * 2.3283064365386963e-10;
  };

  let s0 = mash(' ');
  let s1 = mash(' ');
  let s2 = mash(' ');
  let c = 1;

  s0 -= mash(seed); if (s0 < 0) s0 += 1;
  s1 -= mash(seed); if (s1 < 0) s1 += 1;
  s2 -= mash(seed); if (s2 < 0) s2 += 1;

  return function random() {
    const t = 2091639 * s0 + c * 2.3283064365386963e-10;
    s0 = s1;
    s1 = s2;
    return (s2 = t - (c = t | 0));
  };
}

/** mulberry32 — used for per-chunk prop scattering (cheap to seed per chunk). */
export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap integer hash — turns a chunk index into a well-spread 32-bit seed. */
export function hashInt(i) {
  let h = i | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

// Polynomial smooth minimum (Quilez): blends over a window `k`. A hard
// min/max leaves a derivative crease — a curvature spike a car at speed hits
// as if it struck a wall.
export function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return lerp(b, a, h) - k * h * (1 - h);
}

/** Smooth maximum, by symmetry. */
export function smax(a, b, k) {
  return -smin(-a, -b, k);
}

/** Hashes a seed string to a 32-bit integer, for seeding a PRNG from a name. */
export function hashString(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
