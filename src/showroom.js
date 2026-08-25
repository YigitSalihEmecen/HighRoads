/**
 * showroom.js — the title screen, as a place of its own.
 *
 * The garage used to be the road: the title screen left the middle of the
 * screen transparent and orbited the REAL vehicle, sitting on the real
 * carriageway, in the real weather. That was a nice trick and it had a real
 * argument behind it — what you are choosing is exactly what you will drive,
 * and paint is a live material property rather than a preview of one.
 *
 * It also meant the menu inherited every property of the world behind it.
 * Rendered, the same seed that looks bright and pleasant from the chase camera
 * gives a title screen in near-darkness, because the orbit happens to face the
 * anti-sun side of the sky dome. The car competed with lane markings, verge
 * grass and whatever the terrain was doing that kilometre. None of that is a
 * bug to fix; it is what a road looks like, and a road is the wrong backdrop
 * for a product shot.
 *
 * So this is a studio: a seamless cyclorama, a turntable, and three lights that
 * do not move. Nothing here is procedural and nothing depends on the seed. The
 * car is the same model with the same materials — so paint, trim and the engine
 * bay are all still live — it is simply somewhere the lighting was chosen.
 *
 * The framing is the other half. See `frame()`: the camera fits the car into
 * the part of the screen the interface is not using, measured from the DOM, so
 * a phone in portrait with a tall panel and a desktop with a wide one both put
 * the car where you can see it.
 */

import * as THREE from 'three';
import { SHOWROOM } from './config.js';

/**
 * The cyclorama.
 *
 * A studio backdrop is a wall that curves into the floor with no seam, so there
 * is no edge to read as a corner and the eye takes it for infinite space. The
 * sphere is drawn from the inside with a vertical gradient plus a soft pool of
 * light behind the car, which is the same thing a photographer gets from a
 * light aimed at the wall.
 */
