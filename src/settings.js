/**
 * settings.js — the settings sheet, and the world sheet.
 *
 * Settings is opened from the title, the garage and the pause menu. Each
 * `_page` is a tab: graphics, driving (gearbox, camera, tilt) and audio (the
 * engine simulator's buses and tone, wind).
 *
 * World (the title's World button) is everything about the place you drive:
 * seed, biome, sky, the road, the landscape and what grows on it. All but the
 * sky are applied by rebuilding the world.
 */

import { TiltSteering } from './input.js';
import { CAM_MODES } from './camera.js';
import {
  GRAPHICS_LEVELS, graphicsLevel, setGraphicsLevel, TREES, setTreeGenerator,
  TERRAIN_SPEC, terrainSettings, terrainDefault, saveTerrain, WORLDS,
} from './config.js';
import { SKY_PRESETS } from './sky.js';

/**
 * One line per level; keep them true to config.js:applyGraphics.
 */
const GFX_NOTES = {
  high: 'Dense woods, grass, shrubs and stone. Longest draw distance.',
  medium: 'Half the draw distance, about half the scenery in it.',
  low: 'Simplified trees only — no grass, shrubs or stone. Shortest draw distance.',
};

/**
 * The buses worth a slider. `mechanical` is not one: it is mixed to zero in
 * powertrain.js, so a slider for it would be clutter.
 */
const BUSES = [
  ['exhaust', 'Exhaust', 'the pipe — combustion pulses through the waveguides'],
  ['intake', 'Intake', 'induction roar on the other side of the engine'],
  ['transmission', 'Gearbox', 'mesh whine, pitched per gear'],
  ['turbo', 'Turbo', 'spool whistle, wastegate chatter, blow-off'],
  ['transients', 'Transients', 'bangs, clunks, lash impacts'],
  ['sub', 'Sub', 'the bottom octave you feel more than hear'],
];

export class Settings {
  constructor(game, ids = { body: 'settings-body', tabs: 'set-tabs' }) {
    this.game = game;
    this.body = document.getElementById(ids.body);
    this.tabs = document.getElementById(ids.tabs);
    this._pages = [];
    this._rows = [];
    /** Where new controls go: the page being built. */
    this._host = this.body;

    // Nothing typed into the panel reaches the driving controls.
    this.body.addEventListener('keydown', (e) => e.stopPropagation());
    this.body.addEventListener('keyup', (e) => e.stopPropagation());

    this._build();
  }

  /** A tab in the settings sheet, and the page new controls go into. */
  _page(title) {
    const page = document.createElement('div');
    page.className = 'set-page';
    this.body.appendChild(page);
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'set-tab';
    tab.textContent = title;
    tab.addEventListener('click', () => this.showPage(title));
    this.tabs.appendChild(tab);
    this._pages.push({ title, page, tab });
    this._host = page;
    if (this._pages.length === 1) this.showPage(title);
    return page;
  }

  showPage(title) {
    for (const p of this._pages) {
      p.page.classList.toggle('on', p.title === title);
      p.tab.classList.toggle('on', p.title === title);
    }
  }

  _sub(title) {
    const h = document.createElement('div');
    h.className = 'set-sub';
    h.textContent = title;
    this._host.appendChild(h);
  }

