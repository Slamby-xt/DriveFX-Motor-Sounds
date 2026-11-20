/* DriveFX paywall.
   Free: 5 cars and 5 minutes of engine time per device.  Pro (monthly, yearly or lifetime): every car, no time limit.
   A Pro license belongs to the device ID (DFX-XXXX-XXXX) that lives in this browser; the license server (worker/index.js) knows which IDs are Pro.
   The free minutes are also counted on the server, by device ID AND by a fingerprint of the device plus its network, so
   clearing cookies or opening a private window does not give a fresh trial.
   Payments: Stripe Checkout, created by the license server (GET /go). Prices come from Stripe (GET /prices) in USD, EUR or GBP.
   After paying, the Stripe webhook marks the ID as Pro and this window unlocks by itself. Cancel / card / invoices: Stripe's billing portal (POST /portal). */
(() => {
  'use strict';
  // ======== SETTINGS ========
  const TRIAL_SECONDS = 5 * 60;                 // free engine time per device (keep equal to TRIAL_SECONDS in worker/index.js)
  const API = location.port === '5173' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? 'http://127.0.0.1:3000' : location.origin; // same origin as the site (Vercel serves both); a plain local static server uses `vercel dev` on :3000, never the live server
  const OFFLINE_GRACE_DAYS = 7;                 // keep a known subscription working this long if the server can't be reached
  const SYNC_EVERY = 15;                        // seconds of engine time between trial syncs with the server
  const PLANS = [
    { id: 'monthly',  name: 'Monthly',  per: 'per month' },
    { id: 'yearly',   name: 'Yearly',   per: 'per year' },
    { id: 'lifetime', name: 'Lifetime', per: 'one time', note: 'Pay once' },
  ];
  // shown until the real prices arrive from the server (same numbers in every currency, in cents / pence)
  const FALLBACK = { monthly: { usd: 299, eur: 299, gbp: 299 }, yearly: { usd: 2999, eur: 2999, gbp: 2999 }, lifetime: { usd: 4999, eur: 4999, gbp: 4999 } };
  const CURRENCIES = ['usd', 'eur', 'gbp'];
  // ==========================
  const CFG = window.DFX_CONFIG || {};

  const K = { id: 'dfx_id', used: 'dfx_used', sub: 'dfx_sub', cur: 'dfx_cur' };
  const ls = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: k => { try { localStorage.removeItem(k); } catch {} },
  };
  // everything is mirrored in a cookie so that clearing localStorage alone does not reset the trial
  const cookie = {
    get: k => { const m = document.cookie.match(new RegExp('(?:^|; )' + k + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; },
    set: (k, v) => { document.cookie = `${k}=${encodeURIComponent(v)}; max-age=${3600 * 24 * 730}; path=/; SameSite=Lax`; },
  };
  const read = k => { const a = ls.get(k), b = cookie.get(k); return a === null ? b : b === null ? a : (k === K.used ? String(Math.max(+a || 0, +b || 0)) : a); };
  const write = (k, v) => { ls.set(k, v); cookie.set(k, v); };
  ls.del('dfx_lic'); // old signed-key system

  // ---- device ID ----
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function makeId() {
    const r = crypto.getRandomValues(new Uint8Array(8)); let s = '';
    for (const b of r) s += ALPHA[b % ALPHA.length];
    return `DFX-${s.slice(0, 4)}-${s.slice(4)}`;
  }
  const ID_RE = /^DFX-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
  let deviceId = read(K.id);
  if (!ID_RE.test(deviceId || '')) deviceId = makeId();
  write(K.id, deviceId);

  // ---- fingerprint: a hash of device traits that survive clearing cookies (only the hash ever leaves the browser) ----
  async function fingerprint() {
    const n = navigator, s = screen, p = [];
    p.push(n.platform || '', n.vendor || '', n.hardwareConcurrency || 0, n.deviceMemory || 0, n.maxTouchPoints || 0,
      Math.min(s.width, s.height), Math.max(s.width, s.height), s.colorDepth || 0); // hardware only: language and timezone are one setting away from changing
    try { const gl = document.createElement('canvas').getContext('webgl'), e = gl && gl.getExtension('WEBGL_debug_renderer_info'); p.push(gl ? gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : ''); } catch {}
    try {
      const c = document.createElement('canvas'); c.width = 220; c.height = 40; const x = c.getContext('2d');
      x.textBaseline = 'top'; x.font = '16px Arial'; x.fillStyle = '#f60'; x.fillRect(10, 4, 90, 22); x.fillStyle = '#069'; x.fillText('DriveFX engine 0123', 4, 12); p.push(c.toDataURL());
    } catch {}
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.join('|'))));
    return Array.from(h, b => b.toString(16).padStart(2, '0')).join('');
  }
  let fp = '';
  const fpReady = fingerprint().then(h => { fp = h; }).catch(() => {});

  // ---- state ----
  let used = +read(K.used) || 0;     // seconds of engine time used in the trial
  let lic = { ok: false };           // current subscription: { ok, exp, plan, manage, cancel } (exp 0 = lifetime)
  let priceTable = FALLBACK;         // { monthly: { usd: 299, ... }, ... } from the server
  let currency = CURRENCIES.includes(ls.get(K.cur)) ? ls.get(K.cur) : 'usd'; // suggested by the server by country unless the visitor picked one
  const money = (plan, cur) => { const c = (priceTable[plan] || FALLBACK[plan])[cur || currency]; try { return new Intl.NumberFormat('en', { style: 'currency', currency: (cur || currency).toUpperCase(), minimumFractionDigits: 2 }).format(c / 100); } catch { return (c / 100).toFixed(2); } };
  let blocked = false;               // the server refused a new trial from this network today (not saved: it says nothing about time used)
  const left = () => blocked ? 0 : Math.max(0, TRIAL_SECONDS - used);
  const unlocked = () => lic.ok && (lic.exp === 0 || lic.exp * 1000 > Date.now());
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // ---- ask the license server ----
  let lastResult = '';
  async function check() {
    const asked = deviceId;
    try {
      const r = await fetch(`${API}/status?id=${encodeURIComponent(asked)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      const j = await r.json();
      if (asked !== deviceId) return lastResult; // the ID changed (restore) while this was in flight: this answer is about the old ID
      if (j.active) { lic = { ok: true, exp: j.exp, plan: j.plan || 'manual', manage: !!j.manage, cancel: !!j.cancel }; write(K.sub, JSON.stringify({ exp: j.exp, plan: lic.plan, manage: lic.manage, cancel: lic.cancel, at: Date.now() })); }
      else { lic = { ok: false }; ls.del(K.sub); cookie.set(K.sub, ''); }
      lastResult = j.active ? 'active' : 'inactive';
    } catch {
      lastResult = 'offline'; // keep whatever we already knew (cached subscription, see boot)
    }
    refresh();
    return lastResult;
  }

  // ---- free-trial time on the server ----
  let syncing = false;
  async function trialSync() {
    if (syncing || unlocked()) return;
    syncing = true;
    try {
      await fpReady;
      const r = await fetch(`${API}/trial`, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ id: deviceId, fp, used: +used.toFixed(1) }) });
      if (!r.ok) throw new Error('http ' + r.status);
      const j = await r.json();
      blocked = !!j.blocked;
      if (!blocked && typeof j.used === 'number' && j.used > used) used = j.used;
      write(K.used, used.toFixed(1));
    } catch { /* offline or server not updated: the local counter keeps working */ }
    syncing = false;
    refresh();
  }

  // ---- UI ----
  const chips = document.querySelector('.chips');
  const chip = document.createElement('button');
  chip.className = 'chip'; chip.id = 'chipPlan'; chip.type = 'button'; chip.title = 'Tap to see your plan';
  chip.innerHTML = '<i></i><span></span>'; const chipTxt = chip.querySelector('span');
  if (chips) chips.insertBefore(chip, chips.firstChild);

  const modal = document.createElement('div');
  modal.id = 'paywall'; modal.hidden = true;
  modal.innerHTML = `
    <div class="pw-card" role="dialog" aria-modal="true" aria-labelledby="pwTitle">
      <button class="pw-x" id="pwClose" aria-label="Close">×</button>
      <div class="pw-badge" id="pwBadge"></div>
      <h2 id="pwTitle"></h2>
      <p id="pwText"></p>
      <div id="pwBuy">
        <div class="pw-cur" id="pwCur" role="radiogroup" aria-label="Currency"></div>
        <div class="pw-plans" id="pwPlans" role="radiogroup" aria-label="Choose a plan"></div>
        <a class="pw-pay" id="pwPay" target="_blank" rel="noopener"></a>
        <div class="pw-qr" id="pwQrBox"><div id="pwQr" role="img" aria-label="QR code that opens the payment page"></div><small>Or scan with your phone to pay there.<br>This window unlocks by itself.</small></div>
        <p class="pw-fine">Secure checkout by Stripe · Monthly and yearly plans renew automatically until you cancel, any time from this window</p>
      </div>
      <button class="pw-manage" id="pwManage" type="button" hidden>MANAGE SUBSCRIPTION · CANCEL · INVOICES</button>
      <div class="pw-id"><small>YOUR ID</small><b id="pwId"></b><button id="pwCopy" type="button">COPY</button></div>
      <p class="pw-how" id="pwHow"></p>
      <button class="pw-link" id="pwBill" type="button" hidden>Subscribed before? Manage or cancel your billing</button>
      <details class="pw-restore" id="pwRestore"><summary>Already paid? Restore Pro on this browser</summary>
        <div class="pw-key"><input id="pwRestoreId" placeholder="DFX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="24"><button id="pwRestoreBtn" type="button">RESTORE</button></div>
        <p class="pw-fine">Enter the ID shown on the device you paid with.</p>
      </details>
      <div class="pw-msg" id="pwMsg" role="status"></div>
      <p class="pw-fine" id="pwSupport" hidden></p>
      <p class="pw-fine"><a href="terms.html" target="_blank" rel="noopener">Terms, refunds &amp; privacy</a></p>
    </div>`;
  document.body.appendChild(modal);
  const $ = id => modal.querySelector('#' + id);
  $('pwId').textContent = deviceId;
  if (CFG.support) { $('pwSupport').hidden = false; $('pwSupport').append('Payment problem? ', Object.assign(document.createElement('a'), { href: 'mailto:' + CFG.support, textContent: CFG.support })); }

  // plan buttons
  let plan = 'yearly';
  const planBtns = {};
  PLANS.forEach(p => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pw-plan'; b.setAttribute('role', 'radio');
    const n = document.createElement('b'); n.textContent = p.name;
    const pr = document.createElement('strong'); pr.className = 'pw-price';
    const pe = document.createElement('small'); pe.textContent = p.per;
    b.append(n, pr, pe);
    const e = document.createElement('em'); e.className = 'pw-note'; b.appendChild(e);
    b.onclick = () => { plan = p.id; paintPlans(); };
    planBtns[p.id] = b; $('pwPlans').appendChild(b);
  });
  const payUrl = (id, cur) => `${API}/go?id=${encodeURIComponent(deviceId)}&plan=${id}&cur=${cur || currency}`;
  // currency buttons
  const curBtns = {};
  CURRENCIES.forEach(c => {
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'radio'); b.textContent = { usd: '$ USD', eur: '€ EUR', gbp: '£ GBP' }[c];
    b.onclick = () => { currency = c; ls.set(K.cur, c); paintPlans(); };
    curBtns[c] = b; $('pwCur').appendChild(b);
  });
  function paintPlans() {
    CURRENCIES.forEach(c => { curBtns[c].setAttribute('aria-checked', c === currency); curBtns[c].classList.toggle('on', c === currency); });
    PLANS.forEach(p => {
      const btn = planBtns[p.id];
      btn.setAttribute('aria-checked', p.id === plan); btn.classList.toggle('on', p.id === plan);
      btn.querySelector('.pw-price').textContent = money(p.id);
      const note = btn.querySelector('.pw-note'), t = priceTable[p.id] || FALLBACK[p.id], m = priceTable.monthly || FALLBACK.monthly;
      const save = p.id === 'yearly' ? Math.round((1 - t[currency] / (12 * m[currency])) * 100) : 0;
      note.textContent = p.id === 'yearly' ? (save > 0 ? `Save ${save}%` : '') : (p.note || ''); note.hidden = !note.textContent;
    });
    const url = payUrl(plan), pay = $('pwPay');
    if (!pricesOk) { // the license server cannot take payments (yet): no dead pay button
      pay.removeAttribute('href'); pay.setAttribute('aria-disabled', 'true'); pay.textContent = 'PAYMENTS OPEN SOON';
      $('pwQrBox').hidden = true; $('pwQr').replaceChildren(); return;
    }
    pay.href = url; pay.removeAttribute('aria-disabled'); pay.textContent = `PAY ${money(plan)}${plan === 'lifetime' ? '' : plan === 'yearly' ? ' / YEAR' : ' / MONTH'}`;
    try { const q = qrcode(0, 'M'); q.addData(url); q.make(); $('pwQr').innerHTML = q.createSvgTag({ cellSize: 3, margin: 2, scalable: true }); $('pwQrBox').hidden = false; }
    catch { $('pwQrBox').hidden = true; }
  }
  // real prices and the currency suggested for the visitor's country (until they pick one themselves).
  // Until this succeeds the pay button stays disabled, so a server without Stripe never shows a dead button.
  let pricesOk = false, pricesBusy = false;
  function loadPrices() {
    if (pricesOk || pricesBusy) return;
    pricesBusy = true;
    fetch(`${API}/prices`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(j => {
      if (!j || !j.plans || !j.plans.monthly || !j.plans.yearly || !j.plans.lifetime) return;
      priceTable = j.plans; pricesOk = true;
      if (!CURRENCIES.includes(ls.get(K.cur)) && CURRENCIES.includes(j.currency)) currency = j.currency;
      paintPlans();
    }).catch(() => {}).finally(() => { pricesBusy = false; });
  }
  loadPrices();
  $('pwPay').addEventListener('click', e => { if ($('pwPay').getAttribute('aria-disabled') === 'true') e.preventDefault(); });

  let poll = null;
  function show(mode, car) {
    // mode: 'pro' (a Pro car was tapped) | 'ended' (trial over) | 'manage' (opened from the badge)
    const act = unlocked(), name = car && car.name;
    $('pwBadge').textContent = act ? 'PRO ACTIVE' : mode === 'pro' ? 'PRO CAR' : mode === 'ended' ? 'FREE TRIAL ENDED' : 'FREE PLAN';
    $('pwTitle').textContent = act ? 'You are Pro' : mode === 'pro' && name ? `Unlock ${name}` : mode === 'ended' ? 'Your free trial is over' : 'Unlock DriveFX';
    const planName = (PLANS.find(p => p.id === lic.plan) || {}).name;
    const when = lic.exp ? new Date(lic.exp * 1000).toLocaleDateString() : '';
    $('pwText').textContent = act
      ? (lic.exp ? `${planName ? planName + ' plan · ' : ''}${lic.cancel ? 'cancelled, Pro ends on ' : lic.manage ? 'renews on ' : 'active until '}${when}.` : 'Lifetime access to every car.')
      : mode === 'pro' && name ? `${name} is a Pro car. Upgrade for every car and unlimited driving time.`
      : mode === 'ended' ? `You have used your ${TRIAL_SECONDS / 60} free minutes. Upgrade for every car and unlimited driving time.`
      : `Free includes 5 cars and ${fmt(left())} of engine time left. Upgrade for every car and unlimited driving time.`;
    $('pwBuy').hidden = act; $('pwRestore').hidden = act; $('pwManage').hidden = !(act && lic.manage); $('pwBill').hidden = act;
    $('pwHow').textContent = act ? 'Keep this ID: it restores Pro if you ever clear your browser data.' : 'Pay with the button or the QR code. This window unlocks by itself once the payment goes through.';
    $('pwMsg').textContent = ''; $('pwMsg').className = 'pw-msg';
    loadPrices(); paintPlans();
    modal.hidden = false;
    clearInterval(poll);
    if (!act) poll = setInterval(() => manualCheck(true), 5000); // unlocks by itself once the payment is registered
  }
  const hide = () => { modal.hidden = true; clearInterval(poll); };
  async function manualCheck(quiet) {
    const r = await check();
    if (r === 'active') { $('pwMsg').className = 'pw-msg ok'; $('pwMsg').textContent = 'Pro unlocked! Enjoy.'; clearInterval(poll); setTimeout(hide, 1400); }
    else if (!quiet) { $('pwMsg').className = r === 'offline' ? 'pw-msg err' : 'pw-msg'; $('pwMsg').textContent = r === 'offline' ? 'Cannot reach the server. Check your connection.' : 'No payment found yet.'; }
  }
  $('pwClose').onclick = hide;
  modal.addEventListener('pointerdown', e => { if (e.target === modal) hide(); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) hide(); });
  $('pwCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(deviceId); $('pwCopy').textContent = 'COPIED'; } catch { $('pwCopy').textContent = 'SELECT & COPY'; }
    setTimeout(() => $('pwCopy').textContent = 'COPY', 1800);
  };

  // Stripe's billing portal (cancel, change card, invoices). Stripe asks for the email used to pay and emails a sign-in link,
  // so this works for everyone who paid, including after a subscription has lapsed, and the device ID alone never opens anyone's billing.
  async function openBilling(btn) {
    const msg = (t, cls) => { $('pwMsg').className = 'pw-msg ' + (cls || ''); $('pwMsg').textContent = t; };
    btn.disabled = true; msg('Opening billing…');
    try {
      const r = await fetch(`${API}/portal`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.url) throw new Error('failed');
      msg('');
      const w = window.open(j.url, '_blank');
      if (w) { try { w.opener = null; } catch {} } else location.href = j.url;
    } catch { msg('Cannot open billing right now. Try again, or email ' + (CFG.support || 'support') + '.', 'err'); }
    btn.disabled = false;
  }
  $('pwManage').onclick = () => openBilling($('pwManage'));
  $('pwBill').onclick = () => openBilling($('pwBill'));

  // restore: adopt the ID of a license paid for on another browser (only if that ID really is Pro)
  async function restore() {
    const msg = (t, cls) => { $('pwMsg').className = 'pw-msg ' + (cls || ''); $('pwMsg').textContent = t; };
    let raw = $('pwRestoreId').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (raw.startsWith('DFX') && raw.length === 11) raw = raw.slice(3);
    const id = raw.length === 8 ? `DFX-${raw.slice(0, 4)}-${raw.slice(4)}` : '';
    if (!ID_RE.test(id)) return msg('That does not look like an ID (DFX-XXXX-XXXX).', 'err');
    msg('Checking…');
    try {
      const r = await fetch(`${API}/status?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      const j = await r.json();
      if (!j.active) return msg('No active Pro license found for that ID.', 'err');
      deviceId = id; write(K.id, id); $('pwId').textContent = id;
      lic = { ok: true, exp: j.exp, plan: j.plan || 'manual', manage: !!j.manage, cancel: !!j.cancel }; write(K.sub, JSON.stringify({ exp: j.exp, plan: lic.plan, manage: lic.manage, cancel: lic.cancel, at: Date.now() }));
      refresh(); show('manage'); $('pwMsg').className = 'pw-msg ok'; $('pwMsg').textContent = 'Pro restored on this browser.';
    } catch { msg('Cannot reach the server. Check your connection.', 'err'); }
  }
  $('pwRestoreBtn').onclick = restore;
  $('pwRestoreId').addEventListener('keydown', e => { if (e.key === 'Enter') restore(); });

  let shown = '', wasPro;
  function refresh() {
    let st, html;
    if (unlocked()) {
      st = 'ok';
      const days = lic.exp ? Math.max(1, Math.ceil((lic.exp * 1000 - Date.now()) / 86400000)) : 0;
      html = '<i></i>PRO' + (lic.exp ? ' · ' + days + (days === 1 ? ' DAY' : ' DAYS') : ' · LIFETIME');
    }
    else if (left() > 0) { st = left() < 60 ? 'warn' : 'wait'; html = '<i></i>TRIAL ' + fmt(left()); }
    else { st = 'off'; html = '<i></i>TRIAL ENDED'; }
    if (st + html !== shown) { shown = st + html; chip.dataset.state = st; chipTxt.textContent = html.replace('<i></i>', ''); }
    const pro = unlocked();
    if (pro !== wasPro) { wasPro = pro; document.dispatchEvent(new CustomEvent('dfx-plan', { detail: { pro } })); } // app.js unlocks / locks the Pro cars
  }
  // open the window on tap/click (the badge's inner nodes are never replaced, so a tap can't be lost while the timer ticks)
  const openFromChip = e => { if (e) e.preventDefault(); show(!unlocked() && left() <= 0 ? 'ended' : 'manage'); if (!unlocked()) manualCheck(true); };
  chip.addEventListener('click', openFromChip);

  // ---- gate used by app.js before starting the engine ----
  function gate() {
    const car = window.DriveFX.state.car;
    if (car && !car.free && !unlocked()) { show('pro', car); return false; }
    if (unlocked() || left() > 0) return true;
    show('ended'); manualCheck(true); return false;
  }

  // ---- count engine time ----
  let last = performance.now(), saveT = 0, syncT = 0;
  function tick(d) {
    const now = performance.now(), dt = Math.min(0.25, (now - last) / 1000); last = now;
    if (d.running && !unlocked() && d.car && !d.car.free) { window.DriveFX.stop(); show('pro', d.car); refresh(); return; }
    if (!d.running || unlocked()) { refresh(); return; }
    used += dt; saveT += dt; syncT += dt;
    if (saveT > 2) { saveT = 0; write(K.used, used.toFixed(1)); }
    if (syncT > SYNC_EVERY) { syncT = 0; trialSync(); }
    refresh();
    if (left() <= 0) { write(K.used, used.toFixed(1)); window.DriveFX.stop(); show('ended'); manualCheck(true); trialSync(); }
  }

  function boot() {
    if (!window.DriveFX) return requestAnimationFrame(boot);
    window.DriveFX.gate = gate;
    window.DriveFX.isPro = unlocked;
    window.DriveFX.paywall = { open: (mode, car) => { show(mode, car); if (!unlocked()) manualCheck(true); }, check };
    window.DriveFX.onFrame(tick);
    addEventListener('pagehide', () => {
      write(K.used, used.toFixed(1));
      if (!unlocked() && used > 0 && navigator.sendBeacon) { try { navigator.sendBeacon(`${API}/trial`, new Blob([JSON.stringify({ id: deviceId, fp, used: +used.toFixed(1) })], { type: 'text/plain;charset=UTF-8' })); } catch {} }
    });
    // known subscription keeps working instantly (and offline for a while); the server then confirms or revokes it
    try {
      const c = JSON.parse(read(K.sub) || 'null');
      if (c && (c.exp === 0 || c.exp * 1000 > Date.now()) && Date.now() - c.at < OFFLINE_GRACE_DAYS * 864e5) lic = { ok: true, exp: c.exp, plan: c.plan || 'manual', manage: !!c.manage, cancel: !!c.cancel };
    } catch {}
    refresh();
    check().then(trialSync); // license first; the trial ledger is only needed when not Pro
    setInterval(check, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }
  boot();
})();
