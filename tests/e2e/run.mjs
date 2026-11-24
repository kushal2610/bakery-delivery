// App tests: builds a test copy of index.html wired to the fake Supabase
// (mock_supabase.js), drives headless Chrome over the DevTools protocol, runs
// tests.js, and saves screenshots plus a PDF of the printed invoices to out/.
//   Run:  cd tests && npm run test:app        (Chrome path: set CHROME=...)
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(here, 'out');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// ── build the test pages ──
const app = readFileSync(join(root, 'index.html'), 'utf8');
const cdn = app.match(/<script defer src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^"]+"[^>]*><\/script>/s);
if (!cdn) throw new Error('Supabase <script> tag not found in index.html');
const mocked = app.replace(cdn[0], '<script src="mock_supabase.js"></script>');
const setConfig = (page, url, key) => {
  let n = 0;
  page = page.replace(/const SUPABASE_URL\s*=\s*'[^']*';/, () => (n++, `const SUPABASE_URL = '${url}';`));
  page = page.replace(/const SUPABASE_ANON_KEY\s*=\s*'[^']*';/, () => (n++, `const SUPABASE_ANON_KEY = '${key}';`));
  if (n !== 2) throw new Error('Supabase config constants not found');
  return page;
};
// The real project's URL/key in index.html are never used by the tests
writeFileSync(join(out, 'app.html'),
  setConfig(mocked, 'https://test.supabase.co', 'test-key').replace('</body>', '<script src="tests.js"></script>\n</body>'));
writeFileSync(join(out, 'unconfigured.html'),
  setConfig(mocked, 'https://YOUR-PROJECT-REF.supabase.co', 'YOUR-ANON-OR-PUBLISHABLE-KEY'));
for (const f of ['mock_supabase.js', 'tests.js']) copyFileSync(join(here, f), join(out, f));
copyFileSync(join(root, 'gj06-logo.png'), join(out, 'gj06-logo.png'));
// Serve out/ over http (like the real site; file:// pages can't load the logo)
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
const server = createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  if (!/^[\w.-]+$/.test(name)) { res.writeHead(404).end(); return; }
  try {
    const body = readFileSync(join(out, name));
    res.writeHead(200, { 'Content-Type': TYPES[extname(name)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${server.address().port}`;


// ── drive Chrome ──
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(out, 'profile')}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 100 && !ready; i++) {
  try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); ready = true; } catch { await sleep(100); }
}
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let nextId = 1;
const waiting = new Map(), listeners = [], errors = [];
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); return; }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
  listeners.forEach(l => l(msg));
});
const send = (method, params = {}) => new Promise(r => { const id = nextId++; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const navigate = async url => {
  const loaded = new Promise(r => listeners.push(m => { if (m.method === 'Page.loadEventFired') r(); }));
  await send('Page.navigate', { url });
  await loaded;
};
const evaluate = async (expression, timeout = 90000) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout });
  if (res.result?.exceptionDetails) return { error: res.result.exceptionDetails.exception?.description };
  return res.result?.result?.value;
};
const shot = async name => writeFileSync(join(out, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

let failed = 0;
const report = line => { if (!line.startsWith('PASS')) failed++; console.log(line); };

// 1. Not configured yet
await navigate(site + '/unconfigured.html');
await sleep(1200);
const setup = await evaluate(`[document.getElementById('loginScreen').hidden, document.getElementById('loginError').textContent, document.getElementById('loginBtn').disabled]`);
report((setup[0] === false && /Setup needed/.test(setup[1]) && setup[2] === true ? 'PASS' : 'FAIL') + ' unconfigured: setup message, sign-in disabled');

// 2. The suite
await navigate(site + '/app.html');
await sleep(1200);
const results = await evaluate('runTests()');
(Array.isArray(results) ? results : [`FAIL suite did not finish: ${JSON.stringify(results)}`]).forEach(report);

// 3. Screenshots + the printed invoices as an A4 PDF
const signInAs = (email, page) => evaluate(`(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (currentUser) await signOutNow();
  document.getElementById('loginEmail').value = '${email}';
  document.getElementById('loginPassword').value = 'pw';
  await signIn();
  const t = Date.now(); while (!dataLoaded && Date.now() - t < 3000) await sleep(20);
  await sleep(300);
  document.getElementById('installBanner').style.display = 'none';
  document.getElementById('toast').classList.remove('show');
  showPage('${page}'); window.scrollTo(0, 0);
  await sleep(300);
})()`);
await signInAs('owner@test.com', 'route');
await shot('route-admin.png');
await evaluate(`(async () => { showPage('stores'); openEditStore(3); await new Promise(r => setTimeout(r, 200)); })()`);
await shot('store-form.png');
// The invoices PDF exactly as the app makes it
const pdfB64 = await evaluate(`(async () => {
  closeStoreModal(); window.confirm = () => true;
  Object.assign(__mock.db.business_settings[0], { fuel_levy: 2, freight_fee: 5, freight_under: 50 });
  await refreshCatalog();
  let b64 = null;
  window.printPdfBlob = async blob => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    b64 = btoa(bin);
    return true;
  };
  await printInvoices();
  return b64;
})()`);
const pdf = Buffer.from(pdfB64 || '', 'base64');
writeFileSync(join(out, 'invoices.pdf'), pdf);
const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
report(`${pages === 4 ? 'PASS' : 'FAIL'} invoices.pdf has one A4 page per invoice (4)${pages === 4 ? '' : `  [${pages}]`}`);

// Page 1 as an image, drawn with pdf.js (needs internet; skipped if offline)
const png = await evaluate(`(async () => {
  try {
    await new Promise((ok, fail) => { const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'; s.onload = ok; s.onerror = fail; document.head.append(s); });
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const bytes = Uint8Array.from(atob('${pdfB64 || ''}'), c => c.charCodeAt(0));
    const page = await (await pdfjsLib.getDocument({ data: bytes }).promise).getPage(1);
    const vp = page.getViewport({ scale: 1.5 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c.toDataURL('image/png').split(',')[1];
  } catch (e) { return null; }
})()`);
if (png) writeFileSync(join(out, 'invoice-page1.png'), Buffer.from(png, 'base64'));
else console.log('(invoice-page1.png skipped: pdf.js could not be loaded)');


console.log(`\nconsole errors: ${errors.length ? '\n  ' + errors.join('\n  ') : 'none'}`);
console.log(`${failed ? failed + ' failed' : 'all passed'} · screenshots and invoices.pdf in ${out}`);
ws.close();
proc.kill();
server.close();
process.exit(failed || errors.length ? 1 : 0);
