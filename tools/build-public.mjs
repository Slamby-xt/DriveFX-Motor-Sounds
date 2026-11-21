// Copies ONLY the intended website files into public/ (what Vercel serves). Everything else in the repo (server/, api/, tools/, supabase/, _ad/, ...) stays private.
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..'), out = join(root, 'public');
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const ALLOW = ['index.html', 'terms.html', 'style.css', 'app.js', 'audio.js', 'config.js', 'engine-worklet.js', 'paywall.js', 'robots.txt', 'sitemap.xml',
  'img', 'vendor', 'admin/index.html', 'brand/logo-512.png', 'brand/logo.svg'];
for (const f of ALLOW) {
  const src = join(root, f);
  if (!existsSync(src)) throw new Error('missing public file: ' + f);
  mkdirSync(dirname(join(out, f)), { recursive: true });
  cpSync(src, join(out, f), { recursive: true });
}
console.log('public/ ready:', ALLOW.length, 'entries');
