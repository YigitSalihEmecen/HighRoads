/**
 * env/treegen.js — the canopy, grown by TreeGen (`tree_gen/`, a submodule).
 *
 * Every HighRoads species is a TreeGen parameter set: its own preset where
 * TreeGen has one, a derived set where it does not. Each variant is generated
 * once at boot, meshed at the levels in `TREES.treegen.lods` (TreeGen's
 * simplified bark, polygon leaves, leaf-cluster cards and a baked billboard)
 * and normalised to unit height, so placement scales it exactly as it did the
 * legacy trees. Which level an instance draws is `forest.js`'s job.
 *
 * Leaf colour comes from `foliage.js:TREE_FORMS[*].palettes`, so a chunk's
 * variant still picks the colourway (three seasons of maple) and the biomes
 * look as they did; bark is TreeGen's.
 *
 * The shrubs are TreeGen bushes (`tree_gen/src/bush.js`, one preset per
 * `foliage.js:SHRUBS` name) in the same library, drawn by the same forest
 * with their own wind and fade (`BUSHES`).
 *
 * Triangles per tree at the default levels: ~25-40k / ~8-12k / ~1.5-3k / 6.
 */

import * as THREE from 'three';
import { BUSHES, TREES } from '../config.js';
import { SHRUBS, TREE_FORMS } from '../foliage.js';
import { SPECIES } from '../../tree_gen/src/species.js';
import { BUSHES as BUSH_PRESETS, generateBush } from '../../tree_gen/src/bush.js';
import { buildLods } from '../../tree_gen/src/lod.js';
import { dressLevels, barkMaterial } from '../../tree_gen/src/kit.js';

/**
 * `from` names a TreeGen preset; `params` override it, `bark` overrides its
 * bark palette. Presets are generated at their own scale (leaf size is in
 * metres) with no size variance — the instance matrix sets the height.
 */
