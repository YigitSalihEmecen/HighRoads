/**
 * scene.js — renderer, lighting, sky and post-processing.
 *
 * The fog colour, the sky horizon and the sun tint come from one warm family,
 * so distant geometry ends in the fog instead of at a visible edge.
 */

import { PERF } from './perf.js';
import * as THREE from 'three';
import { ATMOSPHERE, CAMERA } from './config.js';
import { SKY_VERT, SKY_FRAG, skyUniforms, applySky, chosenSky } from './sky.js';

/**
 * Radial blur, strength driven by road speed.
 *
 * Replaces depth-of-field, which focused at one distance and blurred the car
 * five metres ahead of the camera. Samples smear away from the screen centre,
 * so the car and road ahead stay sharp and the periphery streaks.
 *
 * GLSL ES 1.00 only — no const arrays, no in/out.
 */

/**
 * The FINISH pass: radial speed blur and the grade (split tone, S-curve,
 * vignette) in one full-screen pass. They were two, and the blur's nine taps
 * ran even with the car standing still — measured, the pair cost ~130 ms of a
 * SwiftShader 720p frame. The blur is a uniform branch, so at zero strength
 * it costs nothing.
 */
const FINISH_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uStrength: { value: 0 },
    uInner: { value: 0.16 },
    uAmount: { value: 0.16 },
    uWarm: { value: new THREE.Color(0xffd9ac) },
    uCool: { value: new THREE.Color(0xa8bcd8) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uStrength;
    uniform float uInner;
    uniform float uAmount;
    uniform vec3 uWarm;
    uniform vec3 uCool;
    varying vec2 vUv;

    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 toCentre = vUv - vec2(0.5);
      if (uStrength > 0.0005) {
        // Sharp core, then the smear grows quadratically toward the corners.
        float falloff = smoothstep(uInner, 0.72, length(toCentre));
        float amount = uStrength * falloff * falloff;
        vec4 sum = c;
        float weight = 1.0;
        for (int i = 1; i <= 8; i++) {
          float t = float(i) / 8.0;
          float w = 1.0 - t * 0.55;
          sum += texture2D(tDiffuse, vUv - toCentre * amount * t) * w;
          weight += w;
        }
        c = sum / weight;
      }

      // Split tone: warm the highlights, cool the shadows, for depth.
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(c.rgb * uCool, c.rgb * uWarm, smoothstep(0.18, 0.85, l));

      // Gentle S-curve for midtone contrast, leaving the ends alone.
      // On the clamped value: the cubic goes NEGATIVE above 1, and a bright
      // sun disc (HDR here, before tone mapping) came out green.
      vec3 cc = clamp(c.rgb, 0.0, 1.0);
      c.rgb = mix(c.rgb, cc * cc * (3.0 - 2.0 * cc) + max(c.rgb - 1.0, 0.0), 0.22);

      float d = distance(vUv, vec2(0.5));
      c.rgb *= mix(1.0 - uAmount, 1.0, smoothstep(0.80, 0.30, d));
      gl_FragColor = c;
    }
  `,
};

export async function createScene(container) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Neutral rather than ACES: its shoulder crushes highlights into glare.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = ATMOSPHERE.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const fogColor = new THREE.Color(ATMOSPHERE.fogColor);
  scene.fog = new THREE.FogExp2(fogColor, ATMOSPHERE.fogDensity);
  scene.background = fogColor;

  const camera = new THREE.PerspectiveCamera(
    CAMERA.fov,
    window.innerWidth / window.innerHeight,
    CAMERA.near,
    CAMERA.far
  );
  camera.position.set(0, 6, 14);

  const sunDir = new THREE.Vector3(
    ATMOSPHERE.sunDir.x,
    ATMOSPHERE.sunDir.y,
    ATMOSPHERE.sunDir.z
  ).normalize();

  const sun = new THREE.DirectionalLight(ATMOSPHERE.sunColor, ATMOSPHERE.sunIntensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(ATMOSPHERE.shadowMapSize, ATMOSPHERE.shadowMapSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 420;
  const r = ATMOSPHERE.shadowRadius;
  sun.shadow.camera.left = -r;
  sun.shadow.camera.right = r;
  sun.shadow.camera.top = r;
  sun.shadow.camera.bottom = -r;
  // normalBias handles the low sun angle better than a constant bias does.
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.06;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(
    ATMOSPHERE.hemiSky,
    ATMOSPHERE.hemiGround,
    ATMOSPHERE.hemiIntensity
  );
  scene.add(hemi);

  // A dim fill from the anti-sun side keeps shadowed faces readable without
  // washing out the directional key.
  const fill = new THREE.DirectionalLight(0xaec8e8, 0.5);
  fill.position.copy(sunDir).multiplyScalar(-100).setY(60);
  scene.add(fill);

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 20),
    new THREE.ShaderMaterial({
      uniforms: skyUniforms(),
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    })
  );
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  scene.add(sky);

  // Optional: if the addon modules fail to load we fall back to a direct render.
  let composer = null;
  let renderPass = null;
  let speedBlur = null;
  let vignette = null;
  try {
    const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { ShaderPass }, { OutputPass }] =
      await Promise.all([
        import('three/addons/postprocessing/EffectComposer.js'),
        import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/UnrealBloomPass.js'),
        import('three/addons/postprocessing/ShaderPass.js'),
        import('three/addons/postprocessing/OutputPass.js'),
      ]);

    composer = new EffectComposer(renderer);
    renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      ATMOSPHERE.bloomStrength,
      0.7,
      ATMOSPHERE.bloomThreshold
    );
    // Quarter resolution (the pass halves what it is given): at strength 0.1
    // the bloom is a soft glow, and its dozen blur passes were ~90 ms of a
    // SwiftShader 720p frame at half resolution.
    const bloomSize = bloom.setSize.bind(bloom);
    bloom.setSize = (w, h) => bloomSize(Math.max(2, w / 2), Math.max(2, h / 2));
    composer.addPass(bloom);
    vignette = new ShaderPass(FINISH_SHADER);
    // Drive the config value instead of the shader's hard-coded default.
    vignette.uniforms.uAmount.value = ATMOSPHERE.vignette;
    vignette.uniforms.uInner.value = ATMOSPHERE.speedBlurInner;
    composer.addPass(vignette);
    if (ATMOSPHERE.speedBlur > 0) speedBlur = vignette;
    composer.addPass(new OutputPass()); // tone mapping + sRGB happen here
    composer.setSize(window.innerWidth, window.innerHeight);
  } catch (err) {
    console.warn('[highroads] post-processing unavailable, rendering direct.', err);
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (composer) composer.setSize(w, h);
  }
  window.addEventListener('resize', resize);

  // Keeps the sky dome and the shadow frustum locked to the vehicle.
  let clock = 0;
  function follow(target, dt = 0) {
    clock += dt;
    sky.material.uniforms.uTime.value = clock;
    sky.position.copy(camera.position);
    sky.scale.setScalar(CAMERA.far * 0.9);

    sun.target.position.copy(target);
    sun.position.copy(target).addScaledVector(sunDir, 180);
    sun.target.updateMatrixWorld();
  }

  function render() {
    // With ?perf, count the whole frame's draw calls (shadow pass, scene and
    // every post pass) rather than only the last render() the info saw.
    if (PERF.on) { renderer.info.autoReset = false; renderer.info.reset(); }
    if (composer) composer.render();
    else renderer.render(scene, camera);
    if (PERF.on) {
      PERF.add('.calls', renderer.info.render.calls);
      PERF.add('.tris', renderer.info.render.triangles / 1000);
    }
  }

  /**
   * Dynamic resolution. The frame's wall time (rAF to rAF) is smoothed; if it
   * stays over budget for ~1 s the render pixel ratio steps down, and after
   * ~4 s of clear headroom it steps back up. Bounded to [75 % of the device
   * ratio (never under 1.0), the device ratio capped at 2]. On a fill-bound
   * GPU — a high-DPI laptop or phone — this is the difference between a
   * steady 60 and a stutter at 40, for a softening few notice in motion.
   */
  const baseRatio = Math.min(window.devicePixelRatio, 2);
  const minRatio = Math.min(baseRatio, Math.max(1, baseRatio * 0.75));
  let ratio = baseRatio, ema = 16.7, over = 0, under = 0;
  function adapt(frameMs) {
    if (!(frameMs > 0) || frameMs > 250) return;      // a tab switch, not load
    ema += (frameMs - ema) * 0.08;
    over = ema > 19.5 ? over + 1 : 0;
    under = ema < 15.5 ? under + 1 : 0;
    let next = ratio;
    if (over > 60 && ratio > minRatio) next = Math.max(minRatio, ratio * 0.88);
    else if (under > 240 && ratio < baseRatio) next = Math.min(baseRatio, ratio / 0.88);
    if (next !== ratio) {
      ratio = next; over = 0; under = 0;
      renderer.setPixelRatio(ratio);
      if (composer) { composer.setPixelRatio(ratio); composer.setSize(window.innerWidth, window.innerHeight); }
    }
  }

  // How hard the periphery streaks. `t` is 0..1 across the speed range.
  function setSpeedBlur(t) {
    if (!speedBlur) return;
    speedBlur.uniforms.uStrength.value = ATMOSPHERE.speedBlur * Math.max(0, Math.min(1, t));
  }

  const gfx = {
    renderer, scene, camera, sun, hemi, fill, sky, sunDir, composer, follow, render, resize,
    setSpeedBlur, grade: vignette, baseFogDensity: ATMOSPHERE.fogDensity, speedBlur, adapt,
    get pixelRatio() { return ratio; },
  };
  // The sky preset (sky.js): the URL's `?sky=`, else the saved choice, else day.
  applySky(gfx, chosenSky());
  return gfx;
}
