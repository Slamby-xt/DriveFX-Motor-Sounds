# DriveFX release runbook

Vercel serves the static cockpit and the same-origin license API. Supabase Postgres stores licenses and trial usage. Stripe Managed Payments handles checkout through Link. The production domain remains `https://drivefx.pro` and `www.drivefx.pro` redirects with the original path. The retired Cloudflare Worker is excluded from Vercel.

## Prepare the databases

1. Create two dedicated Supabase projects, one for production and one for staging and development. Select the regions and confirm ownership, backup options, network access and costs with the owner. There is no customer data to import from Upstash.
2. In each project, disable the Data API, leave `drivefx` out of the exposed schemas and enforce SSL. In **Connect**, get the direct or session-mode owner connection details and the shared pooler's transaction endpoint. Use the owner credentials only to apply migrations and administer the schema.
3. Apply [the versioned migration](../supabase/migrations/202611210001_drivefx.sql) once per project. Record the migration version and target project in the release record. The migration is for these dedicated projects. It revokes `PUBLIC` access to the `public` schema, which can affect other applications sharing the database. It also explicitly revokes DriveFX access from the Supabase Data API roles. Use `psql` with TLS server verification and enter the owner password when prompted:

   ```sh
   psql 'host=<owner-host> port=<owner-port> dbname=postgres user=<owner-user> sslmode=verify-full sslrootcert=<ca-file>' \
     -W -v ON_ERROR_STOP=1 -f supabase/migrations/202611210001_drivefx.sql
   ```

4. Open an interactive owner `psql` connection with the same parameters. Set a different strong role password on each database using `\password drivefx_app`. On the production database only, run:

   ```sql
   UPDATE drivefx.environment SET name = 'prod';
   ```

