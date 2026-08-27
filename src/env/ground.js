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

/** Terrain material with the detail overlay multiplied onto diffuseColor after colour. */
export function createGroundAssets({ anisotropy = 1 } = {}) {
  const map = GROUND.enabled ? detailTexture(GROUND.textureSize) : null;
  if (map) map.anisotropy = anisotropy;

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
  };

  if (map) {
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
        `)
        // After colour_fragment, before lighting: the overlay is albedo, not light.
        .replace('#include <color_fragment>', /* glsl */`
          #include <color_fragment>
          {
            vec3 fr_n = normalize( vNormal );
            // Which of the three grounds is this? Same two cues the palette
            // uses, so the texture can never disagree with the colour.
            float fr_flat = smoothstep( 0.55, 0.88, abs( fr_n.y ) );
            // World-XZ planar, at two scales whose ratio is not a round number
            // so the tiles beat against each other instead of lining up.
            vec2 fr_uvA = fr_wpos.xz / uTile.x;
            vec2 fr_uvB = fr_wpos.xz / uTile.y;
            vec3 fr_a = texture2D( uDetail, fr_uvA ).rgb;
            vec3 fr_b = texture2D( uDetail, fr_uvB ).rgb;

            // Sward on flat ground, rock on steep; gravel rides underneath both
            // and is what keeps a verge from looking like a lawn.
            float fr_sward = fr_flat;
            float fr_rock  = 1.0 - fr_flat;
            float fr_gravel = 0.34;
            float fr_dA = ( fr_a.r * fr_sward + fr_a.g * fr_rock ) * ( 1.0 - fr_gravel )
                        + fr_a.b * fr_gravel;
            float fr_dB = ( fr_b.r * fr_sward + fr_b.g * fr_rock ) * ( 1.0 - fr_gravel )
                        + fr_b.b * fr_gravel;

            // The near tile carries the grain and has to go before it aliases;
            // the far tile is the one that survives to the horizon.
            float fr_dist = length( fr_wpos - cameraPosition );
            float fr_nearW = 1.0 - smoothstep( uNearFade.x, uNearFade.y, fr_dist );
            float fr_mod = 1.0
              + ( fr_dA - 1.0 ) * uContrast.x * fr_nearW
              + ( fr_dB - 1.0 ) * uContrast.y;
            diffuseColor.rgb *= clamp( fr_mod, 0.55, 1.5 );
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
    },
  };
}