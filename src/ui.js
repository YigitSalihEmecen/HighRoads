/**
 * ui.js — every screen's DOM wiring.
 *
 * index.html owns the markup and the stylesheet; this module moves between
 * screens (with a wipe where the 3D scene changes underneath), drives the
 * loading bar, the title menu, mode select, the garage panel, the settings
 * and world sheets, pause and game over. Game logic stays in main.js; this module calls
 * the Game's methods and reads its state, nothing more.
 */

import { SPEC, OPTIONS, setPillarCount } from '../car_gen/src/index.js';
import { ENGINE_PROFILES } from '../engine_sim/src/profiles.js';
import {
  BODY_STYLES, CAR_COLORS, ENGINE_OPTIONS, DRIVE_OPTIONS, GEARBOX_OPTIONS,
  deriveSpec, bodyShape, classLabel,
} from './cars.js';
import { generateBuild, mutateBuild, finishBuild, newSeed } from './models.js';
import { PRESETS } from '../car_gen/src/index.js';
import { SKY_PRESETS } from './sky.js';
import { WORLD_BIOME } from './config.js';
import { PREMADE } from './premade.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const typing = () => {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.type !== 'range';
};

/* ------------------------------------------------------------- engines -- */

/** Peak power is not in the profiles; this is the estimate the stats card shows, kW. */
export function enginePower(id) {
  const p = ENGINE_PROFILES[id];
  if (!p) return 0;
  const rpm = Math.min(p.redlineRpm * 0.9, Math.max(p.peakTorqueRpm * 1.45, p.redlineRpm * 0.72));
  return (p.peakTorque * 0.88 * rpm * 2 * Math.PI) / 60 / 1000;
}

/* ---------------------------------------------------------- silhouettes -- */

