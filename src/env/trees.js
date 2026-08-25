/**
 * env/trees.js — the canopy, grown from code.
 *
 * This module owns what a tree IS. Where trees go is `chunks.js`'s job and
 * which species belong where is `foliage.js`'s, the same split every other
 * generator in this directory uses.
 *
 * ── why this exists at all ──────────────────────────────────────────────────
 *
 * Trees were switched off, and the note in `config.js` that switched them off
 * is the specification for this file. The Quaternius pack is 1,700-2,900
 * triangles per canopy as SOLID GEOMETRY, which measured 1,030,000 triangles
 * for 468 instances — 90% of everything on screen, against 109,000 for the
 * whole terrain sheet — and bought 10.3 trees per hectare where real woodland
 * carries 200 to 1,000. There was no tuning out of that. A tree that is a solid
 * mesh of leaves is the wrong object.
 *
 * ── the shape of the answer ─────────────────────────────────────────────────
 *
 * Two tiers, exactly as the ground cover has two tiers, and for the same
 * reason: what reads at 20 m and what reads at 200 m are different pictures and
 * trying to serve both with one object serves neither.
 *
 *   NEAR is grown geometry. A branch skeleton, swept into tapering tubes, with
 *   leaf mass hung on the tips as crossed cards. 160-360 triangles depending on
 *   species — five to fifteen times cheaper than the models it replaces, and it
 *   is cheaper for a structural reason rather than by being cruder: the leaves
 *   are seven hundred painted leaves on eight cards instead of seven hundred
 *   modelled ones.
 *
 *   FAR is an impostor: two crossed quads, four triangles, carrying a painted
 *   silhouette of the species. This is the thing that makes a forest affordable.
 *   Three thousand of them cost less than fifty of the models did.
 *
 * The two cross-fade BY SCALE, not by opacity, because the material is an
 * alpha-test cutout and there is no opacity to fade — the same mechanism, the
 * same reasoning and very nearly the same four lines of GLSL as `env/grass.js`.
 * A tree shrinks into the ground as its impostor grows out of it.
 *
 * ── how one is grown ────────────────────────────────────────────────────────
 *
 * A queue-based recursion, which is the standard answer and is worth restating
 * because the two obvious alternatives are both worse here:
 *
 *   An L-SYSTEM is a rewriting grammar, and its output is symmetric unless you
 *   fight it. Real trees are not symmetric, and the fight costs more parameters
 *   than the recursion does.
 *
 *   SPACE COLONISATION grows branches toward a cloud of attraction points and
 *   gives the most convincing structure of the three, but it wants thousands of
 *   points and dozens of iterations per tree, and it produces a branch count it
 *   chooses rather than one you budget. Twenty-one geometries at boot on a
 *   triangle budget is the wrong problem for it.
 *
 * So: a branch is `{origin, dir, length, radius, level}`. Sweep it as a tube;
 * spawn children along its upper half, each rotated off the parent axis and
 * spread radially; recurse until the level budget runs out; hang leaf cards on
 * whatever is left. Four parameters do nearly all the visible work —
 *
 *   GNARLINESS   how far the direction wanders per section. Scaled by 1/radius,
 *                so twigs writhe and trunks barely bend, which is the actual
 *                mechanical fact about wood and is why it reads correctly.
 *   GROWTH       phototropism as a vector: branches turn toward it a little
 *                every section. Up for most things, DOWN for a willow, which is
 *                the entire difference between a willow and a birch.
 *   TAPER        radius at the tip as a fraction of the base.
 *   SPREAD       the cone angle children leave the parent at.
 *
 * ── one texture, one material, one draw call ────────────────────────────────
 *
 * Bark and leaves are in the SAME geometry and the same atlas, because the
 * alternative is two draw calls per (chunk, species) and the draw call is the
 * binding constraint on how many species a chunk may show. The atlas is 2x2:
 * bark, broadleaf mass, needle sprig, and a sparse twiggy mass for dead trees.
 * Bark is opaque, so the alpha cutout that the leaves need costs it nothing.
 *
 * Colour is LUMINANCE in the texture and hue on the vertex, one rule further
 * than the grass needs: a tree has two materials in one mesh, so bark brown and
 * leaf green are vertex colours and the atlas is grey. `chunks.js` then tints
 * the whole instance from the ground it stands on, so a wood in a dry region
 * goes dry without anything being told twice.
 *
 * ── budget ──────────────────────────────────────────────────────────────────
 *
 *   near geometry   160-360 tris   (pine 210, broadleaf 300, dead 120)
 *   impostor          4 tris
 *   library          7 species x TREES.variants, built once at boot
 *
 * Against 109,000 triangles of terrain sheet, four hundred near trees and three
 * thousand impostors is roughly 130,000 — a bit over the sheet, and an order of
 * magnitude under what the models cost for a tenth of the trees.
 */

