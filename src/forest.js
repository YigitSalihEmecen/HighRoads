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
import { ATMOSPHERE, TREES } from './config.js';

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
  }

  removeChunk(key) { this.chunks.delete(key); }

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
    for (const kind of this.kinds) {
      for (const b of all(kind)) for (const m of b.meshes) { this.scene.remove(m); m.dispose(); }
    }
    this.kinds.length = 0;
    this.ids.clear();
    this.chunks.clear();
  }
}
