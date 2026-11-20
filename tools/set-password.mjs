// Lets YOU choose the admin panel password (stored as the server-only Vercel variable ADMIN_TOKEN).
//   node tools/set-password.mjs            (production)       node tools/set-password.mjs preview
// The Vercel CLI asks for the value itself, in this window, with the text hidden. Nothing is written to a file.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.argv[2] === 'preview' ? 'preview' : 'production';
console.log(`\nDriveFX admin password (${env})\n---------------------------------`);
console.log('The Vercel CLI will ask for the value. Type your NEW admin password (14+ characters, hidden) and press Enter.\n');
const r = spawnSync(`npx --yes vercel env add ADMIN_TOKEN ${env} --force`, { cwd: root, stdio: 'inherit', shell: true });
if (r.status !== 0) { console.log('\nFailed. Make sure you ran "npx vercel login" and "npx vercel link" first.'); process.exit(1); }
console.log('\nDone. Redeploy (npx vercel deploy --prod) so the new password is picked up.');
