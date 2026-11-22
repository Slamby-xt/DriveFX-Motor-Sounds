import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { app, lifetimeEvent, testMetadata } from './helpers.js';
import { getStore, postgresStore } from '../server/store.js';
import { handle } from '../server/handler.js';

const ownerUrl = process.env.DRIVEFX_TEST_DATABASE_URL;
const migration = new URL('../db/migrations/202611210001_drivefx.sql', import.meta.url);
const oldId = 'DFX-TEST-0001';
const newId = 'DFX-TEST-0002';

test('remote database credentials must use a Neon pooler and the DriveFX role', async () => {
  const endpoint = 'ep-example-pooler.eu-west-2.aws.neon.tech';
  for (const connectionString of [
    `postgresql://neondb_owner:password@${endpoint}/neondb`,
    'postgresql://drivefx_app:password@ep-example.eu-west-2.aws.neon.tech/neondb',
    `postgresql://drivefx_app:password@${endpoint}:6543/neondb`,
    `postgresql://drivefx_app:password@${endpoint}.example.org/neondb`,
    `postgresql://drivefx_app:password@${endpoint}/neondb?sslmode=disable`,
  ]) {
    await assert.rejects(getStore({ DATA_PREFIX: 'sandbox', VERCEL_ENV: 'preview', DRIVEFX_DATABASE_URL: connectionString }),
      /Neon transaction pooler|invalid database URL/);
  }
});

