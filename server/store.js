import { Pool } from 'pg';

export function checkIsolation(env) {
  const p = env.DATA_PREFIX;
  if (!['prod', 'sandbox'].includes(p)) throw new Error('DATA_PREFIX must be "prod" or "sandbox"');
  const k = env.STRIPE_KEY || '';
  if (k && !/^(sk|rk)_(live|test)_/.test(k)) throw new Error('invalid Stripe key mode');
  if (/^(sk|rk)_live_/.test(k) && p !== 'prod') throw new Error('live Stripe key with non-prod database');
  if (/^(sk|rk)_test_/.test(k) && p !== 'sandbox') throw new Error('test Stripe key with prod database');
  if (env.VERCEL_ENV === 'production' && p !== 'prod') throw new Error('production deployment must use the prod database');
  if (env.VERCEL_ENV && env.VERCEL_ENV !== 'production' && p === 'prod') throw new Error('preview/development deployment must not use the prod database');
  return p;
}

const transient = /^(tr|rl|ev|lease|checkout):/;
const tableOf = key => transient.test(key) ? 'drivefx.transient' : 'drivefx.records';

function queries(db) {
  return {
    async get(key) {
      const table = tableOf(key);
      const sql = `SELECT value FROM ${table} WHERE key = $1` +
        (table === 'drivefx.transient' ? ' AND expires_at > statement_timestamp()' : '');
      return (await db.query(sql, [key])).rows[0]?.value ?? null;
    },

    async set(key, value, { ex, nx } = {}) {
      const data = [key, JSON.stringify(value)];
      if (transient.test(key)) {
        const conflict = nx ? 'WHERE drivefx.transient.expires_at <= statement_timestamp()' : '';
        const r = await db.query(`
          INSERT INTO drivefx.transient (key, value, expires_at)
          VALUES ($1, $2, statement_timestamp() + $3::integer * interval '1 second')
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at ${conflict}
        `, [...data, ex]);
        return r.rowCount === 1;
      }
      const conflict = nx ? 'NOTHING' : 'UPDATE SET value = EXCLUDED.value';
      return (await db.query(`
        INSERT INTO drivefx.records (key, value) VALUES ($1, $2) ON CONFLICT (key) DO ${conflict}
      `, data)).rowCount === 1;
    },

    async del(key) {
      await db.query(`DELETE FROM ${tableOf(key)} WHERE key = $1`, [key]);
    },

    async touch(key, ttl) {
      const result = await db.query(`
        UPDATE drivefx.transient
        SET expires_at = statement_timestamp() + $2::integer * interval '1 second'
        WHERE key = $1 AND expires_at > statement_timestamp()
      `, [key, ttl]);
      return result.rowCount === 1;
    },

    async purgeExpired() {
      const result = await db.query('DELETE FROM drivefx.transient WHERE expires_at <= statement_timestamp()');
      return result.rowCount;
    },

    async release(key, value) {
      await db.query('DELETE FROM drivefx.transient WHERE key = $1 AND value = $2', [key, JSON.stringify(value)]);
    },

    async incr(key, ttl) {
      const r = await db.query(`
        INSERT INTO drivefx.transient AS t (key, value, expires_at)
        VALUES ($1, '1', statement_timestamp() + $2::integer * interval '1 second')
        ON CONFLICT (key) DO UPDATE SET
          value = CASE WHEN t.expires_at <= statement_timestamp() THEN '1'::jsonb ELSE to_jsonb((t.value::bigint) + 1) END,
          expires_at = CASE WHEN t.expires_at <= statement_timestamp() THEN EXCLUDED.expires_at ELSE t.expires_at END
        RETURNING value
      `, [key, ttl]);
      return r.rows[0].value;
    },

    async putMax(key, used, rec, ttl) {
      await db.query(`
        INSERT INTO drivefx.transient AS t (key, value, expires_at)
        VALUES ($1, $2, statement_timestamp() + $3::integer * interval '1 second')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
        WHERE t.expires_at <= statement_timestamp() OR (t.value->>'used')::numeric < $4
      `, [key, JSON.stringify(rec), ttl, used]);
    },

    async attachSession(key, token, session) {
      const result = await db.query(`
        UPDATE drivefx.transient SET value = value || jsonb_build_object('session', $3::text)
        WHERE key = $1 AND value->>'token' = $2 AND expires_at > statement_timestamp()
          AND (value->>'session' IS NULL OR value->>'session' = $3)
      `, [key, token, session]);
      return result.rowCount === 1;
    },

    async updateUnexposedCheckout(key, previous, next, ttl = null) {
      const result = await db.query(`
        UPDATE drivefx.transient SET value = $3,
          expires_at = CASE WHEN $4::integer IS NULL THEN expires_at
            ELSE statement_timestamp() + $4::integer * interval '1 second' END
        WHERE key = $1 AND value = $2 AND expires_at > statement_timestamp() AND value->>'session' IS NULL
      `, [key, JSON.stringify(previous), JSON.stringify(next), ttl]);
      return result.rowCount === 1;
    },

    async licenses() {
      const r = await db.query("SELECT substr(key, 5) AS id, value FROM drivefx.records WHERE key LIKE 'lic:%'");
      return r.rows.map(({ id, value }) => ({ id, ...value }));
    },

    async rememberCustomer(customer, device) {
      await db.query('INSERT INTO drivefx.customers (customer, device) VALUES ($1, $2) ON CONFLICT DO NOTHING', [customer, device]);
    },

    async customerDevices(customer) {
      const r = await db.query('SELECT device FROM drivefx.customers WHERE customer = $1 ORDER BY device', [customer]);
      return r.rows.map(row => row.device);
    },

    async moveMappings(from, to) {
      await db.query(`
        UPDATE drivefx.records SET value = jsonb_set(value, '{device}', to_jsonb($2::text))
        WHERE value ->> 'device' = $1 AND split_part(key, ':', 1) IN ('sub', 'pi')
      `, [from, to]);
      await db.query(`
        INSERT INTO drivefx.customers (customer, device)
        SELECT customer, $2 FROM drivefx.customers WHERE device = $1 ON CONFLICT DO NOTHING
      `, [from, to]);
      await db.query('DELETE FROM drivefx.customers WHERE device = $1', [from]);
    },

    async clearJob(key, value) {
      await db.query('DELETE FROM drivefx.records WHERE key = $1 AND value = $2', [key, JSON.stringify(value)]);
    },
  };
}

