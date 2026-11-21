import test from 'node:test';
import assert from 'node:assert/strict';
import { app, fakeStripe, lifetimeEvent, memoryStore, testMetadata } from './helpers.js';
import { checkIsolation } from '../server/store.js';
import { routeOf, handle } from '../server/handler.js';

const ID = 'DFX-AAAA-0001', ID2 = 'DFX-BBBB-0002';
const now = () => Math.floor(Date.now() / 1000);
const status = async (a, id = ID) => a.j(await a.call('GET', '/status?id=' + id));
const subObj = (o = {}) => {
  const sub = { id: 'sub_1', status: 'active', customer: 'cus_1', currency: 'usd', created: now(), metadata: testMetadata(ID, 'monthly'), ...o };
  const data = o.items?.data || [{ current_period_end: now() + 30 * 86400 }];
  return { ...sub, items: { data: data.map(item => ({ price: { id: sub.metadata.price }, quantity: 1, ...item })) } };
};
const checkoutSub = (a, over) => a.event('checkout.session.completed', {
  mode: 'subscription', payment_status: 'paid', subscription: 'sub_1', customer: 'cus_1',
  client_reference_id: ID, metadata: testMetadata(ID, 'monthly'), ...over,
});

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
    assert.equal(r.status, 303); assert.match(r.headers.get('location'), /checkout\.stripe\.com/);
    const call = a.stripe.calls.filter(c => c.p === '/checkout/sessions').pop().body;
    assert.equal(call.mode, plan === 'lifetime' ? 'payment' : 'subscription'); assert.equal(call.currency, 'gbp');
    assert.equal(call['line_items[0][price]'], { monthly: 'price_m', yearly: 'price_y', lifetime: 'price_l' }[plan]);
    assert.equal(call.success_url, 'https://drivefx-test.vercel.app/thanks?id=' + ID);
  }
  await a.call('GET', `/go?id=${ID}&plan=monthly&cur=jpy`);
  assert.equal(a.stripe.calls.filter(c => c.p === '/checkout/sessions').pop().body.currency, 'usd', 'unknown currency falls back');
  const prod = app({ env: { VERCEL_ENV: 'production', DATA_PREFIX: 'prod', STRIPE_KEY: 'sk_live_x', MANAGED_PAYMENTS_COUNTRY_GATE_VERIFIED: '1' } });
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
  const meta = testMetadata(ID, 'yearly');
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
  const life = () => lifetimeEvent(a, 'pi_1', 'cus_1');
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
  await a.hook(lifetimeEvent(a, 'pi_1', 'cus_1'));
  await a.hook(a.event('charge.refunded', { ...a.stripe.charges.ch_1, refunded: false }));
  assert.equal((await status(a)).active, true, 'partial refund keeps Pro');
  await a.hook(a.event('charge.refunded', { ...a.stripe.charges.ch_1, refunded: true }));
  assert.equal((await status(a)).active, false);
  const b = app(); b.stripe.pis.pi_2 = { charge: 'ch_2' }; b.stripe.charges.ch_2 = { id: 'ch_2', refunded: true, customer: 'cus_2', payment_intent: 'pi_2' };
  await b.hook(lifetimeEvent(b, 'pi_2', 'cus_2'));
  assert.equal((await status(b)).active, false);
  const c = app(); c.stripe.subs.sub_1 = subObj({ invoicePayment: 'pi_3' }); await c.hook(checkoutSub(c));
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
  const mk = () => lifetimeEvent(a, 'pi_1', 'cus_1');
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
  const rec = await a.store.get('lic:' + ID); assert.equal(rec.cus, 'cus_1'); assert.equal(rec.sub, 'sub_1');
  await a.admin('POST', '/relink', { from: ID, to: ID2 });
  assert.deepEqual(await a.store.customerDevices('cus_1'), [ID2]);
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
  const link = app({ env: { STRIPE_PORTAL_MODE: 'link', STRIPE_KEY: undefined } });
  assert.equal((await link.j(await link.call('POST', '/portal'))).url, 'https://app.link.com/');
  assert.equal(link.stripe.calls.length, 0);
});

