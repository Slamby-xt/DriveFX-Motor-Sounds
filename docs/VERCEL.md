# DriveFX release runbook

Vercel serves the static cockpit and the same-origin license API. Neon Postgres stores licenses and trial usage. Stripe Managed Payments handles checkout through Link. The production domain remains `https://drivefx.pro` and `www.drivefx.pro` redirects with the original path.

## Current service layout

| Environment | Vercel | Neon Postgres | Stripe |
| --- | --- | --- | --- |
| Production | [COHEX / drivefx](https://vercel.com/cohex/drivefx), Production at [drivefx.pro](https://drivefx.pro). | `drivefx-production`, London, marker `prod`. | Dedicated **DriveFX** live account. Signed webhook at `https://drivefx.pro/stripe-webhook`. Customer order and cancellation flow uses [Link](https://app.link.com/). |
| Preview | Protected Preview deployments of the same project. Find the latest build under **Deployments**. | `drivefx-staging`, London, marker `sandbox`. Previews share staging data. | **DriveFX sandbox** under the dedicated DriveFX account. The sandbox endpoint targets the protected deployment at host `drivefx-ucpr9cfse-cohex.vercel.app`. Locate the full endpoint privately in Stripe. The existing destination continues to run the webhook code on that deployment. To test webhook code changes, use a new sandbox destination against the changed Preview, or a local Stripe listener. Keep the current destination deployment available until a replacement is verified. |
| Local | Node.js 22 with `vercel dev` for Vercel routes, or a static server for the cockpit. | A sandbox connection for integration work, or a disposable local database for Postgres tests. | Sandbox credentials and a signing secret from the local Stripe listener for local webhook testing. |

Find both Neon resources under **COHEX → Storage** in Vercel and open the resource to manage it in Neon. The resources can show **Not connected** because the app uses separately managed runtime connection strings in Vercel. Connecting a resource in the Marketplace can inject database-owner credentials. Keep the current runtime setup unless intentionally replacing it.

Vercel does not pull this GitHub repository automatically. Maintain the domain records in one.com and the custom domain assignment in [Vercel](https://vercel.com/cohex/drivefx/settings/domains). The `www` redirect preserves the path. If DNS ever needs a change, use the current project-specific records shown by Vercel and check the site and redirect afterward.

## Rebuild the databases

Use these steps when replacing an environment or provisioning a new one. Treat Production as live data. Before a database replacement, take a custom-format backup with `pg_dump --format=custom` over the same verified direct connection used for migrations. Store the encrypted dump privately and verify it by restoring into a separate database.

1. Create two separate Neon Free projects in the COHEX Vercel Marketplace integration, one for production and one for staging and development. Choose the same region for both and keep Neon Auth, Realtime, and the Data API disabled. The current London projects are `drivefx-production` and `drivefx-staging`.
2. Keep the resource's owner connection out of Vercel Preview and Production. In Neon, get the direct connection details as the database owner. If using the Marketplace CLI to retrieve the connection details, temporarily connect one resource to Development only with a dedicated prefix, pull the values into a protected file outside the repo, and disconnect the resource before repeating for the other project. Keep owner credentials out of source, commands printed to logs, and the deployed app.
3. Apply [the versioned migration](../db/migrations/202611210001_drivefx.sql) once per project and record the migration version and target. Use a direct, certificate-verified connection. The migration assumes a dedicated database and revokes `PUBLIC` access to the `public` schema. Use `psql` with verified TLS and enter the owner password when prompted:

   ```sh
   psql 'host=<direct-neon-host> port=5432 dbname=neondb user=<owner> sslmode=verify-full sslrootcert=<ca-file>' \
     -W -v ON_ERROR_STOP=1 -f db/migrations/202611210001_drivefx.sql
   ```

4. Open an interactive owner `psql` connection with the same parameters. Set a different strong role password on each database using `\password drivefx_app`. On the production database only, run:

   ```sql
   UPDATE drivefx.environment SET name = 'prod';
   ```

5. Test the [Neon transaction pooler](https://neon.com/docs/connect/connection-pooling) with the runtime username `drivefx_app`, default Postgres port `5432`, and verified TLS. Confirm `SELECT current_user, name FROM drivefx.environment;` returns `drivefx_app` and the intended marker. Verify that reads and writes in a rollback-only transaction succeed, writes to `drivefx.environment` are denied, and the runtime role cannot access another application's schema or inherit Neon administrative privileges.
6. Vercel Cron calls `/internal/cleanup` daily around 03:15 UTC on the production deployment and sends that environment's `CRON_SECRET` as a bearer token. Exercise the same endpoint manually on Preview using the Preview secret because Vercel schedules jobs for production deployments. Verify a test expired row is removed, a fresh row survives, and a request without the token returns 401. The job removes expired transient records only. Trial entries expire after 400 days without increased usage, daily trial counters after two days, admin and checkout rate counters after 15 minutes and one hour, event markers after seven days, webhook leases after 90 seconds, and checkout attempts after 45 minutes. Licenses, purchase mappings, reversals, and billing jobs remain durable. [Vercel Cron guide](https://vercel.com/docs/cron-jobs/manage-cron-jobs)

## Configure the COHEX Vercel project

Link a clean checkout with `vercel link --scope cohex --project drivefx`. Use Node.js 22 and keep Vercel system environment variables enabled so `VERCEL_ENV` is available. Manage credentials under [Vercel → Environment Variables](https://vercel.com/cohex/drivefx/settings/environment-variables). The repository's [environment template](../.env.example) contains placeholders. Server deployments capture the environment at deploy time, so publish a fresh deployment to apply changes.

| Variable | Preview | Production |
| --- | --- | --- |
| `DATA_PREFIX` | `sandbox` | `prod` |
| `DRIVEFX_DATABASE_URL` | Restricted `drivefx_app` connection to the staging pooler | Separate restricted `drivefx_app` connection to the production pooler |
| `DRIVEFX_DATABASE_CA` | Unset for Neon | Unset for Neon |
| `CRON_SECRET` | Separate random value of at least 32 characters for manual cleanup testing | Separate random value of at least 32 characters used by Vercel Cron |
| `ADMIN_TOKEN` | Random staging admin token, 32+ printable characters without spaces | Separate random production admin token, 32+ printable characters without spaces |
| `TRIAL_PEPPER` | Stable random staging value of at least 32 characters | Separate stable random production value of at least 32 characters |
| `STRIPE_KEY` | Restricted API key from **DriveFX sandbox** | Restricted API key from **DriveFX** live mode |
| `STRIPE_WEBHOOK_SECRET` | Signing secret from the sandbox event destination | Signing secret from the apex live event destination |
| `STRIPE_PORTAL_MODE` | Unset. Uses the configured sandbox billing portal. | `link` |
| `TERMS_CONSENT` | Unset. Set to `1` on a fresh Preview when explicitly testing required checkout consent. | `1` |
| `CHECKOUT_ENABLED` | `1` | `1` |
| `MANAGED_PAYMENTS_COUNTRY_GATE_VERIFIED` | Unset | `1` for the verified first-purchase rule. See the renewal exception below. |

Enter a replacement secret in Vercel as a sensitive variable for the matching environment. Store local sandbox credentials in a gitignored `.env.local`. Keep secret values out of command-line arguments, logs, browser bundles and GitHub. If a Stripe webhook URL includes the Vercel automation bypass token, store that URL only in Stripe and share only its hostname or a redacted form. Manage the bypass token under **Vercel → Settings → Deployment Protection**.

To rotate a Stripe API key, create a replacement restricted key in the same mode, update `STRIPE_KEY`, deploy and verify checkout, then revoke the old key. To rotate a webhook signing secret, use the overlap window offered by Stripe if available. Update `STRIPE_WEBHOOK_SECRET`, redeploy, verify signed delivery in Stripe, then retire the old secret. Rotate the Neon app password and its Vercel connection string together during a maintenance window. Coordinate a replacement `ADMIN_TOKEN` with support operators and verify admin access. Rotate `CRON_SECRET` per environment and check the next cleanup run. Rotating `TRIAL_PEPPER` resets trial recognition and network counters.

Use `postgresql://drivefx_app:<percent-encoded-password>@<neon-pooled-host>/neondb` without query parameters. The provider hostname starts with `ep-`, ends in `.neon.tech`, and has `-pooler` at the end of its first segment. The app uses parameterized queries without named prepared statements, verifies TLS, and compares the actual database's role and marker to its expected environment. Leave `DRIVEFX_DATABASE_CA` unset for Neon so Node uses its trusted roots. A custom CA PEM replaces those roots. Verify the hostname against the Neon Connect dialog. A loopback connection is available for local tests or development. Keep database owner credentials, live keys and personal data out of code, logs and shared evidence. Admin and checkout rate limits group Vercel-provided IPv4 addresses by /24 and IPv6 by /48. Requests without a valid Vercel IP share a fallback budget. Any client-provided forwarding headers have no effect on that budget.

For the runtime restricted Stripe key, configure Checkout Sessions and Subscriptions read/write and Customers, Payment Intents, Charges, Prices, Products, Invoices/Invoice Payments and Billing Portal configurations read as applicable. Verify the names and effective permissions in the selected account. Use an account operator's Stripe CLI profile for sandbox provisioning. Keep those privileges separate from the app key.

## Stage in the dedicated Stripe sandbox

1. Select the newer sandbox linked to the dedicated DriveFX account. In Stripe Dashboard enable Managed Payments, configure terms and privacy links (`https://drivefx.pro/terms.html`), and check the support and business profile. The Cohex sandbox contains older products and is outside this rollout.
2. With Stripe CLI set to the dedicated sandbox, run `node tools/stripe-setup.mjs --account <sandbox_acct_id>`. It finds existing prices by lookup key, reuses an existing matching product such as a Dashboard-created Monthly, and creates missing sandbox catalogue entries and the portal. Rerun with `--check --portal` to audit them. Confirm `txcd_10103000`, inclusive tax, and the same nominal amounts in GBP, USD and EUR. The lookup keys are `drivefx_monthly` (2.99), `drivefx_yearly` (29.99) and `drivefx_lifetime` (49.99).
3. Deploy a safe test snapshot with `npx vercel deploy`. Assign a stable sandbox preview URL. Choose a preview URL Stripe can reach under the team's approved Deployment Protection configuration. Verify the staging API reads and writes the sandbox database using a staging-only admin grant before connecting Stripe. A protected preview may require Vercel's [automation bypass](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation) in the endpoint URL. In that case configure it privately in Stripe Dashboard and avoid publishing the webhook URL or bypass secret.
4. Under the same sandbox, add the staging `/stripe-webhook` endpoint in Stripe Dashboard at API version `2026-02-25.clover`. A preview URL that Stripe can reach directly can also be provisioned with `node tools/stripe-setup.mjs --account <sandbox_acct_id> --webhook https://<preview-host>/stripe-webhook`. Use these events:

   - `checkout.session.completed`, `checkout.session.async_payment_succeeded`
   - `invoice.paid`, `invoice.payment_failed`
   - `customer.subscription.updated`, `customer.subscription.deleted`
   - `charge.refunded`, `charge.dispute.created`

   Copy the endpoint's signing secret directly into Vercel Preview and deploy again. With `vercel dev`, use a separate local test endpoint secret from `stripe listen --forward-to localhost:3000/stripe-webhook`. Enable sandbox Checkout only after these settings are in place.
5. Use real Managed Payments sandbox Checkout sessions to test monthly, yearly and Lifetime from networks in the GBP, EUR and USD pricing regions. Compare the advertised amount, hosted Checkout currency and tax-inclusive total with the invoice/receipt in each combination. Managed Payments always enables Adaptive Pricing, so check how Checkout behaves when the server-assigned currency differs from Stripe’s presentment currency and whether the charged presentment currency and total remain as advertised. Verify the payment's Managed Payments classification, successful signed delivery in Stripe's Dashboard and the same device unlocking from a browser or phone QR. A CLI synthetic sample can test handler plumbing; use genuine sandbox payments to verify object shape, receipt and tax behavior.
6. Test renewal, a failed payment, scheduled cancellation, end of period, Lifetime upgrade, a full and partial refund, dispute delivery, both eligible and ineligible payment attempts, and a webhook retry. In the configured staging portal flow, confirm that sign-in, subscription, payment methods, invoices and cancellation are visible for Managed Payments purchases. Link is the documented order management flow at [app.link.com](https://app.link.com). Stripe sends receipt and invoice emails through Link and controls their content. Preview sandbox receipts manually and verify the customer can save the DriveFX ID on the confirmation page or recover through admin lookup and relink. Link sandbox purchases do not appear in the Link app. Record that limitation and use the Dashboard and any working sandbox Stripe portal flow for the rehearsal. Inspect Checkout, confirmation, receipt email and PDF, invoice, portal, Link and support surfaces for the correct seller and support details. Verify they do not expose the owner's home address. Replace the existing contact with the dedicated support email when the owner supplies it. [Stripe customer flow and sandbox limits](https://docs.stripe.com/payments/managed-payments/how-it-works).

## Production sales

Monthly, Yearly and Lifetime are live. The DriveFX Stripe account uses **Managed Payments** and **Radar Plus pay as you go**. The plan page shows screening charges and usage. At launch, Stripe showed trial rates through 22 December 2026. Viewing the DriveFX paywall does not trigger a Radar fee. A screened payment attempt can incur a fee even when Stripe declines it. Check billing under **Stripe → Settings → Plans and fees → Radar**.

The live rule **DriveFX covered billing countries** is a **Block** rule at 100% rollout. It rejects missing billing countries and countries outside the list below.

| Market | Billing country codes |
| --- | --- |
| North America | CA, MX, US |
| UK and other European markets | CH, GB, IS, LI, NO |
| European Union | AT, BE, BG, CY, CZ, DE, DK, EE, ES, FI, FR, GR, HR, HU, IE, IT, LT, LU, LV, MT, NL, PL, PT, RO, SE, SI, SK |
| Gulf | KW, QA, SA |
| Asia-Pacific | AU, HK, JP, KR, MY, NZ, SG, TW |

To change the list, confirm [Stripe tax coverage](https://docs.stripe.com/payments/managed-payments/tax-compliance), test the change in the dedicated sandbox and verify there are no Allow rules that override the block. Stripe documents the [billing-country rule](https://support.stripe.com/questions/block-payments-from-tax-unsupported-countries-using-radar). Vercel's IP country determines the price currency for the device opening checkout. If a phone opens a QR link from a different pricing region, verify that it shows the new price before starting Checkout.

**Renewal exception.** Sandbox testing confirmed a UK first purchase, UK renewal, and full refund. The refund removed Pro access. A new Colombian purchase was blocked by the country rule. A separate sandbox renewal in an uncovered market succeeded and produced an invoice with issuer `self` and taxability reason `not_collecting`. The owner approved keeping all plans live and handling any resulting tax obligations. Review the invoice country, issuer and tax details in Stripe if this happens on a live renewal. Treat the Vercel flag as verification of the new-purchase rule only.

The production release verified all three plans by opening unpaid live Checkout Sessions and checking price, currency, tax-inclusive configuration and required terms consent. The verification sessions were expired unpaid. The release checks also confirmed that unsigned webhooks are rejected and that a sandbox license is absent from Production. Check signed delivery, the customer-facing receipt and tax outcome when the first genuine payments arrive. Use the sandbox for purchases, refunds and other tests. [Stripe testing guide](https://docs.stripe.com/testing)

## Deploy, pause and roll back

1. Check out the reviewed commit. Run `npm ci`, `npm test` and `npm run build`. Link with `vercel link --scope cohex --project drivefx` and create a protected Preview with `vercel deploy --scope cohex`.
2. Test the affected flows in Preview and confirm Stripe and Neon are in the sandbox environment. Verify webhook delivery if the release changes billing or the webhook contract.
3. Confirm a clean checkout of the reviewed commit on `main` and the COHEX Vercel project. Verify production settings and run `vercel deploy --scope cohex --prod` to build with Production settings. Checkout requires `CHECKOUT_ENABLED=1`, `MANAGED_PAYMENTS_COUNTRY_GATE_VERIFIED=1` and `TERMS_CONSENT=1` in the Production deployment. Check the new deployment is aliased to `drivefx.pro`. Verify `/prices`, the plan links, the Terms and Contact pages, the `www` redirect, and a signed webhook delivery from Stripe when available.
4. To pause new sales, set Production `CHECKOUT_ENABLED=0` and redeploy. `/prices` and `/go` return HTTP 503 when paused. Existing subscriptions, licenses, admin and the webhook continue to work. Already-issued Checkout Sessions may remain open for up to 45 minutes. Expire affected open sessions in the live Stripe account if you need an immediate stop.
5. To roll back, promote a compatible earlier Vercel deployment or redeploy a reviewed commit using the current settings. A promoted deployment keeps its original environment values. After a credential rotation, choose a compatible post-rotation deployment or redeploy. Verify checkout state, the production Neon connection and signed Stripe webhooks. Leave the database and Stripe endpoint intact. Check failed or pending Stripe deliveries after recovery and resend affected events when available.

Pause checkout before downgrading Radar Plus or if Stripe stops applying the rule. Review the Radar plan and verify that the rule is active before reopening checkout. Existing subscriptions continue on Stripe when the site pauses new sales.

### Payment support

Use the Stripe Dashboard to identify exact Checkout Session, PaymentIntent, Invoice and Subscription associations before changing any billing. The [live admin panel](https://drivefx.pro/admin) uses the Production `ADMIN_TOKEN` for manual grants, extensions and revocations. Use **Find by email** and **Move to new ID** to restore access. Paid subscription periods have a two-day grace period. Trial recognition follows the browser and network signals and can treat identical devices on the same network as one. An open compatible browser/QR checkout shares one session. DriveFX saves the selected Stripe price, currency and integration amount in server-set Checkout metadata. Stripe's separate Adaptive Pricing presentment details may show a different currency and amount. Paid renewals use the price bound to their subscription, even when the catalogue lookup key points to a newer price.

A saved Checkout session can be reused until it expires. A Stripe response with a cached create error triggers one recovery attempt while no session has been saved. Two create errors pause compatible requests for 30 seconds before a fresh attempt. DriveFX can refresh unexposed attempts when there is too little time left to create a session within Stripe's 30-minute minimum. Superseded Stripe requests may still create a session internally, but their results cannot be saved or handed to the browser. A saved session is held until its expiry, including if Stripe reports a closed or unavailable session early, to avoid issuing overlapping usable links.

Different plans, currencies or attempt windows can still lead to duplicate completed payments. Identify the charge that funds the current entitlement, preserve the intended purchase and correct any extra subscription or payment through the account's approved refund or cancellation process. Inspect `/status` after the resulting webhooks and reconcile access before closing the support case. The application never automatically issues refunds. Stripe retries pending webhook billing actions. If a retry window has passed, query pending jobs privately as the database owner and reconcile them promptly:

```sql
SELECT key, value->>'operation' AS operation, value->>'sub' AS subscription_id,
       to_timestamp((value->>'queuedAt')::double precision) AS queued_at
FROM drivefx.records
WHERE key LIKE 'billing:%'
ORDER BY queued_at NULLS FIRST;
```

For a `billing:evt_…` job, check the subscription in Stripe, then resend that event from the Stripe Dashboard when available. The job stores the action until Stripe succeeds even if the event marker has expired. For a `billing:admin:DFX-…` job, retry the corresponding revoke from the admin panel. If redelivery is unavailable, use Stripe Dashboard to complete the recorded action and confirm it succeeded before removing the exact job in the database. Keep these records and IDs in the private release environment.

## Local verification

Run `npm ci`, `npm test` and `npm run build` on Node 22. The usual suite uses mocked Stripe. To exercise native Postgres, start a fresh disposable loopback cluster, create a database named `drivefx_test_<suffix>` and pass its owner connection URI in `DRIVEFX_TEST_DATABASE_URL` for `npm test`. The test applies migrations, creates roles and fixtures and refuses existing DriveFX state or non-loopback destinations. Dispose of the cluster when it finishes. Run `npx vercel dev` with sandbox-only values to test local routing and an actual browser. The web build copies the explicit allowlist in `tools/build-public.mjs`, including the AudioWorklet, the cockpit, Terms and `admin/index.html`. Inspect it for server code, secrets or unrelated files before shipping.
