export const STRIPE_VERSION = '2026-02-25.clover';
export const TAX_CODE = 'txcd_10103000';
export const CURRENCIES = ['usd', 'eur', 'gbp'];
export const PLANS = {
  monthly: { name: 'DriveFX Pro Monthly', key: 'drivefx_monthly', amount: 299, interval: 'month' },
  yearly: { name: 'DriveFX Pro Yearly', key: 'drivefx_yearly', amount: 2999, interval: 'year' },
  lifetime: { name: 'DriveFX Pro Lifetime', key: 'drivefx_lifetime', amount: 4999, interval: null },
};
export const stripeEvents = [
  'checkout.session.completed', 'checkout.session.async_payment_succeeded',
  'invoice.paid', 'invoice.payment_failed',
  'customer.subscription.updated', 'customer.subscription.deleted',
  'charge.refunded', 'charge.dispute.created',
];

function form(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.push([key, String(v)]);
  }
  return out;
}

export async function sx(c, method, path, params, idempotencyKey) {
  if (!c.env.STRIPE_KEY) throw new Error('payments are not configured');
  const qs = params ? new URLSearchParams(form(params)).toString() : '';
  const get = method === 'GET';
  const r = await c.fetch('https://api.stripe.com/v1' + path + (get && qs ? '?' + qs : ''), {
    method,
    headers: {
      Authorization: 'Bearer ' + c.env.STRIPE_KEY,
      'Stripe-Version': STRIPE_VERSION,
      ...(get ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: get || !qs ? undefined : qs,
    signal: AbortSignal.timeout(5000),
  });
  const j = await r.json();
  if (!r.ok) {
    const e = new Error('Stripe request failed');
    e.status = r.status;
    e.code = j.error?.code;
    throw e;
  }
  return j;
}

export function verifyPrice(price, plan) {
  if (price.active !== true || price.lookup_key !== plan.key || price.billing_scheme !== 'per_unit'
      || !price.product?.active || price.product.tax_code !== TAX_CODE || price.product.name !== plan.name
      || price.type !== (plan.interval ? 'recurring' : 'one_time')
      || (plan.interval && (price.recurring?.interval !== plan.interval || price.recurring.interval_count !== 1))) return null;
  const options = { ...price.currency_options, [price.currency]: price };
  const amounts = {};
  for (const currency of CURRENCIES) {
    const option = options[currency];
    if (option?.unit_amount !== plan.amount || option.tax_behavior !== 'inclusive') return null;
    amounts[currency] = option.unit_amount;
  }
  return amounts;
}

let priceCache;
export async function getPrices(c) {
  if (priceCache?.key === c.env.STRIPE_KEY && Date.now() - priceCache.at < 600000) return priceCache.value;
  const r = await sx(c, 'GET', '/prices', {
    lookup_keys: Object.values(PLANS).map(p => p.key),
    active: true, expand: ['data.currency_options', 'data.product'], limit: 10,
  });
  const values = {};
  for (const [name, plan] of Object.entries(PLANS)) {
    const candidates = r.data.filter(p => p.lookup_key === plan.key);
    const amounts = candidates.length === 1 && verifyPrice(candidates[0], plan);
    if (!amounts) throw new Error('Stripe catalogue mismatch');
    values[name] = { id: candidates[0].id, amounts };
  }
  priceCache = { at: Date.now(), key: c.env.STRIPE_KEY, value: values };
  return values;
}
