/**
 * fx.js — what the tyres leave behind: smoke in the air, rubber on the road.
 *
 * Both are driven by ONE quantity, `wheel.slipAmount`, which `vehicle.js`
 * already computes as how far past its peak a tyre is — the same number the
 * skid audio uses. There is deliberately no second opinion here about whether a
 * tyre is sliding; a visual effect that disagrees with the sound is worse than
 * no visual effect at all.
 *
 * ── smoke: a pool, not a spawner ────────────────────────────────────────────
 *
 * `FX.smoke.max` particles are allocated once and recycled oldest-first. A
 * thirty-second burnout therefore costs exactly what a one-second one does,
 * there is no allocation anywhere in the frame loop, and the draw is a single
 * instanced call whatever is happening.
 *
 * The particles are integrated ON THE GPU. Each instance carries an origin, a
 * velocity and a birth time; the vertex shader works out where it is from
 * `uTime - birth` in closed form, including the drag term, so the CPU writes to
 * a particle exactly once — when it is born. Updating 260 matrices a frame
 * would not be expensive, but it would be 260 matrices a frame forever, and
 * this is free.
 *
 * They are BILLBOARDS built in view space: the quad's local x and y are added
 * after the origin has been transformed, so the card always faces the camera
 * without anything on the CPU knowing where the camera is. Smoke has no
 * orientation of its own, so anything else is wrong.
 *
 * ── marks: a ring buffer of quads ───────────────────────────────────────────
 *
 * A trail that grows is a trail that grows forever, and this road does not end.
 * `FX.marks.maxQuads` quads are allocated once and written round; the oldest is
 * a couple of hundred metres behind the car by the time it is overwritten, so
 * the recycling is never seen. Each quad bridges the gap between where a wheel
 * was and where it is, at the tyre's own width, lifted just clear of the
 * terrain.
 *
 * Age is a vertex attribute and the fade is in the shader, so a mark laid
 * sixteen seconds ago is gone without anything having to walk the buffer
 * looking for it.
 *
 * ── why marks do not use the depth buffer normally ──────────────────────────
 *
 * They are coplanar with the ground by construction, which is the one thing a
 * depth buffer cannot resolve. `polygonOffset` biases them toward the camera
 * and `depthWrite` is off so overlapping segments of one long drift do not
 * carve holes in each other's alpha.
 */

import * as THREE from 'three';
import { FX } from './config.js';
import { clamp, smoothstep } from './util.js';
import { makeCanvas, paint, tileFbm } from './env/textures.js';

/* ------------------------------------------------------------------ smoke -- */

/**
 * A soft round puff: radial falloff with noise eaten out of the edge.
 *
 * A clean gaussian disc reads as a ball of cotton wool — every particle the
 * same shape, and where two overlap the join is a lens. Breaking the edge with
 * fBm and rotating each instance means a cloud is made of pieces rather than of
 * copies.
 */
