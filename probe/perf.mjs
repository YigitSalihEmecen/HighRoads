/**
 * perf.mjs — where a frame of the real game goes (?perf profiler).
 *
 *
 *   node probe/perf.mjs [seed] [seconds] [WxH]
 *
 * Boots the game with ?perf, drives, and prints the mean / p95 / max of every
 * section of the frame (src/perf.js), draw calls and triangles per frame, JS
 * heap, and streaming sub-costs. Run it at a tiny viewport too (320x180):
 * what is left of `render` there is CPU-side submission, not pixel fill.
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
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png',
  '.fbx': 'application/octet-stream', '.obj': 'text/plain', '.mtl': 'text/plain' };
const server = await new Promise((res) => {
  const s = http.createServer((req, res2) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res2.writeHead(404); res2.end(); return;
    }
    let body = fs.readFileSync(file);
    // Serve three and rapier from node_modules (npm run probe:deps) when they
    // are there: a sandbox with no route to the CDN — or a proxy Chrome does
    // not trust — otherwise boots a page whose every import fails.
    if (rel === '/' || rel === '/index.html') {
      const local = (p) => fs.existsSync(path.join(ROOT, p));
      let html = body.toString();
      if (local('node_modules/three/build/three.module.js')) {
        html = html.replace('https://unpkg.com/three@0.169.0/build/three.module.js', '/node_modules/three/build/three.module.js')
                   .replace('https://unpkg.com/three@0.169.0/examples/jsm/', '/node_modules/three/examples/jsm/');
      }
      if (local('node_modules/@dimforge/rapier3d-compat/rapier.es.js')) {
        html = html.replace('https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/+esm', '/node_modules/@dimforge/rapier3d-compat/rapier.es.js');
      }
      body = Buffer.from(html);
    }
    res2.writeHead(200, { 'content-type': TYPES[path.extname(file)] || (rel === '/' ? 'text/html' : 'application/octet-stream'),
      'cache-control': 'no-store' });
    res2.end(body);
  });
  s.listen(PORT, () => res(s));
});

fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new',
  // Software GL: without these the page never gets a WebGL context at all.
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox', '--mute-audio', '--ignore-certificate-errors',
  // Chrome refuses to start sandboxed as root (containers, CI).
  ...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []),
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
  fs.writeFileSync(path.join(OUT, `${process.env.TAG || ""}${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  wrote probe/shots/${name}.png`);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Performance.enable').catch(() => {});
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push((d.exception && d.exception.description) || d.text);
  }
});
const [W, H] = (process.argv[4] || '1280x720').split('x').map(Number);
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
const sky = process.env.SKY ? `&sky=${process.env.SKY}` : '';
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?seed=${encodeURIComponent(seed)}&perf${sky}` });
for (let i = 0; i < 240; i++) {
  if (await js(`!!document.getElementById('start') && !document.getElementById('start').disabled`)) break;
  await sleep(1000);
}
await js(`document.getElementById('start').click()`);
await sleep(4000);
await js(`(async()=>{const g=window.__highroads;
  if(!g.active){ try{ await g.powertrain.start(g.car()); }catch(e){} g.startRun(); }
  g.input.touch.throttle=1; })()`);
if (process.env.EVAL) await js(process.env.EVAL);
await sleep(3000);
await js(`(async()=>{ window.__perfMod = await import('/src/perf.js'); window.__perfMod.PERF.reset(); })()`);
const heap0 = await js(`performance.memory ? performance.memory.usedJSHeapSize : 0`);
await sleep(driveFor * 1000);
const rep = await js(`(()=>{const g=window.__highroads; const r=window.__perfMod.PERF.report();
  r.kmh=Math.round(Math.abs(g.vehicle.forwardSpeed)*3.6); r.s=Math.round(g.carS);
  const i=g.gfx.renderer.info; r.geometries=i.memory.geometries; r.textures=i.memory.textures;
  r.programs=(i.programs||[]).length; r.chunks=g.chunks.chunks.size; r.tiles=g.chunks.tiles.tiles.size;
  let meshes=0, inst=0; g.gfx.scene.traverse(o=>{ if(o.isMesh){ meshes++; if(o.isInstancedMesh) inst+=o.count; } });
  r.meshes=meshes; r.instances=inst; r.heap=performance.memory?performance.memory.usedJSHeapSize:0; return r;})()`);
const metrics = await send('Performance.getMetrics').catch(() => ({ metrics: [] }));
const M = Object.fromEntries((metrics.metrics || []).map(m => [m.name, m.value]));
console.log(`\nseed "${seed}", ${W}x${H}, ${rep.frames} frames over ${driveFor}s (${(rep.frames / driveFor).toFixed(1)} fps under SwiftShader)`);
console.log(`car ${rep.kmh} km/h at s=${rep.s}; ${rep.chunks} chunks, ${rep.tiles} tiles, ${rep.meshes} meshes, ${rep.instances.toLocaleString()} instances`);
console.log(`gpu: ${rep.geometries} geometries, ${rep.textures} textures, ${rep.programs} programs; JS heap ${(rep.heap / 1e6).toFixed(0)} MB (${((rep.heap - heap0) / 1e6).toFixed(1)} MB over the run)`);
const sec = rep.sections;
const order = Object.keys(sec).sort((a, b) => sec[b].mean - sec[a].mean);
console.log('\n  section         mean ms    p95 ms    max ms');
for (const k of order) {
  const v = sec[k];
  const unit = k === '.calls' ? ' calls' : k === '.tris' ? ' k tris' : '';
  console.log(`  ${k.padEnd(14)} ${v.mean.toFixed(2).padStart(8)}  ${v.p95.toFixed(2).padStart(8)}  ${v.max.toFixed(1).padStart(8)}${unit}`);
}
if (M.JSHeapUsedSize) console.log(`\n  CDP: ScriptDuration ${M.ScriptDuration?.toFixed(1)} s, TaskDuration ${M.TaskDuration?.toFixed(1)} s, LayoutDuration ${M.LayoutDuration?.toFixed(2)} s`);
if (process.env.INSPECT) console.log('\n' + await js(process.env.INSPECT));
if (errors.length) console.log('\n  page errors:\n   ' + errors.slice(0, 5).join('\n   '));
ws.close(); chrome.kill(); server.close();
process.exit(0);