test('admin limiter: per network, no global lockout, short token refused', async () => {
  const a = app();
  for (let i = 0; i < 8; i++) await a.call('GET', '/list', { headers: { 'X-Admin-Token': 'x' }, ip: '203.0.113.10' });
  assert.equal((await a.call('GET', '/list', { headers: { 'X-Admin-Token': 'x' }, ip: '203.0.113.99' })).status, 429, 'same /24 shares the budget');
  const g = app();
  for (let i = 0; i < 120; i++) await g.call('GET', '/list', { headers: { 'X-Admin-Token': 'x' }, ip: `10.${i % 250}.${i}.1` });
  assert.equal((await g.call('GET', '/list', { headers: { 'X-Admin-Token': g.env.ADMIN_TOKEN }, ip: '172.16.5.5' })).status, 200, 'anonymous failures elsewhere never lock out the real admin');
  const s = app({ env: { ADMIN_TOKEN: 'short' } });
  assert.equal((await s.call('GET', '/list', { headers: { 'X-Admin-Token': 'short' } })).status, 401);
});

test('checkout requires explicit enablement and production country verification', async () => {
  const request = '/go?id=' + ID + '&plan=monthly';
  const paused = app({ env: { CHECKOUT_ENABLED: undefined } });
  assert.equal((await paused.call('GET', request)).status, 503);
  assert.equal((await paused.call('GET', '/prices')).status, 503);
  assert.equal((await paused.call('POST', '/portal')).status, 200);
  assert.equal((await paused.admin('POST', '/grant', { id: ID, days: 30 })).status, 200);
  assert.equal((await status(paused)).active, true);
  paused.stripe.subs.sub_1 = subObj({ metadata: testMetadata(ID2, 'monthly') });
  assert.equal((await paused.hook(paused.event('invoice.paid', { subscription: 'sub_1' }))).status, 200);
  assert.equal((await status(paused, ID2)).active, true);
  assert.ok(!paused.stripe.calls.some(x => x.p.startsWith('/checkout/sessions')));

  const prod = app({ env: { VERCEL_ENV: 'production', DATA_PREFIX: 'prod', STRIPE_KEY: 'sk_live_x', CHECKOUT_ENABLED: '1' } });
  assert.match(await (await prod.call('GET', request)).text(), /sales are paused/);
  assert.equal(prod.stripe.calls.length, 0);
});

test('catalogue verifies all nine inclusive amounts and Checkout uses the Managed Payments fields', async () => {
  const a = app({ env: { STRIPE_KEY: 'sk_test_price_parity', TERMS_CONSENT: '1', TAX: '1' } });
  const catalog = await a.j(await a.call('GET', '/prices'));
  assert.deepEqual(catalog.plans, {
    monthly: { usd: 299, eur: 299, gbp: 299 },
    yearly: { usd: 2999, eur: 2999, gbp: 2999 },
    lifetime: { usd: 4999, eur: 4999, gbp: 4999 },
  });
  for (const plan of Object.keys(catalog.plans)) {
    for (const currency of ['usd', 'eur', 'gbp']) {
      const r = await a.call('GET', `/go?id=${ID}&plan=${plan}&cur=${currency}`);
      assert.equal(r.status, 303);
      const body = a.stripe.calls.filter(x => x.method === 'POST').at(-1).body;
      assert.equal(body.currency, currency);
      assert.equal(body['managed_payments[enabled]'], 'true');
      assert.equal(body['consent_collection[terms_of_service]'], 'required');
      assert.equal(body['metadata[device]'], ID);
      const nested = plan === 'lifetime' ? 'payment_intent_data' : 'subscription_data';
      assert.equal(body[`${nested}[metadata][integration]`], 'managed_v1');
      assert.ok(!Object.keys(body).some(k => /^(automatic_tax|adaptive_pricing|invoice_creation|payment_method_types)/.test(k)));
    }
  }
  const bad = app({ env: { STRIPE_KEY: 'sk_test_wrong_price' } });
  bad.stripe.prices[1].currency_options.eur.tax_behavior = 'exclusive';
  assert.equal((await bad.call('GET', '/prices')).status, 503);
  assert.equal((await bad.call('GET', `/go?id=${ID}&plan=yearly&cur=eur`)).status, 503);
  assert.ok(!bad.stripe.calls.some(x => x.method === 'POST'));
});

