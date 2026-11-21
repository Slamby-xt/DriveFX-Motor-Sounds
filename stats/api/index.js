// Single Vercel Function; vercel.json rewrites /collect and /stats (and /api/collect, /api/stats) to it.
import { handle } from '../server/handler.js';
import { getStore } from '../server/store.js';

export default { fetch: req => handle(req, { env: process.env, getStore }) };