export const TREEGEN_SPECIES = {
  // Conifers carry needle SPRAYS, not needles: a 1 cm needle is sub-pixel on
  // every level past the first, and the stand reads as dead poles.
  pine: {
    from: 'pine',
    params: { leafShape: 'frond', leaves: 14, leafScale: 0.55, leafScaleX: 0.45, leafBend: 0.6 },
  },
  spruce: {
    from: 'pine',
    params: {
      shape: 0, baseSize: 0.05, scale: 20, ratio: 0.016, ratioPower: 1.4,
      length: [1, 0.3, 0.38, 0], curve: [0, -25, -20, 0], curveV: [10, 30, 40, 0],
      downAngle: [0, 98, 60, 60], downAngleV: [0, -40, 12, 10],
      branches: [0, 88, 28, 12], attractionUp: 0.35,
      leafShape: 'frond', leaves: 16, leafScale: 0.5, leafScaleX: 0.5, leafBend: 0.2,
    },
    bark: { base: '#5a4636', dark: '#2a1f17', light: '#7a6450', style: 'plated', ridge: 1.1 },
  },
  fir: {
    from: 'pine',
    params: {
      shape: 0, baseSize: 0.08, scale: 21, ratio: 0.016,
      length: [1, 0.28, 0.4, 0], curve: [0, -8, -12, 0], curveV: [8, 24, 30, 0],
      downAngle: [0, 88, 55, 55], downAngleV: [0, -30, 10, 10],
      branches: [0, 80, 26, 12], attractionUp: 0.6,
      leafShape: 'frond', leaves: 16, leafScale: 0.5, leafScaleX: 0.55, leafBend: 0.3,
    },
    bark: { base: '#6a6158', dark: '#2e2924', light: '#8c8378', style: 'smooth', ridge: 0.7 },
  },
  larch: {
    from: 'pine',
    params: {
      shape: 0, baseSize: 0.15, scale: 18, ratio: 0.014,
      length: [1, 0.3, 0.5, 0], curve: [0, -30, -30, 0], curveV: [20, 50, 60, 0],
      downAngle: [0, 80, 55, 55], downAngleV: [0, -35, 14, 10],
      branches: [0, 52, 22, 10], attractionUp: 0.2,
      leafShape: 'bipinnate', leaves: 14, leafScale: 0.4, leafScaleX: 0.6, leafBend: 0.3,
    },
    bark: { base: '#6e4f3a', dark: '#30221a', light: '#93705a', style: 'plated', ridge: 1.2 },
  },
  cypress: { from: 'cypress', params: { leafShape: 'frond', leaves: 22, leafScale: 0.32, leafScaleX: 0.6 } },
  oak: { from: 'oak', params: { scale: 14, leafScale: 0.17 } },
  maple: {
    from: 'maple',
    params: { scale: 9, baseSize: 0.25, levels: 3, branches: [0, 30, 22, 10], leaves: 22,
      leafScale: 0.12, attractionUp: 0.5, pruneRatio: 0.3 },
  },
  beech: {
    from: 'tupelo',
    params: {
      shape: 1, baseSize: 0.22, scale: 18, levels: 3, ratio: 0.017,
      length: [1, 0.42, 0.55, 0], branches: [0, 40, 26, 0], downAngle: [0, 55, 40, 45],
      leaves: 28, leafShape: 'oval', leafScale: 0.2, leafScaleX: 0.62, attractionUp: 0.6,
    },
    bark: { base: '#8f8a80', dark: '#4a4640', light: '#b4aea3', style: 'smooth', ridge: 0.35, streaks: 0.15 },
  },
  birch: { from: 'birch', params: { leafScale: 0.14 } },
  aspen: { from: 'aspen' },
  poplar: {
    from: 'aspen',
    params: {
      shape: 8, baseSize: 0.12, scale: 20, ratio: 0.014,
      downAngle: [0, 25, 30, 40], downAngleV: [0, -10, 10, 10], branches: [0, 70, 26, 10],
      curve: [0, -10, -20, 0], attractionUp: 1.8, leaves: 22, leafShape: 'cordate',
      pruneRatio: 1, pruneWidth: 0.2, pruneWidthPeak: 0.4, prunePowerLow: 0.5, prunePowerHigh: 0.6,
    },
    bark: { base: '#7b7466', dark: '#38342c', light: '#a39b8a', style: 'diamond', ridge: 1.1 },
  },
  dead: { from: 'deadwood' },
  acacia: { from: 'acacia', params: { leaves: 30, leafScale: 0.15 } },
  willow: { from: 'willow', params: { leafScale: 0.2, leafScaleX: 0.32 } },
  cherry: { from: 'sakura' },
  olive: {
    from: 'oak',
    params: {
      scale: 7, baseSize: 0.2, baseSplits: 2, ratio: 0.03, flare: 1.4, lobes: 7, lobeDepth: 0.14,
      curveV: [140, 160, 60, 0], branches: [0, 30, 40, 0],
      leaves: 30, leafShape: 'lanceolate', leafScale: 0.11, leafScaleX: 0.32, attractionUp: 1.0,
    },
    bark: { base: '#7d7466', dark: '#3a342b', light: '#a59c8b', style: 'fibrous', ridge: 1.5 },
  },
};

const isBush = (name) => !(name in TREEGEN_SPECIES);
const defOf = (name) => TREEGEN_SPECIES[name] || { from: name };
const presetOf = (name) => SPECIES[defOf(name).from] || BUSH_PRESETS[name];
/** Seeds and bark textures are keyed by position in this list. */
const KEYS = [...Object.keys(TREEGEN_SPECIES), ...Object.keys(BUSH_PRESETS)];
const defaultNames = () => [...Object.keys(TREEGEN_SPECIES),
  ...(BUSHES.enabled ? Object.keys(SHRUBS).filter((n) => n in BUSH_PRESETS) : [])];

const hex = (rgb) => `#${new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2],
  THREE.LinearSRGBColorSpace).getHexString()}`;

