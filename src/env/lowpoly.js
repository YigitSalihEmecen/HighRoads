/**
 * env/lowpoly.js — faceted solids.
 *
 * The shared primitive layer under trees.js and bushes.js: three shapes and
 * one accumulator. Nothing above this layer touches a vertex.
 */

import * as THREE from 'three';

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

  /** Normal is computed from the winding, so callers only get the order right once per shape. */
  face(a, b, c, col, sway) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    // A degenerate face is dropped — emitting NaNs poisons the buffer and three rejects the geometry.
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

const _ico = new Map();

/** An icosahedron, not a UV sphere — a UV sphere's polar quads degenerate to slivers, pinching every lump's top. */
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

/** Three sines of the direction, continuous over the sphere — lattice value noise would tear the lump along a seam. */
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

export function blob(F, o) {
  const { verts, faces } = icosphere(o.detail);
  // `warpFn` is passed in when the caller planned lumps up front for mutual occlusion; built here otherwise.
  const warp = o.warpFn || makeWarp(o.rnd, o.warp ?? 0.18);
  const [cx, cy, cz] = o.c;
  const [rx, ry, rz] = o.r;
  const hide = o.hide || [];

  // Vertex table displaced once, shared by the faces at each corner — per-face displacing cracks every edge.
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

    // Buried only if all three corners are inside one occluder — centroid-only culling leaves rims standing in open air.
    let buried = false;
    for (let h = 0; h < hide.length; h++) {
      const L = hide[h];
      if (inside(L, a[0], a[1], a[2]) &&
          inside(L, b[0], b[1], b[2]) &&
          inside(L, c[0], c[1], c[2])) { buried = true; break; }
    }
    if (buried) continue;

    let nx = (mx - cx) / rx, ny = (my - cy) / ry, nz = (mz - cz) / rz;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;

    F.face(a, b, c, o.colour(nx, ny, nz, o.rnd()),
      [o.sway(a[0], a[1], a[2]), o.sway(b[0], b[1], b[2]), o.sway(c[0], c[1], c[2])]);
  }

  return { c: o.c, r: o.r, warp };
}

/** Faces sag below the vertices by detail, measured off the tables in `icosphere`. */
const FACET = [0.7947, 0.9342, 0.9822];

/** `L` is a plan `{c, r, warp}`, not a blob — the caller assembles plans before any are emitted. */
function inside(L, x, y, z) {
  const dx = (x - L.c[0]) / L.r[0];
  const dy = (y - L.c[1]) / L.r[1];
  const dz = (z - L.c[2]) / L.r[2];
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-6) return true;
  // Test against the FACETS (inscribed, sag to `FACET[detail]`), not the smooth radius, or covering faces get dropped.
  return d < L.warp(dx / d, dy / d, dz / d) * FACET[Math.min(2, L.detail | 0)];
}

/** Caps default off — the ends are buried; an uncapped visible end is a hole under `FrontSide`. */
export function tube(F, nodes, sides, colour, sway, caps = null) {
  if (nodes.length < 2) return;

  // Initial frame off the axis `d` is least aligned to, so a vertical stem has no singularity.
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
  let sx = dy * uz - dz * uy, sy = dz * ux - dx * uz, sz = dx * uy - dy * ux;
  let sl = Math.hypot(sx, sy, sz) || 1;
  sx /= sl; sy /= sl; sz /= sl;
  let tx = sy * dz - sz * dy, ty = sz * dx - sx * dz, tz = sx * dy - sy * dx;

  let prev = null;
  for (let n = 0; n < nodes.length; n++) {
    if (n > 0) {
      // Parallel transport re-orthogonalises the frame, which keeps the seam straight up a curved stem.
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
        // Wound outward: the other way every tube is back-face culled under
        // `FrontSide` — the signed-volume probe catches it.
        F.quad(prev[k], ring[k], ring[k2], prev[k2],
          colour(n / (nodes.length - 1), k / sides), [w0, w1, w1, w0]);
      }
    }
    if (n === 0 && caps && caps.start) {
      // Start cap faces backward, wound opposite the end cap.
      const hub = [node.x, node.y, node.z];
      const w = sway(node.y);
      for (let k = 0; k < sides; k++) {
        F.face(hub, ring[k], ring[(k + 1) % sides], colour(0, 0), [w, w, w]);
      }
    }
    if (n === nodes.length - 1 && caps && caps.end) {
      const hub = [node.x, node.y, node.z];
      const w = sway(node.y);
      for (let k = 0; k < sides; k++) {
        F.face(hub, ring[(k + 1) % sides], ring[k], colour(1, 0), [w, w, w]);
      }
    }
    prev = ring;
  }
}

/** Every tier is closed underneath — a skirt's rim is its widest point, so an unfloored tier is a ring-shaped hole. */
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
  /** `colour` gets the face's real normal-y, so a skirt lights like the crown it carries. */
  const ny = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, n1 = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    return n1 / (Math.hypot(nx, n1, nz) || 1);
  };
  for (let k = 0; k < sides; k++) {
    const k2 = (k + 1) % sides;
    F.face(apex, rim[k2], rim[k],
      colour(k / sides, ny(apex, rim[k2], rim[k]), rnd()), [wa, wr, wr]);
  }
  {
    const hub = [cx, y + height * 0.12, cz];
    const wh = sway(hub[1]);
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides;
      // Underside faces down, so it is wound the opposite way to the skirt.
      F.face(hub, rim[k], rim[k2],
        colour(k / sides, ny(hub, rim[k], rim[k2]), rnd()), [wh, wr, wr]);
    }
  }
  return rim;
}