/**
 * noise.js — the terrain field.
 *
 * The generation chain, in order. Each stage exists because the one before it
 * has a characteristic failure:
 *
 *   1. GRADIENT NOISE WITH ANALYTIC DERIVATIVES.  Everything downstream needs
 *      the slope of the field, not just its value, so the noise returns
 *      (value, d/dx, d/dy) from one evaluation. Finite differences would cost
 *      three samples per octave for a worse answer.
 *
 *   2. DERIVATIVE-DAMPED fBm (Quilez).  Plain fBm is isotropic mush: every
 *      octave contributes equally everywhere, so hills read as noise rather
 *      than landforms. Dividing each octave by (1 + k|Sum d|^2) suppresses
 *      detail where the accumulated slope is already steep, leaving smooth
 *      valley floors and sharp ridge lines — the signature of erosion, without
 *      simulating any.
 *
 *   3. DOMAIN WARPING (Quilez).  fBm alone produces round, blobby hills whose
 *      contours betray the lattice. Displacing the sample point by another fBm
 *      before evaluation bends those contours into winding ridges and sinuous
 *      valleys.
 *
 *   4. ARCHETYPES.  A single field, however good, is uniform over kilometres.
 *      Six landform generators — plains, hills, valleys, mountains, canyon,
 *      plateau — are blended by a very low frequency field with weights summing
 *      to one, so a route runs out of open country, into a valley system, up
 *      through mountains and across a plateau.
 *
 * Sources: iquilezles.org/articles/morenoise (noise derivatives),
 * iquilezles.org/articles/warp (domain warping), iquilezles.org/articles/fbm.
 */

import { alea, clamp, lerp, smoothstep } from './util.js';

/* ------------------------------------------------------- gradient noise -- */

const GRAD = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071],
];

/**
 * 2D gradient noise returning value and both partial derivatives.
 *
 * Quintic interpolation (6t^5 - 15t^4 + 10t^3) rather than cubic: its second
 * derivative is continuous, so the damping in stage 2 — which differentiates
 * the field — does not pick up a crease at every lattice line.
 */
function makeGradNoise(random) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  /** Fills `out` with [value, d/dx, d/dy] and returns it. */
  return function noise(x, y, out) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;

    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const du = 30 * fx * fx * (fx * (fx - 2) + 1);
    const dv = 30 * fy * fy * (fy * (fy - 2) + 1);

    const xi = ix & 255, yi = iy & 255;
    const ga = GRAD[perm[xi + perm[yi]] & 7];
    const gb = GRAD[perm[xi + 1 + perm[yi]] & 7];
    const gc = GRAD[perm[xi + perm[yi + 1]] & 7];
    const gd = GRAD[perm[xi + 1 + perm[yi + 1]] & 7];

    const va = ga[0] * fx + ga[1] * fy;
    const vb = gb[0] * (fx - 1) + gb[1] * fy;
    const vc = gc[0] * fx + gc[1] * (fy - 1);
    const vd = gd[0] * (fx - 1) + gd[1] * (fy - 1);

    const k1 = vb - va;
    const k2 = vc - va;
    const k3 = va - vb - vc + vd;

    out[0] = va + u * k1 + v * k2 + u * v * k3;
    out[1] = ga[0] + u * (gb[0] - ga[0]) + v * (gc[0] - ga[0])
           + u * v * (ga[0] - gb[0] - gc[0] + gd[0]) + du * (k1 + v * k3);
    out[2] = ga[1] + u * (gb[1] - ga[1]) + v * (gc[1] - ga[1])
           + u * v * (ga[1] - gb[1] - gc[1] + gd[1]) + dv * (k2 + u * k3);
    return out;
  };
}

/* ------------------------------------------------------------------------- */

