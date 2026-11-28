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
  const invData = async storeId => invoiceData((await invoiceRecs([{ storeId, date: currentDate }], false))[0], M.db.business_settings[0]);
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
    ok('admin: all 7 tabs, starts on Orders', visibleTabs() === 'orders,route,totals,production,invoices,products,stores' && activePage() === 'orders', [visibleTabs(), activePage()]);

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

    // ── store payment mode + invoice details
    showPage('stores');
    openEditStore(7);
    ok('store form: payment mode Cash / Online, Cash by default', visible($('fPaySwitch'))
      && JSON.stringify([...$('fPaySwitch').querySelectorAll('button')].map(text)) === JSON.stringify(['💵 Cash', '📱 Online'])
      && $('fPaySwitch').querySelector('.on').textContent.includes('Cash'));
    $('fPaySwitch').querySelectorAll('button')[1].click();
    await saveStore();
    ok('payment mode Online saved for the store', dbStore(7).payment_mode === 'online' && STORES.find(s => s.id === 7).payment_mode === 'online', dbStore(7));
    openAddStore();
    ok('new store starts on Cash', $('fPayment').value === 'cash');
    closeStoreModal();
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
    ok('Route tab: no Cash / Online / Unpaid buttons', !document.querySelector('#page-route .pay-chip') && typeof setPayment === 'undefined');
    showPage('totals');
    const cardsTxt = [...document.querySelectorAll('#moneyGrid .money-card')].map(text);
    ok('Totals: sales split into Cash and Online by store payment mode', cardsTxt.includes('$62.50💵 Cash') && cardsTxt.includes('$5.00📱 Online') && !cardsTxt.some(t => /Unpaid|Not recorded/.test(t)), cardsTxt);
    showPage('route');
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
    const inv3 = await invData(3), no3 = `${yymmdd}-003`;
    ok('invoice number = date + store; issue date DD/MM/YYYY; due C.O.D.', inv3.no === no3 && pdfHas(no3)
      && pdfHas(D.split('-').reverse().join('/')) && pdfHas('C.O.D.'));
    ok('business details from the database', pdfHas('Test Bakery (Example)') && pdfHas('Phone: 0400 000 000') && pdfHas('ABN: 11 111 111 111'));
    ok('Billed To: contact, store, address, phone, ABN', JSON.stringify(inv3.to) === JSON.stringify(
      ['Sam Test', 'Hamara Gaadi (Kellyville)', '3 Test St, Kellyville NSW 2000', 'Phone: 0412 345 678', 'ABN: 12 345 678 901'])
      && pdfHas('Billed To') && inv3.to.every(pdfHas), inv3.to);
    ok('line: product, qty, price, total', JSON.stringify(inv3.rows) === JSON.stringify([{ name: '6 Pack', unpriced: false, qty: 10, price: 3, amount: 30 }])
      && pdfHas('$3.00') && pdfHas('$30.00'), inv3.rows);
    ok('GST-free tax line $0.00', invSum(inv3, 'Tax (GST-free)') === '$0.00' && pdfHas('Tax (GST-free)'));
    ok('balance due is the full amount; no "Total paid" line', money(inv3.due) === '$30.00' && !inv3.sums.some(([l]) => /paid/i.test(l)) && !pdfHas('Total paid'), inv3.sums);
    ok('payment mode bar under balance due: Cash', inv3.paymentMode === 'Cash' && pdfHas('Payment mode') && pdfHas('Cash'));
    ok('bank details with invoice number as reference', ['Bank deposit', 'Example Bank', '000-000', '12345678', 'Reference:'].every(pdfHas));
    ok('footer: number, due date, balance', pdfHas(`Invoice no: ${no3}`) && pdfHas('Due date: C.O.D.') && pdfHas('Balance due: $30.00'));
    const inv7 = await invData(7);
    ok('special price on the invoice; Online store -> payment mode Online', inv7.rows[0].price === 2.5 && inv7.rows[0].amount === 5 && money(inv7.due) === '$5.00'
      && inv7.paymentMode === 'Online' && pdfHas('Online') && pdfHas('$2.50') && pdfHas('Balance due: $5.00'));
    const inv6 = await invData(6);
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
    const c3 = await invData(3), c7 = await invData(7);
    ok('$5 order (under $30): sub-total, freight $5, fuel levy $2, balance $12',
      invSum(c7, 'Sub-total') === '$5.00' && invSum(c7, 'Freight') === '$5.00' && invSum(c7, 'Fuel levy') === '$2.00' && money(c7.due) === '$12.00'
      && pdfHas('Freight') && pdfHas('Fuel levy') && pdfHas('Balance due: $12.00'), c7.sums);
    ok('$30 order (not under $30): no freight, fuel levy only',
      !invSum(c3, 'Freight') && invSum(c3, 'Fuel levy') === '$2.00' && money(c3.due) === '$32.00', c3.sums);
    ok('stop amounts include the charges; no charges for a store with no order', storeAmount(7) === 12 && storeAmount(3) === 32 && storeAmount(1) === 0, [storeAmount(7), storeAmount(3), storeAmount(1)]);
    renderPriceBreakdown();
    ok('Bake tab: charges listed under the store, in its total', /Freight ?\$5\.00 ?Fuel levy ?\$2\.00/.test(text($('pb-7'))) && text($('pb-7').querySelector('.pb-store-total')) === '$12.00', text($('pb-7')));
    await setCharges(0, 5, 50);
    ok('fuel levy off (0): freight only', JSON.stringify(deliveryCharges(7)) === JSON.stringify([{ label: 'Freight', amount: 5 }]));
    await setCharges(0, 0, 0);

    // ── Invoices tab: cut-over, credits, issuing, locking, unlocking
    const k7 = `7|${D}`, k3 = `3|${D}`;
    const invRow = key => INV.rows.find(x => x.key === key);
    const openInv = async () => { showPage('invoices'); $('invFrom').value = D; $('invTo').value = D; await loadInvoicesPage(); };
    await openInv();
    ok('Invoices: one row per store with orders; before tracking until a start date is set',
      INV.rows.length === 4 && INV.rows.every(x => x.status === 'untracked') && $('invStart').classList.contains('warn'), INV.rows.map(x => x.status));
    $('invStartDate').value = D;
    await saveAccountsStart();
    ok('admin sets the tracking start date', M.db.business_settings[0].accounts_start === D && ACCOUNTS_START === D);
    ok('from the start date: not issued yet', INV.rows.every(x => x.status === 'draft') && /4 not issued/.test($('invSummary').textContent), $('invSummary').textContent);
    toggleInvoice(k7);
    ok('open invoice: total, credit form, Save PDF; no Unlock before issuing', !!document.querySelector('.inv-detail #crAmount')
      && /Save PDF/.test(text(document.querySelector('.inv-actions'))) && !/Unlock/.test(text(document.querySelector('.inv-actions'))));
    $('crAmount').value = '9'; $('crReason').value = 'too much';
    await addCredit(k7);
    ok('credit more than the invoice is refused', /can't be more than \$5\.00/.test(toast()) && M.db.invoice_credits.length === 0, toast());
    $('crAmount').value = '2'; $('crReason').value = 'returned';
    await addCredit(k7);
    ok('credit saved and shown: balance $5 - $2 = $3', M.db.invoice_credits.length === 1 && M.db.invoice_credits[0].amount === 2
      && invRow(k7).net === 3 && /Credit: returned/.test(text(document.querySelector('.inv-detail'))), invRow(k7));

    showPage('route');
    lastPdf = null;
    await printInvoices();
    ok('printing from Route issues the day\'s invoices', M.db.invoices.length === 4 && M.db.invoice_lines.length === 4, M.db.invoices.length);
    ok('credit printed on the invoice', pdfHas('Credit: returned') && pdfHas('-$2.00') && pdfHas('Balance due: $3.00'));
    await openInv();
    ok('Invoices: now issued', INV.rows.every(x => x.status === 'issued') && invRow(k7).inv.total === 5);

    // the order changes after issuing: the invoice keeps its amounts
    showPage('orders');
    changeQty(7, '1', 1); changeQty(7, '1', 1);
    await until(() => !pending.size && dbQty(D, 7, 1) === 4);
    await openInv();
    ok('order changed after issuing: flagged, amounts kept', invRow(k7).changed && invRow(k7).total === 5 && !invRow(k3).changed, invRow(k7));
    showPage('route');
    confirmAnswer = false; lastPdf = null;
    await printInvoices();
    ok('Route print warns about a changed order (Cancel prints nothing)', lastPdf === null);
    confirmAnswer = true;
    await openInv();
    INV.open = null; toggleInvoice(k7);
    ok('admin sees Unlock on an issued invoice', /Unlock/.test(text(document.querySelector('.inv-actions'))));
    await unlockInvoice(k7);
    ok('unlock: follows the order again, credit kept', !M.db.invoices.some(i => i.store_id === 7) && invRow(k7).status === 'draft'
      && invRow(k7).total === 10 && invRow(k7).net === 8 && M.db.invoice_credits.length === 1, invRow(k7));

    // Save PDF of one invoice issues it; the filtered list as one PDF
    let savedName = null;
    const realSavePdf = window.savePdfFile;
    window.savePdfFile = (doc, name) => { savedName = name; lastPdf = doc.output(); };
    await invoicePdf(k7);
    ok('Save PDF of one invoice: issued and saved', savedName === `invoice-${yymmdd}-007.pdf` && M.db.invoices.some(i => i.store_id === 7 && i.total === 10)
      && pdfPages() === 1 && pdfHas('Balance due: $8.00'), [savedName, pdfPages()]);
    $('invoices-search').value = 'hamara';
    renderInvoiceList();
    ok('search filters the list', filteredInvoiceRows().length === 1 && document.querySelectorAll('#invList .inv-item').length === 1);
    await invoicesBulk('save');
    ok('Save PDF of the filtered list', savedName === `invoices-${D}-to-${D}.pdf` && pdfPages() === 1 && pdfHas('Hamara Gaadi (Kellyville)'), savedName);
    $('invoices-search').value = '';
    $('invStatus').value = 'issued'; renderInvoiceList();
    ok('status filter', filteredInvoiceRows().length === 4);
    $('invStatus').value = 'all';
    window.savePdfFile = realSavePdf;

    // put store 7's order back
    showPage('orders');
    changeQty(7, '1', -1); changeQty(7, '1', -1);
    await until(() => !pending.size && dbQty(D, 7, 1) === 2);
    await unlockInvoice(k7);

    // ── Customers (admin): balances, payments, opening balances
    await openInv();
    setInvoiceView('customers');
    await loadCustomers();
    const cust = id => CUST.rows.find(x => x.storeId === id);
    ok('Customers: balances from saved invoices (store 7 not issued yet)', cust(3).owing === 30 && cust(4).owing === 32.5 && cust(7).owing === 0
      && /Owed to you: \$62\.50 · 2 stores owe/.test($('custSummary').textContent) && !$('custView').hidden && $('invView').hidden, $('custSummary').textContent);
    await toggleCustomer(3);
    ok('customer detail: unpaid invoice, amount owing filled in, store payment mode', /261\d{3}-003|Unpaid/.test(text(document.querySelector('#custList .inv-detail')))
      && $('payAmount').value === '30.00' && $('payMethod').value === 'cash', text(document.querySelector('#custList .inv-detail')));
    $('payAmount').value = '20'; $('payRef').value = 'cash on delivery';
    await recordPayment(3);
    ok('payment recorded: owing $10', M.db.customer_payments.length === 1 && M.db.customer_payments[0].amount === 20 && cust(3).owing === 10, cust(3));
    setInvoiceView('invoices');
    await loadInvoicesPage();
    $('invStatus').value = 'unpaid'; renderInvoiceList();
    ok('Invoices: Unpaid filter shows part-paid and unpaid', filteredInvoiceRows().map(x => `${x.storeId}:${x.payStatus}`).sort().join() === '3:part,4:unpaid,6:paid'.replace(',6:paid', '')
      && /Part paid/.test(text($('invList'))), filteredInvoiceRows().map(x => `${x.storeId}:${x.payStatus}:${x.balance}`));
    ok('Invoices summary shows the unpaid total', /\$42\.50 unpaid/.test($('invSummary').textContent), $('invSummary').textContent);
    setInvoiceView('customers');
    await loadCustomers();
    $('payAmount').value = '10';
    await recordPayment(3);
    ok('paid up', cust(3).owing === 0 && /Paid up/.test(text(document.querySelector('#custList [data-store="3"]'))));
    $('openingAmount').value = '15';
    await saveOpening(3);
    ok('opening balance: owed again, paid off first', cust(3).owing === 15 && M.db.opening_balances[0].amount === 15);
    const p = M.db.customer_payments[0].id;
    await deletePayment(p);
    ok('deleting a payment recalculates', M.db.customer_payments.length === 1 && cust(3).owing === 35, cust(3));
    // tidy up for the tests below
    $('openingAmount').value = ''; await saveOpening(3);
    await deletePayment(M.db.customer_payments[0].id);
    ok('opening balance 0 and no payments: owing back to $30', cust(3).owing === 30, cust(3));
    setInvoiceView('invoices');
    $('invStatus').value = 'all';

    // ── Sharing invoices and statements, CSV export
    {
      const realSave = window.savePdfFile, realCanShare = window.canShareFiles, realDownload = window.downloadFile;
      const realShare = navigator.share;
      let saved = [], shared = [], downloads = [];
      window.savePdfFile = (doc, name) => saved.push({ name, text: doc.output() });
      window.downloadFile = (name, text) => downloads.push({ name, text });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async ({ files }) => { shared.push({ name: files[0].name, text: await files[0].text() }); } });
      try {
        await openInv();
        // computer: no Share sheet, the PDF is saved and the invoice marked sent
        window.canShareFiles = () => false;
        await shareInvoice(k3);
        await until(() => M.db.invoices.find(i => i.store_id === 3).sent_at);
        ok('computer: Share saves the invoice PDF and marks it sent', saved.length === 1 && saved[0].name === `invoice-${yymmdd}-003.pdf`
          && !!M.db.invoices.find(i => i.store_id === 3).sent_at && $('shareSheet').hidden, saved.map(s => s.name));
        await loadInvoicesPage();
        ok('sent invoices show "Sent"', /Sent/.test(text(document.querySelector(`#invList [data-key="${k3}"]`))));
        // phone: a Share button opens the Share sheet on its own tap
        window.canShareFiles = () => true;
        await shareInvoice(`4|${D}`);
        ok('phone: Share button for the invoice', !$('shareSheet').hidden && $('shareList').querySelectorAll('button').length === 1 && shared.length === 0);
        await sharePdfItem(0);
        ok('phone: Share sheet gets the invoice PDF; marked sent', shared.length === 1 && shared[0].name === `invoice-${yymmdd}-004.pdf`
          && /Big Apple/.test(shared[0].text) && $('share-0').textContent === '✓ Done', shared.map(s => s.name));
        await until(() => M.db.invoices.find(i => i.store_id === 4).sent_at);
        closeShareSheet();

        // statements for everyone owing in the dates at the top
        setInvoiceView('customers');
        await loadCustomers();
        shared = [];
        await sendStatements();
        ok('statements: one per store owing (2)', !$('shareSheet').hidden && $('shareList').querySelectorAll('.share-row').length === 2,
          text($('shareList')));
        await sharePdfItem(0);
        const st = shared[0]?.text || '';
        const stPages = (st.match(/\/Type \/Page[^s]/g) || []).length;
        ok('statement PDF: title, unpaid invoice, amount due, then the invoice itself', /\(STATEMENT\)/.test(st) && st.includes(`(${yymmdd}-004)`)
          && st.includes('(Amount due: $32.50)') && stPages === 2 && /statement-Big-Apple-Tallawong-/.test(shared[0].name), [shared[0]?.name, stPages]);
        closeShareSheet();
        $('stmtWithInvoices').checked = false;
        shared = [];
        await sendStatements(3);
        await sharePdfItem(0);
        ok('one store\'s statement, without the invoices', shared.length === 1 && (shared[0].text.match(/\/Type \/Page[^s]/g) || []).length === 1
          && shared[0].text.includes('(Amount due: $30.00)'));
        closeShareSheet();
        $('stmtWithInvoices').checked = true;

        // CSV
        M.db.customer_payments.push({ id: 500, store_id: 3, paid_on: D, amount: 10, method: 'online', reference: '=HYPERLINK("x")' });
        exportInvoicesCsv();
        await exportPaymentsCsv();
        const inv = downloads[0]?.text.split('\r\n') || [], pay = downloads[1]?.text.split('\r\n') || [];
        ok('invoices CSV: header + one row per invoice', downloads[0]?.name === `invoices-${D}-to-${D}.csv` && inv.length === 6
          && inv[0] === 'Date,Invoice no,Store,Status,Sub-total,Freight,Fuel levy,Total,Credits,Paid,Balance,Payment mode'
          && inv.some(l => l.startsWith(`${D},${yymmdd}-007,Uma Mart,Not issued,`)), inv);
        ok('payments CSV, with formulas made harmless', downloads[1]?.name === `payments-${D}-to-${D}.csv`
          && pay[1] === `${D},Hamara Gaadi (Kellyville),10,Online,"'=HYPERLINK(""x"")"`, pay);
        M.db.customer_payments.length = 0;
      } finally {
        window.savePdfFile = realSave; window.canShareFiles = realCanShare; window.downloadFile = realDownload;
        if (realShare) Object.defineProperty(navigator, 'share', { configurable: true, value: realShare }); else delete navigator.share;
        setInvoiceView('invoices');
      }
    }

    // ── routes still work
    showPage('stores');
    openEditStore(4); pickFormRoute(2); await saveStore();
    showPage('orders');
    ok('store moved to route 2', dbStore(4).route === 2 && cards().length === 21 && switchText() === `${R1} · 21 | ${R2} · 1`, switchText());
    setRoute(1);

    // ════ BAKER ════════════════════════════════════════════════════════
    await login('baker@test.com');
    ok('baker: tabs Orders/Route/Totals/Bake/Invoices, starts on Bake', visibleTabs() === 'orders,route,totals,production,invoices' && activePage() === 'production', [visibleTabs(), activePage()]);
    ok('baker: store-wise lines from the server', /2 × 6 Pack @ \$2\.50/.test(text($('pb-7'))) && $('pb-total').textContent === '$67.50');
    ok('baker: no price list loaded', !Object.keys(PRICES.normal).length);
    showPage('route');
    ok('baker: Print invoices button', visible($('printInvoicesBtn')));
    lastPdf = null;
    await printInvoices();
    const b3 = await invData(3);
    ok('baker prints the same invoices, with payment modes', pdfPages() === 4 && money(b3.due) === '$30.00'
      && b3.paymentMode === 'Cash' && (await invData(7)).paymentMode === 'Online' && pdfHas('Balance due: $30.00'), [pdfPages(), b3.sums]);
    showPage('invoices'); $('invFrom').value = D; $('invTo').value = D; await loadInvoicesPage();
    INV.open = null; toggleInvoice(`7|${D}`);
    ok('baker: Invoices tab, sees the credit, no Unlock or remove-credit', INV.rows.length === 4 && INV.rows.every(x => x.status === 'issued')
      && /Credit: returned/.test(text(document.querySelector('.inv-detail'))) && !document.querySelector('.inv-detail .inv-x')
      && !/Unlock/.test(text(document.querySelector('.inv-actions'))) && !document.querySelector('#invStartDate'));
    ok('baker: no Customers view, no paid/unpaid filters or payment status', !visible($('invViewSwitch'))
      && ![...$('invStatus').options].some(o => /paid/i.test(o.value)) && !/Paid|Unpaid/.test(text($('invList'))));
    $('crAmount').value = '1'; $('crReason').value = 'broken pack';
    await addCredit(`7|${D}`);
    ok('baker gives a credit', M.db.invoice_credits.length === 2 && M.db.invoice_credits[1].updated_by === 'u-baker');

    // ════ DRIVER ═══════════════════════════════════════════════════════
    await login('driver@test.com');
    ok('driver: tabs Route/Totals, starts on Route', visibleTabs() === 'route,totals' && activePage() === 'route');
    ok('driver: Save PDF + Print invoices', JSON.stringify([...document.querySelectorAll('#page-route .route-actions button')].map(b => text(b))) === JSON.stringify(['📄 Save PDF', '🖨 Print invoices']));
    lastPdf = null;
    await printInvoices();
    const d7 = await invData(7);
    ok('driver prints invoices with store prices', pdfPages() === 4 && d7.rows[0].price === 2.5 && d7.rows[0].qty === 2 && pdfHas('$2.50'), [pdfPages(), d7.rows]);
    Object.assign(M.db.business_settings[0], { fuel_levy: 2, freight_fee: 5, freight_under: 50 });
    await refreshCatalog();
    showPage('route');
    ok('driver: amount to collect includes freight + fuel levy', storeAmount(7) === 12
      && [...document.querySelectorAll('#page-route .stop-amount')].map(text).includes('$12.00'),
      [...document.querySelectorAll('#page-route .stop-amount')].map(text));
    Object.assign(M.db.business_settings[0], { fuel_levy: 0, freight_fee: 0, freight_under: 0 });
    await refreshCatalog();
    ok('driver: still no price list', !Object.keys(PRICES.normal).length);

    // ════ NO ROLE ══════════════════════════════════════════════════════
    await login('new@test.com');
    ok('no role: notice, no tabs', /no role yet/.test($('loginError').textContent) && visibleTabs() === '');
    await signOutNow();
  } catch (e) {
    R.push('EXCEPTION ' + e.stack);
  }
  return R;
};
