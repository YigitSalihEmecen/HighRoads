/**
 * scene.js — renderer, golden-hour lighting rig, procedural sky, post stack.
 *
 * The atmosphere is built around one rule: the fog colour, the sky horizon and
 * the sun tint all come from the same warm family. Distant geometry dissolves
 * into the horizon instead of ending at a visible edge, which is what lets the
 * chunk system get away with a finite draw distance.
 */

import * as THREE from 'three';
import { ATMOSPHERE, CAMERA } from './config.js';

/* ------------------------------------------------------------------ sky -- */

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    // Kill translation so the dome is always centred on the camera.
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPos;
    gl_Position.z = gl_Position.w; // force to the far plane
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uSun;
  uniform vec3 uSunDir;
  uniform float uTime;
  varying vec3 vDir;

  // Cheap value noise + fbm, enough for cloud shape at sky scale.
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
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

  void main() {
    vec3 dir = normalize(vDir);
    float h = clamp(dir.y, -1.0, 1.0);

    // Three-stop gradient. A two-stop sky is the single biggest reason a scene
    // reads as flat: real sky darkens and saturates toward the zenith while
    // staying pale and desaturated at the horizon, and that vertical falloff is
    // most of the depth cue.
    float t = pow(clamp(h * 1.15, 0.0, 1.0), 0.55);
    vec3 col = mix(uHorizon, uTop, t);
    col = mix(col, uZenith, pow(clamp(h, 0.0, 1.0), 2.1) * 0.85);

    // Below the eyeline, settle into haze so terrain gaps read as ground.
    col = mix(col * 0.95, col, smoothstep(-0.25, 0.02, h));

    // Clouds, projected onto the dome. Dividing by height stretches them toward
    // the horizon the way perspective actually does, instead of pasting a
    // uniform texture across the sky.
    float band = smoothstep(0.02, 0.36, h);
    vec2 cuv = dir.xz / max(0.16, h + 0.08) * 0.9 + vec2(uTime * 0.004, uTime * 0.0016);
    float n = fbm(cuv * 1.35);
    float wisp = fbm(cuv * 3.7 + n);
    float cloud = smoothstep(0.52, 0.86, n * 0.72 + wisp * 0.42) * band;

    float sd = max(dot(dir, uSunDir), 0.0);
    // Silver lining: clouds facing the sun are brighter at their edges.
    vec3 cloudCol = mix(vec3(0.86, 0.88, 0.92), uSun * 1.08, pow(sd, 3.0) * 0.55);
    col = mix(col, cloudCol, cloud * 0.72);

    // A restrained sun: soft glow, tight halo, small disc.
    col += uSun * pow(sd, 10.0) * 0.11 * (1.0 - cloud * 0.7);
    col += uSun * pow(sd, 400.0) * 0.32 * (1.0 - cloud * 0.85);
    col += uSun * smoothstep(0.9996, 0.9999, sd) * 1.1 * (1.0 - cloud);

    gl_FragColor = vec4(col, 1.0);
  }
`;

/* ------------------------------------------------------------ speed blur -- */

/**
 * Radial blur, strength driven by road speed.
 *
 * This replaces a depth-of-field pass, which was the wrong tool: it focuses at
 * ONE distance, and with focus pulled out to the horizon at speed the car —
 * five metres from the camera — was the most out-of-focus thing on screen. A
 * driving game blurring the car the player is steering is nonsense.
 *
 * Radial blur is the effect that actually belongs here. The centre of the
 * screen, where the car and the road ahead are, stays perfectly sharp; samples
 * are smeared along the direction away from the centre, so the periphery
 * streaks past. It reads as speed because that is what speed looks like, and it
 * never touches the thing you are looking at.
 *
 * GLSL ES 1.00 only — no const arrays, no in/out. See the bug ledger.
 */
const SPEED_BLUR_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uStrength: { value: 0 },
    uInner: { value: 0.16 },
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
    varying vec2 vUv;

    void main() {
      vec2 toCentre = vUv - vec2(0.5);
      float r = length(toCentre);
      // Sharp core, then the smear grows quadratically toward the corners.
      float falloff = smoothstep(uInner, 0.72, r);
      float amount = uStrength * falloff * falloff;

      vec4 sum = texture2D(tDiffuse, vUv);
      float weight = 1.0;
      for (int i = 1; i <= 8; i++) {
        float t = float(i) / 8.0;
        vec2 off = toCentre * amount * t;
        float w = 1.0 - t * 0.55;
        sum += texture2D(tDiffuse, vUv - off) * w;
        weight += w;
      }
      gl_FragColor = sum / weight;
    }
  `,
};

