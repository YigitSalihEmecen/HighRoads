/**
 * garage.js — the studio where cars are generated and tuned.
 *
 * A separate three.js scene drawn through the road's post chain
 * (`gfx.renderView`). Everything in it is built here from primitives and
 * canvas textures: polished floor with a live reflection, a turntable with
 * an LED rim, a light-box ceiling, wall light strips, a lift, tool chests,
 * tyre racks and the odd cone. Dust drifts through soft light shafts.
 *
 * The car on the turntable is its own model (DETAIL.garage), not the one the
 * player drives: the game rebuilds that from the build when you leave.
 * A new car MATERIALISES: a scan plane rises through it, revealing the new
 * body below the line and dissolving the old one above it (clipping planes on
 * each car's own materials).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { buildModel, paintModel, DETAIL } from './models.js';
import { graphicsLevel } from './config.js';
import { damp } from './util.js';

const ACCENT = new THREE.Color('#ff6b2c');
const COOL = new THREE.Color('#5ad1ff');
const ROOM = { w: 30, d: 26, h: 7.5 };
const TABLE_R = 3.5;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Camera shots per garage tab: eye and aim, in the turntable's frame with the car facing −Z. */
const SHOTS = {
  overview: { eye: [7.4, 2.4, -7.6], aim: [0, 0.62, 0.15] },
  front:    { eye: [2.2, 1.15, -8.2], aim: [0, 0.7, 0] },
  side:     { eye: [9.2, 1.35, 0.2], aim: [0, 0.65, 0] },
  rear:     { eye: [-3.2, 1.7, 8.0], aim: [0, 0.75, 0.2] },
  wheel:    { eye: [4.0, 0.6, -3.9], aim: [0.8, 0.38, -1.3] },
  top:      { eye: [0.01, 11.5, 1.6], aim: [0, 0.4, 0] },
  paint:    { eye: [-6.8, 1.9, -6.2], aim: [0, 0.6, 0] },
};

/* --------------------------------------------------------- canvas helpers -- */

function canvasTexture(w, h, draw, { repeat = null, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

/** Speckled concrete with saw-cut joints: one 2 m tile. */
function floorTexture() {
  return canvasTexture(512, 512, (g, w, h) => {
    g.fillStyle = '#26272b';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) {
      const v = 30 + Math.random() * 22;
      g.fillStyle = `rgba(${v},${v},${v + 3},${0.25 + Math.random() * 0.35})`;
      g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    for (let i = 0; i < 14; i++) {
      const grd = g.createRadialGradient(Math.random() * w, Math.random() * h, 0, Math.random() * w, Math.random() * h, 120 + Math.random() * 180);
      grd.addColorStop(0, 'rgba(0,0,0,0.12)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, w, h);
    }
    g.strokeStyle = 'rgba(8,8,10,0.9)';
    g.lineWidth = 3;
    g.strokeRect(1.5, 1.5, w - 3, h - 3);
  }, { repeat: [ROOM.w / 2, ROOM.d / 2] });
}

/** A soft dark disc that grounds the car under any light. */
function contactShadowTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(0,0,0,0.85)');
    grd.addColorStop(0.45, 'rgba(0,0,0,0.55)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  }, { srgb: false });
}

function pegboardTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#3b3f45';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#1b1d20';
    for (let y = 8; y < h; y += 16) for (let x = 8; x < w; x += 16) {
      g.beginPath(); g.arc(x, y, 2.4, 0, Math.PI * 2); g.fill();
    }
  }, { repeat: [3, 1.5] });
}

/** Turntable top: brushed rings and a faint monogram. */
function tableTexture() {
  return canvasTexture(1024, 1024, (g, w, h) => {
    const cx = w / 2, cy = h / 2;
    g.fillStyle = '#2b2d31';
    g.fillRect(0, 0, w, h);
    for (let r = 4; r < w / 2; r += 2) {
      const v = 40 + Math.random() * 16;
      g.strokeStyle = `rgba(${v},${v},${v + 4},0.5)`;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = 3;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * w * 0.43, cy + Math.sin(a) * h * 0.43);
      g.lineTo(cx + Math.cos(a) * w * 0.47, cy + Math.sin(a) * h * 0.47);
      g.stroke();
    }
  });
}

