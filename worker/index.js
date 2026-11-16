// DriveFX license server — Cloudflare Worker + KV.
//   GET  /status?id=DFX-XXXX-XXXX      public: is this device subscribed? -> { active, exp, plan, manage, cancel }
//   POST /trial   {id, fp, used}        public: free-trial ledger kept on the server, so clearing cookies does not reset it
//   GET  /prices                        public: prices in usd/eur/gbp from Stripe + the currency suggested for this visitor's country
//   GET  /go?id=&plan=&cur=             public: creates a Stripe Checkout session and redirects to it (also what the QR code opens)
//   GET  /thanks?id=                    public: page shown after Checkout
//   POST /portal                        public: address of Stripe's billing portal login page (the customer proves who they are by email, via Stripe)
//   POST /stripe-webhook                Stripe -> us (signature checked)
//   POST /grant   {id, days, mode}      admin:  days=0 means lifetime; mode "extend" adds time to an active subscription
//   POST /revoke  {id}                  admin   (also cancels the Stripe subscription, if any)
//   GET  /list                          admin
//   GET  /find?email=                   admin:  look up a paying customer by the email they paid with
//   POST /relink  {from, to}            admin:  move a paid license to a new device ID (customer lost their ID)
// Admin calls need the header  X-Admin-Token: <ADMIN_TOKEN secret>.
// Secrets:  STRIPE_KEY (restricted key), STRIPE_WEBHOOK_SECRET (whsec_...), TRIAL_PEPPER (optional, trial-ledger hashes).
// Optional vars: TAX=1 (turn on Stripe Tax at checkout), TERMS_CONSENT=1 (require ticking the terms box at checkout; the terms URL must be set in the Stripe dashboard).
const ID_RE = /^DFX-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const FP_RE = /^[a-f0-9]{64}$/;
const PLANS = ['monthly', 'yearly', 'lifetime', 'manual'];
const TRIAL_SECONDS = 5 * 60;          // free engine time per device (keep equal to TRIAL_SECONDS in paywall.js)
const NEW_TRIALS_PER_NETWORK_DAY = 40; // brand-new trial identities accepted per network per day (stops scripted resets)
const TRIAL_KEEP_DAYS = 400;           // how long a trial record is remembered
const ORIGINS = ['https://drivefx.pro', 'https://www.drivefx.pro', 'http://localhost:5173', 'http://127.0.0.1:5173'];

// ---- Stripe ----
const STRIPE_VERSION = '2026-02-25.clover'; // pinned: webhook payloads and API responses keep this shape (webhook endpoints created by tools/stripe-setup.mjs use the same version)
const GRACE = 2 * 86400;               // a paid period keeps working this long past its end (renewal webhooks can lag)
const PLAN_KEYS = { monthly: 'drivefx_monthly', yearly: 'drivefx_yearly', lifetime: 'drivefx_lifetime' }; // Stripe price lookup_keys (created by tools/stripe-setup.mjs)
const PLAN_NAMES = { monthly: 'Monthly', yearly: 'Yearly', lifetime: 'Lifetime' };
const CURRENCIES = ['usd', 'eur', 'gbp'];
const EURO = new Set('AT BE BG HR CY EE FI FR DE GR IE IT LV LT LU MT NL PT SK SI ES AD MC SM VA ME XK'.split(' '));
const currencyFor = c => c === 'GB' || c === 'IM' || c === 'JE' || c === 'GG' ? 'gbp' : EURO.has(c) ? 'eur' : 'usd';

const cors = req => {
  const o = req.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(o) ? o : ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
};
const json = (req, obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(req) } });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

async function isAdmin(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || 'x', rk = 'rl:' + ip;
  const tries = +(await env.LICENSES.get(rk)) || 0;
  if (tries >= 8) return 'locked';
  const ok = env.ADMIN_TOKEN && (await same(req.headers.get('X-Admin-Token') || '', env.ADMIN_TOKEN));
  if (!ok) { await env.LICENSES.put(rk, String(tries + 1), { expirationTtl: 900 }); return false; }
  if (tries) await env.LICENSES.delete(rk);
  return true;
}

// Best-effort limiter (KV has no atomic counter): at most `max` calls per `seconds` per network address.
async function limited(req, env, name, max, seconds) {
  const k = `rl:${name}:${req.headers.get('CF-Connecting-IP') || 'x'}`;
  const n = +(await env.LICENSES.get(k)) || 0;
  if (n >= max) return true;
  await env.LICENSES.put(k, String(n + 1), { expirationTtl: Math.max(60, seconds) });
  return false;
}

