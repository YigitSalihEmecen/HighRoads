/**
 * worldtiles.js — the visible ground: world-space LOD tiles over the terrain field.
 *
 * A quadtree of square tiles, every one a 32 × 32 cell grid, so a tile's cell
 * size doubles with each level: 2 m beside the car, 64 m at the horizon. The
 * cover is chosen fresh each frame by splitting any tile whose nearest point is
 * closer to the focus than `split × size`; the result is a set of tiles that
 * tiles the plane exactly — nothing overlaps, nothing is missing.
 *
 * Where a fine tile meets a coarse one their shared edge is sampled at
 * different spacings, which would open hairline cracks; every tile carries a
 * SKIRT, a strip hanging straight down from its border, so a crack shows ground
 * instead of sky. This is the standard chunked-LOD answer (Ulrich 2002) and it is
 * unconditional — it does not depend on the two levels agreeing about anything.
 *
 * Normals come from a grid one cell bigger than the tile all round, sampled
 * from the same field, so two neighbouring tiles of the same level compute
 * identical normals on their shared edge and there is no shading seam (the
 * lesson of bug #61, applied by construction).
 *
 * Tiles near the focus get a trimesh collider — the car drives on what is drawn.
 * Old tiles are kept until everything that replaces them is built, so a level
 * change never leaves a frame with a hole in it.
 */

import * as THREE from 'three';
import { TILES } from './config.js';

const N = 32;               // cells per tile side
const V = N + 1;            // vertices per side
const G = V + 2;            // with the one-cell normal apron

export class WorldTiles {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {import('./terrainfield.js').TerrainField} o.field
   * @param {THREE.Material} o.material
   * @param {(x:number,z:number,y:number,ny:number,d:number,out:THREE.Color)=>number} o.color
   * @param {object|null} o.world Rapier world (null in probes without physics)
   * @param {object|null} o.RAPIER
   */
  constructor({ scene, field, material, color, world = null, RAPIER = null }) {
    this.scene = scene;
    this.field = field;
    this.material = material;
    this.colorFn = color;
    this.world = world;
    this.RAPIER = RAPIER;
    this.tiles = new Map();          // key -> tile
    this.queue = [];
    this.focus = new THREE.Vector3();
    this._sample = { y: 0, natural: 0, d: 0, s: 0, v: 0 };
    this._color = new THREE.Color();
    this.built = 0;
    // New road changes the ground around it: rebuild whatever it reaches.
    field.onGrow.push((x0, z0, x1, z1) => this._invalidate(x0 - 700, z0 - 700, x1 + 700, z1 + 700));
  }

  static size(level) { return TILES.base * Math.pow(2, level); }

  _key(l, i, j) { return l + ':' + i + ':' + j; }

  /** The desired cover around `focus`, as tile descriptors. */
  _cover(fx, fz) {
    const out = [];
    const top = TILES.levels - 1;
    const S = WorldTiles.size(top);
    const reach = Math.ceil(TILES.radius / S);
    const ci = Math.floor(fx / S), cj = Math.floor(fz / S);
    const visit = (l, i, j) => {
      const s = WorldTiles.size(l);
      const x0 = i * s, z0 = j * s;
      // distance from focus to the tile's square
      const dx = Math.max(x0 - fx, 0, fx - (x0 + s));
      const dz = Math.max(z0 - fz, 0, fz - (z0 + s));
      const d = Math.hypot(dx, dz);
      if (d > TILES.radius) return;
      if (l > 0 && d < s * TILES.split) {
        visit(l - 1, i * 2, j * 2); visit(l - 1, i * 2 + 1, j * 2);
        visit(l - 1, i * 2, j * 2 + 1); visit(l - 1, i * 2 + 1, j * 2 + 1);
        return;
      }
      out.push({ l, i, j, d, key: this._key(l, i, j) });
    };
    for (let i = ci - reach; i <= ci + reach; i++) {
      for (let j = cj - reach; j <= cj + reach; j++) visit(top, i, j);
    }
    return out;
  }

  /**
   * Re-plan the cover and build up to `budget` missing tiles, nearest first.
   * `budgetMs` caps the time spent.
   */
  update(fx, fz, budget = TILES.buildPerFrame, budgetMs = TILES.msPerFrame) {
    this.focus.set(fx, 0, fz);
    this.field.sync();
    const want = this._cover(fx, fz);
    const wantKeys = new Set();
    const missing = [];
    for (const t of want) {
      wantKeys.add(t.key);
      if (!this.tiles.has(t.key)) missing.push(t);
    }
    missing.sort((a, b) => a.d - b.d || a.l - b.l);

    const t0 = performance.now();
    let n = 0;
    for (const t of missing) {
      if (n >= budget || (n > 0 && performance.now() - t0 > budgetMs)) break;
      this._build(t.l, t.i, t.j);
      n++;
    }

    // Retire tiles that are no longer wanted once their area is fully covered
    // by built tiles — never earlier, so there is never a hole.
    for (const [k, tile] of this.tiles) {
      if (wantKeys.has(k)) {
        this._setCollider(tile, tile.dist(fx, fz) < TILES.colliderRadius);
        continue;
      }
      if (this._covered(tile, want)) this._dispose(k, tile);
    }
    // Road-invalidated tiles whose slot is no longer wanted at all.
    if (this._retired && this._retired.length) {
      for (let r = this._retired.length - 1; r >= 0; r--) {
        const old = this._retired[r];
        const k = this._key(old.l, old.i, old.j);
        if (!wantKeys.has(k) && this._covered(old, want)) {
          this._dispose(null, old);
          this._retired.splice(r, 1);
        }
      }
    }
    return missing.length - n;
  }