import * as THREE from 'three';
import { TREES } from '../config.js';
import { TREE_FORMS } from '../foliage.js';
import { makeCanvas, rng, tileFbm } from './textures.js';

/* ------------------------------------------------------------- the atlas -- */

/** Atlas cells, as [u0, v0] of a 2x2 grid. `v` counts up from the bottom. */
const CELL = {
  bark:      [0.0, 0.5],
  broadleaf: [0.5, 0.5],
  needle:    [0.0, 0.0],
  twig:      [0.5, 0.0],
};
const CELL_SIZE = 0.5;

/**
 * Maps a unit-square UV into one atlas cell, with a margin.
 *
 * The margin is not cosmetic. Mip level 4 of a 512 atlas is 32 px, at which
 * point a cell is sixteen pixels and its neighbour is one texel away; without
 * a gutter the leaves bleed into the bark and every distant trunk grows a green
 * fringe. Two texels at full size is four percent of a cell.
 */
function inCell(cell, u, v) {
  const m = 0.02;
  return [
    cell[0] + m + u * (CELL_SIZE - 2 * m),
    cell[1] + m + v * (CELL_SIZE - 2 * m),
  ];
}

/** Bark: vertical fibre and a few deep fissures. Luminance only. */
function drawBark(ctx, x0, y0, s, rnd) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, s, s);
  ctx.clip();
  ctx.fillStyle = '#8a8a8a';
  ctx.fillRect(x0, y0, s, s);

  // Fibre. Long thin strokes at slight angles read as grain at any distance
  // the trunk is actually resolved at.
  for (let i = 0; i < 220; i++) {
    const x = x0 + rnd() * s;
    const w = s * (0.004 + rnd() * 0.012);
    const h = s * (0.2 + rnd() * 0.8);
    const y = y0 + rnd() * s - h * 0.5;
    const v = 0.55 + rnd() * 0.55;
    const g = Math.round(255 * Math.min(1, v * 0.62));
    ctx.fillStyle = `rgba(${g},${g},${g},${0.35 + rnd() * 0.4})`;
    ctx.fillRect(x, y, w, h);
  }
  // Fissures: darker, wider, fewer. This is what stops it reading as denim.
  for (let i = 0; i < 14; i++) {
    const x = x0 + rnd() * s;
    ctx.strokeStyle = `rgba(40,40,40,${0.25 + rnd() * 0.35})`;
    ctx.lineWidth = s * (0.008 + rnd() * 0.02);
    ctx.beginPath();
    ctx.moveTo(x, y0);
    for (let k = 1; k <= 6; k++) {
      ctx.lineTo(x + (rnd() - 0.5) * s * 0.09, y0 + (s * k) / 6);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * A mass of broad leaves, drawn as overlapping ellipses with a light gradient.
 *
 * The gradient is the whole trick. A flat cutout of leaves lit by a directional
 * light is a flat cutout whichever way it faces; painting the top-left bright
 * and the bottom-right dark gives every card an internal light direction, and
 * because the cards are randomly yawed the canopy as a whole reads as volume
 * rather than as cardboard.
 */
function drawLeafMass(ctx, x0, y0, s, rnd, opts) {
  const { count, leafW, leafH, ragged, needle } = opts;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, s, s);
  ctx.clip();

  const cx = x0 + s * 0.5;
  const cy = y0 + s * 0.52;
  for (let i = 0; i < count; i++) {
    // Radial placement biased outward, so the silhouette is broken rather than
    // a disc with a dense middle.
    const a = rnd() * Math.PI * 2;
    const r = Math.pow(rnd(), ragged) * s * 0.46;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r * 0.86;

    // Lit from the top-left of the card.
    const d = (1 - (x - x0) / s) * 0.5 + (1 - (y - y0) / s) * 0.5;
    const v = 0.40 + d * 0.62 + (rnd() - 0.5) * 0.18;
    const g = Math.round(255 * Math.max(0.10, Math.min(1, v)));
    ctx.fillStyle = `rgb(${g},${g},${g})`;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(needle ? (rnd() - 0.5) * 0.6 + Math.PI * 0.5 : rnd() * Math.PI);
    ctx.beginPath();
    ctx.ellipse(0, 0, s * leafW * (0.7 + rnd() * 0.6), s * leafH * (0.7 + rnd() * 0.6),
      0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/**
 * The shared atlas: bark and three kinds of leaf mass.
 *
 * Null where there is no canvas — the probes run the whole placement path
 * without pixels, and everything downstream treats a missing map as
 * "untextured" rather than as a failure.
 */
function buildAtlas(size) {
  const target = makeCanvas(size);
  if (!target) return null;
  const { canvas, ctx } = target;
  ctx.clearRect(0, 0, size, size);

  const rnd = rng(0x5eed7ee5);
  const half = size / 2;
  // Canvas y counts DOWN and UV v counts UP, so a cell at v0 = 0.5 is the top
  // row of the image. Getting this backwards puts bark on the leaves.
  const px = (cell) => [cell[0] * size, (1 - cell[1] - CELL_SIZE) * size];

  let p = px(CELL.bark);
  drawBark(ctx, p[0], p[1], half, rnd);

  p = px(CELL.broadleaf);
  drawLeafMass(ctx, p[0], p[1], half, rnd,
    { count: 190, leafW: 0.030, leafH: 0.019, ragged: 0.62, needle: false });

  p = px(CELL.needle);
  drawLeafMass(ctx, p[0], p[1], half, rnd,
    { count: 260, leafW: 0.006, leafH: 0.042, ragged: 0.45, needle: true });

  // Dead wood: a sparse scatter of twigs rather than foliage, so a dead tree
  // still breaks its own silhouette instead of being a bare armature.
  p = px(CELL.twig);
  ctx.save();
  ctx.beginPath();
  ctx.rect(p[0], p[1], half, half);
  ctx.clip();
  for (let i = 0; i < 90; i++) {
    const x = p[0] + rnd() * half;
    const y = p[1] + rnd() * half;
    const g = Math.round(255 * (0.35 + rnd() * 0.35));
    ctx.strokeStyle = `rgb(${g},${g},${g})`;
    ctx.lineWidth = half * 0.006;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rnd() - 0.5) * half * 0.16, y + (rnd() - 0.5) * half * 0.16);
    ctx.stroke();
  }
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/* ---------------------------------------------------------- the skeleton -- */

const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** A unit vector perpendicular to `v`, chosen without a degenerate case. */
function perpendicular(v, out) {
  // Cross with whichever world axis `v` is least aligned to. Picking a fixed
  // axis puts a singularity in exactly the direction a trunk points.
  const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
  if (ax <= ay && ax <= az) out.set(1, 0, 0);
  else if (ay <= az) out.set(0, 1, 0);
  else out.set(0, 0, 1);
  return out.cross(v).normalize();
}

/**
 * One tree's geometry, as flat arrays.
 *
 * Everything is accumulated into plain JS arrays and typed once at the end.
 * A tree is a few hundred vertices, so the arrays cost nothing and the
 * alternative — sizing buffers up front — means predicting the branch count of
 * a recursion whose whole point is that it varies.
 */
class TreeBuilder {
  constructor(form, rnd) {
    this.form = form;
    this.rnd = rnd;
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.col = [];
    /** Wind response, 0 at the root to 1 in the canopy. See the material. */
    this.sway = [];
    this.idx = [];
    this.height = 0;
  }

  vertex(x, y, z, nx, ny, nz, u, v, r, g, b, sway) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    this.sway.push(sway);
    if (y > this.height) this.height = y;
    return this.pos.length / 3 - 1;
  }

  /**
   * Sweeps one branch as a tapering tube and returns where its tip ended up.
   *
   * The ring is closed by DUPLICATING the seam vertex rather than reusing the
   * first, because the two need different `u` — 0 and 1 — and a shared vertex
   * would run the whole bark texture backwards across one quad of every branch.
   */
  branch(origin, dir, length, radius, level, out) {
    const f = this.form;
    const rnd = this.rnd;
    const levels = f.levels;
    const sections = Math.max(2, Math.round(f.sections * (1 - level / (levels + 1)) + 1));
    const segments = Math.max(3, Math.round(f.segments - level * f.segmentDrop));

    const p = origin.clone();
    const d = dir.clone().normalize();
    const growth = f.growth;
    const taper = f.taper;

    let prevRing = null;
    const side = new THREE.Vector3();
    const up = new THREE.Vector3();
    const n = new THREE.Vector3();
    const vtx = new THREE.Vector3();

    for (let s = 0; s <= sections; s++) {
      const t = s / sections;
      const r = radius * (1 - t * (1 - taper));

      if (s > 0) {
        const step = length / sections;
        // Gnarl scales with 1/radius: a trunk is stiff and a twig is not.
        const gn = f.gnarliness * (0.05 / Math.max(0.012, r)) * step;
        _axis.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
        _q.setFromAxisAngle(_axis, gn * (rnd() - 0.5) * 2);
        d.applyQuaternion(_q).normalize();

        // Phototropism, or gravity for a willow. Proportional to the step and
        // inversely to the radius, so a heavy limb holds its line and the
        // twigs at the end of it turn.
        const pull = (growth.strength * step) / Math.max(0.02, r * 12);
        d.x += growth.dir.x * pull;
        d.y += growth.dir.y * pull;
        d.z += growth.dir.z * pull;
        d.normalize();

        p.addScaledVector(d, step);
      }

      perpendicular(d, side);
      up.crossVectors(d, side).normalize();

      const ring = [];
      for (let k = 0; k <= segments; k++) {
        const a = (k / segments) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        n.set(side.x * ca + up.x * sa, side.y * ca + up.y * sa, side.z * ca + up.z * sa);
        vtx.copy(p).addScaledVector(n, r);
        const uv = inCell(CELL.bark, k / segments, (t + level * 0.37) % 1);
        // Ambient occlusion down the trunk: a wood is dark at the bottom.
        const shade = 0.55 + 0.45 * Math.min(1, (vtx.y / Math.max(1, f.trunk.length)) * 0.9 + t * 0.25);
        ring.push(this.vertex(
          vtx.x, vtx.y, vtx.z, n.x, n.y, n.z, uv[0], uv[1],
          f.bark[0] * shade, f.bark[1] * shade, f.bark[2] * shade,
          this.swayAt(vtx.y, level)
        ));
      }

      if (prevRing) {
        for (let k = 0; k < segments; k++) {
          const a = prevRing[k], b = prevRing[k + 1], c = ring[k], e = ring[k + 1];
          this.idx.push(a, c, b, b, c, e);
        }
      }
      prevRing = ring;
    }

    out.tip.copy(p);
    out.dir.copy(d);
    out.radius = radius * taper;
    return out;
  }

  /**
   * How hard a vertex leans in the wind, 0..1.
   *
   * Quadratic in height so the trunk base is pinned, plus a floor per level so
   * the outer twigs move even low down — a branch reaching sideways at two
   * metres should still shiver, and a pure height ramp says it should not.
   */
  swayAt(y, level) {
    const h = Math.max(1, this.form.trunk.length * 1.6);
    const byHeight = Math.min(1, Math.max(0, y / h));
    const byLevel = level / (this.form.levels + 1);
    return Math.min(1, byHeight * byHeight * 0.85 + byLevel * 0.5);
  }

  /**
   * A leaf cluster: `cards` quads crossed about the branch tip.
   *
   * Two is the useful minimum — from any angle one card is near face-on and one
   * near edge-on, and the eye reads the pair as a clump rather than as a
   * picture of leaves — and three is what a big broadleaf crown wants, because
   * at that size a pair has a visible thin axis.
   *
   * Normals point UP rather than out of the card face, the same decision and
   * for the same reason as the grass: a leaf card is not a wall, and lighting
   * one by its own facing turns half of every canopy black as the camera swings
   * round it.
   */
  leaves(at, dir, size, level) {
    const f = this.form;
    const rnd = this.rnd;
    const cell = f.leafCell === 'needle' ? CELL.needle
      : f.leafCell === 'twig' ? CELL.twig : CELL.broadleaf;
    const cards = f.cards;

    // Hang the cluster slightly beyond the tip and let it sag, so leaf mass
    // sits on the ends of branches instead of skewered through them.
    const c = at.clone().addScaledVector(dir, size * 0.22);
    c.y -= size * f.leafDrop;

    const yaw0 = rnd() * Math.PI;
    const sway = Math.min(1, this.swayAt(c.y, level) + 0.25);
    for (let q = 0; q < cards; q++) {
      const a = yaw0 + (q / cards) * Math.PI;
      const dx = Math.cos(a) * size * 0.5;
      const dz = Math.sin(a) * size * 0.5;
      // Tilt every card a little differently, so a cluster is not a neat rosette.
      const tilt = (rnd() - 0.5) * 0.5;
      const hy = size * (0.85 + rnd() * 0.3);

      const base = this.pos.length / 3;
      const tint = 0.82 + rnd() * 0.36;
      const corners = [
        [-dx, -hy * 0.5, -dz, 0, 0, 0.72],
        [dx, -hy * 0.5, dz, 1, 0, 0.72],
        [dx, hy * 0.5 + tilt * size, dz, 1, 1, 1.0],
        [-dx, hy * 0.5 - tilt * size, -dz, 0, 1, 1.0],
      ];
      for (const [ox, oy, oz, u, v, ao] of corners) {
        const uv = inCell(cell, u, v);
        this.vertex(
          c.x + ox, c.y + oy, c.z + oz, 0, 1, 0, uv[0], uv[1],
          f.leaf[0] * tint * ao, f.leaf[1] * tint * ao, f.leaf[2] * tint * ao,
          sway
        );
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
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
 * Grows one tree.
 *
 * The recursion is a QUEUE rather than a call stack, which costs nothing here
 * and buys the one thing that matters: the tree is built breadth-first, so the
 * level budget can be spent evenly instead of being exhausted down the first
 * limb. It also means a cap on total branches is a `while` condition rather
 * than a parameter threaded through every call.
 *
 * @param {object} form  a `TREE_FORMS` entry
 * @param {number} seed
 * @returns {{geometry: THREE.BufferGeometry, height: number, radius: number}}
 *          normalised: the trunk stands on y = 0 and the tree is 1 unit tall,
 *          so `chunks.js` scales by a height in metres and nothing else.
 */
export function growTree(form, seed) {
  const rnd = rng(seed);
  const b = new TreeBuilder(form, rnd);
  const out = { tip: new THREE.Vector3(), dir: new THREE.Vector3(), radius: 0 };

  const queue = [{
    origin: new THREE.Vector3(0, 0, 0),
    dir: new THREE.Vector3(
      (rnd() - 0.5) * form.trunk.lean, 1, (rnd() - 0.5) * form.trunk.lean
    ).normalize(),
    length: form.trunk.length * (0.85 + rnd() * 0.3),
    radius: form.trunk.radius,
    level: 0,
  }];

  let grown = 0;
  while (queue.length && grown < form.maxBranches) {
    const br = queue.shift();
    grown++;
    b.branch(br.origin, br.dir, br.length, br.radius, br.level, out);

    const last = br.level >= form.levels;
    if (last || out.radius < form.minRadius) {
      b.leaves(out.tip, out.dir, form.leafSize * Math.pow(form.leafFalloff, br.level), br.level);
      continue;
    }

    // Children, spread around the parent axis. The radial offset per child is
    // the golden angle plus jitter: an even fan is the thing that makes a
    // procedural tree look procedural, and pure random clumps them.
    const lvl = form.branches[Math.min(br.level, form.branches.length - 1)];
    const kids = lvl.count;
    const side = perpendicular(br.dir, new THREE.Vector3());
    const up = new THREE.Vector3().crossVectors(br.dir, side);

    for (let i = 0; i < kids; i++) {
      // Along the parent, from `start` to just short of the tip.
      const t = lvl.start + (1 - lvl.start) * ((i + 0.5 + (rnd() - 0.5) * 0.6) / kids);
      const tc = Math.min(0.97, Math.max(0.05, t));
      const origin = new THREE.Vector3().lerpVectors(br.origin, out.tip, tc);

      const roll = i * 2.39996 + (rnd() - 0.5) * 0.9;
      const pitch = lvl.angle * (0.72 + rnd() * 0.56);
      const dir = br.dir.clone().multiplyScalar(Math.cos(pitch));
      dir.addScaledVector(side, Math.sin(pitch) * Math.cos(roll));
      dir.addScaledVector(up, Math.sin(pitch) * Math.sin(roll));
      dir.normalize();

      queue.push({
        origin,
        dir,
        // Shorter and thinner the further out, and shorter still the higher up
        // the parent it starts — which is what gives a conifer its cone and a
        // broadleaf its dome without either being described anywhere.
        length: br.length * lvl.length * (0.75 + rnd() * 0.5) * (1 - tc * lvl.tipShrink),
        radius: Math.max(form.minRadius * 0.6, out.radius * lvl.radius * (0.8 + rnd() * 0.4)),
        level: br.level + 1,
      });
    }
    // Some species carry leaf mass on the limbs as well as the tips. Without
    // it a big broadleaf is a bare frame with pom-poms on the ends.
    if (lvl.leafy) {
      b.leaves(out.tip, out.dir, form.leafSize * Math.pow(form.leafFalloff, br.level), br.level);
    }
  }

  const geo = b.build();
  // Normalise to unit height, standing on y = 0. Placement then works purely in
  // metres and no caller has to know how tall the archetype happened to grow.
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const h = Math.max(0.001, bb.max.y - bb.min.y);
  geo.translate(0, -bb.min.y, 0);
  geo.scale(1 / h, 1 / h, 1 / h);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  const radius = Math.max(
    bb.max.x - bb.min.x, bb.max.z - bb.min.z
  ) / (2 * h);

  return { geometry: geo, height: 1, radius };
}

/* --------------------------------------------------------- the impostors -- */

/**
 * Paints one species' silhouette into an impostor cell.
 *
 * A rendered impostor — an orthographic pass over the real mesh, baked to a
 * texture — is the textbook answer and is the wrong one here. It needs a live
 * renderer at boot, which the headless probes do not have and which would make
 * this the one generator in `src/env/` that cannot run without a GPU. Painting
 * the silhouette instead costs a canvas, agrees with the mesh by construction
 * (both are drawn from the same form parameters), and at the distance an
 * impostor is used the difference is a few pixels of outline.
 */
function drawImpostor(ctx, x0, y0, s, form, rnd) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, s, s);
  ctx.clip();

  const cx = x0 + s * 0.5;
  const groundY = y0 + s * 0.98;
  const trunkH = s * form.impostor.trunk;
  const trunkW = s * form.impostor.trunkWidth;

  // Trunk, tapering, with a slight lean so a stand of them is not a picket
  // fence. Drawn dark; the vertex colour supplies the hue.
  ctx.fillStyle = 'rgb(96,96,96)';
  ctx.beginPath();
  ctx.moveTo(cx - trunkW, groundY);
  ctx.lineTo(cx + trunkW, groundY);
  ctx.lineTo(cx + trunkW * 0.4, groundY - trunkH);
  ctx.lineTo(cx - trunkW * 0.4, groundY - trunkH);
  ctx.closePath();
  ctx.fill();

  // Canopy: blobs inside the species' envelope. `profile(t)` is the half-width
  // at height fraction t, which is the one number that separates a poplar from
  // an oak at two hundred metres.
  const top = groundY - s * 0.96;
  const canopyBase = groundY - trunkH * form.impostor.canopyFrom;
  const span = canopyBase - top;
  const blobs = form.impostor.blobs;
  for (let i = 0; i < blobs; i++) {
    const t = Math.pow(rnd(), form.impostor.bias);
    const y = canopyBase - t * span;
    const halfW = form.impostor.profile(t) * s * 0.5;
    const x = cx + (rnd() - 0.5) * 2 * halfW;
    const r = s * form.impostor.blobSize * (0.6 + rnd() * 0.8);
    // Lit from the top-left, and brighter toward the top of the crown.
    const lit = 0.42 + (1 - (y - top) / Math.max(1, span)) * 0.30
      + (1 - (x - x0) / s) * 0.22 + (rnd() - 0.5) * 0.16;
    const g = Math.round(255 * Math.max(0.12, Math.min(1, lit)));
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * form.impostor.blobSquash, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Impostor atlas: one cell per species, in a grid.
 *
 * One texture and therefore one material for every distant tree in the world,
 * which is what makes the far tier a handful of draw calls rather than one per
 * species per chunk.
 */
function buildImpostorAtlas(size, names) {
  const target = makeCanvas(size);
  if (!target) return null;
  const { canvas, ctx } = target;
  ctx.clearRect(0, 0, size, size);

  const cols = Math.ceil(Math.sqrt(names.length));
  const cell = size / cols;
  const rnd = rng(0xb17e5eed);
  const uvs = new Map();

  names.forEach((name, i) => {
    const cx = i % cols;
    const cy = Math.floor(i / cols);
    drawImpostor(ctx, cx * cell, cy * cell, cell, TREE_FORMS[name], rnd);
    // Canvas rows count down, UV rows count up.
    uvs.set(name, {
      u0: cx / cols,
      v0: 1 - (cy + 1) / cols,
      size: 1 / cols,
    });
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return { texture: tex, uvs, cols };
}

/**
 * Two crossed quads standing on y = 0, unit tall, UV'd into one atlas cell.
 *
 * Four triangles. This is the object that makes a forest possible, and the
 * whole of its cleverness is that there is nothing clever about it.
 */
function impostorGeometry(cellUV) {
  const pos = [], uv = [], col = [], sway = [], nrm = [], idx = [];
  const { u0, v0, size } = cellUV || { u0: 0, v0: 0, size: 1 };
  const m = size * 0.01;

  for (let q = 0; q < 2; q++) {
    const a = q * Math.PI * 0.5;
    const dx = Math.cos(a) * 0.5;
    const dz = Math.sin(a) * 0.5;
    const base = q * 4;
    pos.push(-dx, 0, -dz, dx, 0, dz, dx, 1, dz, -dx, 1, -dz);
    uv.push(
      u0 + m, v0 + m,
      u0 + size - m, v0 + m,
      u0 + size - m, v0 + size - m,
      u0 + m, v0 + size - m
    );
    // Root darker than crown, as in the near mesh, so the two agree as one
    // fades into the other.
    col.push(0.74, 0.74, 0.74, 0.74, 0.74, 0.74, 1, 1, 1, 1, 1, 1);
    sway.push(0.1, 0.1, 0.85, 0.85);
    for (let i = 0; i < 4; i++) nrm.push(0, 1, 0);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/* ---------------------------------------------------------- the material -- */

/**
 * One tier's material.
 *
 * Deliberately the same shape as `env/grass.js`'s, down to the shared program
 * cache key: near trees, far impostors and every bush compile to ONE program,
 * because the fade window is a uniform rather than a `#define` and the only
 * thing that differs between them is numbers.
 *
 * The wind differs from the grass in one way that matters. Grass bends by
 * `uv.y * uv.y`, which works because a tuft is a card whose UV is its own
 * height. A tree's UV is an atlas coordinate and says nothing about height, so
 * the bend comes from the `aSway` attribute the builder wrote — which also lets
 * a branch reaching sideways at two metres move while the trunk beside it at
 * the same height does not.
 */
export function foliageMaterial(map, fadeOut, fadeIn, opts = {}) {
  const material = new THREE.MeshStandardMaterial({
    map,
    vertexColors: true,
    transparent: false,
    // Higher than the grass's 0.42: a leaf card's painted mass has soft edges
    // and a low cutoff leaves a halo of half-transparent pixels that reads as
    // fog clinging to every tree.
    alphaTest: 0.5,
    alphaToCoverage: true,
    side: THREE.DoubleSide,
    roughness: 0.92,
    metalness: 0.0,
  });

  const uniforms = {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2(TREES.windDir.x, TREES.windDir.z).normalize() },
    uWindStrength: { value: opts.windStrength ?? TREES.windStrength },
    uWindSpeed: { value: opts.windSpeed ?? TREES.windSpeed },
    uFade: { value: new THREE.Vector2(fadeOut[0], fadeOut[1]) },
    uFadeIn: { value: new THREE.Vector2(fadeIn ? fadeIn[0] : -2, fadeIn ? fadeIn[1] : -1) },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute float aSway;
        varying float vSway;
        uniform float uTime;
        uniform vec2  uWind;
        uniform float uWindStrength;
        uniform float uWindSpeed;
        uniform vec2  uFade;
        uniform vec2  uFadeIn;
        vec2 fr_gust(vec3 p) {
          // Three scales rather than the grass's two. A canopy is big enough to
          // show the difference between the swell crossing it and the flutter
          // inside it, and two sines at tree scale read as a metronome.
          float a = sin(uTime * uWindSpeed       + p.x * 0.031 + p.z * 0.043);
          float b = sin(uTime * uWindSpeed * 2.3 + p.x * 0.13  - p.z * 0.09) * 0.42;
          float c = sin(uTime * uWindSpeed * 5.1 + p.x * 0.47  + p.z * 0.39) * 0.18;
          return uWind * (0.5 + 0.5 * (a + b + c)) * uWindStrength;
        }
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        vec3 fr_inst = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
        float fr_hash = fract( sin( dot( fr_inst.xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
        // Jitter the window per tree, so a stand thins out over a band instead
        // of retreating from the camera as a clean arc.
        float fr_d = distance( cameraPosition, fr_inst ) + ( fr_hash - 0.5 ) * 26.0;
        float fr_fade = smoothstep( uFadeIn.x, uFadeIn.y, fr_d )
                      * ( 1.0 - smoothstep( uFade.x, uFade.y, fr_d ) );
        // Shrink about the base, so a tree sinks into the ground rather than
        // dissolving. The material is a cutout; there is no opacity to fade.
        transformed *= fr_fade;
        vSway = aSway * fr_fade;
      `)
      .replace('#include <project_vertex>', /* glsl */`
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        vec4 fr_world = modelMatrix * mvPosition;
        // WORLD space, after the instance matrix — the same decision the grass
        // makes. Trees are randomly yawed, so displacing in object space would
        // send every one a different way and the wood would shimmer instead of
        // leaning together.
        fr_world.xz += fr_gust( fr_inst ) * vSway;
        mvPosition = viewMatrix * fr_world;
        gl_Position = projectionMatrix * mvPosition;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vSway;');
  };
  material.customProgramCacheKey = () => 'highroads-foliage';

  return { material, uniforms };
}

/* ------------------------------------------------------------- the boot -- */

/**
 * Builds the whole tree library: every species, every variant, both tiers.
 *
 * `TREES.variants` geometries per species, each from its own seed. The variant
 * count is a DRAW CALL decision as much as a look one — `chunks.js` runs an
 * InstancedMesh per (chunk, geometry), so a chunk commits to a couple of
 * variants and neighbouring chunks pick different ones. Three is enough that a
 * stand does not read as a copy-paste and low enough that the boot cost is a
 * few milliseconds.
 *
 * @returns the `src/env/` bundle, plus a `Map` of species -> variant protos in
 *          the exact shape `chunks.js` already expects from `loadFoliage`:
 *          `{ geometry, height, radius }`.
 */
export function createTreeAssets({ anisotropy = 1 } = {}) {
  const names = Object.keys(TREE_FORMS);

  const atlas = buildAtlas(TREES.textureSize);
  if (atlas) atlas.anisotropy = anisotropy;
  const imp = buildImpostorAtlas(TREES.impostorTextureSize, names);
  if (imp && imp.texture) imp.texture.anisotropy = anisotropy;

  /** species -> [{ geometry, height, radius }] */
  const library = new Map();
  /** species -> { geometry, height, radius } */
  const impostors = new Map();
  let triangles = 0;

  names.forEach((name, si) => {
    const form = TREE_FORMS[name];
    const variants = [];
    for (let v = 0; v < TREES.variants; v++) {
      // Seeded from the species index and the variant, never from the world
      // seed: every player sees the same trees, and a reload does not reshuffle
      // the forest's vocabulary underneath the placement that chose from it.
      const t = growTree(form, (0x7ee5 + si * 131 + v * 7919) >>> 0);
      triangles += t.geometry.index.count / 3;
      variants.push(t);
    }
    library.set(name, variants);
    const cellUV = imp ? imp.uvs.get(name) : null;
    impostors.set(name, {
      geometry: impostorGeometry(cellUV),
      height: 1,
      radius: 0.5,
    });
  });

  const near = foliageMaterial(atlas, [TREES.lodFade[0], TREES.lodFade[1]], null);
  const far = foliageMaterial(imp ? imp.texture : null, TREES.farFade, TREES.farFadeIn, {
    // A distant canopy that swings as hard as a near one reads as a gale. The
    // motion is also four pixels wide out there, so nothing is lost by damping.
    windStrength: TREES.windStrength * 0.45,
  });

  return {
    /** species -> array of `TREES.variants` protos. */
    library,
    /** species -> the four-triangle far-field stand-in. */
    impostors,
    material: near.material,
    impostorMaterial: far.material,
    /** Mean triangles per near tree, for the budget line in the probes. */
    trianglesPerTree: triangles / Math.max(1, names.length * TREES.variants),
    setTime(t) {
      near.uniforms.uTime.value = t;
      far.uniforms.uTime.value = t;
    },
    dispose() {
      for (const variants of library.values()) for (const v of variants) v.geometry.dispose();
      for (const i of impostors.values()) i.geometry.dispose();
      near.material.dispose();
      far.material.dispose();
      if (atlas) atlas.dispose();
      if (imp && imp.texture) imp.texture.dispose();
    },
  };
}
