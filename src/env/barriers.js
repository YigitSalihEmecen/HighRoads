/**
 * env/barriers.js — roadside barriers: the models, and where a run stands.
 *
 *   steel   W-beam guardrail: the W profile swept from post to post, on steel
 *           posts, the rail's ends turned down and buried (a terminal).
 *   wood    a timber post-and-rail fence: square posts, two rails between.
 *
 * Both are built per chunk into one merged, vertex-coloured geometry each
 * (`BarrierMesher`); `chunks.js:_buildBarriers` decides the posts. Where they
 * go is `barrierRuns`: a pure function of a station index, so every chunk
 * agrees with its neighbours where a run starts, ends and what it is made of.
 */
import * as THREE from 'three';
import { hashInt } from '../util.js';

/**
 * The W-beam's cross-section, (out, up) metres from its foot: 31 cm high,
 * 8 cm deep, two crests. `out` points away from the road (the posts' side).
 */
const W_BEAM = [[0, 0], [0.02, 0.03], [0.08, 0.075], [0.08, 0.115], [0.03, 0.155],
  [0.08, 0.195], [0.08, 0.235], [0.02, 0.28], [0, 0.31]];
const RAIL_FOOT = 0.45;
const STEEL = new THREE.Color(0xb9bcbd);
const POST = new THREE.Color(0x8d9294);
const TIMBER = new THREE.Color(0x7d6248);

export function createBarrierMaterials() {
  return {
    // Matte enough to read without an environment map to reflect.
    steel: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.42, side: THREE.DoubleSide }),
    wood: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, roughness: 0.92 }),
  };
}

/** Collects one chunk's barriers into a geometry per material. */
export class BarrierMesher {
  constructor() {
    this.parts = { steel: blank(), wood: blank() };
  }

  /**
   * One run's posts, in order: `{ x, y, z }` ground at each post (origin-
   * relative), `ox, oz` its outward unit normal, `post` whether this chunk
   * draws it, `rail` whether it draws the span to the next. `head`/`tail`:
   * this chunk holds the run's first/last post, so it draws that terminal.
   */
  steel(pts, rng, head, tail) {
    const P = this.parts.steel;
    const n = pts.length;
    // Terminals: the rail carries on a span past each end post, sinking into the ground.
    const ext = (i, dir) => {
      const a = pts[i], b = pts[i + dir];
      const L = Math.hypot(a.x - b.x, a.z - b.z) || 1;
      return { x: a.x + (a.x - b.x) / L * 3.5, y: a.y - RAIL_FOOT - 0.3, z: a.z + (a.z - b.z) / L * 3.5, ox: a.ox, oz: a.oz };
    };
    const rail = (a, b) => sweep(P, a, b, W_BEAM, STEEL, 0.92 + rng() * 0.12);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (p.post) box(P, p.x + p.ox * 0.1, p.y + 0.25, p.z + p.oz * 0.1, p.oz, -p.ox, p.ox, p.oz, 0.05, 0.55, 0.075, POST);
      if (p.rail && i + 1 < n) rail(lift(p), lift(pts[i + 1]));
    }
    if (head && n > 1) rail(ext(0, 1), lift(pts[0]));
    if (tail && n > 1) rail(lift(pts[n - 1]), ext(n - 1, -1));
  }

  /** As `steel`; no terminals — a fence just ends at a post. */
  wood(pts, rng) {
    const P = this.parts.wood;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const shade = 0.78 + rng() * 0.32;
      if (p.post) {
        // Set by hand: a little high or low, a little out of true.
        const h = 0.5 + rng() * 0.08, lean = (rng() - 0.5) * 0.06;
        box(P, p.x + p.ox * lean, p.y + h - 0.25, p.z + p.oz * lean, p.oz, -p.ox, p.ox, p.oz, 0.08, h + 0.25, 0.08, TIMBER, shade);
      }
      if (!p.rail || i + 1 >= n) continue;
      const q = pts[i + 1];
      const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
      const L = Math.hypot(dx, dy, dz), H = Math.hypot(dx, dz) || 1;
      const ax = dx / H, az = dz / H;
      for (const h of [0.34, 0.74]) {
        // On the road side of the posts, along the span (its own slope). The
        // depth axis is the span's own right, so the box stays right-handed
        // on either side of the road.
        box(P, (p.x + q.x) / 2 - p.ox * 0.11, (p.y + q.y) / 2 + h, (p.z + q.z) / 2 - p.oz * 0.11,
          ax, az, -az, ax, L / 2 + 0.06, 0.07, 0.025, TIMBER, 0.8 + rng() * 0.3, dy / L);
      }
    }
  }

  /** `{ steel, wood }` geometries, null where empty. */
  finish() {
    const out = {};
    for (const [k, P] of Object.entries(this.parts)) {
      if (!P.pos.length) { out[k] = null; continue; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(P.nor, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(P.col, 3));
      g.setIndex(P.idx);
      g.computeBoundingSphere();
      out[k] = g;
    }
    return out;
  }
}