5. For each project, schedule a daily SQL job through [Supabase Cron](https://supabase.com/docs/guides/cron). Run `DELETE FROM drivefx.transient WHERE expires_at <= now();` as the owner. Verify a test expired row is removed and the job succeeds. Application reads and atomic writes already honor each row's expiry. Trial entries expire after 400 days without increased usage, daily new-trial counters after two days, admin and checkout rate counters after 15 minutes and one hour, event markers after seven days, webhook leases after 90 seconds, and Checkout attempts after 45 minutes. Licenses, exact payment maps, reversals, and pending billing jobs are durable.
6. Test the transaction pooler with the runtime username `drivefx_app.<project-ref>`, port `6543` and verified TLS. Confirm `SELECT current_user, name FROM drivefx.environment;` returns `drivefx_app` and the expected marker. Verify that reading/writing DriveFX's records works in a rollback-only transaction, that access to other application schemas and writes to `drivefx.environment` are denied, and that `anon`, `authenticated` and `service_role` have no DriveFX schema and table permissions through the Data API. Review inherited grants on any other non-system schemas or objects in the dedicated project. Supabase documents the [connection and certificate settings](https://supabase.com/docs/guides/database/connecting-to-postgres).

## Configure the COHEX Vercel project

Run `npx vercel link --scope <cohex-team-slug> --project <drivefx-project>` after checking the team and project in the Dashboard. Use Node 22 and enable the Vercel system environment variables so `VERCEL_ENV` is available. Set values by environment in the Dashboard or use `npx vercel env add <NAME> <environment> --sensitive` for credentials. Enter secrets via the prompt or paste into the Dashboard. Where sensitive variables aren't available for local development, keep the development values in a gitignored `.env.local`.

| Variable | Preview / development | Production |
| --- | --- | --- |
| `DATA_PREFIX` | `sandbox` | `prod` |
| `DRIVEFX_DATABASE_URL` | Staging transaction pooler credential | Production transaction pooler credential |
| `DRIVEFX_DATABASE_CA` | Trusted CA PEM when required | Trusted CA PEM when required |
| `ADMIN_TOKEN` | Random staging value, 32+ characters | Different random value, 32+ characters |
| `TRIAL_PEPPER` | Stable random staging value, 32+ characters | Different stable random value, 32+ characters |
| `STRIPE_KEY` | Dedicated DriveFX sandbox restricted key | Dedicated DriveFX live restricted key |
| `STRIPE_WEBHOOK_SECRET` | The deployed sandbox endpoint's secret | The apex live endpoint's secret |
| `STRIPE_PORTAL_MODE` | `link` for Link, or unset for the configured Stripe portal | Select the sandbox-verified flow |
| `TERMS_CONSENT` | `1` after configuring the Terms URL | `1` after verifying the checkout consent flow |
| `CHECKOUT_ENABLED` | `1` for sandbox checkout | Keep `0` for the initial production deployment |
| `MANAGED_PAYMENTS_COUNTRY_GATE_VERIFIED` | Unset | Keep `0` until the separately approved sales launch |

Use `postgresql://drivefx_app.<project-ref>:<percent-encoded-password>@<shared-pooler-host>:6543/postgres` without query parameters. The app uses parameterized queries without named prepared statements, verifies TLS, and compares the actual database's role and marker to its expected environment. If Node does not trust the pooler's certificate chain, use the CA PEM for that project from the Supabase Dashboard and paste the complete multiline certificate into `DRIVEFX_DATABASE_CA`. Verify the hostname against the Supabase Connect dialog. A loopback connection is available for local tests or development. Keep database owner credentials, live keys and personal data out of code, logs and shared evidence. Rotating `TRIAL_PEPPER` resets existing trial recognition and network counters. Admin and checkout rate limits group Vercel-provided IPv4 addresses by /24 and IPv6 by /48. Requests without a valid Vercel IP share a fallback budget. Any client-provided forwarding headers have no effect on that budget.

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
5. Use real Managed Payments sandbox Checkout sessions to test monthly, yearly and Lifetime with all three explicit currencies. Compare the advertised amount, hosted Checkout currency and tax-inclusive total with the invoice/receipt in each combination. Managed Payments always enables Adaptive Pricing, so check how Checkout behaves when the selected currency differs from the customer's location and whether the charged presentment currency and total remain as advertised. Verify the payment's Managed Payments classification, successful signed delivery in Stripe's Dashboard and the same device unlocking from a browser or phone QR. A CLI synthetic sample can test handler plumbing; use genuine sandbox payments to verify object shape, receipt and tax behavior.
6. Test renewal, a failed payment, scheduled cancellation, end of period, Lifetime upgrade, a full and partial refund, dispute delivery, both eligible and ineligible payment attempts, and a webhook retry. In the configured staging portal flow, confirm that sign-in, subscription, payment methods, invoices and cancellation are visible for Managed Payments purchases. Link is the documented order management flow at [app.link.com](https://app.link.com). Stripe sends receipt and invoice emails through Link and controls their content. Preview sandbox receipts manually and verify the customer can save the DriveFX ID on the confirmation page or recover through admin lookup and relink. Link sandbox purchases do not appear in the Link app. Record that limitation and use the Dashboard and any working sandbox Stripe portal flow for the rehearsal. Inspect Checkout, confirmation, receipt email and PDF, invoice, portal, Link and support surfaces for the correct seller and support details. Verify they do not expose the owner's home address. Replace the existing contact with the dedicated support email when the owner supplies it. [Stripe customer flow and sandbox limits](https://docs.stripe.com/payments/managed-payments/how-it-works).

## Production sales gate

Stripe can process some Managed Payments transactions for which it does not assume indirect tax responsibility. DriveFX sales require Stripe to assume that responsibility. Vercel's IP country is a currency hint. Stripe's published [tax coverage](https://docs.stripe.com/payments/managed-payments/tax-compliance) and its [Radar rule for unsupported countries](https://support.stripe.com/questions/block-payments-from-tax-unsupported-countries-using-radar) control the rollout decision:

1. Obtain separate approval before enabling a paid Radar Plus or Pro plan or changing the live account. Stripe documents that the Managed Payments billing address provides the country for tax calculation and is customer-declared. In the dedicated sandbox, configure a Radar **Block** rule that rejects missing countries and countries outside the approved coverage list. Stripe's example uses this pattern:

   ```text
   Block if is_missing(:billing_address_country:) OR NOT (:billing_address_country: IN ('GB', 'DE', 'US'))
   ```

   The three entries illustrate the syntax. Build and record the intended allowlist from Stripe's current tax coverage and the account's business location and eligibility. Check any jurisdiction-specific exceptions and payment-method coverage with Stripe. Review earlier Radar rules or lists that could allow a payment to bypass the block.
2. Confirm sandbox sales succeed using supported billing locations and that a Colombia (CO) billing address is blocked before payment, including from a supported IP. Verify missing-country handling and all enabled payment paths, including Link, wallets and local payment methods where applicable. Test subscription renewals and address changes, including changes to an unsupported billing country. Confirm Stripe's collected country corresponds to the tax location on the tested flows and prove that each enabled path enforces the same restriction. Disable unverified paths in the Stripe Dashboard if the account supports that control.
3. If account eligibility, paid Radar approval, any payment path or renewal restriction, the three advertised currencies and totals, or the customer-facing privacy checks remain unresolved, keep `CHECKOUT_ENABLED=0` and leave the country verification flag unset or at `0`. Portal, licenses, admin and signed webhooks remain available while `/prices` and `/go` return 503, so the purchase UI stays paused.
4. After the owner approves launch and sandbox verification is recorded, apply and verify the same allowlist and payment-method settings in the live account. Review coverage periodically and after any Stripe notice, account or payment method change. Before enabling sales, get the owner's approval of the published Terms and refund policy and verify the checkout consent wording and control with the applicable legal review. Keep sales paused if the required consent cannot be collected on an enabled checkout path. The separate sales enablement deployment sets both `MANAGED_PAYMENTS_COUNTRY_GATE_VERIFIED=1` and `CHECKOUT_ENABLED=1`. Vercel applies changed environment variables on a fresh deployment.

## Production cutover, pause and rollback

1. Confirm which team owns the existing assignment of both domains before changing them. Audit the existing live catalogue on the dedicated account with `node tools/stripe-setup.mjs --live --account <live_acct_id>`. The script performs GET requests in live mode. Reuse the live catalogue. Configure the live webhook at `https://drivefx.pro/stripe-webhook` only at the approved release, using the same API version and event set. Vercel should accept it directly at the apex.
2. Deploy production with checkout paused using `npx vercel deploy --prod` after confirming scope, environment and ownership. If domain assignment blocks deployment, coordinate reassignment with the current owner. If DNS records must change, read the exact expected apex A, www CNAME, and any TXT verification record from the target Vercel project. Give those exact values to the owner to apply at one.com. Record the old assignment and DNS values before the change.
3. Verify apex HTTPS, the path-preserving www redirect, static assets, `/admin`, `/status`, a trial write, paused Checkout, the configured portal, and rejection of invalid webhook signatures. Check Stripe endpoint delivery and monitor the first genuine Managed Payments event and order after sales are separately enabled. Use a non-customer test ID for smoke tests.
4. To pause new sales, set Production `CHECKOUT_ENABLED=0` and redeploy immediately. Previously issued Checkout Sessions may still be open for up to 45 minutes. During an immediate payment stop, expire affected open sessions on the dedicated account through Stripe and verify the country block remains enforced. Pausing new sales leaves existing subscription billing and webhook acceptance intact.
5. To roll back, promote a known compatible Postgres/Managed Payments Vercel deployment whose sales flags are appropriate for the incident. Keep the database and webhook endpoint intact, and confirm the promoted deployment still uses the production role and signing secret. Avoid promoting the old Redis deployment once Postgres has accepted writes. For a domain reversal, coordinate the reassignment and restore the exact recorded DNS values. Track 5xx or pending delivery in Stripe and resend after the fix if needed.

### Payment support

Use the Stripe Dashboard to identify exact Checkout Session, PaymentIntent, Invoice and Subscription associations before changing any billing. Use the admin **Find by email** and **Move to new ID** actions to restore access. An open compatible browser/QR checkout shares one session. DriveFX saves the selected Stripe price, currency and integration amount in server-set Checkout metadata. Stripe's separate Adaptive Pricing presentment details may show a different currency and amount. Paid renewals use the price bound to their subscription, even when the catalogue lookup key points to a newer price.

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
