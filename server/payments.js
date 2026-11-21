import { createHmac, timingSafeEqual } from 'node:crypto';
import { getPrices, PLANS, stripeEvents, sx } from './stripe.js';

export const ID_RE = /^DFX-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
export const isActive = (rec, now) => !!rec && (rec.exp === 0 || rec.exp > now);
const GRACE = 2 * 86400;
const EVENT_TTL = 7 * 86400;
const EVENT_LEASE = 90;
const MANAGED_INTEGRATION = 'managed_v1';

export const deviceMetadata = (device, plan) => ({ app: 'drivefx', integration: MANAGED_INTEGRATION, device, plan });
const validMeta = m => m?.app === 'drivefx' && m.integration === MANAGED_INTEGRATION && ID_RE.test(m.device) && Object.hasOwn(PLANS, m.plan);
const stripeId = (value, prefix) => {
  const id = typeof value === 'object' ? value?.id : value;
  return typeof id === 'string' && id.startsWith(prefix) && /^[a-zA-Z0-9_]+$/.test(id) ? id : null;
};
const customerOf = obj => stripeId(obj.customer, 'cus_');
const subOfInvoice = i => stripeId(i.parent?.subscription_details?.subscription ?? i.subscription, 'sub_');
const getLic = (c, id) => c.store.get('lic:' + id);
const putLic = (c, id, rec) => c.store.set('lic:' + id, rec);

function withCustomer(rec, cus) {
  const customers = rec?.cuss ?? (rec?.cus ? [rec.cus] : []);
  return customers.includes(cus) ? customers : [...customers, cus].slice(-5);
}

async function checkoutChange(c, o, now) {
  const meta = o.metadata;
  if (!validMeta(meta) || o.client_reference_id !== meta.device || o.payment_status !== 'paid') return null;
  const customer = customerOf(o);
  if (!customer) return null;
  if (o.mode === 'subscription' && meta.plan !== 'lifetime') {
    return subscriptionChange(c, stripeId(o.subscription, 'sub_'), { customer, meta, now });
  }
  if (o.mode !== 'payment' || meta.plan !== 'lifetime') return null;
  const payment = stripeId(o.payment_intent, 'pi_');
  if (!payment) return null;
  const intent = await sx(c, 'GET', '/payment_intents/' + payment, { expand: ['latest_charge'] });
  const charge = intent.latest_charge;
  if (stripeId(intent, 'pi_') !== payment || customerOf(intent) !== customer
      || intent.status !== 'succeeded' || intent.amount_received !== PLANS.lifetime.amount
      || !validMeta(intent.metadata) || intent.metadata.device !== meta.device || intent.metadata.plan !== meta.plan
      || !stripeId(charge, 'ch_') || charge.refunded || charge.disputed) return null;
  return { type: 'lifetime', customer, device: meta.device, payment };
}

async function invoicePayments(c, invoice) {
  const r = await sx(c, 'GET', '/invoice_payments', { invoice, status: 'paid', limit: 100 });
  if (r.has_more) throw new Error('unexpected invoice payment count');
  return (r.data || [])
    .filter(p => p.status === 'paid' && stripeId(p.invoice, 'in_') === invoice && p.amount_paid > 0)
    .map(p => stripeId(p.payment?.payment_intent, 'pi_'))
    .filter(Boolean);
}

async function subscriptionChange(c, id, { customer, meta, now } = {}) {
  if (!id) return null;
  // Read the revision before fetching Stripe. If another delivery commits in the
  // meantime, retry from Stripe instead of committing an older snapshot.
  const revision = (await c.store.get('sub:' + id))?.revision;
  const current = await sx(c, 'GET', '/subscriptions/' + id, { expand: ['latest_invoice'] });
  const m = current.metadata;
  const cus = customerOf(current);
  if (stripeId(current, 'sub_') !== id || !cus || (customer && cus !== customer)
      || !validMeta(m) || m.plan === 'lifetime' || (meta && (m.device !== meta.device || m.plan !== meta.plan))) return null;
  const items = current.items?.data || [];
  const item = items[0];
  const terminal = ['canceled', 'unpaid', 'incomplete_expired'].includes(current.status);
  const change = {
    type: 'subscription', id, revision, device: m.device, customer: cus, plan: m.plan, created: current.created,
    terminal, cancel: !!(current.cancel_at_period_end || current.cancel_at),
  };
  if (terminal || current.status !== 'active') return change;
  const price = await getPrices(c);
  if (items.length !== 1 || stripeId(item.price, 'price_') !== price[m.plan].id) return change;
  const latest = current.latest_invoice;
  const invoice = stripeId(latest, 'in_');
  if (!invoice || latest.status !== 'paid' || latest.amount_paid <= 0 || latest.paid_out_of_band
      || subOfInvoice(latest) !== id || customerOf(latest) !== cus) return change;
  const end = item.current_period_end;
  if (!Number.isSafeInteger(end) || end + GRACE <= now) return change;
  const payments = await invoicePayments(c, invoice);
  if (payments.length) Object.assign(change, { end, invoice, payments });
  return change;
}

