import { createHash, createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { deviceMetadata, finishBilling, ID_RE, isActive, stripeBuyerDetails, webhook } from './payments.js';
import { getPrices, PLANS, stripeDiagnostic, sx } from './stripe.js';
import { checkIsolation } from './store.js';

// DriveFX license server for Vercel (Node.js Functions) and Neon Postgres.
//   GET  /status?id=DFX-XXXX-XXXX      public: is this device subscribed? -> { active, exp, plan, manage, cancel }
//   POST /trial   {id, fp, used}        public: free-trial ledger kept on the server, so clearing cookies does not reset it
//   GET  /prices                        public: Stripe plan prices and the currency assigned to this visitor's country
//   GET  /go?id=&plan=                 public: creates a Stripe Checkout session and redirects to it (also what the QR code opens)
//   GET  /thanks?id=                    public: page shown after Checkout (never grants anything)
//   POST /portal                        public: address of Stripe's billing portal login page
//   GET  /internal/cleanup            Vercel Cron -> us (Bearer CRON_SECRET)
//   POST /stripe-webhook                Stripe -> us (signature checked on the raw body)
//   POST /admin/session signs in with X-Admin-Token, GET extends the session, DELETE signs out.
//   POST /grant {id, days, mode} | POST /revoke {id} | GET /list | GET /find?email= | POST /relink {from, to}   admin session or X-Admin-Token
//   POST /admin/buyers {ids}          admin only: Stripe billing snapshots for a page of paid licenses
// Server-only environment variables: see .env.example.
//
const FP_RE = /^[a-f0-9]{64}$/;
const TRIAL_SECONDS = 5 * 60;          // keep equal to TRIAL_SECONDS in paywall.js
const NEW_TRIALS_PER_NETWORK_DAY = 40;
const TRIAL_KEEP_DAYS = 400;
const ADMIN_SESSION = '__Secure-drivefx-admin';
const ADMIN_ACTIONS = new Set(['grant', 'revoke', 'list', 'find', 'relink', 'buyers']);
const BUYER_BATCH_SIZE = 10;
const ADMIN_IDLE_SECONDS = 10 * 60;
const SITE = 'https://drivefx.pro';
const ORIGINS = [SITE, 'https://www.drivefx.pro', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000'];

const EURO = new Set('AT BE BG HR CY EE FI FR DE GR IE IT LV LT LU MT NL PT SK SI ES AD MC SM VA ME XK'.split(' '));
const currencyFor = c => c === 'GB' || c === 'IM' || c === 'JE' || c === 'GG' ? 'gbp' : EURO.has(c) ? 'eur' : 'usd';

// ---- Vercel platform headers (set by Vercel's edge, a client cannot forge them) ----
const clientIp = req => req.headers.get('x-vercel-forwarded-for')?.trim() || '';
const countryOf = req => (req.headers.get('x-vercel-ip-country') || '').toUpperCase();
const selfOrigin = (req, env) => env.VERCEL_ENV === 'production' ? SITE : new URL(req.url).origin; // production always uses the canonical host; previews/local use their own
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

const getLic = (c, id) => c.store.get('lic:' + id);
const putLic = (c, id, rec) => c.store.set('lic:' + id, rec);
const mutateLicense = (c, fn) => c.store.transaction('license', store => fn({ ...c, store }));

async function checkAdminPassword(c) {
  const password = c.req.headers.get('X-Admin-Token');
  if (!password) return false;
  const key = rateKey(c, 'admin');
  if (await c.store.incr(key, 900) > 8) return 'locked';
  const ok = c.env.ADMIN_TOKEN?.length >= 14 && await same(password, c.env.ADMIN_TOKEN);
  if (ok) await c.store.del(key);
  return ok;
}

function sameAdminOrigin(c) {
  const origin = c.req.headers.get('Origin');
  const site = c.req.headers.get('Sec-Fetch-Site');
  return (!origin || origin === new URL(c.req.url).origin) && (!site || site === 'same-origin');
}

function adminSessionKey(c, token) {
  // Tying the lookup key to the current password invalidates sessions on password rotation.
  return c.env.ADMIN_TOKEN?.length >= 14 && /^[A-Za-z0-9_-]{43}$/.test(token || '')
    ? 'lease:admin-session:' + createHmac('sha256', c.env.ADMIN_TOKEN).update(token).digest('hex')
    : null;
}

function requestSessionKey(c) {
  const cookie = c.req.headers.get('Cookie')?.split(';').map(pair => pair.trim())
    .find(pair => pair.startsWith(ADMIN_SESSION + '='));
  return adminSessionKey(c, cookie?.slice(ADMIN_SESSION.length + 1));
}

async function resumeAdminSession(c) {
  const key = requestSessionKey(c);
  return key && await c.store.touch(key, ADMIN_IDLE_SECONDS);
}

function badAdminPassword(c, result) {
  return result === 'locked'
    ? json(c, { error: 'Too many wrong attempts. Try again in 15 minutes.' }, 429)
    : json(c, { error: 'Wrong password.' }, 401);
}

function sessionResponse(c, token) {
  const response = json(c, { ok: true });
  response.headers.set('Set-Cookie', `${ADMIN_SESSION}=${token}; Path=/admin; Secure; HttpOnly; SameSite=Strict${token ? '' : '; Max-Age=0'}`);
  return response;
}

async function adminSession(c) {
  if (!sameAdminOrigin(c)) return json(c, { error: 'Forbidden.' }, 403);
  if (c.req.method === 'GET') {
    return await resumeAdminSession(c)
      ? json(c, { ok: true })
      : json(c, { error: 'Please sign in again.' }, 401);
  }
  if (c.req.method === 'POST') {
    const auth = await checkAdminPassword(c);
    if (auth !== true) return badAdminPassword(c, auth);
    const old = requestSessionKey(c);
    const token = randomBytes(32).toString('base64url');
    await c.store.set(adminSessionKey(c, token), true, { ex: ADMIN_IDLE_SECONDS });
    if (old) await c.store.del(old);
    return sessionResponse(c, token);
  }
  if (c.req.method === 'DELETE') {
    const key = requestSessionKey(c);
    if (key) await c.store.del(key);
    return sessionResponse(c, '');
  }
  return json(c, { error: 'method not allowed' }, 405);
}

function rateKey(c, name) {
  return `rl:${name}:${mac(c.env, 'rate:' + networkOf(clientIp(c.req)))}`;
}

// ---- checkout ----
async function prices(c) {
  if (!checkoutEnabled(c.env)) return json(c, { error: 'prices unavailable' }, 503);
  try {
    const p = await getPrices(c);
    const plans = {}; for (const k of Object.keys(p)) plans[k] = p[k].amounts;
    const country = countryOf(c.req);
    return json(c, { currency: currencyFor(country), country, plans });
  } catch (error) {
    console.error('DriveFX prices unavailable', stripeDiagnostic(error));
    return json(c, { error: 'prices unavailable' }, 503);
  }
}

function checkoutEnabled(env) {
  if (env.CHECKOUT_ENABLED !== '1') return false;
  if (env.DATA_PREFIX !== 'prod') return true;
  return env.VERCEL_ENV === 'production'
    && env.MANAGED_PAYMENTS_COUNTRY_GATE_VERIFIED === '1'
    && env.TERMS_CONSENT === '1';
}

const unavailable = () => page('DriveFX', '<h1>Payments are temporarily unavailable</h1><p>Please try again in a few minutes.</p>', 503);
const PROCESSING = '<h1>Payment confirmation pending</h1><p>Open DriveFX to check your Pro status.</p>';

const CHECKOUT_TTL = 2700;
const MIN_CREATE_TIME = 31 * 60;
const CHECKOUT_RETRY_DELAY = 30;
const stripeSessionId = id => typeof id === 'string' && /^cs_[a-zA-Z0-9_]{1,252}$/.test(id);
const currentTime = () => Math.floor(Date.now() / 1000);
const newCheckoutAttempt = now => ({ token: crypto.randomUUID(), expires: now + CHECKOUT_TTL });

async function createCheckoutSession(c, params, attempt) {
  const waits = [150, 300, 600, 900];
  for (let i = 0; ; i++) {
    if (attempt.expires - currentTime() < MIN_CREATE_TIME) {
      console.warn('DriveFX checkout session rejected', { reason: 'insufficient-create-window' });
      return null;
    }
    try {
      const session = await sx(c, 'POST', '/checkout/sessions', { ...params, expires_at: attempt.expires }, attempt.token);
      if (stripeSessionId(session.id) && session.expires_at === attempt.expires) return session.id;
      console.warn('DriveFX checkout session rejected', { reason: 'create-response' });
      return null;
    } catch (error) {
      if (error.code !== 'idempotency_key_in_use' || i === waits.length) throw error;
      await new Promise(resolve => setTimeout(resolve, waits[i]));
    }
  }
}

async function checkoutSession(c, params, now) {
  // Compatible browser and QR attempts share persisted parameters and a
  // Stripe idempotency key. A saved session must exist before any redirect.
  const fingerprint = createHash('sha256').update(JSON.stringify(params)).digest('hex');
  const key = 'checkout:' + fingerprint;
  await c.store.set(key, newCheckoutAttempt(now), { nx: true, ex: CHECKOUT_TTL });
  for (let i = 0; i < 4; i++) {
    const attempt = await c.store.get(key);
    if (!attempt) return null;
    let sessionId = attempt.session;
    if (!sessionId) {
      const time = currentTime();
      if (attempt.retryAt > time) return null;
      if (attempt.retryAt || attempt.expires - time < MIN_CREATE_TIME) {
        // No browser has been sent to this attempt. Safely start a fresh
        // window even if a superseded Stripe request is still in flight.
        await c.store.updateUnexposedCheckout(key, attempt, newCheckoutAttempt(time), CHECKOUT_TTL);
        continue;
      }
      try {
        sessionId = await createCheckoutSession(c, params, attempt);
      } catch (error) {
        if (!(error.status >= 500)) throw error;
        // Stripe can cache a 5xx. Rotate once with the same expiry, then
        // pause before allowing a fresh window if the second key also fails.
        if (attempt.recovered) {
          const paused = { ...attempt, retryAt: currentTime() + CHECKOUT_RETRY_DELAY };
          await c.store.updateUnexposedCheckout(key, attempt, paused);
          throw error;
        }
        const retry = { ...attempt, token: crypto.randomUUID(), recovered: true };
        if (await c.store.updateUnexposedCheckout(key, attempt, retry)) {
          console.warn('DriveFX recovering checkout create', stripeDiagnostic(error));
        }
        continue;
      }
      if (!sessionId) {
        if (attempt.expires - currentTime() < MIN_CREATE_TIME) continue;
        return null;
      }
      if (!(await c.store.attachSession(key, attempt.token, sessionId))) continue;
    }
    const current = await sx(c, 'GET', '/checkout/sessions/' + sessionId);
    const fence = await c.store.get(key);
    if (fence?.token !== attempt.token || fence.session !== sessionId || attempt.expires <= currentTime()
        || current.id !== sessionId || current.expires_at !== attempt.expires) {
      console.warn('DriveFX checkout session rejected', { reason: 'stale-session' });
      return null;
    }
    return current;
  }
  console.warn('DriveFX checkout session rejected', { reason: 'attempt-changed' });
  return null;
}

function hostedCheckoutUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://checkout.stripe.com' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function reviewCheckoutPrice(id, plan, currency, amount) {
  const price = new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount / 100);
  const next = new URLSearchParams({ id, plan, expected_currency: currency });
  return page('Review your DriveFX price', `<h1>Review your price</h1><p>Your current network is in a different pricing region. The price for your ${esc(PLANS[plan].name)} plan is <strong>${esc(price)}</strong>. Stripe will show the final total before you pay.</p><p><a href="/go?${esc(next)}">Continue to Stripe</a></p>`);
}

