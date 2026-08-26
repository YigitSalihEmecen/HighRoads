/**
 * settings.js — the settings panel.
 *
 * The parts of the engine simulator worth touching: master level, the six voice
 * buses it mixes independently, the two tone controls, the wind, plus the
 * gearbox and camera modes — driving settings rather than audio ones, but they
 * belong with the other toggles.
 *
 * IT IS A NODE, NOT A PLACE. There used to be a tab clinging to the left edge
 * of the screen that slid this out over the road, and the panel knew where it
 * lived: it owned `#settings`, `#settings-toggle` and an `open` flag. The same
 * controls are now wanted folded into the title screen's Settings drawer AND
 * inside the pause menu, and the honest way to be in two places is to be moved
 * between them — see `Game.mountSettings`. So this module builds the panel and
 * nothing else; whoever wants it appends it.
 *
 * One non-obvious constraint shapes the rest of the file: **the game reads the
 * keyboard from `window`**. A focused range input also responds to arrow keys,
 * so a slider left focused would steer the car every time the player nudged it.
 * Every control therefore blurs itself as soon as it is released, and the panel
 * swallows key events that reach it.
 */

import { TiltSteering } from './input.js';
import { CAM_MODES } from './camera.js';
import { GRAPHICS_LEVELS, graphicsLevel, setGraphicsLevel } from './config.js';

/**
 * The buses worth a slider.
 *
 * `mechanical` is not one of them. It is band-passed pink noise standing in for
 * valvetrain clatter and block resonance, and at driving volume it reads as
 * hiss rather than as detail, so it is mixed to zero in powertrain.js. A slider
 * whose only useful position is the one it already sits at is clutter.
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

    // The panel is a keyboard trap by design — nothing typed into it should
    // reach the driving controls.
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
   * the whole tree of audio controls hangs off it and starts folded, so the
   * panel opens to two short blocks and one line instead of a wall of sliders.
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
    // Release focus the moment the player lets go, or the arrow keys steer.
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
     * Three levels of fidelity, laid out exactly like the mode selector below
     * Drive — a three-state segmented switch with a sliding fill. Each level
     * is its own segment: you pick the one you want in one tap, and only an
     * actual change needs the world rebuilt (see config.js) — picking the
     * level you are already on does nothing.
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

    this._section('Driving');
    this.autoBtn = this._button('Gearbox: auto', () => {
      this.game.setAutoShift(!pt.autoShift);
    });
    this.camBtn = this._button(`Camera: ${CAM_MODES[this.game.cam.mode]}`, () => {
      this.camBtn.textContent = 'Camera: ' + this.game.cam.cycle();
    });
    /**
     * Tilt steering, and this button is the PERMISSION GESTURE.
     *
     * iOS Safari will only hand over the orientation sensor from inside a tap
     * (see `input.js:TiltSteering`), which is the same rule the audio lives
     * under. Doing it here rather than on the Drive button is deliberate: a
     * first-time player should not meet an operating-system permission dialog
     * on their way into the game, and a control they chose to press is a much
     * better place to ask.
     */
    if (TiltSteering.supported) {
      this.tiltBtn = this._button('Steering: buttons', () => this.game.toggleTilt());
      // Which way a given phone reads as "tipped right" is not something the
      // code can know — see `input.js:_read`. This is the escape hatch.
      this.tiltInvBtn = this._button('Tilt: normal', () => {
        TiltSteering.setInverted(!TiltSteering.inverted);
        this.refresh();
      });
    }

    // Everything auditory shares one fold, folded by default, so the panel does
    // not open onto a wall of sliders. See `collapse()`.
    this._host = this.collapse('Audio');
    this.master = this._slider('Master', 'overall level', 0, 1, pt.volume, (v) => pt.setVolume(v));
    // Not one of the engine's buses — see wind.js. It shares the context and
    // nothing else, so it gets its own control rather than sitting under a
    // heading that says "voice mix" and meaning combustion.
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

  /** Pulls state back out of the game — used when a keybind changes something. */
  refresh() {
    const pt = this.game.powertrain;
    if (this.gfxBtns && this.gfxBtns.length) {
      const lvl = graphicsLevel();
      const seg = this.gfxBtns[0].el.parentElement;
      seg.dataset.active = String(GRAPHICS_LEVELS.indexOf(lvl));
      for (const g of this.gfxBtns) g.el.setAttribute('aria-pressed', String(g.lvl === lvl));
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
