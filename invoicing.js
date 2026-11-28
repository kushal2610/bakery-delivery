// Invoicing: invoice PDFs (Route tab and Invoices tab), saved invoices and
// credits. Loaded by index.html after its main script and uses its globals
// (sb, STORES, PRODUCTS, can, money, showToast, dbCall, chargesFor, …).
//
// An invoice is one store's deliveries on one date. From the cut-over date
// (business_settings.accounts_start) it is saved ("issued") the first time
// it is printed, saved or shared; after that it keeps its amounts even if the
// order changes. Before the cut-over, invoices are worked out from the order.

const LOGO_URL = 'gj06-logo.png';

// Invoice number from the delivery date and store: 16 Nov 2026, store 12 ->
// "261116-012". Unique per store and day, and the same on every reprint.
function invoiceNumber(iso, storeId) {
  return `${iso.slice(2).replaceAll('-', '')}-${String(storeId).padStart(3, '0')}`;
}

const auDate = iso => iso.split('-').reverse().join('/');  // 2026-11-16 -> 16/11/2026
const dayLabel = iso => parseIsoDate(iso).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
const cents = n => Math.round(n * 100) / 100;

let ACCOUNTS_START = null;  // first tracked date ('YYYY-MM-DD'), null = not set up
const isTracked = iso => !!ACCOUNTS_START && iso >= ACCOUNTS_START;

const storeById = id => STORES.find(s => s.id === Number(id))
  || { id: Number(id), name: `Store #${id}`, area: '', address: '', contact_name: '', phone: '', abn: '', payment_mode: 'cash' };
const productOrder = id => { const i = PRODUCTS.findIndex(p => Number(p.id) === Number(id)); return i < 0 ? 1e9 + Number(id) : i; };
const productName = id => PRODUCTS.find(p => Number(p.id) === Number(id))?.name || `Product #${id}`;
const creditsTotal = rec => rec.credits.reduce((sum, c) => sum + c.amount, 0);

// ── INVOICE RECORDS ──────────────────────────────────────────────────────────
// { storeId, date, no, store, invoiceId (null = not issued), lines, subtotal,
//   charges: [{label, amount}], credits: [{id, amount, reason}], total, paymentMode }

function issuedRec(inv, lineRows, credits) {
  const charges = [];
  if (Number(inv.freight) > 0) charges.push({ label: 'Freight', amount: Number(inv.freight) });
  if (Number(inv.fuel_levy) > 0) charges.push({ label: 'Fuel levy', amount: Number(inv.fuel_levy) });
  return {
    storeId: Number(inv.store_id), date: inv.delivery_date, no: inv.number, store: storeById(inv.store_id),
    invoiceId: inv.id, sentAt: inv.sent_at || null,
    lines: [...lineRows].sort((a, b) => productOrder(a.product_id) - productOrder(b.product_id)).map(l => ({
      name: l.product_name, qty: Number(l.qty), price: l.unit_price == null ? null : Number(l.unit_price), amount: Number(l.amount),
    })),
    subtotal: Number(inv.subtotal), charges, credits, total: Number(inv.total), paymentMode: inv.payment_mode,
  };
}

// Not issued: from the order lines (store_price_breakdown rows) and today's charges
function liveRec(storeId, date, rows, credits) {
  const store = storeById(storeId);
  const lines = [...rows].sort((a, b) => productOrder(a.product_id) - productOrder(b.product_id)).map(r => ({
    name: productName(r.product_id), qty: Number(r.qty), price: r.unit_price == null ? null : Number(r.unit_price), amount: Number(r.amount),
  }));
  const subtotal = cents(lines.reduce((sum, l) => sum + l.amount, 0));
  const charges = chargesFor(subtotal);
  return {
    storeId, date, no: invoiceNumber(date, storeId), store, invoiceId: null, sentAt: null,
    lines, subtotal, charges, credits, total: cents(charges.reduce((sum, c) => sum + c.amount, subtotal)), paymentMode: store.payment_mode,
  };
}

async function loadAccountsStart() {
  const { data, error } = await sb.from('business_settings').select('accounts_start').eq('id', 1).maybeSingle();
  if (!error) ACCOUNTS_START = data?.accounts_start || null;
}

// Invoice records for [{storeId, date}], in that order (stores without
// orders are left out). With `issue`, tracked ones are saved first.
async function invoiceRecs(keys, issue) {
  if (!keys.length) return [];
  const dates = [...new Set(keys.map(k => k.date))].sort();
  const from = dates[0], to = dates[dates.length - 1];
  if (issue) {
    for (const d of dates.filter(isTracked)) {
      const { error } = await sb.rpc('issue_invoices', { p_date: d, p_store_ids: keys.filter(k => k.date === d).map(k => k.storeId) });
      if (error) throw error;
    }
  }
  const [inv, cr] = await Promise.all([
    sb.from('invoices').select('*').gte('delivery_date', from).lte('delivery_date', to),
    sb.from('invoice_credits').select('*').gte('delivery_date', from).lte('delivery_date', to),
  ]);
  // Before schema.sql is re-run these tables don't exist: invoices are worked out as before
  const invoices = inv.error ? [] : inv.data, credits = cr.error ? [] : cr.data;
  const key = (s, d) => `${Number(s)}|${d}`;
  const issued = new Map(invoices.map(i => [key(i.store_id, i.delivery_date), i]));
  const ids = keys.map(k => issued.get(key(k.storeId, k.date))?.id).filter(Boolean);
  let lineRows = [];
  if (ids.length) {
    const res = await sb.from('invoice_lines').select('*').in('invoice_id', ids);
    if (res.error) throw res.error;
    lineRows = res.data;
  }
  const live = {};
  for (const d of dates) {
    if (!keys.some(k => k.date === d && !issued.has(key(k.storeId, d)))) continue;
    const { data, error } = await sb.rpc('store_price_breakdown', { p_date: d });
    if (error) throw error;
    live[d] = data || [];
  }
  return keys.map(k => {
    const cs = credits.filter(c => key(c.store_id, c.delivery_date) === key(k.storeId, k.date))
      .map(c => ({ id: c.id, amount: Number(c.amount), reason: c.reason || '' }));
    const i = issued.get(key(k.storeId, k.date));
    if (i) return issuedRec(i, lineRows.filter(l => l.invoice_id === i.id), cs);
    const rows = (live[k.date] || []).filter(r => Number(r.store_id) === k.storeId);
    return rows.length ? liveRec(k.storeId, k.date, rows, cs) : null;
  }).filter(Boolean);
}

