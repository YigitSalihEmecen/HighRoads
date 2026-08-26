/**
 * env/bushes.js — the understorey.
 *
 * The thing this is for is the SEAM. A wood built out of trees alone meets the
 * open ground in a line: trunks, and then grass, with nothing between them. Real
 * woodland does not have an edge, it has a fringe tens of metres deep — bramble
 * and hazel in the half-light where there is more sun than the forest floor gets
 * and more shelter than the field — and the fringe is most of what stops a tree
 * line reading as a wall of stickers.
 *
 * So the placement rule matters more than the model, and it lives in
 * `foliage.js:vegetation` as the EDGE signal: `4c(1 - c)` on the canopy density,
 * which peaks exactly where the canopy is half closed. Bramble and hazel hang
 * off it; gorse and heather score the opposite way and fill the open ground the
 * trees have given up on, so scrub thickens as woodland thins instead of the
 * world going from forest to lawn.
 *
 * ── what one is ─────────────────────────────────────────────────────────────
 *
 * A ROUNDED LEAFY DOME — a miniature tree crown, which is exactly what the
 * reference art's shrubs are. They sit low and wide at the foot of the trees
 * and among the rocks, mid-green, lit on top, with gentle facets.
 *
 * The first version of this got that wrong in a way worth recording, because
 * the parameters that produce it look reasonable: every lump was `detail: 0`
 * (twenty faces to a whole sphere) with `warp` at 0.26-0.34, and `spiky` was
 * five thin vertical lumps in a ring. Twenty faces plus a third of a radius of
 * warp is not a rounded thing at all — it is a crystal — and five thin vertical
 * ones is a jack. Photographed next to the trees they read as broken rock.
 *
 * So: the BIGGEST lump of every shrub is `detail: 1`, and the warp is halved.
 * That is the whole difference between a leafy dome and a chunk of granite, and
 * it costs about thirty triangles.
 *
 * Four forms, and the differences are chosen to read from a moving car:
 *
 *   low      a wide flat cushion, ankle height        ~46 tris
 *   round    a dome, waist high                       ~66 tris
 *   spiky    a taller dome with a pointed crest       ~72 tris
 *   upright  short stems carrying three heads         ~92 tris
 *
 * ── budget ──────────────────────────────────────────────────────────────────
 *
 * Mean ~70 triangles, against 12 for the cards this replaces and 45 for the
 * crystals. `BUSHES.cap` came down with it so the per-chunk cost is roughly
 * unchanged; see `config.js`.
 *
 * The material, the wind and the distance fade are all `env/trees.js`'s: same
 * function, same program cache key, one shader for every plant in the world.
 */

import { BUSHES as BUSH_CFG, TREES } from '../config.js';
import { SHRUBS } from '../foliage.js';
import { rng } from './textures.js';
import { Facets, blob, makeWarp, tube, triangleCount } from './lowpoly.js';
import { foliageMaterial } from './trees.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * A shrub's face colour — the canopy's rule exactly. See
 * `env/trees.js:crownShader`; the only difference is a flatter gradient,
 * because a shrub is not tall enough to have a top and a bottom.
 *
 * The hue is BAKED, not per-instance, and that is a change from the cards this
 * replaces. Luminance-in-the-texture was the right rule when a shrub was a grey
 * painted card; it is the wrong one for per-face coloured geometry, because the
 * per-instance blend toward the ground colour desaturated every species to the
 * same pale olive. `chunks.js` now applies the same near-1.0 modulation it
 * applies to trees.
 */
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

/**
 * Builds one shrub, normalised to unit height standing on y = 0 — so placement
 * scales by a height in metres and knows nothing about the form.
 */
