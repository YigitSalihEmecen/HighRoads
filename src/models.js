/**
 * models.js — the bridge to car_gen.
 *
 * Nothing visible is loaded: every car — the player's, the garage's and each
 * one in traffic — is generated from numbers by the car_gen submodule. Its
 * `createCar` returns the shape vehicle.js was written against (body, wheel
 * holders FL/FR/BL/BR, metrics, lamp and paint setters), in the game's frame.
 *
 * A BUILD is the garage's unit of work (see cars.js): generator parameters plus
 * paint, engine, drive and gearbox. `Fleet` keeps a pool of distinct traffic
 * cars, built during loading and refreshed while nobody is driving, so the road
 * never repeats itself and nothing is generated mid-run.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createCar, randomParams, PRESETS, sanitize, clone, OPTIONS } from '../car_gen/src/index.js';
import { CAR_COLORS, BODY_STYLES, carName, bodyShape, characterOf, deriveSpec, roadColour } from './cars.js';
import { mulberry32, hashString } from './util.js';

/** Triangles vs smoothness per use; car_gen's own scale (0 ≈ 10k tris, 1 ≈ 75k). */
export const DETAIL = { player: 0.5, garage: 0.72, traffic: 0.12 };

/** Discrete parameters: picked from one parent, never averaged. */
const DISCRETE = new Set([...Object.keys(OPTIONS), 'spokes', 'contrastRoof', 'color', 'pillars']);

/** Numeric fields lerp, same-length arrays recurse, anything else keeps `a`'s. */
function blend(a, b, t, rng, discreteFromB) {
  const out = Array.isArray(a) ? [] : {};
  for (const k of Object.keys(a)) {
    const x = a[k], y = b[k];
    if (DISCRETE.has(k)) out[k] = rng() < discreteFromB ? clone(y ?? x) : clone(x);
    else if (typeof x === 'number' && typeof y === 'number') out[k] = x + (y - x) * t;
    else if (Array.isArray(x) && Array.isArray(y) && x.length === y.length) out[k] = blend(x, y, t, rng, discreteFromB);
    else if (x && typeof x === 'object' && y && typeof y === 'object') out[k] = blend(x, y, t, rng, discreteFromB);
    else out[k] = clone(x);
  }
  return out;
}

/** A fresh seed string: short enough to read, share and type. */
export function newSeed() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

/**
 * Generator parameters for a seed. With a style, the preset is the parent and
 * a free random car pulls it up to a quarter of the way — recognisably a saloon, but
 * never the same saloon twice. Without one, car_gen's free generation.
 */
export function generateParams(seed, style = null) {
  if (!style || !PRESETS[style]) return randomParams(seed);
  const rng = mulberry32(hashString(String(seed)) ^ 0x2545f491);
  const wild = randomParams(seed);
  const P = blend(PRESETS[style], wild, 0.1 + rng() * 0.14, rng, 0.55);
  return sanitize(P);
}

/** A complete build for a seed. Paint comes from the garage chips, not the generator's random hue. */
export function generateBuild(seed = newSeed(), style = null) {
  const params = generateParams(seed, style);
  const rng = mulberry32(hashString(String(seed)) ^ 0x7f4a7c15);
  const colour = CAR_COLORS[Math.floor(rng() * CAR_COLORS.length)].hex;
  params.color = colour;
  return finishBuild({ seed: String(seed), style, params, color: colour, trim: null });
}

/** Small random variation of an existing build — same family, new seed. */
export function mutateBuild(build, amount = 0.2) {
  const seed = newSeed();
  const rng = mulberry32(hashString(seed));
  const params = sanitize(blend(build.params, generateParams(seed, build.style), amount, rng, amount * 0.6));
  params.color = build.color;
  return finishBuild({ ...build, seed, params, name: undefined });
}

