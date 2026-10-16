/**
 * env/signs.js — road signs, built by Roadsign-gen (`roadsign_gen/`, a
 * submodule, consumed through its plain-ESM bundle `lib/roadsign.js`).
 *
 * A fixed library of assemblies is built once at boot, each tagged with the
 * ROLE it plays on the road (chevrons on the outside of a bend, a warning
 * before one, speed limits, guide signs, gantries over the carriageway...).
 * Where they go is chunks.js:_buildSigns.
 *
 * Each assembly is merged down to one vertex-coloured mesh for all its steel,
 * aluminium and concrete (one material for the whole library) plus one mesh
 * per painted face, so a sign is 2–4 draw calls however much hardware the
 * generator modelled. A placed sign is a THREE.LOD whose far level is empty:
 * past `SIGNS.drawDistance` a sign is a couple of pixels and is not drawn.
 *
 * ~0.6–4k triangles per sign at `SIGNS.lod` 1, ~0.3–1.5k at 2.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  buildRoadSignAssemblyScene, normalizeSignConfig, loadSignFonts, generateSignAssemblyFromSeed,
} from '../../roadsign_gen/lib/roadsign.js';
import { SIGNS } from '../config.js';

const FONTS = new URL('../../roadsign_gen/public/fonts/', import.meta.url).href;

const YELLOW = { colorPreset: 'warning-yellow', bgColor: '#F5C400', borderColor: '#141619', textColor: '#141619' };
const ORANGE = { colorPreset: 'work-orange', bgColor: '#F26B1D', borderColor: '#141619', textColor: '#141619' };
const EURO = { colorPreset: 'euro-warning', bgColor: '#F4F6F8', borderColor: '#D61F26', textColor: '#111315' };
const WHITE = { colorPreset: 'regulatory-white', bgColor: '#F4F5F7', borderColor: '#16181D', textColor: '#16181D' };
const GREEN = { colorPreset: 'freeway-green', bgColor: '#006B54', borderColor: '#F4F6F8', textColor: '#F4F6F8' };
const BLUE = { colorPreset: 'motorist-blue', bgColor: '#0046AD', borderColor: '#F3F4F0', textColor: '#F3F4F0' };
const BROWN = { colorPreset: 'recreation-brown', bgColor: '#5C3D2E', borderColor: '#F8FAFC', textColor: '#F8FAFC' };

const post = (poleHeight, extra = {}) => ({
  structureType: 'single-post', poleProfile: 'u-channel', poleMaterial: 'galvanized',
  baseType: 'direct-embed', poleHeight, poleRadius: 0.05, weathering: 0.12, ...extra,
});
const line = (text, fontSize, letterSpacing = 2, align = 'center') => ({ id: text, text, fontSize, letterSpacing, align });
const warnTri = (pictogramType) => ({
  shape: 'triangle-up', width: 1.15, height: 1.05, cornerRadius: 0.08, ...EURO,
  borderWidth: 0.1, borderInset: 0, showFaceBolts: false, lines: [], pictogramType, pictogramScale: 1.1,
});

/**
 * The library, by role. `dir` is the way a bend turns (+1 left, as `frame.curv`);
 * the rest are free to face either way.
 */
