/**
 * env/ground.js — what the terrain sheet is made of, up close.
 *
 * The ground was one flat wash of green. Not because the palette was wrong —
 * `chunks.js:_groundColor` has always graded it by altitude, slope and a
 * low-frequency mottle — but because a vertex colour is the only thing it had
 * to say, and the vertices out past the verge are metres apart. Between them
 * the interpolator draws a perfectly smooth ramp, and a perfectly smooth ramp
 * over an area the size of a field is exactly what "flat green" looks like.
 *
 * Grass geometry fixes the first forty metres and nothing beyond it. What the
 * middle distance needs is BREAK-UP AT A SCALE THE MESH CANNOT CARRY, and the
 * cheapest place to get that is a texture.
 *
 * ── one texture, three surfaces ─────────────────────────────────────────────
 *
 * A tiling RGB map where each channel is a different ground, all of them
 * LUMINANCE — the hue still comes from the vertex colour, exactly as it does
 * for the grass cards, so a change to the palette moves the whole world and
 * there is no second set of colours to keep in step.
 *
 *   R — sward. Fine directional streaks over a clumpy base: the look of a
 *       roadside meadow from far enough away that individual blades have gone.
 *   G — rock. Ridged noise with sharp creases, which is what erosion leaves and
 *       what plain fBm never produces.
 *   B — soil and gravel. Broad blotches plus a fine speckle for grain.
 *
 * The shader picks between them by the surface normal and by the same altitude
 * cue the palette uses, so a cutting face is stone, a shoulder is gravel and a
 * hillside is sward — automatically, and by the same rule that decided the
 * colour there.
 *
 * ── two scales, and why the second one is not optional ──────────────────────
 *
 * A single tiling texture on ground this size repeats visibly. Two samples of
 * the same map at frequencies with an irrational-ish ratio, multiplied, gives
 * a beat pattern whose period is the product of the two — hundreds of metres —
 * for the cost of one extra fetch. The macro sample also carries most of the
 * contrast, so the near tile is the one that fades out with distance rather
 * than shimmering into aliasing.
 *
 * ── the mapping is planar in world XZ, not UV ──────────────────────────────
 *
 * The terrain sheet has no UVs and giving it some would be the wrong answer
 * anyway: it is parameterised in ROAD SPACE, where the columns are 2.4 m apart
 * on the carriageway and 34 m at the corridor edge, so a UV-mapped texture
 * would be stretched thirty-fold across one hillside. World XZ has no such
 * problem, costs two multiplies, and lines up across chunk seams by
 * construction. It stretches on a vertical face — a cliff gets a smeared
 * texture — which is why the rock channel is weighted toward the horizontal
 * component and the whole overlay fades toward flat on the steepest ground.
 */

import * as THREE from 'three';
import { GROUND } from '../config.js';
import { makeCanvas, paint, tileFbm, tileRidged, tileNoise } from './textures.js';

/**
 * Draws the three-channel detail map.
 *
 * Everything is centred on 1.0 and modulates by `GROUND.contrast` in the
 * shader, so a channel that comes out at 0.5 darkens the ground there and one
 * at 1.0 leaves it alone. Keeping the mean near the middle of the byte range is
 * what stops the overlay changing the world's overall brightness when it is
 * switched on.
 */
function detailTexture(size) {
  const target = makeCanvas(size);
  if (!target) return null;

  paint(target, (u, v, out) => {
    // ---- R: sward -------------------------------------------------------
    // Clumps, then fine streaks running across them. The streaks are stretched
    // 5:1 because grass lies down in a direction; isotropic noise here reads as
    // gravel however green you paint it.
    const clump = tileFbm(u, v, 6, 4, 0.55, 11);
    const streak = tileFbm(u * 0.2, v, 5, 3, 0.5, 23);
    const fleck = tileNoise(u * 96, v * 96, 96, 31);
    out[0] = 0.42 + clump * 0.62 + (streak - 0.5) * 0.30 + (fleck - 0.5) * 0.16;

    // ---- G: rock --------------------------------------------------------
    // Ridged, so the creases are lines rather than blobs, with a coarse
    // blockiness under it for bedding planes.
    const crease = tileRidged(u, v, 5, 5, 0.55, 47);
    const block = tileFbm(u, v, 3, 2, 0.5, 59);
    out[1] = 0.34 + crease * 0.74 + (block - 0.5) * 0.26;

    // ---- B: soil and gravel ---------------------------------------------
    // Broad damp/dry blotches plus grain. The grain is at the texel scale on
    // purpose: mipmapping averages it away with distance, which is precisely
    // the behaviour wanted — grain you can see close up, gone by fifty metres.
    const blotch = tileFbm(u, v, 4, 3, 0.5, 71);
    const grit = tileNoise(u * 160, v * 160, 160, 83);
    out[2] = 0.50 + blotch * 0.52 + (grit - 0.5) * 0.34;
    return out;
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
 * The terrain material, with the detail overlay spliced into its fragment
 * shader.
 *
 * A `MeshStandardMaterial` with `vertexColors`, exactly as before — the overlay
 * is a multiply on `diffuseColor` after the vertex colour has been applied, so
 * every existing decision about the palette still holds and this only adds
 * texture to it.
 */
export function createGroundAssets({ anisotropy = 1 } = {}) {
  const map = GROUND.enabled ? detailTexture(GROUND.textureSize) : null;
  if (map) map.anisotropy = anisotropy;

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    // Smooth-shaded, deliberately. Flat shading is what made the landscape read
    // as faceted and cartoonish: it draws every triangle of a 2.4 m mesh as a
    // distinct plate, so a hillside becomes a mosaic no matter how good the
    // underlying field is.
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

      // World position of the fragment. `worldpos_vertex` only defines
      // `worldPosition` when something already wants it, so ask for it here.
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
        // After the vertex colour has landed in diffuseColor, and before
        // lighting: the overlay is an albedo variation, not a light.
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
