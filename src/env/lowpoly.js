/**
 * env/lowpoly.js — faceted solids.
 *
 * The shared primitive layer under `trees.js` and `bushes.js`. It owns three
 * shapes and one accumulator, and nothing above it ever touches a vertex.
 *
 * ── why solids, after a whole file arguing for cards ────────────────────────
 *
 * The canopy used to be alpha-cutout cards carrying a painted leaf mass, with a
 * four-triangle billboard standing in past 260 m. Cards are the cheapest way to
 * draw a volume of small leaves and they were the right call for that look.
 * They are the wrong call for THIS one. A faceted low-poly canopy has no small
 * leaves in it — the whole style is a handful of big flat planes catching the
 * light — so a card buys nothing and costs three things:
 *
 *   ALPHA TEST. A cutout needs `alphaTest`, `alphaToCoverage` and DoubleSide.
 *   A solid needs none of them, culls its own back faces, and writes depth
 *   normally, which is most of a card's cost gone.
 *   TWO OBJECTS. A painted billboard and a grown mesh are different pictures of
 *   the same tree, so they disagree at the handover: the reported symptom was
 *   distant trees "very out of place", shrinking as near ones grew.
 *   A TEXTURE. Two atlases, two megabytes, and a mip chain that had to be
 *   gutter-margined by hand.
 *
 * A faceted solid is its own level of detail. The far tier here is the SAME
 * BUILDER at a lower subdivision — same silhouette, same colours, same
 * proportions — so the cross-fade has nothing left to disagree about.
 *
 * ── flat shading without `flatShading` ──────────────────────────────────────
 *
 * Every face is emitted with its own three vertices and one normal. That is
 * three times the vertices of an indexed sphere and it is not negotiable: the
 * look IS the discontinuity at the edges, and it also lets each face carry its
 * own colour, which is the second half of the look. `material.flatShading`
 * would give the normals via screen-space derivatives but leaves the colour
 * per-vertex and smooth, and a crown of smoothly-tinted hard facets reads as a
 * shading bug.
 *
 * ── interior culling ────────────────────────────────────────────────────────
 *
 * A crown is five or six overlapping lumps, so a third to a half of every
 * lump's surface is buried inside its neighbours and can never be seen. `blob`
 * takes the lumps already placed as occluders and drops any face whose centroid
 * is inside one. It is exact — the occluder test evaluates the same warp
 * function that displaced the surface — costs a few thousand comparisons per
 * species at boot, and it is worth 30-45% of the crown.
 */

import * as THREE from 'three';

/* ------------------------------------------------------- the accumulator -- */

/**
 * A non-indexed, flat-shaded, per-face-coloured mesh under construction.
 *
 * Plain JS arrays, typed once in `build`. A tree is a few hundred faces, so the
 * arrays cost nothing and the alternative — sizing buffers up front — means
 * predicting the face count of a routine whose whole job is to drop faces.
 */
export class Facets {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    /** Wind response per vertex, 0 at the root to 1 in the canopy. */
    this.sway = [];
  }

  get triangles() {
    return this.pos.length / 9;
  }

  /**
   * One triangle. The normal is computed from the winding, so callers only
   * have to get the order right once per shape rather than carry normals.
   *
   * `col` is [r, g, b] for the whole face; `sway` is [a, b, c] or a scalar.
   */
  face(a, b, c, col, sway) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    // A degenerate face has no normal and nothing to contribute. Emitting it
    // anyway puts NaNs in the buffer and three then refuses the whole geometry.
    if (l < 1e-12) return;
    nx /= l; ny /= l; nz /= l;

    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) {
      this.nrm.push(nx, ny, nz);
      this.col.push(col[0], col[1], col[2]);
    }
    if (typeof sway === 'number') this.sway.push(sway, sway, sway);
    else this.sway.push(sway[0], sway[1], sway[2]);
  }

  /** A quad as two triangles, wound a-b-c-d. */
  quad(a, b, c, d, col, sway) {
    const s = typeof sway === 'number' ? [sway, sway, sway, sway] : sway;
    this.face(a, b, c, col, [s[0], s[1], s[2]]);
    this.face(a, c, d, col, [s[0], s[2], s[3]]);
  }

  build() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 1));
    geo.computeBoundingSphere();
    return geo;
  }
}

/** Triangles in a geometry, indexed or not. */
export function triangleCount(geo) {
  return geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
}

/* ------------------------------------------------------------ icosphere -- */

const _ico = new Map();

/**
 * Unit icosphere at `detail`, as shared vertex directions and face indices.
 *
 * 20 faces at detail 0, 80 at 1, 320 at 2. Cached: eight species times three
 * variants times six lumps is a hundred and forty subdivisions of the same
 * three tables otherwise.
 *
 * The icosahedron and not a UV sphere, because a UV sphere's facets are
 * quads that degenerate to slivers at the poles — visible as a pinch on the
 * top of every lump, which is exactly where the light is.
 */
