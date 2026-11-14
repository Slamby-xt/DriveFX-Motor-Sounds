// DriveFX admin panel — runs ONLY on your computer (127.0.0.1). Never deploy this; it holds your private signing key.
//   node tools/admin.mjs      (or double-click tools/admin.bat)
import http from 'node:http';
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { exec } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const keyFile = join(dir, 'private-key.json'), logFile = join(dir, 'issued.json');
const PORT = 4777, HOST = '127.0.0.1';
if (!existsSync(keyFile)) { console.log('No private-key.json. Run: node tools/license.mjs init'); process.exit(1); }
const priv = createPrivateKey({ key: JSON.parse(readFileSync(keyFile, 'utf8')), format: 'jwk' });
const b64u = b => Buffer.from(b).toString('base64url');
const readLog = () => { try { return JSON.parse(readFileSync(logFile, 'utf8')); } catch { return []; } };

function grant(id, days) {
  const iat = Math.floor(Date.now() / 1000), exp = days ? iat + days * 86400 : 0;
  const body = b64u(JSON.stringify({ id, iat, exp }));
  const sig = sign('sha256', Buffer.from(body), { key: priv, dsaEncoding: 'ieee-p1363' });
  const key = `${body}.${b64u(sig)}`;
  const log = readLog(); log.unshift({ id, days, iat, exp, key }); writeFileSync(logFile, JSON.stringify(log, null, 1));
  return { key, exp };
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DriveFX Admin</title><style>
:root{--bg:#05070d;--card:#0c1220;--line:#1c2740;--tx:#e8f1ff;--mute:#7f90ad;--ac:#00e5ff;--ok:#27f0a0;--err:#ff6b7f}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(1200px 600px at 70% -10%,#0d2a3a 0,transparent 60%),var(--bg);color:var(--tx);font:500 16px/1.45 system-ui,Segoe UI,sans-serif;padding:28px 16px}
.w{max-width:760px;margin:0 auto}h1{font-size:22px;letter-spacing:.12em;margin:0 0 4px}h1 b{color:var(--ac)}.sub{color:var(--mute);margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:18px;box-shadow:0 0 40px -18px var(--ac)}
label{display:block;font-size:12px;letter-spacing:.16em;color:var(--mute);margin-bottom:8px}
input[type=text],input[type=number]{width:100%;padding:14px;border-radius:12px;border:1px solid var(--line);background:#060a14;color:var(--tx);font:700 20px ui-monospace,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase}
input:focus{outline:2px solid var(--ac)}.plans{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 4px}
.plans button{flex:1;min-width:92px;padding:12px;border-radius:12px;border:1px solid var(--line);background:#0a1020;color:var(--tx);font:700 14px inherit;cursor:pointer}
.plans button.on{border-color:var(--ac);background:rgba(0,229,255,.12);color:var(--ac)}
.go{width:100%;margin-top:14px;padding:16px;border:0;border-radius:12px;background:var(--ac);color:#04121a;font:800 15px inherit;letter-spacing:.14em;cursor:pointer}
.go:hover{filter:brightness(1.1)}.msg{margin-top:12px;min-height:20px;color:var(--err);font-weight:600}
.out{display:none}.out.show{display:block}.key{width:100%;min-height:96px;padding:12px;border-radius:12px;border:1px solid var(--ok);background:#06130e;color:var(--ok);font:12px ui-monospace,Consolas,monospace;word-break:break-all;resize:vertical}
.row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.row button{padding:11px 14px;border-radius:10px;border:1px solid var(--line);background:#0a1020;color:var(--tx);font:700 13px inherit;cursor:pointer}
.row button.p{background:var(--ok);border-color:var(--ok);color:#04120c}
table{width:100%;border-collapse:collapse;font-size:14px}th{font-size:11px;letter-spacing:.14em;color:var(--mute);text-align:left;padding:6px 8px}
td{padding:9px 8px;border-top:1px solid var(--line);vertical-align:middle}td.id{font:700 14px ui-monospace,Consolas,monospace}td button{padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:#0a1020;color:var(--tx);cursor:pointer}
.tag{padding:3px 8px;border-radius:99px;font-size:12px;font-weight:700}.tag.on{background:rgba(39,240,160,.15);color:var(--ok)}.tag.off{background:rgba(255,107,127,.15);color:var(--err)}
</style></head><body><div class="w">
<h1>DRIVE<b>FX</b> · ADMIN</h1><p class="sub">Paste a customer's ID, choose a plan, get their license key. Runs only on this computer.</p>
<div class="card"><label>CUSTOMER ID</label><input type="text" id="id" placeholder="DFX-XXXX-XXXX" autocomplete="off" spellcheck="false" autofocus>
<div class="plans" id="plans"></div>
<div id="customBox" style="display:none;margin-top:10px"><label>NUMBER OF DAYS</label><input type="number" id="custom" min="1" max="3650" value="30"></div>
<button class="go" id="go">GENERATE KEY</button><div class="msg" id="msg"></div></div>
<div class="card out" id="out"><label>LICENSE KEY — send this to the customer</label><textarea class="key" id="key" readonly></textarea>
<div class="row"><button class="p" id="copyKey">COPY KEY</button><button id="copyMsg">COPY READY MESSAGE</button></div><div class="msg" id="outMsg" style="color:var(--ok)"></div></div>
<div class="card"><label>ISSUED KEYS</label><table><thead><tr><th>ID</th><th>PLAN</th><th>STATUS</th><th></th></tr></thead><tbody id="hist"></tbody></table></div></div>
<script>
const PLANS=[['7 days',7],['30 days',30],['90 days',90],['1 year',365],['Lifetime',0],['Custom','c']];let plan=30;
const $=s=>document.querySelector(s),H={'X-Admin':'1','Content-Type':'application/json'};
$('#plans').innerHTML=PLANS.map(([t,v])=>'<button data-v="'+v+'" class="'+(v===30?'on':'')+'">'+t+'</button>').join('');
$('#plans').onclick=e=>{const b=e.target.closest('button');if(!b)return;document.querySelectorAll('#plans button').forEach(x=>x.classList.remove('on'));b.classList.add('on');plan=b.dataset.v==='c'?'c':+b.dataset.v;$('#customBox').style.display=plan==='c'?'block':'none'};
const fmtPlan=d=>d?d+' days':'Lifetime';
function status(r){if(!r.exp)return '<span class="tag on">Lifetime</span>';const left=Math.ceil((r.exp*1000-Date.now())/864e5);return left>0?'<span class="tag on">'+left+'d left</span>':'<span class="tag off">Expired</span>'}
async function load(){const r=await (await fetch('/api/history',{headers:H})).json();$('#hist').innerHTML=r.length?r.map((x,i)=>'<tr><td class="id">'+x.id+'</td><td>'+fmtPlan(x.days)+'<br><small style="color:var(--mute)">'+new Date(x.iat*1000).toLocaleDateString()+'</small></td><td>'+status(x)+'</td><td><button data-i="'+i+'">Copy key</button></td></tr>').join(''):'<tr><td colspan="4" style="color:var(--mute)">Nothing issued yet.</td></tr>';window.__h=r}
$('#hist').onclick=async e=>{const b=e.target.closest('button');if(!b)return;await navigator.clipboard.writeText(window.__h[+b.dataset.i].key);b.textContent='Copied';setTimeout(()=>b.textContent='Copy key',1200)};
let last=null;
async function gen(){$('#msg').textContent='';const id=$('#id').value.trim().toUpperCase();if(!/^DFX-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(id)){$('#msg').textContent='ID must look like DFX-XXXX-XXXX.';return}
const days=plan==='c'?+$('#custom').value:plan;if(plan==='c'&&!(days>0)){$('#msg').textContent='Enter a number of days.';return}
const r=await fetch('/api/grant',{method:'POST',headers:H,body:JSON.stringify({id,days})});const j=await r.json();if(!r.ok){$('#msg').textContent=j.error||'Error';return}
last={id,days,key:j.key};$('#key').value=j.key;$('#out').classList.add('show');$('#outMsg').textContent='Done: '+id+' · '+fmtPlan(days);load()}
$('#go').onclick=gen;$('#id').addEventListener('keydown',e=>{if(e.key==='Enter')gen()});
const flash=m=>{$('#outMsg').textContent=m};
$('#copyKey').onclick=async()=>{await navigator.clipboard.writeText(last.key);flash('Key copied.')};
$('#copyMsg').onclick=async()=>{await navigator.clipboard.writeText('Your DriveFX subscription is ready ('+fmtPlan(last.days)+').\\nOpen https://drivefx.pro, click the TRIAL / ID badge at the top, paste this key and press ACTIVATE:\\n\\n'+last.key);flash('Message copied — paste it to the customer.')};
load();
</script></body></html>`;

const server = http.createServer((req, res) => {
  // only this machine, only our own page (blocks DNS-rebinding and other websites calling the API)
  const host = req.headers.host || '';
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) { res.writeHead(403); return res.end('forbidden'); }
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(PAGE); }
  if (req.headers['x-admin'] !== '1') return send(403, { error: 'forbidden' });
  if (req.method === 'GET' && req.url === '/api/history') return send(200, readLog());
  if (req.method === 'POST' && req.url === '/api/grant') {
    let raw = ''; req.on('data', c => { raw += c; if (raw.length > 2000) req.destroy(); });
    req.on('end', () => {
      try {
        const { id, days } = JSON.parse(raw);
        if (!/^DFX-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(id)) return send(400, { error: 'Bad ID format.' });
        if (!Number.isInteger(days) || days < 0 || days > 3650) return send(400, { error: 'Bad number of days.' });
        send(200, grant(id, days));
      } catch { send(400, { error: 'Bad request.' }); }
    });
    return;
  }
  send(404, { error: 'not found' });
});
server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`DriveFX admin running at ${url}\nKeep this window open. Press Ctrl+C to stop.`);
  if (!process.argv.includes('--no-open')) exec(`start "" "${url}"`);
});
