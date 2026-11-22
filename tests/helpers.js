// In-memory stand-ins used ONLY by tests: a store with the same interface as server/store.js and a fake Stripe API.
import { createHmac } from 'node:crypto';
import { handle } from '../server/handler.js';
import { deviceMetadata } from '../server/payments.js';
import { PLANS } from '../server/stripe.js';

export function memoryStore() {
  const m = new Map(), locks = new Map();
  function queries(entries) {
    const live = k => {
      const e = entries.get(k);
      return e && (!e.exp || e.exp > Date.now()) ? e : null;
    };
    return {
      get: async k => live(k)?.v ?? null,
      async set(k, v, o = {}) {
        if (o.nx && live(k)) return false;
        entries.set(k, { v: JSON.parse(JSON.stringify(v)), exp: o.ex ? Date.now() + o.ex * 1000 : 0 });
        return true;
      },
      del: async k => { entries.delete(k); },
      async touch(key, ttl) {
        const row = live(key);
        if (!row) return false;
        entries.set(key, { ...row, exp: Date.now() + ttl * 1000 });
        return true;
      },
      release: async (k, token) => { if (live(k)?.v === token) entries.delete(k); },
      async incr(k, ttl) {
        const e = live(k), v = (e?.v ?? 0) + 1;
        entries.set(k, { v, exp: e?.exp ?? Date.now() + ttl * 1000 });
        return v;
      },
      async putMax(k, used, v, ttl) {
        if ((live(k)?.v?.used ?? -1) < used) entries.set(k, { v, exp: Date.now() + ttl * 1000 });
      },
      async attachSession(key, token, session) {
        const row = live(key);
        if (row?.v.token !== token || (row.v.session && row.v.session !== session)) return false;
        entries.set(key, { ...row, v: { ...row.v, session } });
        return true;
      },
      async updateUnexposedCheckout(key, previous, next, ttl = null) {
        const row = live(key);
        if (!row || row.v.session || JSON.stringify(row.v) !== JSON.stringify(previous)) return false;
        entries.set(key, { v: next, exp: ttl === null ? row.exp : Date.now() + ttl * 1000 });
        return true;
      },
      async licenses() {
        return [...entries.keys()].filter(k => k.startsWith('lic:')).map(k => ({ id: k.slice(4), ...live(k).v }));
      },
      async rememberCustomer(customer, device) {
        entries.set('cus:' + customer + ':' + device, { v: { device } });
      },
      async customerDevices(customer) {
        return [...entries].filter(([key]) => key.startsWith('cus:' + customer + ':')).map(([, entry]) => entry.v.device);
      },
      async moveMappings(from, to) {
        for (const [k, e] of [...entries]) {
          if (e.v.device !== from) continue;
          if (k.startsWith('cus:')) {
            entries.set(k.slice(0, -from.length) + to, { v: { device: to } });
            entries.delete(k);
          } else if (/^(sub|pi):/.test(k)) entries.set(k, { ...e, v: { ...e.v, device: to } });
        }
      },
      async clearJob(key, value) {
        if (JSON.stringify(live(key)?.v) === JSON.stringify(value)) entries.delete(key);
      },
    };
  }
  return {
    m,
    ...queries(m),
    async transaction(lock, fn) {
      if (Array.isArray(lock)) lock = 'trial';
      const previous = locks.get(lock);
      let release;
      const pending = new Promise(resolve => { release = resolve; });
      locks.set(lock, pending);
      await previous;
      try {
        const before = new Map(m), snapshot = new Map(before);
        const result = await fn(queries(snapshot));
        for (const key of before.keys()) if (!snapshot.has(key)) m.delete(key);
        for (const [key, value] of snapshot) if (before.get(key) !== value) m.set(key, value);
        return result;
      } finally {
        release();
        if (locks.get(lock) === pending) locks.delete(lock);
      }
    },
  };
}