// ── PDF ──────────────────────────────────────────────────────────────────────
// Everything printed on one invoice (amounts as numbers)
function invoiceData(rec, biz) {
  const has = (label, v) => (v ? `${label}${v}` : '');
  const store = rec.store;
  return {
    no: rec.no,
    date: auDate(rec.date),
    from: { name: biz.business_name, lines: [biz.address, has('Phone: ', biz.phone), has('ABN: ', biz.abn)].filter(Boolean) },
    to: [store.contact_name, store.name, store.address || store.area, has('Phone: ', store.phone), has('ABN: ', store.abn)].filter(Boolean),
    rows: rec.lines.map(l => ({ name: l.name, unpriced: l.price == null, qty: l.qty, price: l.price, amount: l.amount })),
    sums: [
      ['Sub-total', rec.subtotal],
      ...rec.charges.map(c => [c.label, c.amount]),
      ...rec.credits.map(c => [c.reason ? `Credit: ${c.reason}` : 'Credit', -c.amount]),
      ['Tax (GST-free)', 0],
    ],
    due: cents(rec.total - creditsTotal(rec)),
    paymentMode: PAY_MODE_NAMES[rec.paymentMode] || 'Cash',
    bank: [['Bank:', biz.bank_name], ['Name:', biz.account_name], ['BSB:', biz.bsb], ['Account:', biz.account_no]].filter(([, v]) => v),
  };
}

// The logo file as a data URL for the PDF (null if it can't be loaded)
async function logoDataUrl() {
  try {
    const res = await fetch(LOGO_URL);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch (_) { return null; }
}

// Drawing helpers shared by invoices and statements (A4, mm). Standard PDF
// fonts only cover Western characters.
function pdfKit(doc) {
  const pdfText = s => String(s ?? '').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  return {
    L: 16, R: 194, W: 178,
    ink: () => doc.setTextColor(17, 17, 17),
    font: (style, size) => { doc.setFont('helvetica', style); doc.setFontSize(size); },
    fit: (s, w) => doc.splitTextToSize(pdfText(s), w)[0] || '',
  };
}

// Title, logo, your details / Billed To, and the info strip; returns the y below it
function drawHeader(doc, title, from, to, meta, logo) {
  const { L, R, W, ink, font, fit } = pdfKit(doc);
  ink(); font('normal', 30);
  doc.text(title, L, 34, { charSpace: 3 });
  if (logo) { try { doc.addImage(logo, 'PNG', R - 40, 12, 40, 40 * 880 / 960, 'logo'); } catch (_) {} }

  let yL = 62, yR = 62;
  font('bold', 12); doc.text(fit(from.name, 100), L, yL); yL += 6;
  font('normal', 10); from.lines.forEach(s => { doc.text(fit(s, 100), L, yL); yL += 5; });
  font('bold', 12); doc.text('Billed To', R, yR, { align: 'right' }); yR += 6;
  font('normal', 10); to.forEach(s => { doc.text(fit(s, 75), R, yR, { align: 'right' }); yR += 5; });

  const y = Math.max(yL, yR) + 4;
  doc.setDrawColor(204, 204, 204); doc.setLineWidth(0.3);
  doc.rect(L, y, W, 14);
  meta.forEach(([label, value], i) => {
    const x = L + i * W / meta.length;
    if (i) doc.line(x, y, x, y + 14);
    font('normal', 7); doc.setTextColor(102, 102, 102); doc.text(label, x + 4, y + 5, { charSpace: 0.3 });
    font('bold', 11); ink(); doc.text(fit(value, W / meta.length - 6), x + 4, y + 11);
  });
  return y + 22;
}

// "How to pay" with bank details; returns nothing
function drawHowToPay(doc, bank, reference, y) {
  const { L, ink, font, fit } = pdfKit(doc);
  let yp = y + 4;
  font('bold', 12.5); ink(); doc.text('How to pay', L, yp); yp += 6;
  font('normal', 10);
  if (bank.length) {
    doc.text('Bank deposit', L, yp); yp += 5;
    [...bank, ['Reference:', reference]].forEach(([k, v]) => {
      font('bold', 10); doc.text(k, L, yp);
      font('normal', 10); doc.text(fit(v, 60), L + 25, yp); yp += 5;
    });
  }
}

// Dark bar with white text (label left, value right)
function drawBar(doc, x, y, w, label, value) {
  const { font } = pdfKit(doc);
  doc.setFillColor(26, 26, 26);  // set every time: white text also changes the fill colour
  doc.rect(x, y, w, 11, 'F');
  font('bold', 13); doc.setTextColor(255, 255, 255);
  doc.text(label, x + 4, y + 7.3);
  doc.text(value, x + w - 4, y + 7.3, { align: 'right' });
}

function drawFooter(doc, parts) {
  const { L, R, ink, font } = pdfKit(doc);
  ink(); font('italic', 24);
  doc.text('Thank You', 105, 266, { align: 'center' });
  doc.setDrawColor(204, 204, 204); doc.line(L, 274, R, 274);
  font('normal', 8.5); doc.setTextColor(102, 102, 102);
  doc.text(parts[0], L, 279);
  doc.text(parts[1], 105, 279, { align: 'center' });
  doc.text(parts[2], R, 279, { align: 'right' });
}

// One invoice (one A4 page, more if it has many lines)
function drawInvoice(doc, inv, logo) {
  const { L, R, W, ink, font, fit } = pdfKit(doc);
  let y = drawHeader(doc, 'INVOICE', inv.from, inv.to, [['INVOICE NO', inv.no], ['ISSUE DATE', inv.date], ['DUE DATE', 'C.O.D.']], logo);

  // Lines
  const col = { qty: 120, price: 157, total: R - 4 };
  const header = () => {
    doc.setFillColor(26, 26, 26); doc.rect(L, y, W, 9, 'F');
    font('bold', 10); doc.setTextColor(255, 255, 255);
    doc.text('Description', L + 4, y + 6);
    doc.text('Qty', col.qty, y + 6, { align: 'center' });
    doc.text('Price', col.price, y + 6, { align: 'right' });
    doc.text('Total', col.total, y + 6, { align: 'right' });
    y += 9;
  };
  header();
  inv.rows.forEach((row, i) => {
    if (y > 262) { doc.addPage(); y = 20; header(); }
    if (i % 2) { doc.setFillColor(236, 236, 236); doc.rect(L, y, W, 8, 'F'); }
    font('normal', 10); ink();
    const name = fit(row.name, row.unpriced ? 62 : 90);
    doc.text(name, L + 4, y + 5.5);
    if (row.unpriced) {
      const nameW = doc.getTextWidth(name);
      doc.setTextColor(183, 121, 31); doc.setFontSize(8.5);
      doc.text('(no price set)', L + 4 + nameW + 2, y + 5.5);
      ink(); doc.setFontSize(10);
    }
    doc.text(String(row.qty), col.qty, y + 5.5, { align: 'center' });
    doc.text(row.unpriced ? '-' : money(row.price), col.price, y + 5.5, { align: 'right' });
    doc.text(money(row.amount), col.total, y + 5.5, { align: 'right' });
    y += 8;
  });

  // How to pay + sums (moved to a new page if they don't fit)
  const sumsH = inv.sums.length * 6 + 26;
  const payH = inv.bank.length ? (inv.bank.length + 2) * 5 + 7 : 7;
  if (y + 9 + Math.max(sumsH, payH) > 255) { doc.addPage(); y = 20; } else y += 9;
  drawHowToPay(doc, inv.bank, inv.no, y);
  const sx = R - 78;
  let ys = y + 4;
  font('normal', 10); ink();
  inv.sums.forEach(([label, amount]) => {
    doc.text(fit(label, 52), sx + 4, ys);
    doc.text(money(amount), R - 4, ys, { align: 'right' });
    ys += 6;
  });
  drawBar(doc, sx, ys - 2, 78, 'Balance due', money(inv.due));
  drawBar(doc, sx, ys + 11, 78, 'Payment mode', inv.paymentMode);  // the store's payment mode
  drawFooter(doc, [`Invoice no: ${inv.no}`, 'Due date: C.O.D.', `Balance due: ${money(inv.due)}`]);
}

// ── STATEMENTS (admin) ───────────────────────────────────────────────────────
// A store's unpaid invoices in a date range (plus any unpaid opening balance)
async function statementData(storeId, from, to) {
  const { data, error } = await sb.rpc('invoice_balances', { p_from: from, p_to: to, p_store: storeId });
  if (error) throw error;
  const rows = (data || []).filter(r => Number(r.balance) > 0.004).map(r => ({
    date: r.delivery_date, no: r.number, invoiceId: r.invoice_id == null ? null : Number(r.invoice_id),
    total: Number(r.total), credits: Number(r.credits), paid: Number(r.paid), balance: Number(r.balance),
  }));
  return { store: storeById(storeId), from, to, rows, due: cents(rows.reduce((t, r) => t + r.balance, 0)) };
}

function drawStatement(doc, st, biz, logo) {
  const { L, R, W, ink, font, fit } = pdfKit(doc);
  const has = (label, v) => (v ? `${label}${v}` : '');
  const store = st.store;
  const ref = `Statement ${store.name}`;
  let y = drawHeader(doc, 'STATEMENT',
    { name: biz.business_name, lines: [biz.address, has('Phone: ', biz.phone), has('ABN: ', biz.abn)].filter(Boolean) },
    [store.contact_name, store.name, store.address || store.area, has('Phone: ', store.phone), has('ABN: ', store.abn)].filter(Boolean),
    [['DATE', auDate(isoDate(new Date()))], ['PERIOD', `${auDate(st.from)} - ${auDate(st.to)}`], ['AMOUNT DUE', money(st.due)]], logo);

  const col = { no: L + 30, total: 122, credits: 144, paid: 166, balance: R - 4 };
  const header = () => {
    doc.setFillColor(26, 26, 26); doc.rect(L, y, W, 9, 'F');
    font('bold', 10); doc.setTextColor(255, 255, 255);
    doc.text('Date', L + 4, y + 6);
    doc.text('Invoice', col.no, y + 6);
    doc.text('Total', col.total, y + 6, { align: 'right' });
    doc.text('Credits', col.credits, y + 6, { align: 'right' });
    doc.text('Paid', col.paid, y + 6, { align: 'right' });
    doc.text('Balance', col.balance, y + 6, { align: 'right' });
    y += 9;
  };
  header();
  st.rows.forEach((r, i) => {
    if (y > 262) { doc.addPage(); y = 20; header(); }
    if (i % 2) { doc.setFillColor(236, 236, 236); doc.rect(L, y, W, 8, 'F'); }
    font('normal', 10); ink();
    doc.text(r.date ? auDate(r.date) : '-', L + 4, y + 5.5);
    doc.text(fit(r.no, 46), col.no, y + 5.5);
    doc.text(money(r.total), col.total, y + 5.5, { align: 'right' });
    doc.text(r.credits ? money(-r.credits) : '-', col.credits, y + 5.5, { align: 'right' });
    doc.text(r.paid ? money(-r.paid) : '-', col.paid, y + 5.5, { align: 'right' });
    doc.text(money(r.balance), col.balance, y + 5.5, { align: 'right' });
    y += 8;
  });
  if (!st.rows.length) { font('italic', 10); ink(); doc.text('Nothing owing for this period. Thank you!', L + 4, y + 6); y += 9; }

  if (y + 9 + 50 > 255) { doc.addPage(); y = 20; } else y += 9;
  const bank = [['Bank:', biz.bank_name], ['Name:', biz.account_name], ['BSB:', biz.bsb], ['Account:', biz.account_no]].filter(([, v]) => v);
  drawHowToPay(doc, bank, ref, y);
  drawBar(doc, R - 78, y + 2, 78, 'Amount due', money(st.due));
  drawFooter(doc, [`${st.rows.length} unpaid invoice${st.rows.length === 1 ? '' : 's'}`, `${auDate(st.from)} - ${auDate(st.to)}`, `Amount due: ${money(st.due)}`]);
}

// Statement PDF, followed by the unpaid invoices themselves when `withInvoices`
async function statementPdf(st, biz, withInvoices) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  doc.setProperties({ title: `Statement ${st.store.name}` });
  const logo = await logoDataUrl();
  drawStatement(doc, st, biz, logo);
  if (withInvoices) {
    const keys = st.rows.filter(r => r.invoiceId).map(r => ({ storeId: st.store.id, date: r.date }));
    for (const rec of await invoiceRecs(keys, false)) { doc.addPage(); drawInvoice(doc, invoiceData(rec, biz), logo); }
  }
  return doc;
}

