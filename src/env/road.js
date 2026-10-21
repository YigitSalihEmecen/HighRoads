/**
 * env/road.js — the carriageway surface.
 *
 * Where the road goes is path.js's job; the geometry is chunks.js's. This
 * module draws the look, in ROAD space — (across, along) metres, handed over
 * by the ribbon as `roadUV` — so everything a road wears follows its lanes:
 *
 *   resurfacing  each carriageway's age per section (`roadAge`, chunks.js):
 *                fresh black binder hiding its stone, to bleached grey with
 *                the aggregate standing out of it
 *   wheel paths  polished and darkened where the tyres run; an oil stain
 *                down the middle of each lane
 *   patches      rectangular repairs inside a lane, younger than the road
 *                around them, with a sealed seam, over the paint
 *   cracks       transverse thermal cracks, longitudinal ones at the lane
 *                joint and in the outer wheel path, many sealed with tar;
 *                alligator cracking and ravelling in old wheel paths
 *
 * The asphalt itself is GROWN (binder, chips, pits, alligator cells) as a
 * heightfield and ray-marched — parallax occlusion, the same scheme as the
 * turf in ground.js — so the stone stands proud of the binder near the car.
 */

import * as THREE from 'three';
import { ROAD, ROAD_SURFACE, WORLD_BIOME, GROUND } from '../config.js';
import { litterMap, LITTER_GLSL } from '../forest.js';
import { makeCanvas, rng, tileFbm, tileNoise, paint } from './textures.js';

/** The far wear mottle, world-planar: R wear, centred on 0.5. */
function wearTexture(size) {
  const target = makeCanvas(size);
  if (!target) return null;
  paint(target, (u, v, out) => {
    const patch = tileFbm(u, v, 5, 3, 0.5, 71.9);
    const mottle = tileFbm(u, v, 17, 2, 0.5, 22.1);
    out[0] = out[1] = out[2] = 0.5 + (patch - 0.5) * 0.15 + (mottle - 0.5) * 0.07;
    return out;
  });
  const tex = new THREE.CanvasTexture(target.canvas);
  // NOT sRGB: a modulation mask, and decoding would bend the midpoint.
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/**
 * The asphalt: `size` texels over `ROAD_SURFACE.tile` metres of road space,
 * built the way it is laid — a binder surface, chips of aggregate pressed
 * into it, and the distress an old road gets: ravelled pits where stone has
 * been plucked out, and alligator cracking (Voronoi cell walls).
 *   albedo  R luminance (mean 1)  G distress  B occlusion  A —
 *   normal  tangent space (x across, y along), 0.5-biased, of the base height
 *   height  RG: base height, distress depth — the march lowers the base by
 *           the distress as far as the road's age allows
 * Data textures: a canvas premultiplies.
 */
function asphaltMaps(size) {
  if (!makeCanvas(1)) return null;
  const S = ROAD_SURFACE;
  const N = size, M = N - 1;
  const px = N / S.tile;
  const H = new Float32Array(N * N);
  const L = new Float32Array(N * N);
  const D = new Float32Array(N * N);
  const R = rng(0x0a5f417);

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i, u = i / N, v = j / N;
      // Binder: low, dark, with a fine fBm so it is not a flat floor.
      H[k] = 0.3 + 0.08 * tileFbm(u, v, 64, 3, 0.5, 5);
      L[k] = 0.42 + 0.1 * tileNoise(u * 256, v * 256, 256, 9);
    }
  }

  // Chips: angular stones (a superellipse, rotated), each its own grey.
  const chips = Math.round(S.chips * S.tile * S.tile);
  for (let c = 0; c < chips; c++) {
    const cx = R() * N, cy = R() * N;
    const r = (0.002 + R() * R() * 0.007) * px;
    const e = 0.6 + R() * 0.4, rot = R() * Math.PI;
    const top = 0.55 + R() * 0.4;
    const lum = R() < S.paleChips ? 1.5 + R() * 0.5 : 0.7 + R() * 0.55;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx, dy = y - cy;
        const a = (dx * cr + dy * sr) / r, b = (dy * cr - dx * sr) / (r * e);
        const q = Math.pow(Math.abs(a), 3) + Math.pow(Math.abs(b), 3);
        if (q > 1) continue;
        const k = (y & M) * N + (x & M);
        const z = top * (1 - 0.35 * q);
        if (z <= H[k]) continue;
        H[k] = z;
        L[k] = lum * (0.9 + 0.1 * (1 - q));
      }
    }
  }

  // Distress, as depth to remove: alligator cells (distance to the nearest
  // cell wall, on a jittered lattice that wraps) and ravelled pits.
  const C = S.alligatorCells;
  const seeds = [];
  for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) seeds.push([(i + 0.15 + R() * 0.7) / C, (j + 0.15 + R() * 0.7) / C]);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = i / N, v = j / N;
      const ci = Math.floor(u * C), cj = Math.floor(v * C);
      let d1 = 9, d2 = 9;
      for (let b = -1; b <= 1; b++) {
        for (let a = -1; a <= 1; a++) {
          const si = ((ci + a) % C + C) % C, sj = ((cj + b) % C + C) % C;
          const p = seeds[sj * C + si];
          // The neighbour's seed, unwrapped back next to this texel.
          const ex = p[0] + (ci + a - si) / C - u, ey = p[1] + (cj + b - sj) / C - v;
          const d = ex * ex + ey * ey;
          if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
        }
      }
      // Distance to the wall between the two nearest cells, in texels.
      const wall = (Math.sqrt(d2) - Math.sqrt(d1)) * N;
      const wobble = tileNoise(u * 96, v * 96, 96, 41) * 1.6;
      // Walls ~4 texels: thinner and the mips erase them by a few metres.
      const crack = Math.max(0, 1 - Math.max(0, wall - 1.2 - wobble) / 2.2);
      D[j * N + i] = crack;
    }
  }
  const pits = Math.round(chips * 0.08);
  for (let p = 0; p < pits; p++) {
    const cx = R() * N, cy = R() * N, r = (0.002 + R() * 0.005) * px;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const q = ((x - cx) ** 2 + (y - cy) ** 2) / (r * r);
        if (q > 1) continue;
        const k = (y & M) * N + (x & M);
        D[k] = Math.max(D[k], 0.8 * (1 - q * q));
      }
    }
  }

  // Occlusion: how far below the neighbourhood a texel sits.
  const ao = new Float32Array(N * N);
  const r = Math.max(1, Math.round(0.004 * px));
  let mean = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let m = 0;
      for (let a = -r; a <= r; a += r) for (let b = -r; b <= r; b += r) m += H[((j + a) & M) * N + ((i + b) & M)];
      const k = j * N + i;
      ao[k] = Math.min(1, Math.max(0.45, 0.85 + (H[k] - m / 9) * 2.5));
      mean += L[k] * ao[k];
    }
  }
  mean /= N * N;

  const albedo = new Uint8Array(N * N * 4);
  const normal = new Uint8Array(N * N * 4);
  const height = new Uint8Array(N * N * 2);
  // Height is 0..1 of `pom.depth` metres.
  const g = (S.pom.depth || 0.016) * px / 2;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i, o = k * 4;
      albedo[o] = Math.min(255, (L[k] / mean / 2) * 255);
      albedo[o + 1] = D[k] * 255;
      albedo[o + 2] = ao[k] * 255;
      albedo[o + 3] = 255;
      const nx = -(H[j * N + ((i + 1) & M)] - H[j * N + ((i - 1) & M)]) * g;
      const ny = -(H[((j + 1) & M) * N + i] - H[((j - 1) & M) * N + i]) * g;
      const nl = Math.hypot(nx, ny, 1);
      normal[o] = (nx / nl * 0.5 + 0.5) * 255;
      normal[o + 1] = (ny / nl * 0.5 + 0.5) * 255;
      normal[o + 2] = (1 / nl * 0.5 + 0.5) * 255;
      normal[o + 3] = 255;
      height[k * 2] = H[k] * 255;
      height[k * 2 + 1] = D[k] * 255;
    }
  }
  const tex = (data, format) => {
    const t = new THREE.DataTexture(data, N, N, format);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  };
  const h = tex(height, THREE.RGFormat);
  h.unpackAlignment = 2;
  return { albedo: tex(albedo, THREE.RGBAFormat), normal: tex(normal, THREE.RGBAFormat), height: h };
}

