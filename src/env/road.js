/**
 * env/road.js — the carriageway surface.
 *
 * This module owns what the road looks like. Where the road goes is
 * `path.js`'s job and where its geometry comes from is `chunks.js:_buildRoad`,
 * the same split every other generator in this directory uses.
 *
 * ── what was wrong ──────────────────────────────────────────────────────────
 *
 * The road was a `MeshStandardMaterial` with vertex colours, `roughness: 0.68`,
 * and no map of any kind. Two separate problems come out of that:
 *
 *   FLAT. One colour per vertex over quads metres across, modulated by a single
 *   noise of `s` at a 33 m period. Nothing varies across the lane, nothing
 *   varies at the scale a driver is actually looking at, and asphalt is a
 *   composite of aggregate in bitumen — its whole appearance is a random
 *   distribution of stones two to ten millimetres across.
 *
 *   SHINY. Dry asphalt is about 0.92-0.98 rough. At 0.68, under a low sun and
 *   `NeutralToneMapping`, the specular lobe is wide enough to put a sheen down
 *   the whole carriageway, which reads as wet or as plastic.
 *
 * ── the approach ────────────────────────────────────────────────────────────
 *
 * The same one `env/ground.js` uses, for the same reasons, and the header there
 * is worth reading alongside this one.
 *
 * WORLD-XZ PLANAR, not UVs. The road geometry has no `uv` attribute and adding
 * one is possible — `_buildRoad` has arc length and lateral offset right there
 * in its loop — but it buys nothing here. Asphalt grain is isotropic; there is
 * no direction for a UV to follow. Planar mapping also lines up across chunk
 * seams by construction rather than by bookkeeping, which is one whole class of
 * bug not written.
 *
 * TWO TILE SCALES, multiplied, at a ratio that is not a round number so they
 * beat against each other instead of lining up into a visible grid. The near
 * one carries the aggregate and is faded out with distance before it aliases;
 * the far one carries patch and repair and survives to the horizon.
 *
 * LUMINANCE, NOT COLOUR. The texture is a modulation mask centred on 1.0 and
 * applied after `#include <color_fragment>`, so the vertex colours — which are
 * the only thing that knows where the lane markings are — land first and are
 * multiplied rather than replaced.
 *
 * ── the markings ────────────────────────────────────────────────────────────
 *
 * The lane lines are not a texture. They are geometry: `buildRoadColumns`
 * emits duplicated columns at each stripe edge and tags them, and the dashes
 * are doubled rows. They share this mesh and this material, so anything done
 * here happens to them too.
 *
 * That would put aggregate grain over the paint, which is wrong — paint is a
 * smooth film laid ON the aggregate — so the overlay is damped where the vertex
 * colour is bright. No attribute is needed to find them: `TERRAIN_COLORS.paint`
 * is 0xe9e3d2 against an asphalt that never modulates past about 0x4a, so
 * luminance separates them with a wide margin. The paint gets its own, much
 * gentler wear instead.
 *
 * ── triangle and texture budget ─────────────────────────────────────────────
 *
 * One 512 texture, three channels, built once at boot. No geometry at all.
 */

import * as THREE from 'three';
import { ROAD_SURFACE } from '../config.js';
import { makeCanvas, rng, tileFbm, tileRidged, paint } from './textures.js';

/**
 * The asphalt mask. Three channels, every one centred on 1.0 so that a channel
 * left at 1.0 is a no-op:
 *
 *   R  aggregate — the stones. High-frequency, near-white noise with a hard
 *      speckle on top, because the thing that reads as asphalt at two metres is
 *      individual chips catching the light rather than a smooth gradient.
 *   G  wear — the low-frequency story: patches, repairs, the polished bands
 *      where tyres have run. Broad and gentle.
 *   B  cracks — ridged noise, thresholded. Ridged is the right primitive here
 *      for the same reason `env/rocks.js` uses it: its ridges are lines, and a
 *      crack is a line.
 */
function asphaltTexture(size) {
  const target = makeCanvas(size);
  if (!target) return null;

  const rnd = rng(0x5eed4a5f);
  // Pre-rolled speckle. Doing this per pixel inside `paint` would sample a
  // different chip every frame the texture is rebuilt; it has to be a function
  // of position, so it is baked into a lattice and sampled.
  const CHIPS = 512;
  const chip = new Float32Array(CHIPS * CHIPS);
  for (let i = 0; i < chip.length; i++) chip[i] = rnd();

  paint(target, (u, v, out) => {
    // Aggregate. Two octaves of fine noise for the bed, plus a chip lattice
    // that is either lit or not — the bimodal part is what makes it read as
    // stones in bitumen rather than as fog.
    const bed = tileFbm(u, v, 96, 3, 0.55, 11.3);
    const ci = (Math.floor(v * CHIPS) * CHIPS + Math.floor(u * CHIPS)) % chip.length;
    const c = chip[ci];
    const lit = c > 0.82 ? (c - 0.82) / 0.18 : 0;
    const dark = c < 0.13 ? (0.13 - c) / 0.13 : 0;
    out[0] = 1 + (bed - 0.5) * 0.34 + lit * 0.46 - dark * 0.30;

    // Wear: broad patches, and a slow mottle over them.
    const patch = tileFbm(u, v, 5, 3, 0.5, 71.9);
    const mottle = tileFbm(u, v, 17, 2, 0.5, 22.1);
    out[1] = 1 + (patch - 0.5) * 0.30 + (mottle - 0.5) * 0.14;

    // Cracks. Ridged noise is near 1 along its ridges; keep only the top of it
    // so what survives is a thin network rather than a marbled wash.
    const r = tileRidged(u, v, 9, 4, 0.6, 44.7);
    const crack = Math.max(0, r - ROAD_SURFACE.crackThreshold) /
      Math.max(0.01, 1 - ROAD_SURFACE.crackThreshold);
    out[2] = 1 - crack * ROAD_SURFACE.crackDepth;
  });

  const tex = new THREE.CanvasTexture(target.canvas);
  // NOT sRGB. This is a modulation mask, not a colour: decoding it as sRGB
  // would bend the midpoint and the overlay would darken everything.
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/**
 * @param {{anisotropy?: number}} opts
 * @returns {{material: THREE.Material, dispose: function}}
 */
export function createRoadAssets({ anisotropy = 1 } = {}) {
  const map = asphaltTexture(ROAD_SURFACE.textureSize);
  if (map) map.anisotropy = anisotropy;

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    // Dry asphalt, not wet asphalt. The old 0.68 put a specular sheen down the
    // whole carriageway under a low sun; the aggregate below now supplies what
    // little variation the highlight should have.
    roughness: ROAD_SURFACE.roughness,
    metalness: 0.0,
    // Unchanged, and load-bearing: this plus `chunks.js:ROAD_LIFT` is what
    // keeps the ribbon off the terrain sheet it lies on.
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
        // Roughness AFTER its own include, or the map would be overwritten.
        // Polished wheel paths are the one place a road is legitimately shiny,
        // and having them makes the rest read as properly matte by contrast.
        .replace('#include <roughnessmap_fragment>', /* glsl */`
          #include <roughnessmap_fragment>
          {
            vec3 fr_w = texture2D( uSurface, fr_wpos.xz / uTile.y ).rgb;
            roughnessFactor = clamp(
              roughnessFactor - ( fr_w.g - 1.0 ) * uPolish, 0.55, 1.0 );
          }
        `);
    };
    // Its OWN key. Sharing `highroads-ground`'s would hand this material that
    // material's compiled program.
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
