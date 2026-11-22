# DriveFX Motor Sounds

[DriveFX](https://drivefx.pro) is a web dashboard that plays virtual engine sounds as you drive. It uses browser GPS for speed and a Web Audio engine model for sound.

- GPS needs HTTPS or localhost. The engine model simulates firing order, exhaust pulses and pipe resonances for 23 cars.
- The landscape cockpit shows speed and the selected car. **All Cars** opens the garage, and tapping the speed unit switches between km/h and mph.
- **Test Drive** lets you try the sounds while parked using the pedals, speed slider or **Simulate drive**.
- Car photos live in `img/<car id>.jpg`. Cars without a photo display a drawn silhouette.

## Free and Pro

- **Free** has five minutes of engine time and five cars per device. The free cars are the Porsche 911 GT3, Dodge Challenger Hellcat, BMW M3, Ford Mustang Boss 429 and Tesla Roadster. The server records trial usage using the device ID and keyed hashes of device traits and network.
- **Pro** unlocks all cars and unlimited engine time. Monthly is 2.99, Yearly is 29.99, and Lifetime is a one-time 49.99. These are the tax-inclusive base prices in GBP, EUR and USD. DriveFX selects GBP or EUR based on your network country and uses USD elsewhere. Stripe Checkout can offer local currency conversion.
- Pro is tied to a `DFX-XXXX-XXXX` device ID. Save it to restore access. The upgrade button and phone QR code open Stripe Checkout. Stripe's signed webhook confirms payment and updates the license.
- **Manage subscription** opens Link for live orders. For app support, start at [Contact](https://drivefx.pro/contact.html). [Terms & Privacy](https://drivefx.pro/terms.html) covers cancellation, refunds and privacy. Operators can restore or move a license through the [admin panel](https://drivefx.pro/admin).

## Where everything lives

| Service | Current location and role |
| --- | --- |
| Source | [Slamby-xt/DriveFX-Motor-Sounds](https://github.com/Slamby-xt/DriveFX-Motor-Sounds), branch `main`. |
| Hosting | [COHEX → drivefx in Vercel](https://vercel.com/cohex/drivefx). Node.js 22 serves the static cockpit and runs the license, trial, checkout, support and webhook API. Functions run in London (`lhr1`). |
| Domains and DNS | [drivefx.pro](https://drivefx.pro) serves Production. `www.drivefx.pro` redirects to the same path on the main domain. Manage DNS at [one.com](https://www.one.com/) and domain assignment in [Vercel](https://vercel.com/cohex/drivefx/settings/domains). |
| Production database | `drivefx-production`, a Neon Postgres project in London, available through **COHEX → Storage** in Vercel. Stores licenses, trials and payment records. |
| Preview database | `drivefx-staging`, a separate Neon Postgres project in London. Protected Vercel Preview deployments share this test database. |
| Live payments | [Stripe Dashboard](https://dashboard.stripe.com/), account **DriveFX**, live mode. Stripe Managed Payments runs Checkout, customer receipts and Link order support. Stripe Billing processes renewals. The live webhook is `https://drivefx.pro/stripe-webhook`. |
| Test payments | In Stripe, switch to **DriveFX sandbox** under **DriveFX**. Vercel Preview creates sandbox sessions. The sandbox webhook points to a protected Preview deployment configured in Stripe, and its deliveries use the same staging database as other Previews. |

Vercel has no GitHub deployment connection for DriveFX. Merging to `main` records the source. Deploy from the CLI to publish it. GitHub Pages, Cloudflare, Upstash and Supabase are outside the current production stack.

## Secrets and settings

Manage runtime credentials in [Vercel → drivefx → Settings → Environment Variables](https://vercel.com/cohex/drivefx/settings/environment-variables). Production and Preview have separate values. [`.env.example`](.env.example) lists placeholder values for local setup.

| Variable | Where it comes from |
| --- | --- |
| `DRIVEFX_DATABASE_URL` | Neon. Use the matching project's pooled connection and the restricted `drivefx_app` role. Manage database-owner access separately in Neon. |
| `STRIPE_KEY` | Stripe → API keys in the matching environment. Use the restricted DriveFX runtime key. |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Webhooks or Workbench event destinations. Use the signing secret for that environment's endpoint. |
| `ADMIN_TOKEN` | Separate random credential for the DriveFX admin panel in each environment. |
| `TRIAL_PEPPER` | Stable random value for trial and rate-limit hashing. Rotating it resets existing trial recognition. |
| `CRON_SECRET` | Separate random values for the cleanup endpoint. Vercel Cron uses the Production value daily at 03:15 UTC. |

Keep credentials, private database URLs, the Preview protection-bypass token and customer records out of the repository. For full-stack local development, put sandbox values in a gitignored `.env.local`. The [runbook](docs/VERCEL.md) explains the flags, credential rotation and database setup.

## Run and deploy

Use Node.js 22.

```sh
npm ci
npm test
npm run build
```

For the cockpit alone, serve the generated site with `python3 -m http.server 5173 --directory public`. For the API and sandbox checkout, use `vercel dev` with sandbox credentials.

Link the project and create a Preview from a clean checkout of the reviewed commit.

```sh
vercel link --scope cohex --project drivefx
vercel deploy --scope cohex
```

After testing the protected Preview, run `git status --short` and verify the checkout is clean and points to the reviewed commit on `main`. Vercel builds a fresh deployment with Production settings and publishes it to `drivefx.pro`.

```sh
vercel deploy --scope cohex --prod
```

Use a fresh deployment after changing environment variables.

## Operate payments

Production sales are enabled. Stripe Radar Plus checks the billing country for new purchases against the 46-market launch list. Stripe may still charge a renewal when the invoice is outside Managed Payments tax coverage. The owner handles any resulting tax obligations. See the [runbook](docs/VERCEL.md#production-sales) for the country list and the test results.

To pause new sales, set Production `CHECKOUT_ENABLED=0` in Vercel and redeploy. Previously opened Checkout Sessions can stay usable for up to 45 minutes. To stop those sessions immediately, expire them in the live DriveFX Stripe account. Existing subscriptions continue to renew while new sales are paused. See the [release, rollback and support instructions](docs/VERCEL.md#deploy-pause-and-roll-back).

## Code map

- `index.html`, `app.js`, `audio.js` and `engine-worklet.js` run the cockpit and engine audio in the browser.
- `paywall.js` handles plan selection, device IDs and the checkout QR code. Change the public support email in `contact.html` and manage Stripe's escalation email in its business settings.
- `api/index.js` is the Vercel entry point. `server/handler.js`, `server/payments.js`, `server/stripe.js` and `server/store.js` handle routing, payments, Stripe and Postgres.
- [`db/migrations/`](db/migrations/) is the versioned database schema. `tools/build-public.mjs` prepares the public asset bundle. [`vercel.json`](vercel.json) defines routing and the daily cleanup job.
