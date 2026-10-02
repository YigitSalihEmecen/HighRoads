/**
 * env/ground.js — the terrain surface, up close.
 *
 * The sheet carries height and colour only. A detail texture and its tiling
 * add break-up at a scale the mesh cannot carry.
 */

import * as THREE from 'three';
import { GROUND } from '../config.js';
import { makeCanvas, paint, tileFbm, tileRidged, tileNoise } from './textures.js';

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

/** Terrain material with the detail overlay multiplied onto diffuseColor after colour. */
export function createGroundAssets({ anisotropy = 1 } = {}) {
  const map = GROUND.enabled ? detailTexture(GROUND.textureSize) : null;
  if (map) map.anisotropy = anisotropy;
  const macro = GROUND.enabled ? macroTexture(128) : null;

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
  };

  if (map && macro) {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      // `worldpos_vertex` only defines worldPosition when something wants it, so ask here.
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          varying vec3 fr_wpos;
        `)
        .replace('#include <project_vertex>', /* glsl */`
          #include <project_vertex>
          fr_wpos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        `);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          varying vec3 fr_wpos;
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
          {
            vec3 fr_n = normalize( vNormal );
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
            float fr_gravel = 0.30;
            float fr_dA = ( fr_a.r * fr_sward + fr_rockA * fr_rock ) * ( 1.0 - fr_gravel )
                        + fr_a.b * fr_gravel;
            float fr_dB = ( fr_b.r * fr_sward + fr_b.g * fr_rock ) * ( 1.0 - fr_gravel )
                        + fr_b.b * fr_gravel;

            // The near tile carries the grain and has to go before it aliases;
            // the far tile is the one that survives to the horizon.
            float fr_mod = 1.0
              + ( fr_dA - 1.0 ) * uContrast.x * fr_nearW
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

            fr_height = ( fr_sward * fr_a.r + fr_rock * fr_rockA * 1.6 ) * uBump;
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
        `);
    };
    material.customProgramCacheKey = () => 'highroads-ground';
  }

  return {
    material,
    dispose() {
      material.dispose();
      if (map) map.dispose();
      if (macro) macro.dispose();
    },
  };
}