/**
 * World-space wind after the instance matrix, the legacy shader's gust (so
 * the whole wood leans together) with sway rising as height² up the unit-tall
 * tree, plus a flutter on the leaves.
 */
function windify(material, uniforms, leafy, bark = false) {
  // Cutouts (cards, billboards) soften their edge across the MSAA samples.
  const cutout = !!material.map && material.alphaTest > 0;
  if (cutout) material.alphaToCoverage = true;
  // Chained: TreeGen's card material has a patch of its own.
  const base = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    base.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    // Coverage held up with distance (Castaño 2010; Golus 2017): each mip
    // averages leaf with gap, so alpha sinks under the cutoff and a far crown
    // turns into see-through specks. Scale it back up by the mip level.
    // Bark has no vertex colours, so its vColor IS the instance tint: keep a
    // little of it (ground cast, variety), not a gold wood's gold bark.
    if (bark) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', /* glsl */`
        #ifdef USE_COLOR
          diffuseColor.rgb *= mix( vec3( 1.0 ), vColor, 0.3 );
        #endif
      `);
    }
    if (cutout) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', /* glsl */`
        {
          vec2 tg_t = vMapUv * vec2( textureSize( map, 0 ) );
          vec2 tg_dx = dFdx( tg_t ), tg_dy = dFdy( tg_t );
          float tg_mip = max( 0.0, 0.5 * log2( max( dot( tg_dx, tg_dx ), dot( tg_dy, tg_dy ) ) ) );
          diffuseColor.a *= 1.0 + tg_mip * ${TREES.treegen.alphaMipScale.toFixed(4)};
        }
        #include <alphatest_fragment>
      `);
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform float uTime;
        uniform vec2  uWind;
        uniform float uWindStrength;
        uniform float uWindSpeed;
        vec2 tg_gust(vec3 p) {
          float a = sin(uTime * uWindSpeed       + p.x * 0.031 + p.z * 0.043);
          float b = sin(uTime * uWindSpeed * 2.3 + p.x * 0.13  - p.z * 0.09) * 0.42;
          float c = sin(uTime * uWindSpeed * 5.1 + p.x * 0.47  + p.z * 0.39) * 0.18;
          return uWind * (0.5 + 0.5 * (a + b + c)) * uWindStrength;
        }
      `)
      .replace('#include <project_vertex>', /* glsl */`
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        vec4 tg_world = modelMatrix * mvPosition;
        #ifdef USE_INSTANCING
          vec3 tg_inst = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
        #else
          vec3 tg_inst = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
        #endif
        float tg_h = clamp( position.y, 0.0, 1.0 );
        tg_world.xz += tg_gust( tg_inst ) * tg_h * tg_h;
        ${leafy ? `tg_world.xyz += 0.035 * tg_h * sin( uTime * 6.3 + dot( tg_world.xyz, vec3( 1.7, 2.3, 1.3 ) ) ) * vec3( 0.6, 0.4, 0.5 );` : ''}
        mvPosition = viewMatrix * tg_world;
        gl_Position = projectionMatrix * mvPosition;
      `);
  };
  material.customProgramCacheKey = () => `highroads-treegen-${leafy ? 1 : 0}-${material.alphaTest > 0 ? 1 : 0}-${bark ? 1 : 0}`;
}

/** Scale every part to unit height; returns the horizontal radius at that scale. */
function normalise(levels) {
  let top = 0;
  for (const p of levels[0].parts) {
    p.geometry.computeBoundingBox();
    top = Math.max(top, p.geometry.boundingBox.max.y);
  }
  const k = 1 / Math.max(1e-3, top);
  let r = 0;
  for (const level of levels) {
    for (const p of level.parts) {
      p.geometry.scale(k, k, k);
      p.geometry.computeBoundingBox();
      p.geometry.computeBoundingSphere();
    }
  }
  for (const p of levels[0].parts) {
    const a = p.geometry.getAttribute('position').array;
    for (let i = 0; i < a.length; i += 3) r = Math.max(r, Math.hypot(a[i], a[i + 2]));
  }
  return r;
}

