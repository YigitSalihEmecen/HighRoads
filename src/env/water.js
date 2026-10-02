/**
 * env/water.js — the lakes' surfaces.
 *
 * One mesh per lake, built when the lake comes within the tile radius and
 * dropped when it leaves it. The mesh is a polar grid reaching a little past
 * the shoreline; every vertex carries its WATER DEPTH (level minus the ground
 * there, from the same terrain field the tiles draw), and the shader does the
 * rest:
 *
 *   - depth tints the body (shallows to deep) and fades the edge to nothing,
 *     so the waterline is a soft blend into the beach, not a hard polygon;
 *   - normals are a sum of four directional travelling waves (analytic
 *     derivatives — no normal map to fetch) plus a fine ripple, scrolled by
 *     time and scaled down near the shore, where a lake is calmest;
 *   - Fresnel (Schlick) mixes the body colour toward a reflection of the SKY,
 *     taken from the current sky preset's horizon/zenith colours, so a lake is
 *     a mirror at a grazing angle and clear looking down;
 *   - a tight specular lobe on the sun (or the moon at night) makes the glint
 *     path;
 *   - a band of animated foam where the water is shallowest.
 *
 * Nothing here allocates per frame; `update()` only writes uniforms.
 */

import * as THREE from 'three';
import { WATER, TILES } from '../config.js';

const RINGS = 22;
const SEGS = 56;

