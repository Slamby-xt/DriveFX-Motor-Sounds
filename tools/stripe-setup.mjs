// Creates (or checks) everything DriveFX needs in Stripe: 3 products with USD/EUR/GBP prices, the billing portal, the webhook.
// Safe to run again: existing items are left alone (products have fixed ids, prices are found by lookup_key).
//   node tools/stripe-setup.mjs                 sandbox / test mode (whatever `stripe login` selected)
//   node tools/stripe-setup.mjs --live          LIVE account, asks for the word "live" first
//   node tools/stripe-setup.mjs --webhook URL   also create the webhook endpoint (prints the signing secret once)
// Needs the Stripe CLI, logged in to the account you want to change.
import { execFileSync } from 'node:child_process';
import readline from 'node:readline/promises';

const live = process.argv.includes('--live');
const wi = process.argv.indexOf('--webhook'), hook = wi > 0 ? process.argv[wi + 1] : null;
const API_VERSION = '2026-02-25.clover'; // keep equal to STRIPE_VERSION in worker/index.js

// plan: [name, description, cents (same number in every currency), recurring interval or null]
const PLANS = {
  monthly:  ['DriveFX Pro Monthly',  'Every car, no time limit. Renews monthly until cancelled. Priced in USD, EUR and GBP.', 299, 'month'],
  yearly:   ['DriveFX Pro Yearly',   'Every car, no time limit. Renews yearly until cancelled. Priced in USD, EUR and GBP.', 2999, 'year'],
  lifetime: ['DriveFX Pro Lifetime', 'Every car, no time limit. One payment, no renewals. Priced in USD, EUR and GBP.', 4999, null],
};
const TAX_BEHAVIOR = 'inclusive'; // the number shown is the number paid (turn Stripe Tax on in the worker with TAX=1 once registered)

const stripe = (...a) => {
  let out;
  try { out = execFileSync('stripe', [...a, ...(live ? ['--live'] : []), '--stripe-version', API_VERSION], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { throw new Error((e.stderr || e.message).toString().trim()); }
  const j = JSON.parse(out.slice(out.indexOf('{'))); // the CLI exits 0 on API errors and prints { error: ... }
  if (j.error) { const err = new Error(`${j.error.code || j.error.type}: ${j.error.message}`); err.notFound = j.error.code === 'resource_missing'; throw err; }
  return j;
};
const D = o => Object.entries(o).flatMap(([k, v]) => ['-d', `${k}=${v}`]);

const acct = stripe('get', '/v1/account');
console.log(`Account: ${acct.settings?.dashboard?.display_name || acct.business_profile?.name || '(no name)'} ${acct.id} · ${live ? 'LIVE' : 'test/sandbox'}`);
if (live) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question('This creates real products in the LIVE account above. Type "live" to continue: ');
  rl.close(); if (a.trim() !== 'live') { console.log('Cancelled.'); process.exit(1); }
}

for (const [plan, [name, desc, cents, interval]] of Object.entries(PLANS)) {
  const pid = `drivefx_pro_${plan}`, key = `drivefx_${plan}`;
  try { stripe('products', 'retrieve', pid); console.log(`product ${pid}: exists`); }
  catch (e) { if (!e.notFound) throw e; stripe('products', 'create', ...D({ id: pid, name, description: desc, 'metadata[app]': 'drivefx', 'metadata[plan]': plan })); console.log(`product ${pid}: created`); }
  const have = stripe('prices', 'list', ...D({ 'lookup_keys[]': key, active: 'true' })).data;
  if (have.length) { console.log(`price ${key}: exists (${have[0].id})`); continue; }
  const p = { product: pid, currency: 'usd', unit_amount: cents, tax_behavior: TAX_BEHAVIOR, lookup_key: key, 'metadata[app]': 'drivefx',
    'currency_options[eur][unit_amount]': cents, 'currency_options[eur][tax_behavior]': TAX_BEHAVIOR,
    'currency_options[gbp][unit_amount]': cents, 'currency_options[gbp][tax_behavior]': TAX_BEHAVIOR };
  if (interval) p['recurring[interval]'] = interval;
  const r = stripe('prices', 'create', ...D(p));
  console.log(`price ${key}: created (${r.id}) ${cents / 100} USD / EUR / GBP${interval ? ' per ' + interval : ' one-time'}`);
}

// billing portal: cancel at period end, card update, invoices, and an email login page
const cfgs = stripe('get', '/v1/billing_portal/configurations', ...D({ active: 'true', limit: 20 })).data;
if (cfgs.some(c => c.metadata?.app === 'drivefx')) console.log('billing portal: exists');
else {
  const r = stripe('billing_portal', 'configurations', 'create', ...D({
    'metadata[app]': 'drivefx',
    'business_profile[headline]': 'DriveFX Pro: manage your subscription',
    'features[subscription_cancel][enabled]': 'true',
    'features[subscription_cancel][mode]': 'at_period_end',
    'features[subscription_cancel][cancellation_reason][enabled]': 'true',
    'features[subscription_cancel][cancellation_reason][options][0]': 'too_expensive',
    'features[subscription_cancel][cancellation_reason][options][1]': 'missing_features',
    'features[subscription_cancel][cancellation_reason][options][2]': 'unused',
    'features[subscription_cancel][cancellation_reason][options][3]': 'other',
    'features[payment_method_update][enabled]': 'true',
    'features[invoice_history][enabled]': 'true',
    'login_page[enabled]': 'true',
  }));
  console.log(`billing portal: created (${r.id}) login page: ${r.login_page?.url || '-'}`);
}

if (hook) {
  const events = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'invoice.paid', 'invoice.payment_failed', 'customer.subscription.updated', 'customer.subscription.deleted', 'charge.refunded', 'charge.dispute.created'];
  const existing = stripe('webhook_endpoints', 'list', ...D({ limit: 50 })).data.find(w => w.url === hook);
  if (existing) console.log(`webhook ${hook}: exists (${existing.id})`);
  else {
    const r = stripe('webhook_endpoints', 'create', ...D({ url: hook, api_version: API_VERSION, description: 'DriveFX license server', ...Object.fromEntries(events.map((e, i) => [`enabled_events[${i}]`, e])) }));
    console.log(`webhook ${hook}: created (${r.id})\nSigning secret (shown once, store it with: wrangler secret put STRIPE_WEBHOOK_SECRET):\n${r.secret}`);
  }
}
console.log('Done.');
