// One-minute Stripe hookup. YOU run it (it asks for your Stripe key, hidden; nothing is written to a file or shown).
//   node tools/finish-stripe.mjs --live     LIVE keys -> Vercel Production, creates products/prices/portal/webhook in the live account
//   node tools/finish-stripe.mjs            TEST (sandbox) keys -> Vercel Preview + Development, products/prices/portal only
// Before: `stripe login` (the account to change) and `npx vercel login` + `npx vercel link` done. Create the key first:
//   Stripe Dashboard > Developers > API keys > Create restricted key, name "DriveFX", permissions (Write unless noted):
//   Checkout Sessions, Customers (Read), Subscriptions, Payment Intents (Read), Charges (Read), Prices (Read), Billing Portal Configurations (Read)
//   (a normal secret key sk_live_/sk_test_ also works, restricted is safer).
import { spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const live = process.argv.includes('--live');
const HOOK = 'https://drivefx.pro/stripe-webhook';
const run = (cmd, input) => spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
const die = m => { console.error('\n' + m); process.exit(1); };

function askHidden(q) {
  return new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(q)) process.stdout.write(s); }; // hide what is typed
    rl.question(q, a => { rl.close(); process.stdout.write('\n'); res(a.trim()); });
  });
}

console.log(`\nDriveFX Stripe hookup (${live ? 'LIVE' : 'TEST / sandbox'})\n----------------------------------`);
if (run('npx --yes vercel whoami').status !== 0) die('Vercel is not logged in. Run: npx vercel login');
const acct = run(`stripe get /v1/account${live ? ' --live' : ''}`);
if (acct.status !== 0 || !acct.stdout.includes('"id"')) die('Stripe CLI is not logged in. Run: stripe login');
console.log('Stripe account:', (acct.stdout.match(/"id":\s*"(acct_[A-Za-z0-9]+)"/) || [])[1] || '?');
if (live) {
  const a = await askHidden('Type "live" to change the LIVE Stripe account and the Production site: ');
  if (a !== 'live') die('Cancelled.');
}

const key = await askHidden(`Paste your ${live ? 'LIVE' : 'TEST'} Stripe key (rk_${live ? 'live' : 'test'}_... or sk_${live ? 'live' : 'test'}_...), hidden: `);
if (!new RegExp(`^(rk|sk)_${live ? 'live' : 'test'}_[A-Za-z0-9]{20,}$`).test(key)) die(`That is not a ${live ? 'live' : 'test'} key.`);

// 1) products, prices, billing portal (+ webhook for live)
const setup = run(`node tools/stripe-setup.mjs${live ? ' --live --webhook ' + HOOK : ''}`, live ? 'live\n' : undefined);
const out = (setup.stdout || '') + (setup.stderr || '');
console.log(out.replace(/whsec_[A-Za-z0-9]+/g, 'whsec_[stored in Vercel, not shown]'));
if (setup.status !== 0) die('tools/stripe-setup.mjs failed (see above). Nothing was written to Vercel.');

// 2) secrets into Vercel (server-only, sensitive: cannot be read back)
const envs = live ? ['production'] : ['preview', 'development'];
const put = (name, value, e) => { const r = run(`npx --yes vercel env add ${name} ${e} --sensitive --force`, value); if (r.status !== 0) die(`Could not set ${name} for ${e}: ${(r.stderr || r.stdout).slice(0, 300)}`); };
for (const e of envs) put('STRIPE_KEY', key, e);
const m = out.match(/(whsec_[A-Za-z0-9]+)/);
if (live) {
  if (m) put('STRIPE_WEBHOOK_SECRET', m[1], 'production');
  else console.log('\nThe webhook endpoint already existed, so Stripe did not show its secret again.\nOpen Stripe Dashboard > Developers > Webhooks > the DriveFX endpoint > Signing secret > Reveal, then run:\n  npx vercel env add STRIPE_WEBHOOK_SECRET production --sensitive');
} else console.log('\nTest mode: for local webhook tests use `stripe listen` (its own secret, local only). A deployed sandbox webhook is not created here.');

// 3) redeploy so the new variables are used
if (live) {
  console.log('\nDeploying to production...');
  const d = run('npx --yes vercel deploy --prod --yes');
  console.log(d.status === 0 ? 'Deployed.' : 'Deploy failed: ' + (d.stderr || d.stdout).slice(0, 400));
}
console.log('\nDone. Check: https://drivefx.pro/prices should return the three plans.');
