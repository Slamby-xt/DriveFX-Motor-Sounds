import test from 'node:test';
import assert from 'node:assert/strict';
import { app, memoryStore } from './helpers.js';
import { checkIsolation } from '../server/store.js';
import { routeOf, handle } from '../server/handler.js';

const ID = 'DFX-AAAA-0001', ID2 = 'DFX-BBBB-0002';
const now = () => Math.floor(Date.now() / 1000);
const status = async (a, id = ID) => a.j(await a.call('GET', '/status?id=' + id));
const subObj = (o = {}) => ({ id: 'sub_1', status: 'active', customer: 'cus_1', metadata: { app: 'drivefx', device: ID, plan: 'monthly' }, items: { data: [{ current_period_end: now() + 30 * 86400 }] }, ...o });
const checkoutSub = (a, over) => a.event('checkout.session.completed', { mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', client_reference_id: ID, metadata: { app: 'drivefx', device: ID, plan: 'monthly' }, ...over });

test('routing, unknown routes, CORS', async () => {
  const a = app();
  assert.equal(routeOf(new URL('https://x/api?__r=status')), 'status');
  assert.equal(routeOf(new URL('https://x/nope')), '');
  assert.equal((await a.call('GET', '/nope')).status, 404);
  const o = await a.call('OPTIONS', '/status', { origin: 'https://drivefx.pro' });
  assert.equal(o.status, 204); assert.equal(o.headers.get('access-control-allow-origin'), 'https://drivefx.pro');
  const bad = await a.call('GET', '/status?id=DFX-AAAA-0001', { origin: 'https://evil.example' });
  assert.equal(bad.headers.get('access-control-allow-origin'), 'https://drivefx.pro');
});

test('status: unknown id is inactive, bad id rejected', async () => {
  const a = app();
  assert.equal((await status(a)).active, false);
  assert.equal((await status(a, 'nope')).status, 400);
});

test('trial: persists, max wins, fingerprint survives a new id, never decreases', async () => {
  const a = app(); const fp = 'a'.repeat(64);
  let r = await a.j(await a.call('POST', '/trial', { body: { id: ID, fp, used: 100 } }));
  assert.equal(r.used, 100); assert.equal(r.left, 200);
  r = await a.j(await a.call('POST', '/trial', { body: { id: ID, fp, used: 10 } }));
  assert.equal(r.used, 100, 'lower client value must not lower the server value');
  r = await a.j(await a.call('POST', '/trial', { body: { id: ID2, fp, used: 0 } }));
  assert.equal(r.used, 100, 'new id on the same device+network inherits usage');
  r = await a.j(await a.call('POST', '/trial', { body: { id: ID2, fp, used: 999999 } }));
  assert.equal(r.used, 330, 'client value is clamped to the limit + 30');
  assert.ok([...a.store.m.keys()].every(k => !k.includes(ID) && !k.includes(fp)), 'only hashes stored');
});

test('trial: bad input, foreign origin, per-network new-trial cap', async () => {
  const a = app();
  assert.equal((await a.call('POST', '/trial', { body: { id: 'x', used: 1 } })).status, 400);
  assert.equal((await a.call('POST', '/trial', { body: { id: ID, used: 1 }, origin: 'https://evil.example' })).status, 403);
  let blocked = 0;
  for (let i = 0; i < 45; i++) { const r = await a.j(await a.call('POST', '/trial', { body: { id: 'DFX-CAP0-' + String(i).padStart(4, '0'), fp: i.toString(16).padStart(64, '0'), used: 5 }, ip: '198.51.100.7' })); if (r.blocked) blocked++; }
  assert.equal(blocked, 5, '40 allowed per network per day');
  const other = await a.j(await a.call('POST', '/trial', { body: { id: 'DFX-CAP0-9999', used: 5 }, ip: '192.0.2.1' }));
  assert.equal(other.blocked, false);
});

test('trial: concurrent requests cannot beat the network cap', async () => {
  const a = app();
  const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => a.call('POST', '/trial', { body: { id: 'DFX-RACE-' + String(i).padStart(4, '0'), used: 5 }, ip: '198.51.100.9' }).then(a.j)));
  assert.equal(rs.filter(r => !r.blocked).length, 40);
});

test('prices + country currency from Vercel header', async () => {
  const a = app();
  const r = await a.j(await a.call('GET', '/prices', { headers: { 'x-vercel-ip-country': 'DE' } }));
  assert.equal(r.currency, 'eur'); assert.deepEqual(Object.keys(r.plans).sort(), ['lifetime', 'monthly', 'yearly']);
  assert.equal((await a.j(await a.call('GET', '/prices', { headers: { 'x-vercel-ip-country': 'GB' } }))).currency, 'gbp');
  assert.equal((await a.j(await a.call('GET', '/prices'))).currency, 'usd');
});

