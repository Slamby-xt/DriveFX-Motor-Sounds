// In-memory stand-ins used ONLY by tests: a store with the same interface as server/store.js and a fake Stripe API.
import { createHmac } from 'node:crypto';
import { handle } from '../server/handler.js';

export function memoryStore() {
  const m = new Map(); const now = () => Date.now();
  const live = k => { const e = m.get(k); if (!e) return null; if (e.exp && e.exp <= now()) { m.delete(k); return null; } return e; };
  const s = {
    m,
    get: async k => { const e = live(k); return e ? e.v : null; },
    async set(k, v, o = {}) { if (o.nx && live(k)) return false; m.set(k, { v: String(v), exp: o.ex ? now() + o.ex * 1000 : 0 }); return true; },
    del: async k => { m.delete(k); },
    async incr(k, ttl) { const e = live(k); const n = (e ? +e.v : 0) + 1; m.set(k, { v: String(n), exp: e ? e.exp : now() + ttl * 1000 }); return n; },
    async putMax(k, used, rec, ttl) { const e = live(k); if (e) { try { if (JSON.parse(e.v).used >= used) return 0; } catch {} } m.set(k, { v: rec, exp: now() + ttl * 1000 }); return 1; },
    mget: async keys => keys.map(k => { const e = live(k); return e ? e.v : null; }),
    scan: async p => [...m.keys()].filter(k => k.startsWith(p) && live(k)),
    async lock(n, ttl) { const t = Math.random().toString(36); return (await s.set('lock:' + n, t, { nx: true, ex: ttl })) ? t : null; },
    async unlock(n, t) { const e = live('lock:' + n); if (e && e.v === t) m.delete('lock:' + n); },
  };
  return s;
}

// Minimal Stripe: subscriptions/payment intents/charges are plain objects the test mutates.
export function fakeStripe() {
  const st = { subs: {}, pis: {}, charges: {}, customers: [], calls: [], cancelled: [], deleted: [], failNext: null };
  const price = (id, lk) => ({ id, lookup_key: lk, currency: 'usd', unit_amount: 299, currency_options: { eur: { unit_amount: 299 }, gbp: { unit_amount: 299 } } });
  st.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET', p = u.pathname.replace('/v1', '');
    const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    st.calls.push({ method, p, body });
    const ok = o => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const err = (status, code, message) => new Response(JSON.stringify({ error: { code, message } }), { status });
    if (st.failNext) { const f = st.failNext; st.failNext = null; return err(500, f, 'boom'); }
    if (p === '/prices') return ok({ data: [price('price_m', 'drivefx_monthly'), price('price_y', 'drivefx_yearly'), price('price_l', 'drivefx_lifetime')] });
    if (p === '/checkout/sessions' && method === 'POST') return ok({ url: 'https://checkout.stripe.test/c/' + body['client_reference_id'] + '/' + body.mode });
    if (p === '/billing_portal/configurations') return ok({ data: [{ metadata: { app: 'drivefx' }, login_page: { enabled: true, url: 'https://billing.stripe.test/login' } }] });
    let m;
    if ((m = p.match(/^\/subscriptions\/(.+)$/))) {
      if (method === 'GET') return st.subs[m[1]] ? ok(st.subs[m[1]]) : err(404, 'resource_missing', 'no');
      if (method === 'DELETE') { st.deleted.push(m[1]); if (st.subs[m[1]]) st.subs[m[1]].status = 'canceled'; return ok({}); }
      st.cancelled.push(m[1]); return ok({});
    }
    if ((m = p.match(/^\/payment_intents\/(.+)$/))) return ok({ ...st.pis[m[1]], latest_charge: st.charges[st.pis[m[1]].charge] });
    if ((m = p.match(/^\/charges\/(.+)$/))) return ok(st.charges[m[1]]);
    if (p === '/customers') return ok({ data: st.customers.filter(c => c.email === u.searchParams.get('email')) });
    return err(404, 'resource_missing', 'unknown ' + p);
  };
  return st;
}

export const ENV = { DATA_PREFIX: 'sandbox', STRIPE_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_test', ADMIN_TOKEN: 'a-long-admin-password', TRIAL_PEPPER: 'pep', VERCEL_ENV: 'preview' };

export function app(over = {}) {
  const store = over.store || memoryStore(), stripe = over.stripe || fakeStripe(), env = { ...ENV, ...(over.env || {}) };
  const deps = { env, fetch: stripe.fetch, getStore: async () => store };
  const call = (method, path, { body, headers = {}, raw, ip = '203.0.113.5', origin } = {}) => handle(new Request('https://drivefx-test.vercel.app' + path, {
    method, headers: { 'x-vercel-forwarded-for': ip, ...(origin ? { Origin: origin } : {}), ...headers }, body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined }), deps);
  const j = async r => ({ status: r.status, ...(await r.clone().json().catch(() => ({}))), _r: r });
  const admin = (method, path, body) => call(method, path, { body, headers: { 'X-Admin-Token': env.ADMIN_TOKEN } }).then(j);
  const event = (type, object, id = 'evt_' + Math.random().toString(36).slice(2)) => ({ id, type, data: { object } });
  const hook = (ev, { secret = env.STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000), tamper } = {}) => {
    const raw = JSON.stringify(ev), sig = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    return call('POST', '/stripe-webhook', { raw: tamper ? raw + ' ' : raw, headers: { 'Stripe-Signature': `t=${t},v1=${sig}` } });
  };
  return { store, stripe, env, call, j, admin, event, hook };
}
