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

  // Printing: count print() calls instead of opening the dialog
  let printCalls = 0;
  window.print = () => { printCalls++; };
  let confirmAnswer = true;
  window.confirm = () => confirmAnswer;
  const invoices = () => [...document.querySelectorAll('#printArea .invoice')];
  const invoiceFor = name => invoices().find(inv => text(inv.querySelector('.inv-to')).includes(name));
  const invRows = inv => [...inv.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(td => text(td)).join(' | '));
  const invSum = (inv, label) => text([...inv.querySelectorAll('.inv-sums .row')].find(r => text(r).startsWith(label))?.lastElementChild);
  const lines = el => [...(el?.children || [])].map(text);
  const afterPrint = () => window.dispatchEvent(new Event('afterprint'));

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

    // ── printing invoices
    confirmAnswer = false;
    await printInvoices();
    ok('unpriced line: asks first; "Cancel" prints nothing', printCalls === 0 && invoices().length === 0);
    confirmAnswer = true;
    await printInvoices();
    ok('one print job with one invoice per store with orders', printCalls === 1 && invoices().length === 4, [printCalls, invoices().length]);
    const order = invoices().map(inv => text(inv.querySelector('.inv-meta strong')).slice(-3));
    ok('invoices in delivery order (stores 3, 4, 6, 7)', order.join() === '003,004,006,007', order);
    const inv3 = invoiceFor('Hamara Gaadi (Kellyville)');
    const no3 = `${yymmdd}-003`;
    ok('invoice number = date + store', text(inv3.querySelector('.inv-meta')).includes(no3), text(inv3.querySelector('.inv-meta')));
    ok('issue date DD/MM/YYYY, due C.O.D.', text(inv3.querySelector('.inv-meta')).includes(D.split('-').reverse().join('/')) && text(inv3.querySelector('.inv-meta')).includes('C.O.D.'));
    ok('business details from the database', /Test Bakery \(Example\).*Phone: 0400 000 000.*ABN: 11 111 111 111/.test(text(inv3.querySelector('.inv-from'))), text(inv3.querySelector('.inv-from')));
    ok('Billed To: contact, store, address, phone, ABN on separate lines', JSON.stringify(lines(inv3.querySelector('.inv-to'))) === JSON.stringify(
      ['Billed To', 'Sam Test', 'Hamara Gaadi (Kellyville)', '3 Test St, Kellyville NSW 2000', 'Phone: 0412 345 678', 'ABN: 12 345 678 901']), lines(inv3.querySelector('.inv-to')));
    ok('line: product, qty, price, total', JSON.stringify(invRows(inv3)) === JSON.stringify(['6 Pack | 10 | $3.00 | $30.00']), invRows(inv3));
    ok('GST-free tax line $0.00', invSum(inv3, 'Tax (GST-free)') === '$0.00');
    ok('paid in cash -> total paid $30, balance due $0', invSum(inv3, 'Total paid (cash)') === '$30.00' && invSum(inv3, 'Balance due') === '$0.00');
    ok('bank details with invoice number as reference', /Bank deposit.*Example Bank.*BSB:000-000.*Account:12345678.*Reference:/.test(text(inv3.querySelector('.inv-pay'))) && text(inv3.querySelector('.inv-pay')).endsWith(no3), text(inv3.querySelector('.inv-pay')));
    ok('footer: number, due date, balance', JSON.stringify(lines(inv3.querySelector('.inv-foot'))) === JSON.stringify([`Invoice no: ${no3}`, 'Due date: C.O.D.', 'Balance due: $0.00']), lines(inv3.querySelector('.inv-foot')));
    const inv7 = invoiceFor('Uma Mart');
    ok('special price on the invoice, unpaid -> balance due', JSON.stringify(invRows(inv7)) === JSON.stringify(['6 Pack | 2 | $2.50 | $5.00']) && invSum(inv7, 'Balance due') === '$5.00' && invSum(inv7, 'Total paid') === '$0.00');
    const inv6 = invoiceFor('Anda Chowk');
    ok('unpriced line marked, prints as $0.00', invRows(inv6)[0] === 'Usal Pav (no price set) | 1 | – | $0.00', invRows(inv6));
    ok('logo on every invoice from gj06-logo.png', invoices().every(inv => inv.querySelector('.inv-logo').getAttribute('src') === 'gj06-logo.png'));
    ok('while printing, only the invoices are printable', document.body.classList.contains('printing-invoices'));
    afterPrint();
    ok('after printing: invoices cleared, app back to normal', invoices().length === 0 && !document.body.classList.contains('printing-invoices'));

    M.db.business_settings[0].business_name = '';
    await printInvoices();
    ok('empty business details: clear message, nothing printed', printCalls === 1 && /Business details are empty/.test(toast()), toast());
    M.db.business_settings[0].business_name = 'Test Bakery (Example)';

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
    await printInvoices();
    const b3 = invoiceFor('Hamara Gaadi (Kellyville)');
    ok('baker prints the same invoices; payments not visible -> full balance due', invoices().length === 4 && invSum(b3, 'Balance due') === '$30.00' && invSum(b3, 'Total paid') === '$0.00');
    afterPrint();

    // ════ DRIVER ═══════════════════════════════════════════════════════
    await login('driver@test.com');
    ok('driver: tabs Route/Totals, starts on Route', visibleTabs() === 'route,totals' && activePage() === 'route');
    ok('driver: Save PDF + Print invoices', JSON.stringify([...document.querySelectorAll('#page-route .route-actions button')].map(b => text(b))) === JSON.stringify(['📄 Save PDF', '🖨 Print invoices']));
    await printInvoices();
    const d7 = invoiceFor('Uma Mart');
    ok('driver prints invoices with store prices', invoices().length === 4 && JSON.stringify(invRows(d7)) === JSON.stringify(['6 Pack | 2 | $2.50 | $5.00']), invoices().length);
    afterPrint();
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
