/**
 * main.js — boot sequence and the frame loop.
 *
 * Timing model: rendering runs on requestAnimationFrame, physics on a fixed
 * 120 Hz accumulator. The vehicle's suspension and tyre impulses are integrated
 * *inside* the substep loop, immediately before each world.step(), which is the
 * only way a hand-written raycast vehicle stays stable — feeding it a variable
 * frame delta makes spring damping frame-rate dependent and it will oscillate.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

import { WORLD, CHUNK, ROAD, VEHICLE, ATMOSPHERE, TRAFFIC } from './config.js';
import { loadFoliage, loadCarTexture, loadCarModel } from './assets.js';
import { foliageModelNames } from './foliage.js';
import { CARS, CAR_COLORS, ENGINE_OPTIONS, DEFAULT_CAR, carById, colorById, buildCarParams } from './cars.js';
import { lerp, smoothstep } from './util.js';
import { createTerrain } from './noise.js';
import { RoadPath } from './path.js';
import { ChunkManager } from './chunks.js';
import { Traffic } from './traffic.js';
import { RaycastVehicle } from './vehicle.js';
import { ChaseCamera } from './camera.js';
import { Powertrain } from './powertrain.js';
import { Input } from './input.js';
import { HUD } from './hud.js';
import { createScene } from './scene.js';
import { Settings } from './settings.js';

/**
 * The body origin now *is* the contact plane (see cars.buildCarParams), so a
 * car dropped with its origin on the terrain settles to exactly its static sag.
 * A couple of centimetres of clearance keeps it from starting interpenetrated.
 */
const SPAWN_HEIGHT = 0.03;

/** Start a little way in: the spline (and therefore terrain) begins at s = 0. */
const START_S = 90;

const IDLE_INPUT = { steer: 0, throttle: 0, brake: 0, handbrake: false };

export async function boot() {
  const bootEl = document.getElementById('boot');
  const startBtn = document.getElementById('start');
  const overlay = document.getElementById('overlay');

  bootEl.textContent = 'loading rapier wasm…';
  await RAPIER.init();

  bootEl.textContent = 'building scene…';
  const gfx = await createScene(document.getElementById('app'));

  const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });
  world.timestep = WORLD.fixedStep;

  bootEl.textContent = 'plotting road…';
  // A seed in the URL wins, so a world can be shared as a link.
  const urlSeed = new URLSearchParams(location.search).get('seed');
  const startSeed = urlSeed || WORLD.seed;
  const terrain = createTerrain(startSeed);
  const path = new RoadPath(terrain, startSeed);

  // ---- art -----------------------------------------------------------------
  const names = foliageModelNames();
  bootEl.textContent = `loading foliage 0/${names.length}…`;
  const [foliage, carTexture] = await Promise.all([
    loadFoliage(names, (done, total) => {
      bootEl.textContent = `loading foliage ${done}/${total}…`;
    }),
    loadCarTexture(),
  ]);

  bootEl.textContent = 'loading vehicles…';
  // All models up front — under a megabyte in total, and it means switching
  // cars in the menu is instant rather than a stall on every click.
  const models = new Map();
  await Promise.all(
    CARS.map(async (spec) => {
      try {
        models.set(spec.id, await loadCarModel(spec.file, carTexture));
      } catch (err) {
        console.warn(`[fastroads] car "${spec.id}" unavailable:`, err.message);
      }
    })
  );
  const roster = CARS.filter((c) => models.has(c.id));
  if (!roster.length) throw new Error('no car models could be loaded');

  const chunks = new ChunkManager({ scene: gfx.scene, world, RAPIER, path, terrain, foliage });

  bootEl.textContent = 'carving terrain…';
  chunks.preload(START_S);

  // Rapier only refreshes its query pipeline inside step(), so ray casts
  // against freshly created colliders return null until one has run.
  world.step();

  const game = new Game({ gfx, world, path, chunks, models, roster });
  game.seed = startSeed;
  game.traffic = new Traffic({
    scene: gfx.scene, world, RAPIER, path, chunks, models, roster,
  });
  game.setCar(roster.some((c) => c.id === DEFAULT_CAR) ? DEFAULT_CAR : roster[0].id);

  // Run the loop straight away, with controls inert. The scene behind the
  // overlay compiles its shaders and settles the suspension before the player
  // ever sees it, so there's no hitch on the first real frame.
  game.loop(performance.now());

  buildGarage(game, roster);
  buildSeedBox(game);

  bootEl.textContent = `${foliage.size} plants · ${roster.length} vehicles`;
  startBtn.disabled = false;
  startBtn.textContent = 'Drive';

  const begin = async () => {
    startBtn.removeEventListener('click', begin);
    await game.powertrain.start(game.car());
    overlay.classList.add('gone');
    game.hud.show();
    game.settings = new Settings(game);
    game.active = true;
    setTimeout(() => overlay.remove(), 900);
  };
  startBtn.addEventListener('click', begin);

  window.__fastroads = game;
  return game;
}

