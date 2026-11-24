// App tests: builds a test copy of index.html wired to the fake Supabase
// (mock_supabase.js), drives headless Chrome over the DevTools protocol, runs
// tests.js, and saves screenshots plus a PDF of the printed invoices to out/.
//   Run:  cd tests && npm run test:app        (Chrome path: set CHROME=...)
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
await navigate(pathToFileURL(join(out, 'unconfigured.html')).href);
await sleep(1200);
const setup = await evaluate(`[document.getElementById('loginScreen').hidden, document.getElementById('loginError').textContent, document.getElementById('loginBtn').disabled]`);
report((setup[0] === false && /Setup needed/.test(setup[1]) && setup[2] === true ? 'PASS' : 'FAIL') + ' unconfigured: setup message, sign-in disabled');

// 2. The suite
await navigate(pathToFileURL(join(out, 'app.html')).href);
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
await evaluate(`(async () => { closeStoreModal(); window.print = () => {}; window.confirm = () => true; await printInvoices(); })()`);
// The first page as an image (A4 at 96 dpi = 794 × 1123 px). Taken before the
// PDF, because making a PDF fires "afterprint", which clears the invoices.
await send('Emulation.setEmulatedMedia', { media: 'print' });
await send('Emulation.setDeviceMetricsOverride', { width: 794, height: 1123, deviceScaleFactor: 1, mobile: false });
await evaluate(`(async () => { window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 300)); })()`);
await shot('invoice-page1.png');
await send('Emulation.setEmulatedMedia', { media: '' });
const pdf = Buffer.from((await send('Page.printToPDF', { preferCSSPageSize: true, printBackground: true })).result.data, 'base64');
writeFileSync(join(out, 'invoices.pdf'), pdf);
const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
report(`${pages === 4 ? 'PASS' : 'FAIL'} invoices.pdf has one A4 page per invoice (4)${pages === 4 ? '' : `  [${pages}]`}`);
const cleared = await evaluate(`document.getElementById('printArea').innerHTML === '' && !document.body.classList.contains('printing-invoices')`);
report(`${cleared ? 'PASS' : 'FAIL'} after printing, the app clears the invoices (afterprint)`);

console.log(`\nconsole errors: ${errors.length ? '\n  ' + errors.join('\n  ') : 'none'}`);
console.log(`${failed ? failed + ' failed' : 'all passed'} · screenshots and invoices.pdf in ${out}`);
ws.close();
proc.kill();
process.exit(failed || errors.length ? 1 : 0);