test('browser and phone share one compatible open session, including parallel requests and completion', async () => {
  const a = app();
  const path = `/go?id=${ID}&plan=lifetime&cur=gbp`;
  const [browser, phone] = await Promise.all([
    a.call('GET', path, { ip: '203.0.113.9' }),
    a.call('GET', path, { ip: '198.51.100.11' }),
  ]);
  assert.equal(browser.status, 303);
  assert.equal(browser.headers.get('location'), phone.headers.get('location'));
  assert.equal(browser.headers.get('cache-control'), 'no-store');
  assert.equal(Object.keys(a.stripe.sessions).length, 1);
  a.stripe.sessions.cs_0.status = 'complete';
  const pending = await a.call('GET', path);
  assert.match(await pending.text(), /confirmation pending/);
  assert.equal(Object.keys(a.stripe.sessions).length, 1);
});

test('webhook rejects the wrong or missing Stripe mode and malformed signature timestamps', async () => {
  const a = app();
  const event = checkoutSub(a);
  assert.equal((await a.hook({ ...event, livemode: true })).status, 400);
  assert.equal((await a.hook({ ...event, livemode: undefined })).status, 400);
  assert.equal((await a.hook(event, { t: 'NaN' })).status, 400);
  assert.equal((await a.hook(event, { t: now() + 301 })).status, 400);
  assert.equal(a.stripe.calls.length, 0);
});

test('an active subscription without an actual paid eligible invoice does not create or extend Pro', async () => {
  const a = app();
  a.stripe.subs.sub_1 = subObj({ latest_invoice: null });
  assert.equal((await a.hook(checkoutSub(a))).status, 500);
  assert.equal((await status(a)).active, false);
  a.stripe.subs.sub_1 = subObj();
  await a.hook(a.event('invoice.paid', { subscription: 'sub_1' }));
  const before = await status(a);
  assert.equal(before.active, true);
  const sub = subObj({ items: { data: [{ current_period_end: now() + 60 * 86400 }] } });
  a.stripe.subs.sub_1 = { ...sub, latest_invoice: { id: 'in_open', status: 'open', amount_paid: 0 } };
  await a.hook(a.event('invoice.payment_failed', { subscription: 'sub_1' }));
  assert.equal((await status(a)).exp, before.exp);
});

test('refunds correlate to the funding invoice and device even with one Stripe customer', async () => {
  const a = app();
  const oldEnd = now() + 30 * 86400, newEnd = now() + 60 * 86400;
  a.stripe.subs.sub_1 = subObj({ invoicePayment: 'pi_old', items: { data: [{ current_period_end: oldEnd }] } });
  await a.hook(checkoutSub(a));
  a.stripe.subs.sub_1 = subObj({ invoicePayment: 'pi_renewal', items: { data: [{ current_period_end: newEnd }] } });
  await a.hook(a.event('invoice.paid', { subscription: 'sub_1' }));
  a.stripe.subs.sub_2 = subObj({ id: 'sub_2', metadata: testMetadata(ID2, 'monthly'), invoicePayment: 'pi_other' });
  await a.hook(a.event('invoice.paid', { subscription: 'sub_2' }));
  for (const id of ['pi_old', 'pi_unknown']) {
    await a.hook(a.event('charge.refunded', { id: 'ch_' + id, customer: 'cus_1', payment_intent: id, refunded: true }));
    assert.equal((await status(a)).exp, newEnd + 2 * 86400);
  }
  await a.hook(a.event('charge.refunded', { id: 'ch_renewal', customer: 'cus_1', payment_intent: 'pi_renewal', refunded: true }));
  assert.equal((await status(a)).active, false);
  assert.equal((await status(a, ID2)).active, true);
  assert.deepEqual(a.stripe.deleted, ['sub_1']);
  a.stripe.customers.push({ id: 'cus_1', email: 'test@example.invalid' });
  const found = await a.admin('GET', '/find?email=test@example.invalid');
  assert.deepEqual(found.items.map(item => item.id).sort(), [ID, ID2]);
});