const fileSafe = s => String(s).replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'store';

// ── SHARING ──────────────────────────────────────────────────────────────────
// Phones: the Share sheet (WhatsApp, email, …); computers: download. Shown as
// buttons so the Share sheet opens on its own tap (phones refuse it after
// waiting for the network).
const SHARE = { items: [] };
function canShareFiles() {
  try { return !!navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] }); }
  catch (_) { return false; }
}

// items: [{ label, doc, filename, title, onSent }]
function offerPdfs(title, items) {
  if (!items.length) { showToast('Nothing to send'); return; }
  if (!canShareFiles() && items.length === 1) {  // computer, one file: just download it
    savePdfFile(items[0].doc, items[0].filename);
    items[0].onSent?.();
    showToast('📄 PDF saved');
    return;
  }
  SHARE.items = items;
  document.getElementById('shareTitle').textContent = title;
  document.getElementById('shareList').innerHTML = items.map((it, i) => `<div class="share-row">
    <span>${safeText(it.label)}</span>
    <button class="inv-btn" id="share-${i}" onclick="sharePdfItem(${i})">${canShareFiles() ? '📤 Share' : '📄 Save'}</button></div>`).join('');
  document.getElementById('shareSheet').hidden = false;
}

async function sharePdfItem(i) {
  const it = SHARE.items[i];
  if (!it) return;
  if (canShareFiles()) {
    const file = new File([it.doc.output('blob')], it.filename, { type: 'application/pdf' });
    try {
      await navigator.share({ files: [file], title: it.title });
    } catch (e) {
      if (e?.name === 'AbortError') return;  // closed the Share sheet
      savePdfFile(it.doc, it.filename);
    }
  } else {
    savePdfFile(it.doc, it.filename);
  }
  const btn = document.getElementById(`share-${i}`);
  if (btn) btn.textContent = '✓ Done';
  it.onSent?.();
}

function closeShareSheet() {
  document.getElementById('shareSheet').hidden = true;
  SHARE.items = [];
}

