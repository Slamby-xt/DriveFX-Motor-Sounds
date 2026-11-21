# DriveFX release checklist

Follow the [Vercel, Supabase and Managed Payments runbook](VERCEL.md) for staging, production setup and rollback. The legacy Upstash provisioning and automatic live Stripe deploy are retired.

- [ ] The dedicated DriveFX sandbox, staging Supabase project and COHEX Vercel preview pass the checkout, webhook, renewal, refund, portal and privacy checks.
- [ ] The production Supabase database and runtime role are isolated. Apply the migration and verify transient data cleanup.
- [ ] The owner approves the production cutover. Confirm assignment of both domains and verify the canonical redirect, API and signed webhook with checkout paused.
- [ ] Verify Stripe's country restriction on the dedicated account, the advertised currency and tax-inclusive totals, and customer support details before separately approving public sales.
