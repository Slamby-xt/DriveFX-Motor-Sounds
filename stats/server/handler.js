// DriveFX Stats: privacy-friendly visitor analytics (no cookies, no IP addresses stored, no fingerprinting).
//   POST /collect   {p: path, r: referrer, w: screen width, n: optional event name}   sent by public/t.js from the tracked website
//   GET  /stats?days=30   dashboard data, needs header  X-Stats-Token: <STATS_TOKEN>
// A visitor is only a one-way hash of (secret salt + UTC day + IP + user agent): it changes every day, cannot be reversed and is kept
// inside a HyperLogLog counter, so nobody can be followed across days and no list of visitors exists.
// Env (server-only): STATS_TOKEN (dashboard password, 14+ chars), STATS_SALT (random secret), ALLOWED_HOSTS (comma list, default drivefx.pro),
//                    Redis: KV_REST_API_URL + KV_REST_API_TOKEN (Vercel Upstash integration). Keys are prefixed "stats:".
const DAY_TTL = 400 * 86400;
const MAX_FIELDS = 3000;                 // per day hash: stops junk paths/referrers from growing the store
const BOT = /bot|crawl|spider|slurp|headless|phantom|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|preview|monitor|lighthouse|facebookexternalhit|whatsapp|telegram|discord|embedly|vercel/i;

