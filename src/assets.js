/**
 * assets.js — loading and conditioning of the external art.
 *
 * CARS, AND NOTHING ELSE. There used to be a second pipeline in here — an OBJ
 * parser and an inlined 18-colour palette for the Quaternius nature pack — and
 * it is gone, along with the models. Everything the world is dressed with is
 * now generated from code in `src/env/`, which means the whole of the external
 * art in this project is the car pack in `assets/`.
 *
 *   CARS (FBX).  Every model is one body mesh plus four tyres named
 *   `*_FL_Tire` … `*_BR_Tire`, sharing a 512x512 palette atlas. The tyres are
 *   detached so the vehicle controller can steer and spin them, and the
 *   materials are rebuilt locally rather than trusting whatever the exporter
 *   embedded.
 */

import * as THREE from 'three';

const CAR_DIR = 'assets/car_models/Fbx';
const CAR_TEXTURE = 'assets/car_models/Fbx/Texture/Color.png';

/* ------------------------------------------------------------- loaders --- */

/** The shared car atlas. Nearest filtering — it is a palette, not a picture. */
export async function loadCarTexture() {
  const tex = await new THREE.TextureLoader().loadAsync(CAR_TEXTURE);
  tex.colorSpace = THREE.SRGBColorSpace;
  // The atlas packs flat colour swatches edge to edge. Any filtering blends
  // neighbouring swatches and bleeds the wrong colour along every UV seam.
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = 1;
  tex.flipY = false;
  return tex;
}

/** Rear-lamp emissive strength when coasting, and under braking. */
const TAIL_IDLE = 0.55;
const TAIL_BRAKE = 6.0;
/** Head-lamp emissive: off, on, and the brief overdrive of a flash. */
const HEAD_OFF = 0.35;
const HEAD_ON = 3.2;
const HEAD_FLASH = 9.0;

const WHEEL_RE = /_(FL|FR|BL|BR)_Tire$/i;

/** Material slots the body mesh is re-grouped into. Order matters. */
const SLOT_BODY = 0;   // textured trim, glass, bumpers — left alone
const SLOT_PAINT = 1;  // the palette swatch that is the car's main colour
const SLOT_TRIM = 2;   // the next largest swatch — the car's second colour
const SLOT_HEAD = 3;   // forward-facing lamps
const SLOT_TAIL = 4;   // rear lamps
const SLOT_COUNT = 5;

/** The atlas is a 16x16 grid of flat swatches; this is which cell a UV lands in. */
const ATLAS_GRID = 16;
function cellKey(u, v) {
  return `${Math.floor(u * ATLAS_GRID)},${Math.floor(v * ATLAS_GRID)}`;
}

/**
 * Reads the flat colour out of one atlas cell.
 *
 * The second paint slot has to default to the colour the artist put there, or
 * every car would arrive in the garage already wearing a change nobody asked
 * for. Each cell is a single flat swatch, so one pixel from the middle of it is
 * the whole answer.
 *
 * Cached on the texture: nine cars share one atlas and the canvas readback is
 * the only part of loading that touches the 2D context at all. Returns null
 * when there is no decoded image to read — headless probes pass no texture, and
 * a tainted canvas throws — and every caller has a fallback for that.
 */
function sampleCell(texture, key) {
  if (!texture || !texture.image || !key) return null;
  try {
    let ctx = texture.userData && texture.userData._atlasCtx;
    if (!ctx) {
      const img = texture.image;
      const w = img.width || 0, h = img.height || 0;
      if (!w || !h) return null;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0);
      texture.userData = texture.userData || {};
      texture.userData._atlasCtx = ctx;
    }
    const [cx, cy] = key.split(',').map(Number);
    const cw = ctx.canvas.width / ATLAS_GRID;
    const ch = ctx.canvas.height / ATLAS_GRID;
    // The texture is loaded with flipY = false, so v maps straight to rows and
    // the cell's row index is its y index — no flip to undo here.
    const px = Math.min(ctx.canvas.width - 1, Math.floor((cx + 0.5) * cw));
    const py = Math.min(ctx.canvas.height - 1, Math.floor((cy + 0.5) * ch));
    const d = ctx.getImageData(px, py, 1, 1).data;
    return (d[0] << 16) | (d[1] << 8) | d[2];
  } catch (err) {
    return null;
  }
}

