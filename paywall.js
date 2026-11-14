/* DriveFX paywall — 5-minute free trial, then a subscription that YOU switch on from the admin panel.
   Each browser gets a device ID (DFX-XXXX-XXXX). The customer sends you that ID, you activate it in the admin panel,
   and this page unlocks by itself (it asks the license server, no key to type). */
(() => {
  'use strict';
  // ======== SETTINGS (edit these) ========
  const TRIAL_SECONDS = 5 * 60;                 // free engine time per device
  const CONTACT = 'Message us to subscribe';    // text shown to the customer, e.g. 'Telegram: @yourname  ·  email: you@mail.com'
  const API = 'https://drivefx-licenses.xtdanik.workers.dev';
  const OFFLINE_GRACE_DAYS = 7;                 // keep a known subscription working this long if the server can't be reached
  // =======================================

  const K = { id: 'dfx_id', used: 'dfx_used', sub: 'dfx_sub' };
  const ls = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: k => { try { localStorage.removeItem(k); } catch {} },
  };
  // the trial counter is mirrored in a cookie so a simple "clear site data" of localStorage alone does not reset it
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
  let deviceId = read(K.id);
  if (!/^DFX-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(deviceId || '')) deviceId = makeId();
  write(K.id, deviceId);

  // ---- state ----
  let used = +read(K.used) || 0;     // seconds of engine time used in the trial
  let lic = { ok: false };           // current subscription: { ok, exp } (exp 0 = lifetime)
  const left = () => Math.max(0, TRIAL_SECONDS - used);
  const unlocked = () => lic.ok && (lic.exp === 0 || lic.exp * 1000 > Date.now());
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // ---- ask the license server ----
  let lastResult = '';
  async function check() {
    try {
      const r = await fetch(`${API}/status?id=${encodeURIComponent(deviceId)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      const j = await r.json();
      if (j.active) { lic = { ok: true, exp: j.exp }; write(K.sub, JSON.stringify({ exp: j.exp, at: Date.now() })); }
      else { lic = { ok: false }; ls.del(K.sub); cookie.set(K.sub, ''); }
      lastResult = j.active ? 'active' : 'inactive';
    } catch {
      lastResult = 'offline'; // keep whatever we already knew (cached subscription, see boot)
    }
    refresh();
    return lastResult;
  }

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
      <p class="pw-how"><span id="pwContact"></span><br>Send us your ID — as soon as we activate it, this window unlocks by itself.</p>
      <button class="pw-check" id="pwCheck" type="button">CHECK SUBSCRIPTION</button>
      <div class="pw-msg" id="pwMsg" role="status"></div>
    </div>`;
  document.body.appendChild(modal);
  const $ = id => modal.querySelector('#' + id);
  $('pwId').textContent = deviceId; $('pwContact').textContent = CONTACT;

  let poll = null;
  function show(mode) {
    // mode: 'ended' (trial over) | 'manage' (opened from the badge)
    const ended = mode === 'ended';
    const act = unlocked();
    $('pwBadge').textContent = act ? 'SUBSCRIPTION ACTIVE' : ended ? 'FREE TRIAL ENDED' : 'FREE TRIAL';
    $('pwTitle').textContent = act ? 'You are subscribed' : ended ? 'Your free trial is over' : `Free trial: ${fmt(left())} left`;
    $('pwText').textContent = act ? (lic.exp ? 'Active until ' + new Date(lic.exp * 1000).toLocaleDateString() + '.' : 'Lifetime access.')
      : ended ? 'You have used your 5 free minutes. Subscribe to keep using DriveFX engine sounds.' : 'Subscribe any time to remove the time limit.';
    $('pwCheck').style.display = act ? 'none' : '';
    $('pwMsg').textContent = ''; $('pwMsg').className = 'pw-msg';
    modal.hidden = false;
    clearInterval(poll);
    if (!act) poll = setInterval(() => manualCheck(true), 5000); // unlocks by itself once you activate the ID
  }
  const hide = () => { modal.hidden = true; clearInterval(poll); };
  async function manualCheck(quiet) {
    if (!quiet) { $('pwMsg').className = 'pw-msg'; $('pwMsg').textContent = 'Checking…'; }
    const r = await check();
    if (r === 'active') { $('pwMsg').className = 'pw-msg ok'; $('pwMsg').textContent = 'Activated! Enjoy.'; clearInterval(poll); setTimeout(hide, 1200); }
    else if (r === 'offline') { if (!quiet) { $('pwMsg').className = 'pw-msg err'; $('pwMsg').textContent = 'Cannot reach the server. Check your connection.'; } }
    else if (!quiet) { $('pwMsg').className = 'pw-msg'; $('pwMsg').textContent = 'Not activated yet. Send us your ID, then press again.'; }
  }
  $('pwCheck').onclick = () => manualCheck(false);
  $('pwClose').onclick = hide;
  modal.addEventListener('pointerdown', e => { if (e.target === modal) hide(); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) hide(); });
  $('pwCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(deviceId); $('pwCopy').textContent = 'COPIED'; } catch { $('pwCopy').textContent = 'SELECT & COPY'; }
    setTimeout(() => $('pwCopy').textContent = 'COPY', 1800);
  };

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
  const openFromChip = e => { if (e) e.preventDefault(); show(!unlocked() && left() <= 0 ? 'ended' : 'manage'); if (!unlocked()) manualCheck(true); };
  chip.addEventListener('click', openFromChip);

  // ---- gate used by app.js before starting the engine ----
  function gate() {
    if (unlocked() || left() > 0) return true;
    show('ended'); manualCheck(true); return false;
  }

  // ---- count engine time ----
  let last = performance.now(), saveT = 0;
  function tick(d) {
    const now = performance.now(), dt = Math.min(0.25, (now - last) / 1000); last = now;
    if (!d.running || unlocked()) { refresh(); return; }
    used += dt; saveT += dt;
    if (saveT > 2) { saveT = 0; write(K.used, used.toFixed(1)); }
    refresh();
    if (left() <= 0) { write(K.used, used.toFixed(1)); window.DriveFX.stop(); show('ended'); manualCheck(true); }
  }

  function boot() {
    if (!window.DriveFX) return requestAnimationFrame(boot);
    window.DriveFX.gate = gate;
    window.DriveFX.onFrame(tick);
    addEventListener('pagehide', () => write(K.used, used.toFixed(1)));
    // known subscription keeps working instantly (and offline for a while); the server then confirms or revokes it
    try {
      const c = JSON.parse(read(K.sub) || 'null');
      if (c && (c.exp === 0 || c.exp * 1000 > Date.now()) && Date.now() - c.at < OFFLINE_GRACE_DAYS * 864e5) lic = { ok: true, exp: c.exp };
    } catch {}
    refresh();
    check();
    setInterval(check, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }
  boot();
})();