/** A side-view icon for a car_gen preset, drawn from its own profile curve. */
function silhouette(P) {
  const x = (s) => (s < 0 ? s * P.overhangF : s <= 1 ? s * P.wheelbase : P.wheelbase + (s - 1) * P.overhangR);
  const pts = P.profile.map(([s, h]) => [x(s), h]);
  const x0 = x(-1), x1 = x(2);
  const W = x1 - x0, H = 2.1;
  const sx = (v) => ((v - x0) / W) * 96 + 2;
  const sy = (v) => 46 - (v / H) * 44;
  let d = `M${sx(x0)},${sy(P.chinZ)} L${sx(pts[0][0])},${sy(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    d += ` Q${sx(ax)},${sy(ay)} ${sx((ax + bx) / 2)},${sy((ay + by) / 2)}`;
  }
  d += ` L${sx(x1)},${sy(pts[pts.length - 1][1])} L${sx(x1)},${sy(P.tailBotZ)} L${sx(x0)},${sy(P.chinZ)} Z`;
  const r = (P.wheelR / H) * 44;
  const w = (cx) => `<circle cx="${sx(cx)}" cy="${sy(P.wheelR)}" r="${r}" fill="currentColor" stroke="#0d0e11" stroke-width="2.5"/>`;
  return `<svg viewBox="0 0 100 50" fill="none"><path d="${d}" fill="currentColor"/>${w(0)}${w(P.wheelbase)}</svg>`;
}

const ICONS = {
  generate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
  body: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M2.5 15.5v-2.2c0-.8.5-1.4 1.3-1.6l3.5-.9 2.6-3a2.4 2.4 0 011.8-.8h3.6c.8 0 1.5.4 2 1l2.3 2.9 1.4.4c.8.2 1.4 1 1.4 1.8v2.4"/><circle cx="7" cy="16" r="2"/><circle cx="17" cy="16" r="2"/><path d="M9 16h6"/></svg>',
  details: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.4"/><path d="M12 3.5v6.1M12 14.4v6.1M3.5 12h6.1M14.4 12h6.1"/></svg>',
  paint: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.2s6 6.4 6 10.6a6 6 0 01-12 0C6 9.6 12 3.2 12 3.2z"/><path d="M9.2 14.2a2.8 2.8 0 002.8 2.8"/></svg>',
  engine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 10h2V8h3V6h6v2h2l2 2h1.5v6H19l-2 2H8l-2-2H4z"/><path d="M2 11v4M10.5 11.5l-1.5 3h3l-1.5 3"/></svg>',
  saved: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/></svg>',
  dice: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12a8 8 0 11-2.3-5.6"/><path d="M20 4v4h-4"/></svg>',
};

/** car_gen's attachment groups; the rest of SPEC shapes the body. */
const ATTACH_GROUPS = new Set(['Rims', 'Roof', 'Headlights', 'Tail lights', 'Fenders', 'Body kit', 'Plates', 'Exhaust', 'Spoiler', 'Mirrors', 'Antenna', 'Grille', 'Hood']);

/** Which camera shot suits each parameter group. */
const GROUP_SHOT = {
  Wheels: 'wheel', Chassis: 'side', Nose: 'front', Tail: 'rear', Surface: 'overview', Character: 'side', Sculpt: 'overview',
  Greenhouse: 'side', Cabin: 'side', Rims: 'wheel', Roof: 'top', Headlights: 'front', 'Tail lights': 'rear',
  Fenders: 'wheel', 'Body kit': 'side', Plates: 'rear', Exhaust: 'rear', Spoiler: 'rear', Mirrors: 'front',
  Antenna: 'top', Grille: 'front', Hood: 'front', Trim: 'side', Finish: 'paint',
};

const FINISHES = [
  ['Gloss', 0.1, 0.22], ['Metallic', 0.62, 0.3], ['Pearl', 0.35, 0.14], ['Satin', 0.2, 0.52], ['Matte', 0.0, 0.78],
];

const SAVE_KEY = 'highroads.saved';
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY) || '[]'); } catch { return []; }
}
function storeSaved(list) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(list.slice(0, 24))); } catch { /* private mode */ }
}

/* =================================================================== UI == */

export class UI {
  constructor(game) {
    this.game = game;
    this.screen = 'boot';
    this._wiping = false;
    this.toast = (m) => game.hud.toast(m);
  }

  /* ------------------------------------------------------------ boot -- */

  static progress(frac, msg) {
    const f = $('boot-fill');
    if (f) f.style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`;
    const p = $('boot-pct');
    if (p) p.textContent = Math.round(frac * 100) + '%';
    if (msg) $('boot-msg').textContent = msg;
  }

  static tips() {
    const tips = [
      'Every car is generated from numbers — no two seeds build the same one.',
      'Flash your lights (hold F) and slower traffic pulls over to let you by.',
      'Near misses chain: keep threading gaps to grow the multiplier.',
      'In the garage, Mutate keeps the family resemblance and shuffles the rest.',
      'Any engine fits in any car; the gearbox is redesigned for the swap.',
      'A world seed is a link: share it and a friend drives the same road.',
    ];
    const t = $('boot-tip');
    if (t) t.textContent = tips[Math.floor(Math.random() * tips.length)];
  }

  bootDone() {
    $('boot-screen').classList.add('done');
  }

  /* ------------------------------------------------------- screens -- */

  /** Shows one of the full-screen layers; 'drive' shows none of them. */
  show(name) {
    this.screen = name;
    document.body.dataset.screen = name;
    for (const [id, key] of [['title-screen', 'title'], ['mode-screen', 'mode'], ['garage-screen', 'garage']]) {
      $(id).classList.toggle('on', key === name);
    }
    if (name === 'title') {
      this.refreshTitle();
      this._menuSelect(this._menuIndex || 0);
    }
    if (name === 'mode') this._refreshMode();
    if (name === 'garage') this.garage.open();
  }

  /**
   * Covers the screen, runs `fn` (which may swap whole scenes), uncovers.
   * Heavy work inside `fn` is invisible.
   */
  async wipe(fn) {
    if (this._wiping) return;
    this._wiping = true;
    const bars = [...$('wipe').children];
    const opts = (i) => ({ duration: 520, delay: i * 70, easing: 'cubic-bezier(0.65,0,0.35,1)', fill: 'forwards' });
    await Promise.all(bars.map((b, i) => b.animate(
      [{ transform: 'translateX(-130%) skewX(-14deg)' }, { transform: 'translateX(0) skewX(-14deg)' }], opts(i)
    ).finished));
    await frame();
    try { await fn(); } catch (err) { console.error(err); }
    await frame();
    await frame();
    await Promise.all(bars.map((b, i) => b.animate(
      [{ transform: 'translateX(0) skewX(-14deg)' }, { transform: 'translateX(130%) skewX(-14deg)' }],
      { ...opts(bars.length - 1 - i), duration: 600 }
    ).finished));
    for (const b of bars) b.getAnimations().forEach((a) => a.cancel());
    this._wiping = false;
  }

  /* ---------------------------------------------------------- build -- */

  build() {
    this._buildWordmark();
    this._buildTitleMenu();
    this._buildMode();
    this._buildPause();
    this._buildGameOver();
    this._buildSettingsSheet();
    this._buildModals();
    this.garage = new GarageUI(this);
  }

  _buildWordmark() {
    const h = $('wordmark');
    [...'HIGHROADS'].forEach((c, i) => {
      const s = el('span', i >= 4 ? 'hl' : '', c);
      s.style.setProperty('--c', i);
      h.appendChild(s);
    });
  }

  /* ----------------------------------------------------------- title -- */

  _buildTitleMenu() {
    const items = [...$('main-menu').querySelectorAll('.menu-item')];
    this._menuItems = items;
    items.forEach((it, i) => {
      it.addEventListener('mouseenter', () => this._menuSelect(i));
      it.addEventListener('focus', () => this._menuSelect(i));
      it.addEventListener('click', () => this._menuAction(it.dataset.action));
    });
    $('title-car').addEventListener('click', () => this.openGarage());

    document.addEventListener('keydown', (e) => {
      if (typing() || this._wiping) return;
      if (this._modalOpen() || this._sheetOpen()) return;
      if (this.screen === 'title') {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const n = items.length;
          this._menuSelect(((this._menuIndex || 0) + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
          items[this._menuIndex].focus({ preventScroll: true });
        } else if (e.key === 'Enter') {
          e.preventDefault();
          this._menuAction(items[this._menuIndex || 0].dataset.action);
        }
      } else if (this.screen === 'mode') {
        if (e.key === 'Escape') this.show('title');
        else if (e.key === 'Enter') { e.preventDefault(); $('start').click(); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') this._pickMode(this.game.mode === 'traffic' ? 'zen' : 'traffic');
      }
    });
  }

  _menuSelect(i) {
    this._menuIndex = i;
    this._menuItems.forEach((it, k) => it.classList.toggle('sel', k === i));
  }

  _menuAction(action) {
    if (action === 'drive') this.show('mode');
    else if (action === 'garage') this.openGarage();
    else if (action === 'world') this.openWorld();
    else if (action === 'settings') this.openSettings();
    else if (action === 'howto') $('modal-howto').hidden = false;
    else if (action === 'credits') $('modal-credits').hidden = false;
  }

  refreshTitle() {
    const g = this.game;
    const b = g.build;
    if (!b) return;
    const spec = g.vehicle ? g.vehicle.V : null;
    $('tc-swatch').style.background = b.color;
    $('tc-name').textContent = b.name;
    const eng = spec && ENGINE_PROFILES[spec.engine];
    $('tc-sub').textContent = [
      classLabel(bodyShape(b.params, g.model ? g.model.metrics : { bodyHeight: 1.4 }), b.style),
      eng ? eng.label : '',
      spec ? spec.drive.toUpperCase() : '',
    ].filter(Boolean).join(' · ');
    $('tc-seed').textContent = this._worldName();
    const sky = SKY_PRESETS[g.gfx.skyName] || SKY_PRESETS.day;
    $('tc-sky').textContent = sky.label;
  }

  openGarage() {
    if (this.screen === 'garage') return;
    this.wipe(async () => {
      this.game.openStudio();
      this.show('garage');
    });
  }

  /** Leaves the garage for the road: the driven car is rebuilt from the build behind the wipe. */
  closeGarage(next = 'title') {
    this.wipe(async () => {
      this.game.closeStudio();
      this.show(next);
    });
  }

  /* ------------------------------------------------------------ mode -- */

  _buildMode() {
    for (const c of document.querySelectorAll('.mode-card')) {
      c.addEventListener('click', () => this._pickMode(c.dataset.mode));
      c.addEventListener('dblclick', () => $('start').click());
    }
    $('mode-back').addEventListener('click', () => this.show('title'));
  }

  /** The world in a few words: its seed and, off the default, its biome. */
  _worldName() {
    return WORLD_BIOME.label === 'Temperate' ? this.game.seed : `${this.game.seed} · ${WORLD_BIOME.label}`;
  }

  _pickMode(id) {
    this.game.setMode(id);
    for (const c of document.querySelectorAll('.mode-card')) c.classList.toggle('sel', c.dataset.mode === id);
  }

  _refreshMode() {
    this._pickMode(this.game.mode);
    $('mode-best').textContent = Math.round(this.game.run.best).toLocaleString();
    $('mode-world').textContent = this._worldName();
  }

  /* ----------------------------------------------------------- pause -- */

  _buildPause() {
    const g = this.game;
    $('pause-btn').addEventListener('click', () => g.setPaused(true));
    $('pause-resume').addEventListener('click', () => g.setPaused(false));
    $('pause-restart').addEventListener('click', () => { g.setPaused(false); g.startRun(true); });
    $('pause-settings').addEventListener('click', () => this.openSettings());
    $('pause-garage').addEventListener('click', () => { g.setPaused(false); g.stopRun(); this.openGarage(); });
    $('pause-title').addEventListener('click', () => this.wipe(async () => { g.setPaused(false); g.enterTitle(); }));
    const root = $('pause');
    root.addEventListener('keydown', (e) => e.stopPropagation());
    root.addEventListener('keyup', (e) => e.stopPropagation());
  }

  setPaused(on) {
    $('pause').classList.toggle('on', on);
    if (on) $('pause-resume').focus({ preventScroll: true });
  }

  /* ------------------------------------------------------- game over -- */

  _buildGameOver() {
    const g = this.game;
    $('go-again').addEventListener('click', () => g.startRun(true));
    $('go-garage').addEventListener('click', () => { this.hideGameOver(); g.stopRun(); this.openGarage(); });
    $('go-title').addEventListener('click', () => this.wipe(async () => g.enterTitle()));
  }

  showGameOver(run, trip, record) {
    $('go-best').textContent = Math.round(run.best).toLocaleString();
    $('go-detail').textContent =
      `${run.passes} near ${run.passes === 1 ? 'miss' : 'misses'} · ${(trip / 1000).toFixed(2)} km`;
    $('go-record').textContent = record ? 'New personal best' : '';
    $('gameover').classList.add('on');
    // Count the score up rather than printing it.
    const target = Math.round(run.score);
    const out = $('go-points');
    const t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / 1200);
      out.textContent = Math.round(target * (1 - Math.pow(1 - k, 3))).toLocaleString();
      if (k < 1 && $('gameover').classList.contains('on')) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(() => $('go-again').focus({ preventScroll: true }), 600);
  }

  hideGameOver() {
    $('gameover').classList.remove('on');
  }

  /* -------------------------------------------------------- settings -- */

  _buildSettingsSheet() {
    $('settings-close').addEventListener('click', () => this.closeSettings());
    $('g-settings').addEventListener('click', () => this.openSettings());
    $('settings-screen').addEventListener('click', (e) => { if (e.target.id === 'settings-screen') this.closeSettings(); });
    $('world-close').addEventListener('click', () => this.closeWorld());
    $('world-screen').addEventListener('click', (e) => { if (e.target.id === 'world-screen') this.closeWorld(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if ($('settings-screen').classList.contains('on')) { e.stopPropagation(); this.closeSettings(); }
      else if ($('world-screen').classList.contains('on')) { e.stopPropagation(); this.closeWorld(); }
    }, true);
  }

  _sheetOpen() {
    return $('settings-screen').classList.contains('on') || $('world-screen').classList.contains('on');
  }

  openWorld() {
    this.game.worldSheet.refresh();
    $('world-screen').classList.add('on');
  }

  closeWorld() {
    $('world-screen').classList.remove('on');
    this.refreshTitle();
  }

  openSettings() {
    this.game.settings.refresh();
    $('settings-screen').classList.add('on');
  }

  closeSettings() {
    $('settings-screen').classList.remove('on');
    this.refreshTitle();
  }

  /* ---------------------------------------------------------- modals -- */

  _modalOpen() {
    return !$('modal-howto').hidden || !$('modal-credits').hidden;
  }

  _buildModals() {
    for (const id of ['modal-howto', 'modal-credits']) {
      const m = $(id);
      m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('.modal-close')) m.hidden = true; });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this._modalOpen()) return;
      $('modal-howto').hidden = true;
      $('modal-credits').hidden = true;
    });
  }
}

