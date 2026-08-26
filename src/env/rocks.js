/**
 * env/rocks.js — procedural stone, in three size classes.
 *
 * Rocks are not scenery here. They are TEXTURE — the thing that stops a cut
 * face reading as a smooth green ramp and a verge reading as a mown edge. The
 * brief is deliberately modest: gravel and slabs along the shoulder, scree
 * spilling out of a cutting, the occasional boulder sitting in the grass. Not
 * fields of them, and nothing you would call a landmark.
 *
 * ── how one is built ────────────────────────────────────────────────────────
 *
 * A subdivided icosahedron, displaced per vertex, then squashed. Three things
 * do all the work:
 *
 *   1. **Multi-octave radial displacement.** Two octaves of value noise on the
 *      unit direction. The first gives the lump its overall irregularity; the
 *      second breaks the silhouette so it is not an egg.
 *   2. **Flattening.** Real stone is bedded and broken, not round. Each rock
 *      gets a random non-uniform scale with the vertical axis biased short, and
 *      slabs get an extreme one.
 *   3. **Planar faceting.** The displaced sphere is snapped toward a handful of
 *      random half-space planes — `r = min(r, plane)` for a few random
 *      normals — which is what a fracture is. Without it the result is a potato;
 *      with it, it has faces and edges that catch a light.
 *
 * Normals are FLAT and that is the whole look. A rock is a fractured solid, so
 * every face should have its own shade; smooth-shading one gives a soft blobby
 * thing that reads as clay.
 *
 * ── budget ──────────────────────────────────────────────────────────────────
 *
 * Icosahedron detail 1 is 80 triangles, detail 0 is 20. Scree uses detail 0 and
 * boulders detail 1, so the mean is around 44 per instance — against 1,700 to
 * 2,900 for one of the Quaternius canopies. A hundred rocks in view is 4,400
 * triangles, which is four percent of the terrain sheet.
 *
 * ── colour, and the one exception in `src/env/` ─────────────────────────────
 *
 * Vertex colours here are LUMINANCE, as everywhere: the hue is per instance.
 * But it is the ONE asset in this directory whose hue does not come from the
 * terrain under it — it comes from `ROCKS.palette`, a fixed set of mineral
 * greys and browns.
 *
 * That is a deliberate carve-out from rule 5 of `src/env/README.md`, and the
 * reason is that the rule is about things that GROW out of the ground. Grass
 * and foliage take the ground's colour because a green tuft on a grey scree
 * slope is wrong. A rock does not photosynthesise: sampling the verge gave
 * every chip along the shoulder the grass's green, which reads as algae rather
 * than as stone. The palette is in `config.js` and not in this file for the
 * same reason every other tunable is.
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

/**
 * One rock, as a `BufferGeometry` with position, normal and colour, its base
 * sitting on y = 0 and its longest horizontal half-extent normalised to 0.5.
 *
 * Normalising means the scatter can ask for "a 40 cm rock" and get one, whatever
 * shape came out — otherwise every size in the config would be a size the
 * generator merely influenced.
 */
function buildRock(rand, noise, { detail, flatten, facets, roughness }) {
  // Non-indexed, so every triangle owns its vertices and flat normals fall out
  // of `computeVertexNormals` rather than needing a duplication pass.
  // `IcosahedronGeometry` is already non-indexed; the guard is there because
  // that is an implementation detail of three's polyhedron builder, not a
  // promise.
  const geo = new THREE.IcosahedronGeometry(0.5, detail);
  const src = geo.index ? geo.toNonIndexed() : geo;
  if (src !== geo) geo.dispose();
  const pos = src.attributes.position.array;

  // Fracture planes. `r = min(r, d/dot(n, dir))` clips the lump against a
  // half-space through the origin at distance d, which is exactly a broken face.
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

  // A per-rock offset into the noise field, so two rocks built from the same
  // lattice are still different rocks.
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

  // Normalise the horizontal half-extent, then drop the whole thing so its
  // lowest point is exactly on y = 0. A rock floating a centimetre over the
  // grass is the single most obvious scatter bug there is.
  const k = 0.5 / maxXZ;
  let minY = Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] *= k; pos[i + 1] *= k; pos[i + 2] *= k;
    if (pos[i + 1] < minY) minY = pos[i + 1];
  }
  for (let i = 1; i < pos.length; i += 3) pos[i] -= minY;

  src.computeVertexNormals();

  // Luminance only — the hue arrives per instance from the terrain. Faces
  // pointing up are lighter (weathered, dusty); undersides are darker, which is
  // ambient occlusion the lighting rig is too coarse to produce for something
  // this small.
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
 * The shared rock assets: a small library of variants per size class, and one
 * material for all of them.
 *
 * A library rather than one shape per class because an instanced scatter of a
 * single mesh is unmistakable the moment two of them land near each other —
 * the eye finds the repeat before it finds anything else in the frame. Six
 * variants at ~44 triangles each is 264 triangles of unique geometry for the
 * whole world, so the honest way to buy variety is simply to build more.
 *
 * Classes:
 *   `scree`   — 10–35 cm chips, for spilling down a cut face and along a verge
 *   `stone`   — 35 cm–1 m, the general-purpose one
 *   `boulder` — 1–2.5 m, sparse, something to sit in the grass
 */
export function createRockAssets() {
  const rand = rng(0x51ed270b);
  const noise = makeLumpNoise(rand);

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    // FLAT. See the header — a fractured solid whose faces all shade alike is
    // not a rock, it is a pebble made of clay.
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
    // The scatter takes a WINDOW into `variants`, rotated per chunk, so the
    // whole library gets used across the world while any one chunk only ever
    // touches a couple of geometries — see `chunks.js:_buildRocks` and
    // ROCKS.variantsPerChunk.
    classes[name] = { variants, spec };
  }

  return {
    material,
    classes,
    /** Every variant geometry, flattened — for a caller that wants to iterate. */
    all() {
      return Object.values(classes).flatMap((c) => c.variants);
    },
    dispose() {
      material.dispose();
      for (const c of Object.values(classes)) for (const g of c.variants) g.dispose();
    },
  };
}