async function go(c, url, now) {
  const id = (url.searchParams.get('id') || '').toUpperCase();
  const plan = url.searchParams.get('plan') || '';
  if (!ID_RE.test(id) || !Object.hasOwn(PLANS, plan)) return page('DriveFX', '<h1>Link not valid</h1><p>Open DriveFX and choose a plan again.</p>', 400);
  if (!checkoutEnabled(c.env)) return page('DriveFX', '<h1>DriveFX sales are paused</h1><p>Existing customers can still manage their plan in DriveFX.</p>', 503);
  if (await c.store.incr(rateKey(c, 'go'), 3600) > 30) return page('DriveFX', '<h1>Too many attempts</h1><p>Please try again in a little while.</p>', 429);
  const cur = currencyFor(countryOf(c.req));

  const rec = await getLic(c, id);
  if (isActive(rec, now) && (rec.exp === 0 || plan !== 'lifetime')) {
    return page('DriveFX', `<h1>Already Pro</h1><p>${esc(id)} already has Pro${rec.exp ? ' until ' + new Date(rec.exp * 1000).toISOString().slice(0, 10) : ' for life'}. To change or cancel a plan, open DriveFX and tap Manage.</p>`);
  }
  try {
    const price = (await getPrices(c))[plan];
    // The expected currency only guards the displayed quote. The payer's network sets the price.
    const expected = url.searchParams.get('expected_currency');
    if (expected && expected !== cur) return reviewCheckoutPrice(id, plan, cur, price.amounts[cur]);
    const sub = plan !== 'lifetime';
    const desc = `${PLANS[plan].name} · ID ${id}`;
    const metadata = deviceMetadata(id, plan, price.id, cur, price.amounts[cur]);
    const self = selfOrigin(c.req, c.env);
    const p = {
      mode: sub ? 'subscription' : 'payment',
      line_items: [{ price: price.id, quantity: 1 }],
      currency: cur,
      managed_payments: { enabled: true },
      client_reference_id: id,
      metadata,
      success_url: `${self}/thanks?id=${id}`,
      cancel_url: `${self}/thanks?id=${id}&c=1`,
      locale: 'auto',
      ...(sub ? { subscription_data: { description: desc, metadata } }
        : { customer_creation: 'always', payment_intent_data: { description: desc, metadata } }),
    };
    if (c.env.TERMS_CONSENT === '1') {
      p.consent_collection = { terms_of_service: 'required' };
    }

    const session = await checkoutSession(c, p, now);
    if (session?.status === 'complete') return page('DriveFX', PROCESSING);
    if (!session) return unavailable();
    if (session.status !== 'open' || !hostedCheckoutUrl(session.url)) {
      console.warn('DriveFX checkout redirect rejected', { reason: session.status === 'open' ? 'unexpected-host' : 'session-not-open' });
      return unavailable();
    }
    return new Response(null, { status: 303, headers: {
      Location: session.url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    } });
  } catch (error) {
    console.error('DriveFX checkout could not be started', stripeDiagnostic(error));
    return unavailable();
  }
}