/* ============================================================ GARAGE UI == */

class GarageUI {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.studio = ui.game.studio;
    this.undoStack = [];
    this.history = [];
    this.style = this.game.build.style || null;
    this._rebuildAt = 0;
    this._pending = null;
    this._dragSnap = null;

    this._buildTabs();
    this._buildShots();
    this._buildActions();
    window.addEventListener('resize', () => this._measure());
    document.addEventListener('keydown', (e) => this._keys(e));
  }

  get build() {
    return this.game.build;
  }

  open() {
    this._remember(this.build);
    this._syncAll();
    this.select(this.tab || 'generate');
    requestAnimationFrame(() => this._measure());
    setTimeout(() => this._measure(), 700);
  }

  /** Centres the car in whatever the panels leave free. */
  _measure() {
    if (this.ui.screen !== 'garage') return;
    const panel = document.querySelector('.g-panel').getBoundingClientRect();
    const stats = $('g-stats').getBoundingClientRect();
    const top = document.querySelector('.g-top').getBoundingClientRect();
    const bottom = document.querySelector('.g-bottom').getBoundingClientRect();
    const portrait = innerHeight > innerWidth;
    const rect = portrait
      ? { left: 0, right: innerWidth, top: stats.bottom, bottom: panel.top }
      : { left: panel.right, right: stats.left, top: top.bottom, bottom: bottom.top };
    rect.width = rect.right - rect.left;
    this.studio.setFreeRect(rect);
  }

  /* ----------------------------------------------------------- tabs -- */

  _buildTabs() {
    const tabs = $('g-tabs'), body = $('g-body');
    this.pages = {};
    this.tabBtns = {};
    const defs = [
      ['generate', 'Create', (p) => this._pageGenerate(p)],
      ['body', 'Body', (p) => this._pageParams('body', p)],
      ['details', 'Parts', (p) => this._pageParams('attachments', p)],
      ['paint', 'Paint', (p) => this._pagePaint(p)],
      ['engine', 'Engine', (p) => this._pageEngine(p)],
      ['saved', 'Saved', (p) => this._pageSaved(p)],
    ];
    for (const [id, label, make] of defs) {
      const b = el('button', 'g-tab', `${ICONS[id]}<span>${label}</span>`);
      b.type = 'button';
      b.addEventListener('click', () => this.select(id));
      tabs.appendChild(b);
      this.tabBtns[id] = b;
      const page = el('div', 'g-page');
      page.dataset.page = id;
      body.appendChild(page);
      this.pages[id] = page;
      make(page);
    }
  }

  select(id) {
    this.tab = id;
    for (const k in this.pages) {
      this.pages[k].classList.toggle('on', k === id);
      this.tabBtns[k].classList.toggle('on', k === id);
    }
    const shot = { generate: 'overview', body: 'side', details: 'front', paint: 'paint', engine: 'front', saved: 'overview' }[id];
    this._shot(shot);
    if (id === 'saved') this._renderSaved();
  }

  _shot(name) {
    this.studio.focus(name);
    for (const b of $('g-shots').children) b.classList.toggle('on', b.dataset.shot === name);
  }

  _buildShots() {
    const host = $('g-shots');
    for (const [id, label] of [['overview', 'Orbit'], ['front', 'Front'], ['side', 'Side'], ['rear', 'Rear'], ['wheel', 'Wheel'], ['top', 'Top']]) {
      const b = el('button', 'shot', label);
      b.type = 'button';
      b.dataset.shot = id;
      b.addEventListener('click', () => this._shot(id));
      host.appendChild(b);
    }
  }

  /* -------------------------------------------------------- generate -- */

  _pageGenerate(page) {
    page.append(el('div', 'g-h', '<h3>Create</h3><small>Pick a body style, then generate</small>'));
    page.append(el('div', 'g-sub', 'Body style'));
    const grid = el('div', 'style-grid');
    this.styleCards = [];
    const any = { id: null, name: 'Anything', blurb: 'Free generation. Expect surprises.' };
    for (const s of [any, ...BODY_STYLES]) {
      const card = el('button', 'style-card',
        `${s.id ? silhouette(PRESETS[s.id]) : ICONS.generate}<b>${s.name}</b><small>${s.blurb}</small>`);
      card.type = 'button';
      card.addEventListener('click', () => {
        this.style = s.id;
        this._syncStyles();
        this.generate();
      });
      grid.appendChild(card);
      this.styleCards.push({ id: s.id, el: card });
    }
    page.append(grid);

    const gen = el('button', 'btn primary gen-btn', `${ICONS.dice} Generate <span class="key">G</span>`);
    gen.type = 'button';
    gen.addEventListener('click', () => this.generate());
    page.append(gen);

    page.append(el('div', 'g-sub', 'Seed'));
    const row = el('div', 'row');
    this.seedInput = el('input', 'input');
    this.seedInput.type = 'text';
    this.seedInput.maxLength = 16;
    this.seedInput.spellcheck = false;
    this.seedInput.setAttribute('aria-label', 'Car seed');
    this.seedInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') load(); });
    this.seedInput.addEventListener('keyup', (e) => e.stopPropagation());
    const load = () => {
      const s = this.seedInput.value.trim().toUpperCase();
      if (s) this.apply(generateBuild(s, this.style), { materialise: true });
    };
    const go = el('button', 'btn sm', 'Build');
    go.type = 'button';
    go.addEventListener('click', load);
    row.append(this.seedInput, go);
    page.append(row);

    page.append(el('div', 'g-sub', 'Recent'));
    this.historyEl = el('div', 'history');
    page.append(this.historyEl);
  }

  _syncStyles() {
    for (const c of this.styleCards) c.el.classList.toggle('on', c.id === this.style);
  }

  generate() {
    if (this.studio.busy) return;
    this.apply(generateBuild(newSeed(), this.style), { materialise: true });
  }

  mutate() {
    if (this.studio.busy) return;
    this.apply(mutateBuild(this.build, 0.22), { materialise: true });
  }

  _remember(b) {
    this.history = [b, ...this.history.filter((h) => h.seed !== b.seed)].slice(0, 12);
    if (!this.historyEl) return;
    this.historyEl.innerHTML = '';
    for (const h of this.history) {
      const c = el('button', 'hist' + (h.seed === this.build.seed ? ' on' : ''), `<i style="background:${h.color}"></i><b>${h.name}</b><small>${h.seed}</small>`);
      c.type = 'button';
      c.addEventListener('click', () => this.apply(clone(h), { materialise: true }));
      this.historyEl.appendChild(c);
    }
  }

  /* ---------------------------------------------------------- params -- */

  /** Sliders and option pills straight from car_gen's schema, one fold per group. */
  _pageParams(tab, page) {
    const title = tab === 'body' ? ['Body', 'Proportions, surfaces and the glasshouse'] : ['Parts', 'Lamps, wheels, aero and roof gear'];
    page.append(el('div', 'g-h', `<h3>${title[0]}</h3><small>${title[1]}</small>`));
    this.paramRows = this.paramRows || [];
    let first = true;
    for (const [group, rows] of SPEC) {
      const groupTab = ATTACH_GROUPS.has(group) ? 'attachments' : 'body';
      if (groupTab !== tab || group === 'Finish') continue;
      const g = el('div', 'p-group' + (first ? ' open' : ''));
      first = false;
      const head = el('button', 'p-head', `<span>${group}</span><span class="caret"></span>`);
      head.type = 'button';
      head.addEventListener('click', () => {
        const on = !g.classList.contains('open');
        g.classList.toggle('open', on);
        if (on) this._shot(GROUP_SHOT[group] || 'overview');
      });
      const fold = el('div', 'p-fold');
      const inner = el('div');
      const list = el('div', 'p-rows');
      for (const [key, label, min, max, step, unit = ''] of rows) {
        list.appendChild(OPTIONS[key] ? this._pills(key, label, OPTIONS[key]) : this._slider(key, label, min, max, step, unit));
      }
      inner.append(list);
      fold.append(inner);
      g.append(head, fold);
      page.append(g);
    }
  }

  _value(key) {
    const P = this.build.params;
    return key === 'pillarCount' ? P.pillars.length : P[key];
  }

  _slider(key, label, min, max, step, unit) {
    const row = el('label', 'slider');
    const name = el('span', 'sl-name', label);
    const val = el('span', 'sl-val num');
    const input = el('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    const fmt = (v) => {
      const d = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
      return unit === 'm' && Math.abs(v) < 1 && step < 0.01 ? `${Math.round(v * 1000)} mm` : `${(+v).toFixed(d)}${unit ? ' ' + unit : ''}`;
    };
    const paint = () => {
      const v = this._value(key);
      input.value = v;
      val.textContent = fmt(v);
      input.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`);
    };
    input.addEventListener('pointerdown', () => { this._dragSnap = clone(this.build); });
    input.addEventListener('input', () => {
      if (!this._dragSnap) this._dragSnap = clone(this.build);
      const v = parseFloat(input.value);
      const next = this.build;
      if (key === 'pillarCount') setPillarCount(next.params, v);
      else next.params[key] = v;
      val.textContent = fmt(v);
      input.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`);
      this._liveRebuild();
    });
    input.addEventListener('change', () => {
      if (this._dragSnap) this.undoStack.push(this._dragSnap);
      this._dragSnap = null;
      this._liveRebuild(true);
      input.blur();
    });
    row.append(name, val, input);
    this.paramRows.push(paint);
    return row;
  }

  _pills(key, label, options) {
    const wrap = el('div');
    wrap.append(el('div', 'sl-name', label));
    const pills = el('div', 'pills');
    const btns = options.map((name, i) => {
      const b = el('button', 'pill', name);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.undoStack.push(clone(this.build));
        this.build.params[key] = i;
        paint();
        this._liveRebuild(true);
      });
      pills.appendChild(b);
      return b;
    });
    const paint = () => {
      const v = Math.round(this._value(key));
      btns.forEach((b, i) => b.classList.toggle('on', i === v));
    };
    wrap.append(pills);
    this.paramRows.push(paint);
    return wrap;
  }

  /** Slider drags rebuild at most ~9 times a second; release always rebuilds once more. */
  _liveRebuild(final = false) {
    clearTimeout(this._pending);
    const now = performance.now();
    const run = () => {
      this._rebuildAt = performance.now();
      this.game.setBuild(this.build, { quiet: true });
      this.studio.showBuild(this.build, { materialise: false });
      this._syncStats();
    };
    if (final || now - this._rebuildAt > 110) run();
    else this._pending = setTimeout(run, 110 - (now - this._rebuildAt));
  }

  /* ----------------------------------------------------------- paint -- */

  _pagePaint(page) {
    page.append(el('div', 'g-h', '<h3>Paint</h3><small>Colour, contrast roof and finish</small>'));
    page.append(el('div', 'g-sub', 'Body colour'));
    this.paintSw = this._swatches(page, (hex) => {
      this.undoStack.push(clone(this.build));
      this.build.color = hex;
      this.build.params.color = hex;
      this._repaint();
    }, false);

    page.append(el('div', 'g-sub', 'Contrast roof'));
    this.trimSw = this._swatches(page, (hex) => {
      this.undoStack.push(clone(this.build));
      this.build.trim = hex;
      this._repaint();
    }, true);

    page.append(el('div', 'g-sub', 'Finish'));
    const pills = el('div', 'pills');
    this.finishBtns = FINISHES.map(([name, metal, rough]) => {
      const b = el('button', 'pill', name);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.undoStack.push(clone(this.build));
        Object.assign(this.build.params, { metal, rough });
        this._repaint();
      });
      pills.appendChild(b);
      return { b, metal, rough };
    });
    page.append(pills);

    this.finishSliders = [];
    for (const [key, label] of [['metal', 'Metallic'], ['rough', 'Roughness']]) {
      const row = el('label', 'slider');
      const val = el('span', 'sl-val num');
      const input = el('input');
      input.type = 'range';
      input.min = key === 'rough' ? 0.05 : 0;
      input.max = key === 'rough' ? 0.8 : 1;
      input.step = 0.01;
      input.addEventListener('pointerdown', () => this.undoStack.push(clone(this.build)));
      input.addEventListener('input', () => {
        this.build.params[key] = parseFloat(input.value);
        this._repaint();
      });
      input.addEventListener('change', () => input.blur());
      row.append(el('span', 'sl-name', label), val, input);
      page.append(row);
      this.finishSliders.push(() => {
        const v = this.build.params[key];
        input.value = v;
        val.textContent = (+v).toFixed(2);
        input.style.setProperty('--p', `${((v - input.min) / (input.max - input.min)) * 100}%`);
      });
    }
  }

  _swatches(page, onPick, allowNone) {
    const grid = el('div', 'swatches');
    const items = [];
    if (allowNone) {
      const n = el('button', 'sw none');
      n.type = 'button';
      n.title = 'None';
      n.setAttribute('aria-label', 'No contrast roof');
      n.addEventListener('click', () => onPick(null));
      grid.appendChild(n);
      items.push({ hex: null, el: n });
    }
    for (const c of CAR_COLORS) {
      const s = el('button', 'sw');
      s.type = 'button';
      s.title = c.name;
      s.setAttribute('aria-label', c.name);
      s.style.background = c.hex;
      s.addEventListener('click', () => onPick(c.hex));
      grid.appendChild(s);
      items.push({ hex: c.hex, el: s });
    }
    const custom = el('label', 'sw custom');
    custom.title = 'Custom colour';
    const picker = el('input');
    picker.type = 'color';
    picker.setAttribute('aria-label', 'Custom colour');
    picker.addEventListener('input', () => onPick(picker.value));
    custom.appendChild(picker);
    grid.appendChild(custom);
    page.append(grid);
    return { items, custom, picker };
  }

  _repaint() {
    this.game.setBuild(this.build, { quiet: true });
    this.studio.repaint(this.build);
    this._syncPaint();
    $('g-name').textContent = this.build.name;
  }

  /* ---------------------------------------------------------- engine -- */

  _pageEngine(page) {
    page.append(el('div', 'g-h', '<h3>Powertrain</h3><small>Any engine fits; the gearbox is redesigned to suit</small>'));
    page.append(el('div', 'g-sub', 'Drive'));
    this.drivePills = this._choice(page, DRIVE_OPTIONS, 'drive');
    page.append(el('div', 'g-sub', 'Gearbox'));
    this.boxPills = this._choice(page, GEARBOX_OPTIONS, 'gearbox');
    page.append(el('div', 'g-sub', 'Engine'));
    const list = el('div', 'engine-list');
    const maxP = Math.max(...Object.keys(ENGINE_PROFILES).map(enginePower));
    this.engineBtns = ENGINE_OPTIONS.map((o) => {
      const b = el('button', 'engine');
      b.type = 'button';
      const fill = (id) => {
        const p = ENGINE_PROFILES[id];
        const kw = enginePower(id);
        b.innerHTML = `<b>${o.id === 'stock' ? 'Stock' : o.name}</b><span class="e-num num">${Math.round(kw * 1.341)} hp</span>` +
          `<small>${p ? `${p.label} · ${p.peakTorque} Nm · ${p.redlineRpm} rpm` : ''}</small><span></span>` +
          `<span class="e-bar"><i style="transform:scaleX(${(kw / maxP).toFixed(3)})"></i></span>`;
      };
      b.addEventListener('click', () => {
        this.undoStack.push(clone(this.build));
        this.build.engine = o.id;
        this.game.setBuild(this.build, { quiet: true });
        this._syncEngine();
        this._syncStats();
        this.game.previewEngine(this._spec().engine);
      });
      list.appendChild(b);
      return { id: o.id, b, fill };
    });
    page.append(list);
  }

  _choice(page, options, field) {
    const pills = el('div', 'pills');
    const btns = options.map((o) => {
      const b = el('button', 'pill', o.name);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.undoStack.push(clone(this.build));
        this.build[field] = o.id;
        this.game.setBuild(this.build, { quiet: true });
        this._syncEngine();
        this._syncStats();
      });
      pills.appendChild(b);
      return { id: o.id, b };
    });
    page.append(pills);
    return btns;
  }

  /* ----------------------------------------------------------- saved -- */

  _pageSaved(page) {
    page.append(el('div', 'g-h', '<h3>Saved</h3><small>Builds kept on this device</small>'));
    const save = el('button', 'btn sm', 'Save current build');
    save.type = 'button';
    save.addEventListener('click', () => this.save());
    page.append(save);
    this.savedEl = el('div', 'saved-grid');
    page.append(this.savedEl);
    page.append(el('div', 'g-h', '<h3>Premade</h3><small>Cars that ship with the game</small>'));
    const premade = el('div', 'saved-grid');
    for (const b of PREMADE) premade.append(this._savedRow(b));
    page.append(premade);
  }

  _savedRow(b, onDelete) {
    const row = el('div', 'saved', `<i style="background:${b.color}"></i><b>${b.name}</b><small>${b.seed} · ${b.engine === 'stock' ? 'stock engine' : b.engine}</small>`);
    const act = el('div', 's-act');
    const load = el('button', 'btn sm', 'Load');
    load.type = 'button';
    load.addEventListener('click', () => this.apply(finishBuild(clone(b)), { materialise: true }));
    act.append(load);
    if (onDelete) {
      const del = el('button', 'icon-btn', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>');
      del.type = 'button';
      del.setAttribute('aria-label', 'Delete ' + b.name);
      del.style.width = del.style.height = '36px';
      del.addEventListener('click', onDelete);
      act.append(del);
    }
    row.append(act);
    return row;
  }

  save() {
    const list = loadSaved().filter((b) => b.seed !== this.build.seed);
    list.unshift(clone(this.build));
    storeSaved(list);
    this.ui.toast('build saved');
    this._renderSaved();
  }

  _renderSaved() {
    if (!this.savedEl) return;
    const list = loadSaved();
    this.savedEl.innerHTML = '';
    if (!list.length) {
      this.savedEl.append(el('div', 'empty', 'Nothing saved yet. Generate something you like and press Save.'));
      return;
    }
    for (const b of list) {
      this.savedEl.append(this._savedRow(b, () => { storeSaved(loadSaved().filter((x) => x.seed !== b.seed)); this._renderSaved(); }));
    }
  }

  /* --------------------------------------------------------- actions -- */

  _buildActions() {
    $('g-back').addEventListener('click', () => this.ui.closeGarage('title'));
    $('g-drive').addEventListener('click', () => this.ui.closeGarage('mode'));
    $('g-undo').addEventListener('click', () => this.undo());
    $('g-mutate').addEventListener('click', () => this.mutate());
    $('g-save').addEventListener('click', () => this.save());
  }

  _keys(e) {
    if (this.ui.screen !== 'garage' || typing() || this.ui._wiping) return;
    if ($('settings-screen').classList.contains('on')) return;
    if (e.code === 'KeyG') this.generate();
    else if (e.code === 'KeyM') this.mutate();
    else if (e.code === 'KeyZ') this.undo();
    else if (e.key === 'Escape') this.ui.closeGarage('title');
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) { this.ui.toast('nothing to undo'); return; }
    this.apply(prev, { materialise: false, undoable: false });
  }

  /** Makes `build` the current one: the studio shows it, the game keeps it. */
  apply(build, { materialise = false, undoable = true } = {}) {
    if (undoable) this.undoStack.push(clone(this.build));
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.game.setBuild(build);
    this.studio.showBuild(build, { materialise });
    this._remember(build);
    this._syncAll();
  }

  /* ------------------------------------------------------------ sync -- */

  _spec() {
    return deriveSpec(this.build, this.studio.car ? this.studio.car.metrics : this.game.model.metrics);
  }

  _syncAll() {
    $('g-name').textContent = this.build.name;
    if (this.seedInput) this.seedInput.value = this.build.seed;
    this._syncStyles();
    for (const p of this.paramRows || []) p();
    this._syncPaint();
    this._syncEngine();
    this._syncStats();
  }

  _syncPaint() {
    const b = this.build;
    const same = (a, c) => a && c && a.toLowerCase() === c.toLowerCase();
    let hit = false;
    for (const it of this.paintSw.items) { const on = same(it.hex, b.color); it.el.classList.toggle('on', on); hit = hit || on; }
    this.paintSw.custom.classList.toggle('on', !hit);
    this.paintSw.picker.value = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#888888';
    hit = false;
    for (const it of this.trimSw.items) { const on = it.hex === null ? !b.trim : same(it.hex, b.trim); it.el.classList.toggle('on', on); hit = hit || on; }
    this.trimSw.custom.classList.toggle('on', !hit);
    for (const f of this.finishBtns) {
      f.b.classList.toggle('on', Math.abs(f.metal - b.params.metal) < 0.02 && Math.abs(f.rough - b.params.rough) < 0.02);
    }
    for (const s of this.finishSliders) s();
  }

  _syncEngine() {
    const spec = this._spec();
    for (const e of this.engineBtns) {
      e.fill(e.id === 'stock' ? spec.engine : e.id);
      e.b.classList.toggle('on', (this.build.engine || 'stock') === e.id);
    }
    for (const p of this.drivePills) p.b.classList.toggle('on', (this.build.drive || 'stock') === p.id);
    for (const p of this.boxPills) p.b.classList.toggle('on', (this.build.gearbox || 'stock') === p.id);
  }

  _syncStats() {
    const b = this.build;
    const metrics = this.studio.car ? this.studio.car.metrics : this.game.model.metrics;
    const spec = deriveSpec(b, metrics);
    const eng = ENGINE_PROFILES[spec.engine];
    const kw = enginePower(spec.engine);
    const hp = kw * 1.341;
    const top = Math.min(400, Math.cbrt((kw * 1000 * 0.85) / spec.dragCoefficient) * 3.6);
    const [make, ...rest] = b.name.split(' ');
    $('gs-make').textContent = make;
    $('gs-model').textContent = rest.join(' ');
    $('gs-class').textContent = classLabel(bodyShape(b.params, metrics), b.style);
    const set = (id, text, frac) => {
      $('gs-' + id).innerHTML = text;
      $('gb-' + id).style.transform = `scaleX(${Math.max(0.02, Math.min(1, frac)).toFixed(3)})`;
    };
    set('power', `${Math.round(hp)}<small>HP</small>`, hp / 800);
    set('torque', `${eng ? eng.peakTorque : 0}<small>NM</small>`, (eng ? eng.peakTorque : 0) / 950);
    set('mass', `${spec.mass.toLocaleString()}<small>KG</small>`, (spec.mass - 700) / 2100);
    set('pw', `${Math.round(hp / (spec.mass / 1000))}<small>HP/T</small>`, hp / (spec.mass / 1000) / 500);
    set('grip', `${spec.grip.toFixed(2)}<small>μ</small>`, (spec.grip - 1) / 0.5);
    set('top', `${Math.round(top)}<small>KM/H</small>`, (top - 120) / 260);
    const tags = $('gs-tags');
    tags.innerHTML = '';
    for (const t of [spec.drive.toUpperCase(), { dct: 'Dual-clutch', manual: 'Manual', auto: 'Automatic' }[spec.gearbox], eng ? eng.label : '']) {
      if (t) tags.append(el('span', 'tag', t));
    }
  }
}

export { frame };