test('checkout /go validates input, redirects to Stripe, uses own origin on previews', async () => {
  const a = app();
  assert.equal((await a.call('GET', '/go?id=bad&plan=monthly')).status, 400);
  assert.equal((await a.call('GET', '/go?id=' + ID + '&plan=gold')).status, 400);
  for (const plan of ['monthly', 'yearly', 'lifetime']) {
    const r = await a.call('GET', `/go?id=${ID}&plan=${plan}&cur=gbp`);
    assert.equal(r.status, 303); assert.match(r.headers.get('location'), /checkout\.stripe\.test/);
    const call = a.stripe.calls.filter(c => c.p === '/checkout/sessions').pop().body;
    assert.equal(call.mode, plan === 'lifetime' ? 'payment' : 'subscription'); assert.equal(call.currency, 'gbp');
    assert.equal(call['line_items[0][price]'], { monthly: 'price_m', yearly: 'price_y', lifetime: 'price_l' }[plan]);
    assert.equal(call.success_url, 'https://drivefx-test.vercel.app/thanks?id=' + ID);
  }
  await a.call('GET', `/go?id=${ID}&plan=monthly&cur=jpy`);
  assert.equal(a.stripe.calls.filter(c => c.p === '/checkout/sessions').pop().body.currency, 'usd', 'unknown currency falls back');
  const prod = app({ env: { VERCEL_ENV: 'production', DATA_PREFIX: 'prod', STRIPE_KEY: 'sk_live_x' } });
  await prod.call('GET', `/go?id=${ID}&plan=yearly`);
  assert.equal(prod.stripe.calls.filter(c => c.p === '/checkout/sessions').pop().body.success_url, 'https://drivefx.pro/thanks?id=' + ID);
});

test('go rate limit is per client ip', async () => {
  const a = app();
  for (let i = 0; i < 30; i++) await a.call('GET', `/go?id=${ID}&plan=monthly`, { ip: '1.1.1.1' });
  assert.equal((await a.call('GET', `/go?id=${ID}&plan=monthly`, { ip: '1.1.1.1' })).status, 429);
  assert.equal((await a.call('GET', `/go?id=${ID}&plan=monthly`, { ip: '2.2.2.2' })).status, 303);
});

test('thanks page never grants Pro', async () => {
  const a = app();
  const r = await a.call('GET', '/thanks?id=' + ID); assert.equal(r.status, 200);
  assert.equal((await status(a)).active, false);
});

test('webhook: signature required, raw body, replay window', async () => {
  const a = app(); const ev = checkoutSub(a); a.stripe.subs.sub_1 = subObj();
  assert.equal((await a.call('POST', '/stripe-webhook', { raw: JSON.stringify(ev) })).status, 400);
  assert.equal((await a.hook(ev, { secret: 'whsec_other' })).status, 400);
  assert.equal((await a.hook(ev, { tamper: true })).status, 400, 'body altered after signing');
  assert.equal((await a.hook(ev, { t: now() - 1000 })).status, 400, 'too old');
  assert.equal((await status(a)).active, false);
  assert.equal((await a.hook(ev)).status, 200);
  assert.equal((await status(a)).active, true);
});

test('monthly activation, manage flag, renewal extends, cancellation flag, end', async () => {
  const a = app(); const t0 = now();
  a.stripe.subs.sub_1 = subObj();
  await a.hook(checkoutSub(a));
  let s = await status(a); assert.equal(s.active, true); assert.equal(s.plan, 'monthly'); assert.equal(s.manage, true); assert.equal(s.cancel, false);
  assert.ok(s.exp >= t0 + 30 * 86400 + 2 * 86400 - 5);
  const end = t0 + 60 * 86400;
  a.stripe.subs.sub_1 = subObj({ items: { data: [{ current_period_end: end }] } });
  await a.hook(a.event('invoice.paid', { subscription: 'sub_1' }));
  assert.equal((await status(a)).exp, end + 2 * 86400);
  a.stripe.subs.sub_1 = subObj({ items: { data: [{ current_period_end: end }] }, cancel_at_period_end: true });
  await a.hook(a.event('customer.subscription.updated', { id: 'sub_1' }));
  assert.equal((await status(a)).cancel, true); assert.equal((await status(a)).active, true);
  a.stripe.subs.sub_1 = subObj({ status: 'canceled' });
  await a.hook(a.event('customer.subscription.deleted', { id: 'sub_1' }));
  s = await status(a); assert.equal(s.active, false);
});