const VERT = /* glsl */`
  attribute float aDepth;
  varying float vDepth;
  varying vec3 vWorld;
  #include <fog_pars_vertex>
  void main() {
    vDepth = aDepth;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */`
  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uFoam;
  uniform vec3 uSkyTop;
  uniform vec3 uHorizon;
  uniform vec3 uLightDir;
  uniform vec3 uLightColor;
  uniform float uLightPower;
  uniform float uNight;
  varying float vDepth;
  varying vec3 vWorld;
  #include <fog_pars_fragment>

  // one travelling wave: height derivative (dh/dx, dh/dz)
  vec2 wave(vec2 p, vec2 dir, float freq, float amp, float speed) {
    float ph = dot(p, dir) * freq + uTime * speed;
    return dir * (cos(ph) * freq * amp);
  }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }

  void main() {
    if (vDepth < -0.05) discard;
    vec2 p = vWorld.xz;
    float calm = smoothstep(0.0, 2.5, vDepth);
    vec2 d = vec2(0.0);
    d += wave(p, normalize(vec2(1.0, 0.3)), 0.32, 0.060, 1.3);
    d += wave(p, normalize(vec2(-0.4, 1.0)), 0.51, 0.040, 1.7);
    d += wave(p, normalize(vec2(0.7, -0.8)), 0.93, 0.022, 2.4);
    d += wave(p, normalize(vec2(-1.0, -0.2)), 1.70, 0.012, 3.1);
    // fine ripple: finite difference of scrolling value noise
    vec2 q = p * 0.9 + vec2(uTime * 0.35, -uTime * 0.27);
    float r0 = vnoise(q), rx = vnoise(q + vec2(0.15, 0.0)), rz = vnoise(q + vec2(0.0, 0.15));
    d += vec2(rx - r0, rz - r0) * 0.55;
    d *= mix(0.35, 1.0, calm);
    vec3 N = normalize(vec3(-d.x, 1.0, -d.y));

    vec3 V = normalize(cameraPosition - vWorld);
    float ndv = max(dot(N, V), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
    vec3 R = reflect(-V, N);
    vec3 sky = mix(uHorizon, uSkyTop, smoothstep(-0.02, 0.55, R.y));

    vec3 body = mix(uShallow, uDeep, smoothstep(0.2, 4.5, vDepth));
    // light in the body: water is lit from above and scatters a little
    body *= mix(1.0, 0.55, uNight) * (0.75 + 0.25 * max(uLightDir.y, 0.0));

    vec3 col = mix(body, sky, fres * 0.92);
    float spec = pow(max(dot(R, uLightDir), 0.0), uLightPower);
    col += uLightColor * spec * (uNight > 0.5 ? 1.6 : 2.4);

    // shore foam: a broken band in the shallowest water
    float band = 1.0 - smoothstep(0.05, 0.45, vDepth);
    float n = vnoise(p * 1.7 + vec2(uTime * 0.6, uTime * 0.4)) * 0.6 + vnoise(p * 4.1 - uTime * 0.8) * 0.4;
    float foam = band * smoothstep(0.42, 0.62, n + band * 0.35);
    col = mix(col, uFoam * mix(1.0, 0.35, uNight), foam * 0.85);

    float alpha = smoothstep(-0.05, 0.30, vDepth) * mix(0.82, 0.97, smoothstep(0.3, 3.0, vDepth));
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export class WaterSystem {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {import('../terrainfield.js').TerrainField} o.field
   */
  constructor({ scene, field }) {
    this.scene = scene;
    this.field = field;
    this.meshes = new Map();   // lake -> mesh
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uDeep: { value: new THREE.Color(WATER.deep) },
          uShallow: { value: new THREE.Color(WATER.shallow) },
          uFoam: { value: new THREE.Color(WATER.foam) },
          uSkyTop: { value: new THREE.Color(0x6f9ccc) },
          uHorizon: { value: new THREE.Color(0xdde3e2) },
          uLightDir: { value: new THREE.Vector3(-0.34, 0.62, -0.71).normalize() },
          uLightColor: { value: new THREE.Color(0xfff4e6) },
          uLightPower: { value: 260 },
          uNight: { value: 0 },
        },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
  }

  /** Called by the sky presets: the water reflects whatever sky is up. */
  setSky({ skyTop, horizon, lightDir, lightColor, night = 0, lightPower }) {
    const u = this.material.uniforms;
    if (skyTop) u.uSkyTop.value.set(skyTop);
    if (horizon) u.uHorizon.value.set(horizon);
    if (lightDir) u.uLightDir.value.copy(lightDir).normalize();
    if (lightColor) u.uLightColor.value.set(lightColor);
    if (lightPower) u.uLightPower.value = lightPower;
    u.uNight.value = night;
  }

  update(fx, fz, time) {
    this.material.uniforms.uTime.value = time;
    if (!WATER.enabled) return;
    const lakes = this.field.lakes;
    const R = Math.min(TILES.radius, 2400);
    const c0 = Math.floor((fx - R) / WATER.cell), c1 = Math.floor((fx + R) / WATER.cell);
    const r0 = Math.floor((fz - R) / WATER.cell), r1 = Math.floor((fz + R) / WATER.cell);
    let built = 0;
    const seen = new Set();
    for (let ci = c0; ci <= c1; ci++) {
      for (let cj = r0; cj <= r1; cj++) {
        const lake = lakes.lakeIn(ci, cj);
        if (!lake) continue;
        if (!lakes._settle(lake)) continue;
        if (Math.hypot(lake.cx - fx, lake.cz - fz) > R) continue;
        seen.add(lake);
        if (!this.meshes.has(lake) && built < 1) { this._build(lake); built++; }
      }
    }
    for (const [lake, mesh] of this.meshes) {
      if (seen.has(lake) && lake.ok) continue;
      if (lake.ok && Math.hypot(lake.cx - fx, lake.cz - fz) < R + 400) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      this.meshes.delete(lake);
    }
  }

  _build(lake) {
    const lakes = this.field.lakes;
    const pos = new Float32Array((1 + RINGS * SEGS) * 3);
    const depth = new Float32Array(1 + RINGS * SEGS);
    pos[0] = 0; pos[1] = 0; pos[2] = 0;
    depth[0] = lake.level - this.field.height(lake.cx, lake.cz);
    for (let r = 1; r <= RINGS; r++) {
      for (let s = 0; s < SEGS; s++) {
        const a = (s / SEGS) * Math.PI * 2;
        const rr = lakes.radiusAt(lake, a) * 1.14 * Math.pow(r / RINGS, 0.8);
        const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
        const k = 1 + (r - 1) * SEGS + s;
        pos[k * 3] = x; pos[k * 3 + 1] = 0; pos[k * 3 + 2] = z;
        depth[k] = lake.level - this.field.height(lake.cx + x, lake.cz + z);
      }
    }
    const idx = [];
    for (let s = 0; s < SEGS; s++) idx.push(0, 1 + (s + 1) % SEGS, 1 + s);
    for (let r = 1; r < RINGS; r++) {
      for (let s = 0; s < SEGS; s++) {
        const a = 1 + (r - 1) * SEGS + s, b = 1 + (r - 1) * SEGS + (s + 1) % SEGS;
        const c = a + SEGS, d = b + SEGS;
        // Drop quads that are dry at every corner.
        if (depth[a] < -0.3 && depth[b] < -0.3 && depth[c] < -0.3 && depth[d] < -0.3) continue;
        idx.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(lake.cx, lake.level, lake.cz);
    mesh.renderOrder = 2;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);
    this.meshes.set(lake, mesh);
  }

  dispose() {
    for (const mesh of this.meshes.values()) { this.scene.remove(mesh); mesh.geometry.dispose(); }
    this.meshes.clear();
    this.material.dispose();
  }
}
