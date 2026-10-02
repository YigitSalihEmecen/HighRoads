/**
 * instcull.js — per-instance view culling for the scattered props.
 *
 * Tree, shrub and rock batches are one InstancedMesh per species per chunk,
 * and a chunk's batch spreads over hundreds of metres (the distant woodland
 * reaches 650 m either side of the road). three culls a mesh as a whole, by
 * one bounding sphere — and these batches had culling OFF, because the wind
 * shader moves vertices. So every tree in every loaded chunk was drawn every
 * frame, into the shadow map too: measured, ~90 % of the instances drawn were
 * behind the camera or outside the view.
 *
 * This keeps each registered mesh's full instance data aside and, once a
 * frame, packs only the instances whose bounding sphere (geometry sphere ×
 * the instance's scale, + a sway margin) is inside the camera frustum —
 * GROWN by `margin`, so a tree just outside the view still casts its shadow
 * into it — to the front of the instance buffers, and draws that prefix.
 * A few thousand sphere tests and a sub-buffer upload a frame.
 */
import * as THREE from 'three';

const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();

export class InstanceCuller {
  constructor({ margin = 25, sway = 1.5 } = {}) {
    this.margin = margin;
    this.sway = sway;
    this.meshes = new Set();
    this.stats = { meshes: 0, total: 0, drawn: 0 };
  }

  /** Take over culling of `mesh` (its instance buffers must be filled). */
  add(mesh) {
    const n = mesh.count;
    const m = mesh.instanceMatrix.array;
    const src = new Float32Array(m.subarray(0, n * 16));
    const srcCol = mesh.instanceColor ? new Float32Array(mesh.instanceColor.array.subarray(0, n * 3)) : null;
    const geo = mesh.geometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const gs = geo.boundingSphere;
    // Per instance: world-ish centre offset is the matrix translation plus the
    // scaled sphere centre; radius is the sphere radius × the largest scale.
    const rad = new Float32Array(n);
    const cen = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      const o = k * 16;
      const sx = Math.hypot(src[o], src[o + 1], src[o + 2]);
      const sy = Math.hypot(src[o + 4], src[o + 5], src[o + 6]);
      const sz = Math.hypot(src[o + 8], src[o + 9], src[o + 10]);
      const sc = Math.max(sx, sy, sz);
      const c = gs.center;
      cen[k * 3] = src[o + 12] + src[o] * c.x + src[o + 4] * c.y + src[o + 8] * c.z;
      cen[k * 3 + 1] = src[o + 13] + src[o + 1] * c.x + src[o + 5] * c.y + src[o + 9] * c.z;
      cen[k * 3 + 2] = src[o + 14] + src[o + 2] * c.x + src[o + 6] * c.y + src[o + 10] * c.z;
      rad[k] = gs.radius * sc + this.sway;
    }
    mesh.userData.icull = { n, src, srcCol, rad, cen, drawn: -1 };
    mesh.frustumCulled = false;     // we do it, per instance
    this.meshes.add(mesh);
  }

  /** Cull every registered mesh against `camera`. Call after the camera moves. */
  update(camera) {
    camera.updateMatrixWorld();
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    const planes = _frustum.planes;
    const margin = this.margin;
    let total = 0, drawn = 0, live = 0;
    for (const mesh of this.meshes) {
      if (!mesh.parent) { this.meshes.delete(mesh); continue; }   // evicted
      const d = mesh.userData.icull;
      // The mesh's own matrix (a translation to the chunk origin; its parent is
      // the scene) — matrixWorld is identity until the first render.
      const e = mesh.matrix.elements;
      const ox = e[12], oy = e[13], oz = e[14];
      const dst = mesh.instanceMatrix.array;
      const dstCol = d.srcCol ? mesh.instanceColor.array : null;
      let w = 0;
      for (let k = 0; k < d.n; k++) {
        const x = d.cen[k * 3] + ox, y = d.cen[k * 3 + 1] + oy, z = d.cen[k * 3 + 2] + oz;
        const r = d.rad[k] + margin;
        let inside = true;
        for (let p = 0; p < 6; p++) {
          const pl = planes[p], nrm = pl.normal;
          if (nrm.x * x + nrm.y * y + nrm.z * z + pl.constant < -r) { inside = false; break; }
        }
        if (!inside) continue;
        const so = k * 16, wo = w * 16;
        for (let q = 0; q < 16; q++) dst[wo + q] = d.src[so + q];
        if (dstCol) { dstCol[w * 3] = d.srcCol[k * 3]; dstCol[w * 3 + 1] = d.srcCol[k * 3 + 1]; dstCol[w * 3 + 2] = d.srcCol[k * 3 + 2]; }
        w++;
      }
      // Upload just the drawn prefix.
      mesh.count = w;
      mesh.visible = w > 0;
      if (w > 0) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, w * 16);
        mesh.instanceMatrix.needsUpdate = true;
        if (dstCol) {
          mesh.instanceColor.clearUpdateRanges();
          mesh.instanceColor.addUpdateRange(0, w * 3);
          mesh.instanceColor.needsUpdate = true;
        }
      }
      d.drawn = w;
      total += d.n; drawn += w; live++;
    }
    this.stats.meshes = live; this.stats.total = total; this.stats.drawn = drawn;
  }
}