test('yearly plan recorded; failed payment never extends', async () => {
  const a = app();
  const meta = { app: 'drivefx', device: ID, plan: 'yearly' };
  a.stripe.subs.sub_1 = subObj({ metadata: meta });
  await a.hook(checkoutSub(a, { metadata: meta }));
  const before = await status(a); assert.equal(before.plan, 'yearly');
  a.stripe.subs.sub_1 = subObj({ status: 'past_due', metadata: meta, items: { data: [{ current_period_end: now() + 999 * 86400 }] } });
  await a.hook(a.event('invoice.payment_failed', { parent: { subscription_details: { subscription: 'sub_1' } } }));
  assert.equal((await status(a)).exp, before.exp, 'past_due keeps the old end');
});

test('lifetime purchase replaces subscription, renewals cannot downgrade, duplicate purchase ignored', async () => {
  const a = app();
  a.stripe.subs.sub_1 = subObj(); await a.hook(checkoutSub(a));
  a.stripe.pis.pi_1 = { charge: 'ch_1' }; a.stripe.charges.ch_1 = { id: 'ch_1', refunded: false, disputed: false, customer: 'cus_1', payment_intent: 'pi_1' };
  const life = () => a.event('checkout.session.completed', { mode: 'payment', payment_status: 'paid', payment_intent: 'pi_1', customer: 'cus_1', client_reference_id: ID, metadata: { app: 'drivefx', device: ID, plan: 'lifetime' } });
  await a.hook(life());
  const s = await status(a); assert.equal(s.exp, 0); assert.equal(s.active, true); assert.equal(s.plan, 'lifetime');
  assert.deepEqual(a.stripe.cancelled, ['sub_1'], 'old subscription set to cancel');
  await a.hook(a.event('invoice.paid', { subscription: 'sub_1' }));
  assert.equal((await status(a)).plan, 'lifetime');
  await a.hook(life()); // same payment, new event id
  assert.equal(a.stripe.cancelled.length, 1);
});

test('unpaid / foreign-app / bad-id events change nothing', async () => {
  const a = app();
  await a.hook(a.event('checkout.session.completed', { mode: 'payment', payment_status: 'unpaid', payment_intent: 'pi_9', customer: 'cus_9', client_reference_id: ID, metadata: { app: 'drivefx' } }));
  await a.hook(a.event('checkout.session.completed', { mode: 'payment', payment_status: 'paid', client_reference_id: ID, metadata: { app: 'other' } }));
  await a.hook(a.event('checkout.session.completed', { mode: 'payment', payment_status: 'paid', client_reference_id: 'junk', metadata: { app: 'drivefx' } }));
  assert.equal((await status(a)).active, false);
});

test('refund and dispute end access; partial refund keeps it; refunded-before-grant blocks the grant', async () => {
  const a = app();
  a.stripe.pis.pi_1 = { charge: 'ch_1' }; a.stripe.charges.ch_1 = { id: 'ch_1', refunded: false, disputed: false, customer: 'cus_1', payment_intent: 'pi_1' };
  await a.hook(a.event('checkout.session.completed', { mode: 'payment', payment_status: 'paid', payment_intent: 'pi_1', customer: 'cus_1', client_reference_id: ID, metadata: { app: 'drivefx' } }));
  await a.hook(a.event('charge.refunded', { ...a.stripe.charges.ch_1, refunded: false }));
  assert.equal((await status(a)).active, true, 'partial refund keeps Pro');
  await a.hook(a.event('charge.refunded', { ...a.stripe.charges.ch_1, refunded: true }));
  assert.equal((await status(a)).active, false);
  const b = app(); b.stripe.pis.pi_2 = { charge: 'ch_2' }; b.stripe.charges.ch_2 = { id: 'ch_2', refunded: true, customer: 'cus_2', payment_intent: 'pi_2' };
  await b.hook(b.event('checkout.session.completed', { mode: 'payment', payment_status: 'paid', payment_intent: 'pi_2', customer: 'cus_2', client_reference_id: ID, metadata: { app: 'drivefx' } }));
  assert.equal((await status(b)).active, false);
  const c = app(); c.stripe.subs.sub_1 = subObj(); await c.hook(checkoutSub(c));
  c.stripe.charges.ch_3 = { id: 'ch_3', customer: 'cus_1', payment_intent: 'pi_3' };
  await c.hook(c.event('charge.dispute.created', { charge: 'ch_3' }));
  assert.equal((await status(c)).active, false); assert.deepEqual(c.stripe.deleted, ['sub_1']);
});