/** Names a build from its shape: a make and a model with a trim to suit. */
export function finishBuild(build) {
  const b = {
    engine: 'stock', drive: 'stock', gearbox: 'stock',
    ...build,
    params: sanitize(clone(build.params)),
  };
  if (!b.name) {
    // Shape without a mesh: bodyHeight is the profile's highest point.
    const roof = Math.max(...b.params.profile.map((p) => p[1]));
    const n = carName(b.seed, characterOf(bodyShape(b.params, { bodyHeight: roof })));
    b.name = `${n.make} ${n.model}`;
  }
  return b;
}

/** The demo build for each style, for probes and first boot. */
export function presetBuild(style) {
  const params = sanitize(clone(PRESETS[style]));
  return finishBuild({ seed: style, style, params, color: params.color, trim: null, name: style });
}

/** One car per body style, built from the presets — what the probes drive. */
export function styleRoster(detail = 0) {
  return BODY_STYLES.map(({ id }) => {
    const build = presetBuild(id);
    const model = buildModel(build, detail);
    return { id, build, model, spec: deriveSpec(build, model.metrics) };
  });
}

/**
 * The drawable car for a build. Owns its materials, so it can be painted and
 * braked on its own; `dispose()` frees it.
 */
export function buildModel(build, detail = DETAIL.player) {
  const model = createCar(build.params, { detail });
  model.setColor(build.color || build.params.color);
  model.setTrimColor(build.trim || null);
  matte(model);
  finish(model, build.params);
  // car_gen leaves camber to the host, which owns each holder's rotation: a
  // tilt about the car's length per wheel (FL, FR, BL, BR; negative = tops in),
  // and the hub lift that keeps the low tyre shoulder on the ground.
  const P = model.params, cam = ((P.camber || 0) * Math.PI) / 180;
  model.camber = {
    tilt: [cam, -cam, cam, -cam],
    lift: P.wheelR * (Math.cos(cam) - 1) + (P.tireW / 2) * Math.abs(Math.sin(cam)),
  };
  return model;
}

/** Copies a build's paint and finish onto a model without rebuilding geometry. */
export function paintModel(model, build) {
  model.setColor(build.color);
  model.setTrimColor(build.trim || null);
  finish(model, build.params);
}

/**
 * The world is matte (terrain, rocks and trees sit at roughness ~0.9, no
 * metal), and a mirror-lacquered car in it reads as the only toy on the table.
 * Every car material is held to a satin range: enough to catch the baked sky.
 */
function matte(model) {
  const seen = new Set();
  const dull = (m) => {
    if (seen.has(m)) return;
    seen.add(m);
    if (m.isMeshPhysicalMaterial) {
      m.clearcoat = Math.min(m.clearcoat, 0.45);
      m.clearcoatRoughness = Math.max(m.clearcoatRoughness, 0.22);
    }
    if (m.isMeshStandardMaterial) {
      m.roughness = Math.max(m.roughness, 0.4);
      m.metalness = Math.min(m.metalness, 0.4);
    }
  };
  // The material set covers parts swapped in later (the contrast roof).
  const walk = (v) => {
    if (v?.isMaterial) dull(v);
    else if (v && typeof v === 'object' && !v.isTexture && !v.isVector4) for (const k in v) if (k !== 'U') walk(v[k]);
  };
  walk(model.materials);
  const visit = (o) => { for (const m of [].concat(o.material || [])) dull(m); };
  model.body.traverse(visit);
  for (const k in model.wheels) model.wheels[k].traverse(visit);
}

/** The build's finish, squeezed into the matte range: Gloss is a satin sheen. */
function finish(model, P) {
  const paint = model.materials?.paint;
  if (!paint) return;
  paint.clearcoat = 0.4 * (1 - P.rough);
  paint.clearcoatRoughness = 0.22;
  paint.metalness = P.metal * 0.5;
  paint.roughness = 0.4 + 0.5 * P.rough;
}

