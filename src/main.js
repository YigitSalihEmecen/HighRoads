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

import { WORLD, CHUNK, ROAD, VEHICLE, ATMOSPHERE } from './config.js';
import { loadFoliage, loadCarTexture, loadCarModel } from './assets.js';
import { foliageModelNames } from './foliage.js';
import {
  CARS, CAR_COLORS, CAR_TRIM_COLORS, ENGINE_OPTIONS, DEFAULT_CAR, DEFAULT_TRIM,
  carById, colorById, trimColorById, buildCarParams
} from './cars.js';
import { smoothstep } from './util.js';
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
import { Wind } from './wind.js';
import { TyreFX } from './fx.js';
import { Settings } from './settings.js';
import { ScoreRun } from './score.js';
import { drawTerrainMap } from './terrain-preview.js';

/**
 * The two ways to play. Zen is the original brief — an empty road, going
 * nowhere in particular. Traffic turns the same road into a game: the cars are
 * the obstacle and the reward at once, since the points are for threading past
 * them, and the run ends the moment you actually hit one.
 */
const GAME_MODES = [
  { id: 'traffic', name: 'Traffic', blurb: 'Points for near misses. One crash ends the run.' },
  { id: 'zen', name: 'Zen', blurb: 'Empty road, no traffic, no way to lose.' },
];

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
        console.warn(`[highroads] car "${spec.id}" unavailable:`, err.message);
      }
    })
  );
  const roster = CARS.filter((c) => models.has(c.id));
  if (!roster.length) throw new Error('no car models could be loaded');

  const chunks = new ChunkManager({
    scene: gfx.scene, world, RAPIER, path, terrain, foliage,
    // Grass cards are seen at a very grazing angle down the verge, which is the
    // one case anisotropic filtering exists for.
    anisotropy: gfx.renderer.capabilities.getMaxAnisotropy(),
  });

  bootEl.textContent = 'carving terrain…';
  chunks.preload(START_S);

  // Rapier only refreshes its query pipeline inside step(), so ray casts
  // against freshly created colliders return null until one has run.
  world.step();

  const game = new Game({ gfx, world, path, terrain, chunks, models, roster });
  game.seed = startSeed;
  game.input.bindTouch(document);
  // No world, no RAPIER: traffic owns no physics objects at all. See traffic.js.
  game.traffic = new Traffic({ scene: gfx.scene, path, chunks, models, roster });
  game.setCar(roster.some((c) => c.id === DEFAULT_CAR) ? DEFAULT_CAR : roster[0].id);

  // Run the loop straight away, with controls inert. The scene behind the
  // overlay compiles its shaders and settles the suspension before the player
  // ever sees it, so there's no hitch on the first real frame.
  game.loop(performance.now());

  // The settings panel is built once, here, and re-parented between the title
  // screen's Settings drawer and the pause menu — see `Game.setPaused`. It used
  // to be constructed on the first Drive, which meant its values did not exist
  // until then and nothing on the title screen could show them.
  game.settings = new Settings(game);

  buildGarage(game, roster);
  buildSeedBox(game);
  buildDrawers(game);
  buildPauseMenu(game);

  bootEl.textContent = `${foliage.size} plants · ${roster.length} vehicles`;
  startBtn.disabled = false;
  startBtn.textContent = 'Drive';

  game.enterGarage();

  const begin = async () => {
    if (game.active) return;
    await game.powertrain.start(game.car());
    game.startRun();
  };
  window.addEventListener('resize', () => game.refreshTitleFraming());
  startBtn.addEventListener('click', begin);
  document.getElementById('go-again').addEventListener('click', () => game.startRun());
  document.getElementById('go-garage').addEventListener('click', () => game.enterGarage());

  window.__highroads = game;
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
  const terrainBox = document.getElementById('terrain-box');
  const terrainCanvas = document.getElementById('terrain-canvas');

  /**
   * The route snapshot is rendered ON DEMAND, not at boot.
   *
   * It lives inside a folded drawer now, and a canvas inside a collapsed grid
   * row measures zero — `drawTerrainMap` sizes itself from the element's
   * rectangle, so drawing it while the drawer is shut produces a picture at the
   * fallback resolution that is then stretched over whatever size the drawer
   * turns out to be. `buildDrawers` calls this when World is first opened.
   */
  game.drawRoutePreview = () => {
    if (!terrainCanvas || !game.terrain || !game.path || !game.gfx) return;
    drawTerrainMap(terrainCanvas, game.terrain, game.path, game.seed, game.gfx, game.chunks);
  };

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
  if (terrainBox) {
    terrainBox.addEventListener('click', () => {
      input.value = Math.random().toString(36).slice(2, 10);
      go(input.value);
    });
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') go(input.value);
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());
}

