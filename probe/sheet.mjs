/**
 * sheet.mjs — screenshots one of the probe/*.html contact sheets.
 *
 *   node probe/sheet.mjs road.html?cam=0,1.6,6,0,0,-30 [out.png]
 *
 * The page sets window.READY when drawn, and may set window.SHEET (any JSON),
 * which is printed. GPU=1 renders on the machine's GPU (Metal on a Mac) —
 * for shader costs and looks SwiftShader cannot judge. W=, H= size the page.
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
const PORT = Number(process.env.PORT || 8144);
const CDP = Number(process.env.CDP_PORT || 9406);
const PAGE = process.argv[2] || 'road.html';
const PNG = process.argv[3] || PAGE.split(/[.?]/)[0] + '.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = await new Promise((res) => {
  const s = http.createServer((req, res2) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res2.writeHead(404); res2.end(); return;
    }
    // No-store, or Chrome serves a cached module from a previous run.
    res2.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    let body = fs.readFileSync(file);
    // Local three when installed (npm run probe:deps): no CDN route needed.
    if (file.endsWith('.html') && fs.existsSync(path.join(ROOT, 'node_modules/three/build/three.module.js'))) {
      body = Buffer.from(body.toString()
        .replace('https://unpkg.com/three@0.169.0/build/three.module.js', '/node_modules/three/build/three.module.js')
        .replace('https://unpkg.com/three@0.169.0/examples/jsm/', '/node_modules/three/examples/jsm/'));
    }
    res2.end(body);
  });
  s.listen(PORT, () => res(s));
});

fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new',
  ...(process.env.GPU ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
  '--disable-gpu-sandbox', '--mute-audio', '--ignore-certificate-errors',
  ...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []),
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(OUT, '.chrome-sheet')}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

let targets = null;
for (let i = 0; i < 80 && !(targets && targets.length); i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); } catch { /* not up */ }
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

await send('Page.enable');
await send('Runtime.enable');
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push((d.exception && d.exception.description) || d.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push(m.params.args.map((a) => a.description || a.value).join(' '));
  }
});

await send('Emulation.setDeviceMetricsOverride',
  { width: Number(process.env.W || 1512), height: Number(process.env.H || 945), deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/probe/${PAGE}` });

let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  ready = await js('window.READY === true').catch(() => false);
  if (!ready) await sleep(250);
}

if (ready) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, PNG), Buffer.from(data, 'base64'));
  console.log(`  wrote probe/shots/${PNG}`);
  const sheet = await js('JSON.stringify(window.SHEET || null)');
  if (sheet !== 'null') console.log(`  ${sheet}`);
}
for (const e of errors) console.log(`  console: ${e.split('\n')[0]}`);

ws.close();
chrome.kill();
server.close();
const bad = !ready || errors.length;
console.log(`\n  [${bad ? 'FAIL' : ' ok '}] ${PAGE}\n`);
process.exit(bad ? 1 : 0);
