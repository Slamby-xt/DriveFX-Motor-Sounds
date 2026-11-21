import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { app } from './helpers.js';
import { getStore, postgresStore } from '../server/store.js';
import { deviceMetadata } from '../server/payments.js';

const ownerUrl = process.env.DRIVEFX_TEST_DATABASE_URL;
const migration = new URL('../supabase/migrations/202611210001_drivefx.sql', import.meta.url);
const oldId = 'DFX-TEST-0001';
const newId = 'DFX-TEST-0002';

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
    const anon = await owner.query(`
      SELECT has_schema_privilege('anon', 'drivefx', 'USAGE') AS usg,
             has_table_privilege('anon', 'drivefx.records', 'SELECT,INSERT,UPDATE,DELETE') AS data
    `);
    assert.deepEqual(anon.rows[0], { usg: false, data: false });
    await assert.rejects(getStore({
      DATA_PREFIX: 'sandbox', VERCEL_ENV: 'development',
      DRIVEFX_DATABASE_URL: ownerUrl,
    }), /role mismatch/);
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
    a.stripe.pis[pi] = { charge: 'ch_test_postgres', metadata: deviceMetadata(oldId, 'lifetime') };
    a.stripe.charges.ch_test_postgres = { id: 'ch_test_postgres', payment_intent: pi, customer: 'cus_test' };
    const ev = a.event('checkout.session.completed', {
      mode: 'payment', payment_status: 'paid', payment_intent: pi, customer: 'cus_test',
      client_reference_id: oldId, metadata: deviceMetadata(oldId, 'lifetime'),
    });
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
});
