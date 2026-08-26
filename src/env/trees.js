/**
 * env/trees.js — the canopy, built from faceted solids.
 *
 * This module owns what a tree IS. Where trees go is `chunks.js`'s job and
 * which species belong where is `foliage.js`'s, the same split every other
 * generator in this directory uses. The primitives are `env/lowpoly.js`'s.
 *
 * ── the look, and what it replaced ──────────────────────────────────────────
 *
 * Stylised low-poly, from the reference art in `style_examples/`: a tapered
 * faceted stem carrying either a cluster of big warped lumps or a stack of
 * jagged conical skirts, flat-shaded, in saturated flat colours with visible
 * facet-to-facet variation. There are no leaves in it anywhere.
 *
 * What it replaced was a grown branch skeleton with alpha-cutout leaf cards
 * hung on the tips, and a four-triangle painted billboard standing in past
 * 260 m. That was a coherent design for a naturalistic canopy and it is the
 * wrong object for this one. Three things went with it:
 *
 *   THE ATLASES. Two 512 canvases, a hand-tuned mip gutter, and a whole class
 *   of bug about which cell a UV lands in. A faceted solid has no UVs at all.
 *   THE CUTOUT. `alphaTest`, `alphaToCoverage` and `DoubleSide` are gone;
 *   the material is opaque and culls its own back faces.
 *   THE BILLBOARD. The far tier is now the SAME BUILDER at a lower
 *   subdivision — same envelope, same colours, same proportions — so the
 *   handover has nothing left to disagree about. The reported symptom was
 *   distant trees looking "very out of place" and shrinking as near ones grew;
 *   that was two different pictures of one tree, and there is now one.
 *
 * ── how one is built ────────────────────────────────────────────────────────
 *
 * No recursion and no growth simulation. The old file grew a branch skeleton
 * because leaf cards need somewhere to hang; nothing hangs off anything here,
 * so the tree is DESCRIBED rather than grown:
 *
 *   STEM     a polyline from the ground with `bend` and `lean`, swept as a
 *            tapering n-gon with a flared base. 5 or 6 sides — few enough that
 *            the facets are visible, which is the point.
 *   CROWN    'tier'  M jagged skirts up the stem   (pine, spruce)
 *            'blob'  N warped lumps in an envelope (everything broadleaf)
 *            'bare'  nothing                       (dead)
 *   LIMBS    for blob crowns, one branch reaching from the stem to each lump's
 *            centre. That is what the reference art does and it is why the
 *            crown reads as carried rather than balanced.
 *
 * Everything is built in units where the tree is about one high, then
 * normalised exactly: unit tall, standing on y = 0, so `chunks.js` scales by a
 * height in metres and nothing else.
 *
 * ── budget ──────────────────────────────────────────────────────────────────
 *
 * Interior culling does the heavy lifting — see `lowpoly.js:blob`. A crown of
 * six overlapping lumps loses a third of its faces to being inside its
 * neighbours, and a conifer is nearly free because a skirt is one fan.
 *
 *   near tree   ~110-330 triangles depending on species
 *   far tree    ~25-45   triangles, same silhouette
 *   library     8 species x TREES.variants x 2 tiers, built once at boot
 *
 * `probe/props.mjs` prints the measured figures per species and checks the
 * in-view total against the terrain sheet.
 */

import * as THREE from 'three';
import { TREES } from '../config.js';
import { TREE_FORMS } from '../foliage.js';
import { rng } from './textures.js';
import { Facets, blob, makeWarp, tube, tier, triangleCount } from './lowpoly.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* --------------------------------------------------------------- colours -- */

/**
 * A crown face's colour.
 *
 * Two things vary and both are deliberate. The MIX between the palette's main
 * and alt hue runs with how far up the crown the face sits and how far it
 * faces the sky, which is the gradient every one of the reference images has:
 * lit on top, saturated underneath. The JITTER is per face and small, and it is
 * what stops a lump reading as a single smooth object with creases drawn on it.
 */