test('reversal before the invoice webhook prevents a later grant', async () => {
  const a = app();
  a.stripe.subs.sub_1 = subObj({ invoicePayment: 'pi_early' });
  a.stripe.charges.ch_early = { id: 'ch_early', payment_intent: 'pi_early', customer: 'cus_1' };
  await a.hook(a.event('charge.dispute.created', { charge: 'ch_early' }));
  await a.hook(a.event('invoice.paid', { subscription: 'sub_1' }));
  assert.equal((await status(a)).active, false);
  assert.deepEqual(a.stripe.deleted, ['sub_1']);
});

test('a temporary billing failure leaves Lifetime and the billing action durable, and retry completes cancellation', async () => {
  const a = app();
  a.stripe.subs.sub_1 = subObj();
  await a.hook(checkoutSub(a));
  a.stripe.pis.pi_upgrade = { charge: 'ch_upgrade' };
  a.stripe.charges.ch_upgrade = { id: 'ch_upgrade', customer: 'cus_1', payment_intent: 'pi_upgrade' };
  const ev = lifetimeEvent(a, 'pi_upgrade');
  a.stripe.failBilling = true;
  assert.equal((await a.hook(ev)).status, 500);
  assert.equal((await status(a)).plan, 'lifetime');
  assert.equal(await a.store.get('ev:' + ev.id), true);
  const job = await a.store.get('billing:' + ev.id);
  assert.equal(job.sub, 'sub_1');
  assert.equal(job.operation, 'period_end');
  assert.ok(Number.isInteger(job.queuedAt));
  a.stripe.failBilling = false;
  await a.store.del('ev:' + ev.id); // The durable job outlives the event marker.
  assert.equal((await a.hook(ev)).status, 200);
  assert.deepEqual(a.stripe.cancelled, ['sub_1']);
  assert.equal(await a.store.get('billing:' + ev.id), null);
  const updates = a.stripe.calls.filter(call => call.method === 'POST' && call.p === '/subscriptions/sub_1');
  assert.equal(updates.length, 2);
  assert.ok(updates.every(call => !call.headers['Idempotency-Key']));
});

test('parallel updates store the maximum trial usage and group normalized IPv6 traffic', async () => {
  const a = app();
  await Promise.all([21, 144, 40, 100].map((used, i) => a.call('POST', '/trial', {
    body: { id: ID, used }, ip: `198.51.${i}.1`,
  })));
  const r = await a.j(await a.call('POST', '/trial', { body: { id: ID, used: 0 } }));
  assert.equal(r.used, 144);
  const results = await Promise.all(Array.from({ length: 9 }, (_, i) => a.call('GET', '/list', {
    headers: { 'X-Admin-Token': 'wrong', 'x-forwarded-for': '192.0.2.' + i },
    ip: i % 2 ? '2001:0db8:0000:ffff::3' : '2001:db8::a',
  })));
  assert.equal(results.filter(result => result.status === 429).length, 1);
  assert.ok([...a.store.m.keys()].filter(k => k.startsWith('rl:')).every(k => /^rl:[^:]+:[a-f0-9]{32}$/.test(k)));
});