/**
 * Seed entry. Changing the seed is a full world rebuild, so it simply reloads
 * with the seed in the query string: the alternative is tearing down and
 * rethreading the terrain, path, chunk manager and physics world while a car is
 * sitting on them, for a control that is used once before you start driving.
 */
function buildSeedBox(game) {
  const input = document.getElementById('seed-input');
  const apply = document.getElementById('seed-apply');
  const random = document.getElementById('seed-random');
  if (!input) return;

  input.value = game.seed;
  const go = (value) => {
    const seed = String(value || '').trim();
    if (!seed) return;
    const url = new URL(location.href);
    url.searchParams.set('seed', seed);
    location.href = url.toString();
  };

  apply.addEventListener('click', () => go(input.value));
  random.addEventListener('click', () => {
    input.value = Math.random().toString(36).slice(2, 10);
    go(input.value);
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') go(input.value);
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());
}

/** Builds the car picker on the title screen. */
function buildGarage(game, roster) {
  const garage = document.getElementById('garage');
  const list = document.getElementById('car-list');
  const detail = document.getElementById('car-detail');
  const chips = new Map();

  const refreshDetail = () => {
    const spec = carById(game.carId);
    const drive = { fwd: 'front-wheel drive', rwd: 'rear-wheel drive', awd: 'all-wheel drive' }[spec.drive];
    const eng = game.powertrain.sim ? game.powertrain.sim.profile : null;
    const engName = eng ? eng.label : ENGINE_OPTIONS.find((e) => e.id === game.engineChoice).name;
    const stock = game.engineChoice === 'stock';
    detail.innerHTML =
      `<b>${spec.name}</b> — ${spec.blurb}` +
      `<div id="car-stats">` +
      `<span>Mass<b>${spec.mass} kg</b></span>` +
      `<span>Engine<b>${engName}</b></span>` +
      `<span>Layout<b>${spec.drive.toUpperCase()}</b></span>` +
      (eng ? `<span>Redline<b>${eng.redlineRpm}</b></span>` : '') +
      `</div>` +
      `<div style="margin-top:6px;opacity:.6">${drive}${stock ? '' : ' · engine swapped'}</div>`;
  };

  const select = (id) => {
    game.setCar(id);
    for (const [cid, chip] of chips) chip.setAttribute('aria-pressed', String(cid === id));
    refreshDetail();
  };

  for (const spec of roster) {
    const chip = document.createElement('button');
    chip.className = 'car-chip';
    chip.type = 'button';
    chip.textContent = spec.name;
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => select(spec.id));
    list.appendChild(chip);
    chips.set(spec.id, chip);
  }

  // ---- paint ------------------------------------------------------------
  const colorList = document.getElementById('color-list');
  const swatches = new Map();
  const pickColor = (id) => {
    game.setColor(id);
    for (const [cid, el] of swatches) el.setAttribute('aria-pressed', String(cid === id));
  };
  for (const c of CAR_COLORS) {
    const el = document.createElement('button');
    el.className = 'swatch';
    el.type = 'button';
    el.title = c.name;
    el.style.background = '#' + c.hex.toString(16).padStart(6, '0');
    el.setAttribute('aria-pressed', 'false');
    el.addEventListener('click', () => pickColor(c.id));
    colorList.appendChild(el);
    swatches.set(c.id, el);
  }

  // ---- engine -----------------------------------------------------------
  const engineList = document.getElementById('engine-list');
  const engineChips = new Map();
  const pickEngine = (id) => {
    game.setEngine(id);
    for (const [eid, el] of engineChips) el.setAttribute('aria-pressed', String(eid === id));
    refreshDetail();
  };
  for (const e of ENGINE_OPTIONS) {
    const el = document.createElement('button');
    el.className = 'eng-chip';
    el.type = 'button';
    el.textContent = e.name;
    el.setAttribute('aria-pressed', String(e.id === 'stock'));
    el.addEventListener('click', () => pickEngine(e.id));
    engineList.appendChild(el);
    engineChips.set(e.id, el);
  }

  garage.classList.add('ready');
  select(game.carId);
  pickColor(game.colorId);
}

/* ------------------------------------------------------------------------- */

