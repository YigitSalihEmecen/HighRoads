/**
 * env/grass.js — ground cover and the shader that makes it affordable.
 *
 * A tuft is one instanced card drawn as several blades. This file builds and
 * draws tufts; chunks.js decides where they go.
 */

import * as THREE from 'three';
import { GRASS } from '../config.js';
import { makeCanvas, rng } from './textures.js';

/** Draws the blade card: tapered blades, root-dark AO gradient; null without a 2D canvas. */
function bladeTexture(size, blades, opts = {}) {
  const target = makeCanvas(size);
  if (!target) return null;
  const { canvas, ctx } = target;

  ctx.clearRect(0, 0, size, size);

  const rnd = rng(opts.seed || 0x9e3779b9);
  // `long` is the woodland card: tall floppy blades whose wide roots keep them
  // reading as blades at 2 m, not as black hairs.
  const long = !!opts.long;
  const tipLo = long ? 0.02 : 0.06;
  const tipHi = long ? 0.16 : 0.42;
  const leanK = long ? 0.52 : 0.34;
  const bowK = long ? 0.34 : 0.22;
  const rootLo = long ? 0.038 : 0.030;
  const rootHi = long ? 0.030 : 0.026;

  for (let i = 0; i < blades; i++) {
    const x = ((i + 0.5) / blades + (rnd() - 0.5) * 0.5) * size;
    const rootW = size * (rootLo + rnd() * rootHi);
    const tipY = size * (tipLo + rnd() * tipHi);
    const lean = (rnd() - 0.5) * size * leanK;
    const bow = (rnd() - 0.5) * size * bowK;

    const tipX = x + lean;
    const midX = x + lean * 0.35 + bow;
    const midY = (size + tipY) * 0.5;

    ctx.beginPath();
    ctx.moveTo(x - rootW, size);
    // Control points offset on each edge so the blade keeps width through the bend.
    ctx.quadraticCurveTo(midX - rootW * 0.5, midY, tipX, tipY);
    ctx.quadraticCurveTo(midX + rootW * 0.5, midY, x + rootW, size);
    ctx.closePath();

    const g = ctx.createLinearGradient(0, size, 0, tipY);
    const v = 0.76 + rnd() * 0.24;
    // Root shade is gentle AO; heavy it and the verge reads as a dark stripe.
    // Same luminance as the roadside card — extra darkening multiplies occlusion to black.
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

/** Two crossed quads on y = 0; the colour attribute is second, cheaper AO. */
function tuftGeometry() {
  const pos = [];
  const uv = [];
  const col = [];
  const idx = [];

  // Root shade as a fraction of the tip, matching the texture's gradient.
  const ROOT = 0.78;

  for (let q = 0; q < 2; q++) {
    const a = q * Math.PI * 0.5;
    const dx = Math.cos(a) * 0.5;
    const dz = Math.sin(a) * 0.5;
    const base = q * 4;

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
  // Normals point up, not out of the card: facing-light blackens half of every clump.
  const n = [];
  for (let i = 0; i < 8; i++) n.push(0, 1, 0);
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
  geo.computeBoundingSphere();
  return geo;
}

/** One tier's material; the fade window is a uniform, so both tiers link one program. */
function grassMaterial(map, fadeOut, fadeIn) {
  const material = new THREE.MeshStandardMaterial({
    map,
    vertexColors: true,
    // Cutout, not blend: transparent instancing cannot be depth-sorted; alphaToCoverage softens the edge.
    transparent: false,
    alphaTest: 0.42,
    alphaToCoverage: true,
    // Double-sided: a card is one-sided geometry standing in for a solid clump.
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
    // A window fully behind the camera makes the smoothstep 1: full size from zero distance.
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
      // Shrink to nothing at both ends of the tier's band, about the base.
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
      // Wind in world space, after the instance matrix — see the header.
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
  // One cache key for both tiers: they compile to the same program, deliberately.
  material.customProgramCacheKey = () => 'highroads-grass';

  return { material, uniforms };
}

/**
 * Shared per-session assets: one geometry, one texture, one material per tier,
 * so the whole field is a handful of draw calls.
 */
export function createGrassAssets({ anisotropy = 1 } = {}) {
  const geometry = tuftGeometry();
  const map = bladeTexture(GRASS.textureSize, GRASS.bladesPerCard);
  if (map) map.anisotropy = anisotropy;

  // The woodland floor gets its own card: a different plant, not a scaled copy.
  const woodMap = GRASS.wood.enabled
    ? bladeTexture(GRASS.textureSize, GRASS.wood.bladesPerCard,
      { long: true, seed: 0x6c1f0a3d })
    : null;
  if (woodMap) woodMap.anisotropy = anisotropy;

  const near = grassMaterial(map, [GRASS.fadeStart, GRASS.fadeEnd], null);
  const far = grassMaterial(map, GRASS.far.fadeOut, GRASS.far.fadeIn);
  // Gated on the CONFIG, not the map: headless probes have no 2D canvas.
  const wood = GRASS.wood.enabled
    ? grassMaterial(woodMap, GRASS.wood.fadeOut, null)
    : null;

  return {
    geometry,
    /** Near tier: small cards, dense, a band or two either side. */
    material: near.material,
    /** Far tier: large cards, sparse, out to `GRASS.far.halfExtent`. */
    farMaterial: far.material,
    /** Long shade grass, under the canopy only. Null when switched off. */
    woodMaterial: wood ? wood.material : null,
    /** Sets the wind clock — seconds since the run began. */
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