function icosphere(detail) {
  const key = detail | 0;
  const hit = _ico.get(key);
  if (hit) return hit;

  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  });
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  for (let d = 0; d < key; d++) {
    const mid = new Map();
    const next = [];
    const midpoint = (i, j) => {
      const k = i < j ? `${i},${j}` : `${j},${i}`;
      const seen = mid.get(k);
      if (seen !== undefined) return seen;
      const a = verts[i], b = verts[j];
      const x = a[0] + b[0], y = a[1] + b[1], z = a[2] + b[2];
      const l = Math.hypot(x, y, z);
      verts.push([x / l, y / l, z / l]);
      const idx = verts.length - 1;
      mid.set(k, idx);
      return idx;
    };
    for (const [i, j, k] of faces) {
      const a = midpoint(i, j), b = midpoint(j, k), c = midpoint(k, i);
      next.push([i, a, c], [j, b, a], [k, c, b], [a, b, c]);
    }
    faces = next;
  }

  const out = { verts, faces };
  _ico.set(key, out);
  return out;
}

/**
 * A smooth radial deformation of the unit sphere.
 *
 * Three sines of the direction dotted with three random axes. Continuous over
 * the whole sphere by construction — which value noise on a lattice is not, and
 * a discontinuity here tears the lump open along a seam.
 */
export function makeWarp(rnd, amp) {
  const axes = [];
  for (let i = 0; i < 3; i++) {
    const th = rnd() * Math.PI * 2;
    const ph = Math.acos(rnd() * 2 - 1);
    axes.push({
      x: Math.sin(ph) * Math.cos(th),
      y: Math.sin(ph) * Math.sin(th),
      z: Math.cos(ph),
      f: 1.5 + rnd() * 2.4,
      p: rnd() * Math.PI * 2,
    });
  }
  return (nx, ny, nz) => {
    let a = 0;
    for (const ax of axes) {
      a += Math.sin((nx * ax.x + ny * ax.y + nz * ax.z) * ax.f + ax.p);
    }
    return 1 + (a / 3) * amp;
  };
}

/**
 * A lump: a warped ellipsoid of faceted triangles.
 *
 * @param {Facets} F
 * @param {object} o
 *   c        [x, y, z] centre
 *   r        [rx, ry, rz] radii
 *   detail   icosphere subdivision
 *   warp     0..1 deformation amplitude
 *   rnd      PRNG, consumed for the warp axes and the per-face tint
 *   colour   (nx, ny, nz, jitter) -> [r, g, b], called once per FACE
 *   sway     (x, y, z) -> 0..1, called once per vertex
 *   hide     lumps already placed; a face inside one of them is dropped
 * @returns {object} this lump, in the shape `hide` wants
 */
export function blob(F, o) {
  const { verts, faces } = icosphere(o.detail);
  // Handed in when the caller planned the lumps up front so that every one
  // can occlude every other; built here otherwise.
  const warp = o.warpFn || makeWarp(o.rnd, o.warp ?? 0.18);
  const [cx, cy, cz] = o.c;
  const [rx, ry, rz] = o.r;
  const hide = o.hide || [];

  // Displaced vertex table first, SHARED between the faces that meet at it.
  // Displacing per face would move the same corner three different ways and
  // open a crack at every edge.
  const p = new Array(verts.length);
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    const w = warp(v[0], v[1], v[2]);
    p[i] = [cx + v[0] * rx * w, cy + v[1] * ry * w, cz + v[2] * rz * w];
  }

  for (const [i, j, k] of faces) {
    const a = p[i], b = p[j], c = p[k];
    const mx = (a[0] + b[0] + c[0]) / 3;
    const my = (a[1] + b[1] + c[1]) / 3;
    const mz = (a[2] + b[2] + c[2]) / 3;

    let buried = false;
    for (let h = 0; h < hide.length; h++) {
      if (inside(hide[h], mx, my, mz)) { buried = true; break; }
    }
    if (buried) continue;

    // The face normal, before the winding is known, purely to shade by
    // orientation: a low-poly crown reads as volume because its upward faces
    // are lighter, and that is a property of the face and not of the vertex.
    let nx = (mx - cx) / rx, ny = (my - cy) / ry, nz = (mz - cz) / rz;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;

    F.face(a, b, c, o.colour(nx, ny, nz, o.rnd()),
      [o.sway(a[0], a[1], a[2]), o.sway(b[0], b[1], b[2]), o.sway(c[0], c[1], c[2])]);
  }

  return { c: o.c, r: o.r, warp };
}

/**
 * Is a point inside a placed lump? Evaluates that lump's own warp.
 *
 * `L` is a PLAN — `{ c, r, warp }`, the same record `blob` takes and returns —
 * and it has to be, because the caller assembles the plans before any of them
 * is emitted. This read `L.cx` once, against plans that carry `L.c[0]`, and
 * every comparison came out NaN: nothing was ever culled and an oak was 576
 * triangles instead of 380, silently, with no symptom but the budget.
 */
function inside(L, x, y, z) {
  const dx = (x - L.c[0]) / L.r[0];
  const dy = (y - L.c[1]) / L.r[1];
  const dz = (z - L.c[2]) / L.r[2];
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-6) return true;
  // 0.94 rather than 1: a face whose CENTROID is just inside still has corners
  // outside, and dropping it would nibble a visible notch out of the skyline.
  return d < L.warp(dx / d, dy / d, dz / d) * 0.94;
}