test('webhook retries: duplicate ack, failure -> 500 then retry succeeds, concurrent duplicates processed once', async () => {
  const a = app(); a.stripe.subs.sub_1 = subObj(); const ev = checkoutSub(a, {}); ev.id = 'evt_fixed';
  assert.equal((await a.hook(ev)).status, 200);
  const calls = a.stripe.calls.length;
  assert.equal((await a.hook(ev)).status, 200); assert.equal(a.stripe.calls.length, calls, 'duplicate does no work');
  const b = app(); b.stripe.subs.sub_1 = subObj(); const ev2 = checkoutSub(b, {}); ev2.id = 'evt_fail';
  b.stripe.failNext = 'api_error';
  assert.equal((await b.hook(ev2)).status, 500);
  assert.equal((await status(b)).active, false);
  assert.equal((await b.hook(ev2)).status, 200); assert.equal((await status(b)).active, true);
  const c = app(); c.stripe.subs.sub_1 = subObj(); const ev3 = checkoutSub(c, {}); ev3.id = 'evt_par';
  const rs = await Promise.all(Array.from({ length: 8 }, () => c.hook(ev3)));
  assert.ok(rs.every(r => r.status === 200 || r.status === 409));
  assert.equal(c.stripe.calls.filter(x => x.p === '/subscriptions/sub_1').length, 1);
  assert.equal((await status(c)).active, true);
});

test('concurrent different events for one purchase serialise (no double lifetime grant)', async () => {
  const a = app();
  a.stripe.pis.pi_1 = { charge: 'ch_1' }; a.stripe.charges.ch_1 = { id: 'ch_1', customer: 'cus_1', payment_intent: 'pi_1' };
  const mk = () => a.event('checkout.session.completed', { mode: 'payment', payment_status: 'paid', payment_intent: 'pi_1', customer: 'cus_1', client_reference_id: ID, metadata: { app: 'drivefx' } });
  await Promise.all([a.hook(mk()), a.hook(mk()), a.hook(mk())]);
  const recs = [...a.store.m.keys()].filter(k => k.startsWith('lic:'));
  assert.deepEqual(recs, ['lic:' + ID]); assert.equal((await status(a)).plan, 'lifetime');
});

test('out-of-order events: stale "updated" after "deleted" does not resurrect (state is re-read from Stripe)', async () => {
  const a = app(); a.stripe.subs.sub_1 = subObj(); await a.hook(checkoutSub(a));
  a.stripe.subs.sub_1 = subObj({ status: 'canceled' });
  await a.hook(a.event('customer.subscription.deleted', { id: 'sub_1' }));
  await a.hook(a.event('customer.subscription.updated', { id: 'sub_1', status: 'active' }));
  assert.equal((await status(a)).active, false);
});

test('admin: auth, lockout, grant/extend/lifetime/list/revoke/relink', async () => {
  const a = app();
  assert.equal((await a.call('GET', '/list')).status, 401);
  assert.equal((await a.call('GET', '/list', { headers: { 'X-Admin-Token': 'wrong' } })).status, 401);
  const g = await a.admin('POST', '/grant', { id: ID, days: 30 }); assert.equal(g.ok, true); assert.equal(g.plan, 'manual');
  assert.equal((await status(a)).active, true);
  const e0 = (await status(a)).exp; await a.admin('POST', '/grant', { id: ID, days: 10, mode: 'extend' });
  assert.equal((await status(a)).exp, e0 + 10 * 86400);
  assert.equal((await a.admin('POST', '/grant', { id: ID, days: -1 })).status, 400);
  assert.equal((await a.admin('POST', '/grant', { id: 'bad', days: 1 })).status, 400);
  await a.admin('POST', '/grant', { id: ID2, days: 0 }); assert.equal((await status(a, ID2)).exp, 0);
  assert.equal((await a.admin('GET', '/list')).items.length, 2);
  assert.equal((await a.admin('POST', '/relink', { from: ID, to: ID2 })).status, 409);
  const ID3 = 'DFX-CCCC-0003';
  assert.equal((await a.admin('POST', '/relink', { from: ID, to: ID3 })).ok, true);
  assert.equal((await status(a, ID)).active, false); assert.equal((await status(a, ID3)).active, true);
  assert.equal((await a.admin('POST', '/relink', { from: 'DFX-ZZZZ-0000', to: ID })).status, 404);
  assert.equal((await a.admin('POST', '/revoke', { id: ID3 })).ok, true); assert.equal((await status(a, ID3)).active, false);
  const b = app();
  for (let i = 0; i < 8; i++) await b.call('GET', '/list', { headers: { 'X-Admin-Token': 'x' } });
  assert.equal((await b.call('GET', '/list', { headers: { 'X-Admin-Token': b.env.ADMIN_TOKEN } })).status, 429);
  const c = app(); for (let i = 0; i < 5; i++) await c.call('GET', '/list', { headers: { 'X-Admin-Token': 'x' } });
  assert.equal((await c.admin('GET', '/list')).status, 200);
});