function crownShader(pal, jitter) {
  const [main, alt] = pal;
  return (ny, height, j) => {
    const up = ny * 0.5 + 0.5;
    const mix = clamp01(up * 0.72 + height * 0.42 - 0.10);
    const shade = 0.90 + up * 0.20 + (j - 0.5) * jitter;
    return [
      clamp01(lerp(main[0], alt[0], mix) * shade),
      clamp01(lerp(main[1], alt[1], mix) * shade),
      clamp01(lerp(main[2], alt[2], mix) * shade),
    ];
  };
}

/**
 * Bark. A vertical gradient only — dark at the root, which is ambient occlusion
 * a wood really does have — plus a whisper of per-facet jitter.
 *
 * NOT the crown's per-face jitter: a trunk is five facets around, and colour
 * noise at that count reads as a corrupt buffer rather than as wood.
 */
function barkShader(bark, jitter) {
  return (t, k) => {
    const shade = 0.68 + 0.44 * t + ((k * 7.13) % 1 - 0.5) * jitter * 0.4;
    return [
      clamp01(bark[0] * shade),
      clamp01(bark[1] * shade),
      clamp01(bark[2] * shade),
    ];
  };
}

/* ------------------------------------------------------------ the shapes -- */

/**
 * The stem as a polyline, base to tip.
 *
 * `bend` curves it in one direction and `lean` displaces the tip; together they
 * are the difference between the reference art's straight conifers and its
 * hand-drawn-looking broadleaves, and they cost four numbers instead of the
 * gnarl-per-section simulation they replace.
 *
 * The base is FLARED rather than skirted: the radius multiplier falls off over
 * the bottom fifth, quadratically, so the widening is at the very foot. That is
 * the whole of why a trunk looks planted rather than pushed in like a pin.
 */
function stemNodes(t, top, rnd) {
  const dir = rnd() * Math.PI * 2;
  const bx = Math.cos(dir), bz = Math.sin(dir);
  const nodes = [];
  const SEGS = 4;
  for (let i = 0; i <= SEGS; i++) {
    const u = i / SEGS;
    const fl = 1 + (t.flare - 1) * Math.pow(Math.max(0, 1 - u * 5), 2);
    // `bend` is a quadratic bow; `lean` is linear. A bow with no lean is a
    // banana and a lean with no bow is a leaning post.
    const off = (t.bend * u * (1 - u) * 2 + t.lean * u) * top;
    nodes.push({
      x: bx * off,
      y: u * top,
      z: bz * off,
      r: t.radius * lerp(1, t.taper, u) * fl,
    });
  }
  return { nodes, bx, bz };
}

/** Where the stem is at height fraction `u`, by walking the polyline. */
function alongStem(nodes, u) {
  const top = nodes[nodes.length - 1].y;
  const y = clamp01(u) * top;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i].y >= y || i === nodes.length - 1) {
      const a = nodes[i - 1], b = nodes[i];
      const f = b.y > a.y ? (y - a.y) / (b.y - a.y) : 0;
      return { x: lerp(a.x, b.x, f), y, z: lerp(a.z, b.z, f), r: lerp(a.r, b.r, f) };
    }
  }
  return nodes[nodes.length - 1];
}

/**
 * Lump centres and radii, before any of them is turned into triangles.
 *
 * PLANNED FIRST, EMITTED SECOND, and that ordering is the whole reason the
 * interior culling is symmetric: every lump can be hidden by every other one,
 * including the ones that come after it. Emitting as it goes would only ever
 * let a lump be hidden by its predecessors, which leaves the last lump placed
 * carrying a full sphere of faces buried in the middle of the crown.
 *
 * The centres are a golden-angle spiral through the envelope rather than random
 * points: random points clump, and a clumped crown has a lopsided silhouette
 * that reads as a mistake rather than as character.
 */