/** The mesh `setTrimColor` re-materials (the cabin roof), found by trying it; null if none. */
function findRoof(model) {
  const M = model.materials;
  const before = new Map();
  model.body.traverse((o) => { if (o.isMesh) before.set(o, o.material); });
  const trim = M.trim.color.clone(), contrast = model.params.contrastRoof;
  model.setTrimColor(0);
  let roof = null;
  model.body.traverse((o) => { if (o.isMesh && o.material === M.trim) roof = o; });
  if (roof) roof.material = before.get(roof);
  M.trim.color.copy(trim);
  model.params.contrastRoof = contrast;
  return roof;
}

/**
 * One mesh per material instead of one per part, for a car that will not be
 * edited again (the driven one, traffic): ~35 body parts share ~18 materials,
 * and each part was a draw call in the main pass and another in the shadow
 * pass. car_gen adds every part to one group untransformed, so the paint
 * shader's object-space masks see the same positions. The roof stays apart:
 * `setTrimColor` swaps its material.
 */
export function mergeParts(model) {
  const inner = model.body.children[0];
  const roof = findRoof(model);
  const groups = new Map();
  for (const o of inner.children) {
    if (!o.isMesh || !o.visible || o === roof || !o.matrix.equals(IDENTITY) || !o.geometry.index) continue;
    const attrs = Object.entries(o.geometry.attributes).map(([k, a]) => `${k}${a.itemSize}`).sort().join();
    const key = `${o.material.uuid}|${attrs}|${o.renderOrder}|${o.castShadow}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  const made = [];
  for (const parts of groups.values()) {
    if (parts.length < 2) continue;
    const geometry = mergeGeometries(parts.map((o) => o.geometry));
    if (!geometry) continue;
    const [first] = parts;
    const mesh = new THREE.Mesh(geometry, first.material);
    mesh.castShadow = first.castShadow;
    mesh.receiveShadow = first.receiveShadow;
    mesh.renderOrder = first.renderOrder;
    for (const o of parts) inner.remove(o);
    inner.add(mesh);
    made.push(geometry);
  }
  const dispose = model.dispose;
  model.dispose = () => { dispose(); for (const g of made) g.dispose(); };
  return model;
}

const IDENTITY = new THREE.Matrix4();

/* ----------------------------------------------------------------- fleet -- */

/** Every far traffic car shares one program and one material. */
const PROXY_MATERIAL = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.15 });
const GLASS_TINT = new THREE.Color(0x161c22);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _n = new THREE.Matrix3();

/**
 * A traffic car past `TRAFFIC.lodDistance`: body and wheels at rest, merged
 * into ONE mesh coloured per vertex from each part's material — one draw call
 * instead of ~60 (×2 with the shadow pass). Paint is re-coloured on `paint()`;
 * see-through parts other than the glass are left out.
 */
function buildProxy(model) {
  const M = model.materials;
  const roof = findRoof(model);

  const geos = [], paint = [], roofRange = [0, 0];
  let verts = 0;
  const add = (mesh, matrix) => {
    const m = mesh.material;
    const glass = m === M.glass;
    if (m.transparent && !glass) return;
    const src = mesh.geometry;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', src.attributes.position.clone());
    if (src.attributes.normal) g.setAttribute('normal', src.attributes.normal.clone());
    g.setIndex(src.index ? src.index.clone() : null);
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
    if (!g.attributes.normal) g.computeVertexNormals();
    g.applyMatrix4(matrix);
    const n = g.attributes.position.count;
    const c = glass ? GLASS_TINT : m.color || GLASS_TINT;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (mesh === roof) { roofRange[0] = verts; roofRange[1] = verts + n; } else if (m === M.paint) paint.push([verts, verts + n]);
    verts += n;
    geos.push(g);
  };

  model.body.updateMatrixWorld(true);
  model.body.traverse((o) => { if (o.isMesh && o.visible) add(o, o.matrixWorld); });
  const { trackHalf: tr, wheelbaseHalf: wb, wheelRadius: r } = model.metrics;
  const layout = [[-tr, -wb], [tr, -wb], [-tr, wb], [tr, wb]];
  ['FL', 'FR', 'BL', 'BR'].forEach((k, i) => {
    const w = model.wheels[k];
    const keep = [w.position.clone(), w.rotation.clone()];
    w.position.set(layout[i][0], r + model.camber.lift, layout[i][1]);
    w.rotation.set(0, 0, model.camber.tilt[i], 'YZX');
    w.updateMatrixWorld(true);
    w.traverse((o) => { if (o.isMesh && o.visible) add(o, o.matrixWorld); });
    w.position.copy(keep[0]); w.rotation.copy(keep[1]);
    w.updateMatrixWorld(true);
  });

  const geometry = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  const mesh = new THREE.Mesh(geometry, PROXY_MATERIAL);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.visible = false;
  const colour = geometry.attributes.color;
  const fill = ([a, b], c) => { for (let i = a; i < b; i++) colour.setXYZ(i, c.r, c.g, c.b); };
  return {
    mesh,
    /** Matches the proxy to the model's current paint and roof. */
    paint() {
      for (const range of paint) fill(range, M.paint.color);
      fill(roofRange, roof && roof.material === M.trim ? M.trim.color : M.paint.color);
      colour.needsUpdate = true;
    },
    dispose() { geometry.dispose(); },
  };
}

/** Road traffic is mostly ordinary cars. Weights per style; `null` is free generation. */
const TRAFFIC_MIX = [
  ['sedan', 18], ['hatch', 18], ['suv', 15], ['wagon', 10], ['coupe', 6], ['muscle', 4],
  ['offroad', 5], ['rally', 3], ['supercar', 3], ['wedge', 1], [null, 8],
];

function pickStyle(rng) {
  const total = TRAFFIC_MIX.reduce((a, [, w]) => a + w, 0);
  let x = rng() * total;
  for (const [s, w] of TRAFFIC_MIX) if ((x -= w) <= 0) return s;
  return 'sedan';
}

export class Fleet {
  /**
   * @param {string} seed  the world seed, so a shared world shares its traffic
   * @param {number} size  distinct cars kept; more than ever share the road at once
   */
  constructor(seed = '', size = 18) {
    this.size = size;
    this.rng = mulberry32(hashString('fleet:' + seed));
    this.free = [];
    this.busy = new Set();
    this._n = 0;
  }

  get count() {
    return this.free.length + this.busy.size;
  }

  /** Builds one car (≈40–60 ms). */
  buildOne() {
    const seed = `T${this._n++}-${Math.floor(this.rng() * 1e9).toString(36)}`;
    const build = generateBuild(seed, pickStyle(this.rng));
    const model = buildModel(build, DETAIL.traffic);
    const spec = deriveSpec(build, model.metrics);
    const proxy = buildProxy(model);
    mergeParts(model);
    const entry = { seed, build, model, proxy, mass: spec.mass, name: build.name };
    this.free.push(entry);
    return entry;
  }

  /** Fills the pool one car per frame so a loading bar can move. */
  async fill(onProgress) {
    while (this.count < this.size) {
      this.buildOne();
      if (onProgress) onProgress(this.count / this.size);
      await new Promise((r) => requestAnimationFrame(() => r()));
    }
  }

  /** Swaps the oldest parked car for a new design. Call only when a hitch cannot be seen. */
  refreshOne() {
    if (!this.free.length) return false;
    const old = this.free.shift();
    old.model.dispose();
    old.proxy.dispose();
    this.buildOne();
    return true;
  }

  /** A parked car, freshly painted from the road palette; null if every car is out. */
  acquire(rng = this.rng) {
    if (!this.free.length) return null;
    const i = Math.floor(rng() * this.free.length);
    const entry = this.free.splice(i, 1)[0];
    this.busy.add(entry);
    entry.model.setColor(roadColour(rng));
    entry.model.setTrimColor(rng() < 0.12 ? roadColour(rng) : null);
    entry.model.setBrake(0);
    entry.model.setHeadlights(false, false);
    entry.proxy.paint();
    return entry;
  }

  release(entry) {
    if (!this.busy.delete(entry)) return;
    this.free.push(entry);
  }
}

