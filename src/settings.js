/**
 * settings.js — the settings panel.
 *
 * The panel is a node, not a fixed location. The game mounts it into the
 * title screen drawer or into the pause menu. It builds the controls for the
 * engine simulator, the wind, the gearbox and the camera.
 */

import { TiltSteering } from './input.js';
import { CAM_MODES } from './camera.js';
import { GRAPHICS_LEVELS, graphicsLevel, setGraphicsLevel } from './config.js';

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
    this._rows = [];
    /** Where new controls go. Set to the audio fold's body while it builds. */
    this._host = this.body;

    // Nothing typed into the panel reaches the driving controls.
    this.body.addEventListener('keydown', (e) => e.stopPropagation());
    this.body.addEventListener('keyup', (e) => e.stopPropagation());

    this._build();
  }

  _section(title) {
    const h = document.createElement('div');
    h.className = 'set-section';
    h.textContent = title;
    this._host.appendChild(h);
  }

  /**
   * A collapsible group — the audio block. Returns the body to build into;
   * it starts folded, so the panel opens short instead of a wall of sliders.
   */
  collapse(title, { open = false } = {}) {
    const root = document.createElement('div');
    root.className = 'set-collapse' + (open ? ' open' : '');
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'set-collapse-head';
    head.setAttribute('aria-expanded', String(open));
    const label = document.createElement('span');
    label.textContent = title;
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.setAttribute('aria-hidden', 'true');
    head.append(label, caret);
    const fold = document.createElement('div');
    fold.className = 'set-collapse-fold';
    const body = document.createElement('div');
    body.className = 'set-collapse-body';
    fold.appendChild(body);
    root.append(head, fold);
    this.body.appendChild(root);
    head.addEventListener('click', () => {
      const on = !root.classList.contains('open');
      root.classList.toggle('open', on);
      head.setAttribute('aria-expanded', String(on));
    });
    return body;
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

    const show = (v) => { readout.textContent = Number(v).toFixed(2); };
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

    this._section('Graphics');
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
    this.body.appendChild(seg);

    // One line saying what the level actually does; see config.js.
    this.gfxNote = document.createElement('div');
    this.gfxNote.className = 'row-hint';
    this.body.appendChild(this.gfxNote);

    this._section('Driving');
    this.autoBtn = this._button('Gearbox: auto', () => {
      this.game.setAutoShift(!pt.autoShift);
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

    // All audio shares one fold, folded by default. See collapse().
    this._host = this.collapse('Audio');
    this.master = this._slider('Master', 'overall level', 0, 1, pt.volume, (v) => pt.setVolume(v));
    // Not an engine bus (see wind.js), so it gets its own control.
    this.wind = this._slider('Wind', 'air over the body, louder the faster you go',
      0, 1, this.game.wind.volume, (v) => this.game.wind.setVolume(v));

    this._section('Voice mix');
    this.busRows = {};
    for (const [id, label, hint] of BUSES) {
      this.busRows[id] = this._slider(label, hint, 0, 2, pt.mix[id], (v) => pt.setBus(id, v));
    }

    this._section('Tone');
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
      seg.dataset.active = String(GRAPHICS_LEVELS.indexOf(lvl));
      for (const g of this.gfxBtns) g.el.setAttribute('aria-pressed', String(g.lvl === lvl));
      if (this.gfxNote) this.gfxNote.textContent = GFX_NOTES[lvl] || '';
    }
    if (this.autoBtn) {
      this.autoBtn.textContent = 'Gearbox: ' + (pt.autoShift ? 'auto' : 'manual');
      this.autoBtn.classList.toggle('on', !pt.autoShift);
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