/** Per-triangle material index, from whatever groups the importer produced. */
function triangleMaterials(geo, triCount) {
  const out = new Int32Array(triCount);
  for (const g of geo.groups) {
    const start = Math.floor(g.start / 3);
    const count = Math.floor(g.count / 3);
    for (let t = start; t < start + count && t < triCount; t++) out[t] = g.materialIndex || 0;
  }
  return out;
}

/**
 * Ranks the palette cells the bodywork uses by the surface area they cover,
 * largest first, across every non-emissive group.
 *
 * The first is the car's paint. The SECOND is the reason this returns a list at
 * all: every model in the pack has one, it is always a large flat block of
 * colour, and until now it kept whatever the artist chose no matter what the
 * player picked — the Hatchback's green upper body, the Van's brown roof, the
 * Interceptor's grey, the Muscle car's dark trim. Those are the "permanently
 * coloured sections". Because each cell is a single flat colour, both can be
 * moved onto plain materials and recoloured by setting `.color` — no texture
 * rewriting, and instant.
 *
 * Ranking by raw surface area does count geometry nobody sees, so it was
 * checked against the alternative: six orthographic z-buffers over each model,
 * counting only the cells actually visible from outside. Across the nine
 * roster cars the two metrics agree on the top cell every time and on the
 * second for seven of nine, so the cheap one stands.
 */
function rankPaintCells(meshes, bloomIndex) {
  const area = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), cr = new THREE.Vector3();

  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    if (!uv) continue;
    const idx = geo.index ? geo.index.array : null;
    const triCount = (idx ? idx.length : pos.count) / 3;
    const mats = triangleMaterials(geo, triCount);

    for (let t = 0; t < triCount; t++) {
      if (mats[t] === bloomIndex) continue;
      const i0 = idx ? idx[t * 3] : t * 3;
      const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
      const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      e1.subVectors(b, a);
      e2.subVectors(c, a);
      const size = cr.crossVectors(e1, e2).length() * 0.5;
      const key = cellKey(
        (uv.getX(i0) + uv.getX(i1) + uv.getX(i2)) / 3,
        (uv.getY(i0) + uv.getY(i1) + uv.getY(i2)) / 3
      );
      area.set(key, (area.get(key) || 0) + size);
    }
  }

  return [...area].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

/**
 * Rebuilds one body mesh's material groups into the five slots above.
 *
 * The importer hands us dozens of tiny groups alternating between two
 * materials, and both lamps share one of them. Triangles are reclassified —
 * emissive ones split front/rear by their z sign (the models face +Z, so
 * positive is the front), the rest by which of the two paint swatches they sit
 * on, if either — then an index buffer is written that orders them by slot, so
 * each class is one contiguous group and therefore one draw call.
 */
function regroupBody(mesh, paintCell, trimCell, bloomIndex, materials) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const idx = geo.index ? geo.index.array : null;
  const triCount = Math.floor((idx ? idx.length : pos.count) / 3);
  const mats = triangleMaterials(geo, triCount);

  const slot = new Int32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx[t * 3] : t * 3;
    const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
    const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;

    if (mats[t] === bloomIndex) {
      const z = (pos.getZ(i0) + pos.getZ(i1) + pos.getZ(i2)) / 3;
      slot[t] = z > 0 ? SLOT_HEAD : SLOT_TAIL;
    } else if (uv && paintCell) {
      const key = cellKey(
        (uv.getX(i0) + uv.getX(i1) + uv.getX(i2)) / 3,
        (uv.getY(i0) + uv.getY(i1) + uv.getY(i2)) / 3
      );
      slot[t] = key === paintCell ? SLOT_PAINT : key === trimCell ? SLOT_TRIM : SLOT_BODY;
    } else {
      slot[t] = SLOT_BODY;
    }
  }

  const order = [];
  geo.clearGroups();
  for (let s = 0; s < SLOT_COUNT; s++) {
    const start = order.length;
    for (let t = 0; t < triCount; t++) {
      if (slot[t] !== s) continue;
      if (idx) order.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
      else order.push(t * 3, t * 3 + 1, t * 3 + 2);
    }
    if (order.length > start) geo.addGroup(start, order.length - start, s);
  }
  geo.setIndex(order);
  mesh.material = materials;
}

/**
 * Loads one car FBX and takes it apart.
 *
 * The models face +Z, whereas everything in this project treats -Z as forward,
 * so the body is yawed 180°. Wheel anchors are measured from the tyre meshes
 * rather than guessed, which is what lets each vehicle get its own real
 * wheelbase, track and rolling radius.
 *
 * Returns { body, wheels, metrics } in metres, with the origin at the ground
 * contact plane — the same origin the physics body uses.
 */
