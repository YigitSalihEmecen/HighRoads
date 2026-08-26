/**
 * env/grass.js — the ground cover, and the shader that makes it affordable.
 *
 * This module owns how a tuft is BUILT and DRAWN. Where the tufts go is
 * chunks.js's job, the same split `foliage.js` already uses: rules and
 * rendering here, placement over there, because placement is the only part that
 * needs the road, the terrain and the streaming.
 *
 * ── why cards and not models ────────────────────────────────────────────────
 *
 * The Quaternius pack ships grass, and it is the wrong tool. `Grass_2` is 192
 * triangles of solid geometry — a beautiful thing to put six of in a diorama,
 * and at the density a roadside needs (tens of thousands in view) it is six
 * million triangles for the grass alone. Measured against the rest of the
 * world, that is fifty times the entire terrain sheet.
 *
 * A tuft here is TWO CROSSED QUADS — four triangles — carrying a texture of
 * seven blades. So one instance is seven blades for four triangles, and the
 * same budget that bought 468 solid trees buys well over a hundred thousand
 * tufts. The crossing is what gives it volume: from any angle you see one card
 * near face-on and one edge-on, and the eye reads the pair as a clump rather
 * than as a picture of grass.
 *
 * ── why the texture is grey ─────────────────────────────────────────────────
 *
 * The card is drawn in LUMINANCE ONLY, dark at the root and bright at the tip.
 * All the hue comes from the per-instance colour, which chunks.js samples from
 * the terrain at the tuft's own position — so grass is green in the lowlands
 * and dry gold on a sunlit shoulder for free, follows the biome mask as it
 * drifts over kilometres, and can never disagree with the ground it stands in.
 * Baking green into the texture would have meant maintaining that agreement by
 * hand, which is the kind of thing that silently stops being true.
 *
 * ── TWO TIERS, and why the far one is not just "more grass" ─────────────────
 *
 * The near field wants tufts you can resolve: 60 cm to 1.4 m, densely enough
 * that crossed cards close into a continuous surface. Extending that outward is
 * not affordable and would not help if it were — at 200 m a 1 m card is four
 * pixels tall, so a hundred thousand of them buy a faint dusting and cost a
 * hundred thousand instances.
 *
 * What reads at 200 m is a *layer*: something with a broken top edge standing
 * proud of the ground, catching light differently from the sheet under it. That
 * needs area, not count. The far tier is therefore the same card at three and a
 * half times the size and a twelfth of the density — a third of the near tier's
 * instance count covering thirty times the ground — and it hands the middle
 * distance over to the terrain's own detail texture (`env/ground.js`) rather
 * than trying to carry it with geometry.
 *
 * The two tiers cross-fade by SCALE, not opacity. The material is an alpha-test
 * cutout (see below) so there is no opacity to fade; a tuft shrinks about its
 * own base instead, which sinks it into the ground rather than dissolving it.
 * The near tier shrinks out between `GRASS.fadeStart` and `fadeEnd`; the far
 * tier grows in over `GRASS.far.fadeIn` and shrinks out again at
 * `GRASS.far.fadeOut`, so a card is never both close enough to look coarse and
 * large enough to notice.
 *
 * ── the two shader jobs ─────────────────────────────────────────────────────
 *
 * WIND is applied in WORLD space, not object space, and that is the whole
 * reason `project_vertex` is replaced rather than `begin_vertex` patched. Tufts
 * are randomly yawed so they do not moiré; displacing them in object space
 * would send each one a different way and the field would shimmer instead of
 * leaning. Displacing after the instance matrix means one gust crosses the
 * whole field together, which is what wind looks like.
 *
 * FADE shrinks a tuft to nothing as it approaches — or recedes from — the band
 * it belongs to. Popping a card out at a distance threshold is visible in
 * exactly the way a car moving toward it makes most obvious.
 */

import * as THREE from 'three';
import { GRASS } from '../config.js';
import { makeCanvas, rng } from './textures.js';

