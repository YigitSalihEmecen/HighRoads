/**
 * env/ground.js — the terrain surface, up close.
 *
 * The sheet carries height and colour only. A detail texture and its tiling
 * add break-up at a scale the mesh cannot carry; on grass, near the car, a
 * SWARD heightfield is ray-marched (parallax occlusion mapping) so the turf
 * has depth: tufts that hide the soil behind them, and shadow their own lee.
 */

import * as THREE from 'three';
import { GROUND, TERRAIN_COLORS } from '../config.js';
import { canopyShadow, CANOPY_GLSL } from '../forest.js';
import { makeCanvas, paint, tileFbm, tileRidged, tileNoise, rng } from './textures.js';

/**
 * Three-channel detail map, each centred on 1.0; the shader modulates by the
 * contrast uniforms, so a channel at 1.0 leaves the ground alone.
 */
function detailTexture(size) {
  const target = makeCanvas(size);
  if (!target) return null;

  paint(target, (u, v, out) => {
    // R sward: clumps plus 5:1 directional streaks — grass lies down in a direction.
    const clump = tileFbm(u, v, 6, 4, 0.55, 11);
    const streak = tileFbm(u * 0.2, v, 5, 3, 0.5, 23);
    const fleck = tileNoise(u * 96, v * 96, 96, 31);
    out[0] = 0.42 + clump * 0.62 + (streak - 0.5) * 0.30 + (fleck - 0.5) * 0.16;

    // G rock: ridged creases (lines, not blobs) over coarse bedding blockiness.
    const crease = tileRidged(u, v, 5, 5, 0.55, 47);
    const block = tileFbm(u, v, 3, 2, 0.5, 59);
    out[1] = 0.34 + crease * 0.74 + (block - 0.5) * 0.26;

    // B soil: blotches plus texel-scale grit — mipmapping fades it by fifty metres.
    const blotch = tileFbm(u, v, 4, 3, 0.5, 71);
    const grit = tileNoise(u * 160, v * 160, 160, 83);
    out[2] = 0.50 + blotch * 0.52 + (grit - 0.5) * 0.34;
    return out;
  });

  const tex = new THREE.CanvasTexture(target.canvas);
  // NOT sRGB: a modulation mask, and decoding would bend the midpoint.
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/**
 * The MACRO field: broad and slow, tiled every few hundred metres, to break
 * the ground into lush and parched stretches. Its own small texture rather
 * than the detail map's alpha — a canvas premultiplies, and an alpha channel
 * would quantise the detail's RGB wherever it ran low.
 *   R  lush (low) ↔ parched (high)
 *   G  brightness drift
 */
function macroTexture(size) {
  const target = makeCanvas(size);
  if (!target) return null;
  paint(target, (u, v, out) => {
    out[0] = tileFbm(u, v, 3, 4, 0.55, 97) * 1.25 - 0.12;
    out[1] = tileFbm(u, v, 5, 3, 0.5, 131);
    out[2] = 0;
    out[3] = 1;
    return out;
  });
  const tex = new THREE.CanvasTexture(target.canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/**
 * The sward: a tile of turf, `size` px over `GROUND.sward.tile` metres, built
 * the way it grows rather than from noise — tufts of blades radiating from a
 * crown, each blade a tapering stroke that is tallest at its root and lies
 * down toward its tip, over a soil of crumbs and pebbles. Two RGBA maps:
 *   albedo  R luminance /1.5 (mean 1 after AO)  G dry/soil  B occlusion  A height
 *   normal  tangent space (x along world X, y along world Z), 0.5-biased
 *   height  the alpha again, alone: what the march reads, one byte a fetch
 * Data
 * textures, not canvases: a canvas premultiplies, and would crush the colour
 * wherever the turf is low.
 */
function swardMaps(size) {
  if (!makeCanvas(1)) return null;
  const S = GROUND.sward;
  const N = size, M = N - 1;
  const H = new Float32Array(N * N);
  const L = new Float32Array(N * N);
  const D = new Float32Array(N * N);
  const R = rng(0x5a7d);
  const px = N / S.tile;             // pixels per metre

  // Soil: crumbs, and the odd pebble standing out of it.
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i, u = i / N, v = j / N;
      H[k] = 0.06 + 0.16 * tileFbm(u, v, 24, 3, 0.55, 211);
      L[k] = 0.5 + 0.16 * tileFbm(u, v, 40, 2, 0.5, 223);
      D[k] = 0.85;
    }
  }
  const disc = (cx, cy, r, h, l, d, dome) => {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const q = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (q > r2) continue;
        const k = (y & M) * N + (x & M);
        const z = dome ? h * Math.sqrt(1 - q / r2) : h;
        if (z <= H[k]) continue;
        H[k] = z; L[k] = l; D[k] = d;
      }
    }
  };
  const pebbles = Math.round(S.pebbles * S.tile * S.tile);
  for (let p = 0; p < pebbles; p++) {
    disc(R() * N, R() * N, (0.004 + R() * 0.012) * px, 0.22 + R() * 0.2, 0.8 + R() * 0.35, 0.55 + R() * 0.3, true);
  }

  // Tufts: blades from a crown, leaning out. Drawn back to front by height is
  // not needed — each texel keeps the tallest blade over it.
  const tufts = Math.round(S.tufts * S.tile * S.tile);
  for (let t = 0; t < tufts; t++) {
    const cx = R() * N, cy = R() * N;
    const spread = (0.04 + R() * 0.08) * px;
    const vigour = 0.55 + R() * 0.45;
    const dryTuft = R() < S.dryShare;
    const blades = 24 + Math.floor(R() * 50 * vigour);
    for (let b = 0; b < blades; b++) {
      const a0 = R() * Math.PI * 2;
      const rr = Math.sqrt(R()) * spread * 0.45;
      let x = cx + Math.cos(a0) * rr, y = cy + Math.sin(a0) * rr;
      let ang = a0 + (R() - 0.5) * 1.1;
      const bend = (R() - 0.5) * 0.06;
      const len = (0.05 + R() * 0.1) * px * vigour;
      const h0 = (0.6 + R() * 0.4) * vigour;
      const w0 = (0.0018 + R() * 0.0018) * px;
      const shade = 0.85 + R() * 0.35;
      const dry = dryTuft ? 0.5 + R() * 0.4 : R() * R() * 0.35;
      const steps = Math.ceil(len * 2);
      for (let k = 0; k <= steps; k++) {
        const f = k / steps;
        disc(x, y, Math.max(0.5, w0 * (1 - f * 0.75)), h0 * (1 - 0.7 * f * f) + 0.1,
          shade * (0.9 + 0.3 * f), Math.min(1, dry + f * 0.25), false);
        ang += bend;
        x += Math.cos(ang) * 0.5;
        y += Math.sin(ang) * 0.5;
      }
    }
  }

  const Hs = smooth3(H, N);

  // Occlusion: how far below its neighbourhood a texel sits.
  const ao = new Float32Array(N * N);
  const r = Math.max(2, Math.round(0.012 * px));
  let mean = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let m = 0;
      for (let k = -r; k <= r; k += r) for (let l = -r; l <= r; l += r) m += Hs[((j + k) & M) * N + ((i + l) & M)];
      const c = Hs[j * N + i];
      ao[j * N + i] = Math.min(1, Math.max(0.25, 0.75 + (c - m / 9) * 2.2 + c * 0.35));
      mean += L[j * N + i] * ao[j * N + i];
    }
  }
  mean /= N * N;

  const albedo = new Uint8Array(N * N * 4);
  const normal = new Uint8Array(N * N * 4);
  // Slope in metres per metre: height is 0..1 of `depth` metres.
  const g = (S.depth * px) / 2;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i, o = k * 4;
      albedo[o] = Math.min(255, (L[k] / mean / 1.5) * 255);
      albedo[o + 1] = D[k] * 255;
      albedo[o + 2] = ao[k] * 255;
      albedo[o + 3] = Hs[k] * 255;
      const nx = -(Hs[j * N + ((i + 1) & M)] - Hs[j * N + ((i - 1) & M)]) * g;
      const ny = -(Hs[((j + 1) & M) * N + i] - Hs[((j - 1) & M) * N + i]) * g;
      const nl = Math.hypot(nx, ny, 1);
      normal[o] = (nx / nl * 0.5 + 0.5) * 255;
      normal[o + 1] = (ny / nl * 0.5 + 0.5) * 255;
      normal[o + 2] = (1 / nl * 0.5 + 0.5) * 255;
      normal[o + 3] = 255;
    }
  }
  const height = new Uint8Array(N * N);
  for (let k = 0; k < N * N; k++) height[k] = Hs[k] * 255;
  // The march reads `height` alone: one byte a fetch, no anisotropy.
  const h = dataTexture(height, N, THREE.RedFormat);
  h.unpackAlignment = 1;
  return { albedo: dataTexture(albedo, N), normal: dataTexture(normal, N), height: h };
}