test('admin relink keeps billing links; later renewals land on the new ID; revoke cancels the subscription', async () => {
  const a = app(); a.stripe.subs.sub_1 = subObj(); await a.hook(checkoutSub(a));
  await a.admin('POST', '/grant', { id: ID, days: 5 });
  const rec = JSON.parse(await a.store.get('lic:' + ID)); assert.equal(rec.cus, 'cus_1'); assert.equal(rec.sub, 'sub_1');
  await a.admin('POST', '/relink', { from: ID, to: ID2 });
  assert.equal(await a.store.get('cus:cus_1'), ID2);
  await a.hook(a.event('invoice.paid', { subscription: 'sub_1' }));
  assert.equal((await status(a, ID2)).active, true); assert.equal((await status(a, ID)).active, false);
  await a.admin('POST', '/revoke', { id: ID2 }); assert.deepEqual(a.stripe.deleted, ['sub_1']);
  a.stripe.customers.push({ id: 'cus_1', email: 'a@b.co' });
  const f = await a.admin('GET', '/find?email=a@b.co'); assert.equal(f.status, 200);
});

test('persistence across "restarts": a new handler instance over the same store sees the data', async () => {
  const store = memoryStore(); const a = app({ store });
  await a.admin('POST', '/grant', { id: ID, days: 0 });
  await a.call('POST', '/trial', { body: { id: ID2, used: 50 } });
  const b = app({ store });
  assert.equal((await status(b)).active, true);
  assert.equal((await b.j(await b.call('POST', '/trial', { body: { id: ID2, used: 0 } }))).used, 50);
});

test('storage isolation guards', () => {
  assert.throws(() => checkIsolation({}), /DATA_PREFIX/);
  assert.throws(() => checkIsolation({ DATA_PREFIX: 'sandbox', STRIPE_KEY: 'sk_live_x' }), /live Stripe/);
  assert.throws(() => checkIsolation({ DATA_PREFIX: 'prod', STRIPE_KEY: 'rk_test_x' }), /test Stripe/);
  assert.throws(() => checkIsolation({ DATA_PREFIX: 'prod', VERCEL_ENV: 'preview' }), /must not use the prod/);
  assert.throws(() => checkIsolation({ DATA_PREFIX: 'sandbox', VERCEL_ENV: 'production' }), /production/);
  assert.equal(checkIsolation({ DATA_PREFIX: 'prod', VERCEL_ENV: 'production', STRIPE_KEY: 'rk_live_x' }), 'prod');
});

test('misconfigured storage fails closed with 503 and no detail in the body', async () => {
  const a = app();
  const r = await handle(new Request('https://x.test/status?id=' + ID), { env: a.env, getStore: async () => { throw new Error('secret-detail'); } });
  assert.equal(r.status, 503); assert.ok(!(await r.text()).includes('secret-detail'));
});

test('portal returns the Stripe login page, rejects foreign origins', async () => {
  const a = app();
  assert.equal((await a.j(await a.call('POST', '/portal', { origin: 'https://drivefx.pro' }))).url, 'https://billing.stripe.test/login');
  assert.equal((await a.call('POST', '/portal', { origin: 'https://evil.example' })).status, 403);
});

test('admin limiter: per network, global failure cap, short token refused', async () => {
  const a = app();
  for (let i = 0; i < 8; i++) await a.call('GET', '/list', { headers: { 'X-Admin-Token': 'x' }, ip: '203.0.113.10' });
  assert.equal((await a.call('GET', '/list', { headers: { 'X-Admin-Token': 'x' }, ip: '203.0.113.99' })).status, 429, 'same /24 shares the budget');
  const g = app();
  for (let i = 0; i < 100; i++) await g.call('GET', '/list', { headers: { 'X-Admin-Token': 'x' }, ip: `10.${i % 250}.${i}.1` });
  assert.equal((await g.call('GET', '/list', { headers: { 'X-Admin-Token': g.env.ADMIN_TOKEN }, ip: '172.16.5.5' })).status, 429, 'global cap');
  const s = app({ env: { ADMIN_TOKEN: 'short' } });
  assert.equal((await s.call('GET', '/list', { headers: { 'X-Admin-Token': 'short' } })).status, 401);
});