function planBlobs(cfg, count, grow, rnd) {
  const plans = [];
  const [sx, sy, sz] = cfg.spread;
  for (let i = 0; i < count; i++) {
    // The first lump is the core, on the axis. Everything after it goes out on
    // the spiral, so a two-lump far tier is a core plus one shoulder and still
    // reads as the same tree.
    const t = count > 1 ? i / (count - 1) : 0;
    const ang = i * 2.39996 + rnd() * 0.5;
    const rad = i === 0 ? 0 : Math.sqrt(t) * (0.7 + rnd() * 0.5);
    const up = i === 0 ? cfg.lift * 0.5 : (rnd() * 2 - 1) * 0.9 + cfg.lift;
    const size = lerp(cfg.size[1], cfg.size[0], t * (0.6 + rnd() * 0.6)) * grow;
    plans.push({
      c: [Math.cos(ang) * rad * sx, cfg.centre + up * sy, Math.sin(ang) * rad * sz],
      r: [size, size * cfg.squash, size],
      warp: makeWarp(rnd, cfg.warp),
    });
  }
  return plans;
}

/* ---------------------------------------------------------------- a tree -- */

/**
 * Builds one tree.
 *
 * @param {object} form  a `TREE_FORMS` entry
 * @param {number} seed
 * @param {number} variant  which palette to bake in
 * @param {boolean} far     build the cheap tier instead of the near one
 * @returns {{geometry: THREE.BufferGeometry, height: number, radius: number}}
 *          normalised: standing on y = 0, exactly one unit tall.
 */
export function growTree(form, seed, variant = 0, far = false) {
  const rnd = rng(seed);
  const F = new Facets();
  const lod = form.lod || {};
  const pal = form.palettes[variant % form.palettes.length];
  const crown = crownShader(pal, TREES.faceJitter);
  const bark = barkShader(form.bark, TREES.faceJitter);

  // Quadratic in height, with a floor: the root is pinned and a limb reaching
  // sideways low down still shivers. One function for the whole tree, so the
  // stem and the crown it carries never disagree about where the wind is.
  const sway = (y) => clamp01(y * y * 0.92 + 0.06);

  const t = form.trunk;
  const sides = far ? (lod.trunkSides || 3) : t.sides;
  // A conifer's stem has to clear its lowest skirt, or the tree is standing on
  // a pole nobody can see; a broadleaf's is exactly what the table says.
  const stemTop = form.crown === 'tier'
    ? Math.max(t.height, form.tiers.from + 0.06)
    : t.height;
  const { nodes } = stemNodes(t, stemTop, rnd);
  tube(F, nodes, sides, bark, sway);

  if (form.crown === 'tier') {
    const cfg = form.tiers;
    const count = far ? (lod.tiers || cfg.count) : cfg.count;
    const skirtSides = far ? (lod.sides || 6) : cfg.sides;
    const step = (cfg.to - cfg.from) / count;
    for (let i = 0; i < count; i++) {
      const u = cfg.from + step * i;
      const at = alongStem(nodes, u / stemTop);
      const k = count > 1 ? i / (count - 1) : 0;
      tier(F, {
        cx: at.x, cz: at.z, y: u,
        radius: lerp(cfg.radius[0], cfg.radius[1], k),
        height: step * cfg.height,
        sides: skirtSides,
        droop: cfg.droop, jag: cfg.jag, phase: i * 0.7, rnd,
        // The lowest skirt is the only one with nothing under it.
        floor: i === 0,
        colour: (around, facing, j) => crown(facing > 0 ? 0.55 : -0.6, k, j),
        sway,
      });
    }
  } else if (form.crown === 'blob') {
    const cfg = form.blobs;
    const count = far ? (lod.blobs || 2) : cfg.count;
    // Fewer lumps have to be bigger or the far crown is a smaller tree, and the
    // fade would then be a visible shrink — which is the exact complaint this
    // rewrite exists to answer. The exponent is under a half because the lumps
    // overlap, so covered volume grows faster than the count does.
    const grow = far ? Math.pow(cfg.count / count, TREES.lodGrow) : 1;
    const plans = planBlobs(cfg, count, grow, rnd);

    // Limbs first, so the lumps can cull them: a branch that ends inside a
    // crown is mostly inside that crown.
    if (form.limbs && !far) {
      const L = form.limbs;
      for (let i = 0; i < L.count; i++) {
        const u = lerp(L.from, L.to, L.count > 1 ? i / (L.count - 1) : 0.5);
        const at = alongStem(nodes, u);
        limbFrom(F, [at.x, at.y, at.z], at.r * L.radius,
          plans[i % plans.length].c, L.sides, bark, sway, L.rise, rnd);
      }
    }

    const span = Math.max(1e-4, cfg.spread[1] * 2);
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      const h = clamp01(0.5 + (p.c[1] - cfg.centre) / span);
      blob(F, {
        c: p.c, r: p.r,
        detail: far ? (lod.detail || 0) : cfg.detail,
        warpFn: p.warp, rnd,
        sway: (x, y) => sway(y),
        hide: plans.filter((q) => q !== p),
        colour: (nx, ny, nz, j) => crown(ny, h, j),
      });
    }
  } else if (form.limbs) {
    // Bare. The limbs fork, because an armature with no second generation is a
    // fence post with pegs in it.
    const L = form.limbs;
    for (let i = 0; i < L.count; i++) {
      const u = lerp(L.from, L.to, L.count > 1 ? i / (L.count - 1) : 0.5);
      const ang = i * 2.39996 + rnd() * 0.8;
      const at = alongStem(nodes, u);
      const len = L.length * (0.6 + rnd() * 0.8);
      const tip = [
        at.x + Math.cos(ang) * Math.sin(L.angle) * len,
        at.y + Math.cos(L.angle) * len + len * L.rise * 0.4,
        at.z + Math.sin(ang) * Math.sin(L.angle) * len,
      ];
      const r0 = at.r * L.radius;
      limbFrom(F, [at.x, at.y, at.z], r0, tip, L.sides, bark, sway, L.rise, rnd);
      if (far) continue;
      for (let k = 0; k < (L.fork || 0); k++) {
        const a2 = ang + (k - 0.5) * 1.3 + (rnd() - 0.5) * 0.7;
        limbFrom(F, tip, r0 * 0.38, [
          tip[0] + Math.cos(a2) * len * 0.5,
          tip[1] + len * (0.3 + rnd() * 0.5),
          tip[2] + Math.sin(a2) * len * 0.5,
        ], L.sides, bark, sway, L.rise, rnd);
      }
    }
  }

  return normalise(F.build());
}