/** One pass of 3x3 smoothing on a wrapped field: a march across single-texel spikes shimmers. */
function smooth3(H, N) {
  const M = N - 1;
  const out = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let a = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        a += H[((j + dy) & M) * N + ((i + dx) & M)] * (dx || dy ? (dx && dy ? 1 : 2) : 4);
      }
      out[j * N + i] = a / 16;
    }
  }
  return out;
}

function dataTexture(data, N, format = THREE.RGBAFormat) {
  const t = new THREE.DataTexture(data, N, N, format);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * The verge: a tile of graded roadside, `size` px over `GROUND.verge.tile`
 * metres — packed soil, gravel spread over it in drifts, the odd cobble.
 * Stones are kept apart from the soil so the shader can sink them into it:
 *   height  R soil, G a stone's PROMINENCE over the soil + 0.25 (0.15 where none)
 *   albedo  R soil luminance /1.5, G stone luminance /1.5, B occlusion, A stone warmth
 *   normal  RG the soil's, BA the stones' (soil plus stone), 0.5-biased
 * Prominence rather than stone height: its mips still average to how much
 * stone stands out, so the gravel thins with distance instead of vanishing.
 */
function vergeMaps(size) {
  if (!makeCanvas(1)) return null;
  const S = GROUND.verge;
  const N = size, M = N - 1;
  const soil = new Float32Array(N * N);
  const top = new Float32Array(N * N);
  const Ls = new Float32Array(N * N);
  const Lr = new Float32Array(N * N).fill(1);
  const warm = new Float32Array(N * N).fill(0.3);
  const R = rng(0x6a7e1);
  const px = N / S.tile;

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i, u = i / N, v = j / N;
      soil[k] = 0.05 + 0.1 * tileFbm(u, v, 5, 4, 0.5, 307) + 0.05 * tileFbm(u, v, 48, 2, 0.5, 311);
      Ls[k] = 0.8 + 0.3 * tileFbm(u, v, 9, 3, 0.5, 313) + 0.14 * (tileNoise(u * 256, v * 256, 256, 317) - 0.5);
    }
  }

  // An irregular stone: a turned ellipse with a lobed outline, a flattish
  // crown tilted off level, bedded a third of its height into the soil.
  const stone = (cx, cy, rm) => {
    const r = rm * px;
    const h = (rm / S.depth) * (0.75 + R() * 0.45);
    const asp = 0.6 + R() * 0.4, rot = R() * Math.PI, c = Math.cos(rot), s = Math.sin(rot);
    const a1 = 0.06 + R() * 0.1, a2 = R() * 0.06, p1 = R() * 6.28, p2 = R() * 6.28;
    const tx = (R() - 0.5) * 0.5, ty = (R() - 0.5) * 0.5;
    const base = soil[(Math.round(cy) & M) * N + (Math.round(cx) & M)] - h * 0.35;
    const lum = 0.7 + R() * 0.6;
    const w = R() < 0.3 ? 0.5 + R() * 0.5 : R() * 0.3;
    const rr = r * (1 + a1 + a2);
    for (let y = Math.floor(cy - rr); y <= Math.ceil(cy + rr); y++) {
      for (let x = Math.floor(cx - rr); x <= Math.ceil(cx + rr); x++) {
        const dx = x - cx, dy = y - cy;
        const lx = dx * c + dy * s, ly = (dy * c - dx * s) / asp;
        const q2 = lx * lx + ly * ly;
        if (q2 > rr * rr) continue;
        const th = Math.atan2(ly, lx);
        const q = Math.sqrt(q2) / (r * (1 + a1 * Math.cos(3 * th + p1) + a2 * Math.cos(5 * th + p2)));
        if (q >= 1) continue;
        const z = base + h * Math.sqrt(1 - q ** 2.6) * (1 + (tx * lx + ty * ly) / r);
        const k = (y & M) * N + (x & M);
        if (z <= top[k]) continue;
        top[k] = z; Lr[k] = lum * (0.9 + 0.2 * R()); warm[k] = w;
      }
    }
  };
  const area = S.tile * S.tile;
  for (let n = Math.round(S.cobbles * area); n > 0; n--) stone(R() * N, R() * N, 0.022 + R() * 0.022);
  // Drifts: the grader leaves more stone in some places than others.
  for (let n = Math.round(S.gravel * area); n > 0; n--) {
    const x = R() * N, y = R() * N;
    if (R() > 0.3 + 0.9 * tileFbm(x / N, y / N, 3, 3, 0.5, 331)) continue;
    stone(x, y, 0.005 + R() * R() * 0.016);
  }

  const Hs = smooth3(soil, N);
  const Ts = smooth3(top, N);
  const both = new Float32Array(N * N);
  for (let k = 0; k < N * N; k++) both[k] = Math.max(Hs[k], Ts[k]);

  const ao = new Float32Array(N * N);
  const r = Math.max(2, Math.round(0.008 * px));
  let ms = 0, mr = 0, nr = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let m = 0;
      for (let k = -r; k <= r; k += r) for (let l = -r; l <= r; l += r) m += both[((j + k) & M) * N + ((i + l) & M)];
      const k = j * N + i;
      ao[k] = Math.min(1, Math.max(0.35, 0.82 + (both[k] - m / 9) * 4.0));
      ms += Ls[k] * ao[k];
      if (Ts[k] > Hs[k]) { mr += Lr[k]; nr++; }
    }
  }
  ms /= N * N;
  mr = nr ? mr / nr : 1;

  const albedo = new Uint8Array(N * N * 4);
  const normal = new Uint8Array(N * N * 4);
  const height = new Uint8Array(N * N * 2);
  const g = (S.depth * px) / 2;
  const nrm = (F, i, j, o) => {
    const nx = -(F[j * N + ((i + 1) & M)] - F[j * N + ((i - 1) & M)]) * g;
    const ny = -(F[((j + 1) & M) * N + i] - F[((j - 1) & M) * N + i]) * g;
    const nl = Math.hypot(nx, ny, 1);
    normal[o] = (nx / nl * 0.5 + 0.5) * 255;
    normal[o + 1] = (ny / nl * 0.5 + 0.5) * 255;
  };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i, o = k * 4;
      const prom = Ts[k] > 0 ? Ts[k] - Hs[k] : -0.1;
      height[k * 2] = Math.min(1, Hs[k]) * 255;
      height[k * 2 + 1] = Math.min(1, Math.max(0, prom + 0.25)) * 255;
      albedo[o] = Math.min(255, (Ls[k] / ms / 1.5) * 255);
      albedo[o + 1] = Math.min(255, (Lr[k] / mr / 1.5) * 255);
      albedo[o + 2] = ao[k] * 255;
      albedo[o + 3] = warm[k] * 255;
      nrm(Hs, i, j, o);
      nrm(both, i, j, o + 2);
    }
  }
  return { albedo: dataTexture(albedo, N), normal: dataTexture(normal, N), height: dataTexture(height, N, THREE.RGFormat) };
}

