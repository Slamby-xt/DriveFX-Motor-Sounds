// Sandbox provisioning and read-only catalogue verification for DriveFX.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { PLANS, STRIPE_VERSION, TAX_CODE, stripeEvents, verifyPrice } from '../server/stripe.js';

const { values: opts } = parseArgs({
  options: {
    account: { type: 'string' }, live: { type: 'boolean' }, check: { type: 'boolean' },
    webhook: { type: 'string' }, portal: { type: 'boolean' },
  },
});
const readOnly = opts.live || opts.check;
if (!/^acct_[A-Za-z0-9]+$/.test(opts.account || '')) {
  console.error('Pass --account with the dedicated DriveFX account or sandbox ID.');
  process.exit(1);
}
if (opts.webhook) {
  const url = new URL(opts.webhook);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/stripe-webhook' || url.hash || url.search) {
    throw new Error('Use an HTTPS /stripe-webhook URL without credentials, query parameters or fragments. Set up protected preview endpoints in the Dashboard.');
  }
}

function stripe(method, path, fields = {}, idempotency) {
  if (readOnly && method !== 'get') throw new Error('Stripe writes are disabled in audit or live mode');
  const args = Object.entries(fields).flatMap(([k, v]) => ['-d', `${k}=${v}`]);
  if (idempotency) args.push('--idempotency', idempotency);
  if (opts.live) args.push('--live');
  let raw;
  try {
    raw = execFileSync('stripe', [method, '/v1/' + path, '--stripe-version', STRIPE_VERSION, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
    });
  } catch {
    throw new Error(`Stripe CLI could not complete ${method} ${path}. Check the selected Stripe profile and credentials.`);
  }
  const response = JSON.parse(raw.slice(raw.indexOf('{')));
  if (response.error) {
    const e = new Error(`Stripe API rejected ${method} ${path} (${response.error.code || response.error.type}).`);
    e.missing = response.error.code === 'resource_missing';
    throw e;
  }
  return response;
}

function retrieveProduct(id) {
  try { return stripe('get', 'products/' + id); }
  catch (e) { if (!e.missing) throw e; return null; }
}

function productFor(name, plan) {
  const id = 'drivefx_pro_' + name;
  const fixed = retrieveProduct(id);
  const found = stripe('get', 'products/search', { query: `name:"${plan.name}" AND active:"true"`, limit: 100 });
  const matches = new Map(found.data.map(p => [p.id, p]));
  if (fixed) matches.set(fixed.id, fixed);
  if (found.has_more || matches.size > 1) throw new Error(`Resolve duplicate products for ${plan.name} before provisioning`);
  const existing = matches.values().next().value;
  if (existing && (!existing.active || existing.name !== plan.name || (existing.tax_code && existing.tax_code !== TAX_CODE))) {
    throw new Error(`Review the existing product and tax code for ${plan.name}`);
  }
  if (existing) {
    if (existing.tax_code !== TAX_CODE) {
      stripe('post', 'products/' + existing.id, { tax_code: TAX_CODE }, 'drivefx-tax-code-' + existing.id);
    }
    return existing.id;
  }
  return stripe('post', 'products', {
    id, name: plan.name, tax_code: TAX_CODE, 'metadata[app]': 'drivefx', 'metadata[plan]': name,
  }, 'drivefx-product-' + name).id;
}

function setUpPrice(name, plan) {
  const found = stripe('get', 'prices', {
    'lookup_keys[0]': plan.key, 'expand[0]': 'data.currency_options', 'expand[1]': 'data.product', limit: 10,
  });
  if (found.data.length) {
    if (found.data.length !== 1 || !verifyPrice(found.data[0], plan)) throw new Error(`Review existing price ${plan.key}; it differs from the approved catalogue`);
    console.log(`${plan.key}: verified`);
    return;
  }
  if (readOnly) throw new Error(`Missing price ${plan.key}`);
  const product = productFor(name, plan);
  const fields = {
    product, currency: 'usd', unit_amount: plan.amount, tax_behavior: 'inclusive', lookup_key: plan.key,
    'currency_options[eur][unit_amount]': plan.amount, 'currency_options[eur][tax_behavior]': 'inclusive',
    'currency_options[gbp][unit_amount]': plan.amount, 'currency_options[gbp][tax_behavior]': 'inclusive',
  };
  if (plan.interval) fields['recurring[interval]'] = plan.interval;
  stripe('post', 'prices', fields, 'drivefx-price-' + plan.key);
  console.log(`${plan.key}: created`);
}

function setUpPortal() {
  const { data } = stripe('get', 'billing_portal/configurations', { active: true, limit: 100 });
  const item = data.find(c => c.metadata?.app === 'drivefx');
  if (item) {
    if (!item.login_page?.enabled || !item.features?.invoice_history?.enabled
        || !item.features?.payment_method_update?.enabled || !item.features?.subscription_cancel?.enabled
        || item.features.subscription_cancel.mode !== 'at_period_end') {
      throw new Error('Review the existing DriveFX portal in Stripe Dashboard');
    }
    console.log('DriveFX portal: verified');
    return;
  }
  if (readOnly) throw new Error('No active DriveFX billing portal configuration');
  stripe('post', 'billing_portal/configurations', {
    'metadata[app]': 'drivefx',
    'business_profile[headline]': 'Manage your DriveFX Pro subscription',
    'features[subscription_cancel][enabled]': 'true',
    'features[subscription_cancel][mode]': 'at_period_end',
    'features[payment_method_update][enabled]': 'true',
    'features[invoice_history][enabled]': 'true',
    'login_page[enabled]': 'true',
  }, 'drivefx-billing-portal-v1');
  console.log('DriveFX portal: created');
}

function setUpWebhook(url) {
  const { data } = stripe('get', 'webhook_endpoints', { limit: 100 });
  const item = data.find(w => w.url === url);
  if (item) {
    if (item.api_version !== STRIPE_VERSION || item.status !== 'enabled'
        || !stripeEvents.every(e => item.enabled_events.includes(e))) {
      throw new Error('Review the existing webhook endpoint and event set in Stripe Dashboard');
    }
    console.log('DriveFX webhook: verified');
    return;
  }
  if (readOnly) throw new Error('No matching webhook endpoint');
  const events = Object.fromEntries(stripeEvents.map((e, i) => [`enabled_events[${i}]`, e]));
  const key = 'drivefx-webhook-' + createHash('sha256').update(url).digest('hex');
  stripe('post', 'webhook_endpoints', { url, api_version: STRIPE_VERSION, description: 'DriveFX license server', ...events }, key);
  console.log('DriveFX webhook: created. Copy the signing secret from Stripe Dashboard directly to the matching Vercel environment.');
}

try {
  if (stripe('get', 'account').id !== opts.account) throw new Error('The selected Stripe account does not match --account');
  for (const [name, plan] of Object.entries(PLANS)) setUpPrice(name, plan);
  if (!readOnly || opts.portal) setUpPortal();
  if (opts.webhook) setUpWebhook(opts.webhook);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