test('DriveFX migration and concurrent writes on real Postgres', { skip: !ownerUrl }, async t => {
  const url = new URL(ownerUrl);
  assert.ok(['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname), 'a loopback database is required');
  assert.match(url.pathname, /^\/drivefx_test_[a-z0-9_]+$/, 'use a disposable DriveFX database');
  assert.equal(url.search, '', 'connection overrides are forbidden');
  const owner = new Pool({ connectionString: url.href, connectionTimeoutMillis: 2000 });
  t.after(() => owner.end());
  const before = await owner.query("SELECT to_regnamespace('drivefx') AS schema, to_regrole('drivefx_app') AS role");
  assert.deepEqual(before.rows[0], { schema: null, role: null }, 'use a fresh disposable database and cluster');

  await owner.query(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    ALTER DEFAULT PRIVILEGES GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO anon,authenticated,service_role;
    CREATE TABLE public.not_drivefx (x integer);
    CREATE SCHEMA other_app;
    CREATE TABLE other_app.secret (value text);
  `);
  await owner.query(await readFile(migration, 'utf8'));
  const appRolePass = randomBytes(24).toString('hex');
  await owner.query(`ALTER ROLE drivefx_app PASSWORD '${appRolePass}'`);
  url.username = 'drivefx_app';
  url.password = appRolePass;

  const pool = new Pool({ connectionString: url.href, max: 6, connectionTimeoutMillis: 2000 });
  t.after(() => pool.end());
  const store = postgresStore(pool);

  await t.test('role isolation grants runtime operations only within the DriveFX schema', async () => {
    const r = await pool.query('SELECT current_user, name FROM drivefx.environment');
    assert.deepEqual(r.rows[0], { current_user: 'drivefx_app', name: 'sandbox' });
    for (const sql of [
      'SELECT * FROM public.not_drivefx',
      'INSERT INTO public.not_drivefx VALUES (1)',
      'SELECT * FROM other_app.secret',
      'UPDATE drivefx.environment SET name = \'prod\'',
      'CREATE TABLE drivefx.extra (x integer)',
    ]) {
      await assert.rejects(pool.query(sql), { code: '42501' });
    }
    const api = await owner.query(`
      SELECT rolname, has_schema_privilege(rolname, 'drivefx', 'USAGE,CREATE') AS schema_access,
        has_table_privilege(rolname, 'drivefx.records', 'SELECT,INSERT,UPDATE,DELETE') AS table_access,
        has_table_privilege(rolname, 'drivefx.environment', 'SELECT,INSERT,UPDATE,DELETE') AS environment_access
      FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') ORDER BY rolname
    `);
    assert.deepEqual(api.rows, ['anon', 'authenticated', 'service_role'].map(rolname => ({
      rolname, schema_access: false, table_access: false, environment_access: false,
    })));
    await assert.rejects(getStore({
      DATA_PREFIX: 'sandbox', VERCEL_ENV: 'development',
      DRIVEFX_DATABASE_URL: ownerUrl,
    }), /role mismatch/);
  });

  await t.test('the cleanup route requires its dedicated secret and only deletes expired transient records', async () => {
    const cronSecret = randomBytes(24).toString('hex');
    const deps = { env: { DATA_PREFIX: 'sandbox', VERCEL_ENV: 'preview', CRON_SECRET: cronSecret }, getStore: async () => store };
    const route = 'https://example.com/internal/cleanup?__r=cleanup';
    await store.purgeExpired();
    await store.set('rl:cron-expired', 1, { ex: 0 });
    await store.set('rl:cron-fresh', 1, { ex: 3600 });
    await store.set('loss:cron-preserved', { confirmed: true });
    for (const wrong of [undefined, 'wrong-secret']) {
      const opts = wrong ? { headers: { Authorization: `Bearer ${wrong}` } } : {};
      assert.equal((await handle(new Request(route, opts), deps)).status, 401);
    }
    assert.equal((await handle(new Request(route, { method: 'POST' }), deps)).status, 405);
    assert.equal((await owner.query("SELECT count(*) FROM drivefx.transient WHERE key = 'rl:cron-expired'")).rows[0].count, '1');
    const response = await handle(new Request(route, { headers: { Authorization: `Bearer ${cronSecret}` } }), deps);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: 1 });
    assert.equal(await store.get('rl:cron-fresh'), 1);
    assert.deepEqual(await store.get('loss:cron-preserved'), { confirmed: true });
    await store.del('rl:cron-fresh');
    await store.del('loss:cron-preserved');
  });

  await t.test('atomic counters, retention, and maximum trial usage', async () => {
    const increments = await Promise.all(Array.from({ length: 35 }, () => store.incr('rl:test', 3600)));
    assert.deepEqual(increments.sort((a, b) => a - b), Array.from({ length: 35 }, (_, i) => i + 1));
    await owner.query("UPDATE drivefx.transient SET expires_at = now() WHERE key = 'rl:test'");
    assert.equal(await store.get('rl:test'), null);
    assert.equal(await store.incr('rl:test', 3600), 1);
    await Promise.all([9, 200, 15].map(used => store.putMax('tr:id:test', used, { used }, 34560000)));
    assert.deepEqual(await store.get('tr:id:test'), { used: 200 });
    await owner.query("UPDATE drivefx.transient SET expires_at = now() WHERE key = 'tr:id:test'");
    assert.equal(await store.get('tr:id:test'), null);
    await store.putMax('tr:id:test', 4, { used: 4 }, 34560000);
    assert.deepEqual(await store.get('tr:id:test'), { used: 4 });

    const a = app({ store });
    const checkouts = await Promise.all([1, 2].map(i => a.call('GET', '/go?id=' + oldId + '&plan=monthly&cur=usd', {
      ip: '198.51.' + i + '.5',
    })));
    assert.ok(checkouts.every(r => r.status === 303));
    assert.equal(checkouts[0].headers.get('location'), checkouts[1].headers.get('location'));
    assert.equal(Object.keys(a.stripe.sessions).length, 1);

    const trials = await Promise.all([20, 210, 50].map((used, i) => a.call('POST', '/trial', {
      body: { id: oldId, used }, ip: `192.0.${i}.5`,
    })));
    assert.ok(trials.every(r => r.status === 200));
    const usage = await a.j(await a.call('POST', '/trial', { body: { id: oldId, used: 0 } }));
    assert.equal(usage.used, 210);
  });

  await t.test('admin session activity extends only an unexpired transient record', async () => {
    const key = 'lease:admin-session:test';
    assert.equal(await store.touch(key, 600), false);
    await store.set(key, true, { ex: 10 });
    assert.equal(await store.touch(key, 600), true);
    const { rows: [row] } = await owner.query(
      'SELECT expires_at > statement_timestamp() + interval \'9 minutes\' AS extended FROM drivefx.transient WHERE key = $1', [key]);
    assert.equal(row.extended, true);
    await owner.query('UPDATE drivefx.transient SET expires_at = now() WHERE key = $1', [key]);
    assert.equal(await store.touch(key, 600), false);
    await store.del(key);
    assert.equal(await store.touch(key, 600), false);
  });

  await t.test('rollback and exact purchase deduplication use durable transactions', async () => {
    let failCommit = true;
    const rollbackStore = {
      ...store,
      transaction: (key, write) => store.transaction(key, async tx => {
        const r = await write(tx);
        if (failCommit) {
          failCommit = false;
          throw new Error('injected after all writes');
        }
        return r;
      }),
    };
    const a = app({ store: rollbackStore });
    const pi = 'pi_test_postgres';
    a.stripe.pis[pi] = { charge: 'ch_test_postgres', metadata: testMetadata(oldId, 'lifetime') };
    a.stripe.charges.ch_test_postgres = { id: 'ch_test_postgres', payment_intent: pi, customer: 'cus_test' };
    const ev = lifetimeEvent(a, pi, 'cus_test', oldId);
    assert.equal((await a.hook(ev)).status, 500);
    for (const key of ['ev:' + ev.id, 'pi:' + pi, 'lic:' + oldId]) assert.equal(await store.get(key), null);
    assert.deepEqual(await store.customerDevices('cus_test'), []);
    const deliveries = await Promise.all([a.hook(ev), a.hook(ev), a.hook({ ...ev, id: 'evt_test_other' })]);
    assert.ok(deliveries.every(r => r.status === 200 || r.status === 409));
    assert.equal((await store.get('lic:' + oldId)).plan, 'lifetime');
    assert.equal(await store.get('ev:' + ev.id), true);
    assert.deepEqual(await store.customerDevices('cus_test'), [oldId]);

    const moved = await a.admin('POST', '/relink', { from: oldId, to: newId });
    assert.equal(moved.status, 200);
    assert.deepEqual(await store.customerDevices('cus_test'), [newId]);
    assert.equal((await store.get('pi:' + pi)).device, newId);
    assert.equal(await store.get('lic:' + oldId), null);
    const outcome = await a.j(await a.call('GET', '/status?id=' + newId));
    assert.equal(outcome.plan, 'lifetime');
  });
  await t.test('unexposed Checkout refresh and session attachment use a database fence', async () => {
    const key = 'checkout:test_fence';
    const old = { token: 'previous', expires: 100 };
    const fresh = { token: 'fresh', expires: 200 };
    await store.set(key, old, { ex: 20 });
    const writers = await Promise.all([
      store.updateUnexposedCheckout(key, old, fresh, 2700),
      store.updateUnexposedCheckout(key, old, { token: 'competing', expires: 200 }, 2700),
    ]);
    assert.equal(writers.filter(Boolean).length, 1);
    const winner = await store.get(key);
    assert.equal(await store.attachSession(key, old.token, 'cs_stale'), false);
    assert.equal(await store.attachSession(key, winner.token, 'cs_current'), true);
    assert.equal(await store.updateUnexposedCheckout(key, { ...winner, session: 'cs_current' }, fresh, 2700), false);
    const expiry = await owner.query("SELECT extract(epoch FROM expires_at - now()) AS ttl FROM drivefx.transient WHERE key = $1", [key]);
    assert.ok(Number(expiry.rows[0].ttl) > 2600);
  });

  await t.test('subscription renewals, exact reversal and billing retry use persisted Postgres state', async () => {
    const a = app({ store });
    const device = 'DFX-TEST-0003';
    const id = 'sub_postgres';
    const customer = 'cus_postgres';
    const time = Math.floor(Date.now() / 1000);
    function snapshot(end, payment) {
      a.stripe.subs[id] = {
        id, customer, status: 'active', currency: 'usd', created: time,
        metadata: testMetadata(device, 'monthly'),
        items: { data: [{ price: { id: 'price_m' }, quantity: 1, current_period_end: end }] },
        invoicePayment: payment,
      };
    }
    const firstEnd = time + 30 * 86400, renewedEnd = time + 60 * 86400;
    snapshot(firstEnd, 'pi_postgres_first');
    assert.equal((await a.hook(a.event('invoice.paid', { subscription: id }))).status, 200);
    assert.equal((await store.get('lic:' + device)).exp, firstEnd + 2 * 86400);
    snapshot(renewedEnd, 'pi_postgres_renewed');
    const renewal = a.event('invoice.paid', { subscription: id });
    a.stripe.failNext = 'api_error';
    assert.equal((await a.hook(renewal)).status, 500);
    assert.equal(await store.get('ev:' + renewal.id), null);
    assert.equal((await a.hook(renewal)).status, 200);
    for (const payment of ['pi_postgres_first', 'pi_postgres_renewed']) {
      a.stripe.failBilling = true;
      const ev = a.event('charge.refunded', { id: 'ch_' + payment, payment_intent: payment, customer, refunded: true });
      const response = await a.hook(ev);
      if (payment.endsWith('first')) {
        assert.equal(response.status, 200);
        assert.equal((await store.get('lic:' + device)).exp, renewedEnd + 2 * 86400);
      } else {
        assert.equal(response.status, 500);
        assert.equal((await store.get('lic:' + device)).ended, 'refund');
        assert.equal((await store.get('billing:' + ev.id)).operation, 'cancel');
        assert.equal(await store.get('ev:' + ev.id), true);
        a.stripe.failBilling = false;
        assert.equal((await a.hook(ev)).status, 200);
        assert.equal(await store.get('billing:' + ev.id), null);
        assert.deepEqual(a.stripe.deleted, [id]);
      }
    }
  });

});
