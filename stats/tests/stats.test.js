import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, describe } from '../server/handler.js';

function memStore() {
  const c = new Map(), h = new Map(), u = new Map(), live = new Map();
  return {
    h, u,
    incr: async k => { const n = (c.get(k) || 0) + 1; c.set(k, n); return n; },
    del: async k => { c.delete(k); },
    addVisitor: async (k, id) => { const s = u.get(k) || new Set(); const isNew = !s.has(id); s.add(id); u.set(k, s); return isNew; },
    hlen: async k => Object.keys(h.get(k) || {}).length,
    hincr: async (k, f, by) => { const o = h.get(k) || {}; o[f] = String((+o[f] || 0) + by); h.set(k, o); },
    live: async (id, now) => { live.set(id, now); },
    liveCount: async now => [...live.values()].filter(t => t > now - 300).length,
    hgetallMany: async keys => keys.map(k => ({ ...(h.get(k) || {}) })),
    countVisitors: async keys => new Set(keys.flatMap(k => [...(u.get(k) || [])])).size,
  };
}
const ENV = { STATS_SALT: 'a-long-random-salt-value-1234', STATS_TOKEN: 'a-long-stats-password', ALLOWED_HOSTS: 'drivefx.pro,www.drivefx.pro' };
const UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const UA_TESLA = 'Mozilla/5.0 (X11; GNU/Linux) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Tesla/2024.44';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function app(env = {}, store = memStore()) {
  const deps = { env: { ...ENV, ...env }, getStore: async () => store };
  const hit = (body, { ua = UA_WIN, ip = '203.0.113.5', origin = 'https://drivefx.pro', country = 'GB', method = 'POST' } = {}) =>
    handle(new Request('https://stats.test/api/collect', { method, headers: { 'user-agent': ua, 'x-vercel-forwarded-for': ip, 'x-vercel-ip-country': country, ...(origin ? { origin } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) }), deps);
  const stats = (token = ENV.STATS_TOKEN, q = 'days=30', ip = '198.51.100.1') =>
    handle(new Request('https://stats.test/api/stats?' + q, { headers: { 'x-stats-token': token, 'x-vercel-forwarded-for': ip } }), deps);
  return { store, hit, stats, deps };
}

test('counts pageviews and unique visitors per day, anonymously', async () => {
  const a = app();
  assert.equal((await a.hit({ p: '/', r: 'https://www.google.com/search?q=x', w: 1920 })).status, 204);
  await a.hit({ p: '/', w: 1920 });                                   // same visitor again: pageview only
  await a.hit({ p: '/terms.html', w: 1920 }, { ip: '203.0.113.77', country: 'DE', ua: UA_IPHONE });
  const d = await (await a.stats()).json();
  assert.equal(d.today.pv, 3); assert.equal(d.today.uv, 2); assert.equal(d.totals.visitors, 2); assert.equal(d.totals.pageviews, 3);
  assert.deepEqual(d.pages[0], ['/', 2]);
  assert.deepEqual(d.referrers, [['google.com', 1]]);
  assert.deepEqual(d.countries.map(x => x[0]).sort(), ['DE', 'GB']);
  assert.ok(d.devices.some(x => x[0] === 'Mobile') && d.devices.some(x => x[0] === 'Desktop'));
  assert.ok(d.os.some(x => x[0] === 'iOS') && d.os.some(x => x[0] === 'Windows'));
  const stored = JSON.stringify([...a.store.h.entries()]) + JSON.stringify([...a.store.u.entries()]);
  assert.ok(!stored.includes('203.0.113') && !stored.includes('Mozilla'), 'no IP or user agent is stored');
});

test('a Tesla browser is recognised', () => {
  assert.deepEqual(describe(UA_TESLA, 1280), { browser: 'Tesla browser', os: 'Tesla', device: 'Tesla screen' });
});

test('events are counted separately and do not inflate pageviews', async () => {
  const a = app();
  await a.hit({ p: '/', w: 1200 });
  await a.hit({ p: '/', n: 'paywall_open' }); await a.hit({ p: '/', n: 'paywall_open' }); await a.hit({ p: '/', n: 'Bad Name!' });
  const d = await (await a.stats()).json();
  assert.equal(d.totals.pageviews, 1); assert.deepEqual(d.events, [['paywall_open', 2]]);
});

test('bots, foreign origins, bad bodies and admin paths are ignored', async () => {
  const a = app();
  await a.hit({ p: '/' }, { ua: 'Googlebot/2.1' }); await a.hit({ p: '/' }, { ua: 'curl/8.0' });
  assert.equal((await a.hit({ p: '/' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await a.hit({ p: '/' }, { origin: null })).status, 403);
  await a.hit('not json'); await a.hit('x'.repeat(2000)); await a.hit({ p: '/admin' }); await a.hit({ p: '/admin/x' });
  const d = await (await a.stats()).json(); assert.equal(d.totals.pageviews, 0);
});

test('paths are cleaned, own site is not a referrer, per-network flood guard', async () => {
  const a = app();
  await a.hit({ p: '/Cars?x=1#top/', r: 'https://drivefx.pro/' }); await a.hit({ p: '//<script>', r: 'https://www.drivefx.pro/x' });
  const d = await (await a.stats()).json();
  assert.ok(d.pages.every(([p]) => /^[A-Za-z0-9/_\-.~%]+$/.test(p))); assert.deepEqual(d.referrers, []);
  for (let i = 0; i < 450; i++) await a.hit({ p: '/f' }, { ip: '192.0.2.9' });
  assert.ok((await (await a.stats()).json()).pages.find(x => x[0] === '/f')[1] <= 400);
});

test('dashboard needs the password; wrong tries are limited; short token disabled', async () => {
  const a = app();
  assert.equal((await a.stats('nope')).status, 401);
  assert.equal((await a.stats('')).status, 401);
  for (let i = 0; i < 8; i++) await a.stats('bad', 'days=30', '10.0.0.1');
  assert.equal((await a.stats(ENV.STATS_TOKEN, 'days=30', '10.0.0.1')).status, 429);
  assert.equal((await app({ STATS_TOKEN: 'short' }).stats('short')).status, 401);
  assert.equal((await app({ STATS_TOKEN: '' }).stats('')).status, 401);
});

test('not configured without salt; unknown routes 404; CORS preflight', async () => {
  assert.equal((await app({ STATS_SALT: '' }).hit({ p: '/' })).status, 503);
  const a = app();
  assert.equal((await handle(new Request('https://stats.test/nothing'), a.deps)).status, 404);
  const o = await handle(new Request('https://stats.test/api/collect', { method: 'OPTIONS', headers: { origin: 'https://drivefx.pro' } }), a.deps);
  assert.equal(o.status, 204); assert.equal(o.headers.get('access-control-allow-origin'), 'https://drivefx.pro');
});

test('range selection returns the requested number of days', async () => {
  const a = app(); await a.hit({ p: '/' });
  for (const [q, n] of [['days=1', 1], ['days=7', 7], ['days=90', 90], ['days=500', 90], ['days=x', 30]]) assert.equal((await (await a.stats(ENV.STATS_TOKEN, q)).json()).series.length, n);
});
