/**
 * main.js — the boot sequence and the frame loop.
 *
 * Rendering runs on requestAnimationFrame; physics on a fixed 120 Hz
 * accumulator. Suspension and tyre integration run inside each substep,
 * immediately before world.step().
 *
 * Three places the player can be: the TITLE (the real road, the car parked,
 * the camera orbiting it), the GARAGE (a separate studio scene, garage.js —
 * the road is not simulated meanwhile) and DRIVING. Screens and their DOM
 * belong to ui.js.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

import { WORLD, CHUNK, ROAD, VEHICLE, ATMOSPHERE, TRAFFIC, TREES, SIGNS } from './config.js';
import { deriveSpec, buildCarParams } from './cars.js';
import { buildModel, mergeParts, finishBuild, Fleet, DETAIL } from './models.js';
import { smoothstep, clamp } from './util.js';
import { PERF } from './perf.js';
import { applySky, saveSky, SKY_PRESETS, SKY_NAMES } from './sky.js';
import { createTerrain } from './noise.js';
import { RoadPath, makeFrame } from './path.js';
import { ChunkManager } from './chunks.js';
import { createTreeGenAssetsAsync } from './env/treegen.js';
import { createSignAssetsAsync } from './env/signs.js';
import { Traffic } from './traffic.js';
import { RaycastVehicle } from './vehicle.js';
import { ChaseCamera } from './camera.js';
import { Powertrain } from './powertrain.js';
import { Input, TiltSteering } from './input.js';
import { AutoDrive } from './autodrive.js';
import { HUD } from './hud.js';
import { createScene } from './scene.js';
import { Wind } from './wind.js';
import { TyreFX } from './fx.js';
import { ExhaustFlames } from './flames.js';
import { Settings } from './settings.js';
import { ScoreRun } from './score.js';
import { GarageStudio } from './garage.js';
import { UI, frame } from './ui.js';
import { PREMADE } from './premade.js';

/**
 * The two game modes. Traffic scores near misses and ends on a crash; Zen
 * is an empty road with nothing to lose.
 */
const GAME_MODES = ['traffic', 'zen'];

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

/** The car you drive, kept between sessions. */
const BUILD_KEY = 'highroads.build';
const MODE_KEY = 'highroads.mode';

function storedBuild() {
  try {
    const b = JSON.parse(localStorage.getItem(BUILD_KEY) || 'null');
    if (b && b.params && b.seed) return finishBuild(b);
  } catch { /* nothing stored, or private mode */ }
  return null;
}

function firstBuild() {
  return finishBuild(structuredClone(PREMADE.find((b) => b.seed === 'NERFCU')));
}

