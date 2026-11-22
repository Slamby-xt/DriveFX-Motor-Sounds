import { createHmac, timingSafeEqual } from 'node:crypto';
import { CURRENCIES, PLANS, stripeDiagnostic, stripeEvents, sx } from './stripe.js';

export const ID_RE = /^DFX-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
export const isActive = (rec, now) => !!rec && (rec.exp === 0 || rec.exp > now);
const GRACE = 2 * 86400;
const EVENT_TTL = 7 * 86400;
const EVENT_LEASE = 90;
const MANAGED_INTEGRATION = 'managed_v1';

export const deviceMetadata = (device, plan, price, currency, amount) => ({
  app: 'drivefx', integration: MANAGED_INTEGRATION, device, plan, price, currency, amount: String(amount),
});
const stripeId = (value, prefix) => {
  const id = typeof value === 'object' ? value?.id : value;
  return typeof id === 'string' && id.startsWith(prefix) && /^[a-zA-Z0-9_]{1,255}$/.test(id) ? id : null;
};
const validMeta = m => m?.app === 'drivefx' && m.integration === MANAGED_INTEGRATION
  && ID_RE.test(m.device) && Object.hasOwn(PLANS, m.plan) && stripeId(m.price, 'price_')
  && CURRENCIES.includes(m.currency) && typeof m.amount === 'string' && /^[1-9]\d{0,7}$/.test(m.amount);
const sameBinding = (a, b) => a.device === b.device && a.plan === b.plan && a.price === b.price
  && a.currency === b.currency && a.amount === b.amount;
const customerOf = obj => stripeId(obj.customer, 'cus_');
const subOfInvoice = i => stripeId(i.parent?.subscription_details?.subscription ?? i.subscription, 'sub_');
const getLic = (c, id) => c.store.get('lic:' + id);
const putLic = (c, id, rec) => c.store.set('lic:' + id, rec);

// Look up the billing details on the payment that funded the listed license.
export async function stripeBuyerDetails(c, id) {
  const license = await getLic(c, id);
  if (license?.src !== 'stripe') return null;
  const customer = stripeId(license.cus, 'cus_');
  if (!customer) return null;

  let email, country;
  if (license.plan === 'lifetime') {
    const payment = stripeId(license.pi, 'pi_');
    if (!payment) return null;
    const sessions = await sx(c, 'GET', '/checkout/sessions', { payment_intent: payment, limit: 2 });
    const session = sessions.data.find(s => s.status === 'complete' && s.mode === 'payment'
      && s.payment_status === 'paid' && s.metadata?.app === 'drivefx'
      && stripeId(s.payment_intent, 'pi_') === payment && customerOf(s) === customer);
    if (!session) return null;
    email = session.customer_details?.email;
    country = session.customer_details?.address?.country;
  } else {
    const sub = stripeId(license.sub, 'sub_');
    if (!sub) return null;
    const link = await c.store.get('sub:' + sub);
    const invoiceId = stripeId(link?.invoice, 'in_');
    if (!invoiceId || link.device !== id || link.customer !== customer) return null;
    const invoice = await sx(c, 'GET', '/invoices/' + invoiceId);
    if (stripeId(invoice, 'in_') !== invoiceId || invoice.status !== 'paid' || invoice.amount_paid <= 0
        || subOfInvoice(invoice) !== sub || customerOf(invoice) !== customer) return null;
    email = invoice.customer_email;
    country = invoice.customer_address?.country;
  }
  return {
    email: typeof email === 'string' && email.trim() ? email.trim() : null,
    country: typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? country : null,
  };
}

function withCustomer(rec, cus) {
  const customers = rec?.cuss ?? (rec?.cus ? [rec.cus] : []);
  return customers.includes(cus) ? customers : [...customers, cus].slice(-5);
}

