// Lets YOU choose the admin panel password (stored as a secret on your Cloudflare Worker).
//   double-click tools/set-password.bat
// Wrangler (Cloudflare's tool) asks for the new value itself, in this window, with the text hidden.
import { spawnSync } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
console.log('\nDriveFX admin password\n----------------------');
console.log('Wrangler will now ask:  "Enter a secret value:"');
console.log('Type your NEW admin password there (14+ characters, the text stays hidden) and press Enter.\n');

const r = spawnSync('npx --yes wrangler@4 secret put ADMIN_TOKEN', { cwd: join(root, 'worker'), stdio: 'inherit', shell: true });
if (r.status !== 0) { console.log('\nFailed. Tell Claude what is written above (or simply keep using the password from tools\\admin-token.txt).'); process.exit(1); }
const old = join(root, 'tools', 'admin-token.txt');
if (existsSync(old)) unlinkSync(old);
console.log('\nDone. Your new password works now. The old generated one (admin-token.txt) was deleted.');