/** The back-wall sign, redrawn once the display face has loaded. */
function signTexture() {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 384;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const draw = () => {
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    g.font = 'italic 800 220px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.shadowColor = 'rgba(255,140,80,0.9)';
    g.shadowBlur = 30;
    g.fillText('TO THE HORIZON!', 40, 170);
    const w = g.measureText('TO THE HORIZON!').width;
    g.shadowBlur = 0;
    g.fillStyle = '#ff6b2c';
    g.fillRect(48, 300, w * 0.55, 16);
    g.font = '600 64px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fillText('PERFORMANCE  GARAGE', 60 + w * 0.55 + 30, 310);
    t.needsUpdate = true;
  };
  draw();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);
  return t;
}

/* ------------------------------------------------------------- the studio -- */

export class GarageStudio {
  constructor(gfx) {
    this.gfx = gfx;
    const renderer = gfx.renderer;
    this.level = graphicsLevel();
    renderer.localClippingEnabled = true;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0b0b0d');
    this.scene.fog = new THREE.Fog('#0b0b0d', 24, 60);

    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.1, 120);
    this.camera.position.set(...SHOTS.overview.eye);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = false;
    this.controls.minDistance = 3.4;
    this.controls.maxDistance = 15;
    this.controls.minPolarAngle = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.rotateSpeed = 0.55;
    this.controls.target.set(...SHOTS.overview.aim);
    this.controls.enabled = false;
    this.controls.addEventListener('start', () => { this._userAt = this._time; this._tween = null; });

    this.active = false;
    this._time = 0;
    this._userAt = -100;
    this._tween = null;
    this.shot = 'overview';
    this.spin = true;
    this._tableAngle = 0;
    this._view = { x: 0, y: 0 };
    /** Shot distances scale by this, so the car fits whatever space the panels leave. */
    this._fit = 1;

    this.car = null;
    this.carBuild = null;
    this._ghost = null;          // the previous car, dissolving
    this._scan = null;           // { t, dur, height }

