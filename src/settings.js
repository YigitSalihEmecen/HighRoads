/**
 * settings.js — the in-game settings drawer.
 *
 * A collapsible panel on the left exposing the parts of the engine simulator
 * worth touching while driving: master level, the seven voice buses it mixes
 * independently, and the two tone controls. Plus the gearbox mode, which is a
 * driving setting rather than an audio one but belongs with the other toggles.
 *
 * One non-obvious constraint shapes the whole file: **the game reads the
 * keyboard from `window`**. A focused range input also responds to arrow keys,
 * so a slider left focused would steer the car every time the player nudged it.
 * Every control therefore blurs itself as soon as it is released, and the panel
 * swallows key events that reach it.
 */

const BUSES = [
  ['exhaust', 'Exhaust', 'the pipe — combustion pulses through the waveguides'],
  ['intake', 'Intake', 'induction roar on the other side of the engine'],
  ['mechanical', 'Mechanical', 'valvetrain, injectors, chain, block resonance'],
  ['transmission', 'Gearbox', 'mesh whine, pitched per gear'],
  ['turbo', 'Turbo', 'spool whistle, wastegate chatter, blow-off'],
  ['transients', 'Transients', 'bangs, clunks, lash impacts'],
  ['sub', 'Sub', 'the bottom octave you feel more than hear'],
];

export class Settings {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('settings');
    this.body = document.getElementById('settings-body');
    this.toggle = document.getElementById('settings-toggle');
    this.open = false;
    this._rows = [];

    this.toggle.addEventListener('click', () => this.setOpen(!this.open));

    // The panel is a keyboard trap by design — nothing typed into it should
    // reach the driving controls.
    this.root.addEventListener('keydown', (e) => e.stopPropagation());
    this.root.addEventListener('keyup', (e) => e.stopPropagation());

    this._build();
    this.setOpen(false);
  }

  setOpen(open) {
    this.open = open;
    this.root.classList.toggle('open', open);
    this.toggle.textContent = open ? '‹' : '›';
    this.toggle.setAttribute('aria-expanded', String(open));
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

    this._section('Audio');
    this.master = this._slider('Master', 'overall level', 0, 1, pt.volume, (v) => pt.setVolume(v));

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
    if (this.master) {
      this.master.input.value = String(pt.volume);
      this.master.show(pt.volume);
    }
    for (const [id] of BUSES) {
      const row = this.busRows && this.busRows[id];
      if (row) { row.input.value = String(pt.mix[id]); row.show(pt.mix[id]); }
    }
  }
}