class Game {
  constructor({ gfx, world, path, chunks, models, roster }) {
    this.gfx = gfx;
    this.world = world;
    this.path = path;
    this.chunks = chunks;
    this.models = models;
    this.roster = roster;
    this.vehicle = null;
    this.carId = null;
    this.settings = null;
    this.traffic = null;
    this.headlights = false;
    this.flashing = false;
    this.colorId = null;
    this.engineChoice = 'stock';

    this.input = new Input();
    this.hud = new HUD();
    this.powertrain = new Powertrain();
    this.cam = new ChaseCamera(gfx.camera);

    this.active = false;
    this.accumulator = 0;
    this.lastTime = performance.now();

    /** Arc length of the vehicle along the spline — drives chunk streaming. */
    this.carS = START_S;
    this.trip = 0;

    this._tmp = new THREE.Vector3();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.powertrain.suspend();
        // Drop the accumulator: coming back from a backgrounded tab with two
        // minutes of pending physics would fling the car into orbit.
        this.accumulator = 0;
        this.lastTime = performance.now();
      } else if (this.active) {
        this.powertrain.resume();
      }
    });

    this.loop = this.loop.bind(this);
  }

  /**
   * Builds (or rebuilds) the vehicle for a roster entry. Geometry comes from
   * the model, rates are derived from mass, and the old body is removed from
   * the physics world so switching cars in the menu doesn't accumulate wrecks.
   */
  setCar(id) {
    if (id === this.carId) return;
    const spec = carById(id);
    const model = this.models.get(spec.id);
    if (!model) return;

    if (this.vehicle) this.vehicle.dispose();

    const params = buildCarParams(spec, model.metrics, VEHICLE, Math.abs(WORLD.gravity));
    this.vehicle = new RaycastVehicle({
      RAPIER,
      world: this.world,
      scene: this.gfx.scene,
      params,
      model,
    });
    this.carId = spec.id;
    // A car the player has never coloured takes its own default; once they
    // choose, that choice follows them from car to car.
    if (!this.colorId) this.colorId = spec.defaultColor || CAR_COLORS[0].id;
    this.setColor(this.colorId);
    this.powertrain.setCar(this.car());
    this.respawn(this.carS);
  }

  setColor(id) {
    this.colorId = id;
    if (this.vehicle) this.vehicle.setColor(colorById(id).hex);
  }

  setEngine(id) {
    this.engineChoice = id;
    return this.powertrain.setEngine(id);
  }

  /** The current car as the powertrain wants it: spec plus derived params. */
  car() {
    return { spec: carById(this.carId), V: this.vehicle.V };
  }

  // -------------------------------------------------------------- respawn --

  respawn(atS = this.carS) {
    // Never behind the start of the spline — there is no terrain back there.
    const s = Math.max(START_S, atS);
    this.path.ensureLength(s + CHUNK.length * 2);
    this.chunks.update(s, 6); // make sure there is ground under the spawn

    const frame = this.path.frameAt(s);
    // Sit in the inner forward lane rather than astride the centre line.
    const ground = this.chunks.groundAt(s, ROAD.laneWidth * 0.5, this._tmp);
    ground.y += SPAWN_HEIGHT;

    this.vehicle.respawn(ground, frame.tan);
    this.carS = s;
  }

  // ----------------------------------------------------------------- loop --

  loop(now) {
    requestAnimationFrame(this.loop);

    // Clamp: a long frame must not be simulated in one bite.
    const dt = Math.min((now - this.lastTime) / 1000, 0.05);
    this.lastTime = now;

    this.input.update(dt);
    if (this.active) this._handleActions();

    const control = this.active ? this.input : IDLE_INPUT;

    // ---- powertrain ------------------------------------------------------
    // One simulator step per frame. It sub-steps its driveline internally at
    // 0.5 ms, so the coarser frame rate here costs nothing; the force it
    // returns is then held constant across the physics substeps below.
    const reverse = this.vehicle.reverse;
    const pedals = reverse
      ? { throttle: control.brake, brake: control.throttle }
      : { throttle: control.throttle, brake: control.brake };

    // How far off the asphalt the car is, for surface drag and grip.
    {
      const lat = Math.abs(this.path.lateralOffset(this.vehicle.pos, this.carS));
      this.vehicle.setSurface(smoothstep(ROAD.halfWidth * 0.9, ROAD.halfWidth + 2.2, lat));
    }

    // Brake lights follow the pedal, not the gear — they come on in reverse too.
    this.vehicle.setBrakeLight(this.active ? control.brake : 0);
    this.flashing = this.active && this.input.held('KeyF');
    this.vehicle.setHeadlights(this.headlights, this.flashing);

    this.vehicle.setDriveForce(
      this.powertrain.update(dt, {
        wheelSpeed: this.vehicle.forwardSpeed,
        throttle: pedals.throttle,
        brake: pedals.brake,
        reverse,
      })
    );

    // ---- fixed-step physics ---------------------------------------------
    const h = WORLD.fixedStep;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= h && steps < WORLD.maxSubSteps) {
      this.vehicle.beginStep();
      this.vehicle.update(h, control);
      this.world.step();
      this.accumulator -= h;
      steps++;
    }
    // If we hit the substep ceiling we are behind. Clamp rather than zero the
    // debt: zeroing throws away the sub-step remainder that the interpolator
    // needs, which shows up as a hitch precisely when frames are already late.
    if (this.accumulator > h) this.accumulator = h * 0.999;

    // Draw where the car actually is *between* steps, not at the last one.
    this.vehicle.syncVisuals(this.accumulator / h);

    // ---- world streaming -------------------------------------------------
    this.carS = this.path.projectPoint(this.vehicle.pos, this.carS);
    this.chunks.update(this.carS);

    if (this.active && this.traffic) {
      this.traffic.update(dt, {
        s: this.carS,
        v: this.path.lateralOffset(this.vehicle.pos, this.carS),
        speed: Math.abs(this.vehicle.forwardSpeed),
        flashing: this.flashing,
      });
    }

    if (this.active) this.trip += this.vehicle.speed * dt;
    this._checkRecovery(dt);

    // ---- presentation ----------------------------------------------------
    // Camera first: follow() re-centres the sky dome on the camera, so it must
    // see this frame's position, not last frame's.
    this.cam.update(dt, this.vehicle);
    this.gfx.follow(this.vehicle.pos, dt);
    // The sharp zone extends with speed, so the road stays readable when it matters.
    this.gfx.setFocus(
      lerp(ATMOSPHERE.dofFocusNear, ATMOSPHERE.dofFocusFar,
           smoothstep(0, 60, Math.abs(this.vehicle.forwardSpeed)))
    );

    if (this.active) {
      this.hud.update(dt, {
        speedKmh: Math.abs(this.vehicle.forwardSpeed) * 3.6,
        rpm: this.powertrain.rpm,
        maxRpm: this.powertrain.maxRpm,
        gear: this.powertrain.gearLabel(),
        autoShift: this.powertrain.autoShift,
        tripMeters: this.trip,
        altitude: this.vehicle.pos.y,
        chunks: this.chunks.chunks.size,
      });
    }

    this.gfx.render();

    // Anything that did not consume its one-shot press this frame loses it.
    this.input.endFrame();
  }

  _handleActions() {
    if (this.input.consume('KeyR')) {
      this.respawn();
      this.hud.toast('respawned');
    }
    if (this.input.consume('KeyC')) {
      const mode = this.cam.cycle();
      this.hud.toast(mode + ' camera');
      if (this.settings && this.settings.camBtn) {
        this.settings.camBtn.textContent = 'Camera: ' + mode;
      }
    }
    if (this.input.consume('KeyM')) {
      this.hud.toast(this.powertrain.toggleMute() ? 'audio muted' : 'audio on');
    }

    // ---- gearbox ---------------------------------------------------------
    if (this.input.consume('KeyE')) {
      if (this.powertrain.autoShift) this.setAutoShift(false);
      else if (!this.powertrain.shiftUp()) this.hud.toast('already top gear');
    }
    if (this.input.consume('KeyQ')) {
      // Asking for a lower gear implies wanting control of the gearbox.
      if (this.powertrain.autoShift) this.setAutoShift(false);
      else if (!this.powertrain.shiftDown()) this.hud.toast('would over-rev');
    }
    if (this.input.consume('KeyG')) this.setAutoShift(!this.powertrain.autoShift);
    if (this.input.consume('KeyL')) {
      this.headlights = !this.headlights;
      this.hud.toast(this.headlights ? 'headlights on' : 'headlights off');
    }
  }

  setAutoShift(on) {
    const v = this.powertrain.setAutoShift(on);
    this.hud.toast(v ? 'automatic' : 'manual');
    if (this.settings) this.settings.refresh();
    return v;
  }

  /**
   * Puts the player back on the road after a genuine failure: flipped and
   * stuck, off the edge of the generated corridor, or fallen out of the world.
   */
  _checkRecovery(dt) {
    if (!this.active) return;
    const v = this.vehicle;

    const lateral = Math.abs(this.path.lateralOffset(v.pos, this.carS));
    const groundY = this.chunks.groundAt(this.carS, 0, this._tmp).y;

    // Beached: full throttle, no progress. Happens when the car ends up on a
    // cut face too steep to climb, where nothing else in this check fires — it
    // is upright, on the ground, and well inside the corridor.
    if (this.input.throttle > 0.5 && v.speed < 1.2 && v.groundedCount > 0) {
      this.stuckFor = (this.stuckFor || 0) + dt;
    } else {
      this.stuckFor = 0;
    }

    const flipped = v.upsideDownFor > 2.5;
    const stuck = this.stuckFor > 4;
    const offWorld = lateral > CHUNK.recoverLateral || v.pos.y < groundY - 90;

    if (flipped || offWorld || stuck) {
      this.respawn(this.carS - 12);
      this.stuckFor = 0;
      this.hud.toast(flipped ? 'recovered' : stuck ? 'unstuck' : 'back on road');
    }
  }
}
