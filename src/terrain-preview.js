/**
 * src/terrain-preview.js — captures a high-resolution, high-detail 3D perspective snapshot of the road and landscape.
 */
import * as THREE from 'three';
import { ATMOSPHERE } from './config.js';

const _fScratch = {
  pos: new THREE.Vector3(),
  tan: new THREE.Vector3(),
  right: new THREE.Vector3(),
  up: new THREE.Vector3(),
};

const _fLook = {
  pos: new THREE.Vector3(),
  tan: new THREE.Vector3(),
  right: new THREE.Vector3(),
  up: new THREE.Vector3(),
};

/**
 * Renders a high-detail perspective snapshot of the road from an elevated camera angle looking down.
 */
export function drawTerrainMap(canvas, terrain, path, seed, gfx, chunks) {
  if (!canvas || !path) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(540, Math.round((rect.width || 540) * dpr));
  const h = Math.max(300, Math.round((rect.height || 300) * dpr));
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  if (gfx && gfx.renderer && gfx.scene) {
    const previewCam = new THREE.PerspectiveCamera(52, w / h, 0.5, 3500);
    const startS = 180;
    const f0 = path.frameAt(startS, _fScratch);

    // Elevated position: 14.0m above the asphalt, looking down along the road spline
    const eye = f0.pos.clone()
      .addScaledVector(f0.up, 14.0)
      .addScaledVector(f0.right, 1.8)
      .addScaledVector(f0.tan, -18.0);

    // Target: looking down at the road surface 70m ahead with downward pitch
    const fTarget = path.frameAt(startS + 70, _fLook);
    const target = fTarget.pos.clone().addScaledVector(f0.up, 0.2);

    previewCam.position.copy(eye);
    previewCam.lookAt(target);
    previewCam.updateProjectionMatrix();
    previewCam.updateMatrixWorld();

    // Ensure all preloaded chunks and props are visible
    if (chunks && chunks.chunks) {
      for (const chunk of chunks.chunks.values()) {
        chunk.visible = true;
        for (const obj of chunk.objects) {
          obj.visible = true;
        }
      }
    }

    // Align sky and sunlight with preview camera
    gfx.follow(target);
    if (gfx.sky) {
      gfx.sky.position.copy(eye);
      gfx.sky.scale.setScalar(3500 * 0.9);
    }

    const rt = new THREE.WebGLRenderTarget(w, h, {
      generateMipmaps: false,
      colorSpace: THREE.SRGBColorSpace,
    });

    const prevToneMapping = gfx.renderer.toneMapping;
    const prevExposure = gfx.renderer.toneMappingExposure;
    const prevTarget = gfx.renderer.getRenderTarget();

    gfx.renderer.toneMapping = THREE.NeutralToneMapping;
    gfx.renderer.toneMappingExposure = ATMOSPHERE.exposure || 1.35;

    gfx.renderer.setRenderTarget(rt);
    gfx.renderer.render(gfx.scene, previewCam);

    const pixels = new Uint8Array(w * h * 4);
    gfx.renderer.readRenderTargetPixels(rt, 0, 0, w, h, pixels);
    gfx.renderer.setRenderTarget(prevTarget);
    gfx.renderer.toneMapping = prevToneMapping;
    gfx.renderer.toneMappingExposure = prevExposure;
    rt.dispose();

    const imgData = ctx.createImageData(w, h);
    const dst = imgData.data;
    for (let y = 0; y < h; y++) {
      const srcRow = h - 1 - y;
      for (let x = 0; x < w; x++) {
        const srcIdx = (srcRow * w + x) * 4;
        const dstIdx = (y * w + x) * 4;
        dst[dstIdx] = pixels[srcIdx];
        dst[dstIdx + 1] = pixels[srcIdx + 1];
        dst[dstIdx + 2] = pixels[srcIdx + 2];
        dst[dstIdx + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  // The badge under the snapshot names the world it is a snapshot of. There
  // used to be a second caption next to it repeating the same seed with the
  // words "ROUTE PERSPECTIVE" in front; the picture is the caption.
  const seedBadge = document.getElementById('seed-badge');
  if (seedBadge) {
    seedBadge.textContent = seed;
  }
}