async function reversalChange(c, ev, now) {
  const o = ev.data.object;
  const dispute = ev.type === 'charge.dispute.created';
  if (!dispute && o.refunded !== true) return null;
  const chargeId = stripeId(dispute ? o.charge : o, 'ch_');
  if (!chargeId) return null;
  const charge = dispute ? await sx(c, 'GET', '/charges/' + chargeId) : o;
  const customer = customerOf(charge);
  const payment = stripeId(charge.payment_intent, 'pi_');
  if (!customer || !payment || stripeId(charge, 'ch_') !== chargeId
      || (o.payment_intent && stripeId(o.payment_intent, 'pi_') !== payment)) return null;
  const purchase = await c.store.get('pi:' + payment);
  let newerPeriod;
  if (purchase?.sub && purchase.customer === customer) {
    const snapshot = await subscriptionChange(c, purchase.sub, { customer, now });
    // A paid renewal can precede its own webhook. Reconcile the new period
    // before deciding whether the reversed payment still funds the license.
    if (snapshot?.end && snapshot.invoice !== purchase.invoice) newerPeriod = snapshot;
  }
  return { type: 'reversal', payment, customer, reason: dispute ? 'dispute' : 'refund', newerPeriod };
}

async function prepareEvent(c, ev, now) {
  const o = ev.data.object;
  switch (ev.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': return checkoutChange(c, o, now);
    case 'invoice.paid':
    case 'invoice.payment_failed': return subscriptionChange(c, subOfInvoice(o), { customer: customerOf(o), now });
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': return subscriptionChange(c, stripeId(o, 'sub_'), { customer: customerOf(o), now });
    case 'charge.refunded':
    case 'charge.dispute.created': return reversalChange(c, ev, now);
    default: return null;
  }
}

async function applyLifetime(c, change, now) {
  const { customer, payment, device } = change;
  const piKey = 'pi:' + payment;
  if (await c.store.get(piKey)) return null;
  const loss = await c.store.get('loss:' + payment);
  if (loss?.customer === customer) return null;
  await c.store.set(piKey, { device, customer, plan: 'lifetime' });
  await c.store.rememberCustomer(customer, device);
  const cur = await getLic(c, device);
  const cuss = withCustomer(cur, customer);
  if (cur?.exp === 0) {
    await putLic(c, device, { ...cur, cuss });
    return null;
  }
  await putLic(c, device, { exp: 0, iat: cur?.iat || now, days: 0, plan: 'lifetime', src: 'stripe', pi: payment, cus: customer, cuss, cancel: false });
  return cur?.sub ? { sub: cur.sub, operation: 'period_end' } : null;
}

async function applySubscription(c, v, now) {
  const key = 'sub:' + v.id;
  const previous = await c.store.get(key);
  if (previous?.revision !== v.revision) throw new Error('subscription snapshot changed');
  if (previous && (previous.customer !== v.customer || previous.revoked || previous.terminal || (v.end && v.end < previous.end))) return null;
  const id = previous?.device || v.device;
  const cur = await getLic(c, id);
  const next = {
    device: id, customer: v.customer, plan: v.plan, created: v.created,
    terminal: v.terminal, revision: crypto.randomUUID(),
    invoice: previous?.invoice, payments: previous?.payments, end: previous?.end,
  };
  await c.store.rememberCustomer(v.customer, id);
  const cuss = withCustomer(cur, v.customer);
  let ended;
  if (v.end && (!previous?.end || v.end >= previous.end)) {
    for (const payment of v.payments) {
      const claim = await c.store.get('pi:' + payment);
      if (claim && (claim.sub !== v.id || claim.customer !== v.customer || claim.invoice !== v.invoice)) {
        throw new Error('conflicting payment association');
      }
      if (!claim) await c.store.set('pi:' + payment, { device: id, customer: v.customer, sub: v.id, invoice: v.invoice });
      const loss = await c.store.get('loss:' + payment);
      if (loss?.customer === v.customer) ended = loss.reason;
    }
    Object.assign(next, { invoice: v.invoice, payments: v.payments, end: v.end, ...(ended ? { revoked: true } : {}) });
  }
  await c.store.set(key, next);

  if (cur?.exp === 0) {
    if (ended) return { sub: v.id, operation: 'cancel' };
    await putLic(c, id, { ...cur, cuss });
    return cur.src === 'stripe' && v.end && !v.cancel && !ended ? { sub: v.id, operation: 'period_end' } : null;
  }
  if (cur?.sub && cur.sub !== v.id) {
    const currentSub = await c.store.get('sub:' + cur.sub);
    if (isActive(cur, now) || currentSub?.created >= v.created) return null;
  }
  if (v.terminal || ended) {
    if (cur?.sub === v.id) await putLic(c, id, { ...cur, exp: now, cancel: false, ...(ended ? { ended } : {}) });
    return ended ? { sub: v.id, operation: 'cancel' } : null;
  }
  if (!v.end) {
    if (cur?.sub === v.id) await putLic(c, id, { ...cur, cancel: v.cancel });
    return null;
  }
  await putLic(c, id, {
    exp: v.end + GRACE, iat: cur?.iat || now, days: 0, plan: v.plan, src: 'stripe',
    sub: v.id, cus: v.customer, cuss, cancel: v.cancel,
  });
  return null;
}