export function postgresStore(pool) {
  return {
    ...queries(pool),
    async transaction(lock, fn) {
      const conn = await pool.connect();
      let discard;
      try {
        await conn.query('BEGIN');
        await conn.query("SET LOCAL statement_timeout = '5s'");
        await conn.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
        // Transaction-scoped locks survive transaction pooling, and disappear on rollback.
        // License writes are infrequent; one lock makes entitlement selection and relinks atomic.
        const names = Array.isArray(lock) ? [...new Set(lock)].sort() : lock ? [lock] : [];
        for (const name of names) {
          await conn.query('SELECT pg_advisory_xact_lock(40913027, hashtext($1))', [name]);
        }
        const result = await fn(queries(conn));
        await conn.query('COMMIT');
        return result;
      } catch (e) {
        try { await conn.query('ROLLBACK'); } catch (error) { discard = error; }
        throw e;
      } finally {
        conn.release(discard);
      }
    },
  };
}

let cached;
export async function getStore(env = process.env) {
  const purpose = checkIsolation(env);
  if (!cached) {
    cached = (async () => {
      const url = new URL(env.DRIVEFX_DATABASE_URL);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.password || url.search || url.hash) throw new Error('invalid database URL');
      if (env.VERCEL_ENV && env.VERCEL_ENV !== 'development' && local) throw new Error('deployed database must use TLS');
      if (purpose === 'prod' && local) throw new Error('production database must use TLS');
      const neonPooler = /^ep-[a-z0-9-]+-pooler(?:\.[a-z0-9-]+)+\.neon\.tech$/.test(url.hostname);
      if (!local && (!neonPooler || (url.port && url.port !== '5432') || url.username !== 'drivefx_app')) {
        throw new Error('use the DriveFX role on the Neon transaction pooler');
      }
      const pool = new Pool({
        connectionString: url.toString(),
        ssl: local ? false : { rejectUnauthorized: true, ...(env.DRIVEFX_DATABASE_CA ? { ca: env.DRIVEFX_DATABASE_CA } : {}) },
        max: 3,
        idleTimeoutMillis: 5000,
        connectionTimeoutMillis: 10000,
        query_timeout: 8000,
        allowExitOnIdle: true,
      });
      pool.on('error', () => console.error('DriveFX database connection lost'));
      try {
        const r = await pool.query('SELECT current_user AS role, name FROM drivefx.environment');
        if (r.rows.length !== 1 || r.rows[0].role !== 'drivefx_app' || r.rows[0].name !== purpose) {
          throw new Error('database environment or role mismatch');
        }
        return postgresStore(pool);
      } catch (err) {
        await pool.end();
        throw err;
      }
    })().catch(err => {
      cached = null;
      throw err;
    });
  }
  return cached;
}