/**
 * One branch: a three-node tube from the stem surface to a target point, bowed
 * upward on the way — which is the shape every branch in the reference art has,
 * and it is one lerp rather than a growth loop.
 */
function limbFrom(F, from, r0, to, sides, bark, sway, rise = 0.5, rnd = null) {
  const reach = Math.hypot(to[0] - from[0], to[2] - from[2]);
  const mid = [
    (from[0] + to[0]) * 0.5,
    (from[1] + to[1]) * 0.5 + reach * rise * 0.35,
    (from[2] + to[2]) * 0.5,
  ];
  if (rnd) {
    mid[0] += (rnd() - 0.5) * r0 * 2;
    mid[2] += (rnd() - 0.5) * r0 * 2;
  }
  tube(F, [
    { x: from[0], y: from[1], z: from[2], r: r0 },
    { x: mid[0], y: mid[1], z: mid[2], r: r0 * 0.68 },
    { x: to[0], y: to[1], z: to[2], r: r0 * 0.38 },
  ], sides, bark, sway);
}

/**
 * Unit tall, standing on y = 0, and the crown half-width that goes with it.
 *
 * The clamp comes FIRST. A drooping skirt or a low lump can reach under the
 * root, and the anchor a tree is planted by is its trunk base — so aligning the
 * bounding box instead would lift the whole tree by however far its foliage
 * hung, which is what used to float a spruce a metre and a half. Bug #68.
 */
function normalise(geo) {
  const pos = geo.getAttribute('position');
  const arr = pos.array;
  for (let i = 1; i < arr.length; i += 3) if (arr[i] < 0) arr[i] = 0;
  pos.needsUpdate = true;

  geo.computeBoundingBox();
  const h = Math.max(1e-3, geo.boundingBox.max.y);
  const spanX = geo.boundingBox.max.x - geo.boundingBox.min.x;
  const spanZ = geo.boundingBox.max.z - geo.boundingBox.min.z;
  geo.scale(1 / h, 1 / h, 1 / h);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  // Read off the PRE-scale spans held above as numbers. `computeBoundingBox`
  // writes into the existing Box3 in place, so a reference taken before the
  // call is silently the post-scale box — which is already divided by `h`, and
  // dividing again halved every crown radius. Bug #69.
  return { geometry: geo, height: 1, radius: Math.max(spanX, spanZ) / (2 * h) };
}

