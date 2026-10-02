/**
 * sky.js — the sky, as presets: time of day and weather.
 *
 * One shader draws every sky. It is a three-stop gradient (horizon → top →
 * zenith) with clouds projected onto the dome, plus a sun OR a moon:
 *
 *   - the SUN is a small disc with a tight halo and a wide glow;
 *   - the MOON is a full disc with limb darkening, procedural maria (the
 *     dark "seas" — low-frequency noise on the disc's own 2D coordinates, so
 *     they do not swim as the camera turns) and a soft halo;
 *   - STARS are a hashed lattice over direction: each cell of a cube-mapped
 *     grid may hold one star of random brightness and colour temperature,
 *     twinkling, hidden by cloud and by the moon's glare, and denser along a
 *     Milky Way band.
 *
 * Clouds are lit by whichever light is up, so a night sky has moonlit cloud
 * edges and a sunset sky has orange undersides.
 *
 * A preset sets more than the dome: the key light (sun or moon) and its
 * colour, intensity and direction; the hemisphere fill; fog colour and
 * density; exposure; the grade's warm/cool split; the lake shader's
 * reflection; and whether the car wants its headlights.
 *
 * Choose one with `?sky=night` in the URL or from the Settings drawer.
 */

import * as THREE from 'three';
import { ATMOSPHERE } from './config.js';

export const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPos;
    gl_Position.z = gl_Position.w; // force to the far plane
  }