function catalogue() {
  const C = [];
  const add = (role, config, dir = 0) => C.push({ role, dir, config });

  for (const [dir, side] of [[1, 'left'], [-1, 'right']]) {
    add('chevron', {
      structure: post(2.2, { poleProfile: 'square-perforated' }),
      signs: [{ shape: 'chevron-rect', width: 0.62, height: 0.8, cornerRadius: 0.04, ...YELLOW, lines: [],
        arrowType: side, arrowPosition: 'center', arrowScale: 1.25, showFaceBolts: false }],
    }, dir);
    add('curve', {
      structure: post(3.3, { poleMaterial: 'weathered-steel', weathering: 0.2 }),
      signs: [
        { shape: 'diamond', width: 1.0, height: 1.0, cornerRadius: 0.07, ...YELLOW, lines: [],
          arrowType: `turn-${side}-90`, arrowPosition: 'center', arrowScale: 1.1, yOffset: 0.5 },
        { shape: 'rounded-rect', width: 0.7, height: 0.62, cornerRadius: 0.05, ...YELLOW,
          fontFamily: 'HighwayGothicWide', lines: [line('70', 130), line('km/h', 54, 3)], yOffset: -0.42 },
      ],
    }, dir);
  }
  add('curve', {
    structure: post(3.1, { poleProfile: 'round-steel' }),
    signs: [{ shape: 'diamond', width: 1.05, height: 1.05, cornerRadius: 0.07, ...YELLOW, lines: [],
      arrowType: 's-curve-left', arrowPosition: 'center', arrowScale: 1.1 }],
  }, 1);

  for (const limit of ['80', '100', '120']) {
    add('speed', {
      structure: post(2.9, { poleProfile: 'round-steel' }),
      signs: [{ shape: 'circle', width: 0.9, height: 0.9, ...WHITE, borderColor: '#D61F26', borderWidth: 0.11,
        borderInset: 0, showFaceBolts: false, fontFamily: 'DIN1451', lines: [line(limit, limit.length > 2 ? 120 : 150)] }],
    });
  }
  add('speed', {
    structure: post(3.2),
    signs: [{ shape: 'rounded-rect', width: 0.8, height: 1.0, cornerRadius: 0.05, ...WHITE,
      fontFamily: 'HighwayGothic', lines: [line('SPEED', 62), line('LIMIT', 62), line('65', 150)] }],
  });

  for (const p of ['deer', 'slippery', 'steep-grade', 'bicycle']) add('warn', { structure: post(2.9, { poleProfile: 'round-steel' }), signs: [warnTri(p)] });
  add('warn', {
    structure: post(3.0, { poleMaterial: 'weathered-steel', weathering: 0.25 }),
    signs: [{ shape: 'diamond', width: 1.0, height: 1.0, cornerRadius: 0.07, ...YELLOW, lines: [], pictogramType: 'deer', pictogramScale: 1.05 }],
  });
  add('warn', {
    structure: post(3.4, { baseType: 'crash-barrels' }),
    signs: [
      { shape: 'diamond', width: 1.05, height: 1.05, cornerRadius: 0.07, ...ORANGE, lines: [], pictogramType: 'roadwork', yOffset: 0.45 },
      { shape: 'rounded-rect', width: 1.1, height: 0.42, cornerRadius: 0.04, ...ORANGE,
        fontFamily: 'HighwayGothicCond', lines: [line('NEXT 2 km', 90, 3)], yOffset: -0.42 },
    ],
  });

  add('pennant', {
    structure: post(2.8),
    signs: [{ shape: 'pennant', width: 1.25, height: 0.9, cornerRadius: 0.05, ...YELLOW,
      fontFamily: 'HighwayGothicCond', lines: [line('NO PASSING', 40, 1, 'left'), line('ZONE', 40, 1, 'left')] }],
  });

  add('marker', {
    structure: post(3.8, { poleProfile: 'square-perforated' }),
    signs: [
      { shape: 'rounded-rect', width: 0.95, height: 0.44, cornerRadius: 0.05, ...BLUE,
        fontFamily: 'HighwayGothicCond', lines: [line('NORTH', 120, 4)], yOffset: 0.55 },
      { shape: 'interstate-shield', width: 0.95, height: 0.95, colorPreset: 'interstate-classic', ...BLUE,
        accentColor: '#C8102E', fontFamily: 'HighwayGothicWide', headerText: 'INTERSTATE', lines: [line('17', 165)], yOffset: -0.25 },
    ],
  });
  add('marker', {
    structure: post(3.0, { poleProfile: 'wood-post', poleMaterial: 'wood-cedar', poleRadius: 0.07 }),
    signs: [{ shape: 'us-route-shield', width: 0.85, height: 0.85, ...WHITE, fontFamily: 'HighwayGothicWide', lines: [line('41', 165)] }],
  });
  add('marker', {
    structure: post(3.2, { poleProfile: 'wood-post', poleMaterial: 'wood-cedar', poleRadius: 0.08 }),
    signs: [{ shape: 'rounded-rect', width: 1.6, height: 0.8, cornerRadius: 0.06, ...BROWN,
      fontFamily: 'HighwayGothic', lines: [line('SCENIC', 70, 4), line('LOOKOUT  2 km', 54, 2)] }],
  });

  const guide = (rows, badge) => ({
    structure: { structureType: 'dual-post', poleProfile: 'i-beam', poleMaterial: 'galvanized',
      baseType: 'breakaway-slip', poleHeight: 3.6, poleRadius: 0.06, gantrySpan: 3.0, weathering: 0.1 },
    signs: [{ shape: 'rounded-rect', width: 2.9, height: 1.5, cornerRadius: 0.1, ...GREEN,
      fontFamily: 'HighwayGothicExp', showFaceBolts: false, badgeLayout: 'left-column',
      badges: badge ? [{ id: 'b', type: 'state-circle', number: badge }] : [],
      lines: rows.map((r) => line(r, 64, 2, 'left')) }],
  });
  add('guide', guide(['Ashcombe   12', 'Harrow Vale   38', 'Kestrel Bay   71'], '9'));
  add('guide', guide(['Marlow Ridge   6', 'Northgate   24'], '14'));
  add('guide', guide(['Old Mill   3', 'Stanton   19', 'Corbridge   47']));

  // Taller and larger than the generator's: a highway gantry clears trucks
  // and is read at speed. Spans stay put; the faces spread with their scale.
  const overhead = (a) => {
    a.structure.poleHeight *= SIGNS.overheadLift;
    for (const s of a.signs) { s.scale *= SIGNS.overheadScale; s.xOffset *= SIGNS.overheadScale; }
  };
  // The generator's own regional assemblies, for variety: the first few seeds
  // that come out as roadside stacks, and a few overhead ones re-spanned.
  let verge = 0, over = 0;
  for (let i = 0; i < 400 && (verge < SIGNS.seededVerge || over < SIGNS.seededOverhead); i++) {
    const a = generateSignAssemblyFromSeed(`HIGHROADS-${i}`);
    a.structure.showRoadBase = false;
    const t = a.structure.structureType;
    if ((t === 'dual-post' || t === 'route-tree') && verge < SIGNS.seededVerge) {
      verge++;
      if (a.structure.baseType === 'crash-barrels') a.structure.baseType = 'breakaway-slip';
      add('guide', a);
    } else if ((t === 'portal-gantry' || t === 'truss-gantry') && over < SIGNS.seededOverhead) {
      over++;
      // Legs either side of the whole carriageway, faces over the player's lanes.
      a.structure.gantrySpan = 2 * SIGNS.gantryLeg;
      overhead(a);
      for (const s of a.signs) s.xOffset += SIGNS.gantryShift;
      add('portal', a);
    } else if (t === 'cantilever' && over < SIGNS.seededOverhead) {
      over++;
      a.structure.gantrySpan = SIGNS.cantileverSpan;
      overhead(a);
      add('cantilever', a);
    }
  }
  return C;
}

