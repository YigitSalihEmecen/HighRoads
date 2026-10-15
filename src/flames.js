/**
 * flames.js — exhaust flames, one burst per pop the engine simulator makes.
 *
 * engine_sim's `takePops()` hands over every bang and crackle it schedules,
 * stamped on the audio clock. Each is held until the listener hears it, then
 * fires out of every exhaust mouth car_gen reports (`metrics.exhaustTips`).
 *
 * A flame is a short chain of camera-facing fireballs along the pipe's axis:
 * from the side it reads as a jet, from the chase camera, which looks straight
 * down the pipe, as a ball. Additive and brighter than white, so bloom glows it.
 */

import * as THREE from 'three';

const FLAMES = 64;
const BALLS = 6;
/** Reports older than this when they surface are dropped, s. */
const STALE = 0.3;

const material = () => new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 } },
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    uniform float uTime;
    attribute vec3 aTip;
    attribute vec3 aDir;       // the flame's full reach, car frame
    attribute vec4 aBirth;     // x = birth, y = amp 0..1, z = seed 0..1, w = place along the flame 0..1
    varying vec2 vUv;
    varying float vHeat;
    varying float vAlpha;
    varying float vSeed;

    void main() {
      float amp = aBirth.y, f = aBirth.w;
      float life = 0.05 + 0.13 * amp + 0.03 * aBirth.z;
      float age = ( uTime - aBirth.x ) / life;
      vUv = uv;
      vSeed = aBirth.z + f;
      if ( age < 0.0 || age > 1.0 ) {
        vAlpha = 0.0;
        gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
        return;
      }
      // Shoots out in the first quarter of its life, then hangs and dies.
      float reach = smoothstep( 0.0, 0.25, age ) * ( 0.85 + 0.3 * aBirth.z );
      vec4 mv = modelViewMatrix * vec4( aTip + aDir * f * reach, 1.0 );
      float size = ( 0.14 + 0.28 * amp ) * ( 1.0 - 0.5 * f ) * ( 0.75 + 0.6 * age );
      mv.xy += ( uv - 0.5 ) * size;
      vHeat = ( 1.0 - f ) * ( 1.0 - age );
      vAlpha = pow( 1.0 - age, 1.5 ) * ( 1.0 - 0.35 * f ) * ( 0.5 + 0.5 * amp );
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */`
    uniform float uTime;
    varying vec2 vUv;
    varying float vHeat;
    varying float vAlpha;
    varying float vSeed;

    void main() {
      vec2 p = vUv - 0.5;
      float a = atan( p.y, p.x );
      // A soft ball whose edge licks about irregularly.
      float r = length( p ) * 2.0;
      r *= 1.0 + 0.1 * sin( a * 3.0 + vSeed * 31.0 + uTime * 47.0 ) + 0.06 * sin( a * 7.0 - uTime * 61.0 + vSeed * 17.0 );
      float body = exp( -3.0 * r * r ) * ( 1.0 - smoothstep( 0.75, 1.0, r ) );
      if ( body * vAlpha < 0.003 ) discard;
      // White-yellow at the core and the pipe, orange to red out and over time.
      vec3 col = mix( vec3( 1.0, 0.16, 0.01 ), vec3( 1.0, 0.5, 0.08 ), vHeat );
      col = mix( col, vec3( 1.0, 0.92, 0.7 ), smoothstep( 0.55, 0.0, r ) * vHeat );
      gl_FragColor = vec4( col * body * vAlpha * 5.0, 1.0 );
    }
  `,
});

export class ExhaustFlames {
  constructor() {
    const n = FLAMES * BALLS;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this._tip = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this._dir = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this._birth = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    for (let i = 0; i < n; i++) this._birth.array[i * 4] = -1e6;
    geo.setAttribute('aTip', this._tip);
    geo.setAttribute('aDir', this._dir);
    geo.setAttribute('aBirth', this._birth);
    geo.instanceCount = n;

    this.mesh = new THREE.Mesh(geo, material());
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.time = 0;
    this._cursor = 0;
    this._pending = [];
  }

  /**
   * @param {number} dt
   * @param {RaycastVehicle} vehicle  flames ride in its group, at its model's tips
   * @param {EngineSim|null} sim
   */
  update(dt, vehicle, sim) {
    this.time += dt;
    this.mesh.material.uniforms.uTime.value = this.time;
    if (!vehicle) return;
    if (this.mesh.parent !== vehicle.group) {
      vehicle.group.add(this.mesh);
      this.reset();
    }
    const ctx = sim && sim.ctx;
    if (!ctx || !sim.takePops) return;
    for (const p of sim.takePops()) if (this._pending.length < 128) this._pending.push(p);

    // What the listener hears now: the audio clock less the output latency.
    const heard = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
    let keep = 0;
    for (const p of this._pending) {
      if (p.time > heard) this._pending[keep++] = p;
      else if (heard - p.time < STALE && p.amp > 0.03) this._fire(vehicle, p.amp);
    }
    this._pending.length = keep;
  }

  _fire(vehicle, amp) {
    const m = vehicle.model && vehicle.model.metrics;
    if (!m) return;
    // No pipe fitted: the flame comes from under the middle of the tail.
    const tips = m.exhaustTips && m.exhaustTips.length ? m.exhaustTips : [[0, 0.3, m.bodyRearZ - 0.1]];
    for (const [x, y, z] of tips) {
      const seed = Math.random();
      const len = 0.25 + 0.75 * amp * (0.7 + 0.6 * seed);
      const slot = this._cursor;
      this._cursor = (this._cursor + 1) % FLAMES;
      for (let k = 0; k < BALLS; k++) {
        const i = slot * BALLS + k;
        this._tip.array.set([x, y, z], i * 3);
        this._dir.array.set([(seed - 0.5) * 0.12 * len, -0.06 * len, len], i * 3);
        this._birth.array.set([this.time, amp, seed, k / (BALLS - 1)], i * 4);
      }
    }
    this._tip.needsUpdate = this._dir.needsUpdate = this._birth.needsUpdate = true;
  }

  reset() {
    this._pending.length = 0;
    for (let i = 0; i < FLAMES * BALLS; i++) this._birth.array[i * 4] = -1e6;
    this._birth.needsUpdate = true;
  }
}