// Invoices tab: share one invoice (saved first) and note that it was sent
async function shareInvoice(key) {
  const x = invRow(key);
  if (!x || INV.busy) return;
  if (typeof window.jspdf === 'undefined') { showToast('PDF library loading, try again in a moment...'); return; }
  INV.busy = true;
  try {
    if (!unpricedConfirm(x.inv ? 0 : x.unpriced)) return;
    const biz = await loadBusiness();
    if (!biz) return;
    const [rec] = await invoiceRecs([{ storeId: x.storeId, date: x.date }], true);
    if (!rec) { showToast('No order on this day'); return; }
    const doc = await invoicesPdf([rec], biz, `Invoice ${rec.no}`);
    offerPdfs(`Invoice ${rec.no} · ${rec.store.name}`, [{
      label: `${rec.store.name} · ${money(rec.total - creditsTotal(rec))}`, doc, filename: `invoice-${rec.no}.pdf`, title: `Invoice ${rec.no}`,
      onSent: async () => { if (rec.invoiceId) await sb.rpc('mark_invoices_sent', { p_ids: [rec.invoiceId] }); loadInvoicesPage(); },
    }]);
    await loadInvoicesPage();
  } catch (error) {
    showToast('⚠️ ' + friendlyError(error));
  } finally { INV.busy = false; }
}

// Customers: statements for the dates chosen at the top (one store, or every
// store owing something in those dates)
async function sendStatements(storeId) {
  if (INV.busy) return;
  if (typeof window.jspdf === 'undefined') { showToast('PDF library loading, try again in a moment...'); return; }
  const from = document.getElementById('invFrom').value, to = document.getElementById('invTo').value;
  if (!from || !to || from > to) { showToast('Choose the dates at the top first'); return; }
  INV.busy = true;
  try {
    const biz = await loadBusiness();
    if (!biz) return;
    const withInvoices = document.getElementById('stmtWithInvoices')?.checked ?? true;
    const ids = storeId ? [storeId] : CUST.rows.filter(x => x.owing > 0.004).map(x => x.storeId);
    const items = [];
    for (const id of ids) {
      const st = await statementData(id, from, to);
      if (!storeId && !st.rows.length) continue;  // nothing owing in these dates
      const doc = await statementPdf(st, biz, withInvoices);
      items.push({ label: `${st.store.name} · ${money(st.due)}`, doc, title: `Statement ${st.store.name}`,
        filename: `statement-${fileSafe(st.store.name)}-${from}-to-${to}.pdf` });
    }
    if (!items.length) { showToast('No store owes anything for invoices in these dates'); return; }
    offerPdfs(storeId ? `Statement · ${auDate(from)} – ${auDate(to)}` : `Statements · ${auDate(from)} – ${auDate(to)}`, items);
  } catch (error) {
    showToast('⚠️ ' + friendlyError(error));
  } finally { INV.busy = false; }
}