export function growBush(form, seed, pal) {
  const rnd = rng(seed);
  const F = new Facets();
  const colour = shrubShader(pal, TREES.faceJitter);
  const sway = (y) => clamp01(y * y * 0.8 + 0.12);

  /**
   * Lump plans, so every one can cull every other. See `lowpoly.js:blob`.
   *
   * `detail` is per lump and it is the thing that decides whether this reads as
   * foliage or as rock. The main mass gets 1 (eighty faces to a sphere); the
   * smaller lumps riding on it get 0, because at a third of the radius nobody
   * counts the facets. `warp` stays low for the same reason — a heavily warped
   * twenty-face sphere is a crystal, not a leafy dome.
   */
  const plans = [];
  const lump = (x, y, z, rx, ry, rz, detail = 0, warp = 0.14) => {
    plans.push({ c: [x, y, z], r: [rx, ry, rz], detail, warp: makeWarp(rnd, warp) });
  };

  const yaw0 = rnd() * Math.PI * 2;

  if (form === 'low') {
    // Heather: a cushion. Wide, flat, and sunk, so it reads as something
    // covering the ground rather than as balls resting on it.
    lump(0, 0.36 + rnd() * 0.06, 0,
      0.46 + rnd() * 0.09, 0.34 + rnd() * 0.07, 0.46 + rnd() * 0.09, 1, 0.18);
    for (let q = 0; q < 3; q++) {
      const a = yaw0 + (q / 3) * Math.PI * 2 + (rnd() - 0.5) * 0.8;
      const d = 0.26 + rnd() * 0.14;
      lump(Math.cos(a) * d, 0.26 + rnd() * 0.12, Math.sin(a) * d,
        0.24 + rnd() * 0.08, 0.22 + rnd() * 0.06, 0.24 + rnd() * 0.08);
    }
  } else if (form === 'spiky') {
    // Gorse: the same dome, taller than it is wide, with a crest on top. The
    // five thin vertical lumps this replaces read as a jack, not as a plant.
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
    // Multi-stem, which is what a hazel is: three shoots from one stool rather
    // than a trunk, each carrying its own head. The tallest head takes the
    // subdivision; the other two ride on it.
    for (let i = 0; i < 3; i++) {
      const a = yaw0 + (i / 3) * Math.PI * 2 + (rnd() - 0.5) * 0.6;
      const lean = 0.22 + rnd() * 0.18;
      // SHORT stems and BIG heads. At 0.46-0.64 with 0.28 heads it came out as
      // three lollipops on sticks — a shrub is mostly foliage with a bit of
      // wood showing under it, not a small tree.
      const h = 0.28 + rnd() * 0.14;
      const tipX = Math.cos(a) * lean * h, tipZ = Math.sin(a) * lean * h;
      tube(F, [
        { x: 0, y: 0, z: 0, r: 0.050 },
        { x: tipX * 0.5, y: h * 0.55, z: tipZ * 0.5, r: 0.038 },
        { x: tipX, y: h, z: tipZ, r: 0.026 },
      ], 4, () => WOOD, sway);
      lump(tipX * 1.6, h + 0.26 + rnd() * 0.10, tipZ * 1.6,
        0.36 + rnd() * 0.10, 0.32 + rnd() * 0.09, 0.36 + rnd() * 0.10,
        i === 0 ? 1 : 0, 0.16);
    }
  } else {
    // `round`: bramble. A dome, waist high, with two shoulders on it.
    lump(0, 0.42 + rnd() * 0.08, 0,
      0.40 + rnd() * 0.08, 0.36 + rnd() * 0.07, 0.40 + rnd() * 0.08, 1, 0.16);
    for (let q = 0; q < 2; q++) {
      const a = yaw0 + q * Math.PI + (rnd() - 0.5) * 1.0;
      const d = 0.26 + rnd() * 0.12;
      lump(Math.cos(a) * d, 0.30 + rnd() * 0.16, Math.sin(a) * d,
        0.24 + rnd() * 0.08, 0.22 + rnd() * 0.07, 0.24 + rnd() * 0.08);
    }
  }

  for (const p of plans) {
    blob(F, {
      c: p.c, r: p.r, detail: p.detail, warpFn: p.warp, rnd,
      sway: (x, y) => sway(y),
      hide: plans.filter((q) => q !== p),
      colour: (nx, ny, nz, j) => colour(ny, j),
    });
  }

  const geo = F.build();
  // Clamp before measuring, exactly as the canopy does: a lump reaching under
  // the root would otherwise lift the whole shrub off the ground by that much.
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

/**
 * The whole shrub library: every kind, every variant, one material.
 *
 * Keyed by SPECIES rather than by form, because `chunks.js` picks species and
 * two species can share a form. It is built twice anyway, and deliberately: the
 * variants are seeded per species, so two species sharing a form still get
 * different individuals rather than the same three shrubs alternating across a
 * hillside.
 */
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

  // Shrubs are small, so they are gone long before a tree would be — the fade
  // window is much shorter than the canopy's and there is no second tier at
  // all. A cheap stand-in for a forty-triangle object is not a saving.
  const tier = foliageMaterial(BUSH_CFG.fade, null, {
    // Lighter than the canopy: a shrub is stiff and close to the ground, and
    // one swaying like a treetop reads as a bag caught in a fence.
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
