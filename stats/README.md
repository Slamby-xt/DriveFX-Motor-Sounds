# DriveFX Stats

Separate, password-protected visitor analytics for drivefx.pro. Own Vercel project (`slamby/drivefx-stats`), live at https://drivefx-stats.vercel.app.

**What it measures:** visitors (unique per day), pageviews, pages, referrers, countries, devices (incl. "Tesla screen"), browsers, operating systems, busiest hours, people online in the last 5 minutes, and optional custom events.

**Privacy:** no cookies, no local storage, no IP addresses or user agents stored. A visitor is a one-way hash of secret salt + UTC day + IP + user agent held in a Redis HyperLogLog, so nobody can be followed across days. Bots are ignored; Do-Not-Track is respected by the tracker. (It is anonymous aggregate statistics; mention it in the privacy section of `terms.html` if you like.)

## Parts
| Path | What |
|---|---|
| `public/t.js` | the tracker (a few lines), loaded by the tracked site |
| `public/index.html` | the dashboard (asks for the password, then calls `/api/stats`) |
| `server/handler.js` | `POST /api/collect` (from the tracker) and `GET /api/stats` (dashboard, needs the password) |
| `server/store.js` | Redis access, every key starts with `stats:` (shares the free Upstash database with the license server) |
| `tests/` | `npm test` |

## Environment variables (server-only, Vercel project drivefx-stats)
* `STATS_TOKEN`: the dashboard password (14+ characters, English letters/digits/symbols). Set by you: Vercel > drivefx-stats > Settings > Environment Variables > Add > Production, type Secret, then Redeploy.
* `STATS_SALT`: random secret for the daily hash (already set; changing it only resets "unique visitor" matching, not totals).
* `ALLOWED_HOSTS`: websites allowed to send visits (`drivefx.pro,www.drivefx.pro,drivefx.vercel.app`).
* `KV_REST_API_URL`, `KV_REST_API_TOKEN`: injected by the Upstash integration.

## Install the tracker on a site
```html
<script defer src="https://drivefx-stats.vercel.app/t.js"></script>
```
Custom events from the page: `window.dfxTrack('paywall_open')`.

## Data (Redis, prefix `stats:`)
`d:<YYYY-MM-DD>` hash of counters (`pv`, `uv`, `p:<path>`, `r:<referrer host>`, `c:<country>`, `dev:`, `b:`, `os:`, `h:<hour>`, `e:<event>`), `u:<day>` HyperLogLog of visitors, `live` sorted set (last 5 minutes), `rl:*` flood counters. Daily keys expire after 400 days.

## Limits
Anyone can fake a visit with a script that sets an allowed `Origin` header, so numbers are an estimate, not an audit trail (flood guard: 400 hits per network per hour; at most 3000 distinct fields per day). Free Upstash limits apply; each visit uses a handful of Redis commands.