async function checkoutChange(c, o, now, reject) {
  if (o.metadata?.app !== 'drivefx' || o.payment_status !== 'paid') return null;
  const meta = o.metadata;
  if (!validMeta(meta) || o.client_reference_id !== meta.device) return reject('checkout-metadata');
  const customer = customerOf(o);
  if (!customer) return reject('checkout-customer');
  if (o.mode === 'subscription' && meta.plan !== 'lifetime') {
    const sub = stripeId(o.subscription, 'sub_');
    if (!sub) return reject('checkout-subscription');
    return subscriptionChange(c, sub, { customer, meta, now, reject, requiredPaid: true });
  }
  const id = stripeId(o, 'cs_');
  if (o.mode !== 'payment' || meta.plan !== 'lifetime' || !id) return reject('checkout-mode-or-id');
  const session = await sx(c, 'GET', '/checkout/sessions/' + id, { expand: ['line_items'] });
  if (stripeId(session, 'cs_') !== id || session.mode !== o.mode || session.client_reference_id !== meta.device
      || customerOf(session) !== customer || !validMeta(session.metadata) || !sameBinding(session.metadata, meta)) {
    return reject('checkout-association');
  }
  if (session.status !== 'complete' || session.payment_status !== 'paid') return reject('checkout-payment-pending', true);
  const payment = stripeId(session.payment_intent, 'pi_');
  if (!payment || !Array.isArray(session.line_items?.data)) return reject('checkout-details-pending', true);
  if (o.payment_intent && stripeId(o.payment_intent, 'pi_') !== payment) return reject('checkout-payment-association');

  // Stripe reports the integration amount at the top level. Adaptive Pricing
  // can separately report a different presentment currency and amount.
  const amount = Number(meta.amount);
  const [item] = session.line_items.data;
  if (session.line_items.has_more || session.line_items.data.length !== 1 || item.quantity !== 1
      || stripeId(item.price, 'price_') !== meta.price || item.currency !== meta.currency || item.amount_total !== amount
      || session.currency !== meta.currency || session.amount_total !== amount) return reject('checkout-price');

  const intent = await sx(c, 'GET', '/payment_intents/' + payment, { expand: ['latest_charge'] });
  if (stripeId(intent, 'pi_') !== payment || customerOf(intent) !== customer
      || !validMeta(intent.metadata) || !sameBinding(intent.metadata, meta)) return reject('payment-association');
  if (intent.status !== 'succeeded' || !intent.latest_charge || typeof intent.latest_charge !== 'object') {
    return reject('payment-details-pending', true);
  }
  const charge = intent.latest_charge;
  if (!stripeId(charge, 'ch_') || stripeId(charge.payment_intent, 'pi_') !== payment || customerOf(charge) !== customer
      || intent.currency !== session.currency || intent.amount_received !== session.amount_total) return reject('payment-amount-or-charge');
  if (charge.refunded || charge.disputed) return reject('payment-reversed');
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

async function subscriptionChange(c, id, { customer, meta, now, reject = () => null, requiredPaid, paidInvoice } = {}) {
  if (!id) return null;
  // Read before fetching Stripe. If another event commits in the meantime,
  // retry from Stripe instead of applying an older snapshot.
  const previous = await c.store.get('sub:' + id);
  const current = await sx(c, 'GET', '/subscriptions/' + id, { expand: ['latest_invoice'] });
  const m = current.metadata;
  if (m?.app !== 'drivefx' && !previous && !meta) return null;
  if (!m?.app && meta) return reject('subscription-metadata-pending', true);
  const cus = customerOf(current);
  if (stripeId(current, 'sub_') !== id || !cus || (customer && cus !== customer)
      || !validMeta(m) || m.plan === 'lifetime' || (meta && !sameBinding(m, meta))) return reject('subscription-association');
  // A relink changes the device that owns the stored entitlement. The
  // original binding remains on the Stripe object for renewal validation.
  if (previous?.price && (previous.price !== m.price || previous.currency !== m.currency
      || previous.amount !== m.amount || previous.plan !== m.plan)) return reject('subscription-binding');
  const terminal = ['canceled', 'unpaid', 'incomplete_expired'].includes(current.status);
  const change = {
    type: 'subscription', id, revision: previous?.revision, device: m.device, customer: cus, plan: m.plan,
    price: m.price, currency: m.currency, amount: m.amount, created: current.created,
    terminal, cancel: !!(current.cancel_at_period_end || current.cancel_at),
  };
  if (requiredPaid && current.status === 'incomplete') return reject('subscription-activation-pending', true);
  if (terminal || current.status !== 'active') return change;
  if (!Array.isArray(current.items?.data)) return reject('subscription-items-pending', true);
  const items = current.items.data;
  const item = items[0];
  if (current.items?.has_more || items.length !== 1 || item.quantity !== 1
      || stripeId(item.price, 'price_') !== m.price || current.currency !== m.currency) return reject('subscription-price');
  const latest = current.latest_invoice;
  const invoice = stripeId(latest, 'in_');
  if (!invoice || typeof latest !== 'object') return reject('subscription-invoice-pending', true);
  if (latest.status !== 'paid') {
    if (requiredPaid && (!previous?.invoice || paidInvoice === invoice)) return reject('subscription-invoice-pending', true);
    return change;
  }
  if (latest.amount_paid <= 0 || latest.paid_out_of_band || subOfInvoice(latest) !== id || customerOf(latest) !== cus) {
    return reject('subscription-invoice');
  }
  const end = item.current_period_end;
  if (!Number.isSafeInteger(end) || end + GRACE <= now) return change;
  const payments = await invoicePayments(c, invoice);
  if (!payments.length) return reject('invoice-payment-pending', true);
  return { ...change, end, invoice, payments };
}

async function reversalChange(c, ev, now, reject) {
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
    const snapshot = await subscriptionChange(c, purchase.sub, {
      customer, now, reject: (reason, retry) => retry ? reject(reason, true) : null,
    });
    // A paid renewal can precede its own webhook. Reconcile the new period
    // before deciding whether the reversed payment still funds the license.
    if (snapshot?.end && snapshot.invoice !== purchase.invoice) newerPeriod = snapshot;
  }
  return { type: 'reversal', payment, customer, reason: dispute ? 'dispute' : 'refund', newerPeriod };
}

