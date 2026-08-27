/**
 * env/rocks.js — procedural stone in three size classes.
 *
 * Rocks break the clean surfaces: gravel and slabs along the shoulder, scree
 * in a cutting, and the occasional boulder. A subdivided icosahedron is
 * displaced per vertex and then squashed.
 */

import * as THREE from 'three';
import { ROCKS } from '../config.js';
import { rng } from './textures.js';

/** Smooth 3D value noise on a small lattice. Enough for a lump; not terrain. */
function makeLumpNoise(rand) {
  const N = 16;
  const grid = new Float32Array(N * N * N);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const at = (x, y, z) => grid[
    (((x % N) + N) % N) * N * N + (((y % N) + N) % N) * N + (((z % N) + N) % N)
  ];
  return (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let fx = x - ix, fy = y - iy, fz = z - iz;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    fz = fz * fz * (3 - 2 * fz);
    const c000 = at(ix, iy, iz), c100 = at(ix + 1, iy, iz);
    const c010 = at(ix, iy + 1, iz), c110 = at(ix + 1, iy + 1, iz);
    const c001 = at(ix, iy, iz + 1), c101 = at(ix + 1, iy, iz + 1);
    const c011 = at(ix, iy + 1, iz + 1), c111 = at(ix + 1, iy + 1, iz + 1);
    const x00 = c000 + (c100 - c000) * fx, x10 = c010 + (c110 - c010) * fx;
    const x01 = c001 + (c101 - c001) * fx, x11 = c011 + (c111 - c011) * fx;
    const y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy;
    return y0 + (y1 - y0) * fz;
  };
}

/** One rock on y = 0, longest horizontal half-extent normalised to 0.5, so scatter can ask for an exact size. */
function buildRock(rand, noise, { detail, flatten, facets, roughness }) {
  // Non-indexed so flat normals fall out; the guard defends against three's builder.
  const geo = new THREE.IcosahedronGeometry(0.5, detail);
  const src = geo.index ? geo.toNonIndexed() : geo;
  if (src !== geo) geo.dispose();
  const pos = src.attributes.position.array;

  // Fracture planes: `r = min(r, d/dot(n, dir))` clips the lump into broken faces.
  const planes = [];
  for (let i = 0; i < facets; i++) {
    const a = rand() * Math.PI * 2;
    const b = Math.acos(rand() * 2 - 1);
    planes.push({
      x: Math.sin(b) * Math.cos(a),
      y: Math.sin(b) * Math.sin(a),
      z: Math.cos(b),
      d: 0.30 + rand() * 0.20,
    });
  }

  // Per-rock noise offset: same lattice, different rocks.
  const ox = rand() * 64, oy = rand() * 64, oz = rand() * 64;
  const sx = 1, sy = flatten, sz = 0.78 + rand() * 0.44;

  let maxXZ = 1e-6;
  for (let i = 0; i < pos.length; i += 3) {
    let x = pos[i], y = pos[i + 1], z = pos[i + 2];
    const len = Math.hypot(x, y, z) || 1;
    const dx = x / len, dy = y / len, dz = z / len;

    // Two octaves: shape, then break-up.
    const n1 = noise(ox + dx * 2.1, oy + dy * 2.1, oz + dz * 2.1);
    const n2 = noise(ox + dx * 6.3, oy + dy * 6.3, oz + dz * 6.3);
    let r = 0.5 * (1 + (n1 - 0.5) * roughness * 2 + (n2 - 0.5) * roughness);

    for (const p of planes) {
      const proj = dx * p.x + dy * p.y + dz * p.z;
      if (proj > 1e-3) r = Math.min(r, p.d / proj);
    }

    x = dx * r * sx;
    y = dy * r * sy;
    z = dz * r * sz;
    pos[i] = x; pos[i + 1] = y; pos[i + 2] = z;
    const h = Math.hypot(x, z);
    if (h > maxXZ) maxXZ = h;
  }

  // Normalise the half-extent, then drop to y = 0 — a floating rock is the most obvious scatter bug.
  const k = 0.5 / maxXZ;
  let minY = Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] *= k; pos[i + 1] *= k; pos[i + 2] *= k;
    if (pos[i + 1] < minY) minY = pos[i + 1];
  }
  for (let i = 1; i < pos.length; i += 3) pos[i] -= minY;

  src.computeVertexNormals();

  // Luminance only: up-faces lighter (weathered), under-faces darker — AO the rig cannot produce.
  const nrm = src.attributes.normal.array;
  const col = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const up = nrm[i + 1];
    const v = 0.62 + 0.38 * Math.max(0, up) + (rand() - 0.5) * 0.10;
    col[i] = v; col[i + 1] = v; col[i + 2] = v;
  }
  src.setAttribute('color', new THREE.BufferAttribute(col, 3));
  src.computeBoundingSphere();
  return src;
}

/**
 * A small library of variants per size class plus one shared material. Several
 * shapes hide the repetition the eye finds instantly in a single-mesh scatter.
 */
export function createRockAssets() {
  const rand = rng(0x51ed270b);
  const noise = makeLumpNoise(rand);

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    // Flat-shaded: a fractured solid whose faces all shade alike reads as clay.
    flatShading: true,
    roughness: 0.94,
    metalness: 0.0,
  });

  const classes = {};
  for (const [name, spec] of Object.entries(ROCKS.classes)) {
    const variants = [];
    for (let i = 0; i < spec.variants; i++) {
      variants.push(buildRock(rand, noise, {
        detail: spec.detail,
        flatten: spec.flatten[0] + rand() * (spec.flatten[1] - spec.flatten[0]),
        facets: spec.facets,
        roughness: spec.roughness,
      }));
    }
    // The scatter takes a per-chunk window into `variants`, so one chunk only touches a couple of geometries.
    classes[name] = { variants, spec };
  }

  return {
    material,
    classes,
    /** All variant geometries, flattened. */
    all() {
      return Object.values(classes).flatMap((c) => c.variants);
    },
    dispose() {
      material.dispose();
      for (const c of Object.values(classes)) for (const g of c.variants) g.dispose();
    },
  };
}