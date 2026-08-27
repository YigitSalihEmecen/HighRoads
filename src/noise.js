/**
 * noise.js — the terrain height field.
 *
 * A chain of stages produces the field and its analytic derivatives. Each
 * stage corrects a failure of the input.
 */

import { alea, clamp, lerp, smoothstep } from './util.js';

/* ------------------------------------------------------- gradient noise -- */

const GRAD = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071],
];

// Quintic interpolation (6t^5 − 15t^4 + 10t^3): second derivative continuous,
// so derivative damping does not pick up a crease at every lattice line.
function makeGradNoise(random) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

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

  // Scratch shared by a few hundred thousand evaluations per chunk: no
  // allocation allowed here.
  const t0 = [0, 0, 0], t1 = [0, 0, 0], t2 = [0, 0, 0];

  // Octave budget for the current sample. The grid is dense on the carriageway
  // and ~55 m apart at the fog line, so sampling a 7 m base octave out there
  // aliases into the pointy facets on far hillsides. Budget tracks how finely
  // the mesh can resolve; the last octave fades rather than drops, or the far
  // field pops as the player drives; normalisation uses only octaves taken.
  let lodOct = 99;

  function lodAmp(i) {
    return lodOct >= 99 ? 1 : clamp(lodOct - i, 0, 1);
  }

  /** Plain fBm. For masks and fields that are not landforms. */
  function fbm(noise, x, y, freq, oct, gain) {
    let a = 0, amp = 1, f = freq, norm = 0;
    for (let i = 0; i < oct; i++) {
      const w = amp * lodAmp(i);
      if (w <= 0) break;
      a += w * noise(x * f, y * f, t0)[0];
      norm += w;
      amp *= gain;
      f *= 2;
    }
    return norm > 0 ? a / norm : 0;
  }

  // Derivative-damped fBm — the erosion term: a += amp·n / (1 + k·|Sum d|²).
  // Octaves land at full strength on flat ground, suppressed where the summed
  // gradient is already steep — crisp ridges, smooth valley floors. The
  // derivative accumulates UNSCALED: scaled by frequency, |Sum d|² grows 4^oct,
  // damping to ~0.01 by the seventh octave, erasing the ridge detail.
  function erodedFbm(noise, x, y, freq, oct, gain, damp) {
    let a = 0, amp = 1, f = freq, norm = 0, dx = 0, dy = 0;
    for (let i = 0; i < oct; i++) {
      const w = amp * lodAmp(i);
      if (w <= 0) break;
      noise(x * f, y * f, t1);
      a += (w * t1[0]) / (1 + damp * (dx * dx + dy * dy));
      dx += t1[1];
      dy += t1[2];
      norm += w;
      amp *= gain;
      f *= 2;
    }
    return norm > 0 ? a / norm : 0;
  }

  // Ridged: |n| folded and squared, crests sharpened, troughs rounded. The fold
  // is SOFTENED (sqrt(n² + e)): 1 − |n| has a genuine C1 corner at every zero
  // crossing, per octave at every scale — knife ridges no mesh resolution fixes.
  const RIDGE_SOFT = 0.004;
  function ridgedFbm(noise, x, y, freq, oct, gain, damp) {
    let a = 0, amp = 1, f = freq, norm = 0, dx = 0, dy = 0;
    for (let i = 0; i < oct; i++) {
      const w = amp * lodAmp(i);
      if (w <= 0) break;
      noise(x * f, y * f, t2);
      const n = t2[0];
      const r = 1 - Math.sqrt(n * n + RIDGE_SOFT);
      a += (w * r * r) / (1 + damp * (dx * dx + dy * dy));
      dx += t2[1];
      dy += t2[2];
      norm += w;
      amp *= gain;
      f *= 2;
    }
    return norm > 0 ? (a / norm) * 2 - 1 : -1;
  }

  // One warp level is enough here: the second level of Quilez's recipe mostly
  // buys detail the mesh cannot resolve.
  const warp = { x: 0, y: 0 };
  function domainWarp(x, y, amount, freq) {
    warp.x = x + fbm(nW, x + 137.2, y - 41.7, freq, 3, 0.5) * amount;
    warp.y = y + fbm(nW, x - 88.4, y + 219.6, freq, 3, 0.5) * amount;
    return warp;
  }

  /* --------------------------------------------------------- archetypes -- */

  const W = { plains: 0, hills: 0, valley: 0, mountain: 0, canyon: 0, plateau: 0 };

  // Two very-low-frequency fields index a 2D archetype space, not one scalar:
  // a single dial can only ever give one ordering of biomes.
  // Centres sit evenly on a circle so no archetype is structurally favoured by
  // being nearer the origin of a field that lingers there.
  const NAMES = ['plains', 'hills', 'valley', 'mountain', 'canyon', 'plateau'];
  const CENTRES = NAMES.map((name, i) => {
    const a = (i / NAMES.length) * Math.PI * 2 + 0.4;
    return [name, Math.cos(a) * 0.52, Math.sin(a) * 0.52];
  });

  // Kernel width: small enough the nearest archetype dominates. At ~0.30 the
  // winner held ~0.66 of the blend and its neighbours a fifth each — an
  // averaging acting exactly like turning amplitude down (the world read as
  // "everything, mildly"). At 0.245 the winner holds ~0.80.
  const SIGMA2 = 2 * 0.245 * 0.245;

  function archetypes(x, y) {
    // ~7 km / ~4.5 km wavelengths: an archetype lasts enough driving to establish
    // itself. fBm clusters near zero, so the field is stretched to reach the
    // ring, or the outer archetypes almost never win.
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
    return erodedFbm(nA, x, y, 0.0014, 6, 0.52, 0.40) * 105;
  }

  // Valley system: a ridged field INVERTED so crests become troughs — connected
  // V-shaped valleys with rising shoulders, the shape a road naturally wants.
  function valleyH(x, y) {
    const trough = ridgedFbm(nB, x, y, 0.0011, 5, 0.5, 0.30);
    const floor = -60 + erodedFbm(nA, x, y, 0.0022, 3, 0.5, 0.30) * 16;
    return floor + (1 - trough) * 128;
  }

  // Mountains — where the vertical scale is set. Old relief topped out ~300 m: a
  // 12-degree swell, read as a big hill. Now 620 m of ridge over 150 m bulk,
  // topping >1 km with the continental term underneath. Squaring the ridged
  // field before scaling pushes most of a region to flank and valley — a linear
  // map spends the height budget on the middle. Damping must not erase it: at
  // the old value the gradient had suppressed everything past the 3rd octave,
  // removing exactly the local slope frequencies.
  function mountainH(x, y) {
    const ridge = ridgedFbm(nB, x, y, 0.00082, 7, 0.5, 0.42) * 0.5 + 0.5;
    const bulk = erodedFbm(nA, x, y, 0.0006, 4, 0.5, 0.35);
    const peaked = ridge * ridge * (3 - 2 * ridge);   // smoothstep, cheap
    return bulk * 150 + peaked * 620;
  }

  // Canyon: a high tableland incised by steep gorges; the smoothstep makes the
  // walls near-vertical while rim and floor stay flat.
  function canyonH(x, y) {
    const r = ridgedFbm(nC, x, y, 0.0011, 4, 0.5, 0.28) * 0.5 + 0.5;
    // Gorge band widened from 0.32..0.60: a 128 m drop in that narrow band
    // landed as near-vertical facets whose normals flipped between columns —
    // the dark jagged wall band.
    const gorge = smoothstep(0.26, 0.68, r);
    const rim = erodedFbm(nA, x, y, 0.0019, 3, 0.5, 0.3) * 18;
    return 48 + rim - (1 - gorge) * 128;
  }

  // Plateau: terraces with eroded escarpments. The staircase is built from
  // smoothsteps, not a floor() blend — the latter leaves a corner wherever the
  // blend weight and the sawtooth meet, one per terrace, C1 everywhere instead.
  function plateauH(x, y) {
    const b = erodedFbm(nA, x, y, 0.0013, 4, 0.5, 0.38);
    const steps = 3;
    const t = b * steps;
    const base = Math.floor(t);
    const frac = t - base;
    // Riser occupies the middle 40% of each tread; the rest is flat.
    const terraced = (base + smoothstep(0.3, 0.7, frac)) / steps;
    return terraced * 135 + 18;
  }

  /* -------------------------------------------------------- continental -- */

  // The elevation the whole map sits on. Every archetype is a mean, and the
  // blend has a mean too, so any climb is eventually paid back by a descent.
  // Real topography has TWO scales: landforms sit on a continental surface far
  // longer than anything visible from the ground — you perceive it as "been
  // climbing for twenty minutes". Two octaves at 11 / 5.5 km.
  //
  // Wavelength set against how far the road actually TRAVELS (a routed
  // alignment covers ~0.4 m of map per metre of tarmac): at 19 km a session
  // barely turns over (106 m rise across 18 km); at 11 km the same drive gains
  // 123–348 m, with 100–180 m over sustained 3–5 km climbs.
  //
  // Amplitude bounded by the road's grade: 340 m over a 5.5 km half-cycle is a
  // ~6% mean against ROAD.maxGrade 9.5%; past that the router saturates and
  // extra height buys earthwork, not scenery.
  //
  // erodedFbm, not plain fBm: its damping flattens already-steep ground into
  // long shallow benches separated by sustained climbs — plateau country, not
  // a rolling sine. Evaluated at FULL octave depth, always: fading fine
  // octaves here would be metres of height shifting between columns 55 m apart
  // (and km-length wavelengths have nothing to alias anyway).
  const CONTINENT_AMP = 340;
  function continent(x, y) {
    const keep = lodOct;
    lodOct = 99;
    const h = erodedFbm(nA, x + 4211.7, y - 1877.3, 0.00009, 2, 0.55, 0.22);
    lodOct = keep;
    return h * CONTINENT_AMP;
  }

  /* -------------------------------------------------------------- fields -- */

  // The large-scale surface before road detail; the one path every height sample
  // (road alignment, mesh, props) takes, so they can never disagree.
  function base(x, z, octaves = 99) {
    lodOct = octaves;
    const p = domainWarp(x, z, 130, 0.0006);
    const wx = p.x, wy = p.y;
    const w = archetypes(x, z);

    const h = (
      w.plains * plainsH(wx, wy) +
      w.hills * hillsH(wx, wy) +
      w.valley * valleyH(wx, wy) +
      w.mountain * mountainH(wx, wy) +
      w.canyon * canyonH(wx, wy) +
      w.plateau * plateauH(wx, wy)
    ) + continent(x, z);
    lodOct = 99;
    return h;
  }

  // Full terrain height. `lateral` gates the detail octaves at both ends: quiet
  // on the graded verge (a steep face every 30 m launches a car) and where the
  // mesh columns are 55 m apart and a short wavelength aliases into spikes.
  function height(x, z, lateral) {
    // Octave budget from the mesh's own resolution: ~2.4 m columns on and near
    // the road, 55 m at the corridor edge — eight octaves resolvable, ~3 beyond.
    const octaves = lerp(8, 3.2, smoothstep(80, 420, lateral));

    let h = base(x, z, octaves);
    const detail = 1 - smoothstep(60, 200, lateral);
    const graded = lerp(0.2, 1, smoothstep(16, 90, lateral));
    // This mid-scale roughness is ~33 m wavelength, needing <16 m columns to
    // sample honestly; it dies before the far field like the base octaves.
    const mid = 1 - smoothstep(150, 380, lateral);

    h += erodedFbm(nC, x, z, 0.0075, 3, 0.5, 0.5) * 6.2 * lerp(0.35, 1, graded) * mid;
    h += fbm(nC, x + 91.3, z - 55.1, 0.028, 2, 0.5) * 0.85 * detail * graded;
    return h;
  }

  // Averaged `base` over a disc for the road alignment: sampling a neighbourhood
  // rather than a point stops the road chasing local noise — a surveyed feel.
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

  // Forest density: two scales multiplied — stands hundreds of metres across, a
  // finer break-up within them, edges and clearings instead of a uniform block.
  function forestDensity(x, z) {
    const stand = smoothstep(-0.28, 0.42, fbm(nB, x - 812.3, z + 244.9, 0.0016, 2, 0.5));
    const broken = smoothstep(-0.55, 0.5, fbm(nC, x + 55.5, z - 120.2, 0.0068, 2, 0.5));
    return stand * lerp(0.3, 1, broken);
  }

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
    // The continental surface — "local sea level". Exposed because it is what
    // makes an altitude cue mean anything: 400 m is a summit in one region and
    // a valley floor two hundred km away; subtracting this leaves the relief
    // that snow lines, tree lines and scree are actually keyed to.
    continent,
    // Scalar accessors for colour jitter, road wear and prop seeding.
    nA: (x, z) => nA(x, z, t0)[0],
    nB: (x, z) => nB(x, z, t0)[0],
    nC: (x, z) => nC(x, z, t0)[0],
  };
}
