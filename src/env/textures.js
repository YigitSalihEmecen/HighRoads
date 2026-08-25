/**
 * env/textures.js — shared procedural texture plumbing.
 *
 * Every map in this project is drawn into a 2D canvas at boot rather than
 * loaded, so this file holds the parts every generator would otherwise
 * reimplement: a canvas that fails softly, a seeded PRNG, and tileable value
 * noise.
 *
 * ── why the noise here is not the noise in `noise.js` ───────────────────────
 *
 * `noise.js` generates terrain: it needs analytic derivatives, quintic
 * interpolation and an infinite domain, and it costs accordingly. A texture
 * needs none of that and needs one thing that terrain never does — it has to
 * TILE. A map that does not tile is a map with a seam every time it repeats,
 * and a ground texture repeats a few hundred times across one hillside.
 *
 * So the lattice here wraps: `hash(i mod P, j mod P)`. Everything built on it
 * tiles at period P by construction, at any octave, with no blending trick.
 */

/**
 * A 2D canvas and its context, or null where there is neither.
 *
 * The headless probes stub `document.createElement` to return an object whose
 * `getContext` gives back null, so they can run the real placement code without
 * ever needing pixels. Returning null rather than throwing is what lets every
 * caller treat "no texture" as a rendering detail instead of an error.
 */
export function makeCanvas(size) {
  let canvas;
  try {
    canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
  } catch (err) {
    return null;
  }
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return null;
  return { canvas, ctx, size };
}

/** Deterministic 32-bit PRNG. Same texture every session, on every machine. */
export function rng(seed = 0x9e3779b9) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

/** Integer hash on a wrapped lattice, so anything built on it tiles at `period`. */
function latticeHash(ix, iy, period, salt) {
  const x = ((ix % period) + period) % period;
  const y = ((iy % period) + period) % period;
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable value noise in [0, 1]. `period` is in lattice cells. */
export function tileNoise(x, y, period, salt = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  // Smoothstep, not linear: value noise on a linear ramp shows the lattice as
  // a diamond grid, which at texture scale reads as woven fabric.
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = latticeHash(ix, iy, period, salt);
  const b = latticeHash(ix + 1, iy, period, salt);
  const c = latticeHash(ix, iy + 1, period, salt);
  const d = latticeHash(ix + 1, iy + 1, period, salt);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}

/**
 * Tileable fBm in [0, 1].
 *
 * `cells` is the base frequency in lattice cells across the whole texture; each
 * octave doubles it, and the period doubles with it, so every octave tiles at
 * the same texture size.
 */
export function tileFbm(u, v, cells, octaves = 4, gain = 0.5, salt = 0) {
  let a = 0, amp = 1, norm = 0, f = cells;
  for (let i = 0; i < octaves; i++) {
    a += amp * tileNoise(u * f, v * f, f, salt + i * 17);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return a / norm;
}

/**
 * Tileable ridged fBm in [0, 1] — folded about 0.5 so crests sharpen.
 *
 * This is what makes a rock face read as rock rather than as static: erosion
 * leaves creases and channels, which are ridge lines, and a plain fBm has none.
 */
export function tileRidged(u, v, cells, octaves = 4, gain = 0.5, salt = 0) {
  let a = 0, amp = 1, norm = 0, f = cells;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(tileNoise(u * f, v * f, f, salt + i * 31) * 2 - 1);
    a += amp * n * n;
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return a / norm;
}

/**
 * Writes a full-canvas image from a per-pixel function.
 *
 * `shade(u, v)` is handed texture coordinates in [0, 1) and returns
 * `[r, g, b]` or `[r, g, b, a]`, each in [0, 1]. One `putImageData` for the
 * whole map — a per-pixel `fillRect` is roughly two orders of magnitude slower
 * and this runs at boot, where the loading bar is already the long pole.
 */
export function paint(target, shade) {
  const { ctx, size } = target;
  const img = ctx.createImageData(size, size);
  const px = img.data;
  const out = [0, 0, 0, 1];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const c = shade((i + 0.5) / size, (j + 0.5) / size, out) || out;
      const k = (j * size + i) * 4;
      px[k] = Math.max(0, Math.min(255, c[0] * 255)) | 0;
      px[k + 1] = Math.max(0, Math.min(255, c[1] * 255)) | 0;
      px[k + 2] = Math.max(0, Math.min(255, c[2] * 255)) | 0;
      px[k + 3] = Math.max(0, Math.min(255, (c[3] === undefined ? 1 : c[3]) * 255)) | 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  return target.canvas;
}