/** One job per species variant, in library order: everything a worker needs. */
function plan(names) {
  const G = TREES.treegen;
  const jobs = [];
  for (const name of names) {
    const def = defOf(name);
    const preset = presetOf(name);
    const bush = isBush(name);
    const pal = (bush ? SHRUBS : TREE_FORMS)[name]?.palettes;
    const caps = bush ? BUSHES : G;
    for (let v = 0; v < caps.variants; v++) {
      const params = {
        ...preset.params, ...def.params, scaleV: 0,
        // Seeded from species and variant, never the world seed.
        seed: (0x7ee5 + KEYS.indexOf(name) * 131 + v * 7919) >>> 0,
        maxLeaves: caps.maxLeaves, maxBranches: caps.maxBranches,
      };
      const p = pal ? pal[v % pal.length] : null;
      jobs.push({
        name, v, params, bush,
        leaves: params.leaves !== 0 ? { shape: params.leafShape,
          colors: p ? [hex(p[1]), hex(p[0])] : preset.palette.leaf.summer } : null,
        growth: preset.growth ? { ...preset.growth, detail: 1 } : null,
      });
    }
  }
  return jobs;
}

/** The library being filled, and `add` to dress one variant's geometry into it. */
function makeLibrary(o, names) {
  const G = TREES.treegen;
  const uniforms = {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2(TREES.windDir.x, TREES.windDir.z).normalize() },
    uWindStrength: { value: TREES.windStrength },
    uWindSpeed: { value: TREES.windSpeed },
  };
  // Tip travel is in metres, not tree heights: a shrub sways less.
  const shrubUniforms = { ...uniforms, uWindStrength: { value: BUSHES.windStrength } };
  const windOf = (name) => (isBush(name) ? shrubUniforms : uniforms);
  const specs = G.lods.map((L) => ({ ...L }));
  /** species -> [{ radius, levels: [{ parts: [{ geometry, material, leafy }], tris }] }] */
  const library = new Map(names.map((n) => [n, new Array((isBush(n) ? BUSHES : G).variants)]));
  const barks = new Map();
  const tris = new Array(specs.length).fill(0);
  let done = 0;

  // One bark texture per species: every variant shares it.
  const barkFor = (name) => {
    if (!barks.has(name)) {
      const bark = barkMaterial({ ...presetOf(name).palette.bark, ...defOf(name).bark },
        { size: G.barkSize, seed: 0x5eed + KEYS.indexOf(name) });
      windify(bark, windOf(name), false, true);
      barks.set(name, bark);
    }
    return barks.get(name);
  };

  const add = (job, geos, center) => {
    const bark = barkFor(job.name);
    const levels = dressLevels(geos, specs, {
      renderer: o.renderer, bark, leaves: job.leaves, center,
      // Kept on the GPU: nothing here exports a billboard.
      impostor: { height: G.impostorHeight, readback: false },
    });
    const radius = normalise(levels);
    const out = levels.map((level, i) => {
      let n = 0;
      for (const part of level.parts) {
        if (part.material !== bark) windify(part.material, windOf(job.name), part.name === 'Foliage');
        n += part.geometry.index ? part.geometry.index.count / 3 : 0;
      }
      if (!job.bush) tris[i] += n;
      return { parts: level.parts, tris: n, impostor: !!specs[i].impostor, dispose: level.dispose };
    });
    library.get(job.name)[job.v] = { height: 1, radius, levels: out, fade: job.bush ? BUSHES.fade : null };
    if (!job.bush) done++;
  };

  const assets = {
    library,
    specs,
    uniforms,
    /** Mean triangles per tree (not shrub) at each level, for the probes' budget lines. */
    get trianglesPerLevel() { return tris.map((t) => t / Math.max(1, done)); },
    setTime(t) { uniforms.uTime.value = t; },
    dispose() {
      for (const vs of library.values()) for (const v of vs) for (const l of v.levels) l.dispose();
      for (const b of barks.values()) {
        for (const k of ['map', 'normalMap', 'roughnessMap']) b[k]?.dispose();
        b.dispose();
      }
    },
  };
  return { assets, add, specs };
}