  _slider(label, hint, min, max, value, onInput) {
    const row = document.createElement('label');
    row.className = 'set-row';
    row.title = hint || '';

    const name = document.createElement('span');
    name.className = 'set-name';
    name.textContent = label;

    const readout = document.createElement('span');
    readout.className = 'set-val';

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = '0.01';
    input.value = String(value);

    const show = (v) => {
      readout.textContent = Number(v).toFixed(2);
      input.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`);
    };
    show(value);

    input.addEventListener('input', () => {
      onInput(parseFloat(input.value));
      show(input.value);
    });
    // Release focus on release, or the arrow keys steer.
    input.addEventListener('change', () => input.blur());
    input.addEventListener('pointerup', () => input.blur());

    row.append(name, input, readout);
    this._host.appendChild(row);
    this._rows.push({ input, show });
    return { input, show };
  }

  _button(label, onClick) {
    const b = document.createElement('button');
    b.className = 'set-btn';
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => { onClick(); b.blur(); });
    this._host.appendChild(b);
    return b;
  }

  _build() {
    const pt = this.game.powertrain;

    this._page('Graphics');
    this._sub('Detail');
/**
     * A three-state switch, one segment per level. Only an actual change
     * rebuilds the world (see config.js). Picking the current level does
     * nothing.
     */
    this.gfxBtns = [];
    const seg = document.createElement('div');
    seg.className = 'seg-control seg3';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Graphics');
    const fill = document.createElement('span');
    fill.className = 'seg-fill';
    fill.setAttribute('aria-hidden', 'true');
    seg.appendChild(fill);
    GRAPHICS_LEVELS.forEach((lvl) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn';
      b.textContent = lvl[0].toUpperCase() + lvl.slice(1);
      b.addEventListener('click', () => {
        if (graphicsLevel() === lvl) return;
        setGraphicsLevel(lvl);
        location.reload();
      });
      seg.appendChild(b);
      this.gfxBtns.push({ lvl, el: b });
    });
    seg.style.setProperty('--n', GRAPHICS_LEVELS.length);
    this._host.appendChild(seg);

    // One line saying what the level actually does; see config.js.
    this.gfxNote = document.createElement('div');
    this.gfxNote.className = 'row-hint';
    this._host.appendChild(this.gfxNote);

    // TreeGen or the legacy low-poly canopy; the library is built at boot.
    this._button(`Trees: ${TREES.generator === 'legacy' ? 'legacy low-poly' : 'TreeGen'}`, () => {
      setTreeGenerator(TREES.generator === 'legacy' ? 'treegen' : 'legacy');
      location.reload();
    });

    this._page('Driving');
    this._sub('Car');
    this.autoBtn = this._button('Gearbox: auto', () => {
      this.game.setAutoShift(!pt.autoShift);
    });
    this.tcBtn = this._button('Traction control: on', () => {
      pt.tractionControl = !pt.tractionControl;
      this.refresh();
    });
    this.camBtn = this._button(`Camera: ${CAM_MODES[this.game.cam.mode]}`, () => {
      this.camBtn.textContent = 'Camera: ' + this.game.cam.cycle();
    });
    /**
     * Tilt steering; this button is the permission gesture.
     * iOS grants the sensor only from inside a tap, so the button the player
     * chose is the better place to ask.
     */
    if (TiltSteering.supported) {
      this.tiltBtn = this._button('Steering: buttons', () => this.game.toggleTilt());
      // The code cannot know which way reads as "tipped right"; see input.js.
      // This button toggles it.
      this.tiltInvBtn = this._button('Tilt: normal', () => {
        TiltSteering.setInverted(!TiltSteering.inverted);
        this.refresh();
      });
    }

    this._page('Audio');
    this._sub('Levels');
    this.master = this._slider('Master', 'overall level', 0, 1, pt.volume, (v) => pt.setVolume(v));
    // Not an engine bus (see wind.js), so it gets its own control.
    this.wind = this._slider('Wind', 'air over the body, louder the faster you go',
      0, 1, this.game.wind.volume, (v) => this.game.wind.setVolume(v));

    this._sub('Voice mix');
    this.busRows = {};
    for (const [id, label, hint] of BUSES) {
      this.busRows[id] = this._slider(label, hint, 0, 2, pt.mix[id], (v) => pt.setBus(id, v));
    }

    this._sub('Tone');
    this.rumble = this._slider('Rumble', 'weight at the bottom end', 0, 2, pt.tone.rumble,
      (v) => pt.setTone({ rumble: v }));
    this.bright = this._slider('Brightness', 'rasp and air at the top', 0, 2, pt.tone.brightness,
      (v) => pt.setTone({ brightness: v }));
    this._host = this.body;

    this.refresh();
  }

  /** A labelled segmented switch (the graphics one's look); `onPick` gets the option's value. */
  _segment(label, hint, options, value, onPick) {
    const row = document.createElement('div');
    row.className = 'set-row';
    row.title = hint || '';
    const name = document.createElement('span');
    name.className = 'set-name';
    name.textContent = label;
    const seg = document.createElement('div');
    seg.className = 'seg-control';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', label);
    seg.style.setProperty('--n', options.length);
    seg.style.gridColumn = '2 / 4';
    const fill = document.createElement('span');
    fill.className = 'seg-fill';
    fill.setAttribute('aria-hidden', 'true');
    seg.appendChild(fill);
    const btns = options.map(([v, text], i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn';
      b.textContent = text;
      b.addEventListener('click', () => { pick(i); onPick(v); b.blur(); });
      seg.appendChild(b);
      return b;
    });
    const pick = (i) => {
      seg.style.setProperty('--a', i);
      btns.forEach((b, j) => b.setAttribute('aria-pressed', String(i === j)));
    };
    pick(Math.max(0, options.findIndex(([v]) => v === value)));
    row.append(name, seg);
    this._host.appendChild(row);
  }

  /**
   * Pulls state back out of the game, after a keybind changes something.
   */
  refresh() {
    const pt = this.game.powertrain;
    if (this.gfxBtns && this.gfxBtns.length) {
      const lvl = graphicsLevel();
      const seg = this.gfxBtns[0].el.parentElement;
      seg.style.setProperty('--a', GRAPHICS_LEVELS.indexOf(lvl));
      for (const g of this.gfxBtns) g.el.setAttribute('aria-pressed', String(g.lvl === lvl));
      if (this.gfxNote) this.gfxNote.textContent = GFX_NOTES[lvl] || '';
    }
    if (this.autoBtn) {
      this.autoBtn.textContent = 'Gearbox: ' + (pt.autoShift ? 'auto' : 'manual');
      this.autoBtn.classList.toggle('on', !pt.autoShift);
    }
    if (this.tcBtn) {
      this.tcBtn.textContent = 'Traction control: ' + (pt.tractionControl ? 'on' : 'off');
      this.tcBtn.classList.toggle('on', !pt.tractionControl);
    }
    if (this.tiltBtn) {
      const on = !!(this.game.input && this.game.input.tilt.on);
      this.tiltBtn.textContent = 'Steering: ' + (on ? 'tilt' : 'buttons');
      this.tiltBtn.classList.toggle('on', on);
    }
    if (this.tiltInvBtn) {
      const inv = TiltSteering.inverted;
      this.tiltInvBtn.textContent = 'Tilt: ' + (inv ? 'inverted' : 'normal');
      this.tiltInvBtn.classList.toggle('on', inv);
      this.tiltInvBtn.style.display = this.game.input.tilt.on ? '' : 'none';
    }
    if (this.master) {
      this.master.input.value = String(pt.volume);
      this.master.show(pt.volume);
    }
    if (this.wind) {
      this.wind.input.value = String(this.game.wind.volume);
      this.wind.show(this.game.wind.volume);
    }
    for (const [id] of BUSES) {
      const row = this.busRows && this.busRows[id];
      if (row) { row.input.value = String(pt.mix[id]); row.show(pt.mix[id]); }
    }
  }
}

/**
 * The world sheet: one control per `config.js:TERRAIN_SPEC` knob, plus the
 * seed and the sky. The knobs and the seed edit a pending copy; Apply saves
 * it and rebuilds the world (a reload, like the graphics level), since every
 * one of them shapes what is generated. The sky changes live.
 */
export class WorldSheet extends Settings {
  constructor(game) {
    super(game, { body: 'world-body', tabs: 'world-tabs' });
  }

  _build() {
    const live = terrainSettings();
    const want = { ...live };
    const apply = document.getElementById('world-apply');
    const dirty = () => {
      const changed = Object.keys(want).some((k) => want[k] !== live[k]) || !!this._seedChange();
      apply.classList.toggle('on', changed);
      apply.textContent = changed ? 'Apply — rebuilds the world' : 'Apply';
    };

    this._page('World');
    this._sub('Seed');
    this._seedField(dirty);
    for (const sp of TERRAIN_SPEC) {
      if (sp.group) {
        if (sp.group === 'Climate') this._sub(sp.group);
        else this._page(sp.group);
        continue;
      }
      if (sp.options) {
        this._segment(sp.label, sp.hint, sp.options, want[sp.key], (v) => { want[sp.key] = v; dirty(); note(); });
        // What the chosen world biome is, in a line.
        const hint = document.createElement('div');
        hint.className = 'row-hint';
        this._host.appendChild(hint);
        const note = () => { if (sp.key === 'biome') hint.textContent = BIOME_NOTES[want.biome] || ''; };
        note();
      } else if (sp.toggle) {
        const b = this._button('', () => { want[sp.key] = !want[sp.key]; show(); dirty(); });
        b.title = sp.hint;
        const show = () => {
          b.textContent = `${sp.label}: ${want[sp.key] ? 'on' : 'off'}`;
          b.classList.toggle('on', !want[sp.key]);
        };
        show();
      } else {
        const row = this._slider(sp.label, sp.hint, sp.min, sp.max, want[sp.key], (v) => {
          // Snap to the default near it, so a knob can be put back exactly.
          const d = terrainDefault(sp.key);
          want[sp.key] = Math.abs(v - d) < (sp.max - sp.min) * 0.015 ? d : v;
          dirty();
        });
        row.input.addEventListener('change', () => { row.input.value = String(want[sp.key]); row.show(want[sp.key]); });
      }
      if (sp.key === 'biome') {
        this._sub('Sky');
        // Sky preset: cycles day → golden hour → dawn → overcast → full moon. Live.
        this.skyBtn = this._button('Sky: day', () => {
          this.game.cycleSky();
          this.refresh();
        });
      }
    }

    apply.addEventListener('click', () => {
      if (!apply.classList.contains('on')) return;
      saveTerrain(want);
      const seed = this._seedChange();
      if (!seed) { location.reload(); return; }
      // A different world is a different page: the seed goes in the URL.
      const url = new URL(location.href);
      url.searchParams.set('seed', seed);
      location.href = url.toString();
    });
    document.getElementById('world-reset').addEventListener('click', () => { saveTerrain(null); location.reload(); });
    dirty();
    this.refresh();
  }

  /** The seed box and its dice. */
  _seedField(dirty) {
    const row = document.createElement('div');
    row.className = 'field-row';
    const input = document.createElement('input');
    input.className = 'input';
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.maxLength = 24;
    input.setAttribute('aria-label', 'World seed');
    input.value = this.game.seed;
    input.addEventListener('input', dirty);
    const dice = document.createElement('button');
    dice.className = 'icon-btn';
    dice.type = 'button';
    dice.setAttribute('aria-label', 'Random world');
    dice.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="15" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/></svg>';
    dice.addEventListener('click', () => { input.value = Math.random().toString(36).slice(2, 8); dirty(); dice.blur(); });
    row.append(input, dice);
    this._host.appendChild(row);
    this.seedInput = input;
  }

  /** The seed box's value, if it names a different world. */
  _seedChange() {
    const s = String(this.seedInput?.value || '').trim();
    return s && s !== this.game.seed ? s : null;
  }

  refresh() {
    if (this.skyBtn) {
      const n = this.game.gfx.skyName || 'day';
      this.skyBtn.textContent = 'Sky: ' + (SKY_PRESETS[n] ? SKY_PRESETS[n].label.toLowerCase() : n);
    }
  }
}

/** One line per world biome; keep them true to config.js:WORLDS. */
const BIOME_NOTES = {
  temperate: 'Green country: meadows, broadleaf and conifer woods, lakes and mountains.',
  snow: 'Deep winter: snow on everything that lies flat, bare trees, snowy conifers, rock on the steeps.',
  desert: 'Flat sand sea and gravel plain with dunes, mesas and the odd acacia. Sand drifts on the road.',
  fall: 'Autumn: gold, orange and red woods, leaves on the ground and the road.',
};
for (const k in WORLDS) if (!BIOME_NOTES[k]) BIOME_NOTES[k] = WORLDS[k].label;
