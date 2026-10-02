/**
 * env/grass.js — ground cover and the shader that makes it affordable.
 *
 * A tuft is one instanced card drawn as several blades. This file builds and
 * draws tufts; chunks.js decides where they go.
 */

import * as THREE from 'three';
import { GRASS } from '../config.js';
import { makeCanvas, rng } from './textures.js';

/**
 * The ground-cover ATLAS: four tuft kinds in a 2 × 2 sheet, so one material,
 * one program and one draw per tier still covers them all (trap 27):
 *
 *   0 meadow   short, broad, soft blades — the sward
 *   1 seed     tall thin stems with seed heads — rough grass, savanna
 *   2 flower   blades with flower heads
 *   3 clover   a low clump of round leaves — lawn, verge, shade
 *
 * Channels: R = luminance (all hue comes from the instance), G = a HEAD mask
 * (1 where a flower or seed head is painted), A = coverage. The shader colours
 * heads with the instance's `aBloom` and everything else with its ground
 * colour, so a flower has a green stem and a coloured head.
 */
export const GRASS_KINDS = { meadow: 0, seed: 1, flower: 2, clover: 3 };

function atlasTexture(cell, opts = {}) {
  const target = makeCanvas(cell * 2);
  if (!target) return null;
  const { canvas, ctx } = target;
  ctx.clearRect(0, 0, cell * 2, cell * 2);
  const rnd = rng(opts.seed || 0x5f3759df);
  const long = !!opts.long;

  const blade = (ox, oy, x, rootW, tipY, lean, bow, v) => {
    const size = cell;
    const tipX = x + lean;
    const midX = x + lean * 0.35 + bow;
    const midY = (size + tipY) * 0.5;
    ctx.beginPath();
    ctx.moveTo(ox + x - rootW, oy + size);
    ctx.quadraticCurveTo(ox + midX - rootW * 0.5, oy + midY, ox + tipX, oy + tipY);
    ctx.quadraticCurveTo(ox + midX + rootW * 0.5, oy + midY, ox + x + rootW, oy + size);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, oy + size, 0, oy + tipY);
    // Root-to-tip shading. (The "black bristles" were never this gradient —
    // they were back faces lit from below; see the normal override.)
    const root = Math.round(255 * 0.58 * v), mid = Math.round(255 * 0.86 * v), tip = Math.round(255 * v);
    g.addColorStop(0, `rgb(${root},0,0)`);
    g.addColorStop(0.45, `rgb(${mid},0,0)`);
    g.addColorStop(1, `rgb(${tip},0,0)`);
    ctx.fillStyle = g;
    ctx.fill();
    return [ox + tipX, oy + tipY];
  };
  const head = (x, y, r, petals) => {
    ctx.fillStyle = 'rgb(255,255,0)';
    if (petals) {
      for (let k = 0; k < petals; k++) {
        const a = (k / petals) * Math.PI * 2;
        ctx.beginPath();
        ctx.ellipse(x + Math.cos(a) * r * 0.7, y + Math.sin(a) * r * 0.7, r * 0.55, r * 0.35, a, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = 'rgb(200,255,0)';
      ctx.beginPath(); ctx.arc(x, y, r * 0.35, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.beginPath(); ctx.ellipse(x, y, r * 0.45, r, 0, 0, Math.PI * 2); ctx.fill();
    }
  };

  // 0 meadow (top-left): broad soft blades
  {
    const n = long ? 7 : 9;
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n + (rnd() - 0.5) * 0.4) * cell;
      blade(0, 0, x, cell * (0.040 + rnd() * 0.030), cell * ((long ? 0.02 : 0.10) + rnd() * (long ? 0.16 : 0.36)),
        (rnd() - 0.5) * cell * 0.36, (rnd() - 0.5) * cell * 0.22, 0.80 + rnd() * 0.2);
    }
  }
  // 1 seed grass (top-right): tall thin stems, seed heads
  {
    const n = 8;
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n + (rnd() - 0.5) * 0.4) * cell;
      const tall = rnd() < 0.55;
      const [hx, hy] = blade(cell, 0, x, cell * (0.018 + rnd() * 0.014), cell * (tall ? 0.06 + rnd() * 0.10 : 0.30 + rnd() * 0.25),
        (rnd() - 0.5) * cell * 0.30, (rnd() - 0.5) * cell * 0.18, 0.82 + rnd() * 0.18);
      if (tall) head(hx, hy + cell * 0.05, cell * 0.035, 0);
    }
  }
  // 2 flower (bottom-left): blades with flower heads
  {
    const n = 6;
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n + (rnd() - 0.5) * 0.4) * cell;
      blade(0, cell, x, cell * (0.030 + rnd() * 0.02), cell * (0.30 + rnd() * 0.35),
        (rnd() - 0.5) * cell * 0.3, (rnd() - 0.5) * cell * 0.2, 0.8 + rnd() * 0.2);
    }
    for (let i = 0; i < 4; i++) {
      const x = ((i + 0.5) / 4 + (rnd() - 0.5) * 0.25) * cell;
      const [hx, hy] = blade(0, cell, x, cell * 0.012, cell * (0.06 + rnd() * 0.12), (rnd() - 0.5) * cell * 0.1, 0, 0.85);
      head(hx, hy, cell * (0.07 + rnd() * 0.03), 5 + Math.floor(rnd() * 3));
    }
  }
  // 3 clover (bottom-right): round leaves low down
  {
    for (let i = 0; i < 16; i++) {
      const x = cell + (0.12 + rnd() * 0.76) * cell;
      const y = cell + (0.55 + rnd() * 0.4) * cell;
      const r = cell * (0.06 + rnd() * 0.04);
      const v = Math.round(255 * (0.75 + rnd() * 0.25));
      ctx.fillStyle = `rgb(${v},0,0)`;
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + rnd();
        ctx.beginPath(); ctx.arc(x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8, r * 0.75, 0, Math.PI * 2); ctx.fill();
      }
    }
    for (let i = 0; i < 4; i++) {
      blade(cell, cell, (0.1 + rnd() * 0.8) * cell, cell * 0.03, cell * (0.35 + rnd() * 0.3),
        (rnd() - 0.5) * cell * 0.3, 0, 0.85);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  // Data, not colour: luminance and a mask.
  tex.colorSpace = THREE.NoColorSpace;
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
        attribute float aKind;
        attribute vec3 aBloom;
        varying vec2 vAtlas;
        varying vec3 vBloom;
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
      .replace('#include <uv_vertex>', /* glsl */`
        #include <uv_vertex>
        // Atlas cell from the instance's kind: 0 TL, 1 TR, 2 BL, 3 BR. The
        // canvas is y-down and the texture flipped, so "top" is v in 0.5..1.
        float fr_k = floor(aKind + 0.5);
        vec2 fr_cell = vec2(mod(fr_k, 2.0), 1.0 - floor(fr_k / 2.0));
        vAtlas = (fr_cell + clamp(uv, 0.01, 0.99)) * 0.5;
        vBloom = aBloom;
      `)
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
  // Fragment: sample the atlas cell; R is luminance, G the head mask.
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader) => {
    prev(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vAtlas;
        varying vec3 vBloom;`)
      .replace('#include <map_fragment>', /* glsl */`
        vec4 fr_t = texture2D( map, vAtlas );
        // Un-premultiply: the canvas stores transparent texels as black, so
        // every mip level averages each blade's edge toward zero and a thin
        // blade at distance went dark — the "black bristles". Dividing by the
        // coverage the mip also averaged puts the luminance back.
        fr_t.rg /= max( fr_t.a, 0.06 );
        diffuseColor.a *= fr_t.a;
      `)
      // A tuft's normal is straight UP on both faces. Double-sided, three
      // flips it on the back face, and half of every field — every card seen
      // from behind — was lit from BELOW: the real cause of grass reading as
      // black bristles (bugs #52 and the "known rough" note both chased the
      // colour, which was never the problem).
      .replace('#include <normal_fragment_begin>', /* glsl */`
        float faceDirection = 1.0;
        vec3 normal = normalize( vNormal );
        vec3 nonPerturbedNormal = normal;
      `)
      // color_fragment runs AFTER map_fragment and would multiply the head by
      // the ground colour too; the body takes vColor (root AO x instance
      // colour), the head takes the instance's bloom.
      .replace('#include <color_fragment>', /* glsl */`
        // Sun-caught tips: the brightest part of each blade warms slightly.
        vec3 fr_body = diffuseColor.rgb * vColor * fr_t.r * mix( vec3( 1.0 ), vec3( 1.10, 1.08, 0.86 ), smoothstep( 0.8, 1.0, fr_t.r ) );
        vec3 fr_head = vBloom * ( 0.75 + 0.35 * fr_t.r );
        diffuseColor.rgb = mix( fr_body, fr_head, smoothstep( 0.35, 0.75, fr_t.g ) );
      `);
  };
  material.customProgramCacheKey = () => 'highroads-grass-atlas';

  return { material, uniforms };
}

/**
 * Shared per-session assets: one geometry, one texture, one material per tier,
 * so the whole field is a handful of draw calls.
 */
export function createGrassAssets({ anisotropy = 1 } = {}) {
  const geometry = tuftGeometry();
  // One atlas (four tuft kinds) for every tier.
  const map = atlasTexture(GRASS.textureSize);
  if (map) map.anisotropy = anisotropy;

  // The woodland floor gets its own card: a different plant, not a scaled copy.
  const woodMap = GRASS.wood.enabled
    ? atlasTexture(GRASS.textureSize, { long: true, seed: 0x6c1f0a3d })
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