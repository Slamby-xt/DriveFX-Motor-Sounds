// Redis (Upstash, via the Vercel Marketplace) wrapper. Every key is namespaced with DATA_PREFIX ("prod" | "sandbox").
// Env (injected by the Vercel Upstash integration, server-only): KV_REST_API_URL + KV_REST_API_TOKEN  (or UPSTASH_REDIS_REST_URL/TOKEN)
import { Redis } from '@upstash/redis';

const PREFIXES = ['prod', 'sandbox'];

// A live Stripe key may only touch "prod" data, a test key only "sandbox" data: a misconfigured environment fails closed instead of mixing them.
export function checkIsolation(env) {
  const p = env.DATA_PREFIX;
  if (!PREFIXES.includes(p)) throw new Error('DATA_PREFIX must be "prod" or "sandbox"');
  const k = env.STRIPE_KEY || '';
  if (/^(sk|rk)_live_/.test(k) && p !== 'prod') throw new Error('live Stripe key with non-prod data prefix');
  if (/^(sk|rk)_test_/.test(k) && p !== 'sandbox') throw new Error('test Stripe key with prod data prefix');
  if (env.VERCEL_ENV === 'production' && p !== 'prod') throw new Error('production deployment must use the prod prefix');
  if (env.VERCEL_ENV && env.VERCEL_ENV !== 'production' && p === 'prod') throw new Error('preview/development deployment must not use the prod prefix');
  return p;
}

// Keep the maximum "used" seconds: creates the record or raises it, never lowers it. Atomic inside Redis.
const PUT_MAX = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local ok, o = pcall(cjson.decode, cur)
  if ok and type(o) == 'table' and tonumber(o.used) and tonumber(o.used) >= tonumber(ARGV[1]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1`;
const INCR_TTL = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;
const UNLOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export function redisStore(env) {
  const prefix = checkIsolation(env) + ':';
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL, token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis is not configured');
  const r = new Redis({ url, token, automaticDeserialization: false });
  const K = k => prefix + k;
  return {
    get: async k => { const v = await r.get(K(k)); return v == null ? null : String(v); },
    async set(k, v, o = {}) {
      const args = {}; if (o.ex) args.ex = o.ex; if (o.nx) args.nx = true;
      const res = await r.set(K(k), v, args);
      return res === 'OK';
    },
    del: async k => { await r.del(K(k)); },
    incr: async (k, ttl) => Number(await r.eval(INCR_TTL, [K(k)], [String(ttl)])),
    putMax: async (k, used, rec, ttl) => Number(await r.eval(PUT_MAX, [K(k)], [String(used), rec, String(ttl)])),
    async mget(keys) { if (!keys.length) return []; return (await r.mget(...keys.map(K))).map(v => v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v))); },
    async scan(match) { // cursor SCAN, deduplicated; returns keys without the namespace prefix
      const out = new Set(); let cursor = '0';
      do {
        const [next, keys] = await r.scan(cursor, { match: K(match) + '*', count: 200 });
        keys.forEach(k => out.add(k.slice(prefix.length))); cursor = String(next);
      } while (cursor !== '0');
      return [...out];
    },
    async lock(name, ttl) { const t = crypto.randomUUID(); return (await r.set(K('lock:' + name), t, { nx: true, ex: ttl })) === 'OK' ? t : null; },
    unlock: async (name, t) => { await r.eval(UNLOCK, [K('lock:' + name)], [t]); },
  };
}

let cached = null;
export async function getStore(env = process.env) {
  if (!cached) cached = redisStore(env);
  return cached;
}
