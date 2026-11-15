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
- **Free minutes are counted on the server too** (`POST /trial` in `worker/index.js`), by device ID and by a hash of device traits + network, so clearing cookies or opening a private window on the same device and network does not give a new trial. Only keyed hashes are stored. Known limits: someone who changes device, browser or network, or edits the page's code, gets a fresh trial; identical devices on one network (e.g. cloned school laptops) share one trial; the per-network cap is best-effort under bursts because KV has no atomic counter (a Durable Object would fix that).

## Payments: what is left to connect Stripe

1. In Stripe create three products (monthly, yearly, one-time lifetime) and a **Payment Link** for each. Turn on collecting the customer's email.
2. Paste the three `https://buy.stripe.com/...` URLs into `config.js` (`payLinks`). Until they are set the pay button says "PAYMENTS OPEN SOON". The page adds `?client_reference_id=<device ID>` to each link.
3. Add a Stripe webhook that calls `activate(env, id, plan, exp)` in `worker/index.js` (`id` = the `client_reference_id`): `checkout.session.completed` and `invoice.paid` grant (monthly/yearly: until the period end; lifetime: `exp` 0), `customer.subscription.deleted` ends it. Store the Stripe signing secret with `wrangler secret put STRIPE_WEBHOOK_SECRET`.
4. Deploy the worker (`cd worker && npx wrangler deploy`) and set the trial-hash secret once: `npx wrangler secret put TRIAL_PEPPER` (any long random text).

The admin panel still works for manual grants and revokes.
