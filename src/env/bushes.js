/**
 * env/bushes.js — the understorey.
 *
 * Bushes hide the seam between a wood and open ground. Placement reads the
 * canopy-edge signal from foliage.js:vegetation. Shapes come from lowpoly.js.
 */

import { BUSHES as BUSH_CFG, TREES } from '../config.js';
import { SHRUBS } from '../foliage.js';
import { rng } from './textures.js';
import { Facets, blob, makeWarp, tube, triangleCount } from './lowpoly.js';
import { foliageMaterial } from './trees.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function shrubShader(pal, jitter) {
  const [main, alt] = pal;
  return (ny, j) => {
    const up = ny * 0.5 + 0.5;
    const mix = clamp01(up * 0.85 - 0.08);
    const shade = 0.92 + up * 0.16 + (j - 0.5) * jitter;
    return [
      clamp01((main[0] + (alt[0] - main[0]) * mix) * shade),
      clamp01((main[1] + (alt[1] - main[1]) * mix) * shade),
      clamp01((main[2] + (alt[2] - main[2]) * mix) * shade),
    ];
  };
}

/** Stem wood: darker, and it does not vary. */
const WOOD = [0.31, 0.26, 0.20];

export function growBush(form, seed, pal) {
  const rnd = rng(seed);
  const F = new Facets();
  const colour = shrubShader(pal, TREES.faceJitter);
  const sway = (y) => clamp01(y * y * 0.8 + 0.12);

  const plans = [];
  const lump = (x, y, z, rx, ry, rz, detail = 0, warp = 0.14) => {
    plans.push({ c: [x, y, z], r: [rx, ry, rz], detail, warp: makeWarp(rnd, warp) });
  };

  const yaw0 = rnd() * Math.PI * 2;

  if (form === 'low') {
    lump(0, 0.36 + rnd() * 0.06, 0,
      0.46 + rnd() * 0.09, 0.34 + rnd() * 0.07, 0.46 + rnd() * 0.09, 1, 0.18);
    for (let q = 0; q < 3; q++) {
      const a = yaw0 + (q / 3) * Math.PI * 2 + (rnd() - 0.5) * 0.8;
      const d = 0.26 + rnd() * 0.14;
      lump(Math.cos(a) * d, 0.26 + rnd() * 0.12, Math.sin(a) * d,
        0.24 + rnd() * 0.08, 0.22 + rnd() * 0.06, 0.24 + rnd() * 0.08);
    }
  } else if (form === 'spiky') {
    lump(0, 0.42 + rnd() * 0.06, 0,
      0.32 + rnd() * 0.06, 0.40 + rnd() * 0.08, 0.32 + rnd() * 0.06, 1, 0.20);
    lump((rnd() - 0.5) * 0.10, 0.76 + rnd() * 0.08, (rnd() - 0.5) * 0.10,
      0.16 + rnd() * 0.05, 0.22 + rnd() * 0.07, 0.16 + rnd() * 0.05, 0, 0.24);
    for (let q = 0; q < 2; q++) {
      const a = yaw0 + q * Math.PI + (rnd() - 0.5) * 0.9;
      const d = 0.22 + rnd() * 0.10;
      lump(Math.cos(a) * d, 0.30 + rnd() * 0.14, Math.sin(a) * d,
        0.18 + rnd() * 0.06, 0.22 + rnd() * 0.07, 0.18 + rnd() * 0.06);
    }
  } else if (form === 'upright') {
    // Three shoots from one stool; the tallest head takes the subdivision.
    for (let i = 0; i < 3; i++) {
      const a = yaw0 + (i / 3) * Math.PI * 2 + (rnd() - 0.5) * 0.6;
      const lean = 0.22 + rnd() * 0.18;
      const h = 0.28 + rnd() * 0.14;
      const tipX = Math.cos(a) * lean * h, tipZ = Math.sin(a) * lean * h;
      tube(F, [
        { x: 0, y: 0, z: 0, r: 0.050 },
        { x: tipX * 0.5, y: h * 0.55, z: tipZ * 0.5, r: 0.038 },
        { x: tipX, y: h, z: tipZ, r: 0.026 },
        // Closed at both ends — the foot shows on any ground that is not level,
        // and the head barely swallows the tip.
      ], 4, () => WOOD, sway, { start: true, end: true });
      lump(tipX * 1.6, h + 0.26 + rnd() * 0.10, tipZ * 1.6,
        0.36 + rnd() * 0.10, 0.32 + rnd() * 0.09, 0.36 + rnd() * 0.10,
        i === 0 ? 1 : 0, 0.16);
    }
  } else {
    lump(0, 0.42 + rnd() * 0.08, 0,
      0.40 + rnd() * 0.08, 0.36 + rnd() * 0.07, 0.40 + rnd() * 0.08, 1, 0.16);
    for (let q = 0; q < 2; q++) {
      const a = yaw0 + q * Math.PI + (rnd() - 0.5) * 1.0;
      const d = 0.26 + rnd() * 0.12;
      lump(Math.cos(a) * d, 0.30 + rnd() * 0.16, Math.sin(a) * d,
        0.24 + rnd() * 0.08, 0.22 + rnd() * 0.07, 0.24 + rnd() * 0.08);
    }
  }

  // Biggest-first one-way culling; mutual culling leaks rims (see trees.js).
  plans.sort((a, b) => b.r[0] * b.r[1] * b.r[2] - a.r[0] * a.r[1] * a.r[2]);
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    blob(F, {
      c: p.c, r: p.r, detail: p.detail, warpFn: p.warp, rnd,
      sway: (x, y) => sway(y),
      hide: plans.slice(0, i),
      colour: (nx, ny, nz, j) => colour(ny, j),
    });
  }

  const geo = F.build();
  // Clamp y before measuring — a lump under the root would otherwise lift the shrub.
  const arr = geo.getAttribute('position').array;
  for (let i = 1; i < arr.length; i += 3) if (arr[i] < 0) arr[i] = 0;
  geo.computeBoundingBox();
  const h = Math.max(0.001, geo.boundingBox.max.y);
  const spanX = geo.boundingBox.max.x - geo.boundingBox.min.x;
  const spanZ = geo.boundingBox.max.z - geo.boundingBox.min.z;
  geo.scale(1 / h, 1 / h, 1 / h);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  return { geometry: geo, height: 1, radius: Math.max(spanX, spanZ) / (2 * h) };
}

/** Keyed by species, not form — two species can share a form, and per-species seeds keep them distinct. */
export function createBushAssets() {
  const library = new Map();
  let triangles = 0;
  let n = 0;

  Object.entries(SHRUBS).forEach(([name, kind], si) => {
    const variants = [];
    for (let v = 0; v < BUSH_CFG.variants; v++) {
      const b = growBush(kind.form, (0xb115 + si * 271 + v * 104729) >>> 0,
        kind.palettes[v % kind.palettes.length]);
      triangles += triangleCount(b.geometry);
      n++;
      variants.push(b);
    }
    library.set(name, variants);
  });

  const tier = foliageMaterial(BUSH_CFG.fade, null, {
    windStrength: BUSH_CFG.windStrength,
  });

  return {
    library,
    material: tier.material,
    /** See `env/trees.js` — `probe/canopy.mjs` turns the fade off through this. */
    uniforms: tier.uniforms,
    trianglesPerBush: triangles / Math.max(1, n),
    setTime(t) { tier.uniforms.uTime.value = t; },
    dispose() {
      for (const variants of library.values()) for (const v of variants) v.geometry.dispose();
      tier.material.dispose();
    },
  };
}