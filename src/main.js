/**
 * main.js — the boot sequence and the frame loop.
 *
 * Rendering runs on requestAnimationFrame; physics on a fixed 120 Hz
 * accumulator. Suspension and tyre integration run inside each substep,
 * immediately before world.step().
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

import { WORLD, CHUNK, ROAD, VEHICLE, ATMOSPHERE } from './config.js';
import { loadCarTexture, loadCarModel } from './assets.js';
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
import { Input, TiltSteering } from './input.js';
import { HUD } from './hud.js';
import { createScene } from './scene.js';
import { Wind } from './wind.js';
import { TyreFX } from './fx.js';
import { Settings } from './settings.js';
import { ScoreRun } from './score.js';

/**
 * The two game modes. Traffic scores near misses and ends on a crash; Zen
 * is an empty road with nothing to lose.
 */
const GAME_MODES = [
  { id: 'traffic', name: 'Traffic', blurb: 'Points for near misses. One crash ends the run.' },
  { id: 'zen', name: 'Zen', blurb: 'Empty road, no traffic, no way to lose.' },
];

/**
 * The body origin is the contact plane (see cars.buildCarParams), so the car
 * settles to its static sag. Clearance avoids starting interpenetrated.
 */
const SPAWN_HEIGHT = 0.03;

/** Start a little way in: the spline (and therefore terrain) begins at s = 0. */
const START_S = 90;

const IDLE_INPUT = { steer: 0, throttle: 0, brake: 0, handbrake: false };

/**
 * How far inside the terrain edge the car is recovered, metres.
 * See `_checkRecovery`: the corridor narrows into bends.
 */
const RECOVER_MARGIN = 12;

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
  // Only the cars are fetched; the rest is generated in ChunkManager.
  // See src/env/README.md.
  bootEl.textContent = 'loading vehicles…';
  const carTexture = await loadCarTexture();

  // Load all models up front so switching cars is instant.
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
    scene: gfx.scene, world, RAPIER, path, terrain,
    // Grass is seen at a grazing angle; that is why anisotropic filtering.
    anisotropy: gfx.renderer.capabilities.getMaxAnisotropy(),
  });

  bootEl.textContent = 'carving terrain…';
  chunks.preload(START_S);

  // Rapier refreshes its query pipeline only in step(); ray casts return
  // null until one has run.
  world.step();

  const game = new Game({ gfx, world, path, terrain, chunks, models, roster });
  game.seed = startSeed;
  game.input.bindTouch(document);
  // No world, no RAPIER: traffic owns no physics objects at all. See traffic.js.
  game.traffic = new Traffic({ scene: gfx.scene, path, chunks, models, roster });
  game.setCar(roster.some((c) => c.id === DEFAULT_CAR) ? DEFAULT_CAR : roster[0].id);

  // Run the loop now, controls inert, so shaders compile and the suspension
  // settles before the first real frame.
  game.loop(performance.now());

  // The settings panel is built once and re-parented between the title drawer
  // and the pause menu — see `Game.mountSettings`.
  game.settings = new Settings(game);

  buildGarage(game, roster);
  buildSeedBox(game);
  buildModeToggle(game);
  buildDrawers(game);
  buildPauseMenu(game);
  buildModals(game);

  startBtn.disabled = false;
  startBtn.textContent = 'Drive';
  bootEl.hidden = true;

  game.enterGarage();

  const begin = async () => {
    if (game.active) return;
    await game.powertrain.start(game.car());
    /**
     * Restore tilt steering if the player used it last time.
     * iOS grants the sensor only inside a gesture; this click is one.
     */
    if (TiltSteering.remembered && !game.input.tilt.on) {
      const ok = await game.input.tilt.enable();
      document.body.classList.toggle('tilt', ok);
      if (game.settings) game.settings.refresh();
    }
    game.startRun();
  };
  window.addEventListener('resize', () => game.refreshTitleFraming());
  startBtn.addEventListener('click', begin);
  document.getElementById('go-again').addEventListener('click', () => game.startRun(true));
  document.getElementById('go-garage').addEventListener('click', () => game.enterGarage());

  window.__highroads = game;
  return game;
}

