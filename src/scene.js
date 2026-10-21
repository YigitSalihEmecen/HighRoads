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
 * One bad pixel in the scene buffer and bloom smears it over the whole frame:
 * a NaN draws the screen black, an Inf white. Both are guarded for every
 * built-in material here, ahead of any shader compile.
 *
 * NaN: the road ribbon and car_gen's meshes carry zero-length vertex normals
 * (zero-area quads under computeVertexNormals), and normalize() of zero is
 * NaN, per vertex and again per pixel. A sliver triangle holding one covers a
 * pixel every few hundred frames, and that frame is black.
 *
 * Inf: a sun glint on clearcoat or chrome was measured at 33,184 in the
 * half-float buffer (max 65,504). 1024 is far above any lamp and still white
 * after tone mapping.
 */
THREE.ShaderChunk.normal_vertex = THREE.ShaderChunk.normal_vertex.replace(
  'vNormal = normalize( transformedNormal );',
  'vNormal = dot( transformedNormal, transformedNormal ) > 1e-12 ? normalize( transformedNormal ) : vec3( 0.0, 0.0, 1.0 );');
THREE.ShaderChunk.normal_fragment_begin = THREE.ShaderChunk.normal_fragment_begin.replace(
  'vec3 normal = normalize( vNormal );',
  'vec3 normal = dot( vNormal, vNormal ) > 1e-12 ? normalize( vNormal ) : vec3( 0.0, 0.0, 1.0 );');
THREE.ShaderChunk.opaque_fragment = THREE.ShaderChunk.opaque_fragment.replace(
  'vec4( outgoingLight,', 'vec4( min( outgoingLight, vec3( 1024.0 ) ),');

/**
 * Height fog: haze pools below the camera and thins above it. Each vertex
 * scales the fog density by its world height relative to the camera, so
 * valleys fill and ridgetops clear without a per-material uniform. Clamped
 * so a long drop never turns the fog into a wall.
 */
THREE.ShaderChunk.fog_pars_vertex = THREE.ShaderChunk.fog_pars_vertex.replace(
  'varying float vFogDepth;', 'varying float vFogDepth;\n\tvarying float vFogMul;');
THREE.ShaderChunk.fog_pars_fragment = THREE.ShaderChunk.fog_pars_fragment.replace(
  'varying float vFogDepth;', 'varying float vFogDepth;\n\tvarying float vFogMul;');
THREE.ShaderChunk.fog_vertex = THREE.ShaderChunk.fog_vertex.replace(
  'vFogDepth = - mvPosition.z;',
  `vFogDepth = - mvPosition.z;
	vFogMul = clamp( exp( -0.004 * ( dot( viewMatrix[ 1 ].xyz, mvPosition.xyz ) ) ), 0.55, 1.6 );`);
THREE.ShaderChunk.fog_fragment = THREE.ShaderChunk.fog_fragment.replace(
  'fogDensity * fogDensity * vFogDepth * vFogDepth',
  'fogDensity * fogDensity * vFogMul * vFogMul * vFogDepth * vFogDepth');

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
 * The FINISH: radial speed blur and the grade (split tone, S-curve, vignette),
 * spliced into the OutputPass ahead of its tone mapping, so the whole post
 * chain ends in ONE full-screen pass instead of two (a 2× display reads and
 * writes ~40 MB of half-float per pass). The blur is a uniform branch, so at
 * zero strength it costs nothing.
 */
const FINISH = {
  uniforms: {
    uStrength: { value: 0 },
    uTime: { value: 0 },
    uGrain: { value: 0.025 },
    uInner: { value: 0.16 },
    uAmount: { value: 0.16 },
    uWarm: { value: new THREE.Color(0xffd9ac) },
    uCool: { value: new THREE.Color(0xa8bcd8) },
  },
  pars: /* glsl */ `
    uniform float uStrength;
    uniform float uTime;
    uniform float uGrain;
    uniform float uInner;
    uniform float uAmount;
    uniform vec3 uWarm;
    uniform vec3 uCool;
  `,
  body: /* glsl */ `
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 toCentre = vUv - vec2(0.5);
      if (uStrength > 0.0005) {
        // Lens fringing: red and blue split outward, only at speed.
        vec2 split = toCentre * dot(toCentre, toCentre) * uStrength * 0.25;
        c.r = texture2D(tDiffuse, vUv - split).r;
        c.b = texture2D(tDiffuse, vUv + split).b;
      }
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

      c.rgb = mix(vec3(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722))), c.rgb, 1.08);

      float d = distance(vUv, vec2(0.5));
      c.rgb *= mix(1.0 - uAmount, 1.0, smoothstep(0.80, 0.30, d));
      // Opaque: a coverage cutout leaves alpha under 1, and the page would show through.
      gl_FragColor = vec4(c.rgb, 1.0);
  `,
};