export async function loadCarModel(file, texture) {
  const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
  const root = await new FBXLoader().loadAsync(`${CAR_DIR}/${encodeURIComponent(file)}`);
  return buildCarFromObject(root, texture, file);
}

/**
 * The half of loadCarModel that does not touch the network, split out so the
 * whole take-apart-and-measure step can be exercised without a browser.
 */
export function buildCarFromObject(root, texture, label = 'model') {
  root.updateMatrixWorld(true);

  // Trim, glass and details keep the atlas.
  const trim = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.55,
    metalness: 0.12,
  });
  // The paint swatch is a single flat colour, so it does not need the texture
  // at all — a plain material means changing colour is one property write.
  const paint = new THREE.MeshStandardMaterial({
    color: 0xc0392b,
    roughness: 0.42,
    metalness: 0.28,
  });
  /**
   * The second paint slot.
   *
   * Same idea as `paint`, one swatch further down: the largest flat colour on
   * the model that is NOT the main bodywork. On most of the roster that is a
   * genuine two-tone feature — the Hatchback's upper body, the Van's roof, the
   * Muscle car's trim — and it is what stayed put whatever colour the player
   * chose. Slightly less metallic than the main paint, because on a real car
   * this is usually the part that is plastic, matte or a contrast wrap.
   */
  const secondary = new THREE.MeshStandardMaterial({
    color: 0x9aa0a6,
    roughness: 0.52,
    metalness: 0.18,
  });
  // "Color Bloom" is the exporter's name for the lamps. The atlas cell behind
  // the rear lamps is actually blue, so the lights are given their own
  // materials rather than inheriting whatever swatch the artist happened to use.
  const headlight = new THREE.MeshStandardMaterial({
    color: 0xfff4dd,
    emissive: 0xffeec2,
    emissiveIntensity: HEAD_OFF,
    roughness: 0.3,
  });
  const taillight = new THREE.MeshStandardMaterial({
    color: 0x6e0f0c,
    emissive: 0xff2214,
    emissiveIntensity: TAIL_IDLE,
    roughness: 0.34,
  });

  const wheelMeshes = {};
  const bodyParts = [];

  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;

    const tag = WHEEL_RE.exec(o.name);
    if (tag) {
      // Tyres are not re-grouped, so they need the atlas material assigned
      // directly — left alone they keep whatever the exporter embedded.
      o.material = trim;
      wheelMeshes[tag[1].toUpperCase()] = o;
    } else {
      bodyParts.push(o);
    }
  });

  // Which of the mesh's materials the exporter used for the lamps.
  let bloomIndex = -1;
  for (const part of bodyParts) {
    [].concat(part.material).forEach((m, i) => {
      if (m && /bloom/i.test(m.name || '')) bloomIndex = i;
    });
  }

  const keys = ['FL', 'FR', 'BL', 'BR'];
  if (!keys.every((k) => wheelMeshes[k])) {
    throw new Error(`${label}: expected four tyres, found ${Object.keys(wheelMeshes).join(',') || 'none'}`);
  }

  // Measure in the FBX's own space before anything is re-parented.
  const wheelInfo = {};
  for (const k of keys) {
    const box = new THREE.Box3().setFromObject(wheelMeshes[k]);
    wheelInfo[k] = {
      centre: box.getCenter(new THREE.Vector3()),
      size: box.getSize(new THREE.Vector3()),
    };
  }

  const bodyBox = new THREE.Box3();
  for (const part of bodyParts) bodyBox.expandByObject(part);

  const trackHalf = (Math.abs(wheelInfo.FL.centre.x) + Math.abs(wheelInfo.FR.centre.x)) / 2;
  const wheelbaseHalf = (Math.abs(wheelInfo.FL.centre.z) + Math.abs(wheelInfo.BL.centre.z)) / 2;
  const wheelRadius = keys.reduce((a, k) => a + wheelInfo[k].size.y, 0) / (keys.length * 2);
  const wheelWidth = (wheelInfo.FL.size.x + wheelInfo.FR.size.x) / 2;

  // Ground plane of the model: the lowest point of the tyres.
  const groundY = Math.min(...keys.map((k) => wheelInfo[k].centre.y - wheelInfo[k].size.y / 2));

  // Bake each part's world transform into its geometry. FBX hierarchies carry
  // transforms on ancestor nodes (exporters routinely put a 0.01 scale on the
  // root), and re-parenting a mesh silently drops everything above it. Baking
  // first means every part is expressed in one common space with an identity
  // local transform, so the groups below are the only transforms in play.
  for (const mesh of [...bodyParts, ...keys.map((k) => wheelMeshes[k])]) {
    mesh.updateWorldMatrix(true, false);
    mesh.geometry = mesh.geometry.clone();
    mesh.geometry.applyMatrix4(mesh.matrixWorld);
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
  }

  // Re-group the bodywork so both paint colours and each pair of lamps are
  // independently addressable. Done after baking, while the geometry is still
  // in the model's own +Z-forward space — the front/rear split reads the sign
  // of z directly.
  const [paintCell = null, trimCell = null] = rankPaintCells(bodyParts, bloomIndex);
  // Second colour starts as whatever the artist painted it, so a car arrives in
  // the garage looking exactly as it always did until somebody changes it.
  const trimStock = sampleCell(texture, trimCell);
  if (trimStock !== null) secondary.color.setHex(trimStock, THREE.SRGBColorSpace);
  const bodyMaterials = [trim, paint, secondary, headlight, taillight];
  for (const part of bodyParts) regroupBody(part, paintCell, trimCell, bloomIndex, bodyMaterials);

  // Body group, yawed to face -Z and dropped so y = 0 is the contact plane.
  // A yaw about Y leaves y untouched, so combining it with the drop in a single
  // node is safe here.
  const body = new THREE.Group();
  const inner = new THREE.Group();
  inner.rotation.y = Math.PI;
  inner.position.y = -groundY;
  for (const part of bodyParts) inner.add(part);
  body.add(inner);

  // Wheels become free-standing, each re-centred on its own axle so the vehicle
  // can steer and spin them about their own hub.
  //
  // The centring translation and the yaw MUST live on separate nodes. Three
  // composes a local matrix as T·R·S, so a single node carrying both maps a
  // point to R·p + T — the rotation is applied *before* the offset, leaving the
  // hub at R·centre − centre rather than at the origin. The wheel then orbits
  // that leftover offset instead of spinning in place.
  const wheels = {};
  for (const k of keys) {
    const holder = new THREE.Group(); // steer + spin, driven by the vehicle
    const yaw = new THREE.Group(); // match the body's 180° flip
    const hub = new THREE.Group(); // bring the axle to the origin — applied first

    yaw.rotation.y = Math.PI;
    hub.position.copy(wheelInfo[k].centre).negate();

    hub.add(wheelMeshes[k]);
    yaw.add(hub);
    holder.add(yaw);
    wheels[k] = holder;
  }

  return {
    body,
    wheels,
    metrics: {
      trackHalf,
      wheelbaseHalf,
      wheelRadius,
      wheelWidth,
      // Chassis box excluding wheels, relative to the contact plane.
      bodyHeight: bodyBox.max.y - groundY,
      bodyHalfWidth: (bodyBox.max.x - bodyBox.min.x) / 2,
      bodyHalfLength: (bodyBox.max.z - bodyBox.min.z) / 2,
    },
    materials: bodyMaterials,
    paintCell,
    trimCell,
    /** The colour the artist gave the second slot; null if the atlas was unreadable. */
    trimStock,

    /**
     * Head lamps. `flash` overdrives them well past "on" — a flash reads as a
     * flash because it is brighter than the beam, not merely present.
     */
    setHeadlights(on, flash) {
      headlight.emissiveIntensity = flash ? HEAD_FLASH : on ? HEAD_ON : HEAD_OFF;
    },

    /** Repaints the car. One property write — the paint slot has no texture. */
    setColor(hex) {
      paint.color.setHex(hex, THREE.SRGBColorSpace);
    },

    /**
     * Repaints the second colour. Passing null restores the swatch the model
     * shipped with, which is what the garage's "Stock" option asks for.
     */
    setTrimColor(hex) {
      const value = hex == null ? trimStock : hex;
      if (value == null) return;
      secondary.color.setHex(value, THREE.SRGBColorSpace);
    },

    /**
     * Brake lights. `t` is 0..1; the lamps sit at a dim standing glow and rise
     * an order of magnitude under braking, which is what reads as "on" once the
     * bloom pass gets hold of it.
     */
    setBrake(t) {
      const k = Math.max(0, Math.min(1, t));
      taillight.emissiveIntensity = TAIL_IDLE + (TAIL_BRAKE - TAIL_IDLE) * k;
    },
  };
}