/** Terrain material with the detail overlay multiplied onto diffuseColor after colour. */
export function createGroundAssets({ anisotropy = 1 } = {}) {
  const map = GROUND.enabled ? detailTexture(GROUND.textureSize) : null;
  // Capped: hex tiling takes three of its fetches a pixel.
  if (map) map.anisotropy = Math.min(anisotropy, 8);
  const macro = GROUND.enabled ? macroTexture(128) : null;
  const S = GROUND.sward;
  const sward = GROUND.enabled && S.enabled ? swardMaps(S.size) : null;
  const V = GROUND.verge;
  const verge = sward && V.enabled ? vergeMaps(V.size) : null;
  // Anisotropy only where it shows: the final colour fetch. Every tap of the
  // march would otherwise cost up to that many filtered reads.
  for (const m of [sward, verge]) {
    if (!m) continue;
    m.albedo.anisotropy = Math.min(anisotropy, S.anisotropy);
    m.normal.anisotropy = Math.min(anisotropy, 4);
  }

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    // Smooth-shaded, not flat: flat renders a hillside as a mosaic of 2.4 m plates.
    flatShading: false,
    roughness: 0.97,
    metalness: 0.0,
  });

  const uniforms = {
    uDetail: { value: map },
    // Metres per tile, near and far.
    uTile: { value: new THREE.Vector2(GROUND.tileNear, GROUND.tileFar) },
    uContrast: { value: new THREE.Vector2(GROUND.contrastNear, GROUND.contrastFar) },
    uNearFade: { value: new THREE.Vector2(GROUND.nearFade[0], GROUND.nearFade[1]) },
    uMacro: { value: GROUND.macroTile },
    uMacroMap: { value: macro },
    uBump: { value: GROUND.bump },
    uSward: { value: sward && sward.albedo },
    uSwardN: { value: sward && sward.normal },
    uSwardH: { value: sward && sward.height },
    uSwardTile: { value: S.tile },
    /** relief depth (m), fade start, fade end (m), self-shadow strength */
    uPom: { value: new THREE.Vector4(S.depth, S.fade[0], S.fade[1], S.shadow) },
    uPomSteps: { value: new THREE.Vector2(S.steps[0], S.steps[1]) },
    uSwardLook: { value: new THREE.Vector3(S.contrast, S.occlusion, 0) },
    uSwardDry: { value: new THREE.Color(...S.dry) },
    uVergeA: { value: verge && verge.albedo },
    uVergeN: { value: verge && verge.normal },
    uVergeH: { value: verge && verge.height },
    /** band start, band end, edge wander (m), tile (m) */
    uVerge: { value: new THREE.Vector4(V.band[0], V.band[1], V.jitter, V.tile) },
    uVergeDepth: { value: V.depth },
    uRockCol: { value: new THREE.Color(TERRAIN_COLORS.rock) },
    uSoilCol: { value: new THREE.Color(TERRAIN_COLORS.soil) },
    uStoneA: { value: new THREE.Color(V.stone[0]) },
    uStoneB: { value: new THREE.Color(V.stone[1]) },
  };
  if (sward) material.defines = verge ? { FR_SWARD: '', FR_VERGE: '' } : { FR_SWARD: '' };
  /** Live: the probes flip the march off and on through these. */
  material.userData.uniforms = uniforms;

  if (map && macro) {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms, canopyShadow);

      // `worldpos_vertex` only defines worldPosition when something wants it, so ask here.
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          varying vec3 fr_wpos;
          varying vec3 fr_wnorm;
          attribute vec2 bare;
          varying vec2 fr_bare;
          #ifdef FR_VERGE
          attribute float roadDist;
          varying float fr_rd;
          #endif
        `)
        .replace('#include <project_vertex>', /* glsl */`
          #include <project_vertex>
          fr_wpos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
          fr_wnorm = mat3( modelMatrix ) * objectNormal;
          fr_bare = bare;
          #ifdef FR_VERGE
          fr_rd = roadDist;
          #endif
        `);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          varying vec3 fr_wpos;
          varying vec3 fr_wnorm;
          varying vec2 fr_bare;
          uniform vec3 uRockCol;
          uniform vec3 uSoilCol;
          ${CANOPY_GLSL.pars}
          uniform sampler2D uSward;
          uniform sampler2D uSwardN;
          uniform sampler2D uSwardH;
          uniform float uSwardTile;
          uniform vec4 uPom;
          uniform vec2 uPomSteps;
          uniform vec3 uSwardLook;
          uniform vec3 uSwardDry;
          uniform sampler2D uDetail;
          uniform vec2 uTile;
          uniform vec2 uContrast;
          uniform vec2 uNearFade;
          uniform float uMacro;
          uniform float uBump;
          uniform sampler2D uMacroMap;
          uniform float uVergeDepth;
          #ifdef FR_VERGE
          varying float fr_rd;
          uniform sampler2D uVergeA;
          uniform sampler2D uVergeN;
          uniform sampler2D uVergeH;
          uniform vec4 uVerge;
          uniform vec3 uStoneA;
          uniform vec3 uStoneB;
          #endif

          // HEX TILING (Mikkelsen 2022, "Practical Real-Time Hex-Tiling"):
          // the tile is laid three times, each copy turned and shifted at
          // random per vertex of a triangle grid, and blended by sharpened
          // barycentric weights — so no stretch of ground repeats.
          struct FrHex { vec3 w; mat2 r0, r1, r2; vec2 o0, o1, o2; };
          // Sine-free (Hoskins): a world-scale lattice index is too big for sin.
          vec4 fr_hash24( vec2 p ) {
            vec4 p4 = fract( p.xyxy * vec4( 0.1031, 0.1030, 0.0973, 0.1099 ) );
            p4 += dot( p4, p4.wzxy + 33.33 );
            return fract( ( p4.xxyz + p4.yzzw ) * p4.zywx );
          }
          void fr_cell( vec2 v, out mat2 r, out vec2 o ) {
            vec4 h = fr_hash24( v );
            float a = h.x * 6.2831853, c = cos( a ), s = sin( a );
            r = mat2( c, s, -s, c );
            o = h.zw;
          }
          FrHex fr_hex( vec2 uv ) {
            vec2 sk = mat2( 1.0, 0.0, -0.57735027, 1.15470054 ) * ( uv * 1.4 );
            vec2 base = floor( sk );
            vec3 t = vec3( fract( sk ), 0.0 );
            t.z = 1.0 - t.x - t.y;
            float s = t.z < 0.0 ? 1.0 : 0.0, s2 = 2.0 * s - 1.0;
            FrHex h;
            h.w = pow( max( vec3( -t.z * s2, s - t.y * s2, s - t.x * s2 ), 0.0 ), vec3( 5.0 ) );
            h.w /= h.w.x + h.w.y + h.w.z;
            fr_cell( base + vec2( s ), h.r0, h.o0 );
            fr_cell( base + vec2( s, 1.0 - s ), h.r1, h.o1 );
            fr_cell( base + vec2( 1.0 - s, s ), h.r2, h.o2 );
            return h;
          }
          vec4 fr_hexTex( sampler2D t, FrHex h, vec2 uv, vec2 gx, vec2 gy ) {
            return h.w.x * textureGrad( t, h.r0 * uv + h.o0, h.r0 * gx, h.r0 * gy )
                 + h.w.y * textureGrad( t, h.r1 * uv + h.o1, h.r1 * gx, h.r1 * gy )
                 + h.w.z * textureGrad( t, h.r2 * uv + h.o2, h.r2 * gx, h.r2 * gy );
          }
          // The heaviest copy alone, both tangent-space xy pairs (xy, zw)
          // turned back out of its frame — a turned texture tilts its normals
          // with it. A third of the fetches, for normals past the march.
          vec4 fr_hexMajor( sampler2D t, FrHex h, vec2 uv, vec2 gx, vec2 gy ) {
            mat2 r = h.r0; vec2 o = h.o0;
            if ( h.w.y > h.w.x && h.w.y > h.w.z ) { r = h.r1; o = h.o1; }
            else if ( h.w.z > h.w.x ) { r = h.r2; o = h.o2; }
            vec4 n = textureGrad( t, r * uv + o, r * gx, r * gy ) * 2.0 - 1.0;
            return vec4( n.xy * r, n.zw * r );
          }

          // The relief's height (0..1) at world point m: the sward's, the
          // verge's, or a blend where one hands over to the other.
          float fr_hAt( vec2 m, float gk, float sink, vec2 gx, vec2 gy ) {
            float h = 0.0;
            if ( gk < 0.999 ) h = ( 1.0 - gk ) * textureGrad( uSwardH, m / uSwardTile, gx / uSwardTile, gy / uSwardTile ).r;
            #ifdef FR_VERGE
            if ( gk > 0.001 ) {
              vec2 v = textureGrad( uVergeH, m / uVerge.w, gx / uVerge.w, gy / uVerge.w ).rg;
              h += gk * ( v.r + max( v.g - 0.25 - sink, 0.0 ) );
            }
            #endif
            return h;
          }

          #ifdef FR_VERGE
          // The verge at one tile point: rgb its colour over \`soil\`, a how
          // much of it is stone. Stones stand out by their prominence over
          // the soil less the sink; the edge widens as the mips average.
          vec4 fr_verge( vec2 uv, vec2 gx, vec2 gy, float sink, float soft, vec3 soil ) {
            vec4 a = textureGrad( uVergeA, uv, gx, gy );
            float p = textureGrad( uVergeH, uv, gx, gy ).g - 0.25 - sink;
            float st = smoothstep( -soft, soft, p );
            vec3 stone = mix( uStoneA, uStoneB, a.a ) * ( a.g * 1.5 );
            return vec4( mix( soil * ( a.r * 1.5 ), stone, st ) * mix( 1.0, a.b, 0.8 ), st );
          }
          #endif
        `)
        // After colour_fragment, before lighting: the overlay is albedo, not light.
        .replace('#include <color_fragment>', /* glsl */`
          #include <color_fragment>
          float fr_height = 0.0;      // detail relief for the bump, metres-ish
          float fr_nearW = 0.0;
          // The relief: the sward's weight and the verge's, the verge's share
          // of the march, how far its stones have sunk, the marched point in
          // world metres, and past the march, how far hex tiling has taken
          // over. Its frame: world X and Z (the planar mapping) laid onto the
          // ground's slope.
          float fr_sw = 0.0, fr_gw = 0.0, fr_gk = 0.0, fr_sink = 0.0, fr_hexW = 1.0, fr_vst = 0.0;
          vec2 fr_mp = fr_wpos.xz;
          vec2 fr_gx = dFdx( fr_mp ), fr_gy = dFdy( fr_mp );
          vec3 fr_W = normalize( fr_wnorm );
          // A face along world X (or Z) would normalise a zero vector to NaN.
          vec3 fr_T = vec3( 1.0, 0.0, 0.0 ) - fr_W * fr_W.x;
          fr_T = dot( fr_T, fr_T ) > 1e-12 ? normalize( fr_T ) : vec3( 0.0, 0.0, 1.0 );
          vec3 fr_B = vec3( 0.0, 0.0, 1.0 ) - fr_W * fr_W.z;
          fr_B = dot( fr_B, fr_B ) > 1e-12 ? normalize( fr_B ) : vec3( 1.0, 0.0, 0.0 );
          {
            // WORLD normal: the view-space one called a bank facing the camera a cliff.
            vec3 fr_n = fr_W;
            // Which of the three grounds is this? Same two cues the palette
            // uses, so the texture can never disagree with the colour.
            float fr_flat = smoothstep( 0.55, 0.88, abs( fr_n.y ) );
            // World-XZ planar, at two scales whose ratio is not a round number,
            // each hex-tiled so neither repeats across an open field.
            vec2 fr_uvB = fr_wpos.xz / uTile.y;
            vec3 fr_b = fr_hexTex( uDetail, fr_hex( fr_uvB ), fr_uvB, fr_gx / uTile.y, fr_gy / uTile.y ).rgb;

            // BARE GROUND. The vertex weights (chunks.js:_groundColor) say how
            // likely rock or bald soil is; the far tile's creases and blotches
            // decide WHERE, so an outcrop has a crisp, broken edge instead of
            // a 2 m colour ramp.
            float fr_rk = smoothstep( 0.5, 0.62, fr_bare.x + ( fr_b.g - 0.75 ) * 0.5 );
            float fr_sl = smoothstep( 0.42, 0.58, fr_bare.y + ( fr_b.b - 0.76 ) * 0.8 ) * ( 1.0 - fr_rk );
            // Erosion rills: bald streaks running straight down a steep face.
            // The world normal's flat part points downhill; the detail map's
            // streak channel is laid along it, ten times longer than wide.
            float fr_fall = 1.0 - smoothstep( 0.72, 0.94, abs( fr_n.y ) );
            if ( fr_fall > 0.01 ) {
              vec2 fr_dn = normalize( fr_n.xz + vec2( 1e-5, 0.0 ) );
              vec2 fr_q = vec2( dot( fr_wpos.xz, vec2( -fr_dn.y, fr_dn.x ) ) / 7.0, dot( fr_wpos.xz, fr_dn ) / 70.0 );
              float fr_rill = texture2D( uDetail, fr_q ).r;
              fr_sl = max( fr_sl, smoothstep( 0.66, 0.84, fr_rill ) * fr_fall * ( 1.0 - fr_rk ) * 0.85 );
            }
            {
              // Rock: its own grey, lit by the creases, banded in strata on a
              // steep face (a layer every few metres, a darker bedding joint
              // every seven or so), which is what reads as rock from afar.
              float fr_cliff = 1.0 - fr_flat;
              // Crevices dark, faces pale, and a dark rim where the turf meets
              // it (soil and lichen in the joint): without them an outcrop
              // read as grey paint.
              vec3 fr_rc = uRockCol * ( 0.5 + 0.85 * fr_b.g );
              fr_rc *= 1.0 - 0.35 * fr_rk * ( 1.0 - fr_rk ) * 4.0;
              // Lichen and moss on rock that lies flat enough to hold them.
              fr_rc = mix( fr_rc, diffuseColor.rgb * 0.75, 0.3 * fr_flat );
              fr_rc *= 1.0 + 0.12 * sin( fr_wpos.y * 1.3 + fr_b.r * 5.0 ) * fr_cliff;
              fr_rc *= 1.0 - 0.3 * smoothstep( 0.9, 0.985, abs( sin( fr_wpos.y * 0.45 + fr_b.b * 3.0 ) ) ) * fr_cliff;
              // Soil keeps a little of the ground's own cast (red in savanna).
              vec3 fr_sc = mix( uSoilCol, diffuseColor.rgb, 0.25 ) * ( 0.85 + 0.3 * fr_b.b );
              diffuseColor.rgb = mix( diffuseColor.rgb, fr_sc, fr_sl );
              diffuseColor.rgb = mix( diffuseColor.rgb, fr_rc, fr_rk );
            }

            float fr_rock  = max( 1.0 - fr_flat, fr_rk );
            float fr_sward = 1.0 - fr_rock;

            // The near tile and the triplanar rock only matter inside the
            // near-fade distance (and the rock only off the flat), so most of
            // the screen — the far ground — skips them.
            // Both branches are spatially coherent, so they cost nothing.
            float fr_dist = length( fr_wpos - cameraPosition );
            fr_nearW = 1.0 - smoothstep( uNearFade.x, uNearFade.y, fr_dist );
            #ifdef FR_SWARD
            // Turf is green: the relief is the grass's, not the scree's or the snow's.
            float fr_green = smoothstep( 0.0, 0.035, vColor.g - max( vColor.r * 0.85, vColor.b ) );
            fr_sw = fr_green * fr_flat * fr_nearW * ( 1.0 - max( fr_rk, fr_sl ) );
            #ifdef FR_VERGE
            {
              // Across the verge: gravel at the shoulder, thinning as its
              // stones sink into the dirt, then grass. The band's edge wanders
              // with the far tile so it never runs parallel to the road.
              float fr_vd = fr_rd + ( ( fr_b.b - 0.76 ) * 2.5 + ( fr_b.r - 0.8 ) * 1.5 ) * uVerge.z;
              float fr_t = clamp( ( fr_vd - uVerge.x ) / ( uVerge.y - uVerge.x ), 0.0, 1.0 );
              fr_sink = smoothstep( 0.3, 1.0, fr_t ) * 0.7;
              fr_gw = ( 1.0 - smoothstep( 0.55, 1.0, fr_t ) ) * smoothstep( 0.35, 0.7, abs( fr_n.y ) ) * fr_nearW;
              fr_gk = fr_gw / max( fr_gw + fr_sw, 1e-4 );
            }
            #endif
            #endif
            float fr_relief = max( fr_sw, fr_gw );

            vec3 fr_a = vec3( 1.0 );
            float fr_rockA = 1.0;
            // Under turf or verge the near tile is all but replaced: skip it.
            if ( fr_nearW > 0.0 && ( fr_relief < 0.98 || fr_rock > 0.01 ) ) {
              vec2 fr_uvA = fr_wpos.xz / uTile.x;
              fr_a = fr_hexTex( uDetail, fr_hex( fr_uvA ), fr_uvA, fr_gx / uTile.x, fr_gy / uTile.x ).rgb;
              fr_rockA = fr_a.g;
              // Rock on a steep face is sampled TRIPLANAR: a planar XZ map
              // smears into vertical streaks on a cliff. The two side planes
              // are blended by how much the face looks along X or Z.
              if ( fr_rock > 0.01 ) {
                vec3 fr_w3 = pow( abs( fr_n ), vec3( 4.0 ) );
                fr_w3 /= ( fr_w3.x + fr_w3.y + fr_w3.z + 1e-4 );
                fr_rockA = texture2D( uDetail, fr_wpos.zy / uTile.x ).g * fr_w3.x
                         + fr_a.g * fr_w3.y
                         + texture2D( uDetail, fr_wpos.xy / uTile.x ).g * fr_w3.z;
              }
            }
            #ifdef FR_SWARD
            float fr_lit = 1.0;
            if ( max( fr_sw, fr_gw ) > 0.001 ) {
              float fr_fade = 1.0 - smoothstep( uPom.y, uPom.z, fr_dist );
              fr_hexW = 1.0 - fr_fade;
              float fr_depth = mix( uPom.x * fr_green * fr_flat, uVergeDepth, fr_gk ) * fr_fade;
              // PARALLAX OCCLUSION (Tatarchuk 2006): march the view ray down
              // through the heightfield in layers, stop at the first layer
              // under the surface, and interpolate between it and the last
              // one above. Fewer layers looking down than along the ground,
              // and fewer with distance; none past the fade, where the march
              // is skipped outright. Gradients from the unmarched point, so
              // the loop's fetches keep their mip level and stay legal in a loop.
              if ( fr_depth > 0.002 ) {
                vec3 fr_V = normalize( cameraPosition - fr_wpos );
                // Floored: a ray nearly along the ground would march off the tile.
                vec3 fr_tv = vec3( dot( fr_V, fr_T ), dot( fr_V, fr_B ), max( dot( fr_V, fr_W ), 0.16 ) );
                float fr_steps = floor( mix( uPomSteps.y, uPomSteps.x, fr_tv.z ) * ( 0.35 + 0.65 * fr_fade ) );
                vec2 fr_du = -fr_tv.xy / fr_tv.z * fr_depth / fr_steps;
                // One mip coarser than the colour: fewer cache misses, and a
                // blade a texel wide stops flickering in and out of the ray.
                vec2 fr_mx = fr_gx * 2.0, fr_my = fr_gy * 2.0;
                float fr_layer = 1.0 / fr_steps;
                float fr_d = 0.0;
                float fr_h = 1.0 - fr_hAt( fr_mp, fr_gk, fr_sink, fr_mx, fr_my );
                float fr_pd = 0.0, fr_ph = fr_h;
                for ( int i = 0; i < 32; i ++ ) {
                  if ( float( i ) >= fr_steps || fr_d >= fr_h ) break;
                  fr_pd = fr_d; fr_ph = fr_h;
                  fr_mp += fr_du;
                  fr_d += fr_layer;
                  fr_h = 1.0 - fr_hAt( fr_mp, fr_gk, fr_sink, fr_mx, fr_my );
                }
                float fr_after = fr_h - fr_d, fr_before = fr_ph - fr_pd;
                float fr_w = clamp( fr_after / ( fr_after - fr_before - 1e-5 ), 0.0, 1.0 );
                fr_mp -= fr_du * fr_w;
                fr_d -= fr_layer * fr_w;

                // Self-shadow: from the hit, step up toward the sun; any turf
                // or stone standing above that ray shades what is under it.
                #if NUM_DIR_LIGHTS > 0
                if ( uPom.w > 0.0 ) {
                vec3 fr_L = normalize( ( vec4( directionalLights[ 0 ].direction, 0.0 ) * viewMatrix ).xyz );
                vec3 fr_tl = vec3( dot( fr_L, fr_T ), dot( fr_L, fr_B ), max( dot( fr_L, fr_W ), 0.1 ) );
                vec2 fr_lu = fr_tl.xy / fr_tl.z * fr_depth;
                float fr_occ = 0.0;
                for ( int i = 1; i <= 4; i ++ ) {
                  float fr_rd2 = fr_d * ( 1.0 - float( i ) / 4.0 );
                  float fr_sh = 1.0 - fr_hAt( fr_mp + fr_lu * ( fr_d - fr_rd2 ), fr_gk, fr_sink, fr_mx, fr_my );
                  fr_occ = max( fr_occ, ( fr_rd2 - fr_sh ) * ( 1.0 - float( i ) / 5.0 ) );
                }
                fr_lit = 1.0 - clamp( fr_occ * 5.0, 0.0, 1.0 ) * uPom.w * fr_fade;
                }
                #endif
              }
              // Near, the marched texel; past the march, the unmarched point
              // hex-tiled; between, the one fading into the other.
              if ( fr_sw > 0.001 ) {
                vec2 fr_suv = fr_mp / uSwardTile, fr_sgx = fr_gx / uSwardTile, fr_sgy = fr_gy / uSwardTile;
                vec4 fr_s = vec4( 0.0 );
                if ( fr_hexW < 1.0 ) fr_s = textureGrad( uSward, fr_suv, fr_sgx, fr_sgy );
                if ( fr_hexW > 0.0 ) {
                  vec2 fr_u0 = fr_wpos.xz / uSwardTile;
                  fr_s = mix( fr_s, fr_hexTex( uSward, fr_hex( fr_u0 ), fr_u0, fr_sgx, fr_sgy ), fr_hexW );
                }
                // Luminance (mean 1 with its occlusion), occlusion, and dry
                // blades and bare soil toward straw and earth.
                vec3 fr_turf = mix( vec3( 1.0 ), uSwardDry, fr_s.g )
                  * ( fr_s.r * 1.5 * mix( 1.0, fr_s.b, uSwardLook.y ) * fr_lit );
                diffuseColor.rgb *= mix( vec3( 1.0 ), fr_turf, fr_sw * uSwardLook.x );
              }
              #ifdef FR_VERGE
              if ( fr_gw > 0.001 ) {
                vec2 fr_vuv = fr_mp / uVerge.w, fr_vgx = fr_gx / uVerge.w, fr_vgy = fr_gy / uVerge.w;
                float fr_soft = 0.02 + 0.08 * fr_hexW;
                vec4 fr_v = vec4( 0.0 );
                if ( fr_hexW < 1.0 ) fr_v = fr_verge( fr_vuv, fr_vgx, fr_vgy, fr_sink, fr_soft, diffuseColor.rgb );
                if ( fr_hexW > 0.0 ) {
                  vec2 fr_u0 = fr_wpos.xz / uVerge.w;
                  FrHex fr_vh = fr_hex( fr_u0 );
                  vec4 fr_vx = fr_vh.w.x * fr_verge( fr_vh.r0 * fr_u0 + fr_vh.o0, fr_vh.r0 * fr_vgx, fr_vh.r0 * fr_vgy, fr_sink, fr_soft, diffuseColor.rgb )
                             + fr_vh.w.y * fr_verge( fr_vh.r1 * fr_u0 + fr_vh.o1, fr_vh.r1 * fr_vgx, fr_vh.r1 * fr_vgy, fr_sink, fr_soft, diffuseColor.rgb )
                             + fr_vh.w.z * fr_verge( fr_vh.r2 * fr_u0 + fr_vh.o2, fr_vh.r2 * fr_vgx, fr_vh.r2 * fr_vgy, fr_sink, fr_soft, diffuseColor.rgb );
                  fr_v = mix( fr_v, fr_vx, fr_hexW );
                }
                fr_vst = fr_v.a;
                diffuseColor.rgb = mix( diffuseColor.rgb, fr_v.rgb * fr_lit, fr_gw );
              }
              #endif
            }
            #endif

            float fr_gravel = mix( 0.30, 0.85, fr_sl );
            float fr_dA = ( fr_a.r * fr_sward + fr_rockA * fr_rock ) * ( 1.0 - fr_gravel )
                        + fr_a.b * fr_gravel;
            float fr_dB = ( fr_b.r * fr_sward + fr_b.g * fr_rock ) * ( 1.0 - fr_gravel )
                        + fr_b.b * fr_gravel;

            // The near tile carries the grain and has to go before it aliases;
            // the far tile is the one that survives to the horizon. Neither
            // where the relief brings its own.
            float fr_mod = 1.0
              + ( fr_dA - 1.0 ) * uContrast.x * fr_nearW * ( 1.0 - fr_relief )
              + ( fr_dB - 1.0 ) * uContrast.y;
            diffuseColor.rgb *= clamp( fr_mod, 0.55, 1.5 );

            // MACRO: lush and parched stretches hundreds of metres across — the
            // thing a flat-coloured hillside lacks most when seen from afar.
            vec2 fr_uvM = fr_wpos.xz / uMacro;
            vec4 fr_m = fr_hexTex( uMacroMap, fr_hex( fr_uvM ), fr_uvM, fr_gx / uMacro, fr_gy / uMacro );
            float fr_dry = smoothstep( 0.45, 0.85, fr_m.r ) * fr_flat;
            float fr_lush = smoothstep( 0.45, 0.15, fr_m.r ) * fr_flat;
            diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.16, 1.07, 0.80 ), fr_dry * 0.45 );
            diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.86, 1.02, 0.88 ), fr_lush * 0.40 );
            diffuseColor.rgb *= 0.93 + 0.14 * fr_m.g;

            fr_height = ( fr_sward * fr_a.r * ( 1.0 - fr_relief ) + fr_rock * fr_rockA * 1.6 ) * uBump;
          }
        `)
        // Screen-space derivative bump (Mikkelsen 2010, "Bump mapping
        // unparametrized surfaces"): the detail texture's own relief tilts
        // the normal, so clumps and creases catch the low sun. Faded with
        // the near tile, before it can shimmer.
        .replace('#include <normal_fragment_maps>', /* glsl */`
          #include <normal_fragment_maps>
          if ( fr_nearW > 0.001 ) {
            vec3 fr_dpx = dFdx( -vViewPosition );
            vec3 fr_dpy = dFdy( -vViewPosition );
            float fr_hx = dFdx( fr_height ), fr_hy = dFdy( fr_height );
            vec3 fr_r1 = cross( fr_dpy, normal );
            vec3 fr_r2 = cross( normal, fr_dpx );
            float fr_det = dot( fr_dpx, fr_r1 );
            vec3 fr_grad = sign( fr_det ) * ( fr_hx * fr_r1 + fr_hy * fr_r2 );
            normal = normalize( mix( normal, abs( fr_det ) * normal - fr_grad, fr_nearW ) );
          }
          #ifdef FR_SWARD
          // The relief's own normal, at the marched texel (hex-tiled past the
          // march), through the planar frame.
          if ( max( fr_sw, fr_gw ) > 0.001 ) {
            vec2 fr_tn = vec2( 0.0 );
            if ( fr_sw > 0.001 ) {
              vec2 fr_suv = fr_mp / uSwardTile, fr_sgx = fr_gx / uSwardTile, fr_sgy = fr_gy / uSwardTile;
              vec2 fr_n2 = vec2( 0.0 );
              if ( fr_hexW < 1.0 ) fr_n2 = textureGrad( uSwardN, fr_suv, fr_sgx, fr_sgy ).xy * 2.0 - 1.0;
              if ( fr_hexW > 0.0 ) {
                vec2 fr_u0 = fr_wpos.xz / uSwardTile;
                fr_n2 = mix( fr_n2, fr_hexMajor( uSwardN, fr_hex( fr_u0 ), fr_u0, fr_sgx, fr_sgy ).xy, fr_hexW );
              }
              fr_tn = fr_n2 * ( 1.0 - fr_gk );
            }
            #ifdef FR_VERGE
            if ( fr_gw > 0.001 ) {
              vec2 fr_vuv = fr_mp / uVerge.w, fr_vgx = fr_gx / uVerge.w, fr_vgy = fr_gy / uVerge.w;
              vec4 fr_n4 = vec4( 0.0 );
              if ( fr_hexW < 1.0 ) fr_n4 = textureGrad( uVergeN, fr_vuv, fr_vgx, fr_vgy ) * 2.0 - 1.0;
              if ( fr_hexW > 0.0 ) {
                vec2 fr_u0 = fr_wpos.xz / uVerge.w;
                fr_n4 = mix( fr_n4, fr_hexMajor( uVergeN, fr_hex( fr_u0 ), fr_u0, fr_vgx, fr_vgy ), fr_hexW );
              }
              fr_tn += mix( fr_n4.xy, fr_n4.zw, fr_vst ) * fr_gk;
            }
            #endif
            vec3 fr_t3 = vec3( fr_tn, sqrt( max( 1.0 - dot( fr_tn, fr_tn ), 0.0 ) ) );
            vec3 fr_nw = normalize( fr_T * fr_t3.x + fr_B * fr_t3.y + fr_W * fr_t3.z );
            normal = normalize( mix( normal, normalize( ( viewMatrix * vec4( fr_nw, 0.0 ) ).xyz ), max( fr_sw, fr_gw ) ) );
          }
          #endif
        `)
        .replace('#include <lights_fragment_end>', CANOPY_GLSL.apply('fr_wpos'));
    };
    material.customProgramCacheKey = () => `highroads-ground-${sward ? 1 : 0}${verge ? 1 : 0}`;
  }

  return {
    material,
    dispose() {
      material.dispose();
      if (map) map.dispose();
      if (macro) macro.dispose();
      for (const m of [sward, verge]) if (m) { m.albedo.dispose(); m.normal.dispose(); m.height.dispose(); }
    },
  };
}