test('an old refund delivered ahead of the renewal event preserves the newly paid period', async () => {
  const a = app();
  a.stripe.subs.sub_1 = subObj({ invoicePayment: 'pi_previous' });
  await a.hook(checkoutSub(a));
  const end = now() + 60 * 86400;
  a.stripe.subs.sub_1 = subObj({ invoicePayment: 'pi_current', items: { data: [{ current_period_end: end }] } });
  const result = await a.hook(a.event('charge.refunded', {
    id: 'ch_previous', customer: 'cus_1', payment_intent: 'pi_previous', refunded: true,
  }));
  assert.equal(result.status, 200);
  assert.equal((await status(a)).exp, end + 2 * 86400);
  assert.deepEqual(a.stripe.deleted, []);
});

test('a subscription snapshot overtaken by another delivery retries without rolling back paid access', async () => {
  const a = app();
  a.stripe.subs.sub_1 = subObj();
  await a.hook(checkoutSub(a));
  const staleEnd = now() + 45 * 86400;
  const freshEnd = now() + 60 * 86400;
  a.stripe.subs.sub_1 = subObj({ items: { data: [{ current_period_end: staleEnd }] } });
  let release, captured;
  const waiting = new Promise(r => { release = r; });
  const started = new Promise(r => { captured = r; });
  const fetch = a.stripe.fetch;
  let block = true;
  a.stripe.fetch = async (url, init) => {
    const r = await fetch(url, init);
    if (new URL(url).pathname === '/v1/invoice_payments' && block) {
      block = false;
      captured();
      await waiting;
    }
    return r;
  };
  // Use another handler over the same store so it sees the wrapped Stripe fetch.
  const b = app({ store: a.store, stripe: a.stripe });
  const stale = b.event('invoice.paid', { subscription: 'sub_1' });
  const old = b.hook(stale);
  await started;
  try {
    a.stripe.subs.sub_1 = subObj({ items: { data: [{ current_period_end: freshEnd }] } });
    assert.equal((await b.hook(b.event('invoice.paid', { subscription: 'sub_1' }))).status, 200);
  } finally {
    release();
  }
  assert.equal((await old).status, 500);
  assert.equal(await b.store.get('ev:' + stale.id), null);
  assert.equal((await status(b)).exp, freshEnd + 2 * 86400);
  assert.equal((await b.hook(stale)).status, 200);
});

test('a concurrent renewal and Lifetime purchase settle on Lifetime', async () => {
  const a = app();
  a.stripe.subs.sub_1 = subObj();
  await a.hook(checkoutSub(a));
  a.stripe.pis.pi_parallel = { charge: 'ch_parallel' };
  a.stripe.charges.ch_parallel = { id: 'ch_parallel', customer: 'cus_1', payment_intent: 'pi_parallel' };
  a.stripe.subs.sub_1 = subObj({ items: { data: [{ current_period_end: now() + 60 * 86400 }] } });
  const results = await Promise.all([
    a.hook(a.event('invoice.paid', { subscription: 'sub_1' })),
    a.hook(lifetimeEvent(a, 'pi_parallel')),
  ]);
  assert.ok(results.every(r => r.status === 200));
  assert.equal((await status(a)).plan, 'lifetime');
  assert.equal((await status(a)).exp, 0);
  assert.ok(a.stripe.cancelled.includes('sub_1'));
});

