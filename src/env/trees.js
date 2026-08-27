/**
 * env/trees.js — tree forms built from faceted solids.
 *
 * A tree is described, not grown: a tapered stem carries faceted crowns or
 * conical skirts. The far tier is the same builder at lower subdivision, so
 * the tiers cannot disagree. Placement is chunks.js's job.
 */

import * as THREE from 'three';
import { TREES } from '../config.js';
import { TREE_FORMS } from '../foliage.js';
import { rng } from './textures.js';
import { Facets, blob, makeWarp, tube, tier, triangleCount } from './lowpoly.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

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

function stemNodes(t, top, rnd) {
  const dir = rnd() * Math.PI * 2;
  const bx = Math.cos(dir), bz = Math.sin(dir);
  const nodes = [];
  const SEGS = 4;
  for (let i = 0; i <= SEGS; i++) {
    const u = i / SEGS;
    const fl = 1 + (t.flare - 1) * Math.pow(Math.max(0, 1 - u * 5), 2);
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

// Cross with the axis `d` is least aligned to, so a vertical trunk has no degenerate case.
function perp(d, out) {
  const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
  let ux, uy, uz;
  if (ax <= ay && ax <= az) { ux = 1; uy = 0; uz = 0; }
  else if (ay <= az) { ux = 0; uy = 1; uz = 0; }
  else { ux = 0; uy = 0; uz = 1; }
  const x = d[1] * uz - d[2] * uy;
  const y = d[2] * ux - d[0] * uz;
  const z = d[0] * uy - d[1] * ux;
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

function branch(F, from, dir, len, radius, level, L, bark, sway, rnd, tips) {
  const rise = L.rise * (1 - level * 0.3);
  const to = [
    from[0] + dir[0] * len,
    from[1] + dir[1] * len,
    from[2] + dir[2] * len,
  ];
  const reach = Math.hypot(to[0] - from[0], to[2] - from[2]);
  const mid = [
    (from[0] + to[0]) * 0.5 + (rnd() - 0.5) * radius,
    (from[1] + to[1]) * 0.5 + reach * rise,
    (from[2] + to[2]) * 0.5 + (rnd() - 0.5) * radius,
  ];
  const tipR = radius * L.taper;
  const last = level + 1 >= L.levels;

  // Far tier walks the skeleton without emitting — the tips must match the near tier's.
  if (L.draw !== false) {
    tube(F, [
      { x: from[0], y: from[1], z: from[2], r: radius },
      { x: mid[0], y: mid[1], z: mid[2], r: radius * 0.72 },
      { x: to[0], y: to[1], z: to[2], r: tipR },
    ], L.sides, bark, sway,
    // Capped at the far end: terminal tips are buried in their lump, but a fork
    // is an open ring unless closed — `capTips` closes the no-lump species.
    !last || L.capTips ? { end: true } : null);
  }

  // Children leave along the bowed tip direction, not the launch one, or they fan out of plane.
  const td = [to[0] - mid[0], to[1] - mid[1], to[2] - mid[2]];
  const tl = Math.hypot(td[0], td[1], td[2]) || 1;
  td[0] /= tl; td[1] /= tl; td[2] /= tl;

  if (last) {
    tips.push({ p: to, dir: td, r: tipR, level });
    return;
  }

  const side = perp(td, [0, 0, 0]);
  const up = [
    td[1] * side[2] - td[2] * side[1],
    td[2] * side[0] - td[0] * side[2],
    td[0] * side[1] - td[1] * side[0],
  ];
  const roll0 = rnd() * Math.PI * 2;
  for (let i = 0; i < L.split; i++) {
    const roll = roll0 + i * 2.39996 + (rnd() - 0.5) * 0.7;
    const a = L.splitAngle * (0.7 + rnd() * 0.6);
    const ca = Math.cos(a), sa = Math.sin(a);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const d = [
      td[0] * ca + (side[0] * cr + up[0] * sr) * sa,
      td[1] * ca + (side[1] * cr + up[1] * sr) * sa,
      td[2] * ca + (side[2] * cr + up[2] * sr) * sa,
    ];
    const dl = Math.hypot(d[0], d[1], d[2]) || 1;
    d[0] /= dl; d[1] /= dl; d[2] /= dl;
    // Roots back inside the parent (1.7 tip radii); a ring on the end cap leaves an open crescent.
    const back = tipR * 1.7;
    const root = [to[0] - td[0] * back, to[1] - td[1] * back, to[2] - td[2] * back];
    branch(F, root, d, len * L.shrink * (0.8 + rnd() * 0.4),
      // da Vinci's rule: a child is ~1/sqrt(n) of its parent.
      tipR * L.radius, level + 1, L, bark, sway, rnd, tips);
  }
}

export function growTree(form, seed, variant = 0, far = false) {
  const rnd = rng(seed);
  const F = new Facets();
  const lod = form.lod || {};
  const pal = form.palettes[variant % form.palettes.length];
  const crown = crownShader(pal, TREES.faceJitter);
  const bark = barkShader(form.bark, TREES.faceJitter);

  const sway = (y) => clamp01(y * y * 0.92 + 0.06);

  const t = form.trunk;
  const sides = far ? (lod.trunkSides || 3) : t.sides;
  // A conifer's stem must clear its lowest skirt.
  const stemTop = form.crown === 'tier'
    ? Math.max(t.height, form.tiers.from + 0.06)
    : t.height;
  const { nodes } = stemNodes(t, stemTop, rnd);
  // Capped at both ends — on a slope the foot shows, and branches are thinner
  // than the stem, so either end is otherwise a hole.
  tube(F, nodes, sides, bark, sway, { start: true, end: true });

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
        colour: (around, ny, j) => crown(ny, k, j),
        sway,
      });
    }
    return normalise(F.build());
  }

  const L = form.limbs;
  const tips = [];
  if (L) {
    const levels = far ? Math.max(1, (lod.levels ?? L.levels) ) : L.levels;
    const split = far ? (lod.split ?? L.split) : L.split;
    const count = far ? Math.max(2, Math.round(L.count * (lod.limbs ?? 1))) : L.count;
    // `bare` still draws its skeleton on the far tier, or a bare stem is left
    // that `matchWidth` cannot widen.
    const cfg = {
      ...L, levels, split, sides: L.sides,
      draw: !far || form.crown === 'bare',
    };

    const side = [0, 0, 0];
    const roll0 = rnd() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const u = count > 1 ? lerp(L.from, L.to, i / (count - 1)) : L.to;
      const at = alongStem(nodes, u);
      const roll = roll0 + i * 2.39996 + (rnd() - 0.5) * 0.6;
      const a = L.angle * (0.75 + rnd() * 0.5);
      const ca = Math.cos(a), sa = Math.sin(a);
      const d = [Math.cos(roll) * sa, ca, Math.sin(roll) * sa];
      const dl = Math.hypot(d[0], d[1], d[2]) || 1;
      d[0] /= dl; d[1] /= dl; d[2] /= dl;
      // Roots inside the stem, not on its surface, or the join leaves a notch.
      branch(F, [at.x, at.y, at.z], d, L.length * (0.8 + rnd() * 0.4),
        at.r * L.radius, 0, cfg, bark, sway, rnd, tips);
      void side;
    }
  }

  const cfg = form.blobs;
  if (cfg && tips.length) {
    const grow = far ? Math.pow(1 / Math.max(0.2, tips.length / cfg.tips), TREES.lodGrow) : 1;
    const detail = far ? (lod.detail ?? 0) : cfg.detail;

    const plans = [];
    for (const tip of tips) {
      // `lift` pushes each lump past its tip so it sits on the branch, not skewered by it.
      const size = lerp(cfg.size[0], cfg.size[1], rnd()) * grow;
      plans.push({
        c: [
          tip.p[0] + tip.dir[0] * size * cfg.lift,
          tip.p[1] + tip.dir[1] * size * cfg.lift,
          tip.p[2] + tip.dir[2] * size * cfg.lift,
        ],
        r: [size, size * cfg.squash, size],
        warp: makeWarp(rnd, cfg.warp),
      });
    }
    // Apex lump never on the far tier — a whole lump for a bump a dozen pixels across.
    if (cfg.apex > 0 && !far) {
      const top = nodes[nodes.length - 1];
      const size = cfg.size[1] * cfg.apex * grow;
      plans.push({
        c: [top.x, top.y + size * 0.5, top.z],
        r: [size, size * cfg.squash, size],
        warp: makeWarp(rnd, cfg.warp),
      });
    }

    // Culling is one-way, biggest first; mutual culling drops the covering
    // surface and leaves windows — sorted by volume this is closed by construction.
    plans.sort((a, b) => b.r[0] * b.r[1] * b.r[2] - a.r[0] * a.r[1] * a.r[2]);
    for (let i = 0; i < plans.length; i++) {
      plans[i].detail = i < (cfg.fine ?? 1) ? detail : Math.max(0, detail - 1);
    }
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      blob(F, {
        c: p.c, r: p.r, detail: p.detail, warpFn: p.warp, rnd,
        sway: (x, y) => sway(y),
        hide: plans.slice(0, i),
        colour: (nx, ny, nz, j) => crown(ny, clamp01(p.c[1] / Math.max(0.2, stemTop + 0.6)), j),
      });
    }
  }

  return normalise(F.build());
}

/**
 * Clamp to y = 0 first: a drooping skirt under the root would otherwise lift
 * the whole tree off the ground (bug #68).
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

  // Pre-scale spans: `computeBoundingBox` overwrites the Box3 in place, so a
  // reference read after the call is already divided by `h` (bug #69).
  return { geometry: geo, height: 1, radius: Math.max(spanX, spanZ) / (2 * h) };
}

/** Normals take the inverse transpose (1/k, 1, 1/k) under the (k, 1, k) scale. */
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

/** `flatShading` is off on purpose: facets and colours are baked per face. */
export function foliageMaterial(fadeOut, fadeIn, opts = {}) {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    // Opaque and single-sided; the doubled fragment cost of DoubleSide is gone.
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
      // Seeded from species and variant, never the world seed — and both tiers
      // share it, so a far tree's lumps sit where the near one's do.
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
    windStrength: TREES.windStrength * 0.45,
  });

  return {
    library,
    far,
    material: nearMat.material,
    farMaterial: farMat.material,
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