/** One material for every sign's hardware: its colour is in the vertices. */
const HARDWARE = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 });

/** `geo`'s triangles from `start` for `count` vertices of the non-indexed copy, with `keep` attributes. */
function subset(geo, start, count, keep) {
  const flat = geo.index ? geo.toNonIndexed() : geo;
  const out = new THREE.BufferGeometry();
  const end = Math.min(start + count, flat.attributes.position.count);
  for (const name of keep) {
    const a = flat.attributes[name];
    if (!a) return null;
    out.setAttribute(name, new THREE.BufferAttribute(a.array.slice(start * a.itemSize, end * a.itemSize), a.itemSize));
  }
  return out;
}

/** An assembly as one hardware mesh plus its painted faces, all in the root's frame. */
function merge(root) {
  root.updateMatrixWorld(true);
  const hardware = [];
  const faces = new Map();
  root.traverse((m) => {
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const groups = m.geometry.groups.length ? m.geometry.groups
      : [{ start: 0, count: Infinity, materialIndex: 0 }];
    const indexed = !!m.geometry.index;
    for (const g of groups) {
      const mat = mats[g.materialIndex] || mats[0];
      // Groups count indices on an indexed geometry: the non-indexed copy has one vertex per index.
      const start = g.start, count = indexed && g.count === Infinity ? m.geometry.index.count : g.count;
      if (mat.map) {
        const geo = subset(m.geometry, start, count, ['position', 'normal', 'uv']);
        if (!geo) continue;
        geo.applyMatrix4(m.matrixWorld);
        if (!faces.has(mat)) faces.set(mat, []);
        faces.get(mat).push(geo);
      } else {
        const geo = subset(m.geometry, start, count, ['position', 'normal']);
        if (!geo) continue;
        geo.applyMatrix4(m.matrixWorld);
        const c = mat.color || new THREE.Color(1, 1, 1);
        const n = geo.attributes.position.count;
        const col = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        hardware.push(geo);
      }
    }
    m.geometry.dispose();
  });
  const parts = [];
  if (hardware.length) parts.push({ geometry: mergeGeometries(hardware), material: HARDWARE });
  for (const [material, geos] of faces) {
    material.emissive?.setScalar(0);
    parts.push({ geometry: mergeGeometries(geos), material });
  }
  for (const p of parts) p.geometry.computeBoundingSphere();
  const box = new THREE.Box3();
  for (const p of parts) { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox); }
  const tris = parts.reduce((t, p) => t + p.geometry.attributes.position.count / 3, 0);
  return { parts, box, tris };
}

