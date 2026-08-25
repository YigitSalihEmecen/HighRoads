/**
 * What the interface actually looks like, at real device sizes.
 *
 * This is the only thing in the project that can SEE the layout, and it exists
 * because nothing else could: `probe/ui.mjs` proves every id resolves and every
 * toggled class is styled, which is necessary and says nothing at all about
 * whether two controls sit on top of each other. Four bugs that shipped past
 * every other check were found the first time this ran — the handbrake through
 * the middle of the tachometer, the score squeezed against the auxiliary
 * buttons, garage rows squashed below their content so the text drew through
 * the swatches underneath, and the wordmark running under the panel on a
 * landscape phone.
 *
 * It drives a headless Chrome over the DevTools protocol rather than shelling
 * out to `--screenshot`, for one reason: `--window-size` is clamped to a 500 px
 * minimum, so a plain headless screenshot of a 375 px phone silently lays the
 * page out at 500 and crops it. `Emulation.setDeviceMetricsOverride` gives the
 * real viewport. Node's built-in WebSocket does the rest; no dependencies.
 *
 *   node probe/uishot.mjs            # screenshot every viewport, report overflow
 *   node probe/uishot.mjs --build    # regenerate uiview.html from index.html
 *
 * Images land in probe/shots/. Chrome is expected at the macOS path below;
 * override with CHROME=/path/to/chrome.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 8139);
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const OUT = path.join(HERE, 'shots');

/* ----------------------------------------------------------------- build -- */

/**
 * Splices the live shell together with the harness body. Kept as a build step
 * rather than a copy so the stylesheet under test is always the real one —
 * a forked copy of index.html would drift within a day and then be worse than
 * nothing, because it would still render.
 */
function build() {
  const shell = fs.readFileSync(path.join(HERE, '..', 'index.html'), 'utf8')
    .replace(/<script type="importmap">[\s\S]*?<\/script>/, '')
    .replace(/<script type="module">[\s\S]*?<\/script>/, '');
  const body = fs.readFileSync(path.join(HERE, 'uiview.body.html'), 'utf8');
  fs.writeFileSync(path.join(HERE, 'uiview.html'), shell + body);
  console.log('  built probe/uiview.html from index.html');
}

/* ------------------------------------------------------------- viewports -- */

/** [name, width, height, query, mobile] — real devices, both orientations. */
const VIEWS = [
  ['phone-se',        375,  667,  '',                  1],
  ['phone',           393,  852,  '',                  1],
  ['phone-land',      852,  393,  '',                  1],
  ['tablet',          834, 1112,  '',                  1],
  ['tablet-land',    1112,  834,  '',                  1],
  ['desktop',        1440,  900,  'touch=0',           0],
  ['hud-phone',       393,  852,  'hud=1',             1],
  ['hud-phone-se',    375,  667,  'hud=1',             1],
  ['hud-land',        852,  393,  'hud=1',             1],
  ['hud-tablet',      834, 1112,  'hud=1',             1],
  ['drawer-world',    393,  852,  'open=world',        1],
  ['drawer-car-land', 852,  393,  'open=car',          1],
  ['drawer-desktop', 1440,  900,  'open=settings&touch=0', 0],
  ['pause',           393,  852,  'pause=1',           1],
  ['pause-land',      852,  393,  'pause=1',           1],
  ['gameover',        393,  852,  'over=1',            1],
];

/* --------------------------------------------------------------- harness -- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const file = path.join(HERE, 'uiview.html');
    res.writeHead(200, { 'content-type': types['.html'] });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(PORT, () => r(server)));
}

/** The page reports its own overflow — the thing a screenshot cannot state. */
const AUDIT = `(() => {
  const de = document.documentElement, bad = [];
  document.querySelectorAll('body *').forEach((el) => {
    // A folded drawer clips its own contents to nothing; that is the fold, not
    // a fault. Open drawers are still audited.
    if (el.closest('.drawer:not(.open)')) return;
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'auto') {
      bad.push((el.id || el.className || el.tagName) + ' ' + el.clientWidth + '<' + el.scrollWidth);
    }
  });
  return (de.scrollWidth > innerWidth ? 'PAGE-OVERFLOW ' : '') + bad.join(' ; ');
})()`;

async function main() {
  if (process.argv.includes('--build')) { build(); return; }
  build();
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(OUT, '.chrome')}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 60 && !(targets && targets.length); i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); } catch {}
    if (!targets || !targets.length) await sleep(250);
  }
  if (!targets || !targets.length) {
    chrome.kill(); server.close();
    console.log(`  [FAIL] no Chrome at ${CHROME} — set CHROME=/path/to/chrome`);
    process.exit(1);
  }

  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++seq;
    pending.set(n, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  let bad = 0;
  console.log('  viewport                      overflow');
  for (const [name, w, h, query, mobile] of VIEWS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile,
      screenWidth: w, screenHeight: h,
    });
    await send('Emulation.setTouchEmulationEnabled', { enabled: !!mobile, maxTouchPoints: 1 });
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?${query}` });
    await sleep(800);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    const { result } = await send('Runtime.evaluate', { expression: AUDIT, returnByValue: true });
    const issue = result.value;
    if (issue) bad++;
    console.log(`  ${(name + ` ${w}x${h}`).padEnd(30)}${issue || 'none'}`);
  }

  ws.close();
  chrome.kill();
  server.close();
  console.log(`\n  [${bad ? 'FAIL' : ' ok '}] ${VIEWS.length} viewports · images in probe/shots/` +
    (bad ? `  — ${bad} overflowing` : ''));
  process.exit(bad ? 1 : 0);
}

main();
