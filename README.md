# DriveFX Motor Sounds

Futuristic web dashboard that revs a virtual engine from your real driving speed (browser GPS).

- Speed from `navigator.geolocation` (GPS needs HTTPS or localhost)
- 23 real cars; engine sounds come from a per-sample engine model (`engine-worklet.js`: firing order, exhaust pulses, pipe resonances), no recordings
- Car photos live in `img/<car id>.jpg` (1280×720); a car without a photo shows a drawn silhouette
- One-screen cockpit for landscape car displays (Tesla): speed, the selected car with previous/next arrows, Start and volume. ALL CARS opens the garage to pick any car in one tap; km/h and mph switch by tapping the unit
- Test drive mode (TEST DRIVE tab): gas/brake pedals, speed slider and "Simulate drive" for hearing the engine while parked

Run locally: `python -m http.server 5173` and open http://localhost:5173

## Free and Pro

- **Free:** 5 cars (Porsche 911 GT3, Dodge Challenger Hellcat, BMW M3, Ford Mustang Boss 429, Tesla Roadster) and 5 minutes of engine time per device. The free cars are the ones marked `free: true` in `app.js`.
- **Pro:** every car, no time limit. $2.99 / month, $29.99 / year or $49.99 lifetime (prices are in `PLANS` in `paywall.js`).
- A Pro license belongs to the browser's device ID (`DFX-XXXX-XXXX`). Choosing a Pro car, or running out of free time, opens the upgrade window with the three plans and a QR code to pay from a phone.
- **Free minutes are counted on the server too** (`POST /trial` in `server/handler.js`), by device ID and by a hash of device traits + network, so clearing cookies or opening a private window on the same device and network does not give a new trial. Only keyed hashes are stored. Known limits: someone who changes device, browser or network, or edits the page's code, gets a fresh trial; identical devices on one network (e.g. cloned school laptops) share one trial; the per-network cap is best-effort under bursts (counters are atomic in Redis).

## Payments (Stripe)

- Three Stripe products (`DriveFX Pro Monthly`, `Yearly` = subscriptions that renew automatically, `Lifetime` = one payment). Each price has the same number in USD, EUR and GBP (2.99 / 29.99 / 49.99). `tools/stripe-setup.mjs` creates them (and the billing portal and webhook) in a sandbox or live; it is safe to re-run.
- The currency is suggested from the visitor's country (eurozone: EUR, UK: GBP, everyone else: USD) and can be switched in the payment window.
- Pay button and QR code open `GET /go` on the license server, which creates a Stripe Checkout session. Stripe calls `POST /stripe-webhook`, which grants Pro until the paid period ends (+2 days); full refunds and disputes revoke it; Lifetime is never downgraded by a renewal.
- Cancel / change card / invoices: **Manage subscription** in the Pro window opens Stripe's billing portal login page: Stripe emails the customer a sign-in link, so a device ID alone never opens anyone's billing. Cancelling keeps Pro until the paid period ends.
- Lost ID: the ID is on the Stripe receipt and the success page; otherwise admin panel > "Find by email" > "Move to new ID".
- Server-only Vercel environment variables (see `.env.example`, `docs/VERCEL.md`): `STRIPE_KEY` (restricted key), `STRIPE_WEBHOOK_SECRET`, `TRIAL_PEPPER`. Optional vars: `TAX=1` (Stripe Tax at checkout), `TERMS_CONSENT=1` (terms checkbox; set the terms URL `https://drivefx.pro/terms.html` in the Stripe dashboard first).
- Local testing: `npm test` (in-memory store + fake Stripe); `npx vercel dev` with `vercel env pull` for a real run, and `stripe listen --forward-to localhost:3000/stripe-webhook` (use that listener's own secret locally only).

The admin panel still works for manual grants and revokes. `terms.html` is a plain-language draft: read it before going live.

Hosting: Vercel (site + `api/` function), data in Upstash Redis; see `docs/VERCEL.md`. License changes run under a Redis lock and webhook events are claimed atomically, so concurrent events cannot double-grant. Still true: buying two subscriptions in parallel from two open checkout pages bills both (refund one by hand in Stripe, then use the admin panel if needed).
