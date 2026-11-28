// In-browser stand-in for supabase-js v2 (only the parts the app uses), with
// made-up test data. Mimics: the PostgREST query builder, upsert by primary
// key, the role rules from supabase/schema.sql (forbidden reads return nothing,
// forbidden inserts error, forbidden updates/deletes affect 0 rows), the
// pricing triggers, the database functions, and realtime events (including
// the echo of the client's own writes, only for rows the subscriber may read).
(function () {
  const STORES = [
    'Vatan|Bella Vista', 'Honest|Bella Vista', 'Hamara Gaadi (Kellyville)|Kellyville', 'Big Apple (Tallawong)|Tallawong',
    'Little India (Doonside)|Doonside', 'Anda Chowk|Blacktown', 'Uma Mart|Blacktown', 'Fruit World|Blacktown',
    'Dabeli King|Blacktown', 'Hamara Gaadi (Blacktown)|Blacktown', 'Egglicious|Seven Hills', 'Country Fresh|Toongabbie',
    "Mum's Provider|Toongabbie", 'Little India (Girraween)|Girraween', 'Sunrise|Wentworthville', 'Big Apple (Wenty)|Wentworthville',
    'Udaya|Wentworthville', 'Little India (Westmead)|Westmead', 'Kishan (Wenty)|Wentworthville', 'Kishan (Parra)|Parramatta',
    'David Fresh|Homebush', 'Icy Spicy|Parramatta',
  ];
  const db = {
    stores: STORES.map((s, i) => {
      const [name, area] = s.split('|');
      return { id: i + 1, name, area, address: `${i + 1} Test St, ${area} NSW 2000`, contact_name: '', phone: '', abn: '', payment_mode: 'cash', seq: i + 1, route: 1, archived: false };
    }),
    products: [
      { id: 1, name: '6 Pack', icon: '🍞', sort: 1, archived: false },
      { id: 2, name: '9 Pack', icon: '🥐', sort: 2, archived: false },
      { id: 3, name: 'Usal Pav', icon: '🥙', sort: 3, archived: false },
    ],
    order_items: [], order_item_prices: [], prices: [], deliveries: [], production: [],
    invoices: [], invoice_lines: [], invoice_credits: [], customer_payments: [], opening_balances: [],
    business_settings: [{
      id: 1, business_name: 'Test Bakery (Example)', address: '1 Example St, Testville NSW 2000', phone: '0400 000 000',
      abn: '11 111 111 111', bank_name: 'Example Bank', account_name: 'Test Bakery', bsb: '000-000', account_no: '12345678',
      fuel_levy: 0, freight_fee: 0, freight_under: 0, accounts_start: null,
    }],
    profiles: [
      { id: 'u-admin', full_name: 'Owner', role: 'admin' },
      { id: 'u-baker', full_name: 'Bella', role: 'baker' },
      { id: 'u-driver', full_name: 'Dan', role: 'driver' },
      { id: 'u-new', full_name: 'Newbie', role: null },
    ],
  };
  const USERS = { 'owner@test.com': 'u-admin', 'baker@test.com': 'u-baker', 'driver@test.com': 'u-driver', 'new@test.com': 'u-new' };
  const PK = {
    stores: ['id'], products: ['id'], profiles: ['id'], business_settings: ['id'],
    order_items: ['delivery_date', 'store_id', 'product_id'],
    order_item_prices: ['delivery_date', 'store_id', 'product_id'],
    prices: ['product_id', 'store_id'],
    deliveries: ['delivery_date', 'store_id'],
    production: ['production_date', 'product_id'],
    invoices: ['id'], invoice_lines: ['invoice_id', 'product_id'], invoice_credits: ['id'],
    customer_payments: ['id'], opening_balances: ['store_id'],
  };
  const nextId = { stores: 23, products: 4, prices: 1, invoices: 1, invoice_credits: 1, customer_payments: 1 };
  const ANY = ['admin', 'baker', 'driver'];
  const READ = {
    stores: ANY, products: ANY, order_items: ANY, business_settings: ANY,
    prices: ['admin'], order_item_prices: ['admin'], deliveries: ['admin'], production: ['admin', 'baker'],
    invoices: ANY, invoice_lines: ANY, invoice_credits: ANY, customer_payments: ['admin'], opening_balances: ['admin'],
  };
  const WRITE = {
    stores: ['admin'], products: ['admin'], order_items: ['admin'], prices: ['admin'], deliveries: ['admin'],
    production: ['admin', 'baker'], order_item_prices: [], profiles: [], business_settings: ['admin'],
    invoices: [], invoice_lines: [], invoice_credits: ['admin', 'baker'], customer_payments: ['admin'], opening_balances: ['admin'],
  };
  const DELETE = { invoice_credits: ['admin'] };  // who may delete, where it differs from WRITE
  const log = [];
  const channels = new Set();
  const authCbs = [];
  let session = JSON.parse(localStorage.getItem('mock_session') || 'null');
  let failWrites = 0;
  const missingRpcs = new Set();  // simulate a database without the latest schema
  const LATENCY = 15;

  const role = () => session && db.profiles.find(p => p.id === session.user.id)?.role;
  const clone = o => JSON.parse(JSON.stringify(o));
  const samePk = (t, a, b) => PK[t].every(k => String(a[k] ?? null) === String(b[k] ?? null));
  const today = () => { const d = new Date(); return [d.getFullYear(), d.getMonth() + 1, d.getDate()].map(n => String(n).padStart(2, '0')).join('-'); };

  function emit(table, row, isDelete = false) {
    channels.forEach(ch => ch.handlers.forEach(h => {
      if (h.table !== table || !READ[table]?.includes(ch.role)) return;
      if (h.filter && !isDelete) {
        const [col, rest] = h.filter.split('=');
        if (String(row[col]) !== rest.replace(/^eq\./, '')) return;
      }
      setTimeout(() => h.cb(isDelete ? { eventType: 'DELETE', new: {}, old: clone(row) } : { eventType: 'UPDATE', new: clone(row) }), 5);
    }));
  }

  // ── the database triggers ──
  const effectivePrice = (s, p) =>
    db.prices.find(r => r.store_id === s && r.product_id === p)?.price
    ?? db.prices.find(r => r.store_id == null && r.product_id === p)?.price ?? null;
  function afterInsert(t, row) {
    if (t === 'order_items' && !db.order_item_prices.some(r => samePk('order_item_prices', r, row))) {
      const lp = { delivery_date: row.delivery_date, store_id: row.store_id, product_id: row.product_id, unit_price: effectivePrice(row.store_id, row.product_id) };
      db.order_item_prices.push(lp); emit('order_item_prices', lp);
    }
  }
  function afterPriceChange(productId) {
    db.order_item_prices.filter(r => r.product_id === productId && r.delivery_date >= today()).forEach(r => {
      r.unit_price = effectivePrice(r.store_id, r.product_id); emit('order_item_prices', r);
    });
  }
  function writeRow(t, v, op) {
    const existing = op !== 'insert' && db[t].find(r => samePk(t, r, v));
    if (existing) { Object.assign(existing, v); emit(t, existing); if (t === 'prices') afterPriceChange(existing.product_id); return existing; }
    const defaults = t === 'stores' ? { archived: false, route: 1, contact_name: '', phone: '', abn: '' } : t === 'products' ? { archived: false }
      : t === 'invoice_credits' ? { reason: '', created_at: new Date().toISOString(), updated_by: session?.user.id }
      : t === 'customer_payments' ? { method: 'cash', reference: '', updated_by: session?.user.id } : {};
    const row = { ...defaults, ...v };
    if (nextId[t] && row.id == null) row.id = nextId[t]++;
    db[t].push(row); emit(t, row); afterInsert(t, row);
    if (t === 'prices') afterPriceChange(row.product_id);
    return row;
  }

  const rlsError = () => ({ code: '42501', message: 'new row violates row-level security policy' });
  const badValue = (v, t) => ('qty' in v && v.qty < 0) || ('qty_baked' in v && v.qty_baked < 0)
    || ('route' in v && ![1, 2].includes(v.route))
    || ('abn' in v && v.abn !== '' && !/^\d{11}$/.test(String(v.abn).replace(/\s/g, '')))
    || ('payment_mode' in v && v.payment_mode != null && !['cash', 'online', 'unpaid'].includes(v.payment_mode))
    || ('amount' in v && !(t === 'opening_balances' ? Number(v.amount) >= 0 : Number(v.amount) > 0))
    || ('method' in v && !['cash', 'online'].includes(v.method));

  class Query {
    constructor(t) { this.t = t; this.filters = []; this.op = 'select'; this.ret = false; this.one = null; this.sorts = []; }
    select() { if (this.op !== 'select') this.ret = true; return this; }
    eq(c, v) { this.filters.push(r => String(r[c]) === String(v)); return this; }
    is(c, v) { this.filters.push(r => (r[c] ?? null) === v); return this; }
    gt(c, v) { this.filters.push(r => r[c] > v); return this; }
    gte(c, v) { this.filters.push(r => r[c] >= v); return this; }
    lte(c, v) { this.filters.push(r => r[c] <= v); return this; }
    in(c, a) { this.filters.push(r => a.map(String).includes(String(r[c]))); return this; }
    order(c) { this.sorts.push(c); return this; }
    maybeSingle() { this.one = 'maybe'; return this; }
    single() { this.one = 'one'; return this; }
    insert(v) { this.op = 'insert'; this.vals = [].concat(v); return this; }
    update(v) { this.op = 'update'; this.vals = v; return this; }
    upsert(v) { this.op = 'upsert'; this.vals = [].concat(v); return this; }
    delete() { this.op = 'delete'; return this; }
    then(res, rej) { return new Promise(r => setTimeout(r, LATENCY)).then(() => this.exec()).then(res, rej); }
    exec() {
      const t = this.t;
      if (!session) return { data: null, error: { code: '42501', message: 'permission denied for table ' + t } };
      const me = role();
      if (this.op !== 'select') {
        log.push({ t, op: this.op, vals: clone(this.vals ?? null), by: session.user.id });
        if (failWrites > 0) { failWrites--; return { data: null, error: { message: 'TypeError: Failed to fetch' } }; }
      }
      const mayRead = t === 'profiles' ? true : !!READ[t]?.includes(me);
      const mayWrite = !!WRITE[t]?.includes(me);
      const match = r => this.filters.every(f => f(r)) && (t !== 'profiles' || r.id === session.user.id || me === 'admin');
      let rows;
      if (this.op === 'select') {
        rows = mayRead ? db[t].filter(match) : [];
        rows.sort((a, b) => { for (const c of this.sorts) { if (a[c] !== b[c]) return a[c] < b[c] ? -1 : 1; } return 0; });
      } else if (this.op === 'update') {
        if (!mayWrite) rows = [];
        else {
          if (badValue(this.vals, t)) return { data: null, error: { message: 'violates check constraint' } };
          rows = db[t].filter(match);
          rows.forEach(r => { Object.assign(r, this.vals); emit(t, r); if (t === 'prices') afterPriceChange(r.product_id); });
        }
      } else if (this.op === 'delete') {
        rows = (DELETE[t] ?? WRITE[t] ?? []).includes(me) ? db[t].filter(match) : [];
        rows.forEach(r => { db[t].splice(db[t].indexOf(r), 1); emit(t, r, true); if (t === 'prices') afterPriceChange(r.product_id); });
      } else {
        if (!mayWrite) return { data: null, error: rlsError() };
        rows = [];
        for (const v of this.vals) {
          if (badValue(v, t)) return { data: null, error: { message: 'violates check constraint' } };
          if (this.op === 'insert' && PK[t][0] !== 'id' && db[t].some(r => samePk(t, r, v))) return { data: null, error: { message: 'duplicate key' } };
          rows.push(writeRow(t, v, this.op));
        }
      }
      let data = (this.op === 'select' || this.ret) ? clone(rows) : null;
      if (this.one) {
        if (this.one === 'one' && data.length !== 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
        data = data[0] ?? null;
      }
      return { data, error: null };
    }
  }

  const linesFor = date => db.order_items.filter(r => r.delivery_date === date && r.qty > 0)
    .map(r => ({ ...r, unit_price: db.order_item_prices.find(x => samePk('order_item_prices', x, r))?.unit_price ?? null }));
  const cents = n => Math.round(n * 100) / 100;

  // invoice_balances(): opening balance first, then oldest invoices
  function balances() {
    const items = [];
    db.opening_balances.filter(o => o.amount > 0).forEach(o => items.push({ store_id: o.store_id, delivery_date: null, invoice_id: null,
      number: 'Opening balance', total: o.amount, credits: 0, net: o.amount, ord: 0 }));
    db.invoices.forEach(i => {
      const c = cents(db.invoice_credits.filter(x => x.store_id === i.store_id && x.delivery_date === i.delivery_date).reduce((t, x) => t + Number(x.amount), 0));
      items.push({ store_id: i.store_id, delivery_date: i.delivery_date, invoice_id: i.id, number: i.number, total: i.total,
        credits: c, net: Math.max(cents(i.total - c), 0), ord: 1 });
    });
    items.sort((a, b) => a.store_id - b.store_id || a.ord - b.ord || String(a.delivery_date).localeCompare(String(b.delivery_date)) || a.invoice_id - b.invoice_id);
    const before = {};
    return items.map(r => {
      const pay = db.customer_payments.filter(p => p.store_id === r.store_id).reduce((t, p) => t + Number(p.amount), 0);
      const b = before[r.store_id] || 0;
      before[r.store_id] = b + r.net;
      const paid = cents(Math.min(Math.max(pay - b, 0), r.net));
      const { net, ord, ...out } = r;
      return { ...out, paid, balance: cents(r.net - paid) };
    });
  }

  const client = {
    from: t => new Query(t),
    rpc(name, args) {
      return new Promise(r => setTimeout(r, LATENCY)).then(() => {
        const me = role();
        if (missingRpcs.has(name)) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
        if (name === 'stop_amounts') {
          if (!['admin', 'driver'].includes(me)) return { data: [], error: null };
          const by = {};
          linesFor(args.p_date).forEach(r => by[r.store_id] = (by[r.store_id] || 0) + r.qty * (r.unit_price || 0));
          return { data: Object.entries(by).map(([s, a]) => ({ store_id: Number(s), amount: cents(a) })), error: null };
        }
        if (name === 'store_price_breakdown') {
          if (!ANY.includes(me)) return { data: [], error: null };
          return { data: linesFor(args.p_date).map(r => ({ store_id: r.store_id, product_id: r.product_id, qty: r.qty,
            unit_price: r.unit_price, amount: cents(r.qty * (r.unit_price || 0)) })), error: null };
        }
        if (name === 'invoice_balances') {
          if (me !== 'admin') return { data: [], error: null };
          return { data: balances().filter(r => (args.p_store == null || r.store_id === args.p_store)
            && (r.delivery_date == null || ((!args.p_from || r.delivery_date >= args.p_from) && (!args.p_to || r.delivery_date <= args.p_to)))), error: null };
        }
        if (name === 'store_accounts') {
          if (me !== 'admin') return { data: [], error: null };
          const by = {};
          const acc = id => by[id] ||= { store_id: id, opening: 0, invoiced: 0, credits: 0, paid: 0, net: 0, oldest_unpaid: null, last_payment: null };
          balances().forEach(r => {
            const a = acc(r.store_id);
            if (r.invoice_id == null) a.opening += r.total; else a.invoiced += r.total;
            a.credits += r.credits; a.net += r.total - r.credits;
            if (r.balance > 0 && r.delivery_date && (!a.oldest_unpaid || r.delivery_date < a.oldest_unpaid)) a.oldest_unpaid = r.delivery_date;
          });
          db.customer_payments.forEach(p => {
            const a = acc(p.store_id); a.paid += p.amount;
            if (!a.last_payment || p.paid_on > a.last_payment) a.last_payment = p.paid_on;
          });
          return { data: Object.values(by).map(a => ({ ...a, owing: cents(a.net - a.paid) })), error: null };
        }
        if (name === 'store_day_totals') {
          if (!['admin', 'baker'].includes(me)) return { data: [], error: null };
          const by = {};
          db.order_items.filter(r => r.qty > 0 && r.delivery_date >= args.p_from && r.delivery_date <= args.p_to).forEach(r => {
            const k = r.store_id + '|' + r.delivery_date;
            const p = db.order_item_prices.find(x => samePk('order_item_prices', x, r))?.unit_price ?? null;
            const o = by[k] ||= { store_id: r.store_id, delivery_date: r.delivery_date, subtotal: 0, unpriced: 0 };
            o.subtotal = cents(o.subtotal + r.qty * (p || 0)); if (p == null) o.unpriced++;
          });
          return { data: Object.values(by), error: null };
        }
        log.push({ t: 'rpc', op: name, vals: clone(args), by: session?.user.id });
        if (failWrites > 0) { failWrites--; return { data: null, error: { message: 'TypeError: Failed to fetch' } }; }
        if (name === 'issue_invoices') {
          if (!ANY.includes(me)) return { data: null, error: { code: '42501', message: 'Not allowed' } };
          const s = db.business_settings[0], d = args.p_date, ids = args.p_store_ids;
          if (s.accounts_start && d >= s.accounts_start) {
            const by = {};
            linesFor(d).filter(r => !ids || ids.includes(r.store_id)).forEach(r => (by[r.store_id] ||= []).push(r));
            for (const [sid, ls] of Object.entries(by)) {
              const storeId = Number(sid);
              if (db.invoices.some(i => i.store_id === storeId && i.delivery_date === d)) continue;
              const sub = cents(ls.reduce((t, l) => t + l.qty * (l.unit_price || 0), 0));
              const fr = s.freight_fee > 0 && sub < s.freight_under ? s.freight_fee : 0;
              const inv = { id: nextId.invoices++, store_id: storeId, delivery_date: d,
                number: d.slice(2).replaceAll('-', '') + '-' + String(storeId).padStart(3, '0'),
                subtotal: sub, freight: fr, fuel_levy: s.fuel_levy, total: cents(sub + fr + s.fuel_levy),
                payment_mode: db.stores.find(x => x.id === storeId).payment_mode, issued_at: new Date().toISOString(), sent_at: null };
              db.invoices.push(inv);
              ls.forEach(l => db.invoice_lines.push({ invoice_id: inv.id, product_id: l.product_id,
                product_name: db.products.find(p => p.id === l.product_id).name, qty: l.qty, unit_price: l.unit_price,
                amount: cents(l.qty * (l.unit_price || 0)) }));
            }
          }
          return { data: clone(db.invoices.filter(i => i.delivery_date === d && (!ids || ids.includes(i.store_id)))), error: null };
        }
        if (name === 'unlock_invoice') {
          if (me !== 'admin') return { data: null, error: { code: '42501', message: 'Only admins can unlock an invoice' } };
          db.invoices = db.invoices.filter(i => i.id !== args.p_id);
          db.invoice_lines = db.invoice_lines.filter(l => l.invoice_id !== args.p_id);
          return { data: null, error: null };
        }
        if (me !== 'admin') return { data: null, error: { code: '42501', message: 'Only admins can change the delivery order' } };
        args.store_ids.forEach((id, i) => {
          const s = db.stores.find(x => x.id === id);
          if (s && s.seq !== i + 1) { s.seq = i + 1; emit('stores', s); }
        });
        return { data: null, error: null };
      });
    },
    channel(name) {
      return {
        name, handlers: [],
        on(type, opts, cb) { this.handlers.push({ table: opts.table, filter: opts.filter, cb }); return this; },
        subscribe() { this.role = role(); channels.add(this); return this; },
      };
    },
    removeChannel(ch) { channels.delete(ch); return Promise.resolve('ok'); },
    auth: {
      async getSession() { return { data: { session }, error: null }; },
      async signInWithPassword({ email, password }) {
        await new Promise(r => setTimeout(r, LATENCY));
        const id = USERS[email];
        if (!id || password !== 'pw') return { data: { user: null, session: null }, error: { message: 'Invalid login credentials' } };
        session = { user: { id, email } };
        localStorage.setItem('mock_session', JSON.stringify(session));
        return { data: { user: session.user, session }, error: null };
      },
      async signOut() {
        session = null;
        localStorage.removeItem('mock_session');
        authCbs.forEach(cb => cb('SIGNED_OUT', null));
        return { error: null };
      },
      onAuthStateChange(cb) { authCbs.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
    },
  };

  window.supabase = { createClient: () => client };
  window.__mock = {
    db, log, channels,
    failNextWrites(n) { failWrites = n; },
    setMissingRpc(name, missing) { if (missing) missingRpcs.add(name); else missingRpcs.delete(name); },
    remoteWrite(table, row) { return writeRow(table, row, 'upsert'); },
  };
})();
