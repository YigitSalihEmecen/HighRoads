/**
 * forest.js — draws the TreeGen canopy: one level of detail per tree, chosen
 * per frame.
 *
 * Chunks hand over their placed trees (`addChunk`) and take them back when
 * they stream out (`removeChunk`). Each frame every tree is measured against
 * the camera once: culled against the frustum (grown by `margin`, so a tree
 * just outside the view still casts its shadow into it), given the last level
 * whose `from` distance (metres, `TREES.treegen.lods`) it is past, and packed
 * into that level's instance buffers. One InstancedMesh per
 * variant × level × part for the whole world, so the draw count follows the
 * species in view, not the chunks loaded.
 *
 * Two fades shrink a tree about its base instead of popping it, as the legacy
 * shader did: `TREES.farFade` at the end of the draw distance (a variant's own
 * `fade` instead where it has one: the shrubs), and
 * `TREES.loneFadeIn` for trees placed with no near mesh (the dense far
 * stands), which only exist beyond it.
 *
 * Instance positions are kept in float64 and written relative to an anchor
 * that follows the camera, so precision does not degrade with distance
 * driven.
 */
import * as THREE from 'three';
import { ATMOSPHERE, TREES, WORLD_BIOME } from './config.js';

/**
 * The CANOPY SHADOW MAP: past the sun's 78 m shadow box no tree cast a shadow,
 * and a far wood stood on the hills like cut-outs. Every tree is splatted as
 * a soft ellipse — its crown projected along the sun — into a small top-down
 * map around the camera, re-rendered only when the camera moves `snap`
 * metres, the trees change, or the sun moves. The terrain and the grass
 * darken their direct light by it (`CANOPY_GLSL`), one fetch a pixel, taking
 * over from the real shadow map at `fade`.
 */
export const canopyShadow = {
  uCanopy: { value: null },
  /** x0, z0 of the map, 1 / its size, strength (0 until the first render). */
  uCanopyRect: { value: new THREE.Vector4(0, 0, 0, 0) },
  /** Camera distance over which it takes over from the real shadow map. */
  uCanopyFade: { value: new THREE.Vector2(0, 1) },
};

/**
 * The LITTER MAP (fall worlds): the same splat, straight down and wider than
 * the crown — where the leaves of every tree and shrub have fallen. The
 * ground and the road read it (`LITTER_GLSL`) to lay leaves round the woods
 * and none on open land. Rendered with the canopy map, so it follows the
 * camera and the trees exactly as that does.
 */
export const litterMap = {
  uLitter: { value: null },
  /** x0, z0 of the map, 1 / its size, on (0 until the first render). */
  uLitterRect: { value: new THREE.Vector4(0, 0, 0, 0) },
};

export const LITTER_GLSL = /* glsl */`
  uniform sampler2D uLitter;
  uniform vec4 uLitterRect;
  float fr_litterAt( vec3 p ) {
    vec2 u = ( p.xz - uLitterRect.xy ) * uLitterRect.z;
    if ( uLitterRect.w <= 0.0 || any( lessThan( u, vec2( 0.0 ) ) ) || any( greaterThan( u, vec2( 1.0 ) ) ) ) return 0.0;
    return texture2D( uLitter, u ).r * 0.9;
  }
`;

export const CANOPY_GLSL = {
  pars: /* glsl */`
    uniform sampler2D uCanopy;
    uniform vec4 uCanopyRect;
    uniform vec2 uCanopyFade;
    float fr_canopyAt( vec3 p ) {
      vec2 u = ( p.xz - uCanopyRect.xy ) * uCanopyRect.z;
      if ( uCanopyRect.w <= 0.0 || any( lessThan( u, vec2( 0.0 ) ) ) || any( greaterThan( u, vec2( 1.0 ) ) ) ) return 1.0;
      return 1.0 - texture2D( uCanopy, u ).r * uCanopyRect.w
        * smoothstep( uCanopyFade.x, uCanopyFade.y, distance( p.xz, cameraPosition.xz ) );
    }
  `,
  /** After `lights_fragment_end`: the canopy takes the direct light, as a shadow does. */
  apply: (pos) => /* glsl */`
    #include <lights_fragment_end>
    {
      float fr_cs = fr_canopyAt( ${pos} );
      reflectedLight.directDiffuse *= fr_cs;
      reflectedLight.directSpecular *= fr_cs;
    }
  `,
};