function thanks(c, url) {
  const id = (url.searchParams.get('id') || '').toUpperCase(), ok = ID_RE.test(id), cancelled = url.searchParams.get('c') === '1';
  const home = selfOrigin(c.req, c.env) + '/';
  if (cancelled) return page('DriveFX', `<h1>Checkout closed</h1><p>You returned from checkout before payment confirmation.</p><p><a href="${esc(home)}">Back to DriveFX</a></p>`);
  return page('DriveFX', `<h1>Thank you!</h1><p>DriveFX unlocks when Stripe confirms your payment. You can close this page.</p>${ok ? `<p>Your DriveFX ID<br><b class="id">${esc(id)}</b></p><p style="font-size:14px">Save this ID to restore Pro if you clear your browser data.</p>` : ''}<p><a href="${esc(home)}">Back to DriveFX</a></p>`);
}

let portalCache = null;
async function portal(c) { // Stripe's own login page for the billing portal: it emails the customer a sign-in link
  const o = c.req.headers.get('Origin');
  if (o && !allowedOrigin(c.req, o, c.env)) return json(c, { error: 'origin not allowed' }, 403);
  try {
    if (c.env.STRIPE_PORTAL_MODE === 'link') return json(c, { url: 'https://app.link.com/' });
    if (!portalCache || portalCache.key !== c.env.STRIPE_KEY || Date.now() - portalCache.at > 3600000) {
      const r = await sx(c, 'GET', '/billing_portal/configurations', { active: true, limit: 20 });
      const cf = r.data.find(x => x.metadata && x.metadata.app === 'drivefx' && x.login_page && x.login_page.enabled && x.login_page.url);
      if (!cf) return json(c, { error: 'Billing is not available right now.' }, 503);
      portalCache = { at: Date.now(), url: cf.login_page.url, key: c.env.STRIPE_KEY };
    }
    return json(c, { url: portalCache.url });
  } catch (error) { console.error('DriveFX billing portal could not be loaded', stripeDiagnostic(error)); return json(c, { error: 'Billing is not available right now.' }, 502); }
}

