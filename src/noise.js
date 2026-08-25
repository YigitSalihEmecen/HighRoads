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

  /**
   * Octave budget for the sample currently being evaluated.
   *
   * The terrain grid is dense on the carriageway and sparse at the fog line —
   * lateral columns reach 55 m apart out there, against base octaves whose
   * finest wavelength is around 7 m. Sampling a 7 m feature every 55 m is
   * aliasing, and aliased gradient noise does not read as "distant detail", it
   * reads as random spikes: the pointy facets on far hillsides came from here,
   * not from the landform generators.
   *
   * So the octave count is a function of how finely the mesh can resolve the
   * result. Each fBm variant fades its last octave in and out rather than
   * dropping it, or the far field would visibly pop as the player drives.
   * Normalisation uses only the octaves actually taken, so reducing the budget
   * costs detail without costing amplitude.
   */
  let lodOct = 99;

  /** Amplitude weight for octave `i` under the current budget, 0..1. */
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
      const w = amp * lodAmp(i);
      if (w <= 0) break;
      noise(x * f, y * f, t1);
      a += (w * t1[0]) / (1 + damp * (dx * dx + dy * dy));
      // Accumulate the octave's own derivative, unscaled. Multiplying by the
      // sample frequency makes |Sum d|^2 grow as 4^octave, which drives the
      // damping to ~0.01 by the seventh octave and erases exactly the detail
      // that was supposed to survive on the ridges.
      dx += t1[1];
      dy += t1[2];
      norm += w;
      amp *= gain;
      f *= 2;
    }
    return norm > 0 ? a / norm : 0;
  }

  /**
   * Ridged: |n| folded and squared, so crests sharpen and troughs round off.
   *
   * The fold is SOFTENED. `1 - |n|` has a corner at every zero crossing of n,
   * and that corner is a genuine C1 discontinuity in the height field — one
   * per octave, at every scale, which is what produced knife-edged ridges and
   * spiky facets no amount of mesh resolution could smooth away. Replacing
   * |n| with sqrt(n² + e) rounds the crest over a band of width ~sqrt(e)
   * while leaving the flanks untouched, so a ridge still reads as a ridge and
   * still has a defined crest line — it just has a radius on it, the way an
   * eroded one does.
   */
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
   *
   * Tightened from 0.30. At that width the winning archetype held about 0.66 of
   * the blend and its two neighbours a fifth each, so a mountain region was
   * two-thirds mountain and a third something flatter — an averaging that acts
   * exactly like turning the amplitude down, and it is a large part of why the
   * world read as "everything, mildly". At 0.245 the winner holds about 0.80,
   * which is enough for a landform to be recognisably itself while the
   * transitions between them stay several hundred metres wide.
   */
  const SIGMA2 = 2 * 0.245 * 0.245;

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
    return erodedFbm(nA, x, y, 0.0014, 6, 0.52, 0.40) * 105;
  }

  /**
   * Valley system. A ridged field inverted so its crests become troughs, which
   * carves connected V-shaped valleys with rising shoulders — the shape a road
   * naturally wants to follow.
   */
  function valleyH(x, y) {
    const trough = ridgedFbm(nB, x, y, 0.0011, 5, 0.5, 0.30);
    const floor = -60 + erodedFbm(nA, x, y, 0.0022, 3, 0.5, 0.30) * 16;
    return floor + (1 - trough) * 128;
  }

  /**
   * Mountains, and this is where the world's vertical scale is actually set.
   *
   * The relief here used to top out around 300 m, which sounds like a mountain
   * and does not look like one: against a 1.4 km corridor of visible ground
   * that is a 12-degree swell, and the eye reads it as a big hill. Real ranges
   * put 1,000–1,500 m between a valley floor and a summit over the same
   * horizontal distance. This is now 620 m of ridge over a 150 m bulk, which
   * with the continental term underneath it (see `continent`) reaches summits
   * well over a kilometre above the low country.
   *
   * `ridgePow` is the other half of it. Squaring the ridged field before
   * scaling pushes the distribution toward the floor — most of a mountain
   * region is flank and valley, and only the crests reach the top of the range.
   * A linear map spends far too much of its height budget on the middle, which
   * is what makes a "mountain" look like a plateau with texture on it.
   *
   * Damping shapes the profile; it must not erase it. At the old value the
   * accumulated gradient had suppressed everything past the third octave by
   * ~90%, which removed exactly the frequencies that give a mountain its local
   * slope.
   */
  function mountainH(x, y) {
    const ridge = ridgedFbm(nB, x, y, 0.00082, 7, 0.5, 0.42) * 0.5 + 0.5;
    const bulk = erodedFbm(nA, x, y, 0.0006, 4, 0.5, 0.35);
    const peaked = ridge * ridge * (3 - 2 * ridge);   // smoothstep, cheap
    return bulk * 150 + peaked * 620;
  }

  /**
   * Canyon: a high tableland incised by steep gorges. The smoothstep on the
   * ridged field is what makes the walls near-vertical while leaving both the
   * rim and the floor flat.
   */
  function canyonH(x, y) {
    const r = ridgedFbm(nC, x, y, 0.0011, 4, 0.5, 0.28) * 0.5 + 0.5;
    // Wall width, widened from 0.32..0.60. A 128 m drop compressed into that
    // narrow a band of the ridged field lands on the mesh as a near-vertical
    // facet whose normal flips between neighbouring columns — the dark jagged
    // band across canyon walls. Spread over twice the range it is still
    // unmistakably a gorge, and every triangle in it has a sane normal.
    const gorge = smoothstep(0.26, 0.68, r);
    const rim = erodedFbm(nA, x, y, 0.0019, 3, 0.5, 0.3) * 18;
    return 48 + rim - (1 - gorge) * 128;
  }

  /**
   * Plateau: terraces with eroded escarpments between them.
   *
   * The terrace function is smooth, not quantised. `floor()` blended against
   * the raw field by a smoothstep still leaves a corner wherever the blend
   * weight and the sawtooth meet, and those corners are one per terrace across
   * the whole landform. Instead the staircase itself is built from a
   * smoothstep: flat across the tread, easing over the riser, C1 everywhere.
   */
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

  /**
   * The elevation the whole map sits on, before any landform.
   *
   * Every archetype above is a field with a MEAN. Blend six of them and the
   * result has a mean too, so however dramatic the local shape is, drive far
   * enough and the ground comes back to roughly where it started — which is
   * what "the average of everything still goes to zero" describes. A climb is
   * always eventually paid for by a descent, and the road, which follows the
   * ground, inherits exactly that: it can never simply go up for five minutes.
   *
   * Real topography does not work that way, and the reason is that it has TWO
   * scales of relief. Landforms — ridges, valleys, escarpments — sit on a
   * continental surface whose wavelength is far longer than anything you can
   * see from the ground. You do not perceive it as a hill; you perceive it as
   * having spent the last twenty minutes climbing.
   *
   * So: two octaves at 11 km and 5.5 km, +/-CONTINENT_AMP metres, added
   * underneath everything.
   *
   * The WAVELENGTH is measured against how far the road actually travels, not
   * against how far it drives. A routed alignment covers roughly 0.4 m of
   * ground per metre of tarmac — it winds — so eighteen kilometres of driving is
   * about seven kilometres of map, and a 19 km field (which is where this
   * started) barely turns over in a whole session: measured, 106 m of total
   * elevation change across 18 km of road. At 11 km the same drive crosses most
   * of a cycle and the numbers become 123 to 348 m, with sustained climbs of
   * three to five kilometres gaining 100 to 180 m and giving none of it back —
   * which is what the whole term is for.
   *
   * The AMPLITUDE is bounded by the road's grade budget. 340 m over a 5.5 km
   * half-cycle is a mean gradient near 6% against ROAD.maxGrade of 9.5%, which
   * leaves the alignment room to traverse and switchback instead of being
   * pinned to the clamp. Past that the router simply saturates and the extra
   * height buys earthwork rather than scenery.
   *
   * `erodedFbm` rather than plain fBm because its derivative damping flattens
   * the field where it is already steep, which gives long shallow benches
   * separated by sustained climbs instead of a smooth sine — the difference
   * between a plateau country and a rolling one.
   *
   * IT IS EVALUATED AT FULL OCTAVE DEPTH, ALWAYS. Everything else in this file
   * fades its finest octaves out with the mesh's lateral resolution (see
   * `lodOct`), which is right for detail and catastrophic here: at this
   * amplitude a 20% change in an octave's weight between one column and the
   * next is metres of height, and the columns out there are 55 m apart. The
   * wavelengths are kilometres, so there is nothing to alias anyway.
   */
  const CONTINENT_AMP = 340;
  function continent(x, y) {
    const keep = lodOct;
    lodOct = 99;
    const h = erodedFbm(nA, x + 4211.7, y - 1877.3, 0.00009, 2, 0.55, 0.22);
    lodOct = keep;
    return h * CONTINENT_AMP;
  }

  /* -------------------------------------------------------------- fields -- */

  /**
   * The large-scale surface, before any road detail. Everything that needs a
   * height — road alignment, terrain mesh, prop placement — comes through here,
   * so they can never disagree.
   */
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

  /**
   * Full terrain height. `lateral` is distance from the road centreline, and
   * gates the detail octaves at both ends of the range: suppressed close in,
   * because a verge is graded and because a steep face every 30 m launches a
   * car off the road; suppressed far out, because the mesh columns reach 55 m
   * apart there and a short wavelength would alias into spikes.
   */
  function height(x, z, lateral) {
    // Octave budget from the mesh's own lateral resolution: ~2.4 m columns on
    // and near the road, growing geometrically to 55 m at the corridor edge.
    // Eight octaves are resolvable close in; past ~400 m barely three are.
    const octaves = lerp(8, 3.2, smoothstep(80, 420, lateral));

    let h = base(x, z, octaves);
    const detail = 1 - smoothstep(60, 200, lateral);
    const graded = lerp(0.2, 1, smoothstep(16, 90, lateral));
    // The mid-scale roughness bottoms out around a 33 m wavelength, which needs
    // columns closer than ~16 m to sample honestly. It has to die out before
    // the far field for the same reason the base octaves do.
    const mid = 1 - smoothstep(150, 380, lateral);

    h += erodedFbm(nC, x, z, 0.0075, 3, 0.5, 0.5) * 6.2 * lerp(0.35, 1, graded) * mid;
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
    /**
     * The continental surface at (x, z) — "local sea level".
     *
     * Exposed because it is what makes an altitude cue mean anything. The
     * palette wants to know whether a place is high FOR HERE: 400 m is a summit
     * in one part of the map and a valley floor two hundred kilometres away,
     * and a colour ramp keyed to absolute height paints the second one white.
     * Subtracting this leaves the landform's own relief, which is the quantity
     * every rule about snow lines, tree lines and scree was always about.
     */
    continent,
    // Scalar accessors for colour jitter, road wear and prop seeding.
    nA: (x, z) => nA(x, z, t0)[0],
    nB: (x, z) => nB(x, z, t0)[0],
    nC: (x, z) => nC(x, z, t0)[0],
  };
}
