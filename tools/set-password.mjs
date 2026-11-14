// Lets YOU choose the admin panel password (it is stored as a secret on your Cloudflare Worker).
//   double-click tools/set-password.bat
import { spawnSync } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function ask(q) {
  return new Promise(res => {
    process.stdout.write(q);
    const stdin = process.stdin; let s = '';
    stdin.setRawMode?.(true); stdin.resume(); stdin.setEncoding('utf8');
    const on = c => {
      for (const ch of c) {
        if (ch === '\r' || ch === '\n') { stdin.setRawMode?.(false); stdin.pause(); stdin.off('data', on); process.stdout.write('\n'); return res(s); }
        if (ch === '\u0003') process.exit(1);
        if (ch === '\u007f' || ch === '\b') { if (s) { s = s.slice(0, -1); process.stdout.write('\b \b'); } }
        else { s += ch; process.stdout.write('*'); }
      }
    };
    stdin.on('data', on);
  });
}

console.log('\nDriveFX admin password\n----------------------');
const pw = (await ask('New password (14+ characters): ')).trim();
if (pw.length < 14) { console.log('Too short. Use at least 14 characters.'); process.exit(1); }
if ((await ask('Type it again: ')).trim() !== pw) { console.log('Passwords do not match.'); process.exit(1); }

console.log('\nSaving to Cloudflare...');
const r = spawnSync('npx', ['--yes', 'wrangler@4', 'secret', 'put', 'ADMIN_TOKEN'], { cwd: join(root, 'worker'), input: pw, encoding: 'utf8', shell: true });
if (r.status !== 0) { console.log(r.stdout, r.stderr); console.log('\nFailed. Tell Claude what is written above.'); process.exit(1); }
const old = join(root, 'tools', 'admin-token.txt'); if (existsSync(old)) unlinkSync(old);
console.log('\nDone. Your new password works now. The old generated one (admin-token.txt) was deleted.');
