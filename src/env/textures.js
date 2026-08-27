/**
 * env/textures.js — shared procedural texture plumbing.
 *
 * Every map is drawn into a 2D canvas at boot. This file holds the shared
 * parts: a soft-failing canvas, a seeded PRNG, and tileable value noise.
 */

/** A 2D canvas and context, or null: headless probes then treat "no texture" as a detail, not an error. */
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
  // Smoothstep, not linear: linear value noise shows the lattice as a diamond grid.
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = latticeHash(ix, iy, period, salt);
  const b = latticeHash(ix + 1, iy, period, salt);
  const c = latticeHash(ix, iy + 1, period, salt);
  const d = latticeHash(ix + 1, iy + 1, period, salt);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}

/** Tileable fBm in [0, 1]; each octave doubles its period so it still tiles. */
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

/** Tileable ridged fBm — folded about 0.5 so crests sharpen into lines. */
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

/** Paints the whole map from a per-pixel `shade(u, v)` returning RGB[A] in [0, 1]. One putImageData, not per-pixel fillRects. */
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