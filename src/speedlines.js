/**
 * speedlines.js — faint air streaks past the camera at speed.
 *
 * A fixed pool of short line segments lives in CAMERA space, in a hollow
 * cylinder around the view axis (never across the centre, where the car is).
 * Each frame they move toward the camera by the car's speed and wrap to the
 * far end when they pass it; their length stretches with speed. Opacity is a
 * smoothstep on speed, so below ~90 km/h nothing is drawn at all.
 *
 * One draw call, additive blending, no depth write. Nothing allocates per
 * frame.
 */
import * as THREE from 'three';
import { smoothstep } from './util.js';

const COUNT = 90;
const NEAR = 2, FAR = 46;
const R_MIN = 2.4, R_MAX = 7.5;

export class SpeedLines {
  constructor(camera) {
    this.camera = camera;
    this.pos = new Float32Array(COUNT * 6);
    this.seg = [];
    for (let i = 0; i < COUNT; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = R_MIN + Math.random() * (R_MAX - R_MIN);
      this.seg.push({
        x: Math.cos(a) * r,
        y: Math.sin(a) * r * 0.62,
        z: -(NEAR + Math.random() * (FAR - NEAR)),
        k: 0.6 + Math.random() * 0.8,
      });
    }
    const geo = new THREE.BufferGeometry();
    this.attr = new THREE.BufferAttribute(this.pos, 3);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.attr);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -FAR / 2), FAR);
    this.material = new THREE.LineBasicMaterial({
      color: 0xdfe8f2,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.lines = new THREE.LineSegments(geo, this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 10;
    this.lines.visible = false;
    camera.add(this.lines);
    this.night = false;
  }

  /** @param {number} speed forward speed, m/s */
  update(dt, speed) {
    const t = smoothstep(25, 60, Math.abs(speed));
    this.material.opacity = t * (this.night ? 0.07 : 0.16);
    this.lines.visible = t > 0.001;
    if (!this.lines.visible) return;
    const v = Math.abs(speed);
    const len = 0.6 + v * 0.045;
    const p = this.pos;
    for (let i = 0; i < COUNT; i++) {
      const s = this.seg[i];
      s.z += v * s.k * dt;
      if (s.z > -NEAR) s.z -= FAR - NEAR;
      const o = i * 6;
      p[o] = s.x; p[o + 1] = s.y; p[o + 2] = s.z;
      p[o + 3] = s.x; p[o + 4] = s.y; p[o + 5] = s.z - len * s.k;
    }
    this.attr.needsUpdate = true;
  }

  dispose() {
    this.camera.remove(this.lines);
    this.lines.geometry.dispose();
    this.material.dispose();
  }
}
