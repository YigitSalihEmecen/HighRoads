/**
 * settings.js — the settings sheet.
 *
 * One sheet, opened from the title, the garage and the pause menu. Each
 * `_page` is a tab: graphics, driving (gearbox, camera, tilt) and audio (the
 * engine simulator's buses and tone, wind).
 */

import { TiltSteering } from './input.js';
import { CAM_MODES } from './camera.js';
import { GRAPHICS_LEVELS, graphicsLevel, setGraphicsLevel } from './config.js';
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
  constructor(game) {
    this.game = game;
    this.body = document.getElementById('settings-body');
    this.tabs = document.getElementById('set-tabs');
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
    this._sub('Atmosphere');

    // Sky preset: cycles day → golden hour → dawn → overcast → full moon.
    this.skyBtn = this._button('Sky: day', () => {
      this.game.cycleSky();
      this.refresh();
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
    if (this.skyBtn) {
      const n = this.game.gfx.skyName || 'day';
      this.skyBtn.textContent = 'Sky: ' + (SKY_PRESETS[n] ? SKY_PRESETS[n].label.toLowerCase() : n);
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
