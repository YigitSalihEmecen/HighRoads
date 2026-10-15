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
  const M = model.materials;
  if (M && M.paint) {
    M.paint.metalness = build.params.metal;
    M.paint.roughness = build.params.rough;
  }
}

/* ----------------------------------------------------------------- fleet -- */

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
    const entry = { seed, build, model, mass: spec.mass, name: build.name };
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
    return entry;
  }

  release(entry) {
    if (!this.busy.delete(entry)) return;
    this.free.push(entry);
  }
}