function puffTexture(size) {
  const target = makeCanvas(size);
  if (!target) return null;
  paint(target, (u, v, out) => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const r = Math.hypot(dx, dy) * 2;               // 0 at centre, 1 at the edge
    // Billowing edge. The noise is subtracted from the radius rather than
    // multiplied into the alpha, so it eats into the shape instead of making
    // the whole puff patchy.
    const n = tileFbm(u, v, 4, 4, 0.55, 7);
    const rr = r + (n - 0.5) * 0.42;
    const a = Math.max(0, 1 - rr);
    out[0] = 1; out[1] = 1; out[2] = 1;
    // Squared falloff: a puff should be soft everywhere and solid nowhere.
    out[3] = a * a;
    return out;
  });
  const tex = new THREE.CanvasTexture(target.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

function smokeMaterial(map) {
  const uniforms = {
    uTime: { value: 0 },
    uMap: { value: map },
    uLife: { value: FX.smoke.life },
    uSize: { value: new THREE.Vector2(FX.smoke.size[0], FX.smoke.size[1]) },
    uRise: { value: FX.smoke.rise },
    uDrag: { value: FX.smoke.drag },
    uOpacity: { value: FX.smoke.opacity },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      uniform float uTime, uLife, uRise, uDrag, uOpacity;
      uniform vec2 uSize;
      attribute vec3 aOrigin;
      attribute vec3 aVel;
      attribute vec2 aBirth;     // x = birth time, y = random seed 0..1
      varying vec2 vUv;
      varying float vAlpha;

      void main() {
        float age = ( uTime - aBirth.x ) / uLife;
        vUv = uv;

        if ( age < 0.0 || age > 1.0 ) {
          // Dead. Collapse to a degenerate point behind the camera rather than
          // branching in the fragment shader — a discarded fragment still costs
          // a rasterised one, and a zero-area triangle costs nothing.
          vAlpha = 0.0;
          gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
          return;
        }

        float t = age * uLife;
        // Closed-form position under linear drag plus a constant rise:
        //   x(t) = x0 + v0 * (1 - e^(-k t)) / k  +  rise * t
        // which is the exact integral of the model, so the CPU never touches a
        // particle after birth.
        float decay = ( 1.0 - exp( -uDrag * t ) ) / uDrag;
        vec3 pos = aOrigin + aVel * decay;
        pos.y += uRise * t * ( 0.6 + aBirth.y * 0.8 );

        // Billboard: offset in VIEW space, after the origin has been
        // transformed, so the card faces the camera with nothing on the CPU
        // needing to know where the camera is.
        vec4 mv = modelViewMatrix * vec4( pos, 1.0 );
        float size = mix( uSize.x, uSize.y, sqrt( age ) );
        float rot = aBirth.y * 6.2831853 + age * ( aBirth.y - 0.5 ) * 2.0;
        float c = cos( rot ), s = sin( rot );
        vec2 q = ( uv - 0.5 ) * size;
        mv.xy += vec2( q.x * c - q.y * s, q.x * s + q.y * c );

        // Fade in fast, out slowly. Smoke appears as soon as the rubber lets go
        // and then hangs; the reverse reads as a puff of steam.
        vAlpha = uOpacity * smoothstep( 0.0, 0.10, age ) * ( 1.0 - age ) * ( 1.0 - age );
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vec4 tex = texture2D( uMap, vUv );
        float a = tex.a * vAlpha;
        if ( a < 0.004 ) discard;
        // Warm grey, and lighter than the road. Tyre smoke is mostly vaporised
        // oil and water, not soot; painting it dark makes it read as a fire.
        gl_FragColor = vec4( vec3( 0.82, 0.80, 0.78 ), a );
      }
    `,
  });
  return { material, uniforms };
}

/* ------------------------------------------------------------------ marks -- */

function markMaterial() {
  const uniforms = {
    uTime: { value: 0 },
    uLife: { value: FX.marks.life },
    uOpacity: { value: FX.marks.opacity },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    // Coplanar with the ground by construction, which is the one thing a depth
    // buffer cannot resolve. Bias toward the camera, and do not write depth so
    // overlapping passes of one long drift do not cut holes in each other.
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      uniform float uTime, uLife, uOpacity;
      attribute vec2 aMark;      // x = birth time, y = strength 0..1
      varying float vAlpha;
      void main() {
        float age = ( uTime - aMark.x ) / uLife;
        vAlpha = ( age < 0.0 || age > 1.0 ) ? 0.0
               : uOpacity * aMark.y * ( 1.0 - age ) * ( 1.0 - age );
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: /* glsl */`
      varying float vAlpha;
      void main() {
        if ( vAlpha < 0.004 ) discard;
        gl_FragColor = vec4( vec3( 0.055, 0.05, 0.05 ), vAlpha );
      }
    `,
  });
  return { material, uniforms };
}

/* ------------------------------------------------------------------------- */

export class TyreFX {
  /**
   * @param {THREE.Scene} scene
   * @param {number} anisotropy  from the renderer, for the puff texture
   */
  constructor(scene, { anisotropy = 1 } = {}) {
    this.scene = scene;
    this.time = 0;
    this._v = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();

    this._initSmoke(anisotropy);
    this._initMarks();
  }

  // ------------------------------------------------------------- smoke ----

  _initSmoke(anisotropy) {
    if (!FX.smoke.enabled) { this.smoke = null; return; }
    const map = puffTexture(128);
    if (map) map.anisotropy = anisotropy;
    const { material, uniforms } = smokeMaterial(map);

    const n = FX.smoke.max;
    const geo = new THREE.InstancedBufferGeometry();
    // A unit quad. `uv` doubles as the corner offset in the vertex shader, so
    // there is no separate position attribute to keep in step with it.
    geo.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(
      [0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    this._sOrigin = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this._sVel = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this._sBirth = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
    // Everything starts long dead, so nothing is drawn before the first skid.
    for (let i = 0; i < n; i++) this._sBirth.array[i * 2] = -1e6;
    geo.setAttribute('aOrigin', this._sOrigin);
    geo.setAttribute('aVel', this._sVel);
    geo.setAttribute('aBirth', this._sBirth);
    geo.instanceCount = n;

    const mesh = new THREE.Mesh(geo, material);
    // The particles move in the shader, so three cannot know where they are.
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    this.scene.add(mesh);

    this.smoke = {
      mesh, geo, material, uniforms, map,
      /** Next slot to overwrite. Oldest-first by construction. */
      cursor: 0,
      /** Fractional particle budget carried between frames, per wheel. */
      debt: [0, 0, 0, 0],
    };
  }

  /** Births one puff at `pos` with `vel`. */
  _emit(pos, vel) {
    const s = this.smoke;
    const i = s.cursor;
    s.cursor = (s.cursor + 1) % FX.smoke.max;

    const o = this._sOrigin.array;
    const v = this._sVel.array;
    const b = this._sBirth.array;
    o[i * 3] = pos.x; o[i * 3 + 1] = pos.y; o[i * 3 + 2] = pos.z;
    v[i * 3] = vel.x; v[i * 3 + 1] = vel.y; v[i * 3 + 2] = vel.z;
    b[i * 2] = this.time;
    b[i * 2 + 1] = Math.random();
    this._sOrigin.needsUpdate = true;
    this._sVel.needsUpdate = true;
    this._sBirth.needsUpdate = true;
  }

  // ------------------------------------------------------------- marks ----

  _initMarks() {
    if (!FX.marks.enabled) { this.marks = null; return; }
    const { material, uniforms } = markMaterial();
    const n = FX.marks.maxQuads;

    const geo = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3);
    const mark = new THREE.BufferAttribute(new Float32Array(n * 4 * 2), 2);
    pos.setUsage(THREE.DynamicDrawUsage);
    mark.setUsage(THREE.DynamicDrawUsage);
    // Long dead until written.
    for (let i = 0; i < n * 4; i++) mark.array[i * 2] = -1e6;

    const idx = new Uint32Array(n * 6);
    for (let q = 0; q < n; q++) {
      const a = q * 4;
      idx[q * 6] = a; idx[q * 6 + 1] = a + 1; idx[q * 6 + 2] = a + 2;
      idx[q * 6 + 3] = a; idx[q * 6 + 4] = a + 2; idx[q * 6 + 5] = a + 3;
    }
    geo.setAttribute('position', pos);
    geo.setAttribute('aMark', mark);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));

    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    this.scene.add(mesh);

    this.marks = {
      mesh, geo, material, uniforms, pos, mark,
      cursor: 0,
      /** Where each wheel last laid rubber, and whether it was laying any. */
      last: [null, null, null, null],
    };
  }

  /**
   * Bridges the gap between a wheel's previous mark and this one.
   *
   * The quad is built from the two contact points and the direction between
   * them, not from the wheel's heading: a sliding tyre is not pointing where it
   * is going, and a mark drawn across its own path is the giveaway.
   */
  _layMark(i, contact, normal, halfWidth, strength) {
    const m = this.marks;
    const prev = m.last[i];
    if (!prev) return;

    // Along the mark, then across it, kept in the contact plane.
    const along = this._a.subVectors(contact, prev.pos);
    if (along.lengthSq() < 1e-8) return;
    along.normalize();
    const across = this._b.crossVectors(normal, along);
    if (across.lengthSq() < 1e-8) return;
    across.normalize().multiplyScalar(halfWidth);

    const q = m.cursor;
    m.cursor = (m.cursor + 1) % FX.marks.maxQuads;
    const p = m.pos.array;
    const k = m.mark.array;
    const base = q * 4;

    const lift = this._v.copy(normal).multiplyScalar(FX.marks.lift);
    const write = (n, x, y, z, s) => {
      p[(base + n) * 3] = x + lift.x;
      p[(base + n) * 3 + 1] = y + lift.y;
      p[(base + n) * 3 + 2] = z + lift.z;
      k[(base + n) * 2] = this.time;
      k[(base + n) * 2 + 1] = s;
    };
    write(0, prev.pos.x - across.x, prev.pos.y - across.y, prev.pos.z - across.z, prev.strength);
    write(1, prev.pos.x + across.x, prev.pos.y + across.y, prev.pos.z + across.z, prev.strength);
    write(2, contact.x + across.x, contact.y + across.y, contact.z + across.z, strength);
    write(3, contact.x - across.x, contact.y - across.y, contact.z - across.z, strength);

    m.pos.needsUpdate = true;
    m.mark.needsUpdate = true;
  }

  // ------------------------------------------------------------ update ----

  /**
   * @param {number} dt
   * @param {RaycastVehicle} vehicle
   */
  update(dt, vehicle) {
    this.time += dt;
    if (this.smoke) this.smoke.uniforms.uTime.value = this.time;
    if (this.marks) this.marks.uniforms.uTime.value = this.time;
    if (!vehicle) return;

    const speed = Math.abs(vehicle.forwardSpeed);
    // Smoke needs the contact patch to be moving relative to the ROAD, not the
    // car to be moving relative to the world — see FX.smoke.speedFade.
    const speedGate = 1 - smoothstep(FX.smoke.speedFade[0], FX.smoke.speedFade[1], speed);

    for (let i = 0; i < vehicle.wheels.length; i++) {
      const w = vehicle.wheels[i];

      if (!w.grounded || w.slipAmount < FX.marks.minSlip) {
        if (this.marks) this.marks.last[i] = null;
        if (this.smoke) this.smoke.debt[i] = 0;
        continue;
      }

      // ---- marks -------------------------------------------------------
      if (this.marks) {
        const strength = clamp(
          (w.slipAmount - FX.marks.minSlip) / (1 - FX.marks.minSlip), 0, 1);
        const prev = this.marks.last[i];
        if (!prev) {
          this.marks.last[i] = { pos: w.contact.clone(), strength };
        } else if (prev.pos.distanceToSquared(w.contact) >= FX.marks.step * FX.marks.step) {
          this._layMark(i, w.contact, w.normal,
            vehicle.V.wheelWidth * 0.5 * FX.marks.widthScale, strength);
          prev.pos.copy(w.contact);
          prev.strength = strength;
        }
      }

      // ---- smoke -------------------------------------------------------
      if (this.smoke && w.slipAmount >= FX.smoke.minSlip && speedGate > 0.01) {
        const drive = clamp(
          (w.slipAmount - FX.smoke.minSlip) / (1 - FX.smoke.minSlip), 0, 1);
        this.smoke.debt[i] += FX.smoke.rate * drive * speedGate * dt;
        while (this.smoke.debt[i] >= 1) {
          this.smoke.debt[i] -= 1;
          // Born just behind and above the patch, carrying a share of the
          // wheel's own slip velocity plus a little scatter.
          const p = this._a.copy(w.contact)
            .addScaledVector(vehicle.fwd, -FX.smoke.offset[0])
            .addScaledVector(w.normal, FX.smoke.offset[1]);
          const vel = this._b.copy(w.pointVel).multiplyScalar(-0.28);
          vel.x += (Math.random() - 0.5) * 1.4;
          vel.y += Math.random() * 0.7;
          vel.z += (Math.random() - 0.5) * 1.4;
          this._emit(p, vel);
        }
      } else if (this.smoke) {
        this.smoke.debt[i] = 0;
      }
    }
  }

  /** Wipes every mark and every puff. Used when a run restarts. */
  reset() {
    if (this.smoke) {
      const b = this._sBirth.array;
      for (let i = 0; i < FX.smoke.max; i++) b[i * 2] = -1e6;
      this._sBirth.needsUpdate = true;
      this.smoke.debt.fill(0);
    }
    if (this.marks) {
      const k = this.marks.mark.array;
      for (let i = 0; i < k.length; i += 2) k[i] = -1e6;
      this.marks.mark.needsUpdate = true;
      this.marks.last.fill(null);
    }
  }

  dispose() {
    for (const part of [this.smoke, this.marks]) {
      if (!part) continue;
      this.scene.remove(part.mesh);
      part.geo.dispose();
      part.material.dispose();
      if (part.map) part.map.dispose();
    }
  }
}