test('Lifetime validates Stripe line items and integration amounts while allowing separate Adaptive Pricing presentment', async t => {
  const rejected = t.mock.method(console, 'warn', () => {});
  const a = app();
  const metadata = testMetadata(ID, 'lifetime', 'price_l', 'gbp');
  const presentment_details = { presentment_amount: 6719, presentment_currency: 'cad' };
  a.stripe.pis.pi_adaptive = { charge: 'ch_adaptive', metadata, currency: 'gbp', presentment_details };
  a.stripe.charges.ch_adaptive = { id: 'ch_adaptive', payment_intent: 'pi_adaptive', customer: 'cus_1' };
  const event = lifetimeEvent(a, 'pi_adaptive', 'cus_1', ID, {
    metadata, session: { presentment_details }, type: 'checkout.session.async_payment_succeeded',
  });
  const session = a.stripe.sessions.cs_paid_pi_adaptive;
  session.line_items.data[0].price.id = 'price_other';
  assert.equal((await a.hook(event)).status, 200);
  assert.equal((await status(a)).active, false);
  assert.deepEqual(rejected.mock.calls[0].arguments[1], {
    event: event.id, type: event.type, reason: 'checkout-price',
  });
  session.line_items.data[0].price.id = 'price_l';
  assert.equal((await a.hook({ ...event, id: 'evt_adaptive_ok' })).status, 200);
  assert.equal((await status(a)).plan, 'lifetime');
  const request = a.stripe.calls.find(call => call.p === '/checkout/sessions/cs_paid_pi_adaptive');
  assert.equal(request.query.get('expand[0]'), 'line_items');
});

test('missing authentic paid Checkout data retries and foreign payments make no Stripe requests', async t => {
  const diagnostics = t.mock.method(console, 'error', () => {});
  const a = app();
  const ev = lifetimeEvent(a, 'pi_pending');
  a.stripe.pis.pi_pending = { charge: 'ch_pending' };
  const session = a.stripe.sessions.cs_paid_pi_pending;
  delete a.stripe.sessions.cs_paid_pi_pending;
  assert.equal((await a.hook(ev)).status, 500);
  assert.equal(await a.store.get('ev:' + ev.id), null);
  a.stripe.sessions.cs_paid_pi_pending = { ...session, line_items: undefined };
  assert.equal((await a.hook(ev)).status, 500);
  assert.equal(diagnostics.mock.calls.at(-1).arguments[1].reason, 'checkout-details-pending');
  a.stripe.sessions.cs_paid_pi_pending = session;
  a.stripe.charges.ch_pending = { id: 'ch_pending', payment_intent: 'pi_pending', customer: 'cus_1' };
  assert.equal((await a.hook(ev)).status, 200);
  assert.equal((await status(a)).active, true);
  const calls = a.stripe.calls.length;
  const foreign = a.event(ev.type, { ...ev.data.object, metadata: { app: 'foreign' } });
  assert.equal((await a.hook(foreign)).status, 200);
  assert.equal(a.stripe.calls.length, calls);
});

test('the paid subscription keeps its bound price after lookup rotation and unrelated catalogue drift', async () => {
  const a = app({ env: { STRIPE_KEY: 'sk_test_price_rotation' } });
  a.stripe.subs.sub_1 = subObj();
  assert.equal((await a.hook(checkoutSub(a))).status, 200);
  assert.equal((await a.store.get('sub:sub_1')).price, 'price_m');
  assert.equal((await status(a)).active, true);
  a.stripe.prices[0].id = 'price_rotated';
  a.stripe.prices[1].currency_options.eur.tax_behavior = 'exclusive';
  assert.equal((await a.call('GET', '/prices')).status, 503);
  const end = now() + 60 * 86400;
  a.stripe.subs.sub_1 = subObj({ items: { data: [{ current_period_end: end }] } });
  const paid = a.event('invoice.paid', { subscription: 'sub_1' });
  assert.equal((await a.hook(paid)).status, 200);
  assert.equal((await status(a)).exp, end + 2 * 86400);
  assert.equal(a.stripe.calls.filter(x => x.p === '/prices').length, 1, 'only the explicit catalogue request reads the current prices');
  a.stripe.subs.sub_1 = subObj({ items: { data: [{ current_period_end: end + 86400, price: { id: 'price_rotated' } }] } });
  assert.equal((await a.hook({ ...paid, id: 'evt_unbound_price' })).status, 200);
  assert.equal((await status(a)).exp, end + 2 * 86400);
});