/**
 * Seed entry. A new seed rebuilds the whole world, so it reloads the page
 * with the seed in the query string.
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

/**
 * The Traffic / Zen selector beneath the Drive button.
 * A two-position switch; tapping the inactive half flips it.
 */
function buildModeToggle(game) {
  const root = document.getElementById('mode-toggle');
  if (!root) return;
  const segs = [...root.querySelectorAll('.seg-btn')];
  const refresh = () => {
    root.dataset.active = String(GAME_MODES.findIndex((m) => m.id === game.mode));
    for (const s of segs) {
      s.setAttribute('aria-pressed', String(s.dataset.mode === game.mode));
    }
  };
  for (const s of segs) {
    s.addEventListener('click', () => {
      if (s.dataset.mode === game.mode) return;
      game.setMode(s.dataset.mode);
      game.refreshSummaries();
      refresh();
    });
  }
  refresh();
}

/**
 * The How-to-play and Credits windows.
 * A button opens a modal; a modal closes on its ×, the backdrop, or Escape.
 */
function buildModals(game) {
  const open = {};
  for (const [btnId, modalId] of [['howto-btn', 'modal-howto'], ['credits-btn', 'modal-credits']]) {
    const btn = document.getElementById(btnId);
    const modal = document.getElementById(modalId);
    if (!btn || !modal) continue;
    open[modalId] = modal;
    btn.addEventListener('click', () => { modal.hidden = false; });
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('.modal-close')) modal.hidden = true;
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const modal of Object.values(open)) modal.hidden = true;
  });
}

/**
 * Builds the pickers on the title screen.
 * The chips name the cars; the car shows what it is.
 */