/* --------------------------------------------------------------- vignette -- */

const VIGNETTE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
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
    uniform float uAmount;
    uniform vec3 uWarm;
    uniform vec3 uCool;
    varying vec2 vUv;

    void main() {
      vec4 c = texture2D(tDiffuse, vUv);

      // Split tone: warm the highlights, cool the shadows. A single global tint
      // just shifts everything and still reads flat; opposing the two ends is
      // what gives an image depth without touching contrast.
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(c.rgb * uCool, c.rgb * uWarm, smoothstep(0.18, 0.85, l));

      // Gentle S-curve. Gains a little contrast in the midtones while leaving
      // the ends alone, so the highlights do not clip back to the flat look.
      c.rgb = mix(c.rgb, c.rgb * c.rgb * (3.0 - 2.0 * c.rgb), 0.22);

      float d = distance(vUv, vec2(0.5));
      c.rgb *= mix(1.0 - uAmount, 1.0, smoothstep(0.80, 0.30, d));
      gl_FragColor = c;
    }
  `,
};

/* ------------------------------------------------------------------------- */

export async function createScene(container) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Neutral rather than ACES: the filmic curve's shoulder is what was crushing
  // the highlights into that blown-out glare. Neutral keeps hues stable and the
  // midtones open, which is most of the "pastel" look.
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

  // ------------------------------------------------------------- lighting --

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
  // normalBias handles the low sun angle far better than a constant bias does:
  // grazing light on the terrain would otherwise shadow-acne badly.
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

  // ------------------------------------------------------------------ sky --

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 20),
    new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color(ATMOSPHERE.skyTop) },
        uHorizon: { value: new THREE.Color(ATMOSPHERE.skyHorizon) },
        uZenith: { value: new THREE.Color(ATMOSPHERE.skyZenith) },
        uSun: { value: new THREE.Color(ATMOSPHERE.sunColor) },
        uSunDir: { value: sunDir.clone() },
        uTime: { value: 0 },
      },
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

  // ------------------------------------------------------- post-processing --
  // Optional: if the addon modules fail to load we fall back to a direct render
  // rather than taking the whole game down with us.

  let composer = null;
  let renderPass = null;
  let speedBlur = null;
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
    // Kept, so `render` can point the whole post chain at a different scene —
    // the showroom borrows the bloom and the vignette rather than running its
    // own composer, which would mean two of everything.
    renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    composer.addPass(
      new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        ATMOSPHERE.bloomStrength,
        0.7,
        ATMOSPHERE.bloomThreshold
      )
    );
    const vignette = new ShaderPass(VIGNETTE_SHADER);
    // Was hard-coded in the shader's default while ATMOSPHERE.vignette sat
    // unread, so turning the knob in config did nothing.
    vignette.uniforms.uAmount.value = ATMOSPHERE.vignette;
    composer.addPass(vignette);
    if (ATMOSPHERE.speedBlur > 0) {
      speedBlur = new ShaderPass(SPEED_BLUR_SHADER);
      speedBlur.uniforms.uInner.value = ATMOSPHERE.speedBlurInner;
      composer.addPass(speedBlur);
    }
    composer.addPass(new OutputPass()); // tone mapping + sRGB happen here
    composer.setSize(window.innerWidth, window.innerHeight);
  } catch (err) {
    console.warn('[fastroads] post-processing unavailable, rendering direct.', err);
  }

  // ---------------------------------------------------------------- resize --

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (composer) composer.setSize(w, h);
  }
  window.addEventListener('resize', resize);

  /** Keeps the sky dome and the shadow frustum locked to the vehicle. */
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

  /**
   * Draws the world, or something else entirely.
   *
   * The title screen is its own scene with its own camera and its own lights
   * (showroom.js), but it should still get the same bloom, vignette and tone
   * mapping as the game — so it is swapped into the existing chain rather than
   * given a second one.
   */
  function render(altScene, altCamera) {
    const useScene = altScene || scene;
    const useCamera = altCamera || camera;
    if (composer) {
      renderPass.scene = useScene;
      renderPass.camera = useCamera;
      composer.render();
    } else {
      renderer.render(useScene, useCamera);
    }
  }

  /** How hard the periphery streaks. `t` is 0..1 across the speed range. */
  function setSpeedBlur(t) {
    if (!speedBlur) return;
    speedBlur.uniforms.uStrength.value = ATMOSPHERE.speedBlur * Math.max(0, Math.min(1, t));
  }

  return { renderer, scene, camera, sun, hemi, sky, sunDir, composer, follow, render, resize, setSpeedBlur };
}