/**
 * Builds the library. Yields a frame between assemblies (each paints its
 * faces on a canvas), and reports progress as a share.
 * @returns {Promise<{ roles: Map<string, object[]>, instance(variant): THREE.LOD, dispose() }>}
 */
export async function createSignAssetsAsync(onProgress = () => {}) {
  await loadSignFonts(FONTS);
  const roles = new Map();
  const all = [];
  const list = catalogue();
  for (let i = 0; i < list.length; i++) {
    const { role, dir, config } = list[i];
    const built = buildRoadSignAssemblyScene(normalizeSignConfig(config), SIGNS.lod, false, null);
    if (role !== 'portal' && role !== 'cantilever') built.rootGroup.scale.setScalar(SIGNS.scale);
    const variant = { role, dir, ...merge(built.rootGroup) };
    all.push(variant);
    if (!roles.has(role)) roles.set(role, []);
    roles.get(role).push(variant);
    onProgress((i + 1) / list.length);
    await new Promise((r) => requestAnimationFrame(r));
  }
  return {
    roles,
    /** A placeable copy: shares every geometry and material with the library. */
    instance(variant) {
      const g = new THREE.Group();
      for (const p of variant.parts) {
        const m = new THREE.Mesh(p.geometry, p.material);
        m.castShadow = true;
        m.receiveShadow = true;
        m.matrixAutoUpdate = false;
        g.add(m);
      }
      const lod = new THREE.LOD();
      lod.addLevel(g, 0);
      lod.addLevel(new THREE.Object3D(), SIGNS.drawDistance);
      return lod;
    },
    dispose() {
      for (const v of all) for (const p of v.parts) {
        p.geometry.dispose();
        if (p.material !== HARDWARE) { p.material.map?.dispose(); p.material.dispose(); }
      }
    },
  };
}