export async function boot() {
  const P = UI.progress;
  UI.tips();

  P(0.04, 'Loading physics');
  await RAPIER.init();

  P(0.12, 'Starting the renderer');
  const gfx = await createScene(document.getElementById('app'));

  const world = new RAPIER.World({ x: 0, y: WORLD.gravity, z: 0 });
  world.timestep = WORLD.fixedStep;

  P(0.2, 'Plotting the road');
  await frame();
  // A seed in the URL wins, so a world can be shared as a link.
  const urlSeed = new URLSearchParams(location.search).get('seed');
  const startSeed = urlSeed || WORLD.seed;
  const terrain = createTerrain(startSeed);
  const path = new RoadPath(terrain, startSeed);

  // The canopy: every species grown by TreeGen on worker threads (dressed
  // and its billboards baked here as each arrives). The traffic fleet needs
  // nothing from the world, so it is generated meanwhile.
  let treeShare = 0;
  const treesReady = TREES.enabled && TREES.generator === 'treegen'
    ? createTreeGenAssetsAsync({ renderer: gfx.renderer }, (f) => { treeShare = f; })
    : Promise.resolve(null);
  // Road signs (Roadsign-gen), a face painted per frame in the meantime.
  const signsReady = SIGNS.enabled ? createSignAssetsAsync().catch((err) => {
    console.warn('signs disabled:', err);
    return null;
  }) : Promise.resolve(null);

  // Every traffic car is its own generated design, built now so nothing is
  // generated mid-run. See models.Fleet.
  const fleet = new Fleet(startSeed, TRAFFIC.fleetSize);
  await fleet.fill((f) => P(0.22 + f * 0.26, `Generating traffic · ${fleet.count} / ${fleet.size}`));

  const growing = setInterval(() =>
    P(0.48 + treeShare * 0.1, `Growing trees · ${Math.round(treeShare * 100)} %`), 100);
  const trees = await treesReady.finally(() => clearInterval(growing));
  const signs = await signsReady;

  const chunks = new ChunkManager({
    scene: gfx.scene, world, RAPIER, path, terrain, trees, signs,
    // Grass is seen at a grazing angle; that is why anisotropic filtering.
    anisotropy: gfx.renderer.capabilities.getMaxAnisotropy(),
  });

  P(0.6, 'Carving terrain');
  await frame();
  chunks.preload(START_S);

  // Rapier refreshes its query pipeline only in step(); ray casts return
  // null until one has run.
  world.step();

  P(0.78, 'Generating your car');
  await frame();
  const game = new Game({ gfx, world, path, terrain, chunks });
  game.seed = startSeed;
  game.input.bindTouch(document);
  game.autodrive.bind(document);
  try {
    game.setBuild(storedBuild() || firstBuild());
    game.applyBuild();
  } catch (err) {
    // A build saved by an older generator can fail to rebuild; start fresh.
    console.warn('[highroads] stored car unusable, generating a new one:', err && err.message);
    game.setBuild(firstBuild());
    game.applyBuild();
  }
  // Re-apply the sky now the lakes exist, so they reflect it; and let the
  // preset decide the lamps (a full-moon night starts with them on).
  game.setSky(gfx.skyName || 'day', false);

  game.fleet = fleet;
  // No world, no RAPIER: traffic owns no physics objects at all. See traffic.js.
  game.traffic = new Traffic({ scene: gfx.scene, path, chunks, fleet });
  game.setSky(gfx.skyName || 'day', false);

  P(0.92, 'Lighting the garage');
  await frame();
  game.studio = new GarageStudio(gfx);
  game.settings = new Settings(game);
  game.ui = new UI(game);
  game.ui.build();

  // Run the loop now, controls inert, so shaders compile and the suspension
  // settles before the title fades in.
  game.enterTitle({ show: false });
  game.loop(performance.now());
  P(1, 'Ready');
  await new Promise((r) => setTimeout(r, 350));
  game.ui.show('title');
  game.ui.bootDone();

  const startBtn = document.getElementById('start');
  startBtn.disabled = false;
  const begin = async () => {
    if (game.active) return;
    // A different world is a different page: the seed goes in the URL.
    const seed = game.ui.wantedSeed();
    if (seed) {
      const url = new URL(location.href);
      url.searchParams.set('seed', seed);
      location.href = url.toString();
      return;
    }
    // First AudioContext touch: must be inside this click.
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

  window.__highroads = game;
  return game;
}

/* ------------------------------------------------------------------------- */

class Game {
  constructor({ gfx, world, path, terrain, chunks }) {
    this.gfx = gfx;
    this.world = world;
    this.path = path;
    this.terrain = terrain;
    this.chunks = chunks;
    this.vehicle = null;
    /** The car being driven: its build (garage), model (car_gen) and spec (cars.js). */
    this.build = null;
    this.model = null;
    this.spec = null;
    this._appliedBuild = null;
    this.settings = null;
    this.traffic = null;
    this.fleet = null;
    this.studio = null;
    this.ui = null;
    this.headlights = false;
    this.flashing = false;
    /** True while the title screen engine blip is playing. */
    this.previewing = false;

    let mode = 'traffic';
    try { mode = localStorage.getItem(MODE_KEY) || mode; } catch { /* private mode */ }
    this.mode = GAME_MODES.includes(mode) ? mode : 'traffic';
    this.run = new ScoreRun();
    /** True while parked on the title screen (or in the garage) — distinct from merely not driving. */
    this.inGarage = true;
    /** True while the garage studio is the scene being drawn. */
    this.inStudio = false;
    this._impactMark = 0;

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
      hemi: gfx.hemi,
      sun: gfx.sun,
    });
    /** Exhaust flames on the engine simulator's pops. */
    this.flames = new ExhaustFlames();
    this.cam = new ChaseCamera(gfx.camera);
    /** Drives through `input` like a player would; see autodrive.js. */
    this.autodrive = new AutoDrive();
    this._sFrame = makeFrame();

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
      if (this.inGarage || !this.active) return;
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

  /* ---------------------------------------------------------------- car -- */

  /** Makes a build the current one and remembers it. The driven car follows on `applyBuild`. */
  setBuild(build) {
    this.build = build;
    try { localStorage.setItem(BUILD_KEY, JSON.stringify(build)); } catch { /* private mode */ }
  }

  /**
   * Rebuilds the driven car from the current build: a new model, a spec
   * derived from its shape, and a fresh raycast vehicle. The old ones are
   * disposed, so switching cars does not accumulate wrecks.
   */
  applyBuild() {
    const build = this.build;
    const model = mergeParts(buildModel(build, DETAIL.player));
    const spec = deriveSpec(build, model.metrics);
    const params = buildCarParams(spec, model.metrics, VEHICLE, Math.abs(WORLD.gravity));

    if (this.vehicle) this.vehicle.dispose();
    if (this.model) this.model.dispose();

    this.vehicle = new RaycastVehicle({
      RAPIER,
      world: this.world,
      scene: this.gfx.scene,
      params,
      model,
    });
    this.model = model;
    this.spec = spec;
    this._appliedBuild = JSON.stringify(build);
    // The title rig fits the car to the free rectangle from these.
    this.carMetrics = model.metrics;
    // The spec already carries the build's engine choice, resolved.
    this.powertrain.engineChoice = 'stock';
    this.powertrain.setCar(this.car());
    this.respawn(this.carS);
    if (this.inGarage) this.vehicle.setParked(true);
  }

  setMode(id) {
    this.mode = id;
    try { localStorage.setItem(MODE_KEY, id); } catch { /* private mode */ }
    if (this.traffic) this.traffic.setEnabled(id === 'traffic');
    this.hud.setMode(id);
  }

  // ------------------------------------------------------------ run flow --

  /** Ends driving without a verdict: the car stops being controlled. */
  stopRun() {
    this.setPaused(false);
    this.active = false;
  }

  /** Parks the car at the start of the road, camera orbiting, no HUD. */
  _park() {
    // Before `inGarage` flips, so the title keeps the audio context running.
    this.setPaused(false);
    this.powertrain.resume();
    this.active = false;
    this.inGarage = true;
    this.cam.setTitle(true);
    this.hud.hide();
    // The driving controls stay off over the menus.
    document.body.classList.remove('driving');
    if (this.traffic) this.traffic.dispose();
    this.carS = START_S;
    this.respawn(START_S);
    this.vehicle.setParked(true);
    this.fx.reset();
    this.wind.update(0, 0);
  }

  /** Back to the title screen. */
  enterTitle({ show = true } = {}) {
    this._park();
    if (this.ui) {
      this.ui.hideGameOver();
      if (show) this.ui.show('title');
    }
  }

  /** Into the garage studio; the road stops being simulated. */
  openStudio() {
    this._park();
    if (this.ui) this.ui.hideGameOver();
    this.inStudio = true;
    // Behind the wipe: a few traffic designs are retired for new ones.
    if (this.fleet) for (let i = 0; i < 3; i++) this.fleet.refreshOne();
    if (!this.studio.car || this.studio.carBuild !== this.build) {
      this.studio.showBuild(this.build, { materialise: false });
    }
    this.studio.setActive(true);
  }

  /** Out of the garage: the driven car is rebuilt if the build changed. */
  closeStudio() {
    this.inStudio = false;
    this.studio.setActive(false);
    if (JSON.stringify(this.build) !== this._appliedBuild) this.applyBuild();
    this.lastTime = performance.now();
    this.enterTitle({ show: false });
  }

  /**
   * Drive. From the title screen the camera flies into the chase position
   * (see `camera.beginIntro`). Restarting mid-run is a respawn with a cut.
   */
  startRun(restart = false) {
    if (this.ui) {
      this.ui.hideGameOver();
      this.ui.show('drive');
    }
    this.setPaused(false);
    this.inGarage = false;
    this.cam.setTitle(false);
    this.hud.show();
    document.body.classList.add('driving');
    this.hud.setMode(this.mode);
    this.input.bindTouch(document);
    this.vehicle.setParked(false);
    if (restart) this.carS = START_S;
    // Before the fly-in: a later respawn would eat the first frame of the shot.
    this.respawn(this.carS);
    if (!restart) this.cam.beginIntro();
    // Clear the previous run's marks; respawn is elsewhere.
    this.fx.reset();
    this.flames.reset();
    const ctx = this.powertrain.sim && this.powertrain.sim.ctx;
    this.wind.start(ctx);
    if (this.traffic) {
      if (restart) this.traffic.dispose();
      this.traffic.setEnabled(this.mode === 'traffic');
    }
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
    if (this.ui) this.ui.showGameOver(this.run, this.trip, record);
  }

  // ---------------------------------------------------------------- pause --

  /**
   * Pause. The loop returns before the accumulator is touched, so no time is
   * banked while paused and the frame still renders. Audio is suspended rather
   * than muted so the simulator does not idle behind the menu.
   */
  setPaused(on) {
    const want = !!on && !this.inGarage && this.active;
    if (want === this.paused) return;
    this.paused = want;
    document.body.classList.toggle('paused', want);
    if (this.ui) this.ui.setPaused(want);
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

  // ------------------------------------------------------- title framing --

  /**
   * Hands the title rig the slice of screen the interface is not using.
   * Measured from the DOM, because its shape changes with orientation and
   * the safe area.
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

  /**
   * Starts the audio if needed, swaps to `engineId` and blips the throttle —
   * the garage's engine preview. Leaving the garage restores the build's own.
   */
  async previewEngine(engineId = null) {
    if (!this.vehicle) return;
    try {
      if (!this.powertrain.sim) await this.powertrain.start(this.car());
      if (engineId) this.powertrain.setEngine(engineId);
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
    return { spec: this.spec, V: this.vehicle.V };
  }

  // -------------------------------------------------------------- respawn --

  /**
   * Switch the sky preset (sky.js): light, fog, grade, lakes and lamps.
   * `save` remembers it for the next session.
   */
  setSky(name, save = true) {
    const P = applySky(this.gfx, name, { water: this.chunks.water });
    if (save) saveSky(name);
    this.headlights = !!P.headlights;
    if (this.vehicle) this.vehicle.headlightBoost = P.night ? 24 : 1;
    if (this.traffic) this.traffic.lightsOn = !!(P.night || P.headlights);
    if (this.chunks.towns) this.chunks.towns.setNight(P.night);
    if (this.ui && save) this.ui.refreshTitle();
    return P;
  }

  /** The next preset in the list, for the settings button and the K key. */
  cycleSky() {
    const i = SKY_NAMES.indexOf(this.gfx.skyName || 'day');
    const name = SKY_NAMES[(i + 1) % SKY_NAMES.length];
    this.setSky(name);
    if (this.hud) this.hud.toast('sky: ' + SKY_PRESETS[name].label.toLowerCase());
    return name;
  }

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
    {
      // ...and the drawn, collidable ground around it, now rather than over
      // the next few frames.
      const p = this.path.frameAt(s).pos;
      this.chunks.tiles.preload(p.x, p.z, 260);
    }

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
    // Clamped at 0 as well: `lastTime` is reset to performance.now() on start
    // and unpause, and the next rAF timestamp is the frame's START, which can be
    // earlier. A negative dt makes every exponential damper extrapolate — the
    // FOV was measured at 997° after a slow respawn.
    // Dynamic resolution reads the true frame time, before the clamp.
    if (this.active && !this.paused) this.gfx.adapt(now - this.lastTime);
    const dt = clamp((now - this.lastTime) / 1000, 0, maxFrame);
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

    // The garage studio: its own scene; the road is not simulated meanwhile.
    // The powertrain still runs, so an engine swap can be heard.
    if (this.inStudio) {
      this.input.update(dt);
      this.powertrain.update(dt, {
        wheelSpeed: 0, throttle: this.powertrain.blipThrottle(dt), brake: 0, reverse: false, neutral: true,
      });
      this.studio.update(dt);
      this.studio.render();
      this.input.endFrame();
      return;
    }

    PERF.begin();
    this.input.update(dt);
    if (this.active) {
      // Before the one-shot keys: its shift presses are handled this frame.
      this.autodrive.drive(dt, this);
      this._handleActions();
    }

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
    // The sky decides how hard the lamps have to work (a new car per setCar
    // would otherwise lose it).
    this.vehicle.headlightBoost = (SKY_PRESETS[this.gfx.skyName] || SKY_PRESETS.day).night ? 24 : 1;
    this.vehicle.setHeadlights(this.headlights, this.flashing);

    PERF.lap('input');
    this.vehicle.setDriveForce(
      this.powertrain.update(dt, {
        wheelSpeed: this.vehicle.forwardSpeed,
        throttle: pedals.throttle,
        brake: pedals.brake,
        reverse,
        neutral: garage,
        // The driven tyres' grip: past it the wheels spin and the revs flare.
        grip: this.vehicle.driveGrip,
      })
    );
    this.vehicle.driveSlip = this.powertrain.wheelSlip + this.powertrain.launchSlip;

    PERF.lap('powertrain');
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

    PERF.lap('physics');
    // ---- world streaming -------------------------------------------------
    this.carS = this.path.projectPoint(this.vehicle.pos, this.carS);
    // The wind runs on wall time, not simulation time; it is scenery.
    this.chunks.advanceTime(dt);
    // Terrain tiles follow the CAR, which may be well off the road.
    this.chunks.focus = this.vehicle && this.active ? this.vehicle.pos : null;
    this.chunks.update(this.carS);
    PERF.lap('streaming');

    // Tyre effects read the wheel state just written by the substeps, so they
    // come after the loop and before anything renders.
    this.fx.update(dt, this.vehicle);
    this.flames.update(dt, this.vehicle, this.powertrain.sim);
    this.wind.update(dt, this.active ? this.vehicle.forwardSpeed : 0);

    PERF.lap('fx+wind');
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
    PERF.lap('traffic');

    // ---- presentation ----------------------------------------------------
    // The title screen and the road share one presentation path.
    if (this.inGarage) this._frameTitle();

    // Camera first: follow() re-centres the sky dome on this frame's position.
    if (this.active) this._feedSurroundings(dt);
    this.cam.update(dt, this.vehicle, this.chunks.field);
    // Legacy trees: draw only the instances in (or near) the view.
    this.chunks.culler.update(this.gfx.camera);
    if (this.chunks.forest) {
      this.chunks.forest.update(this.gfx.camera);
      this.chunks.forest.shadeCanopy(this.gfx.renderer, this.gfx.camera);
    }
    // Use the interpolated pose: the shadow frustum is centred here, and
    // 8.3 ms steps would crawl the shadows across everything.
    this.gfx.follow(this.vehicle.renderPos, dt);
    // The periphery streaks with speed; the centre stays sharp.
    this.gfx.setSpeedBlur(
      this.active
        ? smoothstep(6, ATMOSPHERE.speedBlurRef, Math.abs(this.vehicle.forwardSpeed))
        : 0
    );

    PERF.lap('camera');
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

    PERF.lap('hud');
    this.gfx.render();
    PERF.lap('render');
    PERF.end();

    // Any one-shot press not consumed this frame is lost.
    this.input.endFrame();
  }

  /**
   * What engine_sim hears: how far the lens is from the car (the cinematic
   * trackside shot is 50 m off), whether the road is in a cutting with walls
   * both sides, and how hard the engine is pulling uphill.
   */
  _feedSurroundings(dt) {
    const v = this.vehicle;
    const d = this.gfx.camera.position.distanceTo(v.renderPos);
    const f = this.path.frameAt(this.carS, this._sFrame);
    const rx = -f.tan.z, rz = f.tan.x, rl = Math.hypot(rx, rz) || 1;
    const field = this.chunks.field;
    let wall = 1;
    for (const side of [-1, 1]) {
      const x = f.pos.x + (rx / rl) * side * (ROAD.halfWidth + 6);
      const z = f.pos.z + (rz / rl) * side * (ROAD.halfWidth + 6);
      wall = Math.min(wall, smoothstep(2, 7, field.height(x, z) - f.pos.y));
    }
    const climb = clamp(v.fwd.y * 8, 0, 1);
    this.powertrain.setSurroundings(dt, {
      distance: smoothstep(8, 70, d),
      environment: wall * 0.55,
      strain: climb * (this.powertrain.load || 0),
    });
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
    if (this.input.consume('KeyK')) this.cycleSky();
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
        return;
      }
    }
    TiltSteering.remember(tilt.on);
    if (this.settings) this.settings.refresh();
  }

  setAutoShift(on) {
    const v = this.powertrain.setAutoShift(on);
    this.hud.toast(v ? 'automatic' : 'manual');
    if (this.settings) this.settings.refresh();
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
    // The ground is world-space tiles now and has no edge near the road, so
    // the corridor no longer bounds this; `edge` is kept for the record.
    void edge;
    const bound = CHUNK.recoverLateral;

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