function stripeCreateWrapper(onCreate) {
  const stripe = fakeStripe(), real = stripe.fetch;
  stripe.fetch = (url, init) => {
    if (new URL(url).pathname === '/v1/checkout/sessions' && init.method === 'POST') {
      return onCreate(init.headers['Idempotency-Key'], () => real(url, init));
    }
    return real(url, init);
  };
  return stripe;
}

const checkoutPath = '/go?id=' + ID + '&plan=monthly&cur=usd';
const stripeError = (status, code, param) => Response.json({ error: { code, param, message: 'sensitive test message' } }, { status });

test('Checkout recovers once from cached Stripe 5xx responses and fences concurrent stale create results', async t => {
  t.mock.method(console, 'warn', () => {});
  let first, resume, start;
  const started = new Promise(resolve => { start = resolve; });
  const delayed = new Promise(resolve => { resume = resolve; });
  const keys = [];
  const stripe = stripeCreateWrapper(async (key, real) => {
    keys.push(key);
    if (!first) {
      first = key;
      start();
      await delayed;
      return real(); // A late successful response from a superseded token.
    }
    if (key === first) return stripeError(500, 'api_error');
    return real();
  });
  const a = app({ stripe });
  const stale = a.call('GET', checkoutPath);
  await started;
  let recovered;
  try {
    recovered = await a.call('GET', checkoutPath);
    assert.equal(recovered.status, 303);
  } finally {
    resume();
  }
  const last = await stale;
  assert.equal(last.status, 303);
  assert.equal(last.headers.get('location'), recovered.headers.get('location'));
  assert.equal(new Set(keys).size, 2);
  assert.equal(Object.keys(stripe.sessions).length, 2);
  const current = await a.store.get([...a.store.m.keys()].find(key => key.startsWith('checkout:')));
  assert.equal(current.session, 'cs_0');
  assert.doesNotMatch(last.headers.get('location'), /cs_1/);
});

test('two cached Stripe 5xx responses back off before allowing a fresh attempt', async t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  let failing = true;
  const keys = [];
  const stripe = stripeCreateWrapper((key, real) => {
    keys.push(key);
    return failing ? stripeError(500, 'api_error') : real();
  });
  const a = app({ stripe });
  assert.equal((await a.call('GET', checkoutPath)).status, 503);
  assert.equal((await a.call('GET', checkoutPath)).status, 503);
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 2);
  const [key, row] = [...a.store.m.entries()].find(([key]) => key.startsWith('checkout:'));
  assert.ok(row.v.retryAt > now() && row.exp > Date.now());
  a.store.m.set(key, { ...row, v: { ...row.v, retryAt: now() - 1, expires: row.v.expires - 5 } });
  failing = false;
  assert.equal((await a.call('GET', checkoutPath)).status, 303);
  assert.equal(new Set(keys).size, 3);
  const renewed = await a.store.get(key);
  assert.ok(renewed.expires > row.v.expires - 5);
  assert.equal(renewed.retryAt, undefined);
});

test('Checkout refreshes a late unexposed attempt and fences stale or unsafe redirects', async t => {
  const warnings = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  let canCreate = false;
  const stripe = stripeCreateWrapper((key, real) => canCreate ? real() : stripeError(400, 'parameter_unknown'));
  const a = app({ stripe });
  assert.equal((await a.call('GET', checkoutPath)).status, 503);
  const [key, row] = [...a.store.m.entries()].find(([key]) => key.startsWith('checkout:'));
  assert.equal(row.v.session, undefined);
  const old = { ...row.v, expires: now() + 1799 };
  a.store.m.set(key, { v: old, exp: Date.now() + 1799000 });
  canCreate = true;
  assert.equal((await a.call('GET', checkoutPath)).status, 303);
  const latest = await a.store.get(key);
  assert.notEqual(latest.token, old.token);
  assert.ok(latest.expires - now() > 31 * 60);
  assert.ok(a.store.m.get(key).exp > Date.now() + 31 * 60 * 1000);
  assert.equal(await a.store.attachSession(key, old.token, 'cs_stale'), false);
  const session = stripe.sessions[latest.session];
  session.url = 'https://example.invalid/private_checkout_secret';
  assert.equal((await a.call('GET', checkoutPath)).status, 503);
  assert.equal(warnings.mock.calls.at(-1).arguments[1].reason, 'unexpected-host');
  session.expires_at += 1;
  assert.equal((await a.call('GET', checkoutPath)).status, 503);
  assert.equal(warnings.mock.calls.at(-1).arguments[1].reason, 'stale-session');
  assert.doesNotMatch(JSON.stringify(warnings.mock.calls.map(c => c.arguments)), /private_checkout_secret/);
});

