// DriveFX license tool (run on YOUR computer, never publish the private key).
//   node tools/license.mjs init                      -> creates tools/private-key.json and prints the public key
//   node tools/license.mjs grant DFX-XXXX-XXXX 30    -> license key valid 30 days for that device ID
//   node tools/license.mjs grant DFX-XXXX-XXXX 365   -> 1 year
//   node tools/license.mjs grant DFX-XXXX-XXXX life  -> never expires
import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const keyFile = join(dir, 'private-key.json');
const b64u = b => Buffer.from(b).toString('base64url');
const [cmd, id, plan] = process.argv.slice(2);

if (cmd === 'init') {
  if (existsSync(keyFile)) { console.log('private-key.json already exists — refusing to overwrite (it would invalidate every issued key).'); process.exit(1); }
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(keyFile, JSON.stringify(privateKey.export({ format: 'jwk' })));
  console.log('Created', keyFile, '\nBACK THIS FILE UP and keep it secret.\n\nPublic key (paste into paywall.js as PUBLIC_KEY):\n' + JSON.stringify(publicKey.export({ format: 'jwk' })));
} else if (cmd === 'grant') {
  if (!/^DFX-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(id || '')) { console.log('Usage: node tools/license.mjs grant DFX-XXXX-XXXX <days|life>'); process.exit(1); }
  if (!existsSync(keyFile)) { console.log('No private key. Run: node tools/license.mjs init'); process.exit(1); }
  const days = plan === 'life' ? 0 : parseInt(plan, 10);
  if (plan !== 'life' && !(days > 0)) { console.log('Give a number of days or "life".'); process.exit(1); }
  const payload = { id, iat: Math.floor(Date.now() / 1000), exp: days ? Math.floor(Date.now() / 1000) + days * 86400 : 0 };
  const body = b64u(JSON.stringify(payload));
  const priv = createPrivateKey({ key: JSON.parse(readFileSync(keyFile, 'utf8')), format: 'jwk' });
  const sig = sign('sha256', Buffer.from(body), { key: priv, dsaEncoding: 'ieee-p1363' });
  console.log(`\nDevice : ${id}\nValid  : ${days ? days + ' days (until ' + new Date(payload.exp * 1000).toLocaleDateString() + ')' : 'lifetime'}\n\nLICENSE KEY (send this to the customer):\n${body}.${b64u(sig)}\n`);
} else console.log('Commands: init | grant <ID> <days|life>');