// ── CSV EXPORT (admin): for your accountant, and as a backup ─────────────────
function csvCell(v) {
  if (typeof v === 'number') return String(v);
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;  // stop spreadsheets treating text as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = rows => rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

function downloadFile(filename, text, type) {
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function exportInvoicesCsv() {
  const rows = [...INV.rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!rows.length) { showToast('No invoices in these dates'); return; }
  downloadFile(`invoices-${INV.from}-to-${INV.to}.csv`, toCsv([
    ['Date', 'Invoice no', 'Store', 'Status', 'Sub-total', 'Freight', 'Fuel levy', 'Total', 'Credits', 'Paid', 'Balance', 'Payment mode'],
    ...rows.map(x => [x.date, x.no, x.store.name, x.inv ? (x.payStatus ? PAY_STATUS[x.payStatus].label : 'Issued') : INV_STATUS[x.status].label,
      x.inv ? Number(x.inv.subtotal) : x.live ?? 0, x.inv ? Number(x.inv.freight) : 0, x.inv ? Number(x.inv.fuel_levy) : 0,
      x.total, x.credit, x.paid, x.payStatus ? x.balance : x.net, PAY_MODE_NAMES[x.inv?.payment_mode || x.store.payment_mode] || '']),
  ]), 'text/csv');
}

async function exportPaymentsCsv() {
  const { data, error } = await sb.from('customer_payments').select('*').gte('paid_on', INV.from).lte('paid_on', INV.to);
  if (error) { showToast('⚠️ ' + friendlyError(error)); return; }
  if (!data.length) { showToast('No payments in these dates'); return; }
  downloadFile(`payments-${INV.from}-to-${INV.to}.csv`, toCsv([
    ['Date', 'Store', 'Amount', 'Method', 'Reference'],
    ...data.sort((a, b) => (a.paid_on < b.paid_on ? -1 : a.paid_on > b.paid_on ? 1 : a.id - b.id))
      .map(p => [p.paid_on, storeById(p.store_id).name, Number(p.amount), PAY_MODE_NAMES[p.method] || p.method, p.reference || '']),
  ]), 'text/csv');
}

// Business details for the PDF, or null (with a message) if not set up
async function loadBusiness() {
  const { data: biz, error } = await sb.from('business_settings').select('*').eq('id', 1).maybeSingle();
  if (error || !biz?.business_name) {
    showToast(error
      ? '⚠️ Could not load business details. Re-run supabase/schema.sql.'
      : '⚠️ Business details are empty. Run business_details.sql in Supabase.');
    return null;
  }
  return biz;
}

async function invoicesPdf(recs, biz, title) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  doc.setProperties({ title });
  const logo = await logoDataUrl();
  recs.forEach((rec, i) => {
    if (i) doc.addPage();
    drawInvoice(doc, invoiceData(rec, biz), logo);
  });
  return doc;
}

function savePdfFile(doc, filename) { doc.save(filename); }

// Phones and tablets can't print a PDF from inside the page: they save it
const isMobileDevice = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Computer: print the PDF from a hidden frame (prints the PDF itself, so no
// web address or page numbers are added). Returns false if that isn't possible.
let _printFrame = null;
function printPdfBlob(blob) {
  _printFrame?.remove();
  const frame = _printFrame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  frame.src = URL.createObjectURL(blob);
  return new Promise(resolve => {
    frame.onload = () => {
      try { frame.contentWindow.focus(); frame.contentWindow.print(); resolve(true); } catch (_) { resolve(false); }
    };
    document.body.append(frame);
  });
}

// 'print': print dialog on a computer, saved on a phone; 'save': saved
async function deliverPdf(doc, filename, mode) {
  if (mode === 'save') {
    savePdfFile(doc, filename);
    showToast('📄 PDF saved');
  } else if (isMobileDevice()) {
    savePdfFile(doc, filename);
    showToast('📄 Invoices saved. Open the PDF, then Share → Print');
  } else if (!(await printPdfBlob(doc.output('blob')))) {
    savePdfFile(doc, filename);
    showToast('📄 Invoices saved as a PDF. Open it to print');
  }
}

const unpricedConfirm = n => !n || confirm(`${n} order line${n > 1 ? 's have' : ' has'} no price and will print as $0.00. Print anyway?`);

// ── ROUTE TAB: PRINT THE DAY'S INVOICES ──────────────────────────────────────
// One A4 invoice per store with orders on the selected date, in delivery
// order, all in one PDF (a PDF, so iPhone Safari adds no web address/date).
async function printInvoices() {
  if (!currentUser || !sb) return;
  if (typeof window.jspdf === 'undefined') { showToast('PDF library loading, try again in a moment...'); return; }
  const btn = document.getElementById('printInvoicesBtn');
  const date = currentDate;
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    await reloadDay();  // latest quantities and prices
    if (date !== currentDate) return;
    const stops = orderedStores();
    if (!stops.length) { showToast('No orders for this date'); return; }
    const lines = s => PRODUCTS.map(p => invoiceLine(s.id, p.id)).filter(Boolean);
    const withLines = stops.filter(s => lines(s).length);
    if (!withLines.length) { showToast('⚠️ Invoice prices unavailable. Re-run supabase/schema.sql.'); return; }
    if (!unpricedConfirm(withLines.reduce((n, s) => n + lines(s).filter(l => l.price == null).length, 0))) return;
    const biz = await loadBusiness();
    if (!biz) return;
    await loadAccountsStart();
    const recs = await invoiceRecs(withLines.map(s => ({ storeId: s.id, date })), true);
    // Invoices issued before the order changed print as they were saved
    const changed = recs.filter(r => r.invoiceId && Math.abs(r.subtotal - lines(storeById(r.storeId)).reduce((t, l) => t + l.amount, 0)) > 0.004);
    if (changed.length && !confirm(`${changed.length} invoice${changed.length > 1 ? 's were' : ' was'} saved before the order changed `
      + `(${changed.map(r => r.store.name).join(', ')}) and will print as saved. Add a credit, or ask an admin to unlock `
      + 'it in Invoices. Print anyway?')) return;
    await deliverPdf(await invoicesPdf(recs, biz, `Invoices ${auDate(date)}`), `invoices-${date}.pdf`, 'print');
  } catch (error) {
    showToast('⚠️ ' + friendlyError(error));
  } finally {
    btn.disabled = false;
    btn.textContent = '🖨 Print invoices';
  }
}

// ── INVOICES TAB ─────────────────────────────────────────────────────────────
const INV = { from: '', to: '', rows: [], open: null, seq: 0, busy: false, view: 'invoices' };

const STATUS_OPTIONS = [['all', 'All'], ['draft', 'Not issued'], ['issued', 'Issued'], ['changed', 'Order changed'],
  ['unpaid', 'Unpaid', true], ['paid', 'Paid', true]];  // true = admin only (payments)
const PAY_STATUS = { paid: { label: 'Paid', cls: 'ok' }, part: { label: 'Part paid', cls: 'part' }, unpaid: { label: 'Unpaid', cls: 'bad' } };
const invKey = (s, d) => `${Number(s)}|${d}`;

const INV_STATUS = {
  issued:    { label: 'Issued',          cls: 'ok' },
  sent:      { label: 'Sent',            cls: 'ok' },
  draft:     { label: 'Not issued',      cls: 'draft' },
  untracked: { label: 'Before tracking', cls: 'muted' },
};

function setInvoiceRange(kind) {
  const today = isoDate(new Date());
  const dow = (parseIsoDate(today).getDay() + 6) % 7;  // Monday = 0
  let from, to;
  if (kind === 'month') {
    from = today.slice(0, 8) + '01';
    const d = parseIsoDate(from); d.setMonth(d.getMonth() + 1); d.setDate(0);
    to = isoDate(d);
  } else {
    from = addDays(today, -dow - (kind === 'lastweek' ? 7 : 0));
    to = addDays(from, 6);
  }
  document.getElementById('invFrom').value = from;
  document.getElementById('invTo').value = to;
  loadInvoicesPage();
}

function showInvoicesPage() {
  const sel = document.getElementById('invStatus');
  const keep = sel.value;
  sel.innerHTML = STATUS_OPTIONS.filter(o => !o[2] || isAdmin()).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  sel.value = [...sel.options].some(o => o.value === keep) ? keep : 'all';
  if (!isAdmin()) INV.view = 'invoices';
  showInvoiceView();
  if (!document.getElementById('invFrom').value) setInvoiceRange('week');
  else loadInvoicesPage();
}

function showInvoiceView() {
  document.getElementById('invView').hidden = INV.view !== 'invoices';
  document.getElementById('custView').hidden = INV.view !== 'customers';
  document.getElementById('invStatus').hidden = INV.view !== 'invoices';
  document.querySelectorAll('#invViewSwitch .route-opt').forEach(b => b.classList.toggle('on', b.dataset.view === INV.view));
}

// Admin: Invoices list or Customers (balances, payments)
function setInvoiceView(view) {
  if (view === INV.view || !isAdmin()) return;
  INV.view = view;
  showInvoiceView();
  if (view === 'customers') loadCustomers(); else renderInvoiceList();
}

function renderInvoicesView() {
  if (INV.view === 'customers') renderCustomers(); else renderInvoiceList();
}

async function loadInvoicesPage() {
  const from = document.getElementById('invFrom').value, to = document.getElementById('invTo').value;
  const list = document.getElementById('invList');
  if (!from || !to) return;
  if (from > to) { showToast('"From" must be before "To"'); return; }
  INV.from = from; INV.to = to;
  const seq = ++INV.seq;
  if (!INV.rows.length) list.innerHTML = '<div class="inv-empty">Loading…</div>';
  const results = await Promise.all([
    sb.from('business_settings').select('accounts_start').eq('id', 1).maybeSingle(),
    sb.from('invoices').select('*').gte('delivery_date', from).lte('delivery_date', to),
    sb.from('invoice_credits').select('*').gte('delivery_date', from).lte('delivery_date', to),
    sb.rpc('store_day_totals', { p_from: from, p_to: to }),
    isAdmin() ? sb.rpc('invoice_balances', { p_from: from, p_to: to, p_store: null }) : Promise.resolve({ data: [], error: null }),
  ]);
  if (seq !== INV.seq) return;
  const failed = results.find(r => r.error);
  if (failed) {
    console.warn('Invoices unavailable:', failed.error.message);
    INV.rows = [];
    document.getElementById('invSummary').textContent = '';
    list.innerHTML = '<div class="inv-empty">⚠️ Invoices need the latest database update: re-run supabase/schema.sql.</div>';
    return;
  }
  const [st, inv, cr, dt, bal] = results.map(r => r.data);
  const balById = new Map((bal || []).filter(b => b.invoice_id != null).map(b => [Number(b.invoice_id), b]));
  ACCOUNTS_START = st?.accounts_start || null;

  const map = new Map();
  const row = (s, d) => {
    const k = invKey(s, d);
    if (!map.has(k)) map.set(k, { key: k, storeId: Number(s), date: d, inv: null, live: null, unpriced: 0, credits: [] });
    return map.get(k);
  };
  (dt || []).forEach(r => Object.assign(row(r.store_id, r.delivery_date), { live: Number(r.subtotal), unpriced: Number(r.unpriced) || 0 }));
  (inv || []).forEach(i => { row(i.store_id, i.delivery_date).inv = i; });
  (cr || []).forEach(c => row(c.store_id, c.delivery_date).credits.push({ id: c.id, amount: Number(c.amount), reason: c.reason || '' }));
  const order = new Map([...STORES].sort((a, b) => routeOf(a) - routeOf(b) || bySeq(a, b)).map((s, i) => [s.id, i]));
  INV.rows = [...map.values()].map(x => {
    x.store = storeById(x.storeId);
    x.no = x.inv?.number || invoiceNumber(x.date, x.storeId);
    x.total = x.inv ? Number(x.inv.total)
      : x.live == null ? 0 : cents(chargesFor(x.live).reduce((t, c) => t + c.amount, x.live));
    x.credit = cents(x.credits.reduce((t, c) => t + c.amount, 0));
    x.net = cents(x.total - x.credit);
    x.status = x.inv ? 'issued' : isTracked(x.date) ? 'draft' : 'untracked';
    x.changed = !!x.inv && Math.abs((x.live ?? 0) - Number(x.inv.subtotal)) > 0.004;
    // Admin: what's been paid off this invoice (payments go to the oldest first)
    const b = x.inv && balById.get(Number(x.inv.id));
    x.paid = b ? Number(b.paid) : 0;
    x.balance = b ? Number(b.balance) : x.net;
    x.payStatus = !b ? null : x.balance <= 0.004 ? 'paid' : x.paid > 0.004 ? 'part' : 'unpaid';
    return x;
  }).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)
    || (order.get(a.storeId) ?? 1e9) - (order.get(b.storeId) ?? 1e9));
  renderInvoiceStart();
  if (INV.view === 'customers') await loadCustomers(); else renderInvoiceList();
}

