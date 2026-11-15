// DriveFX license server — Cloudflare Worker + KV.
//   GET  /status?id=DFX-XXXX-XXXX      public: is this device subscribed? -> { active, exp, plan }
//   POST /trial   {id, fp, used}        public: free-trial ledger kept on the server, so clearing cookies does not reset it
//   POST /grant   {id, days, mode}      admin:  days=0 means lifetime; mode "extend" adds time to an active subscription
//   POST /revoke  {id}                  admin
//   GET  /list                          admin
// Admin calls need the header  X-Admin-Token: <ADMIN_TOKEN secret>.
// Optional secret TRIAL_PEPPER (wrangler secret put TRIAL_PEPPER): mixed into every hash stored for the trial ledger.
//
// Payments: when Stripe is connected, its webhook handler calls activate(env, id, plan, exp) below; nothing else changes.
const ID_RE = /^DFX-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const FP_RE = /^[a-f0-9]{64}$/;
const PLANS = ['monthly', 'yearly', 'lifetime', 'manual'];
const TRIAL_SECONDS = 5 * 60;          // free engine time per device (keep equal to TRIAL_SECONDS in paywall.js)
const NEW_TRIALS_PER_NETWORK_DAY = 40; // brand-new trial identities accepted per network per day (stops scripted resets)
const TRIAL_KEEP_DAYS = 400;           // how long a trial record is remembered
const ORIGINS = ['https://drivefx.pro', 'https://www.drivefx.pro', 'http://localhost:5173', 'http://127.0.0.1:5173'];

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

// Give a device a license. exp = unix seconds when it ends, 0 = lifetime. The only place that writes a license record.
async function activate(env, id, plan, exp, now = Math.floor(Date.now() / 1000), days = 0) {
  const rec = { exp, iat: now, days, plan: PLANS.includes(plan) ? plan : 'manual' };
  await env.LICENSES.put('lic:' + id, JSON.stringify(rec));
  return rec;
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
      const rec = await env.LICENSES.get('lic:' + id, 'json');
      const active = !!rec && (rec.exp === 0 || rec.exp > now);
      return json(req, { active, exp: rec ? rec.exp : 0, plan: rec ? rec.plan || 'manual' : null, now });
    }

    if (req.method === 'POST' && path === '/trial') {
      // Browsers always send Origin on a cross-site POST, so another website cannot make a visitor's browser write into the ledger.
      const o = req.headers.get('Origin');
      if (o && !ORIGINS.includes(o)) return json(req, { error: 'origin not allowed' }, 403);
      return trial(req, env, now);
    }

    if (path === '/grant' || path === '/revoke' || path === '/list') {
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

      if (req.method === 'POST') {
        let b; try { b = await req.json(); } catch { return json(req, { error: 'bad request' }, 400); }
        const id = String(b.id || '').toUpperCase();
        if (!ID_RE.test(id)) return json(req, { error: 'ID must look like DFX-XXXX-XXXX.' }, 400);
        if (path === '/revoke') { await env.LICENSES.delete('lic:' + id); return json(req, { ok: true }); }
        const days = b.days;
        if (!Number.isInteger(days) || days < 0 || days > 3650) return json(req, { error: 'Bad number of days.' }, 400);
        const cur = await env.LICENSES.get('lic:' + id, 'json');
        let exp;
        if (days === 0) exp = 0;
        else if (b.mode === 'extend' && cur && (cur.exp === 0 || cur.exp > now)) exp = cur.exp === 0 ? 0 : cur.exp + days * 86400;
        else exp = now + days * 86400;
        const rec = await activate(env, id, days === 0 ? 'lifetime' : 'manual', exp, now, days);
        return json(req, { ok: true, id, ...rec });
      }
    }
    return json(req, { error: 'not found' }, 404);
  },
};
