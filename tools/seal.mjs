// Locks your private signing key with a password so the admin page can live on the website safely.
//   node tools/seal.mjs        (or double-click tools/seal.bat)
// Creates panel-9955f43dff/vault.json — an ENCRYPTED copy of the key (AES-256-GCM, key from PBKDF2-SHA256 600k rounds).
// Without your password the vault is useless, so choose a LONG password (14+ characters). Leave it empty to get a random one.
import { pbkdf2Sync, randomBytes, createCipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const keyFile = join(root, 'tools', 'private-key.json');
const outDir = join(root, 'panel-9955f43dff'), outFile = join(outDir, 'vault.json');
if (!existsSync(keyFile)) { console.log('No tools/private-key.json found.'); process.exit(1); }

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
        else { s += ch; process.stdout.write('*'); } // show a * per typed character
      }
    };
    stdin.on('data', on);
  });
}

const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const gen = () => Array.from(randomBytes(20), b => A[b % A.length]).join('').replace(/(.{5})(?=.)/g, '$1-');

console.log('\nDriveFX admin vault\n-------------------');
let pw = await ask('Choose a password (14+ chars, or press Enter for a random one): ');
let generated = false;
if (!pw) { pw = gen(); generated = true; }
else {
  if (pw.length < 14) { console.log('Too short. Use at least 14 characters.'); process.exit(1); }
  const again = await ask('Type it again: ');
  if (again !== pw) { console.log('Passwords do not match.'); process.exit(1); }
}

const salt = randomBytes(16), iv = randomBytes(12), ITER = 600000;
const k = pbkdf2Sync(pw, salt, ITER, 32, 'sha256');
const c = createCipheriv('aes-256-gcm', k, iv);
const enc = Buffer.concat([c.update(readFileSync(keyFile, 'utf8'), 'utf8'), c.final()]);
const data = Buffer.concat([enc, c.getAuthTag()]); // WebCrypto expects ciphertext||tag
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify({ v: 1, iter: ITER, salt: salt.toString('base64'), iv: iv.toString('base64'), data: data.toString('base64') }));
console.log('\nDone. Created ' + outFile);
if (generated) console.log('\nYOUR PASSWORD (write it down now, it is shown only once):\n\n    ' + pw + '\n');
else console.log('Remember your password — it cannot be recovered.');
console.log('Next: tell Claude "done" so the admin page gets published.');
