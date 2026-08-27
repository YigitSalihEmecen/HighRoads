/**
 * env/road.js — the carriageway surface.
 *
 * Where the road goes is path.js's job; the geometry is chunks.js's. This
 * module draws the look: lane texture, edge lines and crown, not flat paint
 * on the sheet.
 */

import * as THREE from 'three';
import { ROAD_SURFACE } from '../config.js';
import { makeCanvas, rng, tileFbm, tileRidged, paint } from './textures.js';

/**
 * Asphalt mask, three channels each centred on 1.0 so a channel at 1.0 is a
 * no-op: R aggregate, G wear, B cracks (ridged and thresholded — a crack is a line).
 */
function asphaltTexture(size) {
  const target = makeCanvas(size);
  if (!target) return null;

  const rnd = rng(0x5eed4a5f);
  // Speckle pre-baked into a lattice, so it is a function of position not frame.
  const CHIPS = 512;
  const chip = new Float32Array(CHIPS * CHIPS);
  for (let i = 0; i < chip.length; i++) chip[i] = rnd();

  paint(target, (u, v, out) => {
    // Aggregate: fine-noise bed plus a bimodal chip lattice — stones, not fog.
    const bed = tileFbm(u, v, 96, 3, 0.55, 11.3);
    const ci = (Math.floor(v * CHIPS) * CHIPS + Math.floor(u * CHIPS)) % chip.length;
    const c = chip[ci];
    const lit = c > 0.82 ? (c - 0.82) / 0.18 : 0;
    const dark = c < 0.13 ? (0.13 - c) / 0.13 : 0;
    out[0] = 1 + (bed - 0.5) * 0.34 + lit * 0.46 - dark * 0.30;

    // Wear: broad patches, with a slow mottle over them.
    const patch = tileFbm(u, v, 5, 3, 0.5, 71.9);
    const mottle = tileFbm(u, v, 17, 2, 0.5, 22.1);
    out[1] = 1 + (patch - 0.5) * 0.30 + (mottle - 0.5) * 0.14;

    // Ridged noise is ~1 along its ridges; threshold to a thin network, not a wash.
    const r = tileRidged(u, v, 9, 4, 0.6, 44.7);
    const crack = Math.max(0, r - ROAD_SURFACE.crackThreshold) /
      Math.max(0.01, 1 - ROAD_SURFACE.crackThreshold);
    out[2] = 1 - crack * ROAD_SURFACE.crackDepth;
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

export function createRoadAssets({ anisotropy = 1 } = {}) {
  const map = asphaltTexture(ROAD_SURFACE.textureSize);
  if (map) map.anisotropy = anisotropy;

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    // Dry asphalt: the old 0.68 read wet under a low sun.
    roughness: ROAD_SURFACE.roughness,
    metalness: 0.0,
    // Load-bearing: with `chunks.js:ROAD_LIFT` this keeps the ribbon off the sheet.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const uniforms = {
    uSurface: { value: map },
    uTile: { value: new THREE.Vector2(ROAD_SURFACE.tileNear, ROAD_SURFACE.tileFar) },
    uContrast: {
      value: new THREE.Vector2(ROAD_SURFACE.contrastNear, ROAD_SURFACE.contrastFar),
    },
    uNearFade: {
      value: new THREE.Vector2(ROAD_SURFACE.nearFade[0], ROAD_SURFACE.nearFade[1]),
    },
    uPolish: { value: ROAD_SURFACE.polish },
  };

  if (map) {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

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
          uniform sampler2D uSurface;
          uniform vec2 uTile;
          uniform vec2 uContrast;
          uniform vec2 uNearFade;
          uniform float uPolish;
        `)
        .replace('#include <color_fragment>', /* glsl */`
          #include <color_fragment>
          {
            vec2 fr_uvA = fr_wpos.xz / uTile.x;
            vec2 fr_uvB = fr_wpos.xz / uTile.y;
            vec3 fr_a = texture2D( uSurface, fr_uvA ).rgb;
            vec3 fr_b = texture2D( uSurface, fr_uvB ).rgb;

            // Is this fragment paint or asphalt? The markings are geometry in
            // this same mesh carrying a much brighter vertex colour, and no
            // attribute is needed to tell them apart — paint is 0xe9e3d2 and
            // asphalt never modulates past about 0x4a.
            float fr_lum = dot( vColor, vec3( 0.30, 0.59, 0.11 ) );
            float fr_isPaint = smoothstep( 0.34, 0.55, fr_lum );

            // Aggregate near, patch and repair far. The near tile carries the
            // grain and has to go before it aliases into a shimmer.
            float fr_dist = length( fr_wpos - cameraPosition );
            float fr_nearW = 1.0 - smoothstep( uNearFade.x, uNearFade.y, fr_dist );
            float fr_grain = ( fr_a.r - 1.0 ) * uContrast.x * fr_nearW;
            float fr_wear  = ( fr_b.g - 1.0 ) * uContrast.y;
            float fr_crack = ( min( fr_a.b, fr_b.b ) - 1.0 ) * fr_nearW;

            // Paint takes the wear and the cracks — a worn line is most of what
            // makes a road look used — but not the aggregate, because paint is
            // a film laid ON the stones and not made of them.
            float fr_mod = 1.0
              + fr_grain * ( 1.0 - fr_isPaint )
              + fr_wear  * mix( 1.0, 0.55, fr_isPaint )
              + fr_crack * mix( 1.0, 0.7, fr_isPaint );
            diffuseColor.rgb *= clamp( fr_mod, 0.55, 1.45 );
          }
        `)
        // Applied AFTER the roughnessmap include, or the map would be overwritten.
        .replace('#include <roughnessmap_fragment>', /* glsl */`
          #include <roughnessmap_fragment>
          {
            vec3 fr_w = texture2D( uSurface, fr_wpos.xz / uTile.y ).rgb;
            roughnessFactor = clamp(
              roughnessFactor - ( fr_w.g - 1.0 ) * uPolish, 0.55, 1.0 );
          }
        `);
    };
    // Its own key — sharing ground's would hand this material ground's program.
    material.customProgramCacheKey = () => 'highroads-road';
  }

  return {
    material,
    dispose() {
      if (map) map.dispose();
      material.dispose();
    },
  };
}