  /** True when every wanted tile overlapping `tile` exists. */
  _covered(tile, want) {
    const s = WorldTiles.size(tile.l);
    const x0 = tile.i * s, z0 = tile.j * s, x1 = x0 + s, z1 = z0 + s;
    for (const w of want) {
      const ws = WorldTiles.size(w.l);
      const wx0 = w.i * ws, wz0 = w.j * ws;
      if (wx0 >= x1 || wx0 + ws <= x0 || wz0 >= z1 || wz0 + ws <= z0) continue;
      if (!this.tiles.has(w.key)) return false;
    }
    return true;
  }

  /** Builds everything wanted around (fx, fz) right now. Boot and teleports. */
  preload(fx, fz, maxDist = Infinity) {
    this.field.sync();
    for (const t of this._cover(fx, fz)) {
      if (t.d <= maxDist && !this.tiles.has(t.key)) this._build(t.l, t.i, t.j);
    }
    this.update(fx, fz, 0);
  }

  _invalidate(x0, z0, x1, z1) {
    for (const [k, tile] of this.tiles) {
      const s = WorldTiles.size(tile.l);
      const tx0 = tile.i * s, tz0 = tile.j * s;
      if (tx0 > x1 || tx0 + s < x0 || tz0 > z1 || tz0 + s < z0) continue;
      tile.stale = true;
      // Rebuilt in place, so the old one stays until the new one exists.
      this.tiles.delete(k);
      this._retired = this._retired || [];
      this._retired.push(tile);
    }
  }

  _build(l, i, j) {
    const s = WorldTiles.size(l);
    const step = s / N;
    const x0 = i * s, z0 = j * s;
    const f = this.field;
    const smp = this._sample;

    // Heights on the apron grid (G × G), road distance on the tile grid.
    const H = new Float32Array(G * G);
    const D = new Float32Array(V * V);
    for (let gj = 0; gj < G; gj++) {
      const z = z0 + (gj - 1) * step;
      for (let gi = 0; gi < G; gi++) {
        const x = x0 + (gi - 1) * step;
        f.sample(x, z, smp);
        H[gj * G + gi] = smp.y;
        if (gi >= 1 && gi <= V && gj >= 1 && gj <= V) D[(gj - 1) * V + (gi - 1)] = smp.d;
      }
    }

    // Main grid + skirt ring (4 × V verts).
    const vCount = V * V + 4 * V;
    const pos = new Float32Array(vCount * 3);
    const nor = new Float32Array(vCount * 3);
    const col = new Float32Array(vCount * 3);
    const c = this._color;
    for (let vj = 0; vj < V; vj++) {
      for (let vi = 0; vi < V; vi++) {
        const g = (vj + 1) * G + (vi + 1);
        const y = H[g];
        const dx = (H[g + 1] - H[g - 1]) / (2 * step);
        const dz = (H[g + G] - H[g - G]) / (2 * step);
        const inv = 1 / Math.sqrt(1 + dx * dx + dz * dz);
        const k = (vj * V + vi) * 3;
        pos[k] = vi * step; pos[k + 1] = y; pos[k + 2] = vj * step;
        nor[k] = -dx * inv; nor[k + 1] = inv; nor[k + 2] = -dz * inv;
        const jit = this.colorFn(x0 + vi * step, z0 + vj * step, y, inv, D[vj * V + vi], c);
        col[k] = c.r * jit; col[k + 1] = c.g * jit; col[k + 2] = c.b * jit;
      }
    }
    // Skirts: copy each border vertex, dropped by a depth that grows with the
    // cell size (a coarse neighbour's chord can sit that far off).
    const drop = TILES.skirt * step + 1.5;
    const border = [];
    for (let t = 0; t < V; t++) border.push(t);                       // z = 0 row
    for (let t = 0; t < V; t++) border.push(N * V + t);              // z = max row
    for (let t = 0; t < V; t++) border.push(t * V);                  // x = 0 column
    for (let t = 0; t < V; t++) border.push(t * V + N);              // x = max column
    for (let b = 0; b < border.length; b++) {
      const src = border[b] * 3, dst = (V * V + b) * 3;
      pos[dst] = pos[src]; pos[dst + 1] = pos[src + 1] - drop; pos[dst + 2] = pos[src + 2];
      nor[dst] = nor[src]; nor[dst + 1] = nor[src + 1]; nor[dst + 2] = nor[src + 2];
      col[dst] = col[src] * 0.8; col[dst + 1] = col[src + 1] * 0.8; col[dst + 2] = col[src + 2] * 0.8;
    }

    const idx = new Uint32Array(N * N * 6 + 4 * N * 6);
    let t = 0;
    for (let vj = 0; vj < N; vj++) {
      for (let vi = 0; vi < N; vi++) {
        const a = vj * V + vi, b = a + 1, cc = a + V, d = cc + 1;
        // Upward faces (+x then +z is clockwise seen from above in three's
        // right-handed frame, so a, cc, b).
        idx[t++] = a; idx[t++] = cc; idx[t++] = b;
        idx[t++] = b; idx[t++] = cc; idx[t++] = d;
      }
    }
    const mainTris = t;
    // Skirt quads, wound outward per side; drawn double-sided anyway via a
    // second winding so the orientation can never hide one.
    const skirtSide = (rowStart, step1, skirtStart) => {
      for (let q = 0; q < N; q++) {
        const a = rowStart + q * step1, b = rowStart + (q + 1) * step1;
        const sa = skirtStart + q, sb = skirtStart + q + 1;
        idx[t++] = a; idx[t++] = b; idx[t++] = sa;
        idx[t++] = b; idx[t++] = sb; idx[t++] = sa;
      }
    };
    skirtSide(0, 1, V * V);              // z = 0
    skirtSide(N * V, 1, V * V + V);      // z = max
    skirtSide(0, V, V * V + 2 * V);      // x = 0
    skirtSide(N, V, V * V + 3 * V);      // x = max
    // Skirts need both faces (which side is "out" differs per edge).
    const both = new Uint32Array(t + (t - mainTris));
    both.set(idx.subarray(0, t));
    for (let q = mainTris, w = t; q < t; q += 3, w += 3) {
      both[w] = idx[q]; both[w + 1] = idx[q + 2]; both[w + 2] = idx[q + 1];
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(both, 1));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(x0, 0, z0);
    mesh.receiveShadow = true;
    mesh.castShadow = l <= 1;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.userData.tile = true;
    this.scene.add(mesh);

    const tile = {
      l, i, j, mesh, collider: null, stale: false,
      // Collider data: the main grid only.
      cpos: pos.subarray(0, V * V * 3), cidx: idx.slice(0, mainTris),
      dist(fx, fz) {
        const dx = Math.max(x0 - fx, 0, fx - (x0 + s));
        const dz = Math.max(z0 - fz, 0, fz - (z0 + s));
        return Math.hypot(dx, dz);
      },
    };
    this.tiles.set(this._key(l, i, j), tile);
    this.built++;

    // Anything this tile replaces after a road-driven rebuild can go now.
    if (this._retired && this._retired.length) {
      for (let r = this._retired.length - 1; r >= 0; r--) {
        const old = this._retired[r];
        if (old.l === l && old.i === i && old.j === j) {
          this._dispose(null, old);
          this._retired.splice(r, 1);
        }
      }
    }
    this._setCollider(tile, tile.dist(this.focus.x, this.focus.z) < TILES.colliderRadius);
    return tile;
  }