function buildGarage(game, roster) {
  /** Flashes an option for as long as the throttle blip lasts. */
  const flash = (el) => {
    if (!el) return;
    el.classList.add('revving');
    setTimeout(() => el.classList.remove('revving'), 900);
  };

  const hex = (h) => '#' + h.toString(16).padStart(6, '0');

  /**
   * A single select-dropdown.
   * The menu is `fixed` and lives on <body> so the drawer's overflow
   * cannot cut it off.
   */
  const dropdowns = [];

  function makeDropdown(root, { showSwatch, values, current, onChange }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dropdown-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    root.appendChild(btn);

    let swatchPreview = null;
    if (showSwatch) {
      swatchPreview = document.createElement('span');
      swatchPreview.className = 'swatch';
      swatchPreview.setAttribute('aria-hidden', 'true');
      btn.appendChild(swatchPreview);
    }
    const label = document.createElement('span');
    label.className = 'dropdown-label';
    const caret = document.createElement('span');
    caret.className = 'dropdown-caret';
    caret.setAttribute('aria-hidden', 'true');
    btn.append(label, caret);

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu';
    menu.setAttribute('role', 'listbox');
    menu.dataset.owner = root.id;
    document.body.appendChild(menu);

    const options = values.map((v) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'dropdown-item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      if (v.title) item.title = v.title;
      if (v.hex || v.stock) {
        const sw = document.createElement('span');
        sw.className = 'swatch';
        sw.setAttribute('aria-hidden', 'true');
        if (v.hex) sw.style.background = hex(v.hex);
        if (v.stock) sw.classList.add('swatch-stock');
        item.appendChild(sw);
      }
      const name = document.createElement('span');
      name.className = 'item-name';
      name.textContent = v.name;
      item.appendChild(name);
      item.addEventListener('click', () => { pick(v.id, item); close(); });
      menu.appendChild(item);
      return { id: v.id, el: item };
    });

    let currentId = current;
    let isOpen = false;

    function render() {
      const v = values.find((o) => o.id === currentId);
      label.textContent = v ? v.name : '';
      for (const o of options) o.el.setAttribute('aria-selected', String(o.id === currentId));
      if (swatchPreview) {
        const on = v && v.hex;
        swatchPreview.style.background = on ? hex(v.hex) : '';
        swatchPreview.classList.toggle('swatch-stock', !on && !!(v && v.stock));
      }
    }

    function position() {
      const r = btn.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(r.width, vw - 16);
      const left = Math.max(8, Math.min(r.left, vw - 8 - width));
      // Flip up when there is more room above; clamp to stay on-screen.
      const maxH = parseFloat(getComputedStyle(menu).maxHeight) || 320;
      const height = Math.min(menu.scrollHeight, maxH);
      const below = r.bottom + 6;
      const spaceBelow = vh - 8 - below;
      const spaceAbove = r.top - 8;
      let top = spaceBelow >= height || spaceBelow >= spaceAbove ? below : r.top - 6 - height;
      if (top < 8) top = 8;
      if (top + height > vh - 8) top = Math.max(8, vh - 8 - height);
      menu.style.width = width + 'px';
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
    }

    function open() {
      for (const d of dropdowns) if (d !== api) d.close();
      position();
      isOpen = true;
      btn.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      menu.classList.add('open');
      const sel = options.find((o) => o.id === currentId);
      sel?.el.scrollIntoView({ block: 'nearest' });
    }

    function close() {
      isOpen = false;
      btn.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      menu.classList.remove('open');
    }

    function pick(id, item) {
      currentId = id;
      for (const o of options) o.el.setAttribute('aria-selected', String(o.id === id));
      render();
      onChange(id, item, api);
    }

    btn.addEventListener('click', () => { if (isOpen) close(); else open(); });

    const api = {
      open, close, btn,
      isOpen: () => isOpen,
      contains: (t) => btn.contains(t) || menu.contains(t),
      menuOpen: () => menu.classList.contains('open'),
      scrollTarget: (t) => menu.contains(t),
    };
    dropdowns.push(api);

    render();
    return api;
  }

  // ---- model ------------------------------------------------------------
  makeDropdown(document.getElementById('car-list'), {
    values: roster.map((s) => ({ id: s.id, name: s.name, title: s.blurb })),
    current: game.carId,
    onChange: (id, item, d) => {
      if (d) flash(d.btn);
      game.setCar(id);
      game.refreshSummaries();
      // The click is the only moment Web Audio will start, so preview here.
      game.previewEngine().then(() => game.refreshSummaries());
    },
  });

  // ---- paint ------------------------------------------------------------
  makeDropdown(document.getElementById('color-list'), {
    showSwatch: true,
    values: CAR_COLORS.map((c) => ({ id: c.id, name: c.name, hex: c.hex })),
    current: game.colorId,
    onChange: (id) => game.setColor(id),
  });

  // ---- second colour -----------------------------------------------------
  // `stock` has no colour, so it reads as the outline swatch.
  makeDropdown(document.getElementById('trim-list'), {
    showSwatch: true,
    values: CAR_TRIM_COLORS.map((c) => ({
      id: c.id, name: c.name, hex: c.hex, stock: c.hex === null,
    })),
    current: game.trimId,
    onChange: (id) => game.setTrim(id),
  });

  // ---- engine -----------------------------------------------------------
  makeDropdown(document.getElementById('engine-list'), {
    values: ENGINE_OPTIONS.map((e) => ({ id: e.id, name: e.name })),
    current: game.engineChoice,
    onChange: (id, item, d) => {
      if (d) flash(d.btn);
      game.setEngine(id);
      game.previewEngine().then(() => game.refreshSummaries());
    },
  });

  // ---- shared behaviour ---------------------------------------------------
  // A tap closes any open menu unless the tap was on it.
  document.addEventListener('click', (e) => {
    for (const d of dropdowns) if (d.isOpen() && !d.contains(e.target)) d.close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') for (const d of dropdowns) d.close();
  });
  window.addEventListener('resize', () => { for (const d of dropdowns) d.close(); });
  // Scrolling outside a menu closes it; scrolling the menu itself does not.
  window.addEventListener('scroll', (e) => {
    const t = e.target;
    for (const d of dropdowns) {
      if (d.isOpen() && !(t instanceof Element && d.scrollTarget(t))) d.close();
    }
  }, true);
}