/**
 * @param {object} o.cover the ground material's uniforms (env/ground.js): the
 *   snow and sand drifts on the road are marched through ITS relief tile, so a
 *   drift is the same stuff as the verge beside it
 */
export function createRoadAssets({ anisotropy = 1, cover: ground = null } = {}) {
  const S = ROAD_SURFACE;
  const wear = wearTexture(256);
  const asphalt = asphaltMaps(S.textureSize);
  if (wear) wear.anisotropy = anisotropy;
  if (asphalt) {
    asphalt.albedo.anisotropy = Math.min(anisotropy, 8);
    asphalt.normal.anisotropy = Math.min(anisotropy, 4);
  }

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0.0,
    // Load-bearing: with `chunks.js:ROAD_LIFT` this keeps the ribbon off the sheet.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const v3 = (a) => new THREE.Vector3(...a);
  const uniforms = {
    uWear: { value: wear },
    uAsph: { value: asphalt && asphalt.albedo },
    uAsphN: { value: asphalt && asphalt.normal },
    uAsphH: { value: asphalt && asphalt.height },
    uTile: { value: new THREE.Vector2(S.tile, S.tileFar) },
    uFar: { value: S.contrastFar },
    uNearFade: { value: new THREE.Vector2(S.nearFade[0], S.nearFade[1]) },
    uCrackFade: { value: new THREE.Vector2(S.crackFade[0], S.crackFade[1]) },
    uFresh: { value: v3(S.fresh) },
    uOld: { value: v3(S.old) },
    /** roughness fresh, old, wheel-path polish, sealant gloss */
    uRough: { value: new THREE.Vector4(S.roughness[0], S.roughness[1], S.polish, S.sealGloss) },
    /** patch chance fresh, old, sealed share, lane width */
    uDamage: { value: new THREE.Vector4(S.patch[0], S.patch[1], S.sealShare, 3.7) },
    uPom: { value: new THREE.Vector3(S.pom.depth, S.pom.fade[0], S.pom.fade[1]) },
    uPomSteps: { value: new THREE.Vector2(S.pom.steps[0], S.pom.steps[1]) },
    /** The markings, as chunks.js lays them: half width, lane, line width, centre gap; dash length. */
    // Outer edge of the edge line; the dashed joint (none on a single lane each way).
    uPaint: { value: new THREE.Vector4(ROAD.halfWidth - ROAD.edgeInset,
      ROAD.lanesPerSide > 1 ? ROAD.laneWidth : -10, ROAD.lineWidth, ROAD.centreGap) },
    uDash: { value: ROAD.dashLength },
  };
  /** Live: the probes flip features through these. */
  material.userData.uniforms = uniforms;
  // What the world biome leaves on the road: snow, drifted sand or fallen
  // leaves. Drifts need the ground's relief tile; without one (no canvas) none.
  const tile = ground && ground.uSwardH.value;
  const cover = (WORLD_BIOME.road === 'leaves' || tile) ? WORLD_BIOME.road || '' : '';
  if (cover) material.defines = { FR_COVER: '', ['FR_COVER_' + cover.toUpperCase()]: '' };
  if (tile) {
    uniforms.uCoverA = ground.uSward;
    uniforms.uCoverH = ground.uSwardH;
    /** tile (m), drift depth (m; none where the road marches nothing), march fade start, end (m) */
    uniforms.uCover = { value: new THREE.Vector4(GROUND.sward.tile, S.pom.depth ? GROUND.sward.depth : 0, 10, 38) };
  }

  if (wear && asphalt) {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms, litterMap);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          attribute vec2 roadUV;
          attribute vec2 roadAge;

          varying vec3 fr_wpos;
          varying vec3 fr_wnorm;
          varying vec2 fr_road;
          varying vec2 fr_ages;
        `)
        .replace('#include <project_vertex>', /* glsl */`
          #include <project_vertex>
          fr_wpos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
          fr_wnorm = mat3( modelMatrix ) * objectNormal;
          fr_road = roadUV;
          fr_ages = roadAge;
        `);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          varying vec3 fr_wpos;
          varying vec3 fr_wnorm;
          varying vec2 fr_road;
          varying vec2 fr_ages;
          uniform sampler2D uWear;
          uniform sampler2D uAsph;
          uniform sampler2D uAsphN;
          uniform sampler2D uAsphH;
          uniform vec2 uTile;
          uniform float uFar;
          uniform vec2 uNearFade;
          uniform vec2 uCrackFade;
          uniform vec3 uFresh;
          uniform vec3 uOld;
          uniform vec4 uRough;
          uniform vec4 uDamage;
          uniform vec3 uPom;
          uniform vec2 uPomSteps;
          uniform vec4 uPaint;
          uniform float uDash;

          // Sine-free hashes (Hoskins): stable for the large road coordinates.
          float fr_h1( float p ) { p = fract( p * 0.1031 ); p *= p + 33.33; p *= p + p; return fract( p ); }
          float fr_h2( vec2 p ) { vec3 q = fract( vec3( p.xyx ) * 0.1031 ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.x + q.y ) * q.z ); }
          float fr_n1( float x ) { float i = floor( x ), f = fract( x ); return mix( fr_h1( i ), fr_h1( i + 1.0 ), f * f * ( 3.0 - 2.0 * f ) ); }
          float fr_n2( vec2 p ) {
            vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
            return mix( mix( fr_h2( i ), fr_h2( i + vec2( 1, 0 ) ), f.x ), mix( fr_h2( i + vec2( 0, 1 ) ), fr_h2( i + vec2( 1, 1 ) ), f.x ), f.y );
          }
          // A zero vector (a skirt face, where road space does not vary) would
          // normalise to NaN, and a NaN normal lights as a blinding streak.
          vec3 fr_unit( vec3 v, vec3 fallback ) { float l = dot( v, v ); return l > 1e-12 ? v * inversesqrt( l ) : fallback; }
          // Is road-space (v, s) painted? The markings exactly as chunks.js
          // lays them: edge lines, the solid double centre line, the dashed dividers.
          // aa is the footprint in metres: 0 inside the march, a pixel's for colour.
          float fr_in( float x, float a, float b, float aa ) { return smoothstep( a - aa, a + aa, x ) * ( 1.0 - smoothstep( b - aa, b + aa, x ) ); }
          float fr_paintAt( vec2 vs, vec2 aa ) {
            aa = max( aa, vec2( 1e-4 ) );
            float av = abs( vs.x ), w = uPaint.z;
            float edge = fr_in( av, uPaint.x - w, uPaint.x, aa.x );
            float centre = fr_in( av, uPaint.w, uPaint.w + w, aa.x );
            float ph = mod( vs.y, 2.0 * uDash );
            float dash = fr_in( av, uPaint.y - w * 0.5, uPaint.y + w * 0.5, aa.x ) * fr_in( ph, 0.0, uDash, aa.y );
            return max( max( edge, centre ), dash );
          }
          // Coverage of a line of half-width w at distance d, antialiased by the footprint fw.
          float fr_line( float d, float w, float fw ) { return clamp( ( w + fw - d ) / ( 2.0 * fw ), 0.0, 1.0 ) * min( 1.0, w / fw ); }
          #ifdef FR_COVER_LEAVES
          ${LITTER_GLSL}
          #endif
          #if defined( FR_COVER_SNOW ) || defined( FR_COVER_SAND )
          uniform sampler2D uCoverA;
          uniform sampler2D uCoverH;
          uniform vec4 uCover;
          // How far inside a drift road point p = (across, along) metres is
          // (> 0 inside). Warped noise smeared along the road — wind and
          // traffic drag drifts out — in irregular patches, most at the edges,
          // rare toward the middle, never in the wheel paths. Sand comes in
          // tongues at the wind's slant.
          float fr_drift( vec2 p ) {
            float av = abs( p.x );
            float edge = smoothstep( uPaint.x - 1.8, uPaint.x + 0.4, av );
            float dv = av - ( min( floor( av / uDamage.w ), 1.0 ) + 0.5 ) * uDamage.w;
            float wp = exp( -pow( abs( dv ) - 0.85, 2.0 ) / 0.07 );
            #ifdef FR_COVER_SAND
            vec2 q = vec2( p.x * 0.8 + p.y * 0.6, p.y * 0.8 - p.x * 0.6 ) / vec2( 1.6, 4.5 );
            float a = 0.8 * edge - 0.4 * wp;
            #else
            vec2 q = vec2( p.x / 1.2, p.y / 5.0 );
            float a = 0.82 * edge + 0.12 * exp( -dv * dv / 0.1 ) - 0.65 * wp;
            #endif
            q += ( vec2( fr_n2( q * 0.6 + 3.1 ), fr_n2( q * 0.6 + 8.3 ) ) - 0.5 ) * 2.2;
            // No fine octave: the march holds this mask linear over the ~0.4 m a
            // ray crosses, and a 20 cm octave made that guess snow where there
            // was none — drifts that changed as the camera came up to them.
            // The tile roughs the rim instead (fr_dH), sampled exactly.
            float n = fr_n2( q ) * 0.66 + fr_n2( q * 2.7 + 5.0 ) * 0.34;
            #ifdef FR_COVER_SAND
            return a + ( n - 0.5 ) * 1.5 - 0.55;
            #else
            return a + ( n - 0.5 ) * 1.5 - 0.48;
            #endif
          }
          // The drift's height (0..1 of uCover.y) at p: the mask, linear about
          // p0 over the few decimetres a ray travels, its rim broken by the
          // ground tile (snow lumps, sand ripples) and tapered, carrying the
          // tile's relief on top.
          float fr_dH( vec2 p, vec2 p0, float m0, vec2 mg, vec2 gx, vec2 gy ) {
            float t = textureGrad( uCoverH, p / uCover.x, gx, gy ).r;
            float s = clamp( ( m0 + dot( mg, p - p0 ) + ( t - 0.5 ) * 0.2 ) * 3.0, 0.0, 1.0 );
            s = 1.0 - ( 1.0 - s ) * ( 1.0 - s );
            return s * ( 0.45 + 0.55 * t );
          }
          #endif
        `)
        .replace('#include <color_fragment>', /* glsl */`
          #include <color_fragment>
          // Road space: v across (right +), s along; each carriageway's age.
          float fr_v = fr_road.x, fr_s = fr_road.y;
          float fr_fv = fwidth( fr_v ) + 1e-4, fr_fs = fwidth( fr_s ) + 1e-4;
          float fr_av = abs( fr_v );
          float fr_side = fr_v >= 0.0 ? 1.0 : -1.0;
          float fr_ageS = fr_v >= 0.0 ? fr_ages.y : fr_ages.x;
          float fr_lane = uDamage.w;
          float fr_li = min( floor( fr_av / fr_lane ), 1.0 );
          float fr_dv = fr_av - ( fr_li + 0.5 ) * fr_lane;     // lane-local, + outward
          float fr_laneId = fr_side * ( fr_li + 1.0 );
          float fr_dist = length( fr_wpos - cameraPosition );
          float fr_nearW = 1.0 - smoothstep( uNearFade.x, uNearFade.y, fr_dist );
          float fr_crackW = 1.0 - smoothstep( uCrackFade.x, uCrackFade.y, fr_dist );

          // Paint or asphalt? The markings are geometry in this mesh with a far
          // brighter vertex colour: paint is 0xe9e3d2, asphalt never past ~0x4a.
          float fr_lum = dot( vColor, vec3( 0.30, 0.59, 0.11 ) );
          float fr_isPaint = smoothstep( 0.34, 0.55, fr_lum );

          // ---- patches: one chance per lane per 16 m, a rectangle inside it.
          vec2 fr_pk = vec2( floor( fr_s / 16.0 ), fr_laneId );
          float fr_has = step( fr_h2( fr_pk ), mix( uDamage.x, uDamage.y, fr_ageS ) );
          float fr_plen = 1.2 + 6.5 * fr_h2( fr_pk + 3.1 );
          float fr_ps0 = fr_pk.x * 16.0 + fr_h2( fr_pk + 7.7 ) * ( 16.0 - fr_plen );
          float fr_pw = 0.9 + ( fr_lane - 0.9 ) * fr_h2( fr_pk + 1.9 );
          float fr_pc = ( fr_h2( fr_pk + 5.3 ) - 0.5 ) * ( fr_lane - fr_pw );
          vec2 fr_pd = vec2( abs( fr_dv - fr_pc ) - fr_pw * 0.5, abs( fr_s - fr_ps0 - fr_plen * 0.5 ) - fr_plen * 0.5 );
          float fr_sd = max( fr_pd.x, fr_pd.y );
          float fr_paa = max( fr_fv, fr_fs );
          float fr_patch = fr_has * ( 1.0 - smoothstep( -fr_paa, fr_paa, fr_sd ) );
          float fr_seam = fr_has * fr_line( abs( fr_sd ), 0.02, fr_paa ) * fr_crackW;
          float fr_age = mix( fr_ageS, fr_h2( fr_pk + 9.4 ) * 0.45 * fr_ageS, fr_patch );

          // ---- wheel paths and the oil stain between them.
          float fr_wp = exp( -pow( abs( fr_dv ) - 0.85, 2.0 ) / 0.07 );
          float fr_oil = exp( -fr_dv * fr_dv / 0.05 ) * ( 0.45 + 0.55 * fr_n1( fr_s * 0.4 + fr_laneId * 37.0 ) );

          // ---- cracks. Open ones are thin and dark; sealed ones a wider glossy band.
          float fr_crk = 0.0, fr_seal = 0.0;
          {
            // Transverse: at most one per carriageway every 9 m, more as it ages.
            float c = floor( fr_s / 9.0 );
            vec2 k = vec2( c, fr_side );
            float on = step( fr_h2( k ), fr_ageS * 0.9 ) * step( fr_av, mix( 3.0, 7.6, fr_h2( k + 4.4 ) ) );
            float sc = c * 9.0 + 1.0 + fr_h2( k + 2.3 ) * 7.0;
            float d = abs( fr_s - sc - ( fr_n1( fr_av * 1.6 + c ) - 0.5 ) * 0.35 - ( fr_n1( fr_av * 11.0 + c * 3.0 ) - 0.5 ) * 0.05 );
            float sealed = step( fr_h2( k + 6.1 ), uDamage.z );
            fr_crk = max( fr_crk, on * ( 1.0 - sealed ) * fr_line( d, 0.005, fr_fs ) );
            fr_seal = max( fr_seal, on * sealed * fr_line( d, 0.03, fr_fs ) );
          }
          {
            // Longitudinal: down the lane joint, and in the outer wheel path of old lanes.
            float wig = ( fr_n1( fr_s * 0.45 + fr_side * 13.0 ) - 0.5 ) * 0.22 + ( fr_n1( fr_s * 4.0 ) - 0.5 ) * 0.03;
            float runs = step( 1.0 - fr_ageS * 0.85, fr_n1( fr_s / 23.0 + fr_side * 17.0 ) );
            float sealed = step( fr_n1( fr_s / 61.0 + fr_side * 5.0 ), uDamage.z );
            float d = abs( fr_av - fr_lane - wig );
            fr_crk = max( fr_crk, runs * ( 1.0 - sealed ) * fr_line( d, 0.005, fr_fv ) );
            fr_seal = max( fr_seal, runs * sealed * fr_line( d, 0.035, fr_fv ) );
            float d2 = abs( fr_dv - 0.85 - wig * 0.6 );
            float runs2 = step( 1.0 - smoothstep( 0.45, 1.0, fr_ageS ) * 0.8, fr_n1( fr_s / 17.0 + fr_laneId * 3.0 ) );
            fr_crk = max( fr_crk, runs2 * fr_line( d2, 0.005, fr_fv ) );
          }
          // A repair is newer than every crack it covered.
          fr_crk *= ( 1.0 - fr_patch ) * fr_crackW;
          fr_seal *= ( 1.0 - fr_patch ) * fr_crackW;

          // ---- distress in the texture (alligator cells, ravelling): old wheel paths.
          float fr_dis = smoothstep( 0.5, 0.95, fr_age ) * ( 0.35 + 0.65 * fr_wp )
            * smoothstep( 0.35, 0.7, fr_n1( fr_s / 13.0 + fr_laneId * 7.0 ) ) * ( 1.0 - fr_isPaint );

          // ---- the asphalt texel, ray-marched (parallax occlusion; ground.js
          // explains the scheme). The frame comes from screen derivatives —
          // the cotangent frame (Schüler 2013) — since road space bends.
          vec2 fr_uv = vec2( fr_v, fr_s ) / uTile.x;
          vec2 fr_gx = dFdx( fr_uv ), fr_gy = dFdy( fr_uv );
          vec3 fr_W = normalize( fr_wnorm );
          vec3 fr_dp1 = dFdx( fr_wpos ), fr_dp2 = dFdy( fr_wpos );
          vec3 fr_p2 = cross( fr_dp2, fr_W ), fr_p1 = cross( fr_W, fr_dp1 );
          vec3 fr_T = fr_p2 * fr_gx.x + fr_p1 * fr_gy.x;
          vec3 fr_B = fr_p2 * fr_gx.y + fr_p1 * fr_gy.y;
          fr_T = fr_unit( fr_T - fr_W * dot( fr_W, fr_T ), vec3( 1.0, 0.0, 0.0 ) );
          fr_B = fr_unit( fr_B - fr_W * dot( fr_W, fr_B ), fr_unit( cross( fr_W, fr_T ), vec3( 0.0, 0.0, 1.0 ) ) );
          float fr_fade = 1.0 - smoothstep( uPom.y, uPom.z, fr_dist );
          // Paint is a film a few millimetres proud of the binder, following
          // the stone under it; a patch took the paint with it.
          float fr_keep = 1.0 - fr_patch;
          float fr_lee = 0.0;
          float fr_depth = uPom.x * fr_fade * fr_W.y * fr_W.y;
          if ( fr_depth > 0.0005 ) {
            vec3 fr_V = normalize( cameraPosition - fr_wpos );
            vec3 fr_tv = vec3( dot( fr_V, fr_T ), dot( fr_V, fr_B ), max( dot( fr_V, fr_W ), 0.16 ) );
            float fr_n = floor( mix( uPomSteps.y, uPomSteps.x, fr_tv.z ) * ( 0.35 + 0.65 * fr_fade ) ) + 1.0;
            vec2 fr_du = -fr_tv.xy / fr_tv.z * ( fr_depth / uTile.x ) / fr_n;
            vec2 fr_mx = fr_gx * 2.0, fr_my = fr_gy * 2.0;
            float fr_layer = 1.0 / fr_n, fr_d = 0.0;
            vec2 fr_t = textureGrad( uAsphH, fr_uv, fr_mx, fr_my ).rg;
            float fr_h = 1.0 - mix( fr_t.r - fr_t.g * fr_dis * 0.5, 0.6 + 0.35 * fr_t.r, fr_paintAt( fr_uv * uTile.x, vec2( 0.0 ) ) * fr_keep );
            float fr_pd2 = 0.0, fr_ph = fr_h;
            for ( int i = 0; i < 16; i ++ ) {
              if ( float( i ) >= fr_n || fr_d >= fr_h ) break;
              fr_pd2 = fr_d; fr_ph = fr_h;
              fr_uv += fr_du; fr_d += fr_layer;
              fr_t = textureGrad( uAsphH, fr_uv, fr_mx, fr_my ).rg;
              fr_h = 1.0 - mix( fr_t.r - fr_t.g * fr_dis * 0.5, 0.6 + 0.35 * fr_t.r, fr_paintAt( fr_uv * uTile.x, vec2( 0.0 ) ) * fr_keep );
            }
            float fr_a1 = fr_h - fr_d, fr_b1 = fr_ph - fr_pd2;
            fr_uv -= fr_du * clamp( fr_a1 / ( fr_a1 - fr_b1 - 1e-5 ), 0.0, 1.0 );
            // What the ray hit decides paint, so a raised line's near edge
            // stands over the asphalt beside it.
            float fr_hitPaint = fr_paintAt( fr_uv * uTile.x, vec2( fr_fv, fr_fs ) );
            // The paint's lee: asphalt the raised film shades from the sun.
            #if NUM_DIR_LIGHTS > 0
            vec3 fr_L = normalize( ( vec4( directionalLights[ 0 ].direction, 0.0 ) * viewMatrix ).xyz );
            vec2 fr_lt = vec2( dot( fr_L, fr_T ), dot( fr_L, fr_B ) ) / max( dot( fr_L, fr_W ), 0.12 );
            fr_lee = ( 1.0 - fr_hitPaint ) * fr_paintAt( fr_uv * uTile.x + fr_lt * fr_depth * 0.35, vec2( fr_fv, fr_fs ) ) * fr_keep;
            #endif
            fr_isPaint = mix( fr_isPaint, fr_hitPaint, step( 0.5, fr_fade ) );
          }
          vec4 fr_tex = textureGrad( uAsph, fr_uv, fr_gx, fr_gy );

          // ---- colour.
          vec3 fr_tone = mix( uFresh, uOld, fr_age );
          // Fresh binder hides its stone; age exposes it. The grain goes with distance.
          float fr_chip = mix( 1.0, fr_tex.r * 2.0 * mix( 1.0, fr_tex.b, 0.6 ), mix( 0.25, 1.0, fr_age ) * fr_nearW );
          float fr_far = 1.0 + ( texture2D( uWear, fr_wpos.xz / uTile.y ).r * 2.0 - 1.0 ) * uFar;
          fr_tone *= fr_chip * fr_far;
          // Old asphalt is blotchy — stains, damp patches, ravelled ground —
          // stretched along the road the way traffic smears it.
          float fr_mot = fr_n2( vec2( fr_v / 2.2, fr_s / 7.0 ) ) * 0.65 + fr_n2( vec2( fr_v / 0.7, fr_s / 1.9 ) ) * 0.35;
          fr_tone *= 1.0 + ( fr_mot - 0.5 ) * mix( 0.12, 0.42, fr_age );
          fr_tone *= 1.0 - 0.14 * fr_oil - 0.07 * fr_wp * fr_age;
          fr_tone *= 1.0 - 0.7 * fr_tex.g * fr_dis;
          fr_tone *= 1.0 - 0.55 * fr_crk - 0.5 * fr_seal - 0.35 * fr_seam - 0.4 * fr_lee;

          // Paint: faded with the road's age, cracked with it, and gone under a patch.
          // Base colours from the constants (0xe9e3d2 paint, 0x46443f asphalt,
          // linear) where the marched texel disagrees with the vertex colour.
          float fr_vPaint = smoothstep( 0.34, 0.55, fr_lum );
          vec3 fr_paint = mix( vec3( 0.815, 0.768, 0.644 ), diffuseColor.rgb, fr_vPaint )
            * mix( 1.0, 0.62, fr_ageS * ( 0.6 + 0.4 * fr_n1( fr_s * 0.7 ) ) )
            * ( 1.0 - 0.6 * fr_crk - 0.5 * fr_seal ) * fr_far;
          vec3 fr_asphalt = mix( diffuseColor.rgb, vec3( 0.061, 0.058, 0.050 ), fr_vPaint ) * fr_tone;
          diffuseColor.rgb = mix( fr_asphalt, fr_paint, fr_isPaint * ( 1.0 - fr_patch ) );

          // Relief the march does not carry, for the derivative bump: open
          // cracks cut down, patches stand a few millimetres proud.
          float fr_bumpH = fr_patch * 0.004 - fr_crk * 0.012 - fr_seal * 0.002 + fr_isPaint * fr_keep * 0.003;

          // ---- what lies on the road (config.js:WORLDS.road): thickest by the
          // edges and along the centre line, worn away in the wheel paths.
          float fr_coverK = 0.0, fr_wetK = 0.0;
          vec3 fr_coverN = fr_W;
          #if defined( FR_COVER_SNOW ) || defined( FR_COVER_SAND )
          {
            // A drift is a layer standing ON the asphalt, so the surface drawn
            // here is its FLOOR (the turf in ground.js is the other way up):
            // march the camera ray from where it crosses the drift's top
            // plane, nearer the camera, down to this point on the road,
            // stopping where it first enters the drift. Reaching the road
            // means it missed. Drifts stay on their footprint at every angle.
            vec2 fr_p0 = vec2( fr_v, fr_s );
            vec2 fr_cgx = dFdx( fr_p0 ) / uCover.x, fr_cgy = dFdy( fr_p0 ) / uCover.x;
            float fr_m0 = fr_drift( fr_p0 );
            #ifdef FR_COVER_SNOW
            // Meltwater darkens the asphalt round every drift.
            fr_wetK = smoothstep( -0.3, 0.0, fr_m0 );
            diffuseColor.rgb *= 1.0 - 0.3 * fr_wetK;
            #else
            // Sand dusts the asphalt, more near a drift.
            diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.66, 0.5, 0.32 ), 0.08 + 0.17 * smoothstep( -0.45, 0.0, fr_m0 ) );
            #endif
            if ( fr_m0 > -0.25 ) {
              vec2 fr_mg = ( vec2( fr_drift( fr_p0 + vec2( 0.04, 0.0 ) ), fr_drift( fr_p0 + vec2( 0.0, 0.04 ) ) ) - fr_m0 ) / 0.04;
              float fr_cfade = 1.0 - smoothstep( uCover.z, uCover.w, fr_dist );
              float fr_cdep = uCover.y * fr_cfade * fr_W.y * fr_W.y;
              vec2 fr_cp = fr_p0;
              if ( fr_cdep > 0.002 ) {
                vec3 fr_V = normalize( cameraPosition - fr_wpos );
                vec3 fr_tv = vec3( dot( fr_V, fr_T ), dot( fr_V, fr_B ), max( dot( fr_V, fr_W ), 0.16 ) );
                float fr_n = floor( mix( 16.0, 6.0, fr_tv.z ) * ( 0.4 + 0.6 * fr_cfade ) ) + 1.0;
                vec2 fr_du = -fr_tv.xy / fr_tv.z * fr_cdep / fr_n;
                float fr_layer = 1.0 / fr_n, fr_d = 0.0;
                fr_cp -= fr_du * fr_n;
                float fr_h = 1.0 - fr_dH( fr_cp, fr_p0, fr_m0, fr_mg, fr_cgx * 2.0, fr_cgy * 2.0 );
                float fr_pd = 0.0, fr_ph = fr_h;
                for ( int i = 0; i < 18; i ++ ) {
                  if ( float( i ) >= fr_n || fr_d >= fr_h ) break;
                  fr_pd = fr_d; fr_ph = fr_h;
                  fr_cp += fr_du; fr_d += fr_layer;
                  fr_h = 1.0 - fr_dH( fr_cp, fr_p0, fr_m0, fr_mg, fr_cgx * 2.0, fr_cgy * 2.0 );
                }
                float fr_a1 = fr_h - fr_d, fr_b1 = fr_ph - fr_pd;
                fr_cp -= fr_du * clamp( fr_a1 / ( fr_a1 - fr_b1 - 1e-5 ), 0.0, 1.0 );
              }
              float fr_th = fr_dH( fr_cp, fr_p0, fr_m0, fr_mg, fr_cgx, fr_cgy );
              float fr_al = smoothstep( 0.0, 0.1, fr_th );
              vec3 fr_ca = textureGrad( uCoverA, fr_cp / uCover.x, fr_cgx, fr_cgy ).rgb * 1.5;
              #ifdef FR_COVER_SNOW
              // Thin snow over the asphalt is grey slush; deep, it is white.
              vec3 fr_col = vec3( 0.84, 0.87, 0.92 ) * fr_ca;
              fr_col = mix( fr_col * 0.5, fr_col, smoothstep( 0.08, 0.5, fr_th ) );
              #else
              vec3 fr_col = vec3( 0.66, 0.46, 0.25 ) * fr_ca;
              fr_col = mix( fr_col * 0.8, fr_col, smoothstep( 0.05, 0.4, fr_th ) );
              #endif
              diffuseColor.rgb = mix( diffuseColor.rgb, fr_col, fr_al );
              fr_coverK = fr_al;
              // Its normal, from the drift's own slope: the rim, and the tile's lumps or ripples.
              vec2 fr_gH = ( vec2( fr_dH( fr_cp + vec2( 0.025, 0.0 ), fr_p0, fr_m0, fr_mg, fr_cgx, fr_cgy ),
                                   fr_dH( fr_cp + vec2( 0.0, 0.025 ), fr_p0, fr_m0, fr_mg, fr_cgx, fr_cgy ) ) - fr_th ) / 0.025;
              vec2 fr_nxy = -fr_gH * max( uCover.y, 0.03 ) * 1.6;
              fr_coverN = normalize( fr_T * fr_nxy.x + fr_B * fr_nxy.y + fr_W );
            }
          }
          #endif
          #ifdef FR_COVER_LEAVES
          {
            float fr_edgeK = smoothstep( uPaint.x - 1.8, uPaint.x + 0.3, fr_av );
            float fr_midK = 1.0 - smoothstep( 0.1, 1.0, fr_av );
            float fr_n = fr_n2( vec2( fr_v / 0.9, fr_s / 3.5 ) ) * 0.6 + fr_n2( vec2( fr_v / 0.22, fr_s / 0.6 ) ) * 0.4;
            #ifdef FR_COVER_LEAVES
            // Leaves one by one: a lattice of 0.17 m cells, each may hold a
            // leaf (a pointed lens with a midrib) reaching into its neighbours.
            // As many as the trees beside the road drop (forest.js:litterMap): none on open land.
            float fr_d = clamp( ( 0.12 + 0.6 * fr_edgeK + 0.25 * fr_midK - 0.2 * fr_wp ) * ( 0.4 + 1.2 * fr_n ) * fr_litterAt( fr_wpos ) * 1.6, 0.0, 0.95 );
            vec3 fr_avg = vec3( 0.5, 0.2, 0.06 );
            float fr_near = 1.0 - smoothstep( 22.0, 40.0, fr_dist );
            vec4 fr_leaf = vec4( 0.0 );
            if ( fr_near > 0.0 ) {
              vec2 fr_p = vec2( fr_v, fr_s ) / 0.17;
              vec2 fr_c = floor( fr_p );
              float fr_aa = max( fr_fv, fr_fs ) / 0.17 * 1.5;
              for ( int j = -1; j <= 1; j ++ ) for ( int i = -1; i <= 1; i ++ ) {
                vec2 fr_k = fr_c + vec2( float( i ), float( j ) );
                float fr_h = fr_h2( fr_k );
                if ( fr_h > fr_d ) continue;
                vec2 fr_o = fr_k + 0.5 + ( vec2( fr_h2( fr_k + 3.7 ), fr_h2( fr_k + 9.1 ) ) - 0.5 ) * 0.6;
                float fr_ang = fr_h2( fr_k + 5.3 ) * 6.2831853;
                vec2 fr_q = fr_p - fr_o;
                fr_q = vec2( cos( fr_ang ) * fr_q.x + sin( fr_ang ) * fr_q.y, cos( fr_ang ) * fr_q.y - sin( fr_ang ) * fr_q.x );
                float fr_len = 0.32 + 0.22 * fr_h2( fr_k + 1.3 );
                float fr_lx = fr_q.x / fr_len, fr_ly = fr_q.y / ( fr_len * 0.5 );
                float fr_half = ( 1.0 - fr_lx * fr_lx ) * ( fr_lx < 0.0 ? 1.1 : 0.9 );
                float fr_in2 = ( 1.0 - smoothstep( -fr_aa, fr_aa, abs( fr_ly ) * fr_len * 0.5 - fr_half * fr_len * 0.5 ) ) * step( abs( fr_lx ), 1.0 );
                if ( fr_in2 <= 0.0 ) continue;
                float fr_pick = fr_h2( fr_k + 7.9 );
                vec3 fr_lc = fr_pick < 0.3 ? vec3( 0.7, 0.26, 0.04 ) : fr_pick < 0.5 ? vec3( 0.52, 0.08, 0.03 )
                  : fr_pick < 0.72 ? vec3( 0.78, 0.5, 0.07 ) : fr_pick < 0.88 ? vec3( 0.32, 0.17, 0.06 ) : vec3( 0.56, 0.36, 0.1 );
                fr_lc *= ( 0.8 + 0.35 * fr_h2( fr_k + 2.2 ) ) * ( abs( fr_ly ) < 0.08 ? 0.8 : 1.0 ) * ( 1.0 - 0.3 * smoothstep( 0.6, 1.0, abs( fr_ly ) / max( fr_half, 1e-3 ) ) );
                fr_leaf = vec4( mix( fr_leaf.rgb, fr_lc, fr_in2 ), max( fr_leaf.a, fr_in2 ) );
              }
            }
            // Past the lattice, the leaves are a stain of their average colour.
            fr_coverK = mix( fr_d * 0.35, fr_leaf.a, fr_near );
            diffuseColor.rgb = mix( diffuseColor.rgb, mix( fr_avg, fr_leaf.rgb, fr_near ), fr_coverK );
            #endif
          }
          #endif
        `)
        .replace('#include <roughnessmap_fragment>', /* glsl */`
          #include <roughnessmap_fragment>
          roughnessFactor = mix( uRough.x, uRough.y, fr_age )
            - uRough.z * fr_wp * ( 0.4 + 0.6 * fr_age ) - uRough.w * fr_seal;
          roughnessFactor = mix( roughnessFactor, 0.72, fr_isPaint * ( 1.0 - fr_patch ) );
          roughnessFactor = mix( roughnessFactor - 0.35 * fr_wetK, 0.88, fr_coverK );
        `)
        .replace('#include <normal_fragment_maps>', /* glsl */`
          #include <normal_fragment_maps>
          {
            // The asphalt's own normal at the marched texel, stronger as the stone shows.
            vec3 fr_tn = textureGrad( uAsphN, fr_uv, fr_gx, fr_gy ).xyz * 2.0 - 1.0;
            vec3 fr_nw = normalize( fr_T * fr_tn.x + fr_B * fr_tn.y + fr_W * fr_tn.z );
            // Paint keeps some of the stone's relief: it is a film laid over it.
            float fr_k = fr_nearW * mix( 0.4, 1.0, fr_age ) * ( 1.0 - 0.6 * fr_isPaint * fr_keep ) * ( 1.0 - fr_coverK );
            normal = normalize( mix( normal, normalize( ( viewMatrix * vec4( fr_nw, 0.0 ) ).xyz ), fr_k ) );
            // Screen-space derivative bump (Mikkelsen 2010) of the cracks and patch edges.
            vec3 fr_dpx = dFdx( -vViewPosition ), fr_dpy = dFdy( -vViewPosition );
            float fr_hx = dFdx( fr_bumpH ), fr_hy = dFdy( fr_bumpH );
            vec3 fr_r1 = cross( fr_dpy, normal ), fr_r2 = cross( normal, fr_dpx );
            float fr_det = dot( fr_dpx, fr_r1 );
            vec3 fr_grad = sign( fr_det ) * ( fr_hx * fr_r1 + fr_hy * fr_r2 );
            normal = normalize( mix( normal, abs( fr_det ) * normal - fr_grad, fr_crackW ) );
            #if defined( FR_COVER_SNOW ) || defined( FR_COVER_SAND )
            normal = normalize( mix( normal, normalize( ( viewMatrix * vec4( fr_coverN, 0.0 ) ).xyz ), fr_coverK ) );
            #endif
          }
        `);
    };
    // Its own key — sharing ground's would hand this material ground's program.
    material.customProgramCacheKey = () => 'tothehorizon-road-' + cover;
  }

  return {
    material,
    dispose() {
      material.dispose();
      if (wear) wear.dispose();
      if (asphalt) { asphalt.albedo.dispose(); asphalt.normal.dispose(); asphalt.height.dispose(); }
    },
  };
}