  _setCollider(tile, on) {
    if (!this.world) return;
    if (on && !tile.collider) {
      const s = WorldTiles.size(tile.l);
      tile.collider = this.world.createCollider(
        this.RAPIER.ColliderDesc.trimesh(tile.cpos, tile.cidx)
          .setTranslation(tile.i * s, 0, tile.j * s)
          .setFriction(1.0).setRestitution(0.0));
    } else if (!on && tile.collider) {
      this.world.removeCollider(tile.collider, false);
      tile.collider = null;
    }
  }

  _dispose(k, tile) {
    this.scene.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    if (tile.collider && this.world) this.world.removeCollider(tile.collider, false);
    tile.collider = null;
    if (k) this.tiles.delete(k);
  }

  /** Height of the DRAWN surface at (x, z), from the finest built tile; NaN if none. */
  surfaceAt(x, z) {
    for (let l = 0; l < TILES.levels; l++) {
      const s = WorldTiles.size(l);
      const tile = this.tiles.get(this._key(l, Math.floor(x / s), Math.floor(z / s)));
      if (!tile) continue;
      const step = s / N;
      const fx = (x - tile.i * s) / step, fz = (z - tile.j * s) / step;
      const vi = Math.min(N - 1, Math.floor(fx)), vj = Math.min(N - 1, Math.floor(fz));
      const u = fx - vi, w = fz - vj;
      const p = tile.cpos;
      const ya = p[(vj * V + vi) * 3 + 1], yb = p[(vj * V + vi + 1) * 3 + 1];
      const yc = p[((vj + 1) * V + vi) * 3 + 1], yd = p[((vj + 1) * V + vi + 1) * 3 + 1];
      // Same diagonal as the index buffer: (a, cc, b) and (b, cc, d).
      return u + w <= 1 ? ya + (yb - ya) * u + (yc - ya) * w
                        : yd + (yc - yd) * (1 - u) + (yb - yd) * (1 - w);
    }
    return NaN;
  }

  dispose() {
    for (const [k, tile] of this.tiles) this._dispose(k, tile);
    if (this._retired) for (const t of this._retired) this._dispose(null, t);
    this._retired = [];
  }
}