// Minimal Stripe: subscriptions/payment intents/charges are plain objects the test mutates.
export function fakeStripe() {
  const st = { subs: {}, pis: {}, charges: {}, customers: [], calls: [], cancelled: [], deleted: [],
    sessions: {}, attempts: {}, failNext: null, failBilling: false };
  const price = (id, plan, key, amount, interval) => ({
    id, lookup_key: 'drivefx_' + key, active: true, billing_scheme: 'per_unit',
    product: { active: true, name: 'DriveFX Pro ' + plan, tax_code: 'txcd_10103000' },
    type: interval ? 'recurring' : 'one_time', recurring: { interval, interval_count: 1 },
    currency: 'usd', unit_amount: amount, tax_behavior: 'inclusive',
    currency_options: { eur: { unit_amount: amount, tax_behavior: 'inclusive' }, gbp: { unit_amount: amount, tax_behavior: 'inclusive' } },
  });
  st.prices = [price('price_m', 'Monthly', 'monthly', 299, 'month'),
    price('price_y', 'Yearly', 'yearly', 2999, 'year'), price('price_l', 'Lifetime', 'lifetime', 4999)];
  const invoiceFor = sub => sub.latest_invoice === undefined ? {
    id: 'in_' + sub.id + '_' + sub.items.data[0].current_period_end,
    status: 'paid', amount_paid: 299, subscription: sub.id, customer: sub.customer,
  } : sub.latest_invoice;
  st.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET', p = u.pathname.replace('/v1', '');
    const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    st.calls.push({ method, p, body, query: u.searchParams, headers: init.headers });
    const ok = o => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const err = (status, code, message) => new Response(JSON.stringify({ error: { code, message } }), { status });
    if (st.failNext) { const f = st.failNext; st.failNext = null; return err(500, f, 'boom'); }
    if (p === '/prices') return ok({ data: st.prices });
    if (p === '/checkout/sessions' && method === 'POST') {
      const key = init.headers['Idempotency-Key'];
      if (!st.attempts[key]) {
        const id = 'cs_' + Object.keys(st.sessions).length;
        const url = 'https://checkout.stripe.com/c/' + id;
        st.sessions[id] = { id, status: 'open', url, expires_at: Number(body.expires_at) };
        st.attempts[key] = { ...st.sessions[id] };
      }
      return ok(st.attempts[key]);
    }
    if (p.startsWith('/checkout/sessions/')) {
      const session = st.sessions[p.split('/').pop()];
      return session ? ok(session) : err(404, 'resource_missing', 'no');
    }
    if (p === '/invoice_payments') {
      const invoice = u.searchParams.get('invoice');
      const sub = Object.values(st.subs).find(s => invoiceFor(s)?.id === invoice);
      return ok({ data: sub ? [{ status: 'paid', invoice, amount_paid: 299,
        payment: { type: 'payment_intent', payment_intent: sub.invoicePayment || 'pi_' + invoice } }] : [] });
    }
    if (p === '/billing_portal/configurations') return ok({ data: [{ metadata: { app: 'drivefx' }, login_page: { enabled: true, url: 'https://billing.stripe.test/login' } }] });
    let m;
    if ((m = p.match(/^\/subscriptions\/(.+)$/))) {
      if (method === 'GET') {
        const sub = st.subs[m[1]];
        return sub ? ok({ ...sub, latest_invoice: invoiceFor(sub) }) : err(404, 'resource_missing', 'no');
      }
      if (st.failBilling) return err(500, 'api_error', 'boom');
      if (method === 'DELETE') { st.deleted.push(m[1]); if (st.subs[m[1]]) st.subs[m[1]].status = 'canceled'; return ok({}); }
      st.cancelled.push(m[1]); if (st.subs[m[1]]) st.subs[m[1]].cancel_at_period_end = true; return ok({});
    }
    if ((m = p.match(/^\/payment_intents\/(.+)$/))) {
      const pi = st.pis[m[1]], charge = pi && st.charges[pi.charge];
      return pi ? ok({ id: m[1], customer: charge?.customer, status: 'succeeded', currency: 'usd', amount_received: 4999,
        metadata: testMetadata('DFX-AAAA-0001', 'lifetime'), ...pi, latest_charge: charge }) :
        err(404, 'resource_missing', 'no');
    }
    if ((m = p.match(/^\/charges\/(.+)$/))) return ok(st.charges[m[1]]);
    if (p === '/customers') return ok({ data: st.customers.filter(c => c.email === u.searchParams.get('email')) });
    return err(404, 'resource_missing', 'unknown ' + p);
  };
  return st;
}

export const ENV = { DATA_PREFIX: 'sandbox', STRIPE_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_test', ADMIN_TOKEN: 'a-long-admin-password', TRIAL_PEPPER: 'local-test-pepper-with-32-characters', VERCEL_ENV: 'preview', CHECKOUT_ENABLED: '1' };

export function app(over = {}) {
  const store = over.store || memoryStore(), stripe = over.stripe || fakeStripe(), env = { ...ENV, ...(over.env || {}) };
  const deps = { env, fetch: stripe.fetch, getStore: async () => store };
  const call = (method, path, { body, headers = {}, raw, ip = '203.0.113.5', origin } = {}) => handle(new Request('https://drivefx-test.vercel.app' + path, {
    method, headers: { 'x-vercel-forwarded-for': ip, ...(origin ? { Origin: origin } : {}), ...headers }, body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined }), deps);
  const j = async r => ({ status: r.status, ...(await r.clone().json().catch(() => ({}))), _r: r });
  const admin = (method, path, body) => call(method, path, { body, headers: { 'X-Admin-Token': env.ADMIN_TOKEN } }).then(j);
  const event = (type, object, id = 'evt_' + Math.random().toString(36).slice(2)) => ({ id, type, livemode: env.DATA_PREFIX === 'prod', data: { object } });
  const hook = (ev, { secret = env.STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000), tamper } = {}) => {
    const raw = JSON.stringify(ev), sig = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    return call('POST', '/stripe-webhook', { raw: tamper ? raw + ' ' : raw, headers: { 'Stripe-Signature': `t=${t},v1=${sig}` } });
  };
  return { store, stripe, env, call, j, admin, event, hook };
}

export function testMetadata(device, plan, price = 'price_' + plan[0], currency = 'usd', amount = PLANS[plan].amount) {
  return deviceMetadata(device, plan, price, currency, amount);
}

export function lifetimeEvent(a, payment, customer = 'cus_1', device = 'DFX-AAAA-0001', options = {}) {
  const metadata = options.metadata ?? testMetadata(device, 'lifetime');
  const id = 'cs_paid_' + payment;
  const shape = { id, status: 'complete', mode: 'payment', payment_status: 'paid',
    payment_intent: payment, customer, client_reference_id: device, metadata };
  const item = { price: { id: metadata.price }, quantity: 1, currency: metadata.currency, amount_total: Number(metadata.amount) };
  a.stripe.sessions[id] = { ...shape, currency: metadata.currency, amount_total: item.amount_total,
    line_items: { data: [item], has_more: false }, ...(options.session || {}) };
  return a.event(options.type ?? 'checkout.session.completed', shape);
}