FINISH.grain = /* glsl */ `
				// Triangular-PDF noise in display space: breaks up banding in the sky and paint.
				vec2 gp = gl_FragCoord.xy + fract(uTime) * 61.0;
				float n = fract(sin(dot(gp, vec2(12.9898, 78.233))) * 43758.5453)
				        + fract(sin(dot(gp, vec2(39.3468, 11.135))) * 24634.6345) - 1.0;
				gl_FragColor.rgb += n * uGrain;
`;

/** OutputPass (tone mapping + sRGB) with the FINISH run on its input first. */
function finishOutput(OutputPass) {
  const pass = new OutputPass();
  Object.assign(pass.uniforms, THREE.UniformsUtils.clone(FINISH.uniforms));
  const src = pass.material.fragmentShader;
  const read = 'gl_FragColor = texture2D( tDiffuse, vUv );';
  if (!src.includes(read)) throw new Error('OutputShader changed: FINISH cannot be spliced in');
  const encode = 'gl_FragColor = sRGBTransferOETF( gl_FragColor );';
  if (!src.includes(encode)) throw new Error('OutputShader changed: grain cannot be spliced in');
  pass.material.fragmentShader = src
    .replace('varying vec2 vUv;', 'varying vec2 vUv;' + FINISH.pars)
    .replace(read, FINISH.body)
    .replace(encode, encode + FINISH.grain);
  return pass;
}