// Give a device a license. exp = unix seconds when it ends, 0 = lifetime. Used for manual (admin) grants, which replace the record.
// Payments go through entitle()/syncSub()/grantLifetime() below, which never downgrade a lifetime license.
async function activate(env, id, plan, exp, now = Math.floor(Date.now() / 1000), days = 0, keep = {}) {
  const rec = { exp, iat: now, days, plan: PLANS.includes(plan) ? plan : 'manual', ...keep };
  await env.LICENSES.put('lic:' + id, JSON.stringify(rec));
  return rec;
}
const getLic = (env, id) => env.LICENSES.get('lic:' + id, 'json');
const isActive = (rec, now) => !!rec && (rec.exp === 0 || rec.exp > now);

// ---- Stripe API (plain fetch: no SDK needed in a Worker) ----
function form(obj, prefix, out = []) { // nested objects/arrays -> Stripe's bracket notation
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (x && typeof x === 'object') ? form(x, `${key}[${i}]`, out) : out.push([`${key}[${i}]`, String(x)]));
    else if (typeof v === 'object') form(v, key, out);
    else out.push([key, String(v)]);
  }
  return out;
}
async function sx(env, method, path, params) {
  if (!env.STRIPE_KEY) throw new Error('payments are not configured');
  const qs = params ? new URLSearchParams(form(params)).toString() : '';
  const get = method === 'GET';
  const r = await fetch('https://api.stripe.com/v1' + path + (get && qs ? '?' + qs : ''), {
    method,
    headers: { Authorization: 'Bearer ' + env.STRIPE_KEY, 'Stripe-Version': STRIPE_VERSION, ...(get ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
    body: get || !qs ? undefined : qs,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`stripe ${r.status}: ${j.error && j.error.message}`); e.status = r.status; e.code = j.error && j.error.code; throw e; }
  return j;
}

let priceCache = null;
async function getPrices(env) { // { monthly: { id, amounts: { usd: 299, eur: 299, gbp: 299 } }, ... }, cached 10 min per isolate
  if (priceCache && Date.now() - priceCache.at < 600000) return priceCache.v;
  const r = await sx(env, 'GET', '/prices', { lookup_keys: Object.values(PLAN_KEYS), active: true, expand: ['data.currency_options'], limit: 10 });
  const v = {};
  for (const p of r.data) {
    const plan = Object.keys(PLAN_KEYS).find(k => PLAN_KEYS[k] === p.lookup_key); if (!plan) continue;
    const amounts = { [p.currency]: p.unit_amount };
    for (const [c, o] of Object.entries(p.currency_options || {})) amounts[c] = o.unit_amount;
    if (CURRENCIES.every(c => Number.isInteger(amounts[c]))) v[plan] = { id: p.id, amounts };
  }
  priceCache = { at: Date.now(), v };
  return v;
}

// ---- checkout ----
async function prices(req, env) {
  try {
    const p = await getPrices(env);
    const plans = {}; for (const k of Object.keys(p)) plans[k] = p[k].amounts;
    return json(req, { currency: currencyFor(req.cf && req.cf.country), country: (req.cf && req.cf.country) || '', plans });
  } catch { return json(req, { error: 'prices unavailable' }, 503); }
}

async function go(req, env, url, now) {
  const id = (url.searchParams.get('id') || '').toUpperCase(), plan = url.searchParams.get('plan') || '';
  if (!ID_RE.test(id) || !PLAN_KEYS[plan]) return page('DriveFX', '<h1>Link not valid</h1><p>Open DriveFX and choose a plan again.</p>', 400);
  if (await limited(req, env, 'go', 30, 3600)) return page('DriveFX', '<h1>Too many attempts</h1><p>Please try again in a little while.</p>', 429);
  const asked = (url.searchParams.get('cur') || '').toLowerCase();
  const cur = CURRENCIES.includes(asked) ? asked : currencyFor(req.cf && req.cf.country);

  const rec = await getLic(env, id);
  if (isActive(rec, now) && (rec.exp === 0 || plan !== 'lifetime')) { // an active subscription may still buy Lifetime; nothing else makes sense
    return page('DriveFX', `<h1>Already Pro</h1><p>${esc(id)} already has Pro${rec.exp ? ' until ' + new Date(rec.exp * 1000).toISOString().slice(0, 10) : ' for life'}. To change or cancel a plan, open DriveFX and tap Manage.</p>`);
  }
  let price;
  try { price = (await getPrices(env))[plan]; } catch { price = null; }
  if (!price) return page('DriveFX', '<h1>Payments are not available right now</h1><p>Please try again in a few minutes.</p>', 503);

  const sub = plan !== 'lifetime';
  const desc = `DriveFX Pro ${PLAN_NAMES[plan]} · ID ${id}`;
  const meta = { app: 'drivefx', device: id, plan };
  const self = new URL(req.url).origin;
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
  if (env.TAX === '1') p.automatic_tax = { enabled: true };
  if (env.TERMS_CONSENT === '1') {
    p.consent_collection = { terms_of_service: 'required' };
    p.custom_text.terms_of_service_acceptance = { message: 'I agree to the terms and ask for DriveFX Pro to start immediately, so I lose my 14-day right to cancel once it has started.' };
  }
  try {
    const s = await sx(env, 'POST', '/checkout/sessions', p);
    return Response.redirect(s.url, 303);
  } catch (e) {
    console.error('checkout', e.message);
    return page('DriveFX', '<h1>Payments are not available right now</h1><p>Please try again in a few minutes.</p>', 502);
  }
}

function thanks(url) {
  const id = (url.searchParams.get('id') || '').toUpperCase(), ok = ID_RE.test(id), cancelled = url.searchParams.get('c') === '1';
  if (cancelled) return page('DriveFX', '<h1>No payment taken</h1><p>You cancelled the checkout, nothing was charged.</p><p><a href="https://drivefx.pro/">Back to DriveFX</a></p>');
  return page('DriveFX', `<h1>Thank you!</h1><p>Your payment went through. The DriveFX window unlocks by itself within a few seconds. You can close this page.</p>${ok ? `<p>Your DriveFX ID<br><b class="id">${esc(id)}</b></p><p style="font-size:14px">Keep it: it is also on your Stripe receipt, and restores Pro if you clear your browser data.</p>` : ''}<p><a href="https://drivefx.pro/">Back to DriveFX</a></p>`);
}

let portalCache = null;
async function portal(req, env) { // Stripe's own login page for the billing portal: it emails the customer a sign-in link, so no device ID is ever enough to reach someone's billing
  const o = req.headers.get('Origin');
  if (o && !ORIGINS.includes(o)) return json(req, { error: 'origin not allowed' }, 403);
  try {
    if (!portalCache || Date.now() - portalCache.at > 3600000) {
      const r = await sx(env, 'GET', '/billing_portal/configurations', { active: true, limit: 20 });
      const c = r.data.find(x => x.metadata && x.metadata.app === 'drivefx' && x.login_page && x.login_page.enabled && x.login_page.url);
      if (!c) return json(req, { error: 'Billing is not available right now.' }, 503);
      portalCache = { at: Date.now(), url: c.login_page.url };
    }
    return json(req, { url: portalCache.url });
  } catch (e) { console.error('portal', e.message); return json(req, { error: 'Billing is not available right now.' }, 502); }
}

// ---- turning Stripe events into licenses ----
const withCus = (rec, cus) => { const l = (rec && rec.cuss) || (rec && rec.cus ? [rec.cus] : []); return l.includes(cus) ? l : [...l, cus].slice(-5); };

// Re-reads the subscription from Stripe (so event order does not matter) and sets the license end to the paid period end.
async function syncSub(env, subId, now, hintId) {
  const sub = await sx(env, 'GET', '/subscriptions/' + subId);
  if (!sub.metadata || sub.metadata.app !== 'drivefx') return; // not ours (the Stripe account may hold other products)
  const cus = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const id = (await env.LICENSES.get('cus:' + cus)) || hintId || sub.metadata.device;
  if (!ID_RE.test(id || '')) return;
  await env.LICENSES.put('cus:' + cus, id);
  const cur = await getLic(env, id);
  if (cur && cur.exp === 0) { // lifetime: only remember the customer so the billing portal still works
    if (!(cur.cuss || []).includes(cus)) await env.LICENSES.put('lic:' + id, JSON.stringify({ ...cur, cuss: withCus(cur, cus) }));
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
  const rec = { exp, iat: (cur && cur.iat) || now, days: 0, plan, src: 'stripe', sub: sub.id, cus, cuss: withCus(cur, cus), cancel: live && !!(sub.cancel_at_period_end || sub.cancel_at) };
  await env.LICENSES.put('lic:' + id, JSON.stringify(rec));
}

async function grantLifetime(env, id, s, now) {
  const pi = s.payment_intent, cus = s.customer;
  if (pi) { // never grant for a payment that was refunded or disputed before this (possibly delayed) event was handled
    const p = await sx(env, 'GET', '/payment_intents/' + pi, { expand: ['latest_charge'] });
    const ch = p.latest_charge && typeof p.latest_charge === 'object' ? p.latest_charge : null;
    if (ch && (ch.refunded || ch.disputed)) return;
    if (await env.LICENSES.get('pi:' + pi)) return; // this purchase was already applied (and may since have been moved with /relink)
  }
  id = (cus && await env.LICENSES.get('cus:' + cus)) || id;
  const cur = await getLic(env, id);
  if (cur && cur.sub && cur.exp !== 0) { // Lifetime replaces a subscription (even one in payment recovery): stop it billing again. Any failure other than "already gone / already cancelled" makes Stripe retry this event
    try { await sx(env, 'POST', '/subscriptions/' + cur.sub, { cancel_at_period_end: true }); }
    catch (e) { if (e.code !== 'resource_missing' && e.code !== 'invalid_canceled_subscription_fields') throw e; }
  }
  if (cus) await env.LICENSES.put('cus:' + cus, id);
  const rec = { exp: 0, iat: (cur && cur.iat) || now, days: 0, plan: 'lifetime', src: 'stripe', pi, cus, cuss: withCus(cur, cus), cancel: false };
  await env.LICENSES.put('lic:' + id, JSON.stringify(rec));
  if (pi) await env.LICENSES.put('pi:' + pi, id);
}

// A full refund or a dispute ends access. A partial refund keeps it.
async function revokeFor(env, charge, now, dispute) {
  if (!dispute && !charge.refunded) return;
  if (!charge.customer) return;
  const id = await env.LICENSES.get('cus:' + charge.customer);
  const cur = id && await getLic(env, id);
  if (!cur) return;
  if (cur.exp === 0 && cur.plan === 'lifetime') { if (cur.pi && cur.pi !== charge.payment_intent) return; } // refund of some other purchase
  else if (cur.sub && cur.cus === charge.customer) { try { await sx(env, 'DELETE', '/subscriptions/' + cur.sub); } catch {} } // only if the refund is for the subscription that holds the license now
  else return;
  await env.LICENSES.put('lic:' + id, JSON.stringify({ ...cur, exp: now, cancel: false, ended: dispute ? 'dispute' : 'refund' }));
}

const invoiceSub = inv => inv.subscription || (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription) || null;

async function handleEvent(env, ev, now) {
  const o = ev.data.object;
  switch (ev.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (!o.metadata || o.metadata.app !== 'drivefx') return;
      const id = String(o.client_reference_id || o.metadata.device || '').toUpperCase();
      if (!ID_RE.test(id)) return;
      if (o.mode === 'payment') { if (o.payment_status === 'paid') await grantLifetime(env, id, o, now); }
      else if (o.mode === 'subscription' && o.subscription) await syncSub(env, o.subscription, now, id);
      return;
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': { const s = invoiceSub(o); if (s) await syncSub(env, s, now); return; }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': await syncSub(env, o.id, now); return;
    case 'charge.refunded': await revokeFor(env, o, now, false); return;
    case 'charge.dispute.created': { const ch = await sx(env, 'GET', '/charges/' + o.charge); await revokeFor(env, ch, now, true); return; }
  }
}

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

async function webhook(req, env, now) {
  const raw = await req.text();
  if (!(await verifySig(env, raw, req.headers.get('Stripe-Signature'), now))) return new Response('bad signature', { status: 400 });
  let ev; try { ev = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  if (await env.LICENSES.get('ev:' + ev.id)) return new Response('ok');
  try { await handleEvent(env, ev, now); }
  catch (e) { console.error('webhook', ev.type, ev.id, e.message); return new Response('error', { status: 500 }); } // Stripe retries on 5xx
  await env.LICENSES.put('ev:' + ev.id, '1', { expirationTtl: 7 * 86400 });
  return new Response('ok');
}

// ---- free-trial ledger ----
// A visitor is recognised by two keys: the device ID (lives in the browser, resets when cookies are cleared) and a
// fingerprint of the device together with its network (survives clearing cookies and private windows).
// Usage is the larger of the two, so a fresh ID on the same device and network starts with the time already used.
// Only keyed hashes are stored, never the fingerprint or the address itself.
async function mac(env, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(env.TRIAL_PEPPER || 'drivefx-trial'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
  return Array.from(sig.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
}
const networkOf = ip => ip.includes(':') ? ip.split(':').slice(0, 3).join(':') : ip.split('.').slice(0, 3).join('.'); // IPv4 /24, IPv6 /48

async function trial(req, env, now) {
  let b; try { const t = await req.text(); if (t.length > 2048) throw 0; b = JSON.parse(t); } catch { return json(req, { error: 'bad request' }, 400); }
  const id = String(b && b.id || '').toUpperCase();
  const fp = b && b.fp ? String(b.fp) : '';
  const sent = Number(b && b.used);
  if (!ID_RE.test(id) || (fp && !FP_RE.test(fp)) || !Number.isFinite(sent) || sent < 0) return json(req, { error: 'bad request' }, 400);
  const mine = Math.min(sent, TRIAL_SECONDS + 30);
  const net = networkOf(req.headers.get('CF-Connecting-IP') || 'unknown');

  const kId = 'tr:id:' + await mac(env, 'id:' + id);
  const kDev = fp ? 'tr:dev:' + await mac(env, 'dev:' + fp + '|' + net) : null;
  const [a, d] = await Promise.all([env.LICENSES.get(kId, 'json'), kDev ? env.LICENSES.get(kDev, 'json') : null]);
  const known = Math.max(a ? a.used : 0, d ? d.used : 0);
  const used = Math.max(known, mine);
  const out = { used, limit: TRIAL_SECONDS, left: Math.max(0, TRIAL_SECONDS - used), blocked: false, now };

  // Creating a record (a new device ID, or a new fingerprint for a known ID) is limited per network per day, so scripts cannot
  // mint unlimited fresh trials or fill the store. Records that already exist are never affected by the limit.
  const kNet = 'tr:net:' + await mac(env, 'net:' + net + ':' + Math.floor(now / 86400));
  const wantsNew = !a || (kDev && !d);
  let n = 0, capped = false;
  if (wantsNew) { n = +(await env.LICENSES.get(kNet)) || 0; capped = n >= NEW_TRIALS_PER_NETWORK_DAY; }
  if (capped && !a && !d) return json(req, { ...out, used: TRIAL_SECONDS, left: 0, blocked: true }); // a brand-new visitor from a network over its limit

  const rec = JSON.stringify({ used, at: now }), ttl = { expirationTtl: TRIAL_KEEP_DAYS * 86400 };
  const writes = []; let created = false;
  const store = (key, existing) => {
    if (existing) { if (existing.used < used) writes.push(env.LICENSES.put(key, rec, ttl)); }
    else if (used > 0 && !capped) { writes.push(env.LICENSES.put(key, rec, ttl)); created = true; }
  };
  store(kId, a);
  if (kDev) store(kDev, d);
  if (created) writes.push(env.LICENSES.put(kNet, String(n + 1), { expirationTtl: 2 * 86400 }));
  await Promise.all(writes);
  return json(req, out);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    const now = Math.floor(Date.now() / 1000);

    if (req.method === 'GET' && path === '/status') {
      const id = (url.searchParams.get('id') || '').toUpperCase();
      if (!ID_RE.test(id)) return json(req, { error: 'bad id' }, 400);
      const rec = await getLic(env, id);
      const active = isActive(rec, now);
      return json(req, { active, exp: rec ? rec.exp : 0, plan: rec ? rec.plan || 'manual' : null, manage: !!(rec && (rec.cus || rec.cuss)), cancel: !!(rec && rec.cancel && active), now });
    }

    if (req.method === 'GET' && path === '/prices') return prices(req, env);
    if (req.method === 'GET' && path === '/go') return go(req, env, url, now);
    if (req.method === 'GET' && path === '/thanks') return thanks(url);
    if (req.method === 'POST' && path === '/portal') return portal(req, env);
    if (req.method === 'POST' && path === '/stripe-webhook') return webhook(req, env, now);

    if (req.method === 'POST' && path === '/trial') {
      // Browsers always send Origin on a cross-site POST, so another website cannot make a visitor's browser write into the ledger.
      const o = req.headers.get('Origin');
      if (o && !ORIGINS.includes(o)) return json(req, { error: 'origin not allowed' }, 403);
      return trial(req, env, now);
    }

    if (path === '/grant' || path === '/revoke' || path === '/list' || path === '/find' || path === '/relink') {
      const a = await isAdmin(req, env);
      if (a === 'locked') return json(req, { error: 'Too many wrong attempts. Try again in 15 minutes.' }, 429);
      if (!a) return json(req, { error: 'Wrong password.' }, 401);

      if (req.method === 'GET' && path === '/list') {
        const out = []; let cursor;
        do {
          const r = await env.LICENSES.list({ prefix: 'lic:', cursor });
          for (const k of r.keys) { const v = await env.LICENSES.get(k.name, 'json'); if (v) out.push({ id: k.name.slice(4), ...v }); }
          cursor = r.list_complete ? undefined : r.cursor;
        } while (cursor);
        out.sort((x, y) => y.iat - x.iat);
        return json(req, { items: out, now });
      }

      if (req.method === 'GET' && path === '/find') {
        const email = (url.searchParams.get('email') || '').trim();
        if (!/^[^\s@]+@[^\s@]+$/.test(email)) return json(req, { error: 'Enter the email the customer paid with.' }, 400);
        try {
          const r = await sx(env, 'GET', '/customers', { email, limit: 10 });
          const items = [];
          for (const c of r.data) {
            const id = await env.LICENSES.get('cus:' + c.id);
            if (!id) continue;
            const rec = await getLic(env, id);
            items.push({ id, email: c.email, plan: rec && rec.plan, exp: rec ? rec.exp : null, active: isActive(rec, now) });
          }
          return json(req, { items, now });
        } catch (e) { return json(req, { error: 'Stripe lookup failed: ' + e.message }, 502); }
      }

      if (req.method === 'POST') {
        let b; try { b = await req.json(); } catch { return json(req, { error: 'bad request' }, 400); }
        if (path === '/relink') {
          const from = String(b.from || '').toUpperCase(), to = String(b.to || '').toUpperCase();
          if (!ID_RE.test(from) || !ID_RE.test(to) || from === to) return json(req, { error: 'Both IDs must look like DFX-XXXX-XXXX and differ.' }, 400);
          const rec = await getLic(env, from);
          if (!rec) return json(req, { error: 'The old ID has no license.' }, 404);
          if (isActive(await getLic(env, to), now)) return json(req, { error: 'The new ID is already Pro.' }, 409);
          await env.LICENSES.put('lic:' + to, JSON.stringify(rec));
          for (const c of rec.cuss || (rec.cus ? [rec.cus] : [])) await env.LICENSES.put('cus:' + c, to);
          await env.LICENSES.delete('lic:' + from);
          return json(req, { ok: true, from, to });
        }
        const id = String(b.id || '').toUpperCase();
        if (!ID_RE.test(id)) return json(req, { error: 'ID must look like DFX-XXXX-XXXX.' }, 400);
        if (path === '/revoke') {
          const cur = await getLic(env, id);
          if (cur && cur.sub && env.STRIPE_KEY) { try { await sx(env, 'DELETE', '/subscriptions/' + cur.sub); } catch {} } // stop charging the customer too
          await env.LICENSES.delete('lic:' + id);
          return json(req, { ok: true });
        }
        const days = b.days;
        if (!Number.isInteger(days) || days < 0 || days > 3650) return json(req, { error: 'Bad number of days.' }, 400);
        const cur = await getLic(env, id);
        let exp;
        if (days === 0) exp = 0;
        else if (b.mode === 'extend' && cur && (cur.exp === 0 || cur.exp > now)) exp = cur.exp === 0 ? 0 : cur.exp + days * 86400;
        else exp = now + days * 86400;
        const keep = {}; for (const k of ['cus', 'cuss', 'sub']) if (cur && cur[k]) keep[k] = cur[k]; // an admin grant must not forget who pays: the billing portal, relink and revoke still need these
        const rec = await activate(env, id, days === 0 ? 'lifetime' : 'manual', exp, now, days, keep);
        return json(req, { ok: true, id, ...rec });
      }
    }
    return json(req, { error: 'not found' }, 404);
  },
};