export function createTerrain(seed) {
  const nA = makeGradNoise(alea(seed + ':a'));
  const nB = makeGradNoise(alea(seed + ':b'));
  const nC = makeGradNoise(alea(seed + ':c'));
  const nW = makeGradNoise(alea(seed + ':warp'));

  // Scratch. These run a few hundred thousand times per chunk, so nothing here
  // is allowed to allocate.
  const t0 = [0, 0, 0], t1 = [0, 0, 0], t2 = [0, 0, 0];

  /** Plain fBm. For masks and fields that are not landforms. */
  function fbm(noise, x, y, freq, oct, gain) {
    let a = 0, amp = 1, f = freq, norm = 0;
    for (let i = 0; i < oct; i++) {
      a += amp * noise(x * f, y * f, t0)[0];
      norm += amp;
      amp *= gain;
      f *= 2;
    }
    return a / norm;
  }

  /**
   * Derivative-damped fBm — the erosion term.
   *
   *     a += amp * n(p*f) / (1 + k*|Sum d|^2)     d accumulates the gradient
   *
   * Octaves land at full strength on flat ground and are progressively
   * suppressed where the accumulated gradient is already steep. Ridges stay
   * crisp because their detail arrives before the slope builds; valley floors
   * come out smooth because by then the damping is strong.
   */
  function erodedFbm(noise, x, y, freq, oct, gain, damp) {
    let a = 0, amp = 1, f = freq, norm = 0, dx = 0, dy = 0;
    for (let i = 0; i < oct; i++) {
      noise(x * f, y * f, t1);
      a += (amp * t1[0]) / (1 + damp * (dx * dx + dy * dy));
      // Accumulate the octave's own derivative, unscaled. Multiplying by the
      // sample frequency makes |Sum d|^2 grow as 4^octave, which drives the
      // damping to ~0.01 by the seventh octave and erases exactly the detail
      // that was supposed to survive on the ridges.
      dx += t1[1];
      dy += t1[2];
      norm += amp;
      amp *= gain;
      f *= 2;
    }
    return a / norm;
  }

  /** Ridged: |n| folded and squared, so crests sharpen and troughs round off. */
  function ridgedFbm(noise, x, y, freq, oct, gain, damp) {
    let a = 0, amp = 1, f = freq, norm = 0, dx = 0, dy = 0;
    for (let i = 0; i < oct; i++) {
      noise(x * f, y * f, t2);
      const r = 1 - Math.abs(t2[0]);
      a += (amp * r * r) / (1 + damp * (dx * dx + dy * dy));
      dx += t2[1];
      dy += t2[2];
      norm += amp;
      amp *= gain;
      f *= 2;
    }
    return (a / norm) * 2 - 1;
  }

  /**
   * Domain warp. Bends the sample point along a low-frequency flow field before
   * the landform generators see it, turning concentric blobs into winding
   * ridges. One level is enough at this scale; the second level of Quilez's
   * recipe mostly buys detail the mesh cannot resolve.
   */
  const warp = { x: 0, y: 0 };
  function domainWarp(x, y, amount, freq) {
    warp.x = x + fbm(nW, x + 137.2, y - 41.7, freq, 3, 0.5) * amount;
    warp.y = y + fbm(nW, x - 88.4, y + 219.6, freq, 3, 0.5) * amount;
    return warp;
  }

  /* --------------------------------------------------------- archetypes -- */

  const W = { plains: 0, hills: 0, valley: 0, mountain: 0, canyon: 0, plateau: 0 };

  /**
   * Two very low frequency fields index a 2D archetype space rather than one
   * scalar. A single dial can only ever produce one ordering of biomes, so
   * every journey would climb the same ladder from plains to mountains.
   */
  // Centres sit evenly on a circle so no archetype is structurally favoured by
  // being nearer the origin of a field that spends most of its time there.
  const NAMES = ['plains', 'hills', 'valley', 'mountain', 'canyon', 'plateau'];
  const CENTRES = NAMES.map((name, i) => {
    const a = (i / NAMES.length) * Math.PI * 2 + 0.4;
    return [name, Math.cos(a) * 0.52, Math.sin(a) * 0.52];
  });

  /**
   * Kernel width. Small enough that the nearest archetype dominates — an
   * inverse-distance blend across six centres never lets any weight exceed
   * about 0.5, which silently halves every landform's amplitude and leaves the
   * whole world looking like gentle hills whatever the map says.
   */
  const SIGMA2 = 2 * 0.30 * 0.30;

  function archetypes(x, y) {
    // ~7 km and ~4.5 km wavelengths: an archetype lasts several kilometres of
    // driving — long enough to establish itself and be left behind.
    // fBm clusters near zero, so the field is stretched to actually reach the
    // ring the centres sit on. Without this the outer archetypes almost never
    // win and the world is all hills and valleys.
    const u = fbm(nA, x, y, 0.00014, 2, 0.5) * 2.1;
    const v = fbm(nB, x + 512.7, y - 311.3, 0.00022, 2, 0.5) * 2.1;

    let total = 0;
    for (let i = 0; i < CENTRES.length; i++) {
      const dx = u - CENTRES[i][1];
      const dy = v - CENTRES[i][2];
      const w = Math.exp(-(dx * dx + dy * dy) / SIGMA2);
      W[CENTRES[i][0]] = w;
      total += w;
    }
    if (total < 1e-9) { W.hills = 1; total = 1; }
    for (const k in W) W[k] /= total;
    return W;
  }

  /* ------------------------------------------------ landform generators -- */

  function plainsH(x, y) {
    return erodedFbm(nA, x, y, 0.0022, 4, 0.5, 0.30) * 11;
  }

  function hillsH(x, y) {
    return erodedFbm(nA, x, y, 0.0017, 6, 0.52, 0.40) * 66;
  }

  /**
   * Valley system. A ridged field inverted so its crests become troughs, which
   * carves connected V-shaped valleys with rising shoulders — the shape a road
   * naturally wants to follow.
   */
  function valleyH(x, y) {
    const trough = ridgedFbm(nB, x, y, 0.0013, 5, 0.5, 0.30);
    const floor = -44 + erodedFbm(nA, x, y, 0.0022, 3, 0.5, 0.30) * 12;
    return floor + (1 - trough) * 62;
  }

  function mountainH(x, y) {
    // Damping shapes the profile; it must not erase it. At the old value the
    // accumulated gradient had suppressed everything past the third octave by
    // ~90%, which removed exactly the frequencies that give a mountain its
    // local slope and left 200 m peaks reading as 2-degree swells.
    const ridge = ridgedFbm(nB, x, y, 0.0011, 7, 0.5, 0.42);
    const bulk = erodedFbm(nA, x, y, 0.0008, 4, 0.5, 0.35);
    return bulk * 74 + (ridge * 0.5 + 0.5) * 232;
  }

  /**
   * Canyon: a high tableland incised by steep gorges. The smoothstep on the
   * ridged field is what makes the walls near-vertical while leaving both the
   * rim and the floor flat.
   */
  function canyonH(x, y) {
    const r = ridgedFbm(nC, x, y, 0.0011, 4, 0.5, 0.28) * 0.5 + 0.5;
    const gorge = smoothstep(0.32, 0.6, r);
    const rim = erodedFbm(nA, x, y, 0.0019, 3, 0.5, 0.3) * 18;
    return 48 + rim - (1 - gorge) * 128;
  }

  /** Plateau: quantised terraces with eroded escarpments between them. */
  function plateauH(x, y) {
    const b = erodedFbm(nA, x, y, 0.0013, 4, 0.5, 0.38);
    const steps = 3;
    const q = Math.floor(b * steps) / steps;
    // Blend terrace against the raw field so an escarpment has a face rather
    // than a vertical wall the mesh cannot represent.
    const frac = b * steps - Math.floor(b * steps);
    const edge = smoothstep(0.12, 0.44, Math.abs(frac - 0.5) * 2);
    return lerp(b, q, edge) * 135 + 18;
  }

  /* -------------------------------------------------------------- fields -- */

  /**
   * The large-scale surface, before any road detail. Everything that needs a
   * height — road alignment, terrain mesh, prop placement — comes through here,
   * so they can never disagree.
   */
  function base(x, z) {
    const p = domainWarp(x, z, 130, 0.0006);
    const wx = p.x, wy = p.y;
    const w = archetypes(x, z);

    return (
      w.plains * plainsH(wx, wy) +
      w.hills * hillsH(wx, wy) +
      w.valley * valleyH(wx, wy) +
      w.mountain * mountainH(wx, wy) +
      w.canyon * canyonH(wx, wy) +
      w.plateau * plateauH(wx, wy)
    );
  }

  /**
   * Full terrain height. `lateral` is distance from the road centreline, and
   * gates the detail octaves at both ends of the range: suppressed close in,
   * because a verge is graded and because a steep face every 30 m launches a
   * car off the road; suppressed far out, because the mesh columns reach 55 m
   * apart there and a short wavelength would alias into spikes.
   */
  function height(x, z, lateral) {
    let h = base(x, z);
    const detail = 1 - smoothstep(60, 200, lateral);
    const graded = lerp(0.2, 1, smoothstep(16, 90, lateral));

    h += erodedFbm(nC, x, z, 0.0075, 3, 0.5, 0.5) * 6.2 * lerp(0.35, 1, graded);
    h += fbm(nC, x + 91.3, z - 55.1, 0.028, 2, 0.5) * 0.85 * detail * graded;
    return h;
  }

  /**
   * Averaged `base` over a disc, for the road alignment: sampling a
   * neighbourhood rather than a point stops the road chasing local noise and
   * gives it a surveyed feel.
   */
  function roadElevation(x, z) {
    const r = 30;
    let sum = base(x, z) * 2;
    let w = 2;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      sum += base(x + Math.cos(a) * r, z + Math.sin(a) * r);
      w += 1;
    }
    return sum / w;
  }

  /** Ruggedness, 0..1 — how mountainous this place is. Drives the species mix. */
  function region(x, z) {
    const w = archetypes(x, z);
    return clamp(w.mountain + w.canyon * 0.7 + w.plateau * 0.35, 0, 1);
  }

  /**
   * Forest density, 0..1. Two scales multiplied: stands several hundred metres
   * across, and within them a finer break-up, so a stand has edges and
   * clearings instead of being a uniform block of trees.
   */
  function forestDensity(x, z) {
    const stand = smoothstep(-0.28, 0.42, fbm(nB, x - 812.3, z + 244.9, 0.0016, 2, 0.5));
    const broken = smoothstep(-0.55, 0.5, fbm(nC, x + 55.5, z - 120.2, 0.0068, 2, 0.5));
    return stand * lerp(0.3, 1, broken);
  }

  /** Smooth spatial mask in 0..1, for anything wanting a soft field. */
  function mask(x, z, freq, ox = 0, oz = 0) {
    return fbm(nC, x + ox, z + oz, freq, 2, 0.5) * 0.5 + 0.5;
  }

  return {
    base,
    height,
    roadElevation,
    region,
    archetypes,
    forestDensity,
    mask,
    // Scalar accessors for colour jitter, road wear and prop seeding.
    nA: (x, z) => nA(x, z, t0)[0],
    nB: (x, z) => nB(x, z, t0)[0],
    nC: (x, z) => nC(x, z, t0)[0],
  };
}