function filteredInvoiceRows() {
  const terms = normalizeSearch(document.getElementById('invoices-search').value).split(' ').filter(Boolean);
  const status = document.getElementById('invStatus').value;
  return INV.rows.filter(x => terms.every(t => storeSearchText(x.store).includes(t))
    && (status === 'all' || (status === 'changed' ? x.changed
      : status === 'unpaid' ? x.payStatus === 'unpaid' || x.payStatus === 'part'
      : status === 'paid' ? x.payStatus === 'paid' : x.status === status)));
}

function renderInvoiceStart() {
  const box = document.getElementById('invStart');
  if (isAdmin()) {
    box.className = 'inv-start' + (ACCOUNTS_START ? '' : ' warn');
    box.innerHTML = `${ACCOUNTS_START ? 'Tracking invoices from'
      : 'Choose the date invoice tracking starts (your cut-over from MYOB). From that date invoices are saved when printed; earlier days count as settled.'}
      <span class="inv-start-row"><input type="date" id="invStartDate" value="${ACCOUNTS_START || ''}">
      <button class="inv-btn" onclick="saveAccountsStart()">${ACCOUNTS_START ? 'Change' : 'Start'}</button></span>`;
  } else {
    box.className = 'inv-start' + (ACCOUNTS_START ? '' : ' warn');
    box.textContent = ACCOUNTS_START ? `Tracking invoices from ${auDate(ACCOUNTS_START)}`
      : 'Invoice tracking starts once the admin sets a start date.';
  }
}

async function saveAccountsStart() {
  const v = document.getElementById('invStartDate').value;
  if (!v) { showToast('Pick a date'); return; }
  if (v === ACCOUNTS_START) return;
  if (ACCOUNTS_START && !confirm(`Change the start of invoice tracking from ${auDate(ACCOUNTS_START)} to ${auDate(v)}? `
    + 'Saved invoices stay saved; days before the new date are no longer issued.')) return;
  const res = await dbCall(sb.from('business_settings').update({ accounts_start: v }).eq('id', 1).select('id'), true);
  if (!res.ok) return;
  ACCOUNTS_START = v;
  showToast('Invoice tracking start saved ✓');
  await loadInvoicesPage();
}

function renderInvoiceList() {
  const rows = filteredInvoiceRows();
  const list = document.getElementById('invList');
  const search = document.getElementById('invoices-search');
  search.nextElementSibling.hidden = !search.value;
  const drafts = rows.filter(x => x.status === 'draft').length;
  const changed = rows.filter(x => x.changed).length;
  document.getElementById('invSummary').textContent = rows.length
    ? `${rows.length} invoice${rows.length > 1 ? 's' : ''} · ${money(rows.reduce((t, x) => t + x.net, 0))}`
      + (drafts ? ` · ${drafts} not issued` : '') + (changed ? ` · ${changed} order${changed > 1 ? 's' : ''} changed` : '')
      + (isAdmin() ? ` · ${money(rows.reduce((t, x) => t + (x.payStatus ? x.balance : 0), 0))} unpaid` : '')
    : '';
  if (!rows.length) {
    list.innerHTML = `<div class="inv-empty">${INV.rows.length ? 'No invoices match' : 'No orders in these dates'}</div>`;
    return;
  }
  let html = '', day = '';
  for (const x of rows) {
    if (x.date !== day) { day = x.date; html += `<div class="inv-day">${dayLabel(day)}</div>`; }
    const st = INV_STATUS[x.inv?.sent_at ? 'sent' : x.status];
    html += `<div class="inv-item${INV.open === x.key ? ' open' : ''}" data-key="${x.key}">
      <div class="inv-row" onclick="toggleInvoice('${x.key}')">
        <div class="inv-main">
          <div class="inv-store">${safeText(x.store.name)}</div>
          <div class="inv-sub">${safeText(x.no)} <span class="inv-chip ${st.cls}">${st.label}</span>${x.changed
            ? ' <span class="inv-chip bad">Order changed</span>' : ''}${x.payStatus
            ? ` <span class="inv-chip ${PAY_STATUS[x.payStatus].cls}">${PAY_STATUS[x.payStatus].label}</span>` : ''}</div>
        </div>
        <div class="inv-amt">${money(x.net)}${x.credit ? `<small>incl. −${money(x.credit)} credit</small>` : ''}</div>
      </div>
      ${INV.open === x.key ? invoiceDetail(x) : ''}
    </div>`;
  }
  list.innerHTML = html;
}

