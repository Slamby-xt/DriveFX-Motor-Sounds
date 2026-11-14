// DriveFX license server — Cloudflare Worker + KV.
//   GET  /status?id=DFX-XXXX-XXXX      public: is this device subscribed?
//   POST /grant   {id, days, mode}      admin:  days=0 means lifetime; mode "extend" adds time to an active subscription
//   POST /revoke  {id}                  admin
//   GET  /list                          admin
// Admin calls need the header  X-Admin-Token: <ADMIN_TOKEN secret>.
const ID_RE = /^DFX-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
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
      return json(req, { active, exp: rec ? rec.exp : 0, now });
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
        const rec = { exp, iat: now, days };
        await env.LICENSES.put('lic:' + id, JSON.stringify(rec));
        return json(req, { ok: true, id, ...rec });
      }
    }
    return json(req, { error: 'not found' }, 404);
  },
};