    this._buildRoom();
    this._buildTable();
    this._buildLights();
    this._buildProps();
    this._buildAtmosphere();
    this.update(0);
  }

  /* ----------------------------------------------------------- building -- */

  _buildRoom() {
    const S = this.scene;
    const hi = this.level !== 'low';

    // Floor: a mirror under a mostly opaque, slightly rough concrete skin.
    if (hi) {
      const mirror = new Reflector(new THREE.PlaneGeometry(ROOM.w, ROOM.d), {
        textureWidth: Math.floor(window.innerWidth * 0.5),
        textureHeight: Math.floor(window.innerHeight * 0.5),
        color: 0x8a8a8a,
      });
      mirror.rotation.x = -Math.PI / 2;
      mirror.position.y = -0.002;
      S.add(mirror);
      this.mirror = mirror;
    }
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM.w, ROOM.d),
      new THREE.MeshStandardMaterial({
        map: floorTexture(),
        roughness: 0.55,
        metalness: 0.05,
        transparent: hi,
        opacity: hi ? 0.8 : 1,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    S.add(floor);

    // Walls: inset panels with light strips between them.
    const wallMat = new THREE.MeshStandardMaterial({ color: '#1d1f24', roughness: 0.8, metalness: 0.1 });
    const panelMat = new THREE.MeshStandardMaterial({ color: '#1c1e22', roughness: 0.55, metalness: 0.35 });
    this.strips = [];
    const stripMat = (c) => new THREE.MeshStandardMaterial({ color: '#000', emissive: c, emissiveIntensity: 2.2 });

    const wall = (w, h, x, z, ry) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
      m.position.set(x, h / 2, z);
      m.rotation.y = ry;
      m.receiveShadow = true;
      S.add(m);
      return m;
    };
    wall(ROOM.w, ROOM.h, 0, -ROOM.d / 2, 0);
    wall(ROOM.w, ROOM.h, 0, ROOM.d / 2, Math.PI);
    wall(ROOM.d, ROOM.h, -ROOM.w / 2, 0, Math.PI / 2);
    wall(ROOM.d, ROOM.h, ROOM.w / 2, 0, -Math.PI / 2);

    // Back wall (−Z): panels, strips, and the sign.
    const panelGeo = new THREE.BoxGeometry(2.6, 4.6, 0.12);
    for (let i = -4; i <= 4; i++) {
      const x = i * 3.1;
      const p = new THREE.Mesh(panelGeo, panelMat);
      p.position.set(x, 3.1, -ROOM.d / 2 + 0.07);
      p.receiveShadow = true;
      S.add(p);
      if (i < 4) {
        const sm = stripMat(i % 3 === 0 ? ACCENT : new THREE.Color('#e9f2ff'));
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 4.4, 0.05), sm);
        strip.position.set(x + 1.55, 3.1, -ROOM.d / 2 + 0.1);
        S.add(strip);
        this.strips.push({ mat: sm, phase: i * 0.7, base: sm.emissiveIntensity });
      }
    }
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(8.4, 1.575),
      new THREE.MeshBasicMaterial({ map: signTexture(), transparent: true, toneMapped: false, depthWrite: false })
    );
    sign.position.set(-1.2, 6.15, -ROOM.d / 2 + 0.2);
    S.add(sign);

    // Side walls: horizontal accent bands at skirting and head height.
    for (const side of [-1, 1]) {
      for (const [y, c] of [[0.18, ACCENT], [5.4, COOL]]) {
        const sm = stripMat(c);
        sm.emissiveIntensity = 1.4;
        const band = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, ROOM.d - 1), sm);
        band.position.set(side * (ROOM.w / 2 - 0.05), y, 0);
        S.add(band);
        this.strips.push({ mat: sm, phase: side + y, base: 1.4 });
      }
    }

    // Ceiling, and the light box over the turntable: four bars and a diffuser.
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.w, ROOM.d), new THREE.MeshStandardMaterial({ color: '#0e0f11', roughness: 1 }));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = ROOM.h;
    S.add(ceil);
    const boxMat = new THREE.MeshStandardMaterial({ color: '#000', emissive: '#ffffff', emissiveIntensity: 3.2 });
    this.boxMat = boxMat;
    const bar = (w, d, x, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, d), boxMat);
      m.position.set(x, ROOM.h - 1.2, z);
      S.add(m);
    };
    bar(7.6, 0.22, 0, -3.1); bar(7.6, 0.22, 0, 3.1);
    bar(0.22, 6.4, -3.7, 0); bar(0.22, 6.4, 3.7, 0);
    const diffuser = new THREE.Mesh(
      new THREE.PlaneGeometry(7.2, 6),
      new THREE.MeshStandardMaterial({ color: '#000', emissive: '#dfe8ff', emissiveIntensity: 0.55, side: THREE.DoubleSide })
    );
    diffuser.rotation.x = Math.PI / 2;
    diffuser.position.y = ROOM.h - 1.16;
    S.add(diffuser);
    // Ceiling trusses beyond the box.
    const truss = new THREE.MeshStandardMaterial({ color: '#202226', roughness: 0.6, metalness: 0.6 });
    for (let z = -11; z <= 11; z += 4.4) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(ROOM.w, 0.3, 0.18), truss);
      t.position.set(0, ROOM.h - 0.25, z);
      S.add(t);
    }
  }

  _buildTable() {
    const S = this.scene;
    this.table = new THREE.Group();
    S.add(this.table);

    const metal = new THREE.MeshStandardMaterial({ map: tableTexture(), metalness: 0.5, roughness: 0.46 });
    const side = new THREE.MeshStandardMaterial({ color: '#17181b', metalness: 0.6, roughness: 0.3 });
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(TABLE_R, TABLE_R + 0.08, 0.12, 128, 1), [side, metal, side]);
    disc.position.y = 0.06;
    disc.receiveShadow = true;
    this.table.add(disc);
    this.tableTop = 0.12;

    // Inlaid rings: a fine accent line and the LED rim at the base.
    this.ringMat = new THREE.MeshStandardMaterial({ color: '#000', emissive: ACCENT, emissiveIntensity: 2.4 });
    const inlay = new THREE.Mesh(new THREE.RingGeometry(TABLE_R - 0.32, TABLE_R - 0.27, 128), this.ringMat);
    inlay.rotation.x = -Math.PI / 2;
    inlay.position.y = this.tableTop + 0.002;
    this.table.add(inlay);
    this.rimMat = new THREE.MeshStandardMaterial({ color: '#000', emissive: COOL, emissiveIntensity: 3 });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(TABLE_R + 0.1, 0.022, 8, 160), this.rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.015;
    S.add(rim);

    // Chasing segments around the inlay: twelve dashes that light in turn.
    this.dashes = [];
    const dashGeo = new THREE.PlaneGeometry(0.42, 0.05);
    for (let i = 0; i < 24; i++) {
      const m = new THREE.MeshStandardMaterial({ color: '#000', emissive: '#ffffff', emissiveIntensity: 0 });
      const d = new THREE.Mesh(dashGeo, m);
      const a = (i / 24) * Math.PI * 2;
      d.position.set(Math.cos(a) * (TABLE_R - 0.12), this.tableTop + 0.003, Math.sin(a) * (TABLE_R - 0.12));
      d.rotation.set(-Math.PI / 2, 0, -a + Math.PI / 2);
      this.table.add(d);
      this.dashes.push(m);
    }

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: contactShadowTexture(), transparent: true, depthWrite: false, opacity: 0.9 })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = this.tableTop + 0.004;
    shadow.renderOrder = 1;
    this.table.add(shadow);
    this.contact = shadow;

    // The car sits in its own node so the scan and the swap never touch the table.
    this.carNode = new THREE.Group();
    this.carNode.position.y = this.tableTop;
    this.table.add(this.carNode);

    // Scanner: a glowing horizontal sheet with a bright edge ring.
    const scanMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uColor: { value: ACCENT.clone() }, uAlpha: { value: 0 }, uTime: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `
        uniform vec3 uColor; uniform float uAlpha; uniform float uTime; varying vec2 vUv;
        void main(){
          vec2 p = vUv - 0.5; float r = length(p) * 2.0;
          float edge = smoothstep(0.86, 0.97, r) * (1.0 - smoothstep(0.97, 1.0, r));
          vec2 g = abs(fract(vUv * 28.0 - 0.5) - 0.5);
          float grid = (1.0 - smoothstep(0.0, 0.05, min(g.x, g.y))) * 0.35;
          float fill = (1.0 - r) * 0.18;
          float a = (edge * 1.6 + (grid + fill) * (1.0 - smoothstep(0.7, 1.0, r))) * uAlpha;
          gl_FragColor = vec4(uColor * (1.4 + 0.4 * sin(uTime * 30.0)), a);
        }`,
    });
    this.scanSheet = new THREE.Mesh(new THREE.CircleGeometry(3.2, 96), scanMat);
    this.scanSheet.rotation.x = -Math.PI / 2;
    this.scanSheet.visible = false;
    this.table.add(this.scanSheet);
  }

  _buildLights() {
    const S = this.scene;
    RectAreaLightUniformsLib.init();
    S.add(new THREE.HemisphereLight('#b8c4d8', '#141210', 0.5));

    // The light box, as a real area light: soft top light and long highlights on the paint.
    const box = new THREE.RectAreaLight('#f2f5ff', 5.5, 7.2, 6);
    box.position.set(0, ROOM.h - 1.2, 0);
    box.lookAt(0, 0, 0);
    S.add(box);

    // Key light with shadows.
    const key = new THREE.SpotLight('#ffffff', 220, 30, 0.62, 0.55, 1.6);
    key.position.set(4.5, 9, -4);
    key.target.position.set(0, 0.4, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 5;
    S.add(key, key.target);

    // Coloured rims from the back corners: warm left, cool right.
    const rimL = new THREE.SpotLight(ACCENT, 60, 28, 0.32, 0.9, 1.4);
    rimL.position.set(-7, 6.5, 8);
    rimL.target.position.set(0, 1.0, 0);
    const rimR = new THREE.SpotLight(COOL, 55, 28, 0.32, 0.9, 1.4);
    rimR.position.set(7, 6.2, 7);
    rimR.target.position.set(0, 1.0, 0);
    S.add(rimL, rimL.target, rimR, rimR.target);
    this.rims = [rimL, rimR];

    // Wall washes: the workbench, the tyre rack, the lift and the sign each get a pool of light.
    const wash = (color, intensity, from, to) => {
      const l = new THREE.SpotLight(color, intensity, 16, 0.75, 1, 1.4);
      l.position.set(...from);
      l.target.position.set(...to);
      S.add(l, l.target);
    };
    wash('#ffd2a8', 70, [-ROOM.w / 2 + 4, 6.4, -5], [-ROOM.w / 2, 1.4, -5]);
    wash('#ffe2c4', 55, [-ROOM.w / 2 + 4, 6.4, 5], [-ROOM.w / 2, 1.2, 5]);
    wash('#bfe6ff', 70, [ROOM.w / 2 - 6, 6.8, -5.5], [ROOM.w / 2 - 2.6, 1.2, -5.5]);
    wash('#ffffff', 60, [0, 6.9, -7], [0, 4.5, -ROOM.d / 2]);

    // A low front fill so the grille is never a black hole.
    const fill = new THREE.PointLight('#c9d6ff', 18, 14, 1.8);
    fill.position.set(0, 1.4, -7);
    S.add(fill);
  }

  _buildProps() {
    const S = this.scene;
    const std = (c, r = 0.6, m = 0.2) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
    const add = (geo, mat, x, y, z, ry = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.castShadow = true;
      m.receiveShadow = true;
      S.add(m);
      return m;
    };

    // ---- left wall: workbench, pegboard, tool chests, tyre rack -----------
    const steel = std('#2a2d32', 0.45, 0.7);
    const red = std('#a3221b', 0.35, 0.4);
    const L = -ROOM.w / 2;
    add(new THREE.BoxGeometry(1.0, 0.9, 4.2), steel, L + 0.6, 0.45, -5);
    add(new THREE.BoxGeometry(1.1, 0.06, 4.4), std('#5a4632', 0.7, 0), L + 0.6, 0.93, -5);
    const peg = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.1), new THREE.MeshStandardMaterial({ map: pegboardTexture(), roughness: 0.8 }));
    peg.position.set(L + 0.03, 2.2, -5);
    peg.rotation.y = Math.PI / 2;
    S.add(peg);
    // Tools on the pegboard: spanners as thin bars of decreasing length.
    for (let i = 0; i < 9; i++) {
      add(new THREE.BoxGeometry(0.03, 0.28 + i * 0.04, 0.05), std('#b9bec6', 0.25, 0.9), L + 0.08, 2.5 - i * 0.02, -6.6 + i * 0.22);
    }
    for (let k = 0; k < 2; k++) {
      const z = -1.4 + k * 1.15;
      add(new THREE.BoxGeometry(0.75, 1.05, 1.05), red, L + 0.5, 0.6, z);
      for (let d = 0; d < 5; d++) add(new THREE.BoxGeometry(0.02, 0.02, 0.8), std('#d8d8d8', 0.2, 0.9), L + 0.89, 0.25 + d * 0.19, z);
      for (const dz of [-0.4, 0.4]) add(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 12), std('#111', 0.6, 0.1), L + 0.5, 0.04, z + dz);
    }
    // Tyre rack: two shelves of tyres on their tread.
    const tyre = new THREE.TorusGeometry(0.32, 0.12, 12, 28);
    const rubber = std('#141414', 0.85, 0);
    add(new THREE.BoxGeometry(0.7, 0.05, 4.4), steel, L + 0.45, 1.1, 5);
    add(new THREE.BoxGeometry(0.7, 0.05, 4.4), steel, L + 0.45, 2.2, 5);
    for (const y of [0.45, 1.56]) for (let i = 0; i < 7; i++) add(tyre, rubber, L + 0.45, y, 3.1 + i * 0.6, Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      const t = add(tyre, rubber, L + 2.2, 0.12 + i * 0.24, 9);
      t.rotation.x = Math.PI / 2;
    }

    // ---- right wall: two-post lift, cabinet, drums, cones, extinguisher -----
    const R = ROOM.w / 2;
    const yellow = std('#d6a21a', 0.45, 0.4);
    for (const z of [-7.5, -3.5]) {
      add(new THREE.BoxGeometry(0.34, 4.2, 0.34), yellow, R - 2.6, 2.1, z);
      add(new THREE.BoxGeometry(0.6, 0.1, 0.6), steel, R - 2.6, 0.05, z);
      add(new THREE.BoxGeometry(1.5, 0.07, 0.12), steel, R - 3.4, 0.55, z + (z < -5 ? 0.35 : -0.35), 0.2);
    }
    add(new THREE.BoxGeometry(0.2, 0.2, 4.4), yellow, R - 2.6, 4.25, -5.5);
    add(new THREE.BoxGeometry(0.8, 1.9, 2.4), std('#23262b', 0.4, 0.6), R - 0.45, 0.95, 1.2);
    const drum = new THREE.CylinderGeometry(0.3, 0.3, 0.9, 24);
    add(drum, std('#1f4f8a', 0.4, 0.5), R - 0.6, 0.45, 4.2);
    add(drum, std('#8a1f1f', 0.4, 0.5), R - 0.6, 0.45, 4.85);
    add(drum, std('#2b2b2b', 0.4, 0.5), R - 1.25, 0.45, 4.5);
    add(new THREE.CylinderGeometry(0.09, 0.09, 0.55, 16), std('#c41e1e', 0.3, 0.3), R - 0.2, 0.9, 6.4);
    const cone = new THREE.ConeGeometry(0.2, 0.62, 20);
    const orange = std('#ff5a14', 0.5, 0);
    for (const [x, z] of [[R - 4, 8.6], [R - 4.6, 9.1], [-6.5, 8.4]]) {
      add(cone, orange, x, 0.31, z);
      add(new THREE.BoxGeometry(0.46, 0.04, 0.46), std('#111', 0.7, 0), x, 0.02, z);
    }

    // ---- behind the camera: a second, sheeted car for scale --------------
    const sheet = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.85, 2.6, 6, 16),
      new THREE.MeshStandardMaterial({ color: '#3a3d44', roughness: 0.95 })
    );
    sheet.rotation.set(0, 0, Math.PI / 2);
    sheet.scale.set(0.62, 1, 1.1);
    sheet.rotation.y = 0.35;
    sheet.position.set(7.5, 0.55, 8.5);
    sheet.castShadow = true;
    S.add(sheet);
  }

  /** Light shafts under the box and dust that drifts through them. */
  _buildAtmosphere() {
    const S = this.scene;
    if (this.level === 'low') return;
    const beamMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uAlpha: { value: 0.025 } },
      vertexShader: 'varying float vY; void main(){ vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform float uAlpha; varying float vY; void main(){ gl_FragColor = vec4(vec3(0.85,0.9,1.0), uAlpha * smoothstep(0.0, 1.0, vY)); }',
    });
    for (const [x, z] of [[-2.2, -1.6], [2.2, -1.6], [-2.2, 1.6], [2.2, 1.6]]) {
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 2.2, ROOM.h - 1.2, 24, 1, true), beamMat);
      beam.position.set(x * 0.8, (ROOM.h - 1.2) / 2, z * 0.8);
      S.add(beam);
    }

    const n = this.level === 'high' ? 700 : 300;
    const pos = new Float32Array(n * 3);
    this._dustSeed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 16;
      pos[i * 3 + 1] = Math.random() * 6;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 14;
      this._dustSeed[i] = Math.random() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dot = canvasTexture(32, 32, (g, w, h) => {
      const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, w, h);
    });
    this.dust = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.035, map: dot, transparent: true, opacity: 0.55, depthWrite: false,
      blending: THREE.AdditiveBlending, color: '#fff3e6',
    }));
    S.add(this.dust);
  }

  /* -------------------------------------------------------------- the car -- */

  /**
   * Puts a build on the turntable. `materialise` runs the scan; otherwise the
   * swap is instant (slider drags rebuild many times a second).
   */
  showBuild(build, { materialise = true } = {}) {
    const next = buildModel(build, DETAIL.garage);
    paintModel(next, build);
    const node = this._mount(next);
    const prev = this.car;
    const prevNode = this._carGroup;
    this.car = next;
    this.carBuild = build;
    this._carGroup = node;
    this._fitContact(next.metrics);

    if (this._ghost) this._dropGhost();
    if (prev && materialise) {
      const h = Math.max(next.metrics.bodyHeight, prev.metrics.bodyHeight) + 0.15;
      const clipNew = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
      const clipOld = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      this._clip(next, [clipNew]);
      this._clip(prev, [clipOld]);
      this._ghost = { model: prev, node: prevNode };
      this._scan = { t: 0, dur: 1.15, height: h, clipNew, clipOld };
      this.scanSheet.visible = true;
    } else if (prev) {
      this.carNode.remove(prevNode);
      prev.dispose();
    } else if (materialise) {
      const clipNew = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
      this._clip(next, [clipNew]);
      this._scan = { t: 0, dur: 1.15, height: next.metrics.bodyHeight + 0.15, clipNew, clipOld: null };
      this.scanSheet.visible = true;
    }
    return next;
  }

  /** Paint, trim and finish without a rebuild. */
  repaint(build) {
    this.carBuild = build;
    if (this.car) paintModel(this.car, build);
  }

  _mount(model) {
    const g = new THREE.Group();
    g.add(model.body);
    const m = model.metrics;
    const layout = { FL: [-m.trackHalf, -m.wheelbaseHalf], FR: [m.trackHalf, -m.wheelbaseHalf], BL: [-m.trackHalf, m.wheelbaseHalf], BR: [m.trackHalf, m.wheelbaseHalf] };
    Object.keys(layout).forEach((k, i) => {
      const w = model.wheels[k];
      w.position.set(layout[k][0], m.wheelRadius + model.camber.lift, layout[k][1]);
      w.rotation.set(0, 0, model.camber.tilt[i], 'YZX');
      g.add(w);
    });
    model.body.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    for (const k in model.wheels) model.wheels[k].traverse((o) => { if (o.isMesh) o.castShadow = true; });
    model.setHeadlights(true, false);
    model.setBrake(0.15);
    this.carNode.add(g);
    // Centre the body's footprint on the table.
    g.position.z = -((m.bodyFrontZ ?? 0) + (m.bodyRearZ ?? 0)) / 2;
    return g;
  }

  _fitContact(m) {
    this.contact.scale.set(m.bodyHalfWidth * 2.9, m.bodyHalfLength * 2.5, 1);
  }

  _clip(model, planes) {
    const set = (o) => {
      if (!o.isMesh) return;
      for (const mat of [].concat(o.material)) { mat.clippingPlanes = planes; mat.clipShadows = true; mat.needsUpdate = true; }
    };
    model.body.traverse(set);
    for (const k in model.wheels) model.wheels[k].traverse(set);
  }

  _dropGhost() {
    const g = this._ghost;
    this._ghost = null;
    if (!g) return;
    this.carNode.remove(g.node);
    g.model.dispose();
  }

  _advanceScan(dt) {
    const sc = this._scan;
    if (!sc) return;
    sc.t = Math.min(1, sc.t + dt / sc.dur);
    const e = ease(sc.t);
    const y = -0.05 + e * sc.height;
    // Planes are in world space; the car node sits on the table top.
    const wy = y + this.tableTop;
    sc.clipNew.constant = wy;
    if (sc.clipOld) sc.clipOld.constant = -wy;
    this.scanSheet.position.y = this.tableTop + y;
    this.scanSheet.material.uniforms.uAlpha.value = Math.sin(sc.t * Math.PI) * 1.2 + 0.15;
    if (sc.t >= 1) {
      this._clip(this.car, null);
      this._dropGhost();
      this._scan = null;
      this.scanSheet.visible = false;
    }
  }

  /** True while a materialise is running; the UI dims Generate meanwhile. */
  get busy() {
    return !!this._scan;
  }

  /* -------------------------------------------------------------- camera -- */

  setActive(on) {
    this.active = !!on;
    this.controls.enabled = this.active;
    if (on) {
      this._userAt = -100;
      this.focus('overview', { instant: !this._shown });
      this._shown = true;
    }
  }

  /** Flies to a named shot; the turntable parks the car square to it. */
  focus(name, { instant = false } = {}) {
    const S = SHOTS[name] || SHOTS.overview;
    this.shot = name;
    this.spin = name === 'overview';
    const aim = new THREE.Vector3(...S.aim);
    const eye = new THREE.Vector3(...S.eye).sub(aim).multiplyScalar(this._fit).add(aim);
    if (instant) {
      this.camera.position.copy(eye);
      this.controls.target.copy(aim);
      this.controls.update();
      this._tween = null;
      return;
    }
    this._tween = {
      t: 0, dur: 1.1,
      fromEye: this.camera.position.clone(), fromAim: this.controls.target.clone(),
      eye, aim,
    };
  }

  /**
   * The free part of the screen, measured from the DOM: the car is centred in
   * it by shifting the projection, so panels never cover it.
   */
  setFreeRect(rect) {
    const W = window.innerWidth, H = window.innerHeight;
    if (!rect || rect.width < 40) { this._view.x = 0; this._view.y = 0; return; }
    this._view.x = -((rect.left + rect.right) / 2 - W / 2);
    this._view.y = -((rect.top + rect.bottom) / 2 - H / 2);
    // Distance at which the car's footprint fills the free rect, either way, over the shots' own distance.
    const h = Math.max(40, rect.bottom - rect.top);
    const m = this.car ? this.car.metrics : { bodyHalfLength: 2.3, bodyHalfWidth: 1 };
    const R = Math.hypot(m.bodyHalfLength, m.bodyHalfWidth) * 1.05;
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360), tanH = tanV * (W / H);
    const need = Math.max(R / (tanH * (rect.width / W)), (R * 0.55) / (tanV * (h / H)));
    const fit = Math.min(2.6, Math.max(1, need / 10.6));
    if (Math.abs(fit - this._fit) > 0.04) {
      this._fit = fit;
      this.controls.maxDistance = 15 * fit;
      if (this.active) this.focus(this.shot);
    }
  }

  /* ------------------------------------------------------------- frame -- */

  update(dt) {
    this._time += dt;
    const t = this._time;
    const W = window.innerWidth, H = window.innerHeight;

    // Projection: aspect, and the offset that centres the car in the free rect.
    const cam = this.camera;
    cam.aspect = W / H;
    this._vx = damp(this._vx || 0, this._view.x, 6, dt || 1);
    this._vy = damp(this._vy || 0, this._view.y, 6, dt || 1);
    cam.setViewOffset(W, H, this._vx, this._vy, W, H);
    cam.updateProjectionMatrix();

    // Turntable: spins in the overview; parks square for the other shots;
    // pauses while the user is dragging the view, resumes after a breath.
    const idle = t - this._userAt > 4;
    if (this.spin && idle) {
      this._tableAngle += dt * 0.22;
    } else if (!this.spin) {
      const target = Math.round(this._tableAngle / (Math.PI * 2)) * Math.PI * 2;
      this._tableAngle = damp(this._tableAngle, target, 3, dt);
    }
    this.table.rotation.y = this._tableAngle;

    if (this._tween) {
      const tw = this._tween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const e = ease(tw.t);
      cam.position.lerpVectors(tw.fromEye, tw.eye, e);
      this.controls.target.lerpVectors(tw.fromAim, tw.aim, e);
      if (tw.t >= 1) this._tween = null;
    } else if (this.shot === 'overview' && idle) {
      // A slow breath in and out, so the shot is never quite still.
      const r = cam.position.distanceTo(this.controls.target);
      const want = (10.6 + Math.sin(t * 0.21) * 0.6) * this._fit;
      cam.position.sub(this.controls.target).multiplyScalar(1 + (want - r) * 0.0015).add(this.controls.target);
    }
    this.controls.update();

    // Lights that live a little.
    const pulse = 0.5 + 0.5 * Math.sin(t * 1.6);
    this.ringMat.emissiveIntensity = 1.6 + pulse * 1.4 + (this._scan ? 3 : 0);
    this.rimMat.emissiveIntensity = 2.2 + Math.sin(t * 0.9 + 1) * 0.8;
    const lead = (t * 9) % this.dashes.length;
    for (let i = 0; i < this.dashes.length; i++) {
      const d = (lead - i + this.dashes.length) % this.dashes.length;
      this.dashes[i].emissiveIntensity = d < 5 ? (5 - d) * 0.9 : 0;
    }
    for (const s of this.strips) s.mat.emissiveIntensity = s.base * (0.8 + 0.2 * Math.sin(t * 0.7 + s.phase));
    this.rims[0].intensity = 60 + Math.sin(t * 0.5) * 12;
    this.rims[1].intensity = 55 + Math.cos(t * 0.43) * 12;

    if (this.dust) {
      const p = this.dust.geometry.attributes.position;
      const a = p.array, seeds = this._dustSeed;
      for (let i = 0; i < seeds.length; i++) {
        const k = seeds[i];
        a[i * 3] += Math.sin(t * 0.13 + k) * 0.0015;
        a[i * 3 + 1] += 0.0016 + Math.sin(t * 0.3 + k * 1.3) * 0.001;
        a[i * 3 + 2] += Math.cos(t * 0.11 + k) * 0.0015;
        if (a[i * 3 + 1] > 6) a[i * 3 + 1] = 0;
      }
      p.needsUpdate = true;
    }

    this.scanSheet.material.uniforms.uTime.value = t;
    this._advanceScan(dt);

    // Tail lamps breathe with the ring.
    if (this.car) this.car.setBrake(0.12 + pulse * 0.05);
  }

  render() {
    this.gfx.renderView(this.scene, this.camera, { bloom: 0.28, exposure: 1.0 });
  }

  /** The current car's triangle count, for the stats line. */
  get triangles() {
    return this.car ? this.car.metrics.triangles : 0;
  }
}

