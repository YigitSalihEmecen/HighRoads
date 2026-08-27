/**
 * render.mjs — the game, actually rendered.
 *
 * Boots a browser, renders the world and screenshots it.
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
  // Software GL: without these the page never gets a WebGL context at all.
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

// The Drive button's async audio start can reject headless, so start directly.
await js(`document.getElementById('start').click()`);
/**
 * Mid-flight, timed off the flight rather than the click: `begin()` awaits
 * engine_sim's audio start, which under SwiftShader can outlast the whole
 * 1.35 s flight.
 */
for (let i = 0; i < 120; i++) {
  if (await js(`!!(window.__highroads && window.__highroads.cam.flyingIn)`)) break;
  await sleep(50);
}
await sleep(450);
await shot('game-flyin');
await sleep(3000);
await js(`(async()=>{const g=window.__highroads;
  if(!g.active){ try{ await g.powertrain.start(g.car()); }catch(e){} g.startRun(); }
  g.input.touch.throttle=1; })()`);

/**
 * Optional teleport, in metres of arc length. SwiftShader runs at ~20 fps, so
 * "drive for a minute" covers a couple of hundred metres and every shot is of
 * the same kilometre; `respawn` is the only way to see a distant landform.
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

const rig = `(()=>{const g=window.__highroads, c=g.cam, v=g.vehicle;
  const d=c.camera.position.distanceTo(v.renderPos);
  return \`title=\${c.title} flyingIn=\${c.flyingIn} introT=\${c.introT.toFixed(2)} \` +
    \`fov=\${c.camera.fov.toFixed(1)} cam-to-car=\${d.toFixed(2)}m mode=\${c.mode}\`;})()`;
console.log('  rig: ' + await js(rig));

const step = Math.max(4, Math.round(driveFor / 3));
for (let i = 0; i < 3; i++) {
  await sleep(step * 1000);
  console.log('  ' + await js(`(()=>{const g=window.__highroads;
    return \`\${Math.round(Math.abs(g.vehicle.forwardSpeed)*3.6)} km/h, s=\${Math.round(g.carS)}, \` +
      \`\${g.chunks.chunks.size} chunks, grass \${[...g.chunks.chunks.values()]
        .filter(c=>c.grass).reduce((a,c)=>a+c.grass.count,0).toLocaleString()} tufts\`;})()`));
}
/**
 * Optional burnout, for looking at the tyre effects. `SKID=1` stops the car
 * and floors it — the state `fx.js` emits smoke and rubber in.
 *
 * It does NOT WORK through SwiftShader: at ~20 fps the powertrain is stepped
 * with dt ≈ 50 ms, far outside what engine_sim's launch controller regulates
 * at, and the engine never comes off idle — no slip, nothing to draw.
 * `probe/env.mjs` verifies the emission path deterministically; this flag only
 * proves the shaders compile and the meshes are in the scene.
 */
if (process.env.SKID === '1') {
  // A standing start, not a handbrake turn: throttle plus handbrake nearly
  // cancels and the friction circle never clamps, so no slip is reported.
  await js(`(()=>{const g=window.__highroads;
    g.input.touch.handbrake=0; g.respawn(g.carS);
    // Brake first: the launch controller regulates on ROAD SPEED, so a car
    // already rolling is one it believes has launched and never revs up.
    g.input.touch.brake=1;
    setTimeout(() => { g.input.touch.brake=0; g.input.touch.throttle=1; }, 1500);
    // Watch the peak: at 20 fps the wheelspin lasts a couple of dozen frames,
    // so a single reading usually misses it.
    g.__peak = { slip: 0, rpm: 0, puffs: 0, marks: 0 };
    g.__watch = setInterval(() => {
      const s = Math.max(...g.vehicle.wheels.map(w => w.slipAmount));
      const p = [...g.fx._sBirth.array].filter((v, i) => i % 2 === 0 && v > g.fx.time - g.fx.smoke.uniforms.uLife.value).length;
      const m = [...g.fx.marks.mark.array].filter((v, i) => i % 2 === 0 && v > -1e5).length / 4;
      if (s > g.__peak.slip) { g.__peak.slip = s; g.__peak.rpm = g.powertrain.rpm; }
      g.__peak.puffs = Math.max(g.__peak.puffs, p);
      g.__peak.marks = Math.max(g.__peak.marks, m);
    }, 60);})()`);
  await sleep(6500);
  console.log('  ' + await js(`(()=>{const g=window.__highroads; clearInterval(g.__watch);
    return \`peak slip \${g.__peak.slip.toFixed(2)}, puffs \${g.__peak.puffs}, \` +
      \`mark quads \${g.__peak.marks}  (now \${Math.round(Math.abs(g.vehicle.forwardSpeed)*3.6)} km/h, \` +
      \`\${Math.round(g.powertrain.rpm)} rpm, gear \${g.powertrain.gearLabel()}, \` +
      \`drive \${Math.round(g.vehicle.driveForce)} N)\`;})()`));
}

console.log('  rig: ' + await js(rig));
await shot('game-drive');

// The pause menu, over a real frame of the road rather than the flat backdrop
// `probe/uishot.mjs` stands in for the scene.
await js(`window.__highroads.setPaused(true)`);
await sleep(700);
await shot('game-pause');
console.log('  ' + await js(`(()=>{const g=window.__highroads;
  return \`paused=\${g.paused}, body.paused=\${document.body.classList.contains('paused')}, \` +
    \`audio=\${g.powertrain.sim ? g.powertrain.sim.ctx.state : 'none'}\`;})()`));
await js(`window.__highroads.setPaused(false)`);
await sleep(500);

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
