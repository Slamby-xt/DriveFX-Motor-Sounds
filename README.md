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
- **Free minutes are counted on the server too** (`POST /trial` in `server/handler.js`), by device ID and by a hash of device traits + network, so clearing cookies or opening a private window on the same device and network does not give a new trial. Only keyed hashes are stored. Known limits: someone who changes device, browser or network, or edits the page's code, gets a fresh trial; identical devices on one network (e.g. cloned school laptops) share one trial; new trials are capped by network using atomic Postgres counters.

## Payments and hosting

- DriveFX Pro uses Stripe Managed Payments Checkout. Monthly (2.99), Yearly (29.99), and Lifetime (49.99) have tax-inclusive USD, EUR and GBP prices. The price display suggests a currency from Vercel's IP country and lets the customer change it.
- The pay button and QR code open the same checkout route. A signed Stripe webhook grants Pro after payment. Subscriptions include two days of paid-period grace. Full refunds and disputes apply to the matching purchase.
- **Manage subscription** opens Link or the configured Stripe billing portal. Save the ID shown on the confirmation page to restore access. For a lost ID, the admin panel can look up the purchase by email and move it to a new ID.
- Vercel serves the static app and license API. Neon Postgres stores licenses and the trial ledger. The admin panel supports manual grants, extensions and revocations.
- Production sales start paused. The release steps, separate Stripe and Neon environments, and verification requirements are in the [Vercel runbook](docs/VERCEL.md). Run `npm test` and `npm run build` on Node 22 for local verification.