export async function createScene(container) {
  // No MSAA on the canvas: the scene renders into the composer's target and
  // the canvas only ever receives one full-screen triangle.
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, ATMOSPHERE.maxPixelRatio));
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
      fog: false,
    })
  );
  // Last of the opaques, at the far plane (SKY_VERT): its clouds are shaded
  // only where nothing else covers the pixel, not under every hill as well.
  sky.renderOrder = 1000;
  sky.frustumCulled = false;
  scene.add(sky);

  const envUniforms = { ...sky.material.uniforms, uGround: { value: new THREE.Color() } };
  const envScene = new THREE.Scene().add(new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 20),
    new THREE.ShaderMaterial({
      uniforms: envUniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG
        .replace('uniform vec3 uTop;', 'uniform vec3 uGround;\n  uniform vec3 uTop;')
        .replace('gl_FragColor = vec4(col, 1.0);',
          'col = mix(uGround, col, smoothstep(-0.05, 0.03, h));\n    gl_FragColor = vec4(col, 1.0);'),
      side: THREE.BackSide,
      depthWrite: false,
    })
  ));
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envTarget = null;

  /** Bakes the live sky into the scene's reflections and ambient; run on every sky change. */
  function bakeEnv() {
    if (!(ATMOSPHERE.envIntensity > 0)) return;
    envUniforms.uGround.value.copy(hemi.groundColor).multiplyScalar(0.6);
    envTarget?.dispose();
    envTarget = pmrem.fromScene(envScene, 0, 0.1, 10);
    scene.environment = envTarget.texture;
    scene.environmentIntensity = ATMOSPHERE.envIntensity;
  }

  // Optional: if the addon modules fail to load we fall back to a direct render.
  let composer = null;
  let renderPass = null;
  let speedBlur = null;
  let vignette = null;
  let bloomPass = null;
  try {
    const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }, { ShaderPass }, { FXAAShader }] =
      await Promise.all([
        import('three/addons/postprocessing/EffectComposer.js'),
        import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/UnrealBloomPass.js'),
        import('three/addons/postprocessing/OutputPass.js'),
        import('three/addons/postprocessing/ShaderPass.js'),
        import('three/addons/shaders/FXAAShader.js'),
      ]);

    // MSAA on the scene target, where it is affordable: without samples
    // alpha-to-coverage (grass, tree cards) is a hard cutout. Measured on an
    // M-series Mac through ANGLE/Metal at 2268x1417 it cost ~15 ms a frame at
    // 2x or 4x, so the levels use FXAA (`ATMOSPHERE.fxaa`) instead — SMAA's
    // three full-screen passes measured ~4.5 ms there, FXAA's one far less.
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType, samples: ATMOSPHERE.msaa,
    }));
    renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    // Medium and Low have none (bloomStrength 0): ~0.8 ms of a 6 ms frame
    // at 1.5x, for a glow most scenes never show.
    if (ATMOSPHERE.bloomStrength > 0) {
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
      bloomPass = bloom;
    }
    vignette = finishOutput(OutputPass);
    // Drive the config value instead of the shader's hard-coded default.
    vignette.uniforms.uAmount.value = ATMOSPHERE.vignette;
    vignette.uniforms.uInner.value = ATMOSPHERE.speedBlurInner;
    composer.addPass(vignette);
    if (ATMOSPHERE.speedBlur > 0) speedBlur = vignette;
    // After tone mapping: FXAA finds edges by luma in display space.
    if (ATMOSPHERE.fxaa) {
      const fxaa = new ShaderPass(FXAAShader);
      // The composer sizes passes in device pixels; FXAA wants one texel.
      fxaa.setSize = (w, h) => fxaa.uniforms.resolution.value.set(1 / w, 1 / h);
      composer.addPass(fxaa);
    }
    composer.setSize(window.innerWidth, window.innerHeight);
  } catch (err) {
    console.warn('[tothehorizon] post-processing unavailable, rendering direct.', err);
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
    if (vignette) vignette.uniforms.uTime.value = clock;
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
   * Draws another scene through the same post chain — the garage studio uses
   * it — with its own bloom and exposure; the road's settings are restored.
   */
  function renderView(view, viewCamera, { bloom = null, exposure = null } = {}) {
    const keepBloom = bloomPass ? bloomPass.strength : 0;
    const keepExposure = renderer.toneMappingExposure;
    const keepBlur = speedBlur ? speedBlur.uniforms.uStrength.value : 0;
    if (bloomPass && bloom != null) bloomPass.strength = bloom;
    if (exposure != null) renderer.toneMappingExposure = exposure;
    if (speedBlur) speedBlur.uniforms.uStrength.value = 0;
    if (renderPass) { renderPass.scene = view; renderPass.camera = viewCamera; }
    if (composer) composer.render();
    else renderer.render(view, viewCamera);
    if (renderPass) { renderPass.scene = scene; renderPass.camera = camera; }
    if (bloomPass) bloomPass.strength = keepBloom;
    renderer.toneMappingExposure = keepExposure;
    if (speedBlur) speedBlur.uniforms.uStrength.value = keepBlur;
  }

  /**
   * Dynamic resolution. The frame's wall time (rAF to rAF) is smoothed; if it
   * stays over budget for ~1 s the render pixel ratio steps down, and after
   * ~4 s of clear headroom it steps back up. Bounded to [`minPixelRatio`,
   * the device ratio capped at `maxPixelRatio`]. On a fill-bound GPU — a
   * high-DPI laptop or phone — this is the difference between a steady 60 and
   * a stutter at 40, for a softening few notice in motion.
   */
  const baseRatio = Math.min(window.devicePixelRatio, ATMOSPHERE.maxPixelRatio);
  const minRatio = Math.min(baseRatio, ATMOSPHERE.minPixelRatio);
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
    renderer, scene, camera, sun, hemi, fill, sky, sunDir, composer, follow, render, renderView, resize,
    setSpeedBlur, bakeEnv, grade: vignette, baseFogDensity: ATMOSPHERE.fogDensity, speedBlur, adapt,
    get pixelRatio() { return ratio; },
  };
  // The sky preset (sky.js): the URL's `?sky=`, else the saved choice, else day.
  applySky(gfx, chosenSky());
  return gfx;
}
