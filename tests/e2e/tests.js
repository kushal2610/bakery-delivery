// In-page test suite for index.html, run by e2e/run.mjs against the fake
// Supabase in mock_supabase.js. Returns a list of "PASS …" / "FAIL …" lines.
window.runTests = async function () {
  const R = [];
  const ok = (name, cond, extra) => R.push(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : '  [' + JSON.stringify(extra) + ']'}`);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  async function until(fn, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (fn()) return true; } catch (_) {} await wait(20); } return false; }
  const M = window.__mock;
  const $ = id => document.getElementById(id);
  const visible = el => !!el && el.offsetParent !== null;
  const toast = () => $('toast').textContent;
  const dbQty = (date, s, p) => M.db.order_items.find(r => r.delivery_date === date && r.store_id === s && r.product_id === p)?.qty;
  const dbStore = id => M.db.stores.find(s => s.id === id);
  const writes = (t, op) => M.log.filter(l => l.t === t && (!op || l.op === op));
  const visibleTabs = () => [...document.querySelectorAll('.tab')].filter(visible).map(t => t.id.replace('tab-', '')).join(',');
  const activePage = () => document.querySelector('.page.active').id.replace('page-', '');
  const cards = () => [...document.querySelectorAll('#storeList .store-card')].map(c => Number(c.id.slice(5)));
  const switchText = () => [...document.querySelectorAll('#page-orders .route-opt')].map(b => b.childNodes[0].textContent.trim()).join(' | ');
  const typeQty = async (pid, store, v) => { const el = $(`${pid}-${store}`); el.value = v; el.dispatchEvent(new Event('change')); await until(() => !pending.size); };
  const rowState = pid => $(`baked-${pid}`).closest('.prod-row').className.replace('prod-row', '').trim();
  const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const R1 = ROUTES[1].label, R2 = ROUTES[2].label;

  // Printing: keep the invoice PDF (uncompressed, so its text is readable)
  // instead of opening the print dialog
  let printCalls = 0, lastPdf = null;
  window.printPdfBlob = async blob => { printCalls++; lastPdf = await blob.text(); return true; };
  let confirmAnswer = true;
  window.confirm = () => confirmAnswer;
  const pdfPages = () => (lastPdf?.match(/\/Type \/Page[^s]/g) || []).length;
  const pdfHas = s => !!lastPdf?.includes(`(${String(s).replace(/[()\\]/g, '\\$&')})`);
  const invData = storeId => invoiceData(STORES.find(s => s.id === storeId),
    PRODUCTS.map(p => ({ p, l: invoiceLine(storeId, p.id) })).filter(x => x.l), M.db.business_settings[0], currentDate);
  const invSum = (inv, label) => { const r = inv.sums.find(([l]) => l === label); return r ? money(r[1]) : ''; };

  async function login(email) {
    if (currentUser) await signOutNow();
    $('loginEmail').value = email; $('loginPassword').value = 'pw';
    await signIn();
    await until(() => dataLoaded && (profile.role || !$('loginScreen').hidden));
    await wait(30);
  }

  try {
    // ════ ADMIN ════════════════════════════════════════════════════════
    await until(() => !$('loginScreen').hidden);
    $('loginEmail').value = 'owner@test.com'; $('loginPassword').value = 'nope';
    await signIn();
    ok('wrong password: friendly error', $('loginError').textContent === 'Wrong email or password');
    await login('owner@test.com');
    const D = currentDate;
    const yymmdd = D.slice(2).replaceAll('-', '');
    ok('admin: all 6 tabs, starts on Orders', visibleTabs() === 'orders,route,totals,production,products,stores' && activePage() === 'orders', [visibleTabs(), activePage()]);

    // logo comes from the file, not an embedded copy
    ok('logo loaded from gj06-logo.png everywhere', $('splashLogo')?.getAttribute('src') === 'gj06-logo.png'
      && document.querySelector('.login-logo').getAttribute('src') === 'gj06-logo.png'
      && document.querySelector('link[rel=icon]').getAttribute('href') === 'gj06-logo.png'
      && !/data:image\/(png|jpe?g);base64/.test(document.documentElement.outerHTML));
    await until(() => $('splashLogo').complete);
    ok('logo file actually loads', $('splashLogo').naturalWidth > 0);

    setRoute(1);
    ok('route toggle shows store counts', switchText() === `${R1} · 22 | ${R2} · 0`, switchText());

    changeQty(3, '1', 1); await wait(100); changeQty(3, '1', 1); await wait(100); changeQty(3, '1', 1);
    await until(() => dbQty(D, 3, 1) === 3 && !pending.size);
    ok('3 quick taps -> 1 save', writes('order_items', 'upsert').length === 1);

    // ── prices: 6 Pack $3, 9 Pack $3.25
    for (const [pid, price] of [['1', '3'], ['2', '3.25']]) { openEditProduct(pid); $('pPrice').value = price; await saveProduct(); }
    ok('price labels say nothing about GST included', !document.body.innerHTML.includes('inc. GST'));
    showPage('orders');
    await typeQty('1', 3, '10');
    await typeQty('2', 4, '10');
    openEditStore(7); $('sp-1').value = '2.5'; await saveStore();
    showPage('orders');
    changeQty(7, '1', 1); changeQty(7, '1', 1);
    changeQty(6, '3', 1);  // Usal Pav has no price
    await until(() => !pending.size && linePrices['7|1'] === 2.5 && linePrices['4|2'] === 3.25);
    showPage('totals');
    ok('totals: value per product', $('totamt-1').textContent === '$35.00' && $('totamt-2').textContent === '$32.50', [$('totamt-1').textContent, $('totamt-2').textContent]);
    ok('totals: $67.50 + unpriced warning', $('tot-amount').textContent.startsWith('$67.50') && /1 item without a price/.test($('tot-amount').textContent), $('tot-amount').textContent);

    // ── Bake tab: store invoices + production check
    showPage('production');
    ok('Bake: store-wise lines (Uma Mart 2 × 6 Pack @ $2.50)', /2 × 6 Pack @ \$2\.50/.test(text($('pb-7'))) && text($('pb-7').querySelector('.pb-store-total')) === '$5.00', text($('pb-7')));
    ok('Bake: grand total', $('pb-total').textContent === '$67.50');
    await setBaked('1', '12'); await setBaked('2', '8');
    ok('production: equal -> green, short -> red', rowState('1') === 'ok' && rowState('2') === 'short' && $('diff-2').textContent === '-2');
    ok('production status names the shortfall', /Short: 9 Pack -2/.test($('prodStatus').textContent), $('prodStatus').textContent);

    // ── payment + store invoice details
    await setPayment(3, 'cash');
    showPage('stores');
    openEditStore(3);
    ok('store form has contact, phone and ABN fields', ['fContact', 'fPhone', 'fAbn'].every(id => visible($(id))));
    $('fContact').value = 'Sam Test'; $('fPhone').value = '0412 345 678'; $('fAbn').value = '12345';
    await saveStore();
    ok('ABN that is not 11 digits is refused', /ABN must be 11 digits/.test(toast()) && dbStore(3).abn === '', toast());
    $('fAbn').value = '12  345 678 901';
    await saveStore();
    ok('contact, phone and ABN saved', dbStore(3).contact_name === 'Sam Test' && dbStore(3).phone === '0412 345 678' && dbStore(3).abn === '12 345 678 901', dbStore(3));
    openEditStore(3);
    ok('store form shows saved details again', $('fContact').value === 'Sam Test' && $('fAbn').value === '12 345 678 901');
    closeStoreModal();

    // ── Route tab: only Save PDF + Print invoices
    showPage('route');
    const btns = [...document.querySelectorAll('#page-route .route-actions button')].map(b => text(b));
    ok('Route tab buttons: Save PDF and Print invoices only', JSON.stringify(btns) === JSON.stringify(['📄 Save PDF', '🖨 Print invoices']), btns);
    ok('Maps and Copy Table code removed', typeof openMaps === 'undefined' && typeof copyCleanTable === 'undefined');

    // ── printing invoices (a PDF, printed from a hidden frame on a computer)
    confirmAnswer = false;
    await printInvoices();
    ok('unpriced line: asks first; "Cancel" prints nothing', printCalls === 0 && lastPdf === null);
    confirmAnswer = true;
    await printInvoices();
    ok('one PDF printed with one A4 page per store with orders', printCalls === 1 && pdfPages() === 4 && /\/MediaBox \[0 0 595\.2\d* 841\.8\d*\]/.test(lastPdf), [printCalls, pdfPages()]);
    const order = [...lastPdf.matchAll(/\((\d{6}-\d{3})\) Tj/g)].map(m => m[1].slice(-3)).filter((x, i, a) => a.indexOf(x) === i);
    ok('invoices in delivery order (stores 3, 4, 6, 7)', order.join() === '003,004,006,007', order);
    const inv3 = invData(3), no3 = `${yymmdd}-003`;
    ok('invoice number = date + store; issue date DD/MM/YYYY; due C.O.D.', inv3.no === no3 && pdfHas(no3)
      && pdfHas(D.split('-').reverse().join('/')) && pdfHas('C.O.D.'));
    ok('business details from the database', pdfHas('Test Bakery (Example)') && pdfHas('Phone: 0400 000 000') && pdfHas('ABN: 11 111 111 111'));
    ok('Billed To: contact, store, address, phone, ABN', JSON.stringify(inv3.to) === JSON.stringify(
      ['Sam Test', 'Hamara Gaadi (Kellyville)', '3 Test St, Kellyville NSW 2000', 'Phone: 0412 345 678', 'ABN: 12 345 678 901'])
      && pdfHas('Billed To') && inv3.to.every(pdfHas), inv3.to);
    ok('line: product, qty, price, total', JSON.stringify(inv3.rows) === JSON.stringify([{ name: '6 Pack', unpriced: false, qty: 10, price: 3, amount: 30 }])
      && pdfHas('$3.00') && pdfHas('$30.00'), inv3.rows);
    ok('GST-free tax line $0.00', invSum(inv3, 'Tax (GST-free)') === '$0.00' && pdfHas('Tax (GST-free)'));
    ok('paid in cash -> total paid $30, balance due $0', invSum(inv3, 'Total paid (cash)') === '$30.00' && money(inv3.due) === '$0.00' && pdfHas('Total paid (cash)'));
    ok('bank details with invoice number as reference', ['Bank deposit', 'Example Bank', '000-000', '12345678', 'Reference:'].every(pdfHas));
    ok('footer: number, due date, balance', pdfHas(`Invoice no: ${no3}`) && pdfHas('Due date: C.O.D.') && pdfHas('Balance due: $0.00'));
    const inv7 = invData(7);
    ok('special price on the invoice, unpaid -> balance due', inv7.rows[0].price === 2.5 && inv7.rows[0].amount === 5 && money(inv7.due) === '$5.00'
      && invSum(inv7, 'Total paid') === '$0.00' && pdfHas('$2.50') && pdfHas('Balance due: $5.00'));
    const inv6 = invData(6);
    ok('unpriced line marked, prints as $0.00', inv6.rows[0].unpriced && inv6.rows[0].amount === 0 && pdfHas('(no price set)') && pdfHas('Usal Pav'), inv6.rows);
    ok('logo from gj06-logo.png, embedded once for all pages', (lastPdf.match(/\/Subtype \/Image/g) || []).length === 1);
    ok('no web page printed (nothing for the browser to add a web address to)', !document.getElementById('printArea') && typeof invoiceHtml === 'undefined');

    M.db.business_settings[0].business_name = '';
    await printInvoices();
    ok('empty business details: clear message, nothing printed', printCalls === 1 && /Business details are empty/.test(toast()), toast());
    M.db.business_settings[0].business_name = 'Test Bakery (Example)';

    // phone or tablet: the PDF is saved (then Share → Print), not printed from the page
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
    const realSave = window.savePdfFile;
    let saved = null;
    window.savePdfFile = (doc, name) => { saved = name; };
    try {
      await printInvoices();
    } finally {
      window.savePdfFile = realSave;
      delete navigator.userAgent;
    }
    ok('iPhone: invoices saved as a PDF with a hint, not printed from the page', saved === `invoices-${D}.pdf` && printCalls === 1 && /Share → Print/.test(toast()), [saved, printCalls, toast()]);

    // ── delivery charges: fuel levy on every delivery, freight under a threshold
    const setCharges = async (fuel_levy, freight_fee, freight_under) => {
      Object.assign(M.db.business_settings[0], { fuel_levy, freight_fee, freight_under });
      await refreshCatalog();
    };
    ok('charges off: invoice has no charge rows', storeAmount(7) === 5 && deliveryCharges(7).length === 0 && !pdfHas('Fuel levy'));
    await setCharges(2, 5, 30);
    await printInvoices();
    const c3 = invData(3), c7 = invData(7);
    ok('$5 order (under $30): sub-total, freight $5, fuel levy $2, balance $12',
      invSum(c7, 'Sub-total') === '$5.00' && invSum(c7, 'Freight') === '$5.00' && invSum(c7, 'Fuel levy') === '$2.00' && money(c7.due) === '$12.00'
      && pdfHas('Freight') && pdfHas('Fuel levy') && pdfHas('Balance due: $12.00'), c7.sums);
    ok('$30 order (not under $30): no freight, fuel levy only; cash paid covers it',
      !invSum(c3, 'Freight') && invSum(c3, 'Fuel levy') === '$2.00' && invSum(c3, 'Total paid (cash)') === '$32.00' && money(c3.due) === '$0.00', c3.sums);
    ok('stop amounts include the charges; no charges for a store with no order', storeAmount(7) === 12 && storeAmount(3) === 32 && storeAmount(1) === 0, [storeAmount(7), storeAmount(3), storeAmount(1)]);
    renderPriceBreakdown();
    ok('Bake tab: charges listed under the store, in its total', /Freight ?\$5\.00 ?Fuel levy ?\$2\.00/.test(text($('pb-7'))) && text($('pb-7').querySelector('.pb-store-total')) === '$12.00', text($('pb-7')));
    await setCharges(0, 5, 50);
    ok('fuel levy off (0): freight only', JSON.stringify(deliveryCharges(7)) === JSON.stringify([{ label: 'Freight', amount: 5 }]));
    await setCharges(0, 0, 0);

    // ── routes still work
    showPage('stores');
    openEditStore(4); pickFormRoute(2); await saveStore();
    showPage('orders');
    ok('store moved to route 2', dbStore(4).route === 2 && cards().length === 21 && switchText() === `${R1} · 21 | ${R2} · 1`, switchText());
    setRoute(1);

    // ════ BAKER ════════════════════════════════════════════════════════
    await login('baker@test.com');
    ok('baker: tabs Orders/Route/Totals/Bake, starts on Bake', visibleTabs() === 'orders,route,totals,production' && activePage() === 'production', [visibleTabs(), activePage()]);
    ok('baker: store-wise lines from the server', /2 × 6 Pack @ \$2\.50/.test(text($('pb-7'))) && $('pb-total').textContent === '$67.50');
    ok('baker: no price list or payments loaded', !Object.keys(PRICES.normal).length && !Object.keys(payments).length);
    showPage('route');
    ok('baker: Print invoices button', visible($('printInvoicesBtn')));
    lastPdf = null;
    await printInvoices();
    const b3 = invData(3);
    ok('baker prints the same invoices; payments not visible -> full balance due', pdfPages() === 4 && money(b3.due) === '$30.00'
      && invSum(b3, 'Total paid') === '$0.00' && pdfHas('Balance due: $30.00'), [pdfPages(), b3.sums]);

    // ════ DRIVER ═══════════════════════════════════════════════════════
    await login('driver@test.com');
    ok('driver: tabs Route/Totals, starts on Route', visibleTabs() === 'route,totals' && activePage() === 'route');
    ok('driver: Save PDF + Print invoices', JSON.stringify([...document.querySelectorAll('#page-route .route-actions button')].map(b => text(b))) === JSON.stringify(['📄 Save PDF', '🖨 Print invoices']));
    lastPdf = null;
    await printInvoices();
    const d7 = invData(7);
    ok('driver prints invoices with store prices', pdfPages() === 4 && d7.rows[0].price === 2.5 && d7.rows[0].qty === 2 && pdfHas('$2.50'), [pdfPages(), d7.rows]);
    Object.assign(M.db.business_settings[0], { fuel_levy: 2, freight_fee: 5, freight_under: 50 });
    await refreshCatalog();
    showPage('route');
    ok('driver: amount to collect includes freight + fuel levy', storeAmount(7) === 12
      && [...document.querySelectorAll('#page-route .stop-amount')].map(text).includes('$12.00'),
      [...document.querySelectorAll('#page-route .stop-amount')].map(text));
    Object.assign(M.db.business_settings[0], { fuel_levy: 0, freight_fee: 0, freight_under: 0 });
    await refreshCatalog();
    ok('driver: still no price list or payments', !Object.keys(PRICES.normal).length && !Object.keys(payments).length);

    // ════ NO ROLE ══════════════════════════════════════════════════════
    await login('new@test.com');
    ok('no role: notice, no tabs', /no role yet/.test($('loginError').textContent) && visibleTabs() === '');
    await signOutNow();
  } catch (e) {
    R.push('EXCEPTION ' + e.stack);
  }
  return R;
};