async function prepareEvent(c, ev, now) {
  function reject(reason, retry = false) {
    if (retry) {
      const e = new Error('Stripe payment evidence pending');
      e.eventReason = reason;
      throw e;
    }
    console.warn('DriveFX payment event rejected', { event: ev.id, type: ev.type, reason });
    return null;
  }
  const o = ev.data.object;
  switch (ev.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': return checkoutChange(c, o, now, reject);
    case 'invoice.paid': return subscriptionChange(c, subOfInvoice(o), {
      customer: customerOf(o), now, reject, requiredPaid: true, paidInvoice: stripeId(o, 'in_'),
    });
    case 'invoice.payment_failed': return subscriptionChange(c, subOfInvoice(o), { customer: customerOf(o), now });
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': return subscriptionChange(c, stripeId(o, 'sub_'), { customer: customerOf(o), now });
    case 'charge.refunded':
    case 'charge.dispute.created': return reversalChange(c, ev, now, reject);
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
    device: id, customer: v.customer, plan: v.plan, price: v.price, currency: v.currency, amount: v.amount, created: v.created,
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
    if (job.operation === 'period_end') await sx(c, 'POST', path, { cancel_at_period_end: true });
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
    if (!(await c.store.get(marker)) && !(await c.store.get(job))) {
      const change = await prepareEvent(c, ev, now);
      await c.store.transaction('license', async store => {
        if (await store.get(marker)) return;
        const effect = await applyEvent({ ...c, store }, change, now);
        if (effect) await store.set(job, { ...effect, queuedAt: now });
        await store.set(marker, true, { ex: EVENT_TTL });
      });
    }
    await finishBilling(c, job);
    return new Response('ok');
  } catch (error) {
    console.error('DriveFX webhook processing failed', {
      event: id, type: ev.type, reason: error.eventReason || 'processing-failed', ...stripeDiagnostic(error),
    });
    return new Response('error', { status: 500 });
  } finally {
    await c.store.release(lease, token).catch(() => {});
  }
}