const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
/** Every bucket of a kind: one per level, and the shadow casters. */
const need = (b) => (b && b.n < b.cap ? b : null);
const all = (kind) => [...kind.buckets, kind.buckets.caster].filter(Boolean);
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Forest {
  /**
   * @param {THREE.Scene} scene
   * @param {object} assets env/treegen.js bundle
   */
  constructor(scene, assets, { margin = 25 } = {}) {
    this.scene = scene;
    this.assets = assets;
    this.margin = margin;
    /** variant object -> id; id -> { variant, size, buckets[level] } */
    this.ids = new Map();
    this.kinds = [];
    this.chunks = new Map();
    this.anchor = new THREE.Vector3(NaN, 0, 0);
    this.stats = { total: 0, drawn: 0, perLevel: [], tris: 0 };
  }

  _id(variant) {
    let id = this.ids.get(variant);
    if (id === undefined) {
      id = this.kinds.length;
      this.ids.set(variant, id);
      this.kinds.push({
        variant,
        // Extent in tree heights, for the culling sphere.
        size: Math.max(1, variant.radius * 2),
        buckets: variant.levels.map(() => null),
        // The last mesh (not billboard) level: what near trees cast shadows with.
        casterLevel: variant.levels.findLastIndex((L) => !L.impostor),
      });
    }
    return id;
  }

  /**
   * @param {number} key chunk index
   * @param {Array<{variant, matrix: THREE.Matrix4, origin: THREE.Vector3,
   *                colour: number[], lone: boolean}>} trees matrix is origin-relative
   */
  addChunk(key, trees) {
    const n = trees.length;
    const rec = {
      n,
      kind: new Int32Array(n),
      pos: new Float64Array(n * 3),
      lin: new Float32Array(n * 9),
      col: new Float32Array(n * 3),
      h: new Float32Array(n),
      jit: new Float32Array(n),
      lone: new Uint8Array(n),
    };
    trees.forEach((t, i) => {
      const e = t.matrix.elements;
      rec.kind[i] = this._id(t.variant);
      rec.pos[i * 3] = t.origin.x + e[12];
      rec.pos[i * 3 + 1] = t.origin.y + e[13];
      rec.pos[i * 3 + 2] = t.origin.z + e[14];
      rec.lin.set([e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]], i * 9);
      rec.col.set(t.colour, i * 3);
      rec.h[i] = Math.hypot(e[4], e[5], e[6]);
      // Jitter the distances per tree, so a stand changes level (and fades)
      // over a band instead of along a clean arc around the camera.
      const x = Math.sin(rec.pos[i * 3] * 12.9898 + rec.pos[i * 3 + 2] * 78.233) * 43758.5453;
      rec.jit[i] = (x - Math.floor(x) - 0.5) * 26;
      rec.lone[i] = t.lone ? 1 : 0;
    });
    this.chunks.set(key, rec);
    this._canopyDirty = true;
  }

  removeChunk(key) { this.chunks.delete(key); this._canopyDirty = true; }

  /**
   * Re-renders the canopy shadow map when it is stale (see `canopyShadow`).
   * Cheap when it is not: three comparisons.
   */
  shadeCanopy(renderer, camera) {
    const C = TREES.canopyShadow;
    if (!C || !C.enabled) return;
    const sun = ATMOSPHERE.sunDir;
    const cx = Math.round(camera.position.x / C.snap) * C.snap;
    const cz = Math.round(camera.position.z / C.snap) * C.snap;
    const sunKey = sun.x * 1e6 + sun.y * 1e3 + sun.z;
    if (!this._canopyDirty && cx === this._canopyX && cz === this._canopyZ && sunKey === this._canopySun) return;
    this._canopyDirty = false;
    this._canopyX = cx; this._canopyZ = cz; this._canopySun = sunKey;

    const S = this._canopy || (this._canopy = this._canopySetup(C));
    const L = WORLD_BIOME.fallLeaves ? this._litter || (this._litter = this._canopySetup(C)) : null;
    let nl = 0;
    const size = C.extent, x0 = cx - size / 2, z0 = cz - size / 2;
    // The shadow falls away from the sun, a crown's centre displaced by its
    // height over the tangent of the sun's elevation, stretched along the fall
    // by 1 / sin(elevation). Floored: a sun on the horizon would throw it off the map.
    const sl = Math.hypot(sun.x, sun.z) || 1;
    const sinE = Math.max(0.3, sun.y / Math.hypot(sun.x, sun.y, sun.z));
    const run = Math.sqrt(1 - sinE * sinE) / sinE;
    const fx = -sun.x / sl, fz = -sun.z / sl;
    const [far0, far1] = TREES.farFade;
    let n = 0;
    for (const rec of this.chunks.values()) {
      const { pos, h, kind: kinds } = rec;
      for (let i = 0; i < rec.n; i++) {
        const px = pos[i * 3], pz = pos[i * 3 + 2];
        if (Math.abs(px - cx) > size / 2 || Math.abs(pz - cz) > size / 2) continue;
        const kind = this.kinds[kinds[i]];
        const fade = kind.variant.fade;
        const d = Math.hypot(px - camera.position.x, pz - camera.position.z);
        const f = 1 - (fade ? smooth(fade[0], fade[1], d) : smooth(far0, far1, d));
        if (f <= 0.01) continue;
        if (n === S.cap) S.grow();
        const r = kind.variant.radius * h[i] * C.crown * f;
        const lift = h[i] * f * 0.6 * run;
        const along = Math.min(2 * r / sinE, 6 * r) + lift * 0.5;
        const a = S.a.array, b = S.b.array;
        a[n * 4] = (px + fx * lift - x0) / size;
        a[n * 4 + 1] = (pz + fz * lift - z0) / size;
        a[n * 4 + 2] = fx * along / size;
        a[n * 4 + 3] = fz * along / size;
        b[n * 2] = 2 * r / size;
        b[n * 2 + 1] = C.density * (fade ? 0.7 : 1);
        n++;
        if (L) {
          // Leaves lie out to about twice the crown, whatever the tree's draw distance.
          if (nl === L.cap) L.grow();
          const rl = kind.variant.radius * h[i] * 1.9 / size;
          const la = L.a.array, lb = L.b.array;
          la[nl * 4] = (px - x0) / size; la[nl * 4 + 1] = (pz - z0) / size;
          la[nl * 4 + 2] = 2 * rl; la[nl * 4 + 3] = 0;
          lb[nl * 2] = 2 * rl; lb[nl * 2 + 1] = fade ? 0.6 : 1;
          nl++;
        }
      }
    }
    S.geo.instanceCount = n;
    S.a.needsUpdate = true;
    S.b.needsUpdate = true;

    const prev = renderer.getRenderTarget(), clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
    renderer.setRenderTarget(S.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(S.scene, S.cam);
    if (L) {
      L.geo.instanceCount = nl;
      L.a.needsUpdate = true;
      L.b.needsUpdate = true;
      renderer.setRenderTarget(L.rt);
      renderer.clear(true, false, false);
      renderer.render(L.scene, L.cam);
      litterMap.uLitter.value = L.rt.texture;
      litterMap.uLitterRect.value.set(x0, z0, 1 / size, 1);
    }
    renderer.setRenderTarget(prev);
    renderer.setClearColor(clear, alpha);

    canopyShadow.uCanopy.value = S.rt.texture;
    canopyShadow.uCanopyRect.value.set(x0, z0, 1 / size, C.strength);
    canopyShadow.uCanopyFade.value.set(C.fade[0], C.fade[1]);
  }

  _canopySetup(C) {
    const rt = new THREE.WebGLRenderTarget(C.size, C.size, {
      depthBuffer: false, generateMipmaps: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    const S = { rt, geo, cap: 0, a: null, b: null };
    S.grow = () => {
      const cap = Math.max(4096, S.cap * 2);
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      const b = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
      if (S.a) { a.array.set(S.a.array); b.array.set(S.b.array); }
      a.setUsage(THREE.DynamicDrawUsage); b.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('iA', a); geo.setAttribute('iB', b);
      Object.assign(S, { cap, a, b });
    };
    S.grow();
    // Straight to clip space from map coordinates: no camera to keep aligned.
    // MAX blending, so a dense stand is as dark as one crown, not darker.
    const material = new THREE.ShaderMaterial({
      vertexShader: /* glsl */`
        attribute vec4 iA;
        attribute vec2 iB;
        varying vec2 vQ;
        varying float vD;
        void main() {
          vQ = position.xy * 2.0;
          vD = iB.y;
          vec2 across = normalize( vec2( -iA.w, iA.z ) + 1e-9 ) * iB.x;
          vec2 p = iA.xy + iA.zw * position.y + across * position.x;
          gl_Position = vec4( p * 2.0 - 1.0, 0.0, 1.0 );
        }
      `,
      fragmentShader: /* glsl */`
        varying vec2 vQ;
        varying float vD;
        void main() {
          gl_FragColor = vec4( vD * ( 1.0 - smoothstep( 0.35, 1.0, length( vQ ) ) ), 0.0, 0.0, 1.0 );
        }
      `,
      depthTest: false,
      depthWrite: false,
      // The quad's winding follows the sun's side: never cull it.
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;
    S.scene = new THREE.Scene();
    S.scene.add(mesh);
    S.cam = new THREE.OrthographicCamera();
    S.dispose = () => { rt.dispose(); geo.dispose(); quad.dispose(); material.dispose(); };
    return S;
  }

  /**
   * The instanced meshes for one variant at one level, grown to hold `need`.
   * `caster` is the shadow-only set: the cheapest mesh level, drawn with all
   * its instances in the shadow pass and none in the main one. (three culls
   * the shadow pass by the MAIN camera's layers, so layers cannot do this.)
   */
  _bucket(kind, level, need, caster = false) {
    const slot = caster ? 'caster' : level;
    let b = kind.buckets[slot];
    if (b && b.cap >= need) return b;
    const cap = Math.max(64, (b ? b.cap : 0) * 2, need);
    const matrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    const colour = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    matrix.setUsage(THREE.DynamicDrawUsage);
    colour.setUsage(THREE.DynamicDrawUsage);
    if (b) {
      matrix.array.set(b.matrix.array);
      colour.array.set(b.colour.array);
      for (const m of b.meshes) { this.scene.remove(m); m.dispose(); }
    }
    const meshes = kind.variant.levels[level].parts.map((part) => {
      const m = new THREE.InstancedMesh(part.geometry, part.material, cap);
      m.instanceMatrix = matrix;
      m.instanceColor = colour;
      m.count = 0;
      m.visible = false;
      m.frustumCulled = false;
      m.castShadow = caster;
      m.receiveShadow = !caster;
      if (caster) {
        m.onBeforeShadow = () => { m.count = m.userData.n; };
        m.onBeforeRender = () => { m.count = 0; };
      }
      m.matrixAutoUpdate = false;
      m.position.copy(this.anchor);
      m.updateMatrix();
      this.scene.add(m);
      return m;
    });
    b = { cap, matrix, colour, meshes, n: b ? b.n : 0, tris: kind.variant.levels[level].tris };
    kind.buckets[slot] = b;
    return b;
  }

  /** Appends one tree to bucket `b`: the linear part scaled by `f`, the origin anchor-relative. */
  _write(b, rec, i, f, ax, ay, az) {
    const { pos, lin, col } = rec;
    const w = b.n++;
    const m = b.matrix.array, o = w * 16, l = i * 9;
    m[o] = lin[l] * f; m[o + 1] = lin[l + 1] * f; m[o + 2] = lin[l + 2] * f; m[o + 3] = 0;
    m[o + 4] = lin[l + 3] * f; m[o + 5] = lin[l + 4] * f; m[o + 6] = lin[l + 5] * f; m[o + 7] = 0;
    m[o + 8] = lin[l + 6] * f; m[o + 9] = lin[l + 7] * f; m[o + 10] = lin[l + 8] * f; m[o + 11] = 0;
    m[o + 12] = pos[i * 3] - ax; m[o + 13] = pos[i * 3 + 1] - ay; m[o + 14] = pos[i * 3 + 2] - az; m[o + 15] = 1;
    const c = b.colour.array;
    c[w * 3] = col[i * 3]; c[w * 3 + 1] = col[i * 3 + 1]; c[w * 3 + 2] = col[i * 3 + 2];
  }

  /**
   * @param {THREE.PerspectiveCamera} camera
   */
  update(camera) {
    const G = TREES.treegen;
    const specs = this.assets.specs;
    camera.updateMatrixWorld();
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    const planes = _frustum.planes;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;

    // Re-anchor in 256 m steps: every mesh moves, and every instance is
    // rewritten below anyway.
    const ax = Math.round(cx / 256) * 256, ay = Math.round(cy / 256) * 256, az = Math.round(cz / 256) * 256;
    const moved = ax !== this.anchor.x || ay !== this.anchor.y || az !== this.anchor.z;
    if (moved) this.anchor.set(ax, ay, az);

    const reach = specs.map((L) => L.from ?? 0);
    const levels = specs.length;
    const [lone0, lone1] = TREES.loneFadeIn;
    const [far0, far1] = TREES.farFade;
    // The shadow box is ±shadowRadius about the car; a low sun throws further.
    const shadowReach = ATMOSPHERE.shadowRadius * 1.6;

    for (const kind of this.kinds) for (const b of all(kind)) b.n = 0;
    let total = 0, drawn = 0;
    const perLevel = new Array(levels).fill(0);
    let tris = 0;

    for (const rec of this.chunks.values()) {
      const { pos, h, jit, lone, kind: kinds } = rec;
      for (let i = 0; i < rec.n; i++) {
        total++;
        const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
        const d = Math.hypot(px - cx, py - cy, pz - cz) + jit[i];
        const kind = this.kinds[kinds[i]];
        const fade = kind.variant.fade;
        let f = 1 - (fade ? smooth(fade[0], fade[1], d) : smooth(far0, far1, d));
        if (lone[i]) f *= smooth(lone0, lone1, d);
        if (f <= 0.01) continue;

        const size = h[i] * kind.size;
        // Sphere around the crown: centre half way up, radius covering the
        // wider of height and crown, plus the sway.
        const r = size * 0.75 + this.margin;
        const sx = px, sy = py + h[i] * 0.5, sz = pz;
        let inside = true;
        for (let p = 0; p < 6; p++) {
          const pl = planes[p], nrm = pl.normal;
          if (nrm.x * sx + nrm.y * sy + nrm.z * sz + pl.constant < -r) { inside = false; break; }
        }
        if (!inside) continue;

        let level = 0;
        while (level + 1 < levels && d >= reach[level + 1]) level++;
        const b = need(kind.buckets[level]) || this._bucket(kind, level, (kind.buckets[level]?.n ?? 0) + 1);
        this._write(b, rec, i, f, ax, ay, az);
        // Near trees cast through their cheapest mesh, not their drawn one.
        if (level < G.shadowLevels && d < shadowReach && kind.casterLevel >= 0) {
          const c = need(kind.buckets.caster) || this._bucket(kind, kind.casterLevel, (kind.buckets.caster?.n ?? 0) + 1, true);
          this._write(c, rec, i, f, ax, ay, az);
        }
        drawn++;
        perLevel[level]++;
        tris += b.tris;
      }
    }

    for (const kind of this.kinds) {
      for (const b of all(kind)) {
        for (const mesh of b.meshes) {
          mesh.count = mesh.userData.n = b.n;
          mesh.visible = b.n > 0;
          if (moved) { mesh.position.copy(this.anchor); mesh.updateMatrix(); }
        }
        if (b.n > 0) {
          b.matrix.clearUpdateRanges();
          b.matrix.addUpdateRange(0, b.n * 16);
          b.matrix.needsUpdate = true;
          b.colour.clearUpdateRanges();
          b.colour.addUpdateRange(0, b.n * 3);
          b.colour.needsUpdate = true;
        }
      }
    }
    this.stats.total = total;
    this.stats.drawn = drawn;
    this.stats.perLevel = perLevel;
    this.stats.tris = tris;
  }

  dispose() {
    if (this._canopy) {
      this._canopy.dispose();
      this._canopy = null;
      canopyShadow.uCanopy.value = null;
      canopyShadow.uCanopyRect.value.w = 0;
    }
    if (this._litter) {
      this._litter.dispose();
      this._litter = null;
      litterMap.uLitter.value = null;
      litterMap.uLitterRect.value.w = 0;
    }
    for (const kind of this.kinds) {
      for (const b of all(kind)) for (const m of b.meshes) { this.scene.remove(m); m.dispose(); }
    }
    this.kinds.length = 0;
    this.ids.clear();
    this.chunks.clear();
  }
}
