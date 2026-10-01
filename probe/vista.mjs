/**
 * vista.mjs — the WORLD, from vantage points the chase camera never reaches.
 *
 * Same boot as render.mjs, then the camera rig is parked and the camera is put
 * high above / far to the side of the road, so terrain seams, holes, biomes,
 * water and skies can be judged. `node probe/vista.mjs [seed] [s] [sky]`
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
const atS = Number(process.argv[3] || 600);
const sky = process.argv[4] || '';
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
  fs.writeFileSync(path.join(OUT, `vista-${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  wrote probe/shots/vista-${name}.png`);
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
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?seed=${encodeURIComponent(seed)}${sky ? '&sky=' + sky : ''}` });

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

await js(`(async()=>{const g=window.__highroads;
  try{ g.powertrain.start(g.car()).catch(()=>{}); }catch(e){}
  g.startRun();
  g.path.ensureLength(${atS} + 2500);
  g.chunks.preload(${atS});
  g.respawn(${atS}); g.carS=${atS};
  g.cam.update = () => {};
})()`);
await sleep(9000);   // let streaming catch up at SwiftShader speed
console.log('  state: ' + await js(`(()=>{const g=window.__highroads, v=g.vehicle;
  const lv = v.body ? v.body.linvel() : {x:0,y:0,z:0};
  return 'car ' + [v.pos.x, v.pos.y, v.pos.z].map(n=>n.toFixed(1)).join(',') + ' vel ' + [lv.x,lv.y,lv.z].map(n=>n.toFixed(1)).join(',') +
    ' tiles ' + g.chunks.tiles.tiles.size + ' road y ' + g.path.frameAt(${atS}).pos.y.toFixed(1);})()`));

/** Camera at (along, side, up) metres in the road frame at s, looking at (along2, side2, up2). */
const views = [
  ['aerial',   [-120, 0, 140], [220, 0, 0]],
  ['high-side',[0, -260, 120], [80, 120, 0]],
  ['low-side', [0, -40, 6], [60, 220, 10]],
  ['ahead',    [-14, 0, 6], [120, 0, 2]],
  ['far',      [0, 0, 360], [700, 0, 0]],
];
for (const [name, a, b] of views) {
  await js(`(()=>{const g=window.__highroads; const T=g.THREE||null;
    const f=g.path.frameAt(${atS});
    const tx=f.tan.x, tz=f.tan.z, l=Math.hypot(tx,tz)||1, fx=tx/l, fz=tz/l, rx=-fz, rz=fx;
    const P=(o)=>{const x=f.pos.x+fx*o[0]+rx*o[1], z=f.pos.z+fz*o[0]+rz*o[1]; return [x, Math.max(f.pos.y, g.chunks.field.height(x,z))+o[2], z];};
    const c=g.cam.camera, p=P(${JSON.stringify(a)}), q=P(${JSON.stringify(b)});
    c.position.set(p[0],p[1],p[2]); c.far=Math.max(c.far, 4000); c.lookAt(q[0],q[1],q[2]); c.updateProjectionMatrix();
    g.chunks.update(${atS});})()`);
  await sleep(4500);
  if (name === 'aerial') console.log('  cam: ' + await js(`(()=>{const g=window.__highroads, c=g.cam.camera;
    return [c.position.x,c.position.y,c.position.z].map(n=>n.toFixed(1)).join(',') + ' fwd ' + g.vehicle.forwardSpeed.toFixed(2) + ' fov ' + c.fov.toFixed(1) + ' parent ' + (c.parent && c.parent.type);})()`));
  await shot(name);
}
if (consoleErrors.length) {
  console.log('\n  page errors:');
  for (const e of [...new Set(consoleErrors)].slice(0, 5)) console.log('   ' + String(e).split('\n')[0]);
}
ws.close(); chrome.kill(); server.close();
process.exit(0);