`;

export const SKY_FRAG = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uSun;
  uniform vec3 uSunDir;
  uniform float uTime;
  uniform float uNight;      // 0 day, 1 night: stars, moon instead of sun
  uniform float uCloud;      // cloud cover 0..1
  uniform vec3 uCloudLit;    // cloud colour where the light catches it
  uniform vec3 uCloudDark;   // and in its own shade
  uniform float uSunSize;    // disc size multiplier
  varying vec3 vDir;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float hash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float a = 0.0, w = 0.5;
    for (int i = 0; i < 5; i++) { a += w * vnoise(p); p *= 2.03; w *= 0.5; }
    return a;
  }

  // One candidate star per cell of a cube-mapped lattice over the sphere.
  vec3 stars(vec3 dir) {
    vec3 a = abs(dir);
    vec2 uv; float face;
    if (a.x > a.y && a.x > a.z) { uv = dir.yz / a.x; face = sign(dir.x); }
    else if (a.y > a.z)         { uv = dir.xz / a.y; face = 2.0 * sign(dir.y); }
    else                        { uv = dir.xy / a.z; face = 3.0 * sign(dir.z); }
    vec2 g = uv * 180.0;
    vec2 cell = floor(g);
    float h = hash3(vec3(cell, face));
    // Milky Way: a band along a tilted great circle, denser and dustier.
    float band = exp(-pow(dot(dir, normalize(vec3(0.35, 0.62, -0.70))) * 3.2, 2.0));
    float keep = step(1.0 - (0.06 + 0.10 * band), h);
    vec2 pos = vec2(hash3(vec3(cell, face + 7.0)), hash3(vec3(cell, face + 13.0)));
    float d = length(fract(g) - pos);
    float mag = pow(hash3(vec3(cell, face + 3.0)), 6.0);
    float tw = 0.75 + 0.25 * sin(uTime * (1.5 + 3.0 * h) + h * 60.0);
    float s = keep * smoothstep(0.10 + 0.12 * mag, 0.0, d) * (0.35 + 1.6 * mag) * tw;
    vec3 tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.86, 0.70), hash3(vec3(cell, face + 21.0)));
    // the band's diffuse glow
    float dust = band * (0.55 + 0.45 * fbm(uv * 6.0 + face)) * 0.06;
    return tint * s + vec3(0.55, 0.62, 0.85) * dust;
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = clamp(dir.y, -1.0, 1.0);

    float t = pow(clamp(h * 1.15, 0.0, 1.0), 0.55);
    vec3 col = mix(uHorizon, uTop, t);
    col = mix(col, uZenith, pow(clamp(h, 0.0, 1.0), 2.1) * 0.85);
    col = mix(col * 0.95, col, smoothstep(-0.25, 0.02, h));

    float sd = max(dot(dir, uSunDir), 0.0);

    // ---- clouds ----
    float band = smoothstep(0.02, 0.36, h);
    vec2 cuv = dir.xz / max(0.16, h + 0.08) * 0.9 + vec2(uTime * 0.004, uTime * 0.0016);
    float n = fbm(cuv * 1.35);
    float wisp = fbm(cuv * 3.7 + n);
    float lo = mix(0.52, 0.20, uCloud), hi = mix(0.86, 0.62, uCloud);
    float cloud = smoothstep(lo, hi, n * 0.72 + wisp * 0.42) * band;
    // thicker cloud is darker underneath
    float thick = smoothstep(hi - 0.05, hi + 0.25, n * 0.72 + wisp * 0.42);
    vec3 cloudCol = mix(uCloudLit, uCloudDark, thick * 0.7);
    cloudCol = mix(cloudCol, uSun * 1.08, pow(sd, 3.0) * mix(0.55, 0.35, uNight));

    // ---- night sky ----
    if (uNight > 0.0) {
      float moonGlare = smoothstep(0.75, 1.0, sd);
      col += stars(dir) * uNight * (1.0 - cloud) * (1.0 - moonGlare * 0.9) * smoothstep(-0.02, 0.15, h);
    }

    col = mix(col, cloudCol, cloud * mix(0.72, 0.86, uCloud));

    if (uNight < 0.5) {
      // A restrained sun: soft glow, tight halo, small disc.
      col += uSun * pow(sd, 10.0) * 0.11 * (1.0 - cloud * 0.7);
      col += uSun * pow(sd, 400.0) * 0.32 * (1.0 - cloud * 0.85);
      float disc = 0.9999 - 0.00025 * (uSunSize - 1.0);
      col += uSun * smoothstep(disc - 0.0003, disc, sd) * 1.1 * (1.0 - cloud);
    } else {
      // The moon: a disc ~4x the sun's, limb-darkened, with maria.
      float r = acos(clamp(sd, -1.0, 1.0));
      float R = 0.032;
      // 2D coordinates on the disc, in a frame fixed to the moon direction.
      vec3 up = abs(uSunDir.y) < 0.99 ? vec3(0, 1, 0) : vec3(1, 0, 0);
      vec3 ax = normalize(cross(up, uSunDir));
      vec3 ay = cross(uSunDir, ax);
      vec2 m = vec2(dot(dir, ax), dot(dir, ay)) / R;
      float inside = 1.0 - smoothstep(0.96, 1.0, length(m));
      float limb = sqrt(max(0.0, 1.0 - dot(m, m)));
      float maria = smoothstep(0.42, 0.68, fbm(m * 1.6 + 3.1)) * 0.38
                  + smoothstep(0.55, 0.8, fbm(m * 4.3 - 7.0)) * 0.12;
      vec3 moon = vec3(0.92, 0.94, 1.0) * (0.55 + 0.45 * limb) * (1.0 - maria);
      col = mix(col, moon * 1.25, inside * (1.0 - cloud * 0.8));
      // halo and the wide glow that lifts the sky around it
      col += uSun * pow(sd, 900.0) * 0.6 * (1.0 - inside);
      col += uSun * pow(sd, 40.0) * 0.10;
      col += uSun * pow(sd, 6.0) * 0.05;
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

export function skyUniforms() {
  return {
    uTop: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uZenith: { value: new THREE.Color() },
    uSun: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uTime: { value: 0 },
    uNight: { value: 0 },
    uCloud: { value: 0 },
    uCloudLit: { value: new THREE.Color(0.86, 0.88, 0.92) },
    uCloudDark: { value: new THREE.Color(0.62, 0.66, 0.72) },
    uSunSize: { value: 1 },
  };
}

/**
 * The presets. `light` is the key light: the sun, or the moon at night.
 * Intensities are three's physical units and were set against the day
 * preset, which reproduces the game's original look exactly.
 */
export const SKY_PRESETS = {
  day: {
    label: 'Day',
    top: 0x7ba4ce, zenith: 0x3f6ea8, horizon: 0xdde3e2,
    light: 0xfff4e6, lightIntensity: 2.4, dir: [-0.34, 0.62, -0.71],
    hemiSky: 0xd2e2f2, hemiGround: 0xa39c8c, hemi: 1.5, fill: 0.5,
    fog: 0xd6dbdb, fogDensity: null, exposure: 1.18,
    cloud: 0.0, cloudLit: [0.86, 0.88, 0.92], cloudDark: [0.66, 0.70, 0.76],
    warm: 0xffd9ac, cool: 0xa8bcd8, night: 0, headlights: false,
  },
  golden: {
    label: 'Golden hour',
    top: 0x6f86b8, zenith: 0x34497e, horizon: 0xf3c08a,
    light: 0xffb06a, lightIntensity: 2.3, dir: [-0.62, 0.16, -0.77],
    hemiSky: 0xd8c4c0, hemiGround: 0x8a6e58, hemi: 1.05, fill: 0.35,
    fog: 0xe9c4a0, fogDensity: 0.0013, exposure: 1.12,
    cloud: 0.25, cloudLit: [1.0, 0.78, 0.58], cloudDark: [0.58, 0.48, 0.55],
    warm: 0xffcf98, cool: 0x9cabd6, night: 0, headlights: false, sunSize: 1.4,
  },
  dawn: {
    label: 'Dawn',
    top: 0x8a9cc8, zenith: 0x4a5c94, horizon: 0xf2c7c4,
    light: 0xffc9b8, lightIntensity: 1.7, dir: [0.70, 0.10, 0.70],
    hemiSky: 0xc8c8e0, hemiGround: 0x7a6c70, hemi: 1.1, fill: 0.4,
    fog: 0xdcc8d2, fogDensity: 0.0016, exposure: 1.15,
    cloud: 0.18, cloudLit: [1.0, 0.82, 0.84], cloudDark: [0.56, 0.54, 0.66],
    warm: 0xffd6c8, cool: 0xa4b0dc, night: 0, headlights: false, sunSize: 1.3,
  },
  overcast: {
    label: 'Overcast',
    top: 0x9aa4ad, zenith: 0x7d8792, horizon: 0xc6cbcf,
    light: 0xe8eef5, lightIntensity: 0.9, dir: [-0.2, 0.8, -0.5],
    hemiSky: 0xd6dde4, hemiGround: 0x8a8a84, hemi: 1.9, fill: 0.2,
    fog: 0xbfc5ca, fogDensity: 0.0021, exposure: 1.10,
    cloud: 0.92, cloudLit: [0.80, 0.82, 0.86], cloudDark: [0.52, 0.55, 0.60],
    warm: 0xf0e4d4, cool: 0xb0bccc, night: 0, headlights: false,
  },
  night: {
    label: 'Full moon',
    top: 0x0d1a33, zenith: 0x040914, horizon: 0x24334f,
    // Moonlight: cool, a fraction of the sun, still casting shadows — a
    // full moon throws a hard-edged shadow, and losing it reads as darkness
    // rather than night.
    light: 0xa9bfff, lightIntensity: 0.62, dir: [0.42, 0.50, -0.76],
    hemiSky: 0x33456b, hemiGround: 0x0c0f16, hemi: 0.42, fill: 0.08,
    fog: 0x111b2c, fogDensity: 0.0017, exposure: 1.05,
    cloud: 0.16, cloudLit: [0.42, 0.48, 0.62], cloudDark: [0.12, 0.15, 0.22],
    warm: 0xd8dcff, cool: 0x8095c8, night: 1, headlights: true,
  },
};
export const SKY_NAMES = Object.keys(SKY_PRESETS);

const KEY = 'highroads.sky';
/** The saved / URL-chosen preset name. URL wins. */
export function chosenSky() {
  try {
    const u = new URLSearchParams(location.search).get('sky');
    if (u && SKY_PRESETS[u]) return u;
  } catch (e) { /* no location (Node) */ }
  try {
    const v = localStorage.getItem(KEY);
    if (v && SKY_PRESETS[v]) return v;
  } catch (e) { /* private window, or Node */ }
  return 'day';
}
export function saveSky(name) {
  try { localStorage.setItem(KEY, name); } catch (e) { /* ignore */ }
}

/**
 * Apply a preset to the live scene. `gfx` is scene.js's result; `extras`
 * may carry `water` (env/water.js) to keep the lakes reflecting this sky.
 */
export function applySky(gfx, name, extras = {}) {
  const P = SKY_PRESETS[name] || SKY_PRESETS.day;
  const u = gfx.sky.material.uniforms;
  u.uTop.value.set(P.top);
  u.uZenith.value.set(P.zenith);
  u.uHorizon.value.set(P.horizon);
  u.uSun.value.set(P.light);
  u.uNight.value = P.night;
  u.uCloud.value = P.cloud;
  u.uCloudLit.value.setRGB(...P.cloudLit);
  u.uCloudDark.value.setRGB(...P.cloudDark);
  u.uSunSize.value = P.sunSize || 1;

  gfx.sunDir.set(P.dir[0], P.dir[1], P.dir[2]).normalize();
  // The title rig picks its lit side from this.
  ATMOSPHERE.sunDir.x = gfx.sunDir.x; ATMOSPHERE.sunDir.y = gfx.sunDir.y; ATMOSPHERE.sunDir.z = gfx.sunDir.z;
  u.uSunDir.value.copy(gfx.sunDir);

  gfx.sun.color.set(P.light);
  gfx.sun.intensity = P.lightIntensity;
  gfx.hemi.color.set(P.hemiSky);
  gfx.hemi.groundColor.set(P.hemiGround);
  gfx.hemi.intensity = P.hemi;
  if (gfx.fill) {
    gfx.fill.intensity = P.fill;
    gfx.fill.position.copy(gfx.sunDir).multiplyScalar(-100).setY(60);
  }
  gfx.scene.fog.color.set(P.fog);
  if (P.fogDensity != null) gfx.scene.fog.density = P.fogDensity;
  else if (gfx.baseFogDensity != null) gfx.scene.fog.density = gfx.baseFogDensity;
  gfx.scene.background = gfx.scene.fog.color;
  gfx.renderer.toneMappingExposure = P.exposure;
  if (gfx.grade) {
    gfx.grade.uniforms.uWarm.value.set(P.warm);
    gfx.grade.uniforms.uCool.value.set(P.cool);
  }
  if (extras.water) {
    extras.water.setSky({
      skyTop: P.top, horizon: P.horizon, lightDir: gfx.sunDir, lightColor: P.light,
      night: P.night, lightPower: P.night ? 900 : 260,
    });
  }
  gfx.skyName = name;
  return P;
}
