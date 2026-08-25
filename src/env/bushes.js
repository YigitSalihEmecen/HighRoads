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
 * Cards, mostly, for the same reason the grass is cards: a shrub is a volume of
 * small leaves, and modelling small leaves is the single most expensive way to
 * draw a thing nobody looks at directly. Four forms, and the differences are
 * chosen to read from a moving car rather than from a screenshot:
 *
 *   low      2 crossed cards, ankle height, wide         4 tris
 *   round    3 cards crossed at 60 degrees, waist high   6 tris
 *   spiky    4 narrow cards at staggered heights         8 tris
 *   upright  3 tapered stems + 3 leaf cards, head high  30 tris
 *
 * `upright` is the only one with geometry in it, and it earns that because it is
 * the only one tall enough to be seen against the sky, where a card standing
 * edge-on is a visible sliver of nothing.
 *
 * ── budget ──────────────────────────────────────────────────────────────────
 *
 * Mean 12 triangles. Two thousand bushes in view is 24,000 — a fifth of the
 * terrain sheet, and about a fiftieth of what the same coverage would cost as
 * modelled foliage.
 *
 * The material, the wind and the distance fade are all `env/trees.js`'s: same
 * function, same program cache key, one shader for every plant in the world.
 */

import * as THREE from 'three';
import { BUSHES as BUSH_CFG } from '../config.js';
import { SHRUBS } from '../foliage.js';
import { makeCanvas, rng } from './textures.js';
import { foliageMaterial } from './trees.js';

/** Atlas cells, [u0, v0] of a 2x2 grid, `v` counting up. */
const CELL = {
  round:   [0.0, 0.5],
  upright: [0.5, 0.5],
  spiky:   [0.0, 0.0],
  low:     [0.5, 0.0],
};
const CELL_SIZE = 0.5;

function inCell(cell, u, v) {
  const m = 0.02;
  return [
    cell[0] + m + u * (CELL_SIZE - 2 * m),
    cell[1] + m + v * (CELL_SIZE - 2 * m),
  ];
}

/**
 * Draws one shrub mass.
 *
 * `spread` biases placement toward the bottom of the card, because a bush is
 * wide and low and a card filled evenly reads as a hedge panel. `spike` swaps
 * the ellipses for tapered slivers, which is the whole of the difference
 * between gorse and bramble at the distance either is ever seen from.
 */