/**
 * Squeezes a far tree sideways until it is exactly as wide as its near twin.
 *
 * Both tiers are normalised to unit HEIGHT, so height already agrees to the
 * bit. Width does not: a far crown is two lumps where a near one is five, and
 * `TREES.lodGrow` can only be one exponent for a table containing both a dome
 * and a column — measured before this, a poplar's far tier came out 45% wider
 * than its near tier and a dead tree 35% narrower. Either way the cross-fade is
 * a visible change of size, which is the complaint the whole rewrite answers.
 *
 * One number per proto removes the whole class of problem, and it is exact by
 * construction rather than by tuning. The clamp is a guard, not a tolerance: if
 * a form ever lands outside it, the geometry is wrong and squashing it flat
 * would only hide that.
 *
 * The NORMALS are transformed too. Under a scale of (k, 1, k) the correct
 * normal transform is the inverse transpose, (1/k, 1, 1/k) — skipping it leaves
 * every slanted facet lit for a shape the tree no longer is.
 */
function matchWidth(proto, target) {
  const k = Math.min(1.6, Math.max(0.6, target / Math.max(1e-4, proto.radius)));
  if (Math.abs(k - 1) < 0.02) return proto;
  const geo = proto.geometry;
  geo.scale(k, 1, k);
  const n = geo.getAttribute('normal').array;
  for (let i = 0; i < n.length; i += 3) {
    const x = n[i] / k, y = n[i + 1], z = n[i + 2] / k;
    const l = Math.hypot(x, y, z) || 1;
    n[i] = x / l; n[i + 1] = y / l; n[i + 2] = z / l;
  }
  geo.getAttribute('normal').needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  proto.radius *= k;
  return proto;
}

/* ---------------------------------------------------------- the material -- */

/**
 * One tier's material. Untextured, opaque, flat-shaded by construction.
 *
 * Deliberately the same shape as `env/grass.js`'s, down to the shared program
 * cache key: near trees, far trees and every bush compile to ONE program,
 * because the fade window is a uniform rather than a `#define` and the only
 * thing that differs between them is numbers.
 *
 * `flatShading` is NOT set, and that is not an oversight. The geometry is
 * non-indexed with a baked per-face normal and a baked per-face colour, so the
 * facets are already hard and three would only recompute normals it already
 * has — while leaving the colour smooth, which is half the look gone.
 */
