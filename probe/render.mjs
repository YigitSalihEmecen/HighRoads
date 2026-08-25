/**
 * The game, actually rendered.
 *
 * Until this existed, nothing in the project had ever been seen. Every claim
 * about the world came from headless measurement, and the standing note in
 * AGENT_CONTEXT §8 was that no browser had drawn a single frame of it — which
 * meant the whole of the look (lighting, fog, tunnels as they appear, foliage
 * density, the garage framing) was unverified by construction.
 *
 * The blocker was WebGL: a headless Chrome has no GPU, so the game died at
 * `createScene` and the page never got past "building scene…". The way through
 * is SwiftShader, ANGLE's software rasteriser — `--use-angle=swiftshader` plus
 * `--enable-unsafe-swiftshader`. It is slow (about 20 fps at 1280x720, and that
 * number says nothing about real hardware) but it is a correct GL 
 * implementation, so what it draws is what a GPU would draw.
 *
 * Two bugs were found the first time it ran that no other probe could see: the
 * grass reading as a dark stripe along the verge rather than as grass, and the
 * car sitting entirely behind the garage dock on a 16:9 screen.
 *
 *   node probe/render.mjs                    # garage + driving, default seed
 *   node probe/render.mjs <seed> <seconds>
 *
 * Images land in probe/shots/. Chrome is expected at the macOS path below;
 * override with CHROME=/path/to/chrome.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '..');
const OUT = path.join(HERE, 'shots');
const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 8141);
const CDP = Number(process.env.CDP_PORT || 9403);

const seed = process.argv[2] || 'highroads-01';
const driveFor = Number(process.argv[3] || 25);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The whole project, statically. No build step, so this is the whole server. */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png',
  '.fbx': 'application/octet-stream', '.obj': 'text/plain', '.mtl': 'text/plain' };
const server = await new Promise((res) => {
  const s = http.createServer((req, res2) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res2.writeHead(404); res2.end(); return;
    }
    res2.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res2.end(fs.readFileSync(file));
  });
  s.listen(PORT, () => res(s));
});

fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new',
  // Software GL. Without these three the page never gets a context and the
  // game stops at "building scene…" with no error anyone can see.
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox', '--mute-audio',
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(OUT, '.chrome-gl')}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

let targets = null;
for (let i = 0; i < 80 && !(targets && targets.length); i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); } catch {}
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
const js = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
    .result.value;
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  wrote probe/shots/${name}.png`);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable').catch(() => {});
const consoleErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    consoleErrors.push((d.exception && d.exception.description) || d.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.description || a.value).join(' '));
  }
});
await send('Emulation.setDeviceMetricsOverride',
  { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?seed=${encodeURIComponent(seed)}` });

console.log(`\nseed "${seed}" — rendering through SwiftShader\n`);
let booted = false;
for (let i = 0; i < 240; i++) {
  if (await js(`!document.getElementById('start').disabled`)) { booted = true; break; }
  if (i % 20 === 19) console.log('  ' + (await js(`document.getElementById('boot').textContent`)));
  await sleep(1000);
}
if (!booted) {
  console.log('  [FAIL] never finished booting — ' + (await js(`document.getElementById('boot').textContent`)));
  ws.close(); chrome.kill(); server.close();
  process.exit(1);
}
console.log('  booted: ' + (await js(`document.getElementById('boot').textContent`)));
await sleep(2500);
await shot('game-garage');

// The Drive button goes through an async audio start that can reject in a
// headless browser, so fall back to starting the run directly.
await js(`document.getElementById('start').click()`);
await sleep(4000);
await js(`(async()=>{const g=window.__highroads;
  if(!g.active){ try{ await g.powertrain.start(g.car()); }catch(e){} g.startRun(); }
  g.input.touch.throttle=1; })()`);

/**
 * Optional teleport, in metres of arc length.
 *
 * SwiftShader runs the whole thing at roughly 20 fps, so "drive for a minute"
 * covers a couple of hundred metres and every shot is of the same kilometre.
 * `respawn` is the game's own recovery path — it puts the car on the road at an
 * arbitrary station — so a third argument picks the stretch to look at, which
 * is the only way to see a landform that takes two kilometres to arrive.
 */
const jumpTo = Number(process.argv[4] || 0);
if (jumpTo > 0) {
  await js(`(()=>{const g=window.__highroads;
    g.path.ensureLength(${jumpTo} + 2000);
    g.chunks.preload(${jumpTo});
    g.respawn(${jumpTo});
    g.carS = ${jumpTo};})()`);
  await sleep(6000);
}

const step = Math.max(4, Math.round(driveFor / 3));
for (let i = 0; i < 3; i++) {
  await sleep(step * 1000);
  console.log('  ' + await js(`(()=>{const g=window.__highroads;
    return \`\${Math.round(Math.abs(g.vehicle.forwardSpeed)*3.6)} km/h, s=\${Math.round(g.carS)}, \` +
      \`\${g.chunks.chunks.size} chunks, grass \${[...g.chunks.chunks.values()]
        .filter(c=>c.grass).reduce((a,c)=>a+c.grass.count,0).toLocaleString()} tufts\`;})()`));
}
/**
 * Optional burnout, for looking at the tyre effects.
 *
 * `SKID=1` pins the throttle and the handbrake for the last stretch, which is
 * the state `fx.js` emits smoke and rubber in. There is no other way to see
 * either of them from a script: they are driven by tyre slip, and a car being
 * driven sensibly never has any.
 */
if (process.env.SKID === '1') {
  // A standing start, not a handbrake turn. With the throttle open AND the
  // handbrake on the two longitudinal impulses very nearly cancel, so the
  // friction circle never clamps and the tyre model reports no slip at all —
  // which is correct, and not the state anyone means by "burnout". Dropping the
  // car back to a standstill and flooring it is.
  await js(`(()=>{const g=window.__highroads;
    g.input.touch.handbrake=0; g.respawn(g.carS); g.input.touch.throttle=1;})()`);
  await sleep(2200);
  console.log('  ' + await js(`(()=>{const g=window.__highroads;
    const slip=g.vehicle.wheels.map(w=>w.slipAmount.toFixed(2)).join('/');
    const puffs=[...g.fx._sBirth.array].filter((v,i)=>i%2===0&&v>g.fx.time-1.5).length;
    const marks=[...g.fx.marks.mark.array].filter((v,i)=>i%2===0&&v>g.fx.time-16).length/4;
    return \`slip \${slip}, puffs \${puffs}, marks \${marks}, \` +
      \`\${Math.round(Math.abs(g.vehicle.forwardSpeed)*3.6)} km/h, \${Math.round(g.powertrain.rpm)} rpm, \` +
      \`drive \${Math.round(g.vehicle.driveForce)} N, thr \${g.input.throttle}\`;})()`));
}

await shot('game-drive');

const errs = await js(`(()=>{const g=window.__highroads;
  return [g.vehicle.pos.y, g.chunks.chunks.size].join(',');})()`);
console.log(`  final: y=${errs.split(',')[0]}, chunks=${errs.split(',')[1]}`);

if (consoleErrors.length) {
  console.log('\n  page errors:');
  for (const e of [...new Set(consoleErrors)].slice(0, 5)) console.log('   ' + String(e).split('\n')[0]);
}
ws.close();
chrome.kill();
server.close();
console.log(`\n  [${consoleErrors.length ? 'FAIL' : ' ok '}] rendered`);
process.exit(consoleErrors.length ? 1 : 0);