function drawMass(ctx, x0, y0, s, rnd, opts) {
  const { count, w, h, spread, spike, base } = opts;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, s, s);
  ctx.clip();

  for (let i = 0; i < count; i++) {
    // Canvas y counts down, so a low bias is a HIGH y.
    const fy = 1 - Math.pow(rnd(), spread);
    const y = y0 + s * (base + fy * (1 - base));
    // Narrower toward the top: the silhouette of a shrub is a mound.
    const halfW = 0.5 * (1 - Math.pow(1 - fy, 1.6) * 0.55);
    const x = x0 + s * (0.5 + (rnd() - 0.5) * 2 * halfW);

    // Lit from the top-left, darker toward the base of the mass.
    const lit = 0.34 + fy * 0.42 + (1 - (x - x0) / s) * 0.22 + (rnd() - 0.5) * 0.2;
    const g = Math.round(255 * Math.max(0.10, Math.min(1, lit)));
    ctx.fillStyle = `rgb(${g},${g},${g})`;

    ctx.save();
    ctx.translate(x, y);
    if (spike) {
      // A tapered sliver leaning off vertical — a spine, not a leaf.
      const lean = (rnd() - 0.5) * 0.8;
      ctx.rotate(lean);
      const len = s * h * (0.6 + rnd() * 0.9);
      const wid = s * w * (0.6 + rnd() * 0.8);
      ctx.beginPath();
      ctx.moveTo(-wid, 0);
      ctx.lineTo(wid, 0);
      ctx.lineTo(0, -len);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.rotate(rnd() * Math.PI);
      ctx.beginPath();
      ctx.ellipse(0, 0, s * w * (0.6 + rnd() * 0.8), s * h * (0.6 + rnd() * 0.8),
        0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
}

/** One atlas for every shrub in the world. Null where there is no canvas. */
function buildAtlas(size) {
  const target = makeCanvas(size);
  if (!target) return null;
  const { canvas, ctx } = target;
  ctx.clearRect(0, 0, size, size);

  const rnd = rng(0xb115e5);
  const half = size / 2;
  const px = (cell) => [cell[0] * size, (1 - cell[1] - CELL_SIZE) * size];

  let p = px(CELL.round);
  drawMass(ctx, p[0], p[1], half, rnd,
    { count: 150, w: 0.030, h: 0.022, spread: 1.5, spike: false, base: 0.08 });

  p = px(CELL.upright);
  drawMass(ctx, p[0], p[1], half, rnd,
    { count: 120, w: 0.034, h: 0.024, spread: 0.9, spike: false, base: 0.02 });

  p = px(CELL.spiky);
  drawMass(ctx, p[0], p[1], half, rnd,
    { count: 200, w: 0.008, h: 0.11, spread: 1.7, spike: true, base: 0.06 });

  p = px(CELL.low);
  drawMass(ctx, p[0], p[1], half, rnd,
    { count: 190, w: 0.020, h: 0.013, spread: 2.6, spike: false, base: 0.02 });

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/* --------------------------------------------------------------- shapes -- */

/**
 * Accumulator, deliberately the same shape as the tree builder's so the two
 * write geometries the one material can draw: position, normal, uv, colour and
 * `aSway`, with normals UP rather than out of the card face.
 */
class Mass {
  constructor() {
    this.pos = []; this.nrm = []; this.uv = []; this.col = []; this.sway = []; this.idx = [];
  }

  /**
   * One card, standing on y = 0, centred on x = z = 0.
   *
   * @param {number} yaw     rotation about Y
   * @param {number} w,h     width and height, in units of the bush's own height
   * @param {number} y0      how far off the ground the card starts
   * @param {number} tilt    lateral lean of the top edge
   */
  card(cell, yaw, w, h, y0, tilt, shade = 1) {
    const dx = Math.cos(yaw) * w * 0.5;
    const dz = Math.sin(yaw) * w * 0.5;
    const tx = Math.cos(yaw + Math.PI * 0.5) * tilt;
    const tz = Math.sin(yaw + Math.PI * 0.5) * tilt;
    const base = this.pos.length / 3;

    // Root darker than tip: the inside of a clump is shaded, and without it a
    // field of cards reads as flat cutouts standing on the ground.
    const corners = [
      [-dx, y0, -dz, 0, 0, 0.66],
      [dx, y0, dz, 1, 0, 0.66],
      [dx + tx, y0 + h, dz + tz, 1, 1, 1.0],
      [-dx + tx, y0 + h, -dz + tz, 0, 1, 1.0],
    ];
    for (const [x, y, z, u, v, ao] of corners) {
      const uv = inCell(cell, u, v);
      this.pos.push(x, y, z);
      this.nrm.push(0, 1, 0);
      this.uv.push(uv[0], uv[1]);
      const g = ao * shade;
      this.col.push(g, g, g);
      // Quadratic in height, as everywhere: the root does not move.
      this.sway.push(Math.min(1, (y / Math.max(0.05, y0 + h)) ** 2));
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** A short tapering stem. Three of these are what makes `upright` upright. */
  stem(cell, yaw, lean, height, radius, segments = 3) {
    const dirX = Math.cos(yaw) * lean;
    const dirZ = Math.sin(yaw) * lean;
    let prev = null;
    for (let s = 0; s <= 1; s++) {
      const t = s;
      const y = t * height;
      const r = radius * (1 - t * 0.7);
      const cx = dirX * y, cz = dirZ * y;
      const ring = [];
      for (let k = 0; k <= segments; k++) {
        const a = (k / segments) * Math.PI * 2;
        const nx = Math.cos(a), nz = Math.sin(a);
        const uv = inCell(cell, k / segments, t);
        this.pos.push(cx + nx * r, y, cz + nz * r);
        this.nrm.push(nx, 0.2, nz);
        this.uv.push(uv[0], uv[1]);
        const g = 0.42 + t * 0.2;
        this.col.push(g, g, g);
        this.sway.push(t * t * 0.5);
        ring.push(this.pos.length / 3 - 1);
      }
      if (prev) {
        for (let k = 0; k < segments; k++) {
          this.idx.push(prev[k], ring[k], prev[k + 1], prev[k + 1], ring[k], ring[k + 1]);
        }
      }
      prev = ring;
    }
  }

  build() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 1));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    return geo;
  }
}

/**
 * Grows one shrub, normalised to unit height standing on y = 0 — so placement
 * scales by a height in metres and knows nothing about the form.
 */
export function growBush(form, seed) {
  const rnd = rng(seed);
  const m = new Mass();
  const cell = CELL[form] || CELL.round;
  const yaw0 = rnd() * Math.PI;

  if (form === 'low') {
    // Ankle height and wide: a mat, not a bush. Cards are near-square so the
    // pair overlaps into a continuous surface from any angle.
    for (let q = 0; q < 2; q++) {
      m.card(cell, yaw0 + q * Math.PI * 0.5, 1.9 + rnd() * 0.5, 1.0,
        0, (rnd() - 0.5) * 0.25);
    }
  } else if (form === 'spiky') {
    // Four narrow cards at staggered heights and radii. The stagger is the
    // point: four cards through one axis is a star, and a star has a dead
    // angle every 45 degrees where it nearly vanishes.
    for (let q = 0; q < 4; q++) {
      const a = yaw0 + (q / 4) * Math.PI * 2 + (rnd() - 0.5) * 0.4;
      const h = 0.62 + rnd() * 0.5;
      m.card(cell, a, 0.75 + rnd() * 0.4, h,
        rnd() * 0.1, (rnd() - 0.5) * 0.4, 0.88 + rnd() * 0.24);
    }
  } else if (form === 'upright') {
    // Multi-stem, which is what a hazel is: three or four shoots from one
    // stool rather than a trunk.
    const stems = 3;
    for (let i = 0; i < stems; i++) {
      const a = yaw0 + (i / stems) * Math.PI * 2 + (rnd() - 0.5) * 0.5;
      m.stem(CELL.upright, a, 0.16 + rnd() * 0.14, 0.55 + rnd() * 0.2,
        0.028 + rnd() * 0.014, 3);
    }
    for (let q = 0; q < 3; q++) {
      const a = yaw0 + (q / 3) * Math.PI + (rnd() - 0.5) * 0.4;
      m.card(cell, a, 0.95 + rnd() * 0.4, 0.72 + rnd() * 0.2,
        0.28 + rnd() * 0.12, (rnd() - 0.5) * 0.3);
    }
  } else {
    // `round`: three cards at 60 degrees. Two leaves a visible thin axis at
    // waist height, where the player's eye actually is.
    for (let q = 0; q < 3; q++) {
      m.card(cell, yaw0 + (q / 3) * Math.PI, 1.15 + rnd() * 0.4, 0.95 + rnd() * 0.2,
        rnd() * 0.06, (rnd() - 0.5) * 0.3, 0.9 + rnd() * 0.2);
    }
  }

  const geo = m.build();
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const h = Math.max(0.001, bb.max.y - bb.min.y);
  geo.translate(0, -bb.min.y, 0);
  geo.scale(1 / h, 1 / h, 1 / h);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  return {
    geometry: geo,
    height: 1,
    radius: Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / (2 * h),
  };
}

/**
 * The whole shrub library: every kind, every variant, one material.
 *
 * Keyed by SPECIES rather than by form, because `chunks.js` picks species and
 * two species can share a form — the tint that separates gorse from heather is
 * per-instance, but the geometry they point at need not be rebuilt twice. It is
 * built twice anyway, and deliberately: the variants are seeded per species, so
 * two species sharing a form still get different individuals rather than the
 * same three shrubs alternating across a hillside.
 */
export function createBushAssets({ anisotropy = 1 } = {}) {
  const atlas = buildAtlas(BUSH_CFG.textureSize);
  if (atlas) atlas.anisotropy = anisotropy;

  const library = new Map();
  let triangles = 0;
  let n = 0;

  Object.entries(SHRUBS).forEach(([name, kind], si) => {
    const variants = [];
    for (let v = 0; v < BUSH_CFG.variants; v++) {
      const b = growBush(kind.form, (0xb115 + si * 271 + v * 104729) >>> 0);
      triangles += b.geometry.index.count / 3;
      n++;
      variants.push(b);
    }
    library.set(name, variants);
  });

  // Shrubs are small, so they are gone long before a tree would be — the fade
  // window is much shorter than the canopy's and there is no impostor tier at
  // all. A four-triangle stand-in for a four-triangle object is not a saving.
  const tier = foliageMaterial(atlas, BUSH_CFG.fade, null, {
    // Lighter than the canopy: a shrub is stiff and close to the ground, and
    // one swaying like a treetop reads as a bag caught in a fence.
    windStrength: BUSH_CFG.windStrength,
  });

  return {
    library,
    material: tier.material,
    trianglesPerBush: triangles / Math.max(1, n),
    setTime(t) { tier.uniforms.uTime.value = t; },
    dispose() {
      for (const variants of library.values()) for (const v of variants) v.geometry.dispose();
      tier.material.dispose();
      if (atlas) atlas.dispose();
    },
  };
}