function cyclorama() {
  const geo = new THREE.SphereGeometry(SHOWROOM.radius, 48, 32);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uFloor: { value: new THREE.Color(SHOWROOM.floorColor) },
      uWall: { value: new THREE.Color(SHOWROOM.wallColor) },
      uTop: { value: new THREE.Color(SHOWROOM.topColor) },
      uGlow: { value: new THREE.Color(SHOWROOM.glowColor) },
    },
    vertexShader: /* glsl */`
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uFloor, uWall, uTop, uGlow;
      varying vec3 vPos;
      void main() {
        vec3 n = normalize(vPos);
        // Floor to wall to ceiling, with the transition low and soft so the
        // seam a real cyclorama hides is hidden here too.
        float h = n.y;
        vec3 c = mix(uFloor, uWall, smoothstep(-0.55, 0.05, h));
        c = mix(c, uTop, smoothstep(0.1, 0.85, h));
        // A pool of light on the back wall, behind and above where the car
        // stands. This is what separates a dark car from a dark backdrop.
        float glow = smoothstep(0.75, 0.0, distance(n, normalize(vec3(0.0, 0.35, -1.0))));
        c += uGlow * glow * glow;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

/** The turntable the car stands on. */
function turntable() {
  const group = new THREE.Group();

  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(SHOWROOM.plateRadius, SHOWROOM.plateRadius * 1.02, 0.22, 64),
    new THREE.MeshStandardMaterial({
      color: SHOWROOM.plateColor, roughness: 0.42, metalness: 0.15,
    })
  );
  disc.position.y = -0.11;
  disc.receiveShadow = true;
  group.add(disc);

  // A brighter ring around the rim, which is what stops the plate reading as a
  // dark hole in a dark floor from a low camera.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(SHOWROOM.plateRadius * 0.985, SHOWROOM.plateRadius * 1.03, 96),
    new THREE.MeshBasicMaterial({
      color: SHOWROOM.ringColor, side: THREE.DoubleSide, transparent: true, opacity: 0.55,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.005;
  group.add(ring);

  return group;
}

export function createShowroom() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(SHOWROOM.fov, 1, 0.1, SHOWROOM.radius * 3);

  scene.add(cyclorama());
  scene.add(turntable());

  /**
   * Three-point lighting, fixed.
   *
   * Not the world's sun, and that is the entire point of this module: the key
   * is where a photographer would put it rather than wherever the seed's
   * `sunDir` happens to be, so every car is lit the same way and none of them
   * is ever in silhouette.
   */
  const key = new THREE.DirectionalLight(SHOWROOM.keyColor, SHOWROOM.keyIntensity);
  key.position.set(-6, 8, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 40;
  const sc = 7;
  key.shadow.camera.left = -sc;
  key.shadow.camera.right = sc;
  key.shadow.camera.top = sc;
  key.shadow.camera.bottom = -sc;
  key.shadow.bias = -0.0008;
  scene.add(key, key.target);

  const fill = new THREE.DirectionalLight(SHOWROOM.fillColor, SHOWROOM.fillIntensity);
  fill.position.set(9, 4, 4);
  scene.add(fill, fill.target);

  // Rim from behind, which is what puts an edge on the roof and separates the
  // car from the backdrop. Without it a dark paint reads as a hole.
  const rim = new THREE.DirectionalLight(SHOWROOM.rimColor, SHOWROOM.rimIntensity);
  rim.position.set(2, 5, -10);
  scene.add(rim, rim.target);

  scene.add(new THREE.HemisphereLight(
    SHOWROOM.hemiSky, SHOWROOM.hemiGround, SHOWROOM.hemiIntensity));

  /** The car currently on the plate, and the group that spins it. */
  const plate = new THREE.Group();
  scene.add(plate);
  let current = null;
  let orbit = SHOWROOM.startAngle;
  let radius = 2.5;
  let height = 1.4;

  /** Where the camera is aiming, in world units above the plate. */
  const aim = new THREE.Vector3();
  const eye = new THREE.Vector3();

  return {
    scene,
    camera,

    /**
     * Puts a car on the turntable.
     *
     * Takes the model's `body` and `wheels` groups directly — the same objects
     * the driving vehicle uses, so materials are shared and a paint click is
     * still one property write. They are re-parented here and handed back when
     * the run starts; nothing is cloned, because two copies of a car are two
     * things that can disagree.
     */
    setCar(model, metrics) {
      plate.clear();
      if (!model) { current = null; return; }
      plate.add(model.body);
      for (const k of ['FL', 'FR', 'BL', 'BR']) {
        const w = model.wheels[k];
        // The vehicle parks its wheels by suspension travel; on the plate they
        // sit at their own rolling radius, which is where the FBX author drew
        // them.
        w.position.set(0, 0, 0);
        w.quaternion.identity();
        plate.add(w);
      }
      plate.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      current = { model, metrics };

      // Frame from the car's real measurements, so a monster truck and a
      // hatchback are both filled to the same fraction of the screen.
      const m = metrics || {};
      const len = (m.bodyHalfLength || 2.2) * 2;
      const wid = (m.bodyHalfWidth || 1.0) * 2;
      const hgt = m.bodyHeight || 1.5;
      // The DIAGONAL, not the longer side: the turntable shows the car at every
      // angle, and three-quarter on is where its silhouette is widest. Framing
      // to the length alone fits it beautifully side-on and runs it off both
      // edges of the screen a second and a half later.
      radius = Math.hypot(len, wid) * 0.5;
      height = hgt;
    },

    /** Releases the car back to the caller — the run is about to start. */
    releaseCar() {
      plate.clear();
      current = null;
    },

    /**
     * Fits the car into the part of the screen the interface is NOT using.
     *
     * This is the whole answer to "make sure the car is visible on a phone and
     * on a desktop". A fixed camera distance cannot be: the dock is a panel
     * whose height depends on the viewport, the safe area and how many rows the
     * garage has, and the old rig was tuned by hand against one of those and
     * put the car behind the panel the moment a row was added.
     *
     * So the free band is MEASURED — from the bottom of the wordmark to the top
     * of the dock — and the camera solves for the distance that fits the car
     * into it and the aim that centres it there. Add a row, rotate the phone,
     * open on a tablet: the framing follows, because it is derived from the
     * thing that actually changed.
     *
     * @param {number} vw,vh   viewport, CSS pixels
     * @param {number} topPx   bottom of the brand block, CSS pixels from the top
     * @param {number} botPx   top of the dock, CSS pixels from the top
     */
    frame(vw, vh, topPx, botPx) {
      camera.aspect = vw / Math.max(1, vh);
      camera.updateProjectionMatrix();

      // Fall back to the middle half of the screen if the panels have not been
      // laid out yet — on the very first frame they have zero height.
      let top = topPx;
      let bottom = botPx;
      if (!(bottom - top > vh * 0.12)) {
        top = vh * 0.18;
        bottom = vh * 0.72;
      }
      const bandH = bottom - top;
      const centre = (top + bottom) * 0.5;

      const vFov = (camera.fov * Math.PI) / 180;
      const tanV = Math.tan(vFov * 0.5);
      const tanH = tanV * camera.aspect;

      // Distance so the car fits the band vertically AND the viewport
      // horizontally, whichever is the binding constraint.
      const fill = SHOWROOM.fill;
      const needV = (height * 1.25) / (2 * tanV * (bandH / vh) * fill);
      const needH = (radius * 2) / (2 * tanH * fill);
      const dist = Math.max(needV, needH, SHOWROOM.minDistance);

      // Aim so the car's centre lands at `centre` rather than at the middle of
      // the screen. A point offset by `o` world units vertically projects
      // (o / (dist * tanV)) of a half-screen away from centre.
      const offset = ((centre - vh * 0.5) / (vh * 0.5)) * tanV * dist;

      const cy = height * 0.45;
      aim.set(0, cy + offset, 0);
      eye.set(
        Math.sin(orbit) * dist * SHOWROOM.orbitRadius,
        cy + dist * SHOWROOM.eyeLift,
        Math.cos(orbit) * dist * SHOWROOM.orbitRadius
      );
      camera.position.copy(eye);
      camera.up.set(0, 1, 0);
      camera.lookAt(aim);
    },

    /** Spins the turntable. */
    update(dt) {
      orbit += SHOWROOM.spin * dt;
      plate.rotation.y = -orbit;
    },

    dispose() {
      plate.clear();
      scene.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose();
          if (o.material.dispose) o.material.dispose();
        }
      });
    },
  };
}
