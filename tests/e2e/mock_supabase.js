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
    business_settings: [{
      id: 1, business_name: 'Test Bakery (Example)', address: '1 Example St, Testville NSW 2000', phone: '0400 000 000',
      abn: '11 111 111 111', bank_name: 'Example Bank', account_name: 'Test Bakery', bsb: '000-000', account_no: '12345678',
      fuel_levy: 0, freight_fee: 0, freight_under: 0,
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
  };
  const nextId = { stores: 23, products: 4, prices: 1 };
  const ANY = ['admin', 'baker', 'driver'];
  const READ = {
    stores: ANY, products: ANY, order_items: ANY, business_settings: ANY,
    prices: ['admin'], order_item_prices: ['admin'], deliveries: ['admin'], production: ['admin', 'baker'],
  };
  const WRITE = {
    stores: ['admin'], products: ['admin'], order_items: ['admin'], prices: ['admin'], deliveries: ['admin'],
    production: ['admin', 'baker'], order_item_prices: [], profiles: [], business_settings: ['admin'],
  };
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
    const defaults = t === 'stores' ? { archived: false, route: 1, contact_name: '', phone: '', abn: '' } : t === 'products' ? { archived: false } : {};
    const row = { ...defaults, ...v };
    if (nextId[t] && row.id == null) row.id = nextId[t]++;
    db[t].push(row); emit(t, row); afterInsert(t, row);
    if (t === 'prices') afterPriceChange(row.product_id);
    return row;
  }

  const rlsError = () => ({ code: '42501', message: 'new row violates row-level security policy' });
  const badValue = v => ('qty' in v && v.qty < 0) || ('qty_baked' in v && v.qty_baked < 0)
    || ('route' in v && ![1, 2].includes(v.route))
    || ('abn' in v && v.abn !== '' && !/^\d{11}$/.test(String(v.abn).replace(/\s/g, '')))
    || ('payment_mode' in v && v.payment_mode != null && !['cash', 'online', 'unpaid'].includes(v.payment_mode));

  class Query {
    constructor(t) { this.t = t; this.filters = []; this.op = 'select'; this.ret = false; this.one = null; this.sorts = []; }
    select() { if (this.op !== 'select') this.ret = true; return this; }
    eq(c, v) { this.filters.push(r => String(r[c]) === String(v)); return this; }
    is(c, v) { this.filters.push(r => (r[c] ?? null) === v); return this; }
    gt(c, v) { this.filters.push(r => r[c] > v); return this; }
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
          if (badValue(this.vals)) return { data: null, error: { message: 'violates check constraint' } };
          rows = db[t].filter(match);
          rows.forEach(r => { Object.assign(r, this.vals); emit(t, r); if (t === 'prices') afterPriceChange(r.product_id); });
        }
      } else if (this.op === 'delete') {
        rows = mayWrite ? db[t].filter(match) : [];
        rows.forEach(r => { db[t].splice(db[t].indexOf(r), 1); emit(t, r, true); if (t === 'prices') afterPriceChange(r.product_id); });
      } else {
        if (!mayWrite) return { data: null, error: rlsError() };
        rows = [];
        for (const v of this.vals) {
          if (badValue(v)) return { data: null, error: { message: 'violates check constraint' } };
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
        log.push({ t: 'rpc', op: name, vals: clone(args), by: session?.user.id });
        if (failWrites > 0) { failWrites--; return { data: null, error: { message: 'TypeError: Failed to fetch' } }; }
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