// ---- free-trial ledger ----
// A visitor is recognised by two keys: the device ID and a fingerprint of the device together with its network. Usage is the larger of the two.
// Only keyed hashes are stored. New records per network per day are capped (atomic counter) so scripts cannot mint unlimited trials.
function mac(env, value) {
  if (!env.TRIAL_PEPPER || env.TRIAL_PEPPER.length < 32) throw new Error('trial pepper is not configured');
  return createHmac('sha256', env.TRIAL_PEPPER).update(value).digest('hex').slice(0, 32);
}

function networkOf(ip) {
  if (isIP(ip) === 4) return ip.split('.').slice(0, 3).join('.');
  if (isIP(ip) !== 6) return 'unknown';
  // Normalize compressed IPv6 and IPv4-mapped IPv6 before taking a prefix.
  const normal = new URL('http://[' + ip + ']/').hostname.slice(1, -1);
  const mapped = normal.match(/^::ffff:([a-f0-9]+):([a-f0-9]+)$/);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return [high >> 8, high & 255, low >> 8].join('.');
  }
  const [before, after] = normal.split('::');
  const left = before ? before.split(':') : [], right = after ? after.split(':') : [];
  const zeros = after === undefined ? [] : Array(8 - left.length - right.length).fill('0');
  return [...left, ...zeros, ...right].slice(0, 3).join(':');
}

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

  const kId = 'tr:id:' + mac(c.env, 'id:' + id);
  const kDev = fp ? 'tr:dev:' + mac(c.env, 'dev:' + fp + '|' + net) : null;
  const kNet = 'tr:net:' + mac(c.env, 'net:' + net + ':' + Math.floor(now / 86400));

  return c.store.transaction([kNet, kId, ...(kDev ? [kDev] : [])], async store => {
    const a = await store.get(kId);
    const d = kDev ? await store.get(kDev) : null;
    const used = Math.max(a?.used || 0, d?.used || 0, mine);
    const out = { used, limit: TRIAL_SECONDS, left: Math.max(0, TRIAL_SECONDS - used), blocked: false, now };

    let capped = false;
    if (!a || (kDev && !d)) {
      capped = used > 0
        ? await store.incr(kNet, 2 * 86400) > NEW_TRIALS_PER_NETWORK_DAY
        : (await store.get(kNet) || 0) >= NEW_TRIALS_PER_NETWORK_DAY;
    }
    if (capped && !a && !d) return json(c, { ...out, used: TRIAL_SECONDS, left: 0, blocked: true });

    const rec = { used, at: now }, ttl = TRIAL_KEEP_DAYS * 86400;
    // Both paths write the common device key first. ON CONFLICT retains the
    // larger value even when the same ID checks in over different networks.
    if (a || (used > 0 && !capped)) await store.putMax(kId, used, rec, ttl);
    if (kDev && (d || (used > 0 && !capped))) await store.putMax(kDev, used, rec, ttl);
    return json(c, out);
  });
}