test('an already exposed near-expiry session is reused without overlapping checkout creation', async () => {
  const a = app();
  const first = await a.call('GET', checkoutPath);
  const [key, row] = [...a.store.m.entries()].find(([key]) => key.startsWith('checkout:'));
  const expires = now() + 60;
  a.store.m.set(key, { v: { ...row.v, expires }, exp: Date.now() + 60000 });
  a.stripe.sessions.cs_0.expires_at = expires;
  const second = await a.call('GET', checkoutPath);
  assert.equal(second.status, 303);
  assert.equal(second.headers.get('location'), first.headers.get('location'));
  assert.equal(a.stripe.calls.filter(call => call.method === 'POST').length, 1);
});

test('checkout retries a Stripe idempotency conflict and logs only safe error fields', async t => {
  const logs = t.mock.method(console, 'error', () => {});
  let attempts = 0;
  const stripe = stripeCreateWrapper((key, real) => {
    if (++attempts === 1) return stripeError(409, 'idempotency_key_in_use');
    return stripeError(400, 'parameter_unknown', 'managed_payments[enabled]');
  });
  const a = app({ stripe });
  assert.equal((await a.call('GET', checkoutPath)).status, 503);
  assert.equal(attempts, 2);
  assert.deepEqual(logs.mock.calls[0].arguments[1], {
    stripeStatus: 400, stripeCode: 'parameter_unknown', stripeParam: 'managed_payments[enabled]',
  });
  const another = app({ stripe: stripeCreateWrapper(() => stripeError(403, 'sk_test_private_value', 'email_private_value')) });
  assert.equal((await another.call('GET', checkoutPath)).status, 503);
  assert.deepEqual(logs.mock.calls[1].arguments[1], { stripeStatus: 403, stripeCode: 'other', stripeParam: 'other' });
  assert.doesNotMatch(JSON.stringify(logs.mock.calls.map(c => c.arguments)), /sensitive|private_value/);
});


test('an old reversal waits if evidence of the newer paid invoice is still unavailable', async t => {
  t.mock.method(console, 'error', () => {});
  const stripe = fakeStripe(), original = stripe.fetch;
  let delayed = false;
  stripe.fetch = (url, init) => delayed && new URL(url).pathname === '/v1/invoice_payments'
    ? Response.json({ data: [] }) : original(url, init);
  const a = app({ stripe });
  stripe.subs.sub_1 = subObj({ invoicePayment: 'pi_previous' });
  await a.hook(checkoutSub(a));
  const end = now() + 60 * 86400;
  stripe.subs.sub_1 = subObj({ invoicePayment: 'pi_new', items: { data: [{ current_period_end: end }] } });
  const ev = a.event('charge.refunded', {
    id: 'ch_previous', customer: 'cus_1', payment_intent: 'pi_previous', refunded: true,
  });
  delayed = true;
  assert.equal((await a.hook(ev)).status, 500);
  assert.equal(await a.store.get('ev:' + ev.id), null);
  assert.equal((await status(a)).active, true);
  delayed = false;
  assert.equal((await a.hook(ev)).status, 200);
  assert.equal((await status(a)).exp, end + 2 * 86400);
  assert.deepEqual(stripe.deleted, []);
});