/**
 * Builds the pickers on the title screen.
 *
 * What is NOT here any more: the paragraph. Every car used to arrive with a
 * sentence of ad copy and a four-cell table of mass, engine, layout and
 * redline, held at a fixed height so that changing car did not move the
 * controls under the player's thumb. It was the tallest thing in the menu, it
 * pushed the one button that matters off the bottom of a phone, and none of it
 * survives contact with the car being visible on screen behind it. The chips
 * name the cars; the car shows what it is.
 */
function buildGarage(game, roster) {
  const chips = new Map();
  const list = document.getElementById('car-list');

  /** Flashes a chip for as long as the throttle blip lasts. */
  const flash = (el) => {
    if (!el) return;
    el.classList.add('revving');
    setTimeout(() => el.classList.remove('revving'), 900);
  };

  const select = (id, preview = true) => {
    game.setCar(id);
    for (const [cid, chip] of chips) chip.setAttribute('aria-pressed', String(cid === id));
    chips.get(id)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    game.refreshSummaries();
    // The click is a user gesture, which is the only moment Web Audio will
    // start. Taking it means the player hears the engine before committing to
    // it rather than discovering it a kilometre down the road.
    if (preview) {
      flash(chips.get(id));
      game.previewEngine().then(() => game.refreshSummaries());
    }
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

  // ---- mode -------------------------------------------------------------
  const modeList = document.getElementById('mode-list');
  const modeChips = new Map();
  const pickMode = (id) => {
    game.setMode(id);
    for (const [mid, el] of modeChips) el.setAttribute('aria-pressed', String(mid === id));
    game.refreshSummaries();
  };
  for (const m of GAME_MODES) {
    const el = document.createElement('button');
    el.className = 'car-chip';
    el.type = 'button';
    el.textContent = m.name;
    el.title = m.blurb;
    el.setAttribute('aria-pressed', String(m.id === game.mode));
    el.addEventListener('click', () => pickMode(m.id));
    modeList.appendChild(el);
    modeChips.set(m.id, el);
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

  // ---- second colour -----------------------------------------------------
  // The swatch every model carries that the paint picker never reached. See
  // cars.CAR_TRIM_COLORS.
  const trimList = document.getElementById('trim-list');
  const trims = new Map();
  const pickTrim = (id) => {
    game.setTrim(id);
    for (const [tid, el] of trims) el.setAttribute('aria-pressed', String(tid === id));
  };
  for (const c of CAR_TRIM_COLORS) {
    const el = document.createElement('button');
    el.className = 'swatch';
    el.type = 'button';
    el.title = c.name;
    if (c.hex === null) {
      // "Stock" has no colour of its own to show, so it reads as an outline.
      el.classList.add('swatch-stock');
    } else {
      el.style.background = '#' + c.hex.toString(16).padStart(6, '0');
    }
    el.setAttribute('aria-pressed', 'false');
    el.addEventListener('click', () => pickTrim(c.id));
    trimList.appendChild(el);
    trims.set(c.id, el);
  }

  // ---- engine -----------------------------------------------------------
  const engineList = document.getElementById('engine-list');
  const engineChips = new Map();
  const pickEngine = (id) => {
    game.setEngine(id);
    for (const [eid, el] of engineChips) el.setAttribute('aria-pressed', String(eid === id));
    engineChips.get(id)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    flash(engineChips.get(id));
    game.previewEngine().then(() => game.refreshSummaries());
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

  select(game.carId, false);   // no audio before the player has clicked anything
  pickColor(game.colorId);
  pickTrim(game.trimId);
  pickMode(game.mode);
}

/**
 * Accordion behaviour for a set of `.drawer` sections.
 *
 * ONE OPEN AT A TIME, and that is the whole reason the title screen fits on a
 * phone now. Four folded drawers plus the Drive button is a fixed height; four
 * OPEN drawers is the wall of controls this replaced. The summary in each
 * header is what makes a shut drawer honest — it still answers the question you
 * would have opened it to ask.
 *
 * @param {Element} root  the container to scope the accordion to
 * @param {?function(string)} onOpen  called with the drawer's key when it opens
 */
function wireDrawers(root, onOpen) {
  const drawers = [...root.querySelectorAll('.drawer')];
  for (const d of drawers) {
    const head = d.querySelector('.drawer-head');
    if (!head) continue;
    head.addEventListener('click', () => {
      const open = !d.classList.contains('open');
      for (const other of drawers) {
        const on = other === d && open;
        other.classList.toggle('open', on);
        other.querySelector('.drawer-head').setAttribute('aria-expanded', String(on));
      }
      if (!open) return;
      // Let the fold finish before scrolling, or the browser scrolls to the
      // height the drawer had a third of a second ago.
      setTimeout(() => d.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 340);
      if (onOpen) onOpen(d.dataset.drawer || d.id);
    });
  }
  return drawers;
}

/** The title screen's four drawers. */
function buildDrawers(game) {
  const host = document.getElementById('drawers');
  if (!host) return;
  let drewRoute = false;
  wireDrawers(host, (key) => {
    if (key === 'world' && !drewRoute) {
      drewRoute = true;
      // One frame, so the fold has a size to measure.
      requestAnimationFrame(() => requestAnimationFrame(() => game.drawRoutePreview()));
    }
  });

  // The settings panel writes its own values; the drawer header mirrors them.
  // One delegated listener rather than a callback per control — every slider in
  // there raises `input`, and none of them needs to know a header exists.
  const body = document.getElementById('settings-body');
  if (body) body.addEventListener('input', () => game.refreshSummaries());

  game.refreshSummaries();
}

/**
 * The pause menu.
 *
 * Note what it does NOT contain: a second copy of the settings controls. The
 * panel `settings.js` builds is moved in here and moved back out again, because
 * two sets of sliders bound to the same buses are two things that can disagree
 * about what the volume is.
 */
function buildPauseMenu(game) {
  const root = document.getElementById('pause');
  if (!root) return;
  wireDrawers(root, null);

  document.getElementById('pause-btn').addEventListener('click', () => game.setPaused(true));
  document.getElementById('pause-resume').addEventListener('click', () => game.setPaused(false));
  document.getElementById('pause-restart').addEventListener('click', () => {
    game.setPaused(false);
    game.startRun();
  });
  document.getElementById('pause-garage').addEventListener('click', () => {
    game.setPaused(false);
    game.enterGarage();
  });

  // Clicking the backdrop resumes; clicking the card does not.
  root.addEventListener('click', (e) => { if (e.target === root) game.setPaused(false); });
  // Nothing typed into the menu should reach the driving controls.
  root.addEventListener('keydown', (e) => e.stopPropagation());
  root.addEventListener('keyup', (e) => e.stopPropagation());
}

/* ------------------------------------------------------------------------- */

class Game {
  constructor({ gfx, world, path, terrain, chunks, models, roster }) {
    this.gfx = gfx;
    this.world = world;
    this.path = path;
    this.terrain = terrain;
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
    this.trimId = DEFAULT_TRIM;
    this.engineChoice = 'stock';
    /** Seconds of throttle blip left on the title screen. */
    this.previewing = false;

    this.mode = GAME_MODES[0].id;
    this.run = new ScoreRun();
    /** True while the title screen is up — distinct from merely not driving. */
    this.inGarage = true;
    this._impactMark = 0;
    this.overlayEl = document.getElementById('overlay');
    this.gameOverEl = document.getElementById('gameover');

    /** True while the pause menu is up. Distinct from `!active`. */
    this.paused = false;
    /** The current model's measurements, for the title rig's fit. */
    this.carMetrics = null;
    this._stageEl = null;

    this.input = new Input();
    this.hud = new HUD();
    this.powertrain = new Powertrain();
    /**
     * Wind noise. It shares the powertrain's AudioContext rather than making
     * its own — one clock, one output bus — so it can only be started once
     * engine_sim has built that, which is inside the Drive click.
     */
    this.wind = new Wind();
    /** Tyre smoke and rubber. */
    this.fx = new TyreFX(gfx.scene, {
      anisotropy: gfx.renderer.capabilities.getMaxAnisotropy(),
    });
    this.cam = new ChaseCamera(gfx.camera);

    this.active = false;
    this.accumulator = 0;
    this.lastTime = performance.now();

    /** Arc length of the vehicle along the spline — drives chunk streaming. */
    this.carS = START_S;
    this.trip = 0;

    this._tmp = new THREE.Vector3();

    /**
     * The pause key is bound here rather than going through `Input`.
     *
     * Everything in `_handleActions` is read only while the game is running,
     * which is exactly the state a pause key has to work in BOTH sides of. It
     * also has to keep working while the menu is up, and the menu swallows key
     * events so a slider cannot steer the car.
     */
    this._onPauseKey = (e) => {
      if (e.code !== 'Escape' && e.code !== 'KeyP') return;
      if (this.inGarage) return;
      e.preventDefault();
      this.togglePause();
    };
    window.addEventListener('keydown', this._onPauseKey);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.powertrain.suspend();
        // Drop the accumulator: coming back from a backgrounded tab with two
        // minutes of pending physics would fling the car into orbit.
        this.accumulator = 0;
        this.lastTime = performance.now();
      } else if (this.active && !this.paused) {
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
    // The title rig fits the car to the free rectangle from these.
    this.carMetrics = model.metrics;
    // A car the player has never coloured takes its own default; once they
    // choose, that choice follows them from car to car.
    if (!this.colorId) this.colorId = spec.defaultColor || CAR_COLORS[0].id;
    this.setColor(this.colorId);
    // Each model carries its own stock second colour, so this has to be
    // reapplied per car rather than surviving from the last one.
    this.setTrim(this.trimId);
    this.powertrain.setCar(this.car());
    this.respawn(this.carS);
  }

  setColor(id) {
    this.colorId = id;
    if (this.vehicle) this.vehicle.setColor(colorById(id).hex);
  }

  /** The second paint colour. `stock` restores whatever the model shipped with. */
  setTrim(id) {
    this.trimId = id;
    if (this.vehicle) this.vehicle.setTrimColor(trimColorById(id).hex);
  }

  setMode(id) {
    this.mode = id;
    if (this.traffic) this.traffic.setEnabled(id === 'traffic');
    this.hud.setMode(id);
  }

  // ------------------------------------------------------------ run flow --

  /**
   * Back to the title screen: car parked, camera orbiting, overlay up. The
   * overlay is hidden rather than removed precisely so this can happen — a
   * Traffic run always ends somewhere, and it has to end somewhere the player
   * can choose what to do next.
   */
  enterGarage() {
    // Before `inGarage` flips, so a run abandoned from the pause menu leaves
    // the audio context running rather than suspended behind the title screen —
    // `setPaused` will not resume anything once it believes we are in the
    // garage, and the garage still wants to hear the engine blip.
    this.setPaused(false);
    this.powertrain.resume();
    this.active = false;
    this.inGarage = true;
    this.gameOverEl.classList.remove('show');
    this.overlayEl.classList.remove('gone');
    this.cam.setTitle(true);
    this.hud.hide();
    // The on-screen driving controls belong to driving. Left up over the title
    // screen they are a steering wheel on top of a menu — live, tappable, and
    // attached to a car that is parked.
    document.body.classList.remove('driving');
    if (this.traffic) this.traffic.dispose();
    // Back to the start of the road rather than to wherever the last run ended.
    // The title screen is a photograph of the world you are about to be dropped
    // into, and you are dropped in at the beginning of it.
    this.carS = START_S;
    this.respawn(START_S);
    this.vehicle.setParked(true);
    this.fx.reset();
    this.wind.update(0, 0);
    this.mountSettings('title-settings-host');
    this.refreshSummaries();
  }

  /**
   * Drive.
   *
   * The camera does not cut. It is left exactly where the title orbit had it
   * and flown into the chase position over `TITLE.introTime` — see
   * `camera.beginIntro` — while the overlay fades out underneath. The two
   * overlap deliberately, so the transition reads as one move rather than as a
   * menu closing and then a camera starting.
   *
   * Controls go live immediately rather than at the end of the flight. A second
   * and a bit of a car that will not respond is a second and a bit of a game
   * that looks broken, and the chase goal is recomputed every frame, so pulling
   * away during the fly-in simply moves the place the camera is flying to.
   */
  startRun() {
    this.gameOverEl.classList.remove('show');
    this.overlayEl.classList.add('gone');
    this.setPaused(false);
    this.inGarage = false;
    this.cam.setTitle(false);
    this.cam.beginIntro();
    this.hud.show();
    document.body.classList.add('driving');
    this.hud.setMode(this.mode);
    this.mountSettings('pause-settings-host');
    this.input.bindTouch(document);
    this.vehicle.setParked(false);
    this.respawn(this.carS);
    // A previous run's rubber has nothing to do with this one, and respawn puts
    // the car somewhere the old marks are not.
    this.fx.reset();
    this.wind.start(this.powertrain.sim && this.powertrain.sim.ctx);
    if (this.traffic) this.traffic.setEnabled(this.mode === 'traffic');
    this.run.reset();
    this._impactMark = this.traffic ? this.traffic.impacts : 0;
    this.trip = 0;
    this.active = true;
  }

  /** Traffic mode only: one collision and the run is over. */
  endRun() {
    if (!this.active) return;
    this.active = false;
    const record = this.run.finish();
    document.getElementById('go-points').textContent = Math.round(this.run.score).toLocaleString();
    document.getElementById('go-best').textContent = Math.round(this.run.best).toLocaleString();
    document.getElementById('go-detail').textContent =
      `${this.run.passes} near ${this.run.passes === 1 ? 'miss' : 'misses'} · ` +
      `${(this.trip / 1000).toFixed(2)} km`;
    document.getElementById('go-record').textContent = record ? 'New best' : '';
    this.gameOverEl.classList.add('show');
  }

  // ---------------------------------------------------------------- pause --

  /**
   * Pause.
   *
   * Freezing a fixed-step simulation is not a matter of multiplying `dt` by
   * zero — the accumulator would keep filling from wall time and the world
   * would fast-forward through everything it owed the moment play resumed,
   * which is the same failure as returning to a backgrounded tab. So the loop
   * returns BEFORE the accumulator is touched: no time is banked, and the frame
   * still renders, so what is behind the menu is the road you stopped on.
   *
   * Audio is suspended rather than muted. The engine simulator runs on the
   * AudioContext's own clock and would otherwise keep idling behind the menu.
   */
  setPaused(on) {
    const want = !!on && !this.inGarage;
    if (want === this.paused) return;
    this.paused = want;
    document.body.classList.toggle('paused', want);
    if (want) {
      this.powertrain.suspend();
      this._refreshPauseStats();
    } else {
      if (this.active) this.powertrain.resume();
      // Wall time moved on while the menu was up; the next frame must not be
      // handed the whole of it.
      this.lastTime = performance.now();
      this.accumulator = 0;
    }
  }

  togglePause() {
    this.setPaused(!this.paused);
  }

  _refreshPauseStats() {
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    set('pause-km', (this.trip / 1000).toFixed(2) + ' km');
    set('pause-speed', Math.round(Math.abs(this.vehicle.forwardSpeed) * 3.6) + ' km/h');
    set('pause-score', Math.round(this.run.score).toLocaleString());
    const wrap = document.getElementById('pause-score-wrap');
    if (wrap) wrap.style.display = this.mode === 'traffic' ? '' : 'none';
  }

  /**
   * Moves the settings panel to whichever host wants it now.
   *
   * See the note in `index.html`: there is one panel, and it is re-parented
   * between the title screen's Settings drawer and the pause menu rather than
   * built twice. `appendChild` on a node that already has a parent is a move,
   * so this is the whole implementation.
   */
  mountSettings(hostId) {
    const host = document.getElementById(hostId);
    const body = this.settings && this.settings.body;
    if (!host || !body || body.parentNode === host) return;
    host.appendChild(body);
  }

  // ------------------------------------------------------- title readouts --

  /**
   * Writes the one-line summary into each folded drawer's header.
   *
   * This is what a closed drawer is worth. Without it the title screen is four
   * words and no state, and the player has to open every one of them to find
   * out what they are about to drive.
   */
  refreshSummaries() {
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    const spec = carById(this.carId);
    const colour = colorById(this.colorId);
    set('v-car', spec ? `${spec.name} · ${colour ? colour.name : ''}`.trim() : '');

    const sim = this.powertrain.sim ? this.powertrain.sim.profile : null;
    const choice = ENGINE_OPTIONS.find((e) => e.id === this.engineChoice);
    set('v-engine', sim ? sim.label : (choice ? choice.name : 'Stock'));

    const mode = GAME_MODES.find((m) => m.id === this.mode);
    set('v-world', `${mode ? mode.name : ''} · ${this.seed}`);
    set('mode-hint', mode ? mode.blurb : '');

    const pt = this.powertrain;
    const summary = `${pt.autoShift ? 'Auto' : 'Manual'} · ${Math.round(pt.volume * 100)}%`;
    set('v-settings', summary);
    set('v-pause-settings', summary);
  }

  /**
   * Hands the title rig the slice of screen the interface is not using.
   *
   * Measured from the DOM rather than assumed. `#stage` is the hole in the
   * title screen's grid — see the layout note in `index.html` — and its shape
   * changes with the orientation, the safe area and whether a drawer is open. A
   * camera tuned by hand against one of those puts the car behind a panel the
   * moment another changes; that is bug #53 exactly. A layout query per frame
   * would be indefensible in the driving loop and costs nothing on a menu that
   * is not moving anything else.
   */
  _frameTitle() {
    if (!this._stageEl) this._stageEl = document.getElementById('stage');
    const r = this._stageEl ? this._stageEl.getBoundingClientRect() : null;
    this.cam.frameTitle(
      window.innerWidth,
      window.innerHeight,
      r && r.width > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null,
      this.carMetrics
    );
  }

  /** Re-frames after a rotation or a window resize, without waiting a frame. */
  refreshTitleFraming() {
    if (this.inGarage) this._frameTitle();
  }

  setEngine(id) {
    this.engineChoice = id;
    return this.powertrain.setEngine(id);
  }

  /**
   * Starts the audio if it is not running yet and blips the throttle, so the
   * garage is audible as well as visible. Safe to call repeatedly; safe to call
   * before any model has loaded.
   */
  async previewEngine() {
    if (!this.vehicle) return;
    try {
      if (!this.powertrain.sim) await this.powertrain.start(this.car());
      else this.powertrain.setCar(this.car());
    } catch (err) {
      console.warn('[highroads] engine preview unavailable:', err && err.message);
      return;
    }
    this.previewing = true;
    this.powertrain.blip();
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
    if (this.powertrain) {
      this.powertrain.reset(this.inGarage ? 0 : 1);
    }
    this.carS = s;
  }

  // ----------------------------------------------------------------- loop --

  loop(now) {
    requestAnimationFrame(this.loop);

    /**
     * Clamp: a long frame must not be simulated in one bite.
     *
     * The ceiling is DERIVED from the substep budget rather than written down
     * again. A clamp looser than `maxSubSteps * fixedStep` cannot be honoured —
     * the loop below runs out of substeps, the leftover is discarded, and the
     * world quietly advances less than the frame it is part of. Everything
     * downstream (the camera, traffic, the trip meter) is handed this same `dt`
     * and has no way to know, so it acts on time the car never got. That
     * disagreement is what a frame-rate hitch looked like: not a pause, but the
     * car lurching backwards inside the frame.
     *
     * At this value the accumulator always drains, so `dt` is time the whole
     * game agrees on. Beyond it the frame is genuinely too long and everything
     * slows down together, which is a hitch and looks like one.
     */
    const maxFrame = WORLD.maxSubSteps * WORLD.fixedStep;
    const dt = Math.min((now - this.lastTime) / 1000, maxFrame);
    this.lastTime = now;

    /**
     * Paused: draw the frame, bank no time.
     *
     * This returns before the accumulator is touched on purpose. Scaling `dt`
     * to zero instead would leave the accumulator filling from wall time, and
     * the world would then fast-forward through every second the menu was up —
     * the same failure as returning to a tab that has been in the background,
     * which the visibility handler below exists to avoid.
     */
    if (this.paused) {
      this.gfx.render();
      this.input.endFrame();
      return;
    }

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

    // On the title screen the car is parked, so the gearbox goes to neutral and
    // the only throttle is whatever blip the garage asked for. In gear against a
    // stopped driveline it would bog instead of revving.
    // The title screen puts the gearbox in neutral so the engine revs freely
    // for the preview. A finished run does NOT — the car is still on the road
    // and should coast to a stop in gear like a car that has just crashed.
    const garage = this.inGarage;
    if (garage) pedals.throttle = this.powertrain.blipThrottle(dt);

    // How far off the asphalt the car is, for surface drag and grip.
    {
      const lat = Math.abs(this.path.lateralOffset(this.vehicle.pos, this.carS));
      this.vehicle.setSurface(smoothstep(ROAD.halfWidth * 0.9, ROAD.halfWidth + 2.2, lat));
    }

    // Brake lights follow the pedal, not the gear — they come on in reverse too.
    this.vehicle.setBrakeLight(this.active ? control.brake : 0);
    this.flashing = this.active && this.input.flashHeld;
    this.vehicle.setHeadlights(this.headlights, this.flashing);

    this.vehicle.setDriveForce(
      this.powertrain.update(dt, {
        wheelSpeed: this.vehicle.forwardSpeed,
        throttle: pedals.throttle,
        brake: pedals.brake,
        reverse,
        neutral: garage,
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
    // With `dt` capped at the substep budget this cannot fire — the loop always
    // drains. Kept as a guard against the two ever drifting apart again, since
    // the failure is silent.
    if (this.accumulator > h) this.accumulator = h * 0.999;

    // Draw where the car actually is *between* steps, not at the last one.
    this.vehicle.syncVisuals(this.accumulator / h);

    // ---- world streaming -------------------------------------------------
    this.carS = this.path.projectPoint(this.vehicle.pos, this.carS);
    // The wind runs on wall time, not simulation time: it is scenery, and
    // nothing about the car depends on where a blade of grass is pointing.
    this.chunks.advanceTime(dt);
    this.chunks.update(this.carS);

    // Tyre effects read the wheel state the substeps above just wrote, so they
    // have to come after the loop and before anything renders. On the title
    // screen they are inert rather than hidden — the car is parked and nothing
    // is slipping — which matters now that the title screen is the world.
    this.fx.update(dt, this.vehicle);
    this.wind.update(dt, this.active ? this.vehicle.forwardSpeed : 0);

    if (this.active && this.traffic) {
      this.traffic.update(dt, {
        s: this.carS,
        v: this.path.lateralOffset(this.vehicle.pos, this.carS),
        speed: Math.abs(this.vehicle.forwardSpeed),
        flashing: this.flashing,
        vehicle: this.vehicle,
      });

      if (this.mode === 'traffic') {
        this.run.update(dt, this.traffic.passes, Math.abs(this.vehicle.forwardSpeed));
        if (this.traffic.impacts !== this._impactMark) this.endRun();
      }
    }

    if (this.active) this.trip += this.vehicle.speed * dt;
    this._checkRecovery(dt);

    // ---- presentation ----------------------------------------------------
    // The title screen and the road are the same picture now, so there is one
    // presentation path rather than two. All that differs is which rig is
    // driving the camera and whether the speed effects have anything to say.
    if (this.inGarage) this._frameTitle();

    // Camera first: follow() re-centres the sky dome on the camera, so it must
    // see this frame's position, not last frame's.
    this.cam.update(dt, this.vehicle);
    // The interpolated pose, not the raw physics one: the sun's shadow frustum
    // is centred here, and stepping it in 8.3 ms jumps while the car moves
    // smoothly crawls the shadows across everything at speed.
    this.gfx.follow(this.vehicle.renderPos, dt);
    // Periphery streaks with speed; the centre of the screen, where the car is,
    // stays sharp. Nothing at all on the title screen.
    this.gfx.setSpeedBlur(
      this.active
        ? smoothstep(6, ATMOSPHERE.speedBlurRef, Math.abs(this.vehicle.forwardSpeed))
        : 0
    );

    if (this.active && this.mode === 'traffic') this.hud.updateRun(dt, this.run);

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
      const muted = this.powertrain.toggleMute();
      this.wind.setMuted(muted);
      this.hud.toast(muted ? 'audio muted' : 'audio on');
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
    this.refreshSummaries();
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