// ---- main router ----
const ROUTES = new Set(['status', 'prices', 'go', 'thanks', 'portal', 'trial', 'admin-session', ...ADMIN_ACTIONS, 'stripe-webhook', 'cleanup']);

export function routeOf(url) {
  const r = url.searchParams.get('__r');                       // set by the rewrites in vercel.json
  if (r && ROUTES.has(r)) return r;
  const p = url.pathname.replace(/^\/+|\/+$/g, '');
  if (p === 'admin/session') return 'admin-session';
  if (p.startsWith('admin/')) {
    const action = p.slice('admin/'.length);
    return ADMIN_ACTIONS.has(action) ? action : '';
  }
  return ROUTES.has(p) ? p : '';
}

export async function handle(req, deps) {
  const env = deps.env, url = new URL(req.url);
  const c0 = { req, env, fetch: deps.fetch || fetch, store: null };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, env) });
  const route = routeOf(url);
  if (!route) return json(c0, { error: 'not found' }, 404);
  const now = Math.floor(Date.now() / 1000);
  if (route === 'cleanup') {
    if (req.method !== 'GET') return json(c0, { error: 'method not allowed' }, 405);
    const secret = env.CRON_SECRET;
    if (!secret || secret.length < 32 || !await same(req.headers.get('Authorization') || '', `Bearer ${secret}`)) {
      return json(c0, { error: 'unauthorized' }, 401);
    }
  }
  if (route === 'thanks' && req.method === 'GET') return thanks(c0, url); // needs no storage
  let c;
  try {
    checkIsolation(env);
    if (req.method === 'GET' && route === 'prices') return await prices(c0);
    if (req.method === 'POST' && route === 'portal') return await portal(c0);
    c = { ...c0, store: await deps.getStore(env) };
  } catch {
    console.error('DriveFX server configuration unavailable');
    return json(c0, { error: 'server not configured' }, 503);
  }
  try {
    if (req.method === 'GET' && route === 'status') {
      const id = (url.searchParams.get('id') || '').toUpperCase();
      if (!ID_RE.test(id)) return json(c, { error: 'bad id' }, 400);
      const rec = await getLic(c, id);
      const active = isActive(rec, now);
      return json(c, { active, exp: rec ? rec.exp : 0, plan: rec ? rec.plan || 'manual' : null, manage: !!(rec && (rec.cus || rec.cuss)), cancel: !!(rec && rec.cancel && active), now });
    }
    if (route === 'cleanup') return json(c, { deleted: await c.store.purgeExpired() });
    if (req.method === 'GET' && route === 'go') return await go(c, url, now);
    if (req.method === 'POST' && route === 'stripe-webhook') return await webhook(c, now);
    if (req.method === 'POST' && route === 'trial') return await trial(c, now);

    if (route === 'admin-session') return await adminSession(c);
    if (ADMIN_ACTIONS.has(route)) {
      if (req.headers.has('X-Admin-Token')) {
        const auth = await checkAdminPassword(c);
        if (auth !== true) return badAdminPassword(c, auth);
      } else {
        if (!sameAdminOrigin(c)) return json(c, { error: 'Forbidden.' }, 403);
        if (!await resumeAdminSession(c)) return json(c, { error: 'Please sign in again.' }, 401);
      }

      if (req.method === 'GET' && route === 'list') {
        const out = await c.store.licenses();
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
            for (const id of await c.store.customerDevices(cu.id)) {
              const rec = await getLic(c, id);
              items.push({ id, email: cu.email, plan: rec && rec.plan, exp: rec ? rec.exp : null, active: isActive(rec, now) });
            }
          }
          return json(c, { items, now });
        } catch (error) {
          console.error('DriveFX customer lookup failed', stripeDiagnostic(error));
          return json(c, { error: 'Stripe lookup failed.' }, 502);
        }
      }

      if (req.method === 'POST') {
        let b; try { b = await req.json(); if (!b || typeof b !== 'object') throw new Error('invalid body'); } catch { return json(c, { error: 'bad request' }, 400); }
        if (route === 'buyers') {
          if (!Array.isArray(b.ids) || b.ids.length > BUYER_BATCH_SIZE
              || !b.ids.every(id => typeof id === 'string' && ID_RE.test(id))) {
            return json(c, { error: 'Enter up to 10 DriveFX IDs.' }, 400);
          }
          const entries = await Promise.all([...new Set(b.ids)].map(async id => {
            try {
              return [id, await stripeBuyerDetails(c, id)];
            } catch (error) {
              console.error('DriveFX buyer details lookup failed', stripeDiagnostic(error));
              return [id, { unavailable: true }];
            }
          }));
          return json(c, { buyers: Object.fromEntries(entries) });
        }
        if (route === 'relink') {
          const from = String(b.from || '').toUpperCase(), to = String(b.to || '').toUpperCase();
          if (!ID_RE.test(from) || !ID_RE.test(to) || from === to) return json(c, { error: 'Both IDs must look like DFX-XXXX-XXXX and differ.' }, 400);
          return await mutateLicense(c, async c => {
            const rec = await getLic(c, from);
            if (!rec) return json(c, { error: 'The old ID has no license.' }, 404);
            if (isActive(await getLic(c, to), now)) return json(c, { error: 'The new ID is already Pro.' }, 409);
            await putLic(c, to, rec);
            await c.store.moveMappings(from, to);
            await c.store.del('lic:' + from);
            return json(c, { ok: true, from, to });
          });
        }
        const id = String(b.id || '').toUpperCase();
        if (!ID_RE.test(id)) return json(c, { error: 'ID must look like DFX-XXXX-XXXX.' }, 400);
        if (route === 'revoke') {
          const job = 'billing:admin:' + id;
          await finishBilling(c, job);
          await mutateLicense(c, async c => {
            const cur = await getLic(c, id);
            if (cur?.sub) {
              const p = await c.store.get('sub:' + cur.sub);
              if (p) await c.store.set('sub:' + cur.sub, { ...p, revoked: true, revision: crypto.randomUUID() });
              if (c.env.STRIPE_KEY) await c.store.set(job, { sub: cur.sub, operation: 'cancel', queuedAt: now });
            }
            await c.store.del('lic:' + id);
          });
          await finishBilling(c, job);
          return json(c, { ok: true });
        }
        const days = b.days;
        if (!Number.isInteger(days) || days < 0 || days > 3650) return json(c, { error: 'Bad number of days.' }, 400);
        return await mutateLicense(c, async c => {
          const cur = await getLic(c, id);
          let exp;
          if (days === 0) exp = 0;
          else if (b.mode === 'extend' && cur && (cur.exp === 0 || cur.exp > now)) exp = cur.exp === 0 ? 0 : cur.exp + days * 86400;
          else exp = now + days * 86400;
          const keep = {}; for (const k of ['cus', 'cuss', 'sub']) if (cur && cur[k]) keep[k] = cur[k];
          const rec = { exp, iat: now, days, plan: days === 0 ? 'lifetime' : 'manual', ...keep };
          await putLic(c, id, rec);
          return json(c, { ok: true, id, ...rec });
        });
      }
    }
    return json(c, { error: 'not found' }, 404);
  } catch (error) {
    console.error('DriveFX request failed', { route, ...stripeDiagnostic(error) });
    return json(c, { error: 'server error' }, 500);
  }
}