function invoiceDetail(x) {
  const canCredit = isAdmin() || profile.role === 'baker';
  const notes = [];
  if (x.changed) notes.push('⚠️ The order changed after this invoice was issued; it keeps the saved amounts. Add a credit'
    + (isAdmin() ? ', or unlock it so it follows the order again.' : ', or ask an admin to unlock it.'));
  if (x.live == null && !x.inv) notes.push('No order on this day any more.');
  if (!x.inv && x.unpriced) notes.push(`⚠️ ${x.unpriced} line${x.unpriced > 1 ? 's have' : ' has'} no price.`);
  if (!x.inv && x.status === 'draft') notes.push('Not issued yet: it follows the order until it\'s printed or saved.');
  return `<div class="inv-detail">
    ${notes.map(n => `<div class="inv-note">${n}</div>`).join('')}
    <div class="inv-lines">
      <div><span>Total</span><span>${money(x.total)}</span></div>
      ${x.credits.map(c => `<div class="inv-credit"><span>Credit${c.reason ? ': ' + safeText(c.reason) : ''}</span>
        <span>−${money(c.amount)}${isAdmin() ? ` <button class="inv-x" onclick="deleteCredit(${Number(c.id)})" aria-label="Remove credit">✕</button>` : ''}</span></div>`).join('')}
      ${x.payStatus ? `<div><span>Paid</span><span>−${money(x.paid)}</span></div>` : ''}
      <div class="inv-net"><span>Balance</span><span>${money(x.payStatus ? x.balance : x.net)}</span></div>
    </div>
    ${canCredit ? `<div class="inv-credit-form">
      <input type="number" inputmode="decimal" step="0.01" min="0" id="crAmount" placeholder="Credit $">
      <input type="text" id="crReason" maxlength="200" placeholder="Reason, e.g. 2 packs returned">
      <button class="inv-btn" onclick="addCredit('${x.key}')">Add credit</button>
    </div>` : ''}
    <div class="inv-actions">
      ${x.live != null || x.inv ? `<button class="inv-btn" onclick="invoicePdf('${x.key}')">📄 Save PDF</button>
        <button class="inv-btn" onclick="shareInvoice('${x.key}')">📤 Share</button>` : ''}
      ${isAdmin() && x.inv ? `<button class="inv-btn" onclick="unlockInvoice('${x.key}')">🔓 Unlock</button>` : ''}
    </div>
  </div>`;
}

function toggleInvoice(key) {
  INV.open = INV.open === key ? null : key;
  renderInvoiceList();
}

const invRow = key => INV.rows.find(x => x.key === key);

async function addCredit(key) {
  const x = invRow(key);
  if (!x || INV.busy) return;
  const amount = cents(parseFloat(document.getElementById('crAmount').value));
  const reason = document.getElementById('crReason').value.trim();
  if (!(amount > 0)) { showToast('Enter the credit amount'); return; }
  if (amount > x.net + 0.004) { showToast(`A credit can't be more than ${money(x.net)}`); return; }
  INV.busy = true;
  try {
    const res = await dbCall(sb.from('invoice_credits').insert({ store_id: x.storeId, delivery_date: x.date, amount, reason }));
    if (!res.ok) return;
    showToast(`Credit of ${money(amount)} added ✓`);
    await loadInvoicesPage();
  } finally { INV.busy = false; }
}

async function deleteCredit(id) {
  if (!confirm('Remove this credit?')) return;
  const res = await dbCall(sb.from('invoice_credits').delete().eq('id', id).select('id'), true);
  if (!res.ok) return;
  showToast('Credit removed');
  await loadInvoicesPage();
}

async function unlockInvoice(key) {
  const x = invRow(key);
  if (!x?.inv) return;
  if (!confirm(`Unlock invoice ${x.no} (${x.store.name})? It will follow the order again`
    + `${x.live != null ? ` (now ${money(x.live)} before charges)` : ''} until it's printed or saved. Credits are kept.`)) return;
  const res = await dbCall(sb.rpc('unlock_invoice', { p_id: x.inv.id }));
  if (!res.ok) return;
  showToast(`Invoice ${x.no} unlocked`);
  await loadInvoicesPage();
}

// PDF of some Invoices-tab rows (issued first if tracked); 'save' or 'print'
async function invoiceRowsPdf(rows, mode, filename, title) {
  if (typeof window.jspdf === 'undefined') { showToast('PDF library loading, try again in a moment...'); return; }
  rows = rows.filter(x => x.live != null || x.inv);
  if (!rows.length) { showToast('No invoices to print'); return; }
  if (!unpricedConfirm(rows.reduce((n, x) => n + (x.inv ? 0 : x.unpriced), 0))) return;
  const biz = await loadBusiness();
  if (!biz) return;
  const recs = await invoiceRecs(rows.map(x => ({ storeId: x.storeId, date: x.date })), true);
  await deliverPdf(await invoicesPdf(recs, biz, title), filename, mode);
}

async function invoicePdf(key) {
  const x = invRow(key);
  if (!x || INV.busy) return;
  INV.busy = true;
  try {
    await invoiceRowsPdf([x], 'save', `invoice-${x.no}.pdf`, `Invoice ${x.no}`);
    await loadInvoicesPage();
  } catch (error) {
    showToast('⚠️ ' + friendlyError(error));
  } finally { INV.busy = false; }
}

// Save / print every invoice in the list (as filtered)
async function invoicesBulk(mode) {
  if (INV.busy) return;
  const rows = filteredInvoiceRows();
  INV.busy = true;
  try {
    // Oldest day first; each day in delivery order (the list shows newest first)
    const days = [...new Set(rows.map(x => x.date))].sort();
    const ordered = days.flatMap(d => rows.filter(x => x.date === d));
    await invoiceRowsPdf(ordered, mode, `invoices-${INV.from}-to-${INV.to}.pdf`, `Invoices ${auDate(INV.from)} – ${auDate(INV.to)}`);
    await loadInvoicesPage();
  } catch (error) {
    showToast('⚠️ ' + friendlyError(error));
  } finally { INV.busy = false; }
}

function clearInvoiceSearch() {
  const input = document.getElementById('invoices-search');
  input.value = '';
  renderInvoicesView();
  input.focus();
}

// ── CUSTOMERS (admin): balances, payments, opening balances ─────────────────
const CUST = { rows: [], open: null, detail: null, seq: 0 };

async function loadCustomers() {
  const seq = ++CUST.seq;
  const list = document.getElementById('custList');
  if (!CUST.rows.length) list.innerHTML = '<div class="inv-empty">Loading…</div>';
  const { data, error } = await sb.rpc('store_accounts');
  if (seq !== CUST.seq) return;
  if (error) {
    console.warn('Customer balances unavailable:', error.message);
    list.innerHTML = '<div class="inv-empty">⚠️ Balances need the latest database update: re-run supabase/schema.sql.</div>';
    return;
  }
  const acct = new Map((data || []).map(a => [Number(a.store_id), a]));
  const n = v => Number(v) || 0;
  const order = new Map([...STORES].sort((a, b) => routeOf(a) - routeOf(b) || bySeq(a, b)).map((s, i) => [s.id, i]));
  // Every active store (to record a payment or opening balance), plus archived ones with a balance
  CUST.rows = STORES.filter(s => !s.archived || acct.has(s.id)).map(s => {
    const a = acct.get(s.id) || {};
    return { store: s, storeId: s.id, opening: n(a.opening), invoiced: n(a.invoiced), credits: n(a.credits), paid: n(a.paid),
      owing: cents(n(a.owing)), oldestUnpaid: a.oldest_unpaid || null, lastPayment: a.last_payment || null };
  }).sort((a, b) => b.owing - a.owing || (order.get(a.storeId) ?? 1e9) - (order.get(b.storeId) ?? 1e9));
  if (CUST.open) await loadCustomerDetail(CUST.open);
  renderCustomers();
}