const blank = () => ({ pos: [], nor: [], col: [], idx: [] });
/** The rail's foot over a post, a spacer's depth toward the road. */
const lift = (p) => ({ x: p.x - p.ox * 0.06, y: p.y + RAIL_FOOT, z: p.z - p.oz * 0.06, ox: p.ox, oz: p.oz });

/** The profile `prof` swept straight from `a` to `b` (each `{x, y, z, ox, oz}`), flat across each facet. */
function sweep(P, a, b, prof, colour, shade) {
  // Wound so the front face looks at the road whichever side it stands on:
  // DoubleSide flips the normal on a back face, and would light it from behind.
  if ((b.x - a.x) * a.oz - (b.z - a.z) * a.ox < 0) [a, b] = [b, a];
  for (let k = 0; k + 1 < prof.length; k++) {
    const [o0, u0] = prof[k], [o1, u1] = prof[k + 1];
    // The facet's normal in (out, up), pointing at the road.
    const no = -(u1 - u0), nu = o1 - o0, nl = Math.hypot(no, nu) || 1;
    const base = P.pos.length / 3;
    for (const [e, o, u] of [[a, o0, u0], [a, o1, u1], [b, o1, u1], [b, o0, u0]]) {
      P.pos.push(e.x + e.ox * o, e.y + u, e.z + e.oz * o);
      P.nor.push(e.ox * no / nl, nu / nl, e.oz * no / nl);
      P.col.push(colour.r * shade, colour.g * shade, colour.b * shade);
    }
    P.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/**
 * A box centred at (cx, cy, cz): `ax, az` its long axis in the ground plane
 * (half-length hx), `bx, bz` its depth axis (hz), height hy; `slope` tilts the
 * long axis up by that sine (a rail spanning two posts at different heights).
 */
function box(P, cx, cy, cz, ax, az, bx, bz, hx, hy, hz, colour, shade = 1, slope = 0) {
  const c = Math.sqrt(1 - slope * slope);
  const X = [ax * c, slope, az * c], Y = [-ax * slope, c, -az * slope], Z = [bx, 0, bz];
  const faces = [[X, Y, Z, hx, hy, hz], [Y, Z, X, hy, hz, hx], [Z, X, Y, hz, hx, hy]];
  for (const [N, U, V, hn, hu, hv] of faces) {
    for (const sgn of [1, -1]) {
      const base = P.pos.length / 3;
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const u = su * sgn, v = sv;
        P.pos.push(cx + N[0] * hn * sgn + U[0] * hu * u + V[0] * hv * v,
          cy + N[1] * hn * sgn + U[1] * hu * u + V[1] * hv * v,
          cz + N[2] * hn * sgn + U[2] * hu * u + V[2] * hv * v);
        P.nor.push(N[0] * sgn, N[1] * sgn, N[2] * sgn);
        P.col.push(colour.r * shade, colour.g * shade, colour.b * shade);
      }
      P.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
}

/**
 * The barrier runs through stations `k0..k1` (indices of `B.step`-metre
 * stations): each `{ a, b, wood }`, its first and last station (which may lie
 * outside the window) and its kind. `hazard(k)` says whether station k needs
 * one; a run is held `lead` past its hazards, closes gaps under `bridge`, and
 * is dropped under `minRun`. Pure in `k`, so neighbouring windows agree.
 *
 * ponytail: walks out to a run's ends station by station (cap `B.maxRun`);
 * fine at a few dozen stations a chunk, a run table if it ever shows.
 */
export function barrierRuns(k0, k1, hazard, B, side, woodShare) {
  const lead = Math.round(B.lead / B.step), bridge = Math.round(B.bridge / B.step);
  const cap = B.maxRun ?? 600;
  const held = (k) => { for (let d = -lead; d <= lead; d++) if (hazard(k + d)) return true; return false; };
  const on = (k) => {
    if (held(k)) return true;
    let l = false, r = false;
    for (let d = 1; d <= bridge && !(l && r); d++) { l = l || held(k - d); r = r || held(k + d); }
    return l && r;
  };
  const runs = [];
  for (let k = k0; k <= k1; k++) {
    if (!on(k)) continue;
    let a = k, b = k;
    while (a > 0 && k - a < cap && on(a - 1)) a--;
    while (b - k < cap && on(b + 1)) b++;
    if ((b - a) * B.step >= B.minRun) {
      const h = hashInt(a * 0x9e3779b1 + (side > 0 ? 0x51ed : 0x2c1b)) / 4294967296;
      runs.push({ a, b, wood: h < woodShare });
    }
    k = b;
  }
  return runs;
}
