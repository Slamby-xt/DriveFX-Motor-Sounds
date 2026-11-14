/* DriveFX paywall — 5-minute free trial, then a signed license key (issued by you with tools/license.mjs) unlocks the engine.
   Each browser gets a device ID (DFX-XXXX-XXXX). The customer sends you that ID, you generate a key for it, they paste it in.
   Keys are verified in the browser with a public key, so they cannot be forged without your private key. */
(() => {
  'use strict';
  // ======== SETTINGS (edit these) ========
  const TRIAL_SECONDS = 5 * 60;                 // free engine time per device
  const CONTACT = 'Message us to subscribe';    // text shown to the customer, e.g. 'Telegram: @yourname  ·  email: you@mail.com'
  const PUBLIC_KEY = { kty: 'EC', x: 'CksdFWJCd_3dFluA2K6dSyDm2sskF7POfynTFM2ZXhU', y: '4EgqooF2fgrqJyseZ3w0y2-MRE95FLRB26PQs1GFTyQ', crv: 'P-256' };
  // =======================================

  const K = { id: 'dfx_id', used: 'dfx_used', lic: 'dfx_lic' };
  const ls = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  // the trial counter is mirrored in a cookie so a simple "clear site data" of localStorage alone does not reset it
  const cookie = {
    get: k => { const m = document.cookie.match(new RegExp('(?:^|; )' + k + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; },
    set: (k, v) => { document.cookie = `${k}=${encodeURIComponent(v)}; max-age=${3600 * 24 * 730}; path=/; SameSite=Lax`; },
  };
  const read = k => { const a = ls.get(k), b = cookie.get(k); return a === null ? b : b === null ? a : (k === K.used ? String(Math.max(+a || 0, +b || 0)) : a); };
  const write = (k, v) => { ls.set(k, v); cookie.set(k, v); };

  // ---- device ID ----
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function makeId() {
    const r = crypto.getRandomValues(new Uint8Array(8)); let s = '';
    for (const b of r) s += ALPHA[b % ALPHA.length];
    return `DFX-${s.slice(0, 4)}-${s.slice(4)}`;
  }
  let deviceId = read(K.id);
  if (!/^DFX-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(deviceId || '')) { deviceId = makeId(); }
  write(K.id, deviceId);

  // ---- license verification (ECDSA P-256 / SHA-256, public key only) ----
  const b64uToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  let pubKey = null;
  async function verify(key) {
    try {
      const [body, sig] = String(key).trim().split('.');
      if (!body || !sig) return { ok: false, why: 'That does not look like a license key.' };
      pubKey = pubKey || await crypto.subtle.importKey('jwk', PUBLIC_KEY, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const good = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, b64uToBytes(sig), new TextEncoder().encode(body));
      if (!good) return { ok: false, why: 'Invalid license key.' };
      const p = JSON.parse(new TextDecoder().decode(b64uToBytes(body)));
      if (p.id !== deviceId) return { ok: false, why: 'This key was issued for a different device ID.' };
      if (p.exp && p.exp * 1000 < Date.now()) return { ok: false, why: 'This license has expired.', expired: true };
      return { ok: true, exp: p.exp };
    } catch { return { ok: false, why: 'Could not verify the key (is the page open over HTTPS?).' }; }
  }

  // ---- state ----
  let used = +read(K.used) || 0;     // seconds of engine time used in the trial
  let lic = { ok: false };           // current verified license
  const left = () => Math.max(0, TRIAL_SECONDS - used);
  const unlocked = () => lic.ok;
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // ---- UI ----
  const chips = document.querySelector('.chips');
  const chip = document.createElement('button');
  chip.className = 'chip'; chip.id = 'chipPlan'; chip.type = 'button'; chip.title = 'Tap to see your trial / subscription';
  chip.innerHTML = '<i></i><span></span>'; const chipTxt = chip.querySelector('span');
  if (chips) chips.insertBefore(chip, chips.firstChild);

  const modal = document.createElement('div');
  modal.id = 'paywall'; modal.hidden = true;
  modal.innerHTML = `
    <div class="pw-card" role="dialog" aria-modal="true" aria-labelledby="pwTitle">
      <button class="pw-x" id="pwClose" aria-label="Close">×</button>
      <div class="pw-badge" id="pwBadge">FREE TRIAL ENDED</div>
      <h2 id="pwTitle">Your free trial is over</h2>
      <p id="pwText">You have used your 5 free minutes. Subscribe to keep using DriveFX engine sounds.</p>
      <div class="pw-id"><small>YOUR ID</small><b id="pwId"></b><button id="pwCopy" type="button">COPY</button></div>
      <p class="pw-how"><span id="pwContact"></span><br>Send us your ID — we will reply with a license key.</p>
      <div class="pw-key"><input id="pwKey" placeholder="Paste license key here" autocomplete="off" spellcheck="false"><button id="pwGo" type="button">ACTIVATE</button></div>
      <div class="pw-msg" id="pwMsg" role="status"></div>
    </div>`;
  document.body.appendChild(modal);
  const $ = id => modal.querySelector('#' + id);
  $('pwId').textContent = deviceId; $('pwContact').textContent = CONTACT;

  function show(mode) {
    // mode: 'ended' (trial over) | 'manage' (user opened it from the chip)
    const ended = mode === 'ended';
    $('pwBadge').textContent = unlocked() ? 'SUBSCRIPTION ACTIVE' : ended ? 'FREE TRIAL ENDED' : 'FREE TRIAL';
    $('pwTitle').textContent = unlocked() ? 'You are subscribed' : ended ? 'Your free trial is over' : `Free trial: ${fmt(left())} left`;
    $('pwText').textContent = unlocked() ? (lic.exp ? 'Active until ' + new Date(lic.exp * 1000).toLocaleDateString() + '.' : 'Lifetime access.')
      : ended ? 'You have used your 5 free minutes. Subscribe to keep using DriveFX engine sounds.' : 'Subscribe any time to remove the time limit.';
    $('pwMsg').textContent = ''; $('pwMsg').className = 'pw-msg';
    modal.hidden = false;
  }
  const hide = () => { modal.hidden = true; };
  $('pwClose').onclick = hide;
  modal.addEventListener('pointerdown', e => { if (e.target === modal) hide(); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) hide(); });
  $('pwCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(deviceId); $('pwCopy').textContent = 'COPIED'; } catch { $('pwCopy').textContent = 'SELECT & COPY'; }
    setTimeout(() => $('pwCopy').textContent = 'COPY', 1800);
  };
  async function activate() {
    const key = $('pwKey').value.trim(); if (!key) return;
    $('pwMsg').className = 'pw-msg'; $('pwMsg').textContent = 'Checking…';
    const r = await verify(key);
    if (r.ok) { lic = r; write(K.lic, key); $('pwMsg').className = 'pw-msg ok'; $('pwMsg').textContent = 'Activated! Enjoy.'; refresh(); setTimeout(hide, 900); }
    else { $('pwMsg').className = 'pw-msg err'; $('pwMsg').textContent = r.why; }
  }
  $('pwGo').onclick = activate;
  $('pwKey').addEventListener('keydown', e => { if (e.key === 'Enter') activate(); });

  let shown = '';
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
  }
  // open the window on tap/click (the badge's inner nodes are never replaced, so a tap can't be lost while the timer ticks)
  const openFromChip = e => { if (e) e.preventDefault(); show(!unlocked() && left() <= 0 ? 'ended' : 'manage'); };
  chip.addEventListener('click', openFromChip);

  // ---- gate used by app.js before starting the engine ----
  function gate() {
    if (unlocked() || left() > 0) return true;
    show('ended'); return false;
  }

  // ---- count engine time ----
  let last = performance.now(), saveT = 0;
  function tick(d) {
    const now = performance.now(), dt = Math.min(0.25, (now - last) / 1000); last = now;
    if (!d.running || unlocked()) { refresh(); return; }
    used += dt; saveT += dt;
    if (saveT > 2) { saveT = 0; write(K.used, used.toFixed(1)); }
    refresh();
    if (left() <= 0) { write(K.used, used.toFixed(1)); window.DriveFX.stop(); show('ended'); }
  }

  async function boot() {
    if (!window.DriveFX) return requestAnimationFrame(boot);
    window.DriveFX.gate = gate;
    window.DriveFX.onFrame(tick);
    addEventListener('pagehide', () => write(K.used, used.toFixed(1)));
    const saved = read(K.lic);
    if (saved) { const r = await verify(saved); if (r.ok) lic = r; }
    refresh();
    // expiry check while the page stays open
    setInterval(() => { if (lic.ok && lic.exp && lic.exp * 1000 < Date.now()) { lic = { ok: false }; refresh(); } }, 30000);
  }
  boot();
})();