function renderCustomers() {
  const terms = normalizeSearch(document.getElementById('invoices-search').value).split(' ').filter(Boolean);
  const search = document.getElementById('invoices-search');
  search.nextElementSibling.hidden = !search.value;
  const rows = CUST.rows.filter(x => terms.every(t => storeSearchText(x.store).includes(t)));
  const owing = CUST.rows.filter(x => x.owing > 0.004);
  document.getElementById('custSummary').textContent = CUST.rows.length
    ? `Owed to you: ${money(owing.reduce((t, x) => t + x.owing, 0))} · ${owing.length} store${owing.length === 1 ? '' : 's'} owe` : '';
  const list = document.getElementById('custList');
  if (!rows.length) { list.innerHTML = `<div class="inv-empty">${CUST.rows.length ? 'No stores match' : 'No stores'}</div>`; return; }
  list.innerHTML = rows.map(x => {
    const sub = x.owing > 0.004 ? `Owes${x.oldestUnpaid ? ` since ${dayLabel(x.oldestUnpaid)}` : ' (opening balance)'}`
      : x.owing < -0.004 ? `In credit ${money(-x.owing)}` : x.invoiced || x.opening ? 'Paid up' : 'No invoices yet';
    return `<div class="inv-item${CUST.open === x.storeId ? ' open' : ''}" data-store="${x.storeId}">
      <div class="inv-row" onclick="toggleCustomer(${x.storeId})">
        <div class="inv-main">
          <div class="inv-store">${safeText(x.store.name)}</div>
          <div class="inv-sub">${sub}${x.lastPayment ? ` · last paid ${dayLabel(x.lastPayment)}` : ''}</div>
        </div>
        <div class="inv-amt${x.owing > 0.004 ? ' inv-owes' : ''}">${money(Math.max(x.owing, 0))}</div>
      </div>
      ${CUST.open === x.storeId ? customerDetail(x) : ''}
    </div>`;
  }).join('');
}

async function loadCustomerDetail(storeId) {
  const [b, p] = await Promise.all([
    sb.rpc('invoice_balances', { p_from: null, p_to: null, p_store: storeId }),
    sb.from('customer_payments').select('*').eq('store_id', storeId),
  ]);
  CUST.detail = {
    storeId,
    unpaid: (b.data || []).filter(r => Number(r.balance) > 0.004),
    payments: (p.data || []).sort((x, y) => (x.paid_on < y.paid_on ? 1 : x.paid_on > y.paid_on ? -1 : y.id - x.id)),
  };
}

function customerDetail(x) {
  const d = CUST.detail?.storeId === x.storeId ? CUST.detail : { unpaid: [], payments: [] };
  const mode = x.store.payment_mode === 'online' ? 'online' : 'cash';
  return `<div class="inv-detail">
    <div class="inv-lines">
      ${x.opening ? `<div><span>Opening balance</span><span>${money(x.opening)}</span></div>` : ''}
      <div><span>Invoiced</span><span>${money(x.invoiced)}</span></div>
      ${x.credits ? `<div class="inv-credit"><span>Credits</span><span>−${money(x.credits)}</span></div>` : ''}
      <div><span>Paid</span><span>−${money(x.paid)}</span></div>
      <div class="inv-net"><span>${x.owing < -0.004 ? 'In credit' : 'Owing'}</span><span>${money(Math.abs(x.owing))}</span></div>
    </div>
    ${d.unpaid.length ? `<div class="inv-h">Unpaid</div><div class="inv-small">${d.unpaid.map(r => `<div>
      <span>${safeText(r.number)}${r.delivery_date ? ` <span class="m">· ${dayLabel(r.delivery_date)}</span>` : ''}</span>
      <span>${money(r.balance)}${Number(r.paid) > 0 ? ` <span class="m">of ${money(Number(r.total) - Number(r.credits))}</span>` : ''}</span></div>`).join('')}</div>` : ''}
    <div class="inv-h">Record a payment</div>
    <div class="inv-pay-form">
      <input type="number" inputmode="decimal" step="0.01" min="0" id="payAmount" placeholder="Amount $"
        value="${x.owing > 0.004 ? x.owing.toFixed(2) : ''}">
      <input type="date" id="payDate" value="${isoDate(new Date())}">
      <select id="payMethod">${Object.entries(PAY_MODE_NAMES).map(([v, l]) => `<option value="${v}"${v === mode ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <input type="text" id="payRef" maxlength="120" placeholder="Reference (optional)">
      <button class="inv-btn" onclick="recordPayment(${x.storeId})">Record payment</button>
    </div>
    ${d.payments.length ? `<div class="inv-h">Payments</div><div class="inv-small">${d.payments.slice(0, 30).map(p => `<div>
      <span>${dayLabel(p.paid_on)} <span class="m">· ${PAY_MODE_NAMES[p.method] || p.method}${p.reference ? ' · ' + safeText(p.reference) : ''}</span></span>
      <span>${money(p.amount)} <button class="inv-x" onclick="deletePayment(${Number(p.id)})" aria-label="Delete payment">✕</button></span></div>`).join('')}</div>` : ''}
    <div class="inv-opening">Opening balance (owed on ${ACCOUNTS_START ? auDate(ACCOUNTS_START) : 'the start date'})
      <input type="number" inputmode="decimal" step="0.01" min="0" id="openingAmount" value="${x.opening ? x.opening.toFixed(2) : ''}" placeholder="$0.00">
      <button class="inv-btn" onclick="saveOpening(${x.storeId})">Save</button></div>
    <div class="inv-actions"><button class="inv-btn" onclick="sendStatements(${x.storeId})">📄 Statement for the dates above</button></div>
  </div>`;
}

async function toggleCustomer(storeId) {
  CUST.open = CUST.open === storeId ? null : storeId;
  if (CUST.open) await loadCustomerDetail(storeId);
  renderCustomers();
}

async function recordPayment(storeId) {
  if (INV.busy) return;
  const amount = cents(parseFloat(document.getElementById('payAmount').value));
  const paid_on = document.getElementById('payDate').value;
  const method = document.getElementById('payMethod').value === 'online' ? 'online' : 'cash';
  const reference = document.getElementById('payRef').value.trim();
  if (!(amount > 0)) { showToast('Enter the amount paid'); return; }
  if (!paid_on) { showToast('Enter the payment date'); return; }
  INV.busy = true;
  try {
    const res = await dbCall(sb.from('customer_payments').insert({ store_id: storeId, paid_on, amount, method, reference }));
    if (!res.ok) return;
    showToast(`Payment of ${money(amount)} recorded ✓`);
    await loadCustomers();
  } finally { INV.busy = false; }
}

async function deletePayment(id) {
  if (!confirm('Delete this payment?')) return;
  const res = await dbCall(sb.from('customer_payments').delete().eq('id', id).select('id'), true);
  if (!res.ok) return;
  showToast('Payment deleted');
  await loadCustomers();
}

async function saveOpening(storeId) {
  const raw = document.getElementById('openingAmount').value.trim();
  const amount = raw === '' ? 0 : cents(parseFloat(raw));
  if (!(amount >= 0)) { showToast('Enter the opening balance (0 or more)'); return; }
  const res = await dbCall(sb.from('opening_balances').upsert({ store_id: storeId, amount }));
  if (!res.ok) return;
  showToast('Opening balance saved ✓');
  await loadCustomers();
}
