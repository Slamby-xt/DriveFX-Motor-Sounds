// Single Vercel Function for all license endpoints; vercel.json rewrites /status, /go, ... to it (?__r=<route>).
import { handle } from '../server/handler.js';
import { getStore } from '../server/store.js';

export default {
  fetch: req => handle(req, { env: process.env, getStore }),
};
