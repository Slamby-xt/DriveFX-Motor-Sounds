// DriveFX license server for Vercel (Node.js Functions) + Upstash Redis. Same endpoints and behaviour as the old Cloudflare Worker.
//   GET  /status?id=DFX-XXXX-XXXX      public: is this device subscribed? -> { active, exp, plan, manage, cancel }
//   POST /trial   {id, fp, used}        public: free-trial ledger kept on the server, so clearing cookies does not reset it
//   GET  /prices                        public: prices in usd/eur/gbp from Stripe + the currency suggested for this visitor's country
//   GET  /go?id=&plan=&cur=             public: creates a Stripe Checkout session and redirects to it (also what the QR code opens)
//   GET  /thanks?id=                    public: page shown after Checkout (never grants anything)
//   POST /portal                        public: address of Stripe's billing portal login page
//   POST /stripe-webhook                Stripe -> us (signature checked on the raw body)
//   POST /grant {id, days, mode} | POST /revoke {id} | GET /list | GET /find?email= | POST /relink {from, to}   admin, header X-Admin-Token
// Server-only environment variables: see .env.example.
//
// Storage rules (all state lives in Redis, never in memory/files):
//  * every key is prefixed with DATA_PREFIX ("prod" or "sandbox"); a live Stripe key refuses to run with any other prefix than "prod" and vice versa
//  * every read-modify-write of licenses, customer maps and purchase maps runs under one short Redis lock (see withLock)
//  * webhook events are claimed atomically (SET NX) so retries/concurrent deliveries are processed once
//  * counters (rate limits, trial caps) use atomic INCR; trial usage uses an atomic "keep the maximum" script
const ID_RE = /^DFX-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const FP_RE = /^[a-f0-9]{64}$/;
const PLANS = ['monthly', 'yearly', 'lifetime', 'manual'];
const TRIAL_SECONDS = 5 * 60;          // keep equal to TRIAL_SECONDS in paywall.js
const NEW_TRIALS_PER_NETWORK_DAY = 40;
const TRIAL_KEEP_DAYS = 400;
const SITE = 'https://drivefx.pro';
const ORIGINS = [SITE, 'https://www.drivefx.pro', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000'];

const STRIPE_VERSION = '2026-02-25.clover'; // keep equal to tools/stripe-setup.mjs
const GRACE = 2 * 86400;
const PLAN_KEYS = { monthly: 'drivefx_monthly', yearly: 'drivefx_yearly', lifetime: 'drivefx_lifetime' };
const PLAN_NAMES = { monthly: 'Monthly', yearly: 'Yearly', lifetime: 'Lifetime' };
const CURRENCIES = ['usd', 'eur', 'gbp'];
const EURO = new Set('AT BE BG HR CY EE FI FR DE GR IE IT LV LT LU MT NL PT SK SI ES AD MC SM VA ME XK'.split(' '));
const currencyFor = c => c === 'GB' || c === 'IM' || c === 'JE' || c === 'GG' ? 'gbp' : EURO.has(c) ? 'eur' : 'usd';

// ---- Vercel platform headers (set by Vercel's edge, a client cannot forge them) ----
const clientIp = req => req.headers.get('x-vercel-forwarded-for') || req.headers.get('x-real-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'x';
const countryOf = req => (req.headers.get('x-vercel-ip-country') || '').toUpperCase();
const selfOrigin = (req, env) => env.VERCEL_ENV === 'production' ? (env.PUBLIC_ORIGIN || SITE) : new URL(req.url).origin; // production always uses the canonical host; previews/local use their own
const allowedOrigin = (req, o, env) => !!o && (ORIGINS.includes(o) || o === selfOrigin(req, env));

const cors = (req, env) => {
  const o = req.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': allowedOrigin(req, o, env) ? o : ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
};
const json = (c, obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(c.req, c.env) } });
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const page = (title, body, status = 200) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#04050a;color:#e8f1ff;font:500 17px/1.5 system-ui,sans-serif;padding:20px}
main{max-width:440px;text-align:center;padding:30px 24px;border:1px solid #00e5ff;border-radius:18px;background:#0a0e1a;box-shadow:0 0 60px -14px #00e5ff}
h1{margin:0 0 10px;font-size:22px;letter-spacing:.04em}p{color:#9fb0c8;margin:0 0 14px}b.id{display:inline-block;padding:10px 14px;border:1px dashed #2a3858;border-radius:10px;color:#e8f1ff;letter-spacing:.1em;user-select:all}
a{color:#00e5ff}</style></head><body><main>${body}</main></body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });

async function same(a, b) { // constant-time string compare
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const A = new Uint8Array(x), B = new Uint8Array(y); let d = 0;
  for (let i = 0; i < A.length; i++) d |= A[i] ^ B[i];
  return d === 0;
}

// ---- storage helpers (c.store is the Redis wrapper from server/store.js) ----
const getJson = async (c, k) => { const v = await c.store.get(k); if (v == null) return null; try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
const getLic = (c, id) => getJson(c, 'lic:' + id);
const putLic = (c, id, rec) => c.store.set('lic:' + id, JSON.stringify(rec));
const isActive = (rec, now) => !!rec && (rec.exp === 0 || rec.exp > now);

// One lock for every change to licenses / customer / purchase maps. Webhooks and admin actions are rare, so serialising them is cheap
// and rules out lost updates, double grants and half-finished relinks. The lock expires by itself if a function dies.
async function withLock(c, fn) {
  let token = null;
  for (let i = 0; i < 60 && !token; i++) { token = await c.store.lock('license', 30); if (!token) await new Promise(r => setTimeout(r, 150 + Math.random() * 150)); }
  if (!token) { const e = new Error('busy'); e.busy = true; throw e; }
  try { return await fn(); } finally { await c.store.unlock('license', token).catch(() => {}); }
}

const ADMIN_GLOBAL_FAILS = 100; // failed admin logins per 15 min from anywhere before admin auth pauses for everyone (caps distributed guessing; a long ADMIN_TOKEN is still required)
async function isAdmin(c) {
  const rk = 'rl:admin:' + networkOf(clientIp(c.req)); // per network (IPv4 /24, IPv6 /48), so rotating addresses inside a range does not help
  const n = await c.store.incr(rk, 900);                // counts every attempt first, so parallel guesses cannot slip past the limit
  if (n > 8) return 'locked';
  if ((+(await c.store.get('rl:admin:global')) || 0) >= ADMIN_GLOBAL_FAILS) return 'locked';
  const ok = c.env.ADMIN_TOKEN && c.env.ADMIN_TOKEN.length >= 14 && (await same(c.req.headers.get('X-Admin-Token') || '', c.env.ADMIN_TOKEN));
  if (!ok) { await c.store.incr('rl:admin:global', 900); return false; }
  await c.store.del(rk);
  return true;
}
async function limited(c, name, max, seconds) { // atomic: at most `max` calls per `seconds` per network address
  return (await c.store.incr(`rl:${name}:${clientIp(c.req)}`, Math.max(60, seconds))) > max;
}

// Manual (admin) grants replace the record. Payments go through syncSub()/grantLifetime() and never downgrade a lifetime license.
function activateRec(plan, exp, now, days = 0, keep = {}) {
  return { exp, iat: now, days, plan: PLANS.includes(plan) ? plan : 'manual', ...keep };
}

// ---- Stripe API (plain fetch) ----
function form(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (x && typeof x === 'object') ? form(x, `${key}[${i}]`, out) : out.push([`${key}[${i}]`, String(x)]));
    else if (typeof v === 'object') form(v, key, out);
    else out.push([key, String(v)]);
  }
  return out;
}
async function sx(c, method, path, params) {
  if (!c.env.STRIPE_KEY) throw new Error('payments are not configured');
  const qs = params ? new URLSearchParams(form(params)).toString() : '';
  const get = method === 'GET';
  const r = await c.fetch('https://api.stripe.com/v1' + path + (get && qs ? '?' + qs : ''), {
    method,
    headers: { Authorization: 'Bearer ' + c.env.STRIPE_KEY, 'Stripe-Version': STRIPE_VERSION, ...(get ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
    body: get || !qs ? undefined : qs,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`stripe ${r.status}: ${j.error && j.error.message}`); e.status = r.status; e.code = j.error && j.error.code; throw e; }
  return j;
}

// Stripe price list is a cache of Stripe's data (not license state), re-read every 10 minutes per function instance.
let priceCache = null;
async function getPrices(c) {
  if (priceCache && priceCache.key === c.env.STRIPE_KEY && Date.now() - priceCache.at < 600000) return priceCache.v;
  const r = await sx(c, 'GET', '/prices', { lookup_keys: Object.values(PLAN_KEYS), active: true, expand: ['data.currency_options'], limit: 10 });
  const v = {};
  for (const p of r.data) {
    const plan = Object.keys(PLAN_KEYS).find(k => PLAN_KEYS[k] === p.lookup_key); if (!plan) continue;
    const amounts = { [p.currency]: p.unit_amount };
    for (const [cu, o] of Object.entries(p.currency_options || {})) amounts[cu] = o.unit_amount;
    if (CURRENCIES.every(cu => Number.isInteger(amounts[cu]))) v[plan] = { id: p.id, amounts };
  }
  priceCache = { at: Date.now(), key: c.env.STRIPE_KEY, v };
  return v;
}

// ---- checkout ----
async function prices(c) {
  try {
    const p = await getPrices(c);
    const plans = {}; for (const k of Object.keys(p)) plans[k] = p[k].amounts;
    const country = countryOf(c.req);
    return json(c, { currency: currencyFor(country), country, plans });
  } catch { return json(c, { error: 'prices unavailable' }, 503); }
}

async function go(c, url, now) {
  const id = (url.searchParams.get('id') || '').toUpperCase(), plan = url.searchParams.get('plan') || '';
  if (!ID_RE.test(id) || !PLAN_KEYS[plan]) return page('DriveFX', '<h1>Link not valid</h1><p>Open DriveFX and choose a plan again.</p>', 400);
  if (await limited(c, 'go', 30, 3600)) return page('DriveFX', '<h1>Too many attempts</h1><p>Please try again in a little while.</p>', 429);
  const asked = (url.searchParams.get('cur') || '').toLowerCase();
  const cur = CURRENCIES.includes(asked) ? asked : currencyFor(countryOf(c.req)); // currency is validated against the allow-list

  const rec = await getLic(c, id);
  if (isActive(rec, now) && (rec.exp === 0 || plan !== 'lifetime')) {
    return page('DriveFX', `<h1>Already Pro</h1><p>${esc(id)} already has Pro${rec.exp ? ' until ' + new Date(rec.exp * 1000).toISOString().slice(0, 10) : ' for life'}. To change or cancel a plan, open DriveFX and tap Manage.</p>`);
  }
  let price;
  try { price = (await getPrices(c))[plan]; } catch { price = null; }
  if (!price) return page('DriveFX', '<h1>Payments are not available right now</h1><p>Please try again in a few minutes.</p>', 503);

  const sub = plan !== 'lifetime';
  const desc = `DriveFX Pro ${PLAN_NAMES[plan]} · ID ${id}`;
  const meta = { app: 'drivefx', device: id, plan };
  const self = selfOrigin(c.req, c.env);
  const p = {
    mode: sub ? 'subscription' : 'payment',
    line_items: [{ price: price.id, quantity: 1 }],
    currency: cur,
    client_reference_id: id,
    metadata: meta,
    success_url: `${self}/thanks?id=${id}`,
    cancel_url: `${self}/thanks?id=${id}&c=1`,
    locale: 'auto',
    billing_address_collection: 'auto',
    custom_text: { submit: { message: sub
      ? `Renews automatically every ${plan === 'yearly' ? 'year' : 'month'} until you cancel (DriveFX > your plan > Manage). Your DriveFX ID: ${id}`
      : `One-time payment, no renewals. Your DriveFX ID: ${id}` } },
  };
  if (sub) p.subscription_data = { description: desc, metadata: meta };
  else {
    p.customer_creation = 'always';
    p.payment_intent_data = { description: desc, metadata: meta };
    p.invoice_creation = { enabled: true, invoice_data: { description: desc, metadata: meta } };
  }
  if (c.env.TAX === '1') p.automatic_tax = { enabled: true };
  if (c.env.TERMS_CONSENT === '1') {
    p.consent_collection = { terms_of_service: 'required' };
    p.custom_text.terms_of_service_acceptance = { message: 'I agree to the terms and ask for DriveFX Pro to start immediately, so I lose my 14-day right to cancel once it has started.' };
  }
  try {
    const s = await sx(c, 'POST', '/checkout/sessions', p);
    return Response.redirect(s.url, 303);
  } catch (e) {
    console.error('checkout', e.message);
    return page('DriveFX', '<h1>Payments are not available right now</h1><p>Please try again in a few minutes.</p>', 502);
  }
}

function thanks(c, url) {
  const id = (url.searchParams.get('id') || '').toUpperCase(), ok = ID_RE.test(id), cancelled = url.searchParams.get('c') === '1';
  const home = selfOrigin(c.req, c.env) + '/';
  if (cancelled) return page('DriveFX', `<h1>No payment taken</h1><p>You cancelled the checkout, nothing was charged.</p><p><a href="${esc(home)}">Back to DriveFX</a></p>`);
  return page('DriveFX', `<h1>Thank you!</h1><p>Your payment went through. The DriveFX window unlocks by itself within a few seconds. You can close this page.</p>${ok ? `<p>Your DriveFX ID<br><b class="id">${esc(id)}</b></p><p style="font-size:14px">Keep it: it is also on your Stripe receipt, and restores Pro if you clear your browser data.</p>` : ''}<p><a href="${esc(home)}">Back to DriveFX</a></p>`);
}

let portalCache = null;
async function portal(c) { // Stripe's own login page for the billing portal: it emails the customer a sign-in link
  const o = c.req.headers.get('Origin');
  if (o && !allowedOrigin(c.req, o, c.env)) return json(c, { error: 'origin not allowed' }, 403);
  try {
    if (!portalCache || portalCache.key !== c.env.STRIPE_KEY || Date.now() - portalCache.at > 3600000) {
      const r = await sx(c, 'GET', '/billing_portal/configurations', { active: true, limit: 20 });
      const cf = r.data.find(x => x.metadata && x.metadata.app === 'drivefx' && x.login_page && x.login_page.enabled && x.login_page.url);
      if (!cf) return json(c, { error: 'Billing is not available right now.' }, 503);
      portalCache = { at: Date.now(), url: cf.login_page.url, key: c.env.STRIPE_KEY };
    }
    return json(c, { url: portalCache.url });
  } catch (e) { console.error('portal', e.message); return json(c, { error: 'Billing is not available right now.' }, 502); }
}

// ---- turning Stripe events into licenses (always called inside withLock) ----
const withCus = (rec, cus) => { const l = (rec && rec.cuss) || (rec && rec.cus ? [rec.cus] : []); return l.includes(cus) ? l : [...l, cus].slice(-5); };

// Re-reads the subscription from Stripe (so event order does not matter) and sets the license end to the paid period end.
async function syncSub(c, subId, now, hintId) {
  const sub = await sx(c, 'GET', '/subscriptions/' + subId);
  if (!sub.metadata || sub.metadata.app !== 'drivefx') return;
  const cus = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const id = (await c.store.get('cus:' + cus)) || hintId || sub.metadata.device;
  if (!ID_RE.test(id || '')) return;
  await c.store.set('cus:' + cus, id);
  const cur = await getLic(c, id);
  if (cur && cur.exp === 0) { // lifetime: only remember the customer so the billing portal still works
    if (!(cur.cuss || []).includes(cus)) await putLic(c, id, { ...cur, cuss: withCus(cur, cus) });
    return;
  }
  const item = sub.items && sub.items.data && sub.items.data[0];
  const end = (item && item.current_period_end) || sub.current_period_end || 0;
  const live = sub.status === 'active' || sub.status === 'trialing';
  if (!live && cur && cur.sub && cur.sub !== sub.id && isActive(cur, now)) return; // an old subscription ending must not cut a newer one short
  let exp;
  if (live) exp = end + GRACE;
  else if (sub.status === 'canceled' || sub.status === 'unpaid' || sub.status === 'incomplete_expired') exp = now;
  else exp = cur ? cur.exp : now; // past_due / incomplete / paused: never extend
  const plan = PLANS.includes(sub.metadata.plan) ? sub.metadata.plan : 'monthly';
  await putLic(c, id, { exp, iat: (cur && cur.iat) || now, days: 0, plan, src: 'stripe', sub: sub.id, cus, cuss: withCus(cur, cus), cancel: live && !!(sub.cancel_at_period_end || sub.cancel_at) });
}

async function grantLifetime(c, id, s, now) {
  const pi = s.payment_intent, cus = s.customer;
  if (pi) {
    const p = await sx(c, 'GET', '/payment_intents/' + pi, { expand: ['latest_charge'] });
    const ch = p.latest_charge && typeof p.latest_charge === 'object' ? p.latest_charge : null;
    if (ch && (ch.refunded || ch.disputed)) return;       // refunded/disputed before this (delayed) event was handled
    if (await c.store.get('pi:' + pi)) return;             // this purchase was already applied (and may since have been moved with /relink)
  }
  id = (cus && await c.store.get('cus:' + cus)) || id;
  const cur = await getLic(c, id);
  if (cur && cur.sub && cur.exp !== 0) { // Lifetime replaces a subscription: stop it billing again. Failures other than "already gone" make Stripe retry
    try { await sx(c, 'POST', '/subscriptions/' + cur.sub, { cancel_at_period_end: true }); }
    catch (e) { if (e.code !== 'resource_missing' && e.code !== 'invalid_canceled_subscription_fields') throw e; }
  }
  if (cus) await c.store.set('cus:' + cus, id);
  await putLic(c, id, { exp: 0, iat: (cur && cur.iat) || now, days: 0, plan: 'lifetime', src: 'stripe', pi, cus, cuss: withCus(cur, cus), cancel: false });
  if (pi) await c.store.set('pi:' + pi, id);
}

// A full refund or a dispute ends access. A partial refund keeps it.
async function revokeFor(c, charge, now, dispute) {
  if (!dispute && !charge.refunded) return;
  if (!charge.customer) return;
  const id = await c.store.get('cus:' + charge.customer);
  const cur = id && await getLic(c, id);
  if (!cur) return;
  if (cur.exp === 0 && cur.plan === 'lifetime') { if (cur.pi && cur.pi !== charge.payment_intent) return; }
  else if (cur.sub && cur.cus === charge.customer) { try { await sx(c, 'DELETE', '/subscriptions/' + cur.sub); } catch {} }
  else return;
  await putLic(c, id, { ...cur, exp: now, cancel: false, ended: dispute ? 'dispute' : 'refund' });
}

const invoiceSub = inv => inv.subscription || (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription) || null;

async function handleEvent(c, ev, now) {
  const o = ev.data.object;
  switch (ev.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (!o.metadata || o.metadata.app !== 'drivefx') return;
      const id = String(o.client_reference_id || o.metadata.device || '').toUpperCase();
      if (!ID_RE.test(id)) return;
      if (o.mode === 'payment') { if (o.payment_status === 'paid') await grantLifetime(c, id, o, now); }
      else if (o.mode === 'subscription' && o.subscription) await syncSub(c, o.subscription, now, id);
      return;
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': { const s = invoiceSub(o); if (s) await syncSub(c, s, now); return; }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': await syncSub(c, o.id, now); return;
    case 'charge.refunded': await revokeFor(c, o, now, false); return;
    case 'charge.dispute.created': { const ch = await sx(c, 'GET', '/charges/' + o.charge); await revokeFor(c, ch, now, true); return; }
  }
}

// Signature check over the exact bytes Stripe sent (req.text() before any parsing).
async function verifySig(env, raw, header, now) {
  if (!env.STRIPE_WEBHOOK_SECRET || !header) return false;
  const parts = header.split(',').map(x => x.split('='));
  const t = (parts.find(p => p[0] === 't') || [])[1];
  const sigs = parts.filter(p => p[0] === 'v1').map(p => p[1]);
  if (!t || !sigs.length || Math.abs(now - Number(t)) > 300) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${raw}`))), b => b.toString(16).padStart(2, '0')).join('');
  for (const s of sigs) if (await same(s, mac)) return true;
  return false;
}

async function webhook(c, now) {
  const raw = await c.req.text();
  if (!(await verifySig(c.env, raw, c.req.headers.get('Stripe-Signature'), now))) return new Response('bad signature', { status: 400 });
  let ev; try { ev = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  if (!ev || typeof ev.id !== 'string' || !ev.data || !ev.data.object) return new Response('bad event', { status: 400 });
  const k = 'ev:' + ev.id;
  // Claim the event atomically: a duplicate or concurrent delivery either sees "done" (ack) or "in progress" (ask Stripe to retry later).
  if (!(await c.store.set(k, 'p', { nx: true, ex: 120 }))) {
    return (await c.store.get(k)) === 'd' ? new Response('ok') : new Response('in progress', { status: 409 });
  }
  try { await withLock(c, () => handleEvent(c, ev, now)); }
  catch (e) { await c.store.del(k).catch(() => {}); console.error('webhook', ev.type, ev.id, e.message); return new Response('error', { status: 500 }); } // Stripe retries on 5xx
  await c.store.set(k, 'd', { ex: 7 * 86400 });
  return new Response('ok');
}

// ---- free-trial ledger ----
// A visitor is recognised by two keys: the device ID and a fingerprint of the device together with its network. Usage is the larger of the two.
// Only keyed hashes are stored. New records per network per day are capped (atomic counter) so scripts cannot mint unlimited trials.
async function mac(env, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(env.TRIAL_PEPPER || 'drivefx-trial'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
  return Array.from(sig.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
}
const networkOf = ip => ip.includes(':') ? ip.split(':').slice(0, 3).join(':') : ip.split('.').slice(0, 3).join('.'); // IPv4 /24, IPv6 /48

async function trial(c, now) {
  const o = c.req.headers.get('Origin'); // a browser always sends Origin on a cross-site POST, so another site cannot write into the ledger
  if (o && !allowedOrigin(c.req, o, c.env)) return json(c, { error: 'origin not allowed' }, 403);
  let b; try { const t = await c.req.text(); if (t.length > 2048) throw 0; b = JSON.parse(t); } catch { return json(c, { error: 'bad request' }, 400); }
  const id = String(b && b.id || '').toUpperCase();
  const fp = b && b.fp ? String(b.fp) : '';
  const sent = Number(b && b.used);
  if (!ID_RE.test(id) || (fp && !FP_RE.test(fp)) || !Number.isFinite(sent) || sent < 0) return json(c, { error: 'bad request' }, 400);
  const mine = Math.min(sent, TRIAL_SECONDS + 30);
  const net = networkOf(clientIp(c.req));

  const kId = 'tr:id:' + await mac(c.env, 'id:' + id);
  const kDev = fp ? 'tr:dev:' + await mac(c.env, 'dev:' + fp + '|' + net) : null;
  const [a, d] = await Promise.all([getJson(c, kId), kDev ? getJson(c, kDev) : null]);
  const known = Math.max(a ? a.used : 0, d ? d.used : 0);
  const used = Math.max(known, mine);
  const out = { used, limit: TRIAL_SECONDS, left: Math.max(0, TRIAL_SECONDS - used), blocked: false, now };

  const kNet = 'tr:net:' + await mac(c.env, 'net:' + net + ':' + Math.floor(now / 86400));
  const wantsNew = !a || (kDev && !d);
  let capped = false;
  if (wantsNew) {
    if (used > 0) capped = (await c.store.incr(kNet, 2 * 86400)) > NEW_TRIALS_PER_NETWORK_DAY; // atomic: concurrent requests cannot all pass the cap
    else capped = (+(await c.store.get(kNet)) || 0) >= NEW_TRIALS_PER_NETWORK_DAY;
  }
  if (capped && !a && !d) return json(c, { ...out, used: TRIAL_SECONDS, left: 0, blocked: true });

  const rec = JSON.stringify({ used, at: now }), ttl = TRIAL_KEEP_DAYS * 86400;
  const writes = [];
  if (a) writes.push(c.store.putMax(kId, used, rec, ttl)); else if (used > 0 && !capped) writes.push(c.store.putMax(kId, used, rec, ttl));
  if (kDev) { if (d) writes.push(c.store.putMax(kDev, used, rec, ttl)); else if (used > 0 && !capped) writes.push(c.store.putMax(kDev, used, rec, ttl)); }
  await Promise.all(writes);
  return json(c, out);
}

// ---- main router ----
const ROUTES = new Set(['status', 'prices', 'go', 'thanks', 'portal', 'trial', 'grant', 'revoke', 'list', 'find', 'relink', 'stripe-webhook']);

export function routeOf(url) {
  const r = url.searchParams.get('__r');                       // set by the rewrites in vercel.json
  if (r && ROUTES.has(r)) return r;
  const p = url.pathname.replace(/^\/+|\/+$/g, '');
  return ROUTES.has(p) ? p : '';
}

export async function handle(req, deps) {
  const env = deps.env, url = new URL(req.url);
  const c0 = { req, env, fetch: deps.fetch || fetch, store: null };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, env) });
  const route = routeOf(url);
  if (!route) return json(c0, { error: 'not found' }, 404);
  const now = Math.floor(Date.now() / 1000);
  if (route === 'thanks' && req.method === 'GET') return thanks(c0, url); // needs no storage
  let c;
  try { c = { ...c0, store: await deps.getStore(env) }; }
  catch (e) { console.error('config', e.message); return json(c0, { error: 'server not configured' }, 503); }
  try {
    if (req.method === 'GET' && route === 'status') {
      const id = (url.searchParams.get('id') || '').toUpperCase();
      if (!ID_RE.test(id)) return json(c, { error: 'bad id' }, 400);
      const rec = await getLic(c, id);
      const active = isActive(rec, now);
      return json(c, { active, exp: rec ? rec.exp : 0, plan: rec ? rec.plan || 'manual' : null, manage: !!(rec && (rec.cus || rec.cuss)), cancel: !!(rec && rec.cancel && active), now });
    }
    if (req.method === 'GET' && route === 'prices') return await prices(c);
    if (req.method === 'GET' && route === 'go') return await go(c, url, now);
    if (req.method === 'POST' && route === 'portal') return await portal(c);
    if (req.method === 'POST' && route === 'stripe-webhook') return await webhook(c, now);
    if (req.method === 'POST' && route === 'trial') return await trial(c, now);

    if (['grant', 'revoke', 'list', 'find', 'relink'].includes(route)) {
      const a = await isAdmin(c);
      if (a === 'locked') return json(c, { error: 'Too many wrong attempts. Try again in 15 minutes.' }, 429);
      if (!a) return json(c, { error: 'Wrong password.' }, 401);

      if (req.method === 'GET' && route === 'list') {
        const keys = await c.store.scan('lic:'), out = [];
        for (let i = 0; i < keys.length; i += 100) {
          const vals = await c.store.mget(keys.slice(i, i + 100));
          vals.forEach((v, j) => { if (v) { try { out.push({ id: keys[i + j].slice(4), ...(typeof v === 'string' ? JSON.parse(v) : v) }); } catch {} } });
        }
        out.sort((x, y) => y.iat - x.iat);
        return json(c, { items: out, now });
      }

      if (req.method === 'GET' && route === 'find') {
        const email = (url.searchParams.get('email') || '').trim();
        if (!/^[^\s@]+@[^\s@]+$/.test(email)) return json(c, { error: 'Enter the email the customer paid with.' }, 400);
        try {
          const r = await sx(c, 'GET', '/customers', { email, limit: 10 });
          const items = [];
          for (const cu of r.data) {
            const id = await c.store.get('cus:' + cu.id);
            if (!id) continue;
            const rec = await getLic(c, id);
            items.push({ id, email: cu.email, plan: rec && rec.plan, exp: rec ? rec.exp : null, active: isActive(rec, now) });
          }
          return json(c, { items, now });
        } catch (e) { return json(c, { error: 'Stripe lookup failed: ' + e.message }, 502); }
      }

      if (req.method === 'POST') {
        let b; try { b = await req.json(); } catch { return json(c, { error: 'bad request' }, 400); }
        if (route === 'relink') {
          const from = String(b.from || '').toUpperCase(), to = String(b.to || '').toUpperCase();
          if (!ID_RE.test(from) || !ID_RE.test(to) || from === to) return json(c, { error: 'Both IDs must look like DFX-XXXX-XXXX and differ.' }, 400);
          return await withLock(c, async () => {
            const rec = await getLic(c, from);
            if (!rec) return json(c, { error: 'The old ID has no license.' }, 404);
            if (isActive(await getLic(c, to), now)) return json(c, { error: 'The new ID is already Pro.' }, 409);
            await putLic(c, to, rec);                                  // write the new record first, so a crash never leaves the customer without a license
            for (const cu of rec.cuss || (rec.cus ? [rec.cus] : [])) await c.store.set('cus:' + cu, to);
            if (rec.pi) await c.store.set('pi:' + rec.pi, to);
            await c.store.del('lic:' + from);
            return json(c, { ok: true, from, to });
          });
        }
        const id = String(b.id || '').toUpperCase();
        if (!ID_RE.test(id)) return json(c, { error: 'ID must look like DFX-XXXX-XXXX.' }, 400);
        if (route === 'revoke') {
          return await withLock(c, async () => {
            const cur = await getLic(c, id);
            if (cur && cur.sub && c.env.STRIPE_KEY) { try { await sx(c, 'DELETE', '/subscriptions/' + cur.sub); } catch {} } // stop charging the customer too
            await c.store.del('lic:' + id);
            return json(c, { ok: true });
          });
        }
        const days = b.days;
        if (!Number.isInteger(days) || days < 0 || days > 3650) return json(c, { error: 'Bad number of days.' }, 400);
        return await withLock(c, async () => {
          const cur = await getLic(c, id);
          let exp;
          if (days === 0) exp = 0;
          else if (b.mode === 'extend' && cur && (cur.exp === 0 || cur.exp > now)) exp = cur.exp === 0 ? 0 : cur.exp + days * 86400;
          else exp = now + days * 86400;
          const keep = {}; for (const k of ['cus', 'cuss', 'sub']) if (cur && cur[k]) keep[k] = cur[k];
          const rec = activateRec(days === 0 ? 'lifetime' : 'manual', exp, now, days, keep);
          await putLic(c, id, rec);
          return json(c, { ok: true, id, ...rec });
        });
      }
    }
    return json(c, { error: 'not found' }, 404);
  } catch (e) {
    if (e && e.busy) return json(c, { error: 'Busy, try again.' }, 503);
    console.error('error', route, e && e.message);
    return json(c, { error: 'server error' }, 500);
  }
}