/**
 * Draws the blade card.
 *
 * Seven tapered blades, each a quadratic curve leaning off vertical, drawn as a
 * filled path rather than a stroke so the taper is real geometry in the alpha
 * rather than a line width. The vertical gradient is fake ambient occlusion:
 * the inside of a clump is dark, and without it a field of cards reads as flat
 * cutouts standing on the ground instead of as something with a floor.
 *
 * Returns null where there is no 2D canvas — the headless probes run the
 * placement path without ever needing pixels, and everything downstream treats
 * a missing map as "untextured", not as an error.
 */
function bladeTexture(size, blades, opts = {}) {
  const target = makeCanvas(size);
  if (!target) return null;
  const { canvas, ctx } = target;

  ctx.clearRect(0, 0, size, size);

  // Deterministic: the same card every session, so nothing about the look
  // depends on which frame the texture happened to be built on.
  const rnd = rng(opts.seed || 0x9e3779b9);
  // `long` is the woodland-floor card: every blade reaches most of the way up,
  // leaning further and bowing harder. Roadside rough is short and dense
  // because it is grazed; what grows in a wood is tall and floppy, and drawing
  // it with the same card at a bigger scale gives coarse roadside grass rather
  // than a different plant.
  //
  // The blades are WIDER than the roadside card's, not narrower. The first
  // version halved the root width on the reasoning that long grass is fine, and
  // the tier photographed as a clump of black bristles: a card is read as a
  // surface only when its blades close up, and at 2 m tall a thin blade is a
  // hair with a gap either side of it.
  const long = !!opts.long;
  const tipLo = long ? 0.02 : 0.06;
  const tipHi = long ? 0.16 : 0.42;
  const leanK = long ? 0.52 : 0.34;
  const bowK = long ? 0.34 : 0.22;
  const rootLo = long ? 0.038 : 0.030;
  const rootHi = long ? 0.030 : 0.026;

  for (let i = 0; i < blades; i++) {
    // Spread across the card with jitter, so the blades are not a comb.
    const x = ((i + 0.5) / blades + (rnd() - 0.5) * 0.5) * size;
    const rootW = size * (rootLo + rnd() * rootHi);
    // Tall blades reach the top of the card; short ones fill the gaps between.
    const tipY = size * (tipLo + rnd() * tipHi);
    const lean = (rnd() - 0.5) * size * leanK;
    const bow = (rnd() - 0.5) * size * bowK;

    const tipX = x + lean;
    const midX = x + lean * 0.35 + bow;
    const midY = (size + tipY) * 0.5;

    ctx.beginPath();
    ctx.moveTo(x - rootW, size);
    // Up one side to the tip, back down the other. Control points on the two
    // edges are offset so the blade keeps width through the bend instead of
    // pinching where it curves hardest.
    ctx.quadraticCurveTo(midX - rootW * 0.5, midY, tipX, tipY);
    ctx.quadraticCurveTo(midX + rootW * 0.5, midY, x + rootW, size);
    ctx.closePath();

    // Root dark, tip bright. Per-blade variation keeps neighbours distinct.
    const g = ctx.createLinearGradient(0, size, 0, tipY);
    const v = 0.76 + rnd() * 0.24;
    // Root shade. The first render had this at 0.26, which combined with the
    // geometry's own root shading to leave the bottom of every blade at 11% of
    // the ground colour — so a field read as a dark stripe along the verge
    // rather than as grass growing out of it. Ambient occlusion in a sward is
    // real but gentle.
    // The SAME luminance as the roadside card, and deliberately so. Woodland
    // grass is in shade, but the shade is already in the ground colour the
    // instance takes and in the tint `chunks.js` applies — darkening the card
    // as well multiplies two occlusion terms together and the tier comes out
    // black. That is bug #52, which cost the near tier its first render.
    const root = Math.round(255 * 0.55 * v);
    const tip = Math.round(255 * v);
    g.addColorStop(0, `rgb(${root},${root},${root})`);
    g.addColorStop(0.45, `rgb(${Math.round(tip * 0.84)},${Math.round(tip * 0.84)},${Math.round(tip * 0.84)})`);
    g.addColorStop(1, `rgb(${tip},${tip},${tip})`);
    ctx.fillStyle = g;
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/**
 * Two quads crossed at 90 degrees, standing on y = 0.
 *
 * The `color` attribute is a second, cheaper ambient occlusion on top of the
 * texture's: it is what the per-instance colour gets multiplied INTO, so the
 * root stays dark whatever hue the terrain hands the tuft. It also has to exist
 * for its own sake — `vertexColors` is what makes three consume the instance
 * colour in the fragment shader at all.
 */
function tuftGeometry() {
  const pos = [];
  const uv = [];
  const col = [];
  const idx = [];

  // Root shade, as a fraction of the tip. Matches the texture's gradient so the
  // two reinforce rather than fight.
  const ROOT = 0.78;

  for (let q = 0; q < 2; q++) {
    const a = q * Math.PI * 0.5;
    const dx = Math.cos(a) * 0.5;
    const dz = Math.sin(a) * 0.5;
    const base = q * 4;

    //  3---2      y = 1
    //  |   |
    //  0---1      y = 0
    pos.push(-dx, 0, -dz,  dx, 0, dz,  dx, 1, dz,  -dx, 1, -dz);
    uv.push(0, 0,  1, 0,  1, 1,  0, 1);
    col.push(ROOT, ROOT, ROOT,  ROOT, ROOT, ROOT,  1, 1, 1,  1, 1, 1);
    idx.push(base, base + 1, base + 2,  base, base + 2, base + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  // Normals straight up rather than out of the card face. A grass blade is not
  // a wall: lighting it by its own facing makes half of every clump go black as
  // the camera swings round it. Facing the sky, a field lights as a field.
  const n = [];
  for (let i = 0; i < 8; i++) n.push(0, 1, 0);
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * One tier's material.
 *
 * Both tiers compile to the SAME program — the fade window is a uniform, not a
 * `#define` — so `customProgramCacheKey` returns one string and three links the
 * shader once. What differs between them is only the numbers in `uniforms`,
 * which is per-material state.
 *
 * @param {THREE.Texture|null} map
 * @param {number[]} fadeOut  [start, end] camera distance over which a tuft shrinks away
 * @param {number[]|null} fadeIn  [start, end] over which it grows in, or null for "already there"
 */
function grassMaterial(map, fadeOut, fadeIn) {
  const material = new THREE.MeshStandardMaterial({
    map,
    vertexColors: true,
    // Cut out, not blended. Sixty thousand transparent instances cannot be
    // depth-sorted at any sensible cost, and the artefacts of getting it wrong
    // (cards vanishing through one another) are far worse than a hard edge.
    // `alphaToCoverage` then softens that edge back using the MSAA samples the
    // renderer is already paying for.
    transparent: false,
    alphaTest: 0.42,
    alphaToCoverage: true,
    // Both faces: a card is one-sided geometry standing in for a solid thing,
    // and half a clump disappearing as you drive past it is the giveaway.
    side: THREE.DoubleSide,
    roughness: 0.95,
    metalness: 0.0,
  });

  const uniforms = {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2(GRASS.windDir.x, GRASS.windDir.z).normalize() },
    uWindStrength: { value: GRASS.windStrength },
    uWindSpeed: { value: GRASS.windSpeed },
    uFade: { value: new THREE.Vector2(fadeOut[0], fadeOut[1]) },
    // A window entirely behind the camera means the smoothstep is 1 everywhere,
    // which is exactly "this tier is at full size from zero distance".
    uFadeIn: { value: new THREE.Vector2(fadeIn ? fadeIn[0] : -2, fadeIn ? fadeIn[1] : -1) },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform float uTime;
        uniform vec2  uWind;
        uniform float uWindStrength;
        uniform float uWindSpeed;
        uniform vec2  uFade;
        uniform vec2  uFadeIn;
        vec2 fr_windAt(vec3 p) {
          // Two scales: a slow swell that crosses the field, and a faster
          // ripple on top. One sine alone reads as a machine.
          float a = sin(uTime * uWindSpeed        + p.x * 0.085 + p.z * 0.11);
          float b = sin(uTime * uWindSpeed * 2.7  + p.x * 0.31  - p.z * 0.24) * 0.45;
          // Bias positive: wind blows one way and gusts, it does not oscillate
          // about zero like a metronome.
          return uWind * (0.55 + 0.45 * (a + b)) * uWindStrength;
        }
      `)
      // Shrink to nothing at both ends of the tier's band, about the base. This
      // is object space and uniform in all three axes, so it is safe to fold
      // into `transformed` before the instance matrix touches it.
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        vec3 fr_inst = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
        // Per-tuft jitter on the fade window, from the instance position, so a
        // field thins out over a band instead of retreating as a clean arc.
        float fr_hash = fract( sin( dot( fr_inst.xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
        float fr_d = distance( cameraPosition, fr_inst ) + ( fr_hash - 0.5 ) * 12.0;
        float fr_fade = smoothstep( uFadeIn.x, uFadeIn.y, fr_d )
                      * ( 1.0 - smoothstep( uFade.x, uFade.y, fr_d ) );
        transformed.y *= fr_fade;
        transformed.xz *= clamp(fr_fade * 1.4, 0.0, 1.0);
      `)
      // Wind, in WORLD space — see the file header. This is the stock
      // project_vertex with the world-space displacement spliced in.
      .replace('#include <project_vertex>', /* glsl */`
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        vec4 fr_world = modelMatrix * mvPosition;
        // Quadratic in height: the tip travels, the root does not move at all.
        // Linear here would shear the whole card sideways off its own base.
        float fr_bend = uv.y * uv.y * fr_fade;
        fr_world.xz += fr_windAt( fr_inst ) * fr_bend;
        mvPosition = viewMatrix * fr_world;
        gl_Position = projectionMatrix * mvPosition;
      `);
  };
  // Two materials that compile to different programs must not share a cache
  // key, and three keys `onBeforeCompile` materials by this. These two DO
  // compile to the same program, deliberately.
  material.customProgramCacheKey = () => 'highroads-grass';

  return { material, uniforms };
}

/**
 * Builds everything the grass shares: one geometry, one texture, and one
 * material per tier. Every chunk's InstancedMesh points at these, so the whole
 * field is a handful of draw calls and one texture upload for the session.
 */
export function createGrassAssets({ anisotropy = 1 } = {}) {
  const geometry = tuftGeometry();
  const map = bladeTexture(GRASS.textureSize, GRASS.bladesPerCard);
  if (map) map.anisotropy = anisotropy;

  // The woodland floor gets its own card, not a scaled copy of the roadside
  // one. See `bladeTexture`: it is a different plant, and at 2 m tall the
  // difference is the whole point of having a third tier at all.
  const woodMap = GRASS.wood.enabled
    ? bladeTexture(GRASS.textureSize, GRASS.wood.bladesPerCard,
      { long: true, seed: 0x6c1f0a3d })
    : null;
  if (woodMap) woodMap.anisotropy = anisotropy;

  const near = grassMaterial(map, [GRASS.fadeStart, GRASS.fadeEnd], null);
  const far = grassMaterial(map, GRASS.far.fadeOut, GRASS.far.fadeIn);
  // Gated on the CONFIG, never on whether the texture exists. `bladeTexture`
  // returns null wherever there is no 2D canvas, which is every headless probe
  // — so keying the tier off the map made the whole woodland floor invisible to
  // measurement while it rendered fine in a browser. `src/env/README.md` rule 2.
  const wood = GRASS.wood.enabled
    ? grassMaterial(woodMap, GRASS.wood.fadeOut, null)
    : null;

  return {
    geometry,
    /** The close field: small cards, dense, a band or two either side. */
    material: near.material,
    /** The middle distance: large cards, sparse, out to `GRASS.far.halfExtent`. */
    farMaterial: far.material,
    /** Long shade grass, under the canopy only. Null when switched off. */
    woodMaterial: wood ? wood.material : null,
    /** Advances the wind. Seconds since the run began. */
    setTime(t) {
      near.uniforms.uTime.value = t;
      far.uniforms.uTime.value = t;
      if (wood) wood.uniforms.uTime.value = t;
    },
    dispose() {
      geometry.dispose();
      near.material.dispose();
      far.material.dispose();
      if (wood) wood.material.dispose();
      if (map) map.dispose();
      if (woodMap) woodMap.dispose();
    },
  };
}