export function foliageMaterial(fadeOut, fadeIn, opts = {}) {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    // Opaque and single-sided. The cutout the leaf cards needed is gone with
    // them, and so is the doubled fragment cost of DoubleSide.
    side: THREE.FrontSide,
    roughness: 0.88,
    metalness: 0.0,
  });

  const uniforms = {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2(TREES.windDir.x, TREES.windDir.z).normalize() },
    uWindStrength: { value: opts.windStrength ?? TREES.windStrength },
    uWindSpeed: { value: opts.windSpeed ?? TREES.windSpeed },
    uFade: { value: new THREE.Vector2(fadeOut[0], fadeOut[1]) },
    uFadeIn: { value: new THREE.Vector2(fadeIn ? fadeIn[0] : -2, fadeIn ? fadeIn[1] : -1) },
    uFadeLone: { value: new THREE.Vector2(TREES.loneFadeIn[0], TREES.loneFadeIn[1]) },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute float aSway;
        // 1 on a far tree with no near mesh behind it. See TREES.loneFadeIn and
        // chunks.js:_buildProps — those instances take a much later fade-in,
        // because there is nothing to hand over TO.
        //
        // Instanced, and absent from the near tier's geometry entirely: an
        // attribute three does not enable reads as 0, which is exactly the
        // paired behaviour. Both tiers share one compiled program (see
        // customProgramCacheKey), so this could not have been a #define.
        attribute float aLone;
        varying float vSway;
        uniform float uTime;
        uniform vec2  uWind;
        uniform float uWindStrength;
        uniform float uWindSpeed;
        uniform vec2  uFade;
        uniform vec2  uFadeIn;
        uniform vec2  uFadeLone;
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
        vec2 fr_in = mix( uFadeIn, uFadeLone, step( 0.5, aLone ) );
        float fr_fade = smoothstep( fr_in.x, fr_in.y, fr_d )
                      * ( 1.0 - smoothstep( uFade.x, uFade.y, fr_d ) );
        // Shrink about the base, so a tree sinks into the ground rather than
        // popping. Uniform, so the winding — and therefore the back-face
        // culling this material now relies on — survives it.
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
 * `TREES.variants` of each species, each from its own seed AND its own palette.
 * The variant count is a DRAW CALL decision as much as a look one —
 * `chunks.js` runs an InstancedMesh per (chunk, geometry), so a chunk commits
 * to one variant per species and neighbouring chunks pick different ones.
 * Three is enough that a stand does not read as a copy-paste, and because the
 * palettes are per variant it is also three seasons of maple.
 *
 * @returns the `src/env/` bundle, plus two `Map`s of species -> variant protos
 *          in the shape `chunks.js` expects: `{ geometry, height, radius }`.
 */
export function createTreeAssets() {
  const names = Object.keys(TREE_FORMS);

  /** species -> [{ geometry, height, radius }], near tier. */
  const library = new Map();
  /** species -> [...], far tier: same silhouette, a fifth of the faces. */
  const far = new Map();
  let nearTris = 0, farTris = 0, count = 0;

  names.forEach((name, si) => {
    const form = TREE_FORMS[name];
    const near = [];
    const cheap = [];
    for (let v = 0; v < TREES.variants; v++) {
      // Seeded from the species index and the variant, never from the world
      // seed: every player sees the same trees, and a reload does not reshuffle
      // the forest's vocabulary underneath the placement that chose from it.
      // BOTH TIERS TAKE THE SAME SEED, so a far tree's lumps sit where the near
      // one's do and the cross-fade has nothing left to slide.
      const seed = (0x7ee5 + si * 131 + v * 7919) >>> 0;
      const a = growTree(form, seed, v, false);
      const b = matchWidth(growTree(form, seed, v, true), a.radius);
      nearTris += triangleCount(a.geometry);
      farTris += triangleCount(b.geometry);
      count++;
      near.push(a);
      cheap.push(b);
    }
    library.set(name, near);
    far.set(name, cheap);
  });

  const nearMat = foliageMaterial([TREES.lodFade[0], TREES.lodFade[1]], null);
  const farMat = foliageMaterial(TREES.farFade, TREES.farFadeIn, {
    // A distant canopy that swings as hard as a near one reads as a gale. The
    // motion is also four pixels wide out there, so nothing is lost by damping.
    windStrength: TREES.windStrength * 0.45,
  });

  return {
    library,
    far,
    material: nearMat.material,
    farMaterial: farMat.material,
    /**
     * The live uniform objects behind both materials.
     *
     * `setTime` already reaches into them; exposing them costs nothing and buys
     * the one thing that cannot be done from outside — `probe/canopy.mjs`
     * neutralises the distance fade so it can photograph the two tiers at true
     * size and side by side, which is the only way to see that they are the
     * same tree.
     */
    uniforms: { near: nearMat.uniforms, far: farMat.uniforms },
    /** Mean triangles per tree in each tier, for the budget lines in the probes. */
    trianglesPerTree: nearTris / Math.max(1, count),
    trianglesPerFarTree: farTris / Math.max(1, count),
    setTime(t) {
      nearMat.uniforms.uTime.value = t;
      farMat.uniforms.uTime.value = t;
    },
    dispose() {
      for (const vs of library.values()) for (const v of vs) v.geometry.dispose();
      for (const vs of far.values()) for (const v of vs) v.geometry.dispose();
      nearMat.material.dispose();
      farMat.material.dispose();
    },
  };
}