async function applyReversal(c, change, now) {
  const { customer, payment, reason, newerPeriod } = change;
  const p = await c.store.get('pi:' + payment);
  if (p && p.customer !== customer) return null;
  // Keep the exact reversal even when delivery precedes the paid event. The
  // later payment/subscription event joins on the same PaymentIntent ID.
  await c.store.set('loss:' + payment, { customer, reason });
  if (!p) return null;
  const renewalEffect = newerPeriod ? await applySubscription(c, newerPeriod, now) : null;
  const cur = await getLic(c, p.device);
  const sub = p.sub && await c.store.get('sub:' + p.sub);
  const paidPeriod = sub?.invoice === p.invoice && sub?.payments?.includes(payment);
  if (paidPeriod && !sub.revoked && !sub.terminal) {
    await c.store.set('sub:' + p.sub, { ...sub, revoked: true, revision: crypto.randomUUID() });
  }
  if (cur?.src === 'stripe' && (p.plan === 'lifetime' ? cur.pi === payment : paidPeriod && cur.sub === p.sub)) {
    await putLic(c, p.device, { ...cur, exp: now, cancel: false, ended: reason });
  }
  return paidPeriod && !sub.revoked && !sub.terminal ? { sub: p.sub, operation: 'cancel' } : renewalEffect;
}

async function applyEvent(c, change, now) {
  switch (change?.type) {
    case 'lifetime': return applyLifetime(c, change, now);
    case 'subscription': return applySubscription(c, change, now);
    case 'reversal': return applyReversal(c, change, now);
    default: return null;
  }
}

export async function finishBilling(c, key) {
  const job = await c.store.get(key);
  if (!job) return;
  const path = '/subscriptions/' + job.sub;
  try {
    if (job.operation === 'period_end') await sx(c, 'POST', path, { cancel_at_period_end: true }, 'drivefx-' + key);
    else await sx(c, 'DELETE', path);
  } catch (e) {
    if (e.code !== 'resource_missing' && e.code !== 'invalid_canceled_subscription_fields') throw e;
  }
  await c.store.clearJob(key, job);
}

function verifySignature(env, raw, header, now) {
  if (!env.STRIPE_WEBHOOK_SECRET || !header) return false;
  const parts = header.split(',').map(p => p.trim().split('='));
  const time = parts.find(([k]) => k === 't')?.[1];
  if (!/^\d{1,12}$/.test(time || '') || Math.abs(now - Number(time)) > 300) return false;
  const mac = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(time + '.').update(raw).digest();
  return parts.some(([k, sig]) => k === 'v1' && /^[a-f0-9]{64}$/.test(sig) && timingSafeEqual(Buffer.from(sig, 'hex'), mac));
}

export async function webhook(c, now) {
  const raw = Buffer.from(await c.req.arrayBuffer());
  if (!verifySignature(c.env, raw, c.req.headers.get('Stripe-Signature'), now)) return new Response('bad signature', { status: 400 });
  let ev;
  try { ev = JSON.parse(raw.toString('utf8')); } catch { return new Response('bad json', { status: 400 }); }
  const id = stripeId(ev, 'evt_');
  if (!id || !ev.data?.object || typeof ev.type !== 'string') return new Response('bad event', { status: 400 });
  if (ev.livemode !== (c.env.DATA_PREFIX === 'prod')) return new Response('wrong event mode', { status: 400 });
  if (!stripeEvents.includes(ev.type)) return new Response('ok');
  const marker = 'ev:' + id;
  const lease = 'lease:' + id;
  const job = 'billing:' + id;
  const token = crypto.randomUUID();
  // The lease avoids duplicate Stripe requests. Only the final transaction
  // records success. An interrupted worker leaves a short, reclaimable lease.
  if (!(await c.store.set(lease, token, { nx: true, ex: EVENT_LEASE }))) {
    return new Response('in progress', { status: 409 });
  }
  try {
    if (!(await c.store.get(marker))) {
      const change = await prepareEvent(c, ev, now);
      await c.store.transaction('license', async store => {
        if (await store.get(marker)) return;
        const effect = await applyEvent({ ...c, store }, change, now);
        if (effect) await store.set(job, effect);
        await store.set(marker, true, { ex: EVENT_TTL });
      });
    }
    await finishBilling(c, job);
    return new Response('ok');
  } catch {
    console.error('DriveFX webhook processing failed');
    return new Response('error', { status: 500 });
  } finally {
    await c.store.release(lease, token).catch(() => {});
  }
}