/** One variant on this thread. */
function grow(job, specs) {
  const tree = generateBush(job.params);
  const geos = buildLods(tree, specs, { detail: TREES.treegen.detail, leaves: job.leaves, growth: job.growth });
  return { geos, center: tree.bounds.center };
}

/**
 * The whole library at once, on this thread (probes, headless).
 * @param {object} o { renderer (bakes billboards; none headless), names }
 */
export function createTreeGenAssets(o = {}) {
  const names = o.names || defaultNames();
  const L = makeLibrary(o, names);
  for (const job of plan(names)) {
    const { geos, center } = grow(job, L.specs);
    L.add(job, geos, center);
  }
  return L.assets;
}

const unpack = (p) => {
  if (!p) return null;
  const g = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(p.attrs)) g.setAttribute(k, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized));
  g.setIndex(new THREE.BufferAttribute(p.index, 1));
  return g;
};

/**
 * The library grown on a pool of workers (treegen.worker.js), dressed and
 * baked here as each variant arrives. Falls back to this thread, a variant
 * per frame, where workers or OffscreenCanvas are missing or fail to start.
 */
export async function createTreeGenAssetsAsync(o = {}, onProgress = () => {}) {
  const names = o.names || defaultNames();
  const L = makeLibrary(o, names);
  const jobs = plan(names);
  const total = jobs.length;
  let done = 0;
  const finished = () => onProgress(++done / total);

  const pool = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
    ? await startPool(Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))) : [];
  if (pool.length) {
    const queue = [...jobs];
    await Promise.all(pool.map((w) => (async () => {
      for (let job; (job = queue.shift());) {
        const r = await new Promise((res) => {
          w.onmessage = ({ data }) => res(data);
          w.postMessage({ id: 0, params: job.params, specs: L.specs, detail: TREES.treegen.detail,
            leaves: job.leaves, growth: job.growth });
        });
        if (r.error) throw new Error(`treegen worker: ${r.error}`);
        L.add(job, r.levels.map((l) => l && {
          bark: unpack(l.bark), leaves: unpack(l.leaves), moss: unpack(l.moss), fungus: unpack(l.fungus),
          counts: l.counts, cards: l.cards,
        }), r.center);
        finished();
      }
    })()));
    for (const w of pool) w.terminate();
  } else {
    for (const job of jobs) {
      const { geos, center } = grow(job, L.specs);
      L.add(job, geos, center);
      finished();
      await new Promise((res) => setTimeout(res, 0));
    }
  }
  return L.assets;
}

/** Workers that have loaded TreeGen, or none if they cannot. */
async function startPool(n) {
  const init = {
    type: 'init',
    base: new URL('../../tree_gen/src/', import.meta.url).href,
    bare: Object.fromEntries(['three', 'meshoptimizer/simplifier', 'meshoptimizer/encoder']
      .map((s) => [s, import.meta.resolve(s)])),
  };
  const start = () => new Promise((res) => {
    let w;
    try { w = new Worker(new URL('./treegen.worker.js', import.meta.url), { type: 'module' }); }
    catch (err) { res(null); return; }
    const fail = () => { w.terminate(); res(null); };
    const timer = setTimeout(fail, 15000);
    w.onerror = () => { clearTimeout(timer); fail(); };
    w.onmessage = ({ data }) => { if (data.type === 'ready') { clearTimeout(timer); res(w); } };
    w.postMessage(init);
  });
  const workers = await Promise.all(Array.from({ length: n }, start));
  const ok = workers.filter(Boolean);
  if (ok.length < workers.length) console.warn(`[treegen] ${workers.length - ok.length} worker(s) failed to start`);
  return ok;
}
