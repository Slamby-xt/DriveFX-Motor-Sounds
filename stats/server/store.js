// Upstash Redis wrapper for DriveFX Stats. Every key is prefixed "stats:" so it can share a database with other apps.
import { Redis } from '@upstash/redis';

const INCR_TTL = `local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return n`;

export function redisStore(env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL, token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis is not configured');
  const r = new Redis({ url, token, automaticDeserialization: false });
  const K = k => 'stats:' + k;
  return {
    incr: async (k, ttl) => Number(await r.eval(INCR_TTL, [K(k)], [String(ttl)])),
    del: async k => { await r.del(K(k)); },
    async addVisitor(k, id, ttl) { const n = await r.pfadd(K(k), id); await r.expire(K(k), ttl); return Number(n) === 1; },
    hlen: async k => Number(await r.hlen(K(k))),
    async hincr(k, f, by, ttl) { await r.hincrby(K(k), f, by); await r.expire(K(k), ttl); },
    async live(id, now) { await r.zadd(K('live'), { score: now, member: id }); await r.zremrangebyscore(K('live'), 0, now - 300); await r.expire(K('live'), 900); },
    async liveCount(now) { await r.zremrangebyscore(K('live'), 0, now - 300); return Number(await r.zcard(K('live'))); },
    async hgetallMany(keys) { const p = r.pipeline(); keys.forEach(k => p.hgetall(K(k))); return (await p.exec()).map(x => x || {}); },
    async countVisitors(keys) { return Number(await r.pfcount(...keys.map(K))); },
  };
}

let cached = null;
export async function getStore(env = process.env) { if (!cached) cached = redisStore(env); return cached; }
