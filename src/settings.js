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
    this.body.appendChild(h);
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
    this.body.appendChild(row);
    this._rows.push({ input, show });
    return { input, show };
  }

  _button(label, onClick) {
    const b = document.createElement('button');
    b.className = 'set-btn';
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => { onClick(); b.blur(); });
    this.body.appendChild(b);
    return b;
  }

  _build() {
    const pt = this.game.powertrain;

    this._section('Driving');
    this.autoBtn = this._button('Gearbox: auto', () => {
      this.game.setAutoShift(!pt.autoShift);
    });
    this.camBtn = this._button('Camera: chase', () => {
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
    }

    this._section('Audio');
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

    this.refresh();
  }

  /** Pulls state back out of the game — used when a keybind changes something. */
  refresh() {
    const pt = this.game.powertrain;
    if (this.autoBtn) {
      this.autoBtn.textContent = 'Gearbox: ' + (pt.autoShift ? 'auto' : 'manual');
      this.autoBtn.classList.toggle('on', !pt.autoShift);
    }
    if (this.tiltBtn) {
      const on = !!(this.game.input && this.game.input.tilt.on);
      this.tiltBtn.textContent = 'Steering: ' + (on ? 'tilt' : 'buttons');
      this.tiltBtn.classList.toggle('on', on);
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
