/**
 * env/ground.js — the terrain surface, up close.
 *
 * The sheet carries height and colour only. A detail texture and its tiling
 * add break-up at a scale the mesh cannot carry; on grass, near the car, a
 * SWARD heightfield is ray-marched (parallax occlusion mapping) so the turf
 * has depth: tufts that hide the soil behind them, and shadow their own lee.
 */

import * as THREE from 'three';
import { GROUND } from '../config.js';
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

  // One pass of 3x3 smoothing: a march across single-texel spikes shimmers.
  const Hs = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let a = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        a += H[((j + dy) & M) * N + ((i + dx) & M)] * (dx || dy ? (dx && dy ? 1 : 2) : 4);
      }
      Hs[j * N + i] = a / 16;
    }
  }

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
  const tex = (data, format = THREE.RGBAFormat) => {
    const t = new THREE.DataTexture(data, N, N, format);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  };
  // The march reads `height` alone: one byte a fetch, no anisotropy.
  const h = tex(height, THREE.RedFormat);
  h.unpackAlignment = 1;
  return { albedo: tex(albedo), normal: tex(normal), height: h };
}

/** Terrain material with the detail overlay multiplied onto diffuseColor after colour. */
export function createGroundAssets({ anisotropy = 1 } = {}) {
  const map = GROUND.enabled ? detailTexture(GROUND.textureSize) : null;
  if (map) map.anisotropy = anisotropy;
  const macro = GROUND.enabled ? macroTexture(128) : null;
  const S = GROUND.sward;
  const sward = GROUND.enabled && S.enabled ? swardMaps(S.size) : null;
  // Anisotropy only where it shows: the final colour fetch. Every tap of the
  // march would otherwise cost up to that many filtered reads.
  if (sward) {
    sward.albedo.anisotropy = Math.min(anisotropy, S.anisotropy);
    sward.normal.anisotropy = Math.min(anisotropy, 4);
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
  };
  if (sward) material.defines = { FR_SWARD: '' };
  /** Live: the probes flip the march off and on through these. */
  material.userData.uniforms = uniforms;

  if (map && macro) {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      // `worldpos_vertex` only defines worldPosition when something wants it, so ask here.
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          varying vec3 fr_wpos;
          varying vec3 fr_wnorm;
        `)
        .replace('#include <project_vertex>', /* glsl */`
          #include <project_vertex>
          fr_wpos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
          fr_wnorm = mat3( modelMatrix ) * objectNormal;
        `);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          varying vec3 fr_wpos;
          varying vec3 fr_wnorm;
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
        `)
        // After colour_fragment, before lighting: the overlay is albedo, not light.
        .replace('#include <color_fragment>', /* glsl */`
          #include <color_fragment>
          float fr_height = 0.0;      // detail relief for the bump, metres-ish
          float fr_nearW = 0.0;
          // The sward's weight, its marched UV and gradients, and its frame:
          // world X and Z (the planar mapping) laid onto the ground's slope.
          float fr_sw = 0.0;
          vec2 fr_suv = fr_wpos.xz / uSwardTile;
          vec2 fr_sgx = dFdx( fr_suv ), fr_sgy = dFdy( fr_suv );
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
            // World-XZ planar, at two scales whose ratio is not a round number
            // so the tiles beat against each other instead of lining up.
            vec2 fr_uvB = fr_wpos.xz / uTile.y;
            vec3 fr_b = texture2D( uDetail, fr_uvB ).rgb;

            float fr_sward = fr_flat;
            float fr_rock  = 1.0 - fr_flat;

            // The near tile and the triplanar rock only matter inside the
            // near-fade distance (and the rock only off the flat), so most of
            // the screen — the far ground — skips three of the five samples.
            // Both branches are spatially coherent, so they cost nothing.
            float fr_dist = length( fr_wpos - cameraPosition );
            fr_nearW = 1.0 - smoothstep( uNearFade.x, uNearFade.y, fr_dist );
            vec3 fr_a = vec3( 1.0 );
            float fr_rockA = 1.0;
            if ( fr_nearW > 0.0 ) {
              fr_a = texture2D( uDetail, fr_wpos.xz / uTile.x ).rgb;
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
            // Turf is green: the relief is the grass's, not the scree's or the snow's.
            float fr_green = smoothstep( 0.0, 0.035, vColor.g - max( vColor.r * 0.85, vColor.b ) );
            fr_sw = fr_green * fr_flat * fr_nearW;
            float fr_lit = 1.0;
            if ( fr_sw > 0.001 ) {
              float fr_fade = 1.0 - smoothstep( uPom.y, uPom.z, fr_dist );
              float fr_depth = uPom.x * fr_fade * fr_green * fr_flat;
              // PARALLAX OCCLUSION (Tatarchuk 2006): march the view ray down
              // through the heightfield in layers, stop at the first layer
              // under the surface, and interpolate between it and the last
              // one above. Fewer layers looking down than along the ground,
              // and fewer with distance; none past the fade, where the march
              // is skipped outright. Gradients from the unmarched UV, so the
              // loop's fetches keep their mip level and stay legal in a loop.
              if ( fr_depth > 0.002 ) {
                vec3 fr_V = normalize( cameraPosition - fr_wpos );
                // Floored: a ray nearly along the ground would march off the tile.
                vec3 fr_tv = vec3( dot( fr_V, fr_T ), dot( fr_V, fr_B ), max( dot( fr_V, fr_W ), 0.16 ) );
                float fr_steps = floor( mix( uPomSteps.y, uPomSteps.x, fr_tv.z ) * ( 0.35 + 0.65 * fr_fade ) );
                vec2 fr_du = -fr_tv.xy / fr_tv.z * ( fr_depth / uSwardTile ) / fr_steps;
                // One mip coarser than the colour: fewer cache misses, and a
                // blade a texel wide stops flickering in and out of the ray.
                vec2 fr_mx = fr_sgx * 2.0, fr_my = fr_sgy * 2.0;
                float fr_layer = 1.0 / fr_steps;
                float fr_d = 0.0;
                float fr_h = 1.0 - textureGrad( uSwardH, fr_suv, fr_mx, fr_my ).r;
                float fr_pd = 0.0, fr_ph = fr_h;
                for ( int i = 0; i < 32; i ++ ) {
                  if ( float( i ) >= fr_steps || fr_d >= fr_h ) break;
                  fr_pd = fr_d; fr_ph = fr_h;
                  fr_suv += fr_du;
                  fr_d += fr_layer;
                  fr_h = 1.0 - textureGrad( uSwardH, fr_suv, fr_mx, fr_my ).r;
                }
                float fr_after = fr_h - fr_d, fr_before = fr_ph - fr_pd;
                float fr_w = clamp( fr_after / ( fr_after - fr_before - 1e-5 ), 0.0, 1.0 );
                fr_suv -= fr_du * fr_w;
                fr_d -= fr_layer * fr_w;

                // Self-shadow: from the hit, step up toward the sun; any turf
                // standing above that ray shades the soil and blade bases.
                #if NUM_DIR_LIGHTS > 0
                if ( uPom.w > 0.0 ) {
                vec3 fr_L = normalize( ( vec4( directionalLights[ 0 ].direction, 0.0 ) * viewMatrix ).xyz );
                vec3 fr_tl = vec3( dot( fr_L, fr_T ), dot( fr_L, fr_B ), max( dot( fr_L, fr_W ), 0.1 ) );
                vec2 fr_lu = fr_tl.xy / fr_tl.z * ( fr_depth / uSwardTile );
                float fr_occ = 0.0;
                for ( int i = 1; i <= 4; i ++ ) {
                  float fr_rd = fr_d * ( 1.0 - float( i ) / 4.0 );
                  float fr_sh = 1.0 - textureGrad( uSwardH, fr_suv + fr_lu * ( fr_d - fr_rd ), fr_mx, fr_my ).r;
                  fr_occ = max( fr_occ, ( fr_rd - fr_sh ) * ( 1.0 - float( i ) / 5.0 ) );
                }
                fr_lit = 1.0 - clamp( fr_occ * 5.0, 0.0, 1.0 ) * uPom.w * fr_fade;
                }
                #endif
              }
              // Luminance (mean 1 with its occlusion), occlusion, and dry
              // blades and bare soil toward straw and earth.
              vec4 fr_s = textureGrad( uSward, fr_suv, fr_sgx, fr_sgy );
              vec3 fr_turf = mix( vec3( 1.0 ), uSwardDry, fr_s.g )
                * ( fr_s.r * 1.5 * mix( 1.0, fr_s.b, uSwardLook.y ) * fr_lit );
              diffuseColor.rgb *= mix( vec3( 1.0 ), fr_turf, fr_sw * uSwardLook.x );
            }
            #endif

            float fr_gravel = 0.30;
            float fr_dA = ( fr_a.r * fr_sward + fr_rockA * fr_rock ) * ( 1.0 - fr_gravel )
                        + fr_a.b * fr_gravel;
            float fr_dB = ( fr_b.r * fr_sward + fr_b.g * fr_rock ) * ( 1.0 - fr_gravel )
                        + fr_b.b * fr_gravel;

            // The near tile carries the grain and has to go before it aliases;
            // the far tile is the one that survives to the horizon.
            float fr_mod = 1.0
              + ( fr_dA - 1.0 ) * uContrast.x * fr_nearW * ( 1.0 - fr_sw )
              + ( fr_dB - 1.0 ) * uContrast.y;
            diffuseColor.rgb *= clamp( fr_mod, 0.55, 1.5 );

            // MACRO: lush and parched stretches hundreds of metres across — the
            // thing a flat-coloured hillside lacks most when seen from afar.
            vec4 fr_m = texture2D( uMacroMap, fr_wpos.xz / uMacro );
            float fr_dry = smoothstep( 0.45, 0.85, fr_m.r ) * fr_flat;
            float fr_lush = smoothstep( 0.45, 0.15, fr_m.r ) * fr_flat;
            diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.16, 1.07, 0.80 ), fr_dry * 0.45 );
            diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.86, 1.02, 0.88 ), fr_lush * 0.40 );
            diffuseColor.rgb *= 0.93 + 0.14 * fr_m.g;

            fr_height = ( fr_sward * fr_a.r * ( 1.0 - fr_sw ) + fr_rock * fr_rockA * 1.6 ) * uBump;
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
          // The turf's own normal, at the marched texel, through the planar frame.
          if ( fr_sw > 0.001 ) {
            vec3 fr_tn = textureGrad( uSwardN, fr_suv, fr_sgx, fr_sgy ).xyz * 2.0 - 1.0;
            vec3 fr_nw = normalize( fr_T * fr_tn.x + fr_B * fr_tn.y + fr_W * fr_tn.z );
            normal = normalize( mix( normal, normalize( ( viewMatrix * vec4( fr_nw, 0.0 ) ).xyz ), fr_sw ) );
          }
          #endif
        `);
    };
    material.customProgramCacheKey = () => (sward ? 'highroads-ground-sward' : 'highroads-ground');
  }

  return {
    material,
    dispose() {
      material.dispose();
      if (map) map.dispose();
      if (macro) macro.dispose();
      if (sward) { sward.albedo.dispose(); sward.normal.dispose(); sward.height.dispose(); }
    },
  };
}