/* ------------------------------------------------------------------ tube -- */

/**
 * A tapering faceted tube along a polyline — trunks, limbs, shrub stems.
 *
 * `nodes` is [{ x, y, z, r }, ...] from base to tip. Rings are built on a
 * parallel-transported frame rather than a fixed up-vector, so a stem that
 * curves does not twist its facets as it goes.
 *
 * No caps. The base is buried and the tip is inside the crown; two fans of
 * `sides` triangles each, per branch, for surfaces that are never seen.
 */
export function tube(F, nodes, sides, colour, sway) {
  if (nodes.length < 2) return;

  // Initial frame: any perpendicular to the first segment, chosen off whichever
  // world axis the segment is least aligned to so there is no singularity where
  // a trunk points straight up.
  let dx = nodes[1].x - nodes[0].x;
  let dy = nodes[1].y - nodes[0].y;
  let dz = nodes[1].z - nodes[0].z;
  let dl = Math.hypot(dx, dy, dz) || 1;
  dx /= dl; dy /= dl; dz /= dl;
  let ux, uy, uz;
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
  if (ax <= ay && ax <= az) { ux = 1; uy = 0; uz = 0; }
  else if (ay <= az) { ux = 0; uy = 1; uz = 0; }
  else { ux = 0; uy = 0; uz = 1; }
  // side = normalize(cross(d, u)); up = cross(side, d)
  let sx = dy * uz - dz * uy, sy = dz * ux - dx * uz, sz = dx * uy - dy * ux;
  let sl = Math.hypot(sx, sy, sz) || 1;
  sx /= sl; sy /= sl; sz /= sl;
  let tx = sy * dz - sz * dy, ty = sz * dx - sx * dz, tz = sx * dy - sy * dx;

  let prev = null;
  for (let n = 0; n < nodes.length; n++) {
    if (n > 0) {
      // Parallel transport: re-orthogonalise the previous frame against the new
      // direction rather than rebuilding it, which is what keeps the seam
      // running straight up a curved stem.
      dx = nodes[n].x - nodes[n - 1].x;
      dy = nodes[n].y - nodes[n - 1].y;
      dz = nodes[n].z - nodes[n - 1].z;
      dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl; dy /= dl; dz /= dl;
      const dot = sx * dx + sy * dy + sz * dz;
      sx -= dx * dot; sy -= dy * dot; sz -= dz * dot;
      sl = Math.hypot(sx, sy, sz) || 1;
      sx /= sl; sy /= sl; sz /= sl;
      tx = sy * dz - sz * dy; ty = sz * dx - sx * dz; tz = sx * dy - sy * dx;
    }

    const node = nodes[n];
    const ring = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const ca = Math.cos(a) * node.r, sa = Math.sin(a) * node.r;
      ring.push([
        node.x + sx * ca + tx * sa,
        node.y + sy * ca + ty * sa,
        node.z + sz * ca + tz * sa,
      ]);
    }

    if (prev) {
      const w0 = sway(nodes[n - 1].y), w1 = sway(node.y);
      for (let k = 0; k < sides; k++) {
        const k2 = (k + 1) % sides;
        F.quad(prev[k], prev[k2], ring[k2], ring[k],
          colour(n / (nodes.length - 1), k / sides), [w0, w0, w1, w1]);
      }
    }
    prev = ring;
  }
}

/* ------------------------------------------------------------------ tier -- */

/**
 * One conifer skirt: a jagged n-gon rim rising to a point.
 *
 * This is the whole of what makes a low-poly spruce a low-poly spruce, and it
 * is deliberately not a cone. The rim radius is jittered per corner and the rim
 * drops away from the axis, so the silhouette is a ragged star seen from above
 * and a drooping bough seen from the side — which is what the reference art
 * does and what a smooth cone conspicuously does not.
 *
 * `floor` closes the underside. Only the LOWEST tier needs it: every other one
 * has a skirt beneath it, and a fan of `sides` triangles apiece for surfaces
 * inside the tree is a quarter of a conifer's whole budget.
 */
export function tier(F, o) {
  const { cx, cz, y, radius, height, sides, droop, jag, rnd, colour, sway } = o;
  const apex = [cx, y + height, cz];
  const rim = [];
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * Math.PI * 2 + (o.phase || 0);
    const r = radius * (1 - jag * rnd());
    rim.push([cx + Math.cos(a) * r, y - droop * radius, cz + Math.sin(a) * r]);
  }
  const wa = sway(apex[1]);
  const wr = sway(rim[0][1]);
  for (let k = 0; k < sides; k++) {
    const k2 = (k + 1) % sides;
    F.face(apex, rim[k], rim[k2], colour(k / sides, 1, rnd()), [wa, wr, wr]);
  }
  if (o.floor) {
    const hub = [cx, y + height * 0.12, cz];
    const wh = sway(hub[1]);
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides;
      F.face(hub, rim[k2], rim[k], colour(k / sides, -1, rnd()), [wh, wr, wr]);
    }
  }
  return rim;
}