/**
 * Accordion behaviour for a set of `.drawer` sections. One drawer is open
 * at a time.
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
      // Scroll after the fold finishes, or the browser uses the old height.
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
  wireDrawers(host, null);

  // One delegated listener: every slider raises `input`.
  const body = document.getElementById('settings-body');
  if (body) body.addEventListener('input', () => game.refreshSummaries());

  game.refreshSummaries();
}

/**
 * The pause menu. It contains no second copy of the settings controls;
 * `settings.js` builds one panel that is moved in here.
 */
function buildPauseMenu(game) {
  const root = document.getElementById('pause');
  if (!root) return;
  wireDrawers(root, null);

  document.getElementById('pause-btn').addEventListener('click', () => game.setPaused(true));
  document.getElementById('pause-resume').addEventListener('click', () => game.setPaused(false));
  document.getElementById('pause-restart').addEventListener('click', () => {
    game.setPaused(false);
    game.startRun(true);
  });
  document.getElementById('pause-garage').addEventListener('click', () => {
    game.setPaused(false);
    game.enterGarage();
  });

  // Clicking the backdrop resumes; clicking the card does not.
  root.addEventListener('click', (e) => { if (e.target === root) game.setPaused(false); });
  // Nothing typed into the menu reaches the driving controls.
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
     * Wind noise shares the powertrain's AudioContext, so it can start only
     * after the engine simulator has built that — inside the Drive click.
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
    /** Reused by `_checkRecovery`; see `path.corridorAt`. */
    this._reach = { left: 0, right: 0 };

    /**
     * The pause key is bound here because it must work both while running
     * and while the menu is up.
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
        // Drop the accumulator so a long background gap is not simulated.
        this.accumulator = 0;
        this.lastTime = performance.now();
      } else if (this.active && !this.paused) {
        this.powertrain.resume();
      }
    });

    this.loop = this.loop.bind(this);
  }

  /**
   * Builds or rebuilds the vehicle for a roster entry. The old body is
   * disposed, so switching cars does not accumulate wrecks.
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
    // The first choice of colour sticks across cars; otherwise use the default.
    if (!this.colorId) this.colorId = spec.defaultColor || CAR_COLORS[0].id;
    this.setColor(this.colorId);
    // Each model has its own stock second colour; reapply it per car.
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
   * Back to the title screen: car parked, camera orbiting, overlay up.
   */
  enterGarage() {
    // Before `inGarage` flips, so the garage keeps the audio context running.
    this.setPaused(false);
    this.powertrain.resume();
    this.active = false;
    this.inGarage = true;
    this.gameOverEl.classList.remove('show');
    this.overlayEl.classList.remove('gone');
    this.cam.setTitle(true);
    this.hud.hide();
    // The driving controls stay off over the title screen.
    document.body.classList.remove('driving');
    if (this.traffic) this.traffic.dispose();
    // Back to the start of the road for the title screen.
    this.carS = START_S;
    this.respawn(START_S);
    this.vehicle.setParked(true);
    this.fx.reset();
    this.wind.update(0, 0);
    this.mountSettings('title-settings-host');
    this.refreshSummaries();
  }

  /**
   * Drive. From the title screen the camera flies into the chase position
   * (see `camera.beginIntro`). Restarting mid-run is a respawn with a cut.
   */
  startRun(restart = false) {
    this.gameOverEl.classList.remove('show');
    this.overlayEl.classList.add('gone');
    this.setPaused(false);
    this.inGarage = false;
    this.cam.setTitle(false);
    this.hud.show();
    document.body.classList.add('driving');
    this.hud.setMode(this.mode);
    this.mountSettings('pause-settings-host');
    this.input.bindTouch(document);
    this.vehicle.setParked(false);
    if (restart) this.carS = START_S;
    // Before the fly-in: a later respawn would eat the first frame of the shot.
    this.respawn(this.carS);
    if (!restart) this.cam.beginIntro();
    // Clear the previous run's marks; respawn is elsewhere.
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
   * Pause. The loop returns before the accumulator is touched, so no time is
   * banked while paused and the frame still renders. Audio is suspended rather
   * than muted so the simulator does not idle behind the menu.
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
      // Do not hand the next frame all the wall time the menu consumed.
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
   * `appendChild` on a node with a parent is a move.
   */
  mountSettings(hostId) {
    const host = document.getElementById(hostId);
    const body = this.settings && this.settings.body;
    if (!host || !body || body.parentNode === host) return;
    host.appendChild(body);
  }

  // ------------------------------------------------------- title readouts --

  /**
   * Writes a one-line summary into each folded drawer's header.
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

    const pt = this.powertrain;
    const summary = `${pt.autoShift ? 'Auto' : 'Manual'} · ${Math.round(pt.volume * 100)}%`;
    set('v-settings', summary);
    set('v-pause-settings', summary);
  }

  /**
   * Hands the title rig the slice of screen the interface is not using.
   * Measured from the DOM, because its shape changes with orientation, the
   * safe area and open drawers.
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
   * Starts the audio if needed and blips the throttle. Safe to call repeatedly
   * and before any model has loaded.
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

  /**
   * Puts the car back on the road and cuts the camera there. See `camera.snap`.
   *
   * `startRun` respawns BEFORE `beginIntro`; a snap after the fly-in starts
   * would eat the first frame of the shot.
   */
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
    if (this.cam) this.cam.snap();
  }

  // ----------------------------------------------------------------- loop --

  loop(now) {
    requestAnimationFrame(this.loop);

    /**
     * Clamp a long frame to the substep budget. A looser clamp would run out
     * of substeps, discard the leftover, and the world would advance less than
     * the frame handed to it.
     */
    const maxFrame = WORLD.maxSubSteps * WORLD.fixedStep;
    const dt = Math.min((now - this.lastTime) / 1000, maxFrame);
    this.lastTime = now;

    /**
     * Paused: draw the frame, bank no time. If `dt` were scaled to zero the
     * accumulator would keep filling and the world would fast-forward.
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
    // One simulator step per frame; it sub-steps internally at 0.5 ms, and
    // the returned force is held constant across the physics substeps below.
    const reverse = this.vehicle.reverse;
    const pedals = reverse
      ? { throttle: control.brake, brake: control.throttle }
      : { throttle: control.throttle, brake: control.brake };

    // On the title screen the gearbox is neutral so the engine revs freely.
    // A finished run is not: the car should coast to a stop in gear.
    const garage = this.inGarage;
    if (garage) pedals.throttle = this.powertrain.blipThrottle(dt);

    // How far off the asphalt the car is, for surface drag and grip.
    {
      const lat = Math.abs(this.path.lateralOffset(this.vehicle.pos, this.carS));
      this.vehicle.setSurface(smoothstep(ROAD.halfWidth * 0.9, ROAD.halfWidth + 2.2, lat));
    }

    // Brake lights follow the pedal, so they come on in reverse too.
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
    // If we hit the substep ceiling we are behind. Clamp the debt rather than
    // zero it: the interpolator needs the sub-step remainder.
    if (this.accumulator > h) this.accumulator = h * 0.999;

    // Draw where the car actually is *between* steps, not at the last one.
    this.vehicle.syncVisuals(this.accumulator / h);

    // ---- world streaming -------------------------------------------------
    this.carS = this.path.projectPoint(this.vehicle.pos, this.carS);
    // The wind runs on wall time, not simulation time; it is scenery.
    this.chunks.advanceTime(dt);
    this.chunks.update(this.carS);

    // Tyre effects read the wheel state just written by the substeps, so they
    // come after the loop and before anything renders.
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
    // The title screen and the road share one presentation path.
    if (this.inGarage) this._frameTitle();

    // Camera first: follow() re-centres the sky dome on this frame's position.
    this.cam.update(dt, this.vehicle);
    // Use the interpolated pose: the shadow frustum is centred here, and
    // 8.3 ms steps would crawl the shadows across everything.
    this.gfx.follow(this.vehicle.renderPos, dt);
    // The periphery streaks with speed; the centre stays sharp.
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

    // Any one-shot press not consumed this frame is lost.
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
      // A lower gear request implies manual control.
      if (this.powertrain.autoShift) this.setAutoShift(false);
      else if (!this.powertrain.shiftDown()) this.hud.toast('would over-rev');
    }
    if (this.input.consume('KeyG')) this.setAutoShift(!this.powertrain.autoShift);
    if (this.input.consume('KeyT')) {
      // Recentre: the phone's current attitude becomes straight ahead.
      if (this.input.tilt.on) {
        this.input.tilt.recentre();
        this.hud.toast('tilt centred');
      }
    }
    if (this.input.consume('KeyL')) {
      this.headlights = !this.headlights;
      this.hud.toast(this.headlights ? 'headlights on' : 'headlights off');
    }
  }

  /**
   * Turns tilt steering on or off and remembers the choice.
   * Called from the Settings button, the tap iOS needs; must survive denial,
   * non-HTTPS, and a device with no sensor, which all come back as false.
   */
  async toggleTilt() {
    const tilt = this.input.tilt;
    if (tilt.on) {
      tilt.disable();
      document.body.classList.remove('tilt');
      this.hud.toast('button steering');
    } else {
      const ok = await tilt.enable();
      document.body.classList.toggle('tilt', ok);
      this.hud.toast(ok ? 'tilt steering — hold the phone level' : 'tilt unavailable');
      if (!ok) {
        if (this.settings) this.settings.refresh();
        this.refreshSummaries();
        return;
      }
    }
    TiltSteering.remember(tilt.on);
    if (this.settings) this.settings.refresh();
    this.refreshSummaries();
  }

  setAutoShift(on) {
    const v = this.powertrain.setAutoShift(on);
    this.hud.toast(v ? 'automatic' : 'manual');
    if (this.settings) this.settings.refresh();
    this.refreshSummaries();
    return v;
  }

  /**
   * Puts the player back on the road after a failure: flipped and stuck, off
   * the corridor edge, or fallen out of the world.
   */
  _checkRecovery(dt) {
    if (!this.active) return;
    const v = this.vehicle;

    const offset = this.path.lateralOffset(v.pos, this.carS);
    const lateral = Math.abs(offset);
    const groundY = this.chunks.groundAt(this.carS, 0, this._tmp).y;

    /**
     * Where the world ends on this side, here. `CHUNK.recoverLateral` is a
     * flat 300 m, but the terrain edge pulls in on bends, so the road's own
     * corridor width is used. `RECOVER_MARGIN` is slack for the car's length
     * and for the corridor narrowing into a bend.
     */
    const reach = this.path.corridorAt(this.carS, this._reach);
    const edge = offset < 0 ? reach.left : reach.right;
    const bound = Math.min(CHUNK.recoverLateral, edge - RECOVER_MARGIN);

    // Beached: full throttle, no progress — for example on a cut face too
    // steep to climb.
    if (this.input.throttle > 0.5 && v.speed < 1.2 && v.groundedCount > 0) {
      this.stuckFor = (this.stuckFor || 0) + dt;
    } else {
      this.stuckFor = 0;
    }

    const flipped = v.upsideDownFor > 2.5;
    const stuck = this.stuckFor > 4;
    const offWorld = lateral > bound || v.pos.y < groundY - 90;

    if (flipped || offWorld || stuck) {
      this.respawn(this.carS - 12);
      this.stuckFor = 0;
      this.hud.toast(flipped ? 'recovered' : stuck ? 'unstuck' : 'back on road');
    }
  }
}