const ymd = t => new Date(t * 1000).toISOString().slice(0, 10);
const clientIp = req => req.headers.get('x-vercel-forwarded-for') || req.headers.get('x-real-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'x';
const networkOf = ip => ip.includes(':') ? ip.split(':').slice(0, 3).join(':') : ip.split('.').slice(0, 3).join('.');

async function sha(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(d.slice(0, 12), b => b.toString(16).padStart(2, '0')).join('');
}
async function same(a, b) { // constant-time compare
  const [x, y] = await Promise.all([sha(a), sha(b)]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0 && a.length === b.length;
}

const hosts = env => (env.ALLOWED_HOSTS || 'drivefx.pro,www.drivefx.pro').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const hostOf = u => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const originAllowed = (req, env) => { const o = req.headers.get('origin') || req.headers.get('referer') || ''; return !!o && hosts(env).includes(hostOf(o)); };
const corsFor = (req, env) => { const o = req.headers.get('origin'); return { 'Access-Control-Allow-Origin': o && hosts(env).includes(hostOf(o)) ? o : 'null', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Stats-Token', 'Vary': 'Origin' }; };
const json = (req, env, obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsFor(req, env) } });

// ---- user agent -> coarse labels ----
export function describe(ua, width) {
  let browser = 'Other';
  if (/Tesla\//i.test(ua)) browser = 'Tesla browser';
  else if (/Edg\//.test(ua)) browser = 'Edge'; else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet'; else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS/.test(ua)) browser = 'Chrome'; else if (/Safari\//.test(ua)) browser = 'Safari';
  let os = 'Other';
  if (/Tesla\//i.test(ua)) os = 'Tesla'; else if (/Windows/.test(ua)) os = 'Windows'; else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS'; else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS'; else if (/CrOS/.test(ua)) os = 'ChromeOS'; else if (/Linux/.test(ua)) os = 'Linux';
  const w = Number(width) || 0;
  const device = /Tesla\//i.test(ua) ? 'Tesla screen' : /Mobi|iPhone|Android.*Mobile/.test(ua) || (w && w < 700) ? 'Mobile' : /iPad|Tablet|Android/.test(ua) || (w && w < 1100) ? 'Tablet' : 'Desktop';
  return { browser, os, device };
}

function cleanPath(p) {
  p = String(p || '/').split('?')[0].split('#')[0].slice(0, 80);
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/[^A-Za-z0-9/_\-.~%]/g, '');
  return p.length > 1 ? p.replace(/\/+$/, '') : '/';
}

async function collect(c, now) {
  const { req, env, store } = c;
  const empty = () => new Response(null, { status: 204, headers: corsFor(req, env) });
  if (!originAllowed(req, env)) return json(req, env, { error: 'origin not allowed' }, 403);
  const ua = req.headers.get('user-agent') || '';
  if (!ua || BOT.test(ua)) return empty();                                     // bots and previews are not visitors
  let b; try { const t = await req.text(); if (t.length > 1024) return empty(); b = JSON.parse(t); } catch { return empty(); }
  if (!b || typeof b !== 'object') return empty();

  const ip = clientIp(req);
  if ((await store.incr('rl:' + await sha(env.STATS_SALT + networkOf(ip)), 3600)) > 400) return empty(); // flood guard per network and hour

  const day = ymd(now), key = 'd:' + day;
  const path = cleanPath(b.p);
  if (path.startsWith('/admin')) return empty();                               // the owner's admin pages are not tracked
  const f = {};
  if (b.n !== undefined && !(typeof b.n === 'string' && /^[a-z0-9_]{1,30}$/.test(b.n))) return empty(); // a malformed event is dropped, never counted as a pageview
  const eventName = b.n || '';
  const visitor = await sha(`${env.STATS_SALT}|${day}|${ip}|${ua}`);
  const { browser, os, device } = describe(ua, b.w);
  const ref = (() => { const h = hostOf(String(b.r || '').slice(0, 300)).replace(/^www\./, ''); return h && !hosts(env).includes(h) && !hosts(env).includes('www.' + h) ? h.slice(0, 60) : ''; })();
  const country = (req.headers.get('x-vercel-ip-country') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || '??';
  const hour = String(new Date(now * 1000).getUTCHours()).padStart(2, '0');

  if (eventName) { f['e:' + eventName] = 1; }
  else {
    f.pv = 1; f['h:' + hour] = 1; f['dev:' + device] = 1; f['b:' + browser] = 1; f['os:' + os] = 1; f['c:' + country] = 1; f['p:' + path] = 1;
    if (ref) f['r:' + ref] = 1;
  }
  const isNew = await store.addVisitor('u:' + day, visitor, DAY_TTL);          // HyperLogLog: unique visitors today
  if (isNew && !eventName) f.uv = 1;
  const full = (await store.hlen(key)) > MAX_FIELDS;
  for (const [k, v] of Object.entries(f)) {
    if (full && !(k === 'pv' || k === 'uv' || k.startsWith('h:'))) continue;
    await store.hincr(key, k, v, DAY_TTL);
  }
  if (!eventName) await store.live(visitor, now);
  return empty();
}

const num = v => Number(v) || 0;
function topOf(sum, prefix, limit = 10) {
  return Object.entries(sum).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

async function stats(c, url, now) {
  const { req, env, store } = c;
  const rk = 'rla:' + await sha(env.STATS_SALT + networkOf(clientIp(req)));
  if ((await store.incr(rk, 900)) > 8) return json(req, env, { error: 'Too many attempts. Try again in 15 minutes.' }, 429);
  const tok = req.headers.get('x-stats-token') || '';
  if (!env.STATS_TOKEN || env.STATS_TOKEN.length < 14 || !(await same(tok, env.STATS_TOKEN))) return json(req, env, { error: 'Wrong password.' }, 401);
  await store.del(rk);

  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10) || 30));
  const dates = Array.from({ length: days }, (_, i) => ymd(now - (days - 1 - i) * 86400));
  const rows = await store.hgetallMany(dates.map(d => 'd:' + d));
  const series = dates.map((d, i) => ({ date: d, pv: num(rows[i].pv), uv: num(rows[i].uv) }));
  const sum = {};
  for (const r of rows) for (const [k, v] of Object.entries(r)) sum[k] = (sum[k] || 0) + num(v);
  const unique = await store.countVisitors(dates.map(d => 'u:' + d));
  const today = series[series.length - 1];
  return json(req, env, {
    days, series, today,
    totals: { pageviews: sum.pv || 0, visitors: unique, dailyVisitorSum: sum.uv || 0 },
    pages: topOf(sum, 'p:'), referrers: topOf(sum, 'r:'), countries: topOf(sum, 'c:', 15), devices: topOf(sum, 'dev:'), browsers: topOf(sum, 'b:'), os: topOf(sum, 'os:'),
    events: topOf(sum, 'e:', 20), hours: Array.from({ length: 24 }, (_, h) => num(sum['h:' + String(h).padStart(2, '0')])),
    live: await store.liveCount(now), now,
  });
}

export async function handle(req, deps) {
  const env = deps.env, url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsFor(req, env) });
  const route = url.searchParams.get('__r') || url.pathname.replace(/^\/+|\/+$/g, '').replace(/^api\//, '');
  const now = Math.floor(Date.now() / 1000);
  if (!env.STATS_SALT || env.STATS_SALT.length < 16) return json(req, env, { error: 'not configured' }, 503);
  let store; try { store = await deps.getStore(env); } catch { return json(req, env, { error: 'not configured' }, 503); }
  const c = { req, env, store };
  try {
    if (req.method === 'POST' && route === 'collect') return await collect(c, now);
    if (req.method === 'GET' && route === 'stats') return await stats(c, url, now);
    return json(req, env, { error: 'not found' }, 404);
  } catch (e) { console.error('stats error', route, e && e.message); return json(req, env, { error: 'server error' }, 500); }
}
