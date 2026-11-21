import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const stripeCli = String.raw`
const { readFileSync, writeFileSync } = require('node:fs');
const file = process.env.DRIVEFX_SETUP_TEST_STATE;
const state = JSON.parse(readFileSync(file));
const [method, path, ...args] = process.argv.slice(2);
const fields = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-d') {
    const [name, ...content] = args[++i].split('=');
    fields[name] = content.join('=');
  }
}
const isLive = args.includes('--live');
state.requests.push({ method, path, isLive });
const reply = value => {
  writeFileSync(file, JSON.stringify(state));
  console.log(JSON.stringify(value));
};
const missing = { error: { code: 'resource_missing' } };
if (path === '/v1/account') reply({ id: isLive ? 'acct_DriveFXLive' : 'acct_DriveFXSandbox' });
else if (path === '/v1/products/search') reply({ data: state.products.filter(p => fields.query.includes(p.name)) });
else if (path.startsWith('/v1/products/')) {
  const product = state.products.find(p => p.id === path.split('/').pop());
  if (product && method === 'post') product.tax_code = fields.tax_code;
  reply(product || missing);
} else if (path === '/v1/products') {
  const product = { active: true, id: fields.id, name: fields.name, tax_code: fields.tax_code };
  state.products.push(product);
  reply(product);
} else if (path === '/v1/prices' && method === 'get') {
  const data = state.prices.filter(p => p.lookup_key === fields['lookup_keys[0]']);
  reply({ data });
} else if (path === '/v1/prices') {
  const interval = fields['recurring[interval]'];
  const price = {
    id: 'price_' + fields.lookup_key, active: true, billing_scheme: 'per_unit',
    lookup_key: fields.lookup_key, currency: fields.currency, unit_amount: +fields.unit_amount,
    tax_behavior: fields.tax_behavior, product: state.products.find(p => p.id === fields.product),
    type: interval ? 'recurring' : 'one_time', recurring: { interval, interval_count: 1 },
    currency_options: Object.fromEntries(['eur', 'gbp'].map(c => [c, {
      unit_amount: +fields['currency_options[' + c + '][unit_amount]'],
      tax_behavior: fields['currency_options[' + c + '][tax_behavior]'],
    }])),
  };
  state.prices.push(price);
  reply(price);
} else if (path === '/v1/billing_portal/configurations' && method === 'get') reply({ data: state.portals });
else if (path === '/v1/billing_portal/configurations') {
  const portal = { metadata: { app: fields['metadata[app]'] }, login_page: { enabled: true }, features: {
    invoice_history: { enabled: true }, payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: 'at_period_end' },
  } };
  state.portals.push(portal);
  reply(portal);
} else if (path === '/v1/webhook_endpoints' && method === 'get') reply({ data: state.webhooks });
else if (path === '/v1/webhook_endpoints') {
  const webhook = { url: fields.url, api_version: fields.api_version, status: 'enabled',
    enabled_events: Object.entries(fields).filter(([key]) => key.startsWith('enabled_events')).map(([, value]) => value) };
  state.webhooks.push(webhook);
  reply({ ...webhook, secret: 'whsec_should_stay_hidden' });
} else reply(missing);
`;

test('Stripe setup reuses the Dashboard Monthly product and never writes in live mode', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'drivefx-stripe-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  await writeFile(join(dir, 'stripe'), '#!' + process.execPath + '\n' + stripeCli, { mode: 0o700 });
  await writeFile(file, JSON.stringify({
    requests: [], products: [{ id: 'prod_DashboardMonthly', name: 'DriveFX Pro Monthly', active: true }],
    prices: [], portals: [], webhooks: [],
  }));
  const env = { ...process.env, PATH: dir + delimiter + process.env.PATH, DRIVEFX_SETUP_TEST_STATE: file };
  const setup = (...args) => exec(process.execPath, ['tools/stripe-setup.mjs', ...args], { env });
  const state = async () => JSON.parse(await readFile(file));
  const sandbox = ['--account', 'acct_DriveFXSandbox', '--webhook', 'https://stage.example.invalid/stripe-webhook'];
  const wrong = setup('--account', 'acct_LegacyCohex');
  await assert.rejects(wrong, /does not match/);
  const first = await setup(...sandbox);
  assert.doesNotMatch(first.stdout, /whsec_/);
  assert.equal((await state()).prices[0].product.id, 'prod_DashboardMonthly');
  assert.equal((await state()).products.length, 3);
  assert.equal((await state()).webhooks.length, 1);
  const requests = (await state()).requests.length;
  await setup(...sandbox);
  assert.ok((await state()).requests.slice(requests).every(r => r.method === 'get'));
  await setup('--live', '--account', 'acct_DriveFXLive', '--portal', '--webhook', 'https://stage.example.invalid/stripe-webhook');
  assert.ok((await state()).requests.filter(r => r.isLive).every(r => r.method === 'get'));
});
