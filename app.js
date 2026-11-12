/* DriveFX Motor Sounds — futuristic UI + GPS speed. Audio plugs in later via DriveFX.onFrame(). */
(() => {
  'use strict';

  // ---------- Cars ----------
  const CARS = [
    { id: 'flat6',    name: 'Porsche', desc: 'Flat-six · 9,000 rpm · 7 gears · 280 km/h',        redline: 9000,  idle: 900,  gears: 7, top: 280, color: '#ff7a1a' },
    { id: 'v8',       name: 'Dodge',         desc: 'Big-block V8 · 6,500 rpm · 6 gears · 250 km/h',     redline: 6500,  idle: 700,  gears: 6, top: 250, color: '#ff2d55' },
    { id: 'v12',      name: 'Ferrari',       desc: 'Naturally aspirated V12 · 8,500 rpm · 320 km/h',    redline: 8500,  idle: 1000, gears: 7, top: 320, color: '#ffd23f' },
    { id: 'roadster', name: 'Tesla', desc: 'Synthetic whine · 12,000 rpm · 1 gear · 260 km/h',  redline: 12000, idle: 0,    gears: 1, top: 260, color: '#00e5ff' },
    { id: 'rally',    name: 'Mitsubishi',       desc: 'Turbo four · 7,500 rpm · 6 short gears · 220 km/h', redline: 7500,  idle: 1000, gears: 6, top: 220, color: '#5dff9a' },
    { id: 'v10',      name: 'Lamborghini',      desc: 'Screaming V10 · 8,700 rpm · 7 gears · 330 km/h',     redline: 8700,  idle: 950,  gears: 7, top: 330, color: '#a6ff00' },
    { id: 'i6t',      name: 'BMW',    desc: 'Twin-turbo I6 · 7,000 rpm · 8 gears · 300 km/h',     redline: 7000,  idle: 800,  gears: 8, top: 300, color: '#4d8bff' },
    { id: 'boxer',    name: 'Subaru',      desc: 'Flat-four boxer · 7,500 rpm · 6 gears · 240 km/h',   redline: 7500,  idle: 850,  gears: 6, top: 240, color: '#00ffd5' },
    { id: 'rotary',   name: 'Mazda',   desc: 'Twin-rotor · 9,500 rpm · 5 gears · 260 km/h',        redline: 9500,  idle: 900,  gears: 5, top: 260, color: '#ff4fd8' },
    { id: 'hearse',   name: 'Cadillac',    desc: 'Rattling old V8 · 5,000 rpm · 4 gears · 150 km/h',  redline: 5000,  idle: 600,  gears: 4, top: 150, color: '#b48cff' },
  ];

  // ---------- State ----------
  const S = {
    car: CARS[0], running: false, mode: 'gps', unit: 'kmh', volume: 100,
    speed: 0, targetSpeed: 0, rpm: 0, gear: 0, throttle: 0, g: 0,
    trip: 0, top: 0, time: 0, heading: null, sweepT: 0,
    gps: { state: 'off', acc: null, last: null, lastTime: 0 },
    keys: { up: false, down: false },
  };

  const $ = id => document.getElementById(id);
  const el = {};
  ['gauge','speed','unit','gear','rpm','throttleFill','startBtn','startLabel','chipGps','chipEngine','chipMode','notice','testBox',
   'testSpeed','testSpeedVal','cars','carName','carDesc','carArt','carIdx','volume','volumeVal','gpsAcc','gpsSrc','gpsLat','gpsLon',
   'gpsBars','simBtn','simLabel','gasBtn','brakeBtn','fsBtn','shift','tTrip','tTripU','tTop','tTime','tG','tHead','tHeadD','tLoad','tMax','graph','bg','tLive'].forEach(id => el[id] = $(id));

  const store = {
    get(k) { try { return localStorage.getItem('drivefx.' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('drivefx.' + k, v); } catch {} },
  };
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const unitFactor = () => S.unit === 'kmh' ? 1 : 0.621371;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---------- Theme ----------
  let accentRgb = [255, 122, 26];
  function setTheme(hex) {
    const n = parseInt(hex.slice(1), 16);
    accentRgb = [n >> 16, (n >> 8) & 255, n & 255];
    const r = document.documentElement.style;
    r.setProperty('--accent', hex); r.setProperty('--ar', accentRgb.join(','));
    const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = '#04050a';
  }
  const mix = (a, b, t) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;

  // ---------- Gauge ----------
  const NS = 'http://www.w3.org/2000/svg';
  const C = 300, A0 = -135, A1 = 135, SEGS = 54, R_SEG = 262, R_NUM = 224, R_SPD = 190;
  let gaugeMax = 10, segEls = [], spFill, litCount = -1, redStart = 0.8;
  const pt = (r, a) => [C + r * Math.sin(a * Math.PI / 180), C - r * Math.cos(a * Math.PI / 180)];
  const arc = (r, a, b) => { const [x0, y0] = pt(r, a), [x1, y1] = pt(r, b); return `M${x0} ${y0}A${r} ${r} 0 ${b - a > 180 ? 1 : 0} 1 ${x1} ${y1}`; };
  const mk = (tag, attrs, parent) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); (parent || el.gauge).appendChild(n); return n; };

  function buildGauge() {
    gaugeMax = Math.ceil(S.car.redline / 1000);
    redStart = S.car.redline / (gaugeMax * 1000);
    el.gauge.replaceChildren();
    mk('circle', { class: 'dash', cx: C, cy: C, r: 292 });
    mk('circle', { class: 'dash rev', cx: C, cy: C, r: 166 });
    mk('circle', { class: 'ring', cx: C, cy: C, r: 150 });
    // rpm segments
    segEls = [];
    const step = (A1 - A0) / SEGS;
    for (let i = 0; i < SEGS; i++) {
      const a = A0 + i * step;
      const f = i / (SEGS - 1);
      const s = mk('path', { class: 'seg', d: arc(R_SEG, a + 0.6, a + step - 0.6) });
      s.dataset.f = f;
      segEls.push(s);
    }
    // numbers
    for (let v = 0; v <= gaugeMax; v++) {
      const a = A0 + (v / gaugeMax) * (A1 - A0), [x, y] = pt(R_NUM, a);
      const t = mk('text', { class: 'num' + (v * 1000 >= S.car.redline ? ' red' : ''), x, y }); t.textContent = v;
    }
    // speed ring
    mk('path', { class: 'sp-track', d: arc(R_SPD, A0, A1), pathLength: 100 });
    spFill = mk('path', { class: 'sp-fill', d: arc(R_SPD, A0, A1), pathLength: 100, 'stroke-dasharray': '0 100' });
    litCount = -1; paintSegs(0);
  }
  function paintSegs(frac) {
    const n = Math.round(clamp(frac, 0, 1) * SEGS);
    if (n === litCount) return; litCount = n;
    segEls.forEach((s, i) => {
      const on = i < n, f = +s.dataset.f;
      if (on) {
        const col = f >= redStart - 0.001 ? '#ff3b3b' : mix(accentRgb, [255, 45, 111], clamp(f / redStart, 0, 1) ** 2 * 0.85);
        s.style.stroke = col; s.style.color = col;
      } else { s.style.stroke = ''; s.style.color = ''; }
      s.classList.toggle('on', on);
    });
  }

  // shift lights
  const leds = [];
  (function () { for (let i = 0; i < 12; i++) { const d = document.createElement('i'); d.className = i < 4 ? 'g' : i < 8 ? 'a' : 'r'; el.shift.appendChild(d); leds.push(d); } })();
  let ledN = -1;
  function paintShift(rpm) {
    const t = clamp((rpm / S.car.redline - 0.72) / 0.26, 0, 1), n = Math.round(t * 12);
    if (n !== ledN) { ledN = n; leds.forEach((d, i) => d.classList.toggle('on', i < n)); }
    el.shift.classList.toggle('flash', S.running && rpm >= S.car.redline * 0.985);
  }

  // ---------- Car UI ----------
  function carSvg() {
    return `<svg viewBox="0 0 260 90" fill="none">
      <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".9"/><stop offset="1" stop-color="var(--accent)" stop-opacity=".12"/></linearGradient></defs>
      <path d="M8 62c0-8 6-12 18-14l36-9c10-8 24-15 44-16h34c20 0 34 7 48 18l32 7c18 3 28 7 28 14v6c0 3-2 5-5 5h-20a20 20 0 0 0-40 0H88a20 20 0 0 0-40 0H14c-4 0-6-2-6-5z" fill="url(#cg)" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M76 38c14-11 28-17 46-17h28c16 0 28 6 40 17z" fill="rgba(4,5,10,.7)" stroke="var(--accent)" stroke-opacity=".7"/>
      <path d="M140 21v17" stroke="var(--accent)" stroke-opacity=".6"/>
      <circle cx="68" cy="68" r="14" fill="#05060b" stroke="var(--accent)" stroke-width="2"/><circle cx="68" cy="68" r="5" fill="var(--accent)"/>
      <circle cx="196" cy="68" r="14" fill="#05060b" stroke="var(--accent)" stroke-width="2"/><circle cx="196" cy="68" r="5" fill="var(--accent)"/>
      <path d="M232 52h14" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>`;
  }
  function renderCars() {
    el.cars.replaceChildren();
    CARS.forEach(c => {
      const b = document.createElement('button');
      b.className = 'car' + (c === S.car ? ' on' : '');
      b.style.setProperty('--c', c.color); b.style.setProperty('--w', (c.redline / 12000 * 100) + '%');
      b.setAttribute('role', 'option'); b.setAttribute('aria-selected', c === S.car);
      const n = document.createElement('b'); n.textContent = c.name;
      const s = document.createElement('span'); s.textContent = `${c.redline.toLocaleString('en')} rpm · ${c.gears} gear${c.gears > 1 ? 's' : ''}`;
      const th = new Image(); th.src = 'img/' + c.id + '.jpg'; th.alt = ''; th.className = 'th'; th.loading = 'lazy'; th.onerror = () => th.remove();
      b.append(th, n, s, document.createElement('i'));
      b.onclick = () => { selectCar(c); window.DriveFX && DriveFX.audio && DriveFX.audio.preview(c); };
      el.cars.appendChild(b);
    });
  }
  function selectCar(c) {
    S.car = c; store.set('car', c.id);
    setTheme(c.color);
    el.carName.textContent = c.name; el.carDesc.textContent = c.desc;
    el.carIdx.textContent = String(CARS.indexOf(c) + 1).padStart(2, '0') + '/' + String(CARS.length).padStart(2, '0');
    el.carArt.replaceChildren();
    const im = new Image(); im.alt = c.name; im.decoding = 'async'; im.src = 'img/' + c.id + '.jpg';
    im.onerror = () => { el.carArt.innerHTML = carSvg(); el.carArt.classList.add('fallback'); };
    el.carArt.classList.remove('fallback'); el.carArt.appendChild(im);
    renderCars(); buildGauge();
    el.testSpeed.max = Math.round(c.top * unitFactor());
    S.targetSpeed = Math.min(S.targetSpeed, c.top);
    syncRanges();
  }

  // ---------- Engine model ----------
  const gearTop = (car, i) => car.top * Math.pow((i + 1) / car.gears, 0.85);
  function pickGear(car, speed, cur) {
    let g = cur;
    while (g < car.gears - 1 && speed > gearTop(car, g) * 0.93) g++;
    while (g > 0 && speed < gearTop(car, g - 1) * 0.72) g--;
    return g;
  }
  function targetRpm(car, speed, gearIdx, throttle) {
    if (S.sweepT < 1.5) { // self-test / ignition sweep
      const t = S.sweepT / 1.5, k = t < 0.5 ? t * 2 : 1 - (t - 0.5) * 2;
      const base = S.running ? car.idle : 0;
      return base + (car.redline * 0.99 - base) * (k * k * (3 - 2 * k));
    }
    if (!S.running) return 0;
    if (car.idle === 0 && speed < 0.5) return 0;
    const base = speed / gearTop(car, gearIdx) * car.redline;
    return Math.min(car.redline * 1.02, Math.max(car.idle, base + throttle * car.redline * 0.06));
  }

  // ---------- GPS ----------
  let watchId = null;
  const haversine = (a, b) => {
    const r = 6371000, d = Math.PI / 180, dLat = (b.latitude - a.latitude) * d, dLon = (b.longitude - a.longitude) * d;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * d) * Math.cos(b.latitude * d) * Math.sin(dLon / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(h));
  };
  function setGpsState(state, text) { el.chipGps.dataset.state = state; el.chipGps.innerHTML = '<i></i>' + text; S.gps.state = state; }
  function setBars(acc) {
    const n = acc == null ? 0 : acc <= 10 ? 4 : acc <= 25 ? 3 : acc <= 60 ? 2 : 1;
    [...el.gpsBars.children].forEach((b, i) => b.classList.toggle('on', i < n));
  }
  function onPosition(pos) {
    const c = pos.coords, now = pos.timestamp || Date.now();
    let ms = null, src = '—';
    if (typeof c.speed === 'number' && !Number.isNaN(c.speed)) { ms = c.speed; src = 'Doppler'; }
    else if (S.gps.last) {
      const dt = (now - S.gps.lastTime) / 1000;
      if (dt > 0.3 && c.accuracy <= 50) {
        const dist = haversine(S.gps.last, c); ms = dist / dt; src = 'Δ position';
        if (dist < c.accuracy * 0.3) ms = 0;
      }
    }
    S.gps.last = { latitude: c.latitude, longitude: c.longitude }; S.gps.lastTime = now;
    if (typeof c.heading === 'number' && !Number.isNaN(c.heading) && (ms || 0) > 1) S.heading = c.heading;
    el.gpsAcc.textContent = c.accuracy ? `±${Math.round(c.accuracy)} m` : '—';
    el.gpsSrc.textContent = src;
    el.gpsLat.textContent = c.latitude.toFixed(5); el.gpsLon.textContent = c.longitude.toFixed(5);
    setBars(c.accuracy);
    if (ms !== null) S.targetSpeed = Math.max(0, ms * 3.6);
    setGpsState('ok', `GPS ±${Math.round(c.accuracy)} M`);
  }
  function onGpsError(err) {
    setGpsState('err', { 1: 'GPS DENIED', 2: 'GPS UNAVAILABLE', 3: 'GPS TIMEOUT' }[err.code] || 'GPS ERROR');
    el.notice.classList.remove('hidden');
    el.notice.querySelector('p').textContent = err.code === 1
      ? 'Location permission denied. Enable it for this site in browser settings, then press START ENGINE again.'
      : 'No GPS fix. Go outside or try Test drive. GPS needs HTTPS (or localhost).';
  }
  function startGps() {
    if (watchId !== null) return;
    if (!('geolocation' in navigator)) return setGpsState('err', 'NO GPS SUPPORT');
    if (!window.isSecureContext) return setGpsState('err', 'NEEDS HTTPS');
    setGpsState('wait', 'SEARCHING GPS…');
    watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }
  function stopGps() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null; S.gps.last = null;
    setGpsState('off', 'GPS OFF'); setBars(null);
    ['gpsAcc', 'gpsSrc', 'gpsLat', 'gpsLon'].forEach(k => el[k].textContent = '—');
  }

  // ---------- Simulated drive (auto demo) ----------
  let demo = null;
  const demoPlan = [ // [target as fraction of top speed, rate as fraction of top per second, hold seconds]
    [0.9, 0.14, 1.5], [0.25, 0.30, 0.4], [0.7, 0.18, 1.0], [0.0, 0.32, 2.5],
  ];
  function runDemo(dt) {
    const [frac, rate, hold] = demoPlan[demo.i], goal = frac * S.car.top, step = rate * S.car.top * dt;
    if (demo.hold > 0) { demo.hold -= dt; return; }
    const d = goal - S.targetSpeed;
    if (Math.abs(d) <= step) { S.targetSpeed = goal; demo.hold = hold; demo.i = (demo.i + 1) % demoPlan.length; }
    else S.targetSpeed += Math.sign(d) * step;
    el.testSpeed.value = S.targetSpeed * unitFactor(); syncRanges();
  }
  function setDemo(on) {
    el.simBtn.classList.toggle('on', on);
    el.simLabel.textContent = on ? 'STOP SIMULATION' : 'SIMULATE DRIVE';
    demo = on ? { i: 0, hold: 0.8 } : null;
    if (on) { if (S.mode !== 'test') setMode('test'); if (!S.running) setRunning(true); }
    else if (S.running) S.targetSpeed = 0;
  }

  // ---------- Controls ----------
  function setRunning(on) {
    if (!on && demo) setDemo(false);
    S.running = on; S.sweepT = 0;
    el.startBtn.classList.toggle('running', on);
    el.startLabel.textContent = on ? 'STOP ENGINE' : 'START ENGINE';
    el.chipEngine.dataset.state = on ? 'ok' : 'off';
    el.chipEngine.innerHTML = '<i></i>' + (on ? 'ENGINE ON' : 'ENGINE OFF');
    if (on && S.mode === 'gps') startGps(); else if (!on) { stopGps(); S.targetSpeed = 0; el.testSpeed.value = 0; syncRanges(); }
    if (on) { S.trip = 0; S.top = 0; S.time = 0; hist.length = 0; }
  }
  function setMode(m) {
    if (m !== 'test' && demo) setDemo(false);
    S.mode = m; store.set('mode', m);
    document.querySelectorAll('[data-mode]').forEach(b => { const on = b.dataset.mode === m; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    el.chipMode.innerHTML = '<i></i>' + (m === 'gps' ? 'GPS DRIVE' : 'TEST DRIVE');
    el.testBox.hidden = m !== 'test';
    el.notice.classList.toggle('hidden', m === 'test');
    S.targetSpeed = 0; el.testSpeed.value = 0; el.testSpeedVal.textContent = '0'; syncRanges();
    if (m === 'test') stopGps(); else if (S.running) startGps();
  }
  function setUnit(u) {
    S.unit = u; store.set('unit', u);
    document.querySelectorAll('[data-unit]').forEach(b => b.classList.toggle('on', b.dataset.unit === u));
    const t = u === 'kmh' ? 'km/h' : 'mph';
    el.unit.textContent = t.toUpperCase();
    document.querySelectorAll('.su').forEach(n => n.textContent = t);
    el.tTripU.textContent = u === 'kmh' ? 'km' : 'mi';
    el.testSpeed.max = Math.round(S.car.top * unitFactor());
    el.testSpeed.value = Math.round(S.targetSpeed * unitFactor()); syncRanges();
  }
  function syncRanges() {
    [el.volume, el.testSpeed].forEach(r => r.style.setProperty('--p', ((r.value - r.min) / (r.max - r.min) * 100) + '%'));
  }

  // ---------- Speed history graph ----------
  const hist = []; let histT = 0, graphT = 0;
  const gctx = el.graph.getContext('2d');
  function drawGraph() {
    const dpr = Math.min(devicePixelRatio || 1, 2), w = el.graph.clientWidth, h = el.graph.clientHeight;
    if (!w) return;
    if (el.graph.width !== w * dpr) { el.graph.width = w * dpr; el.graph.height = h * dpr; }
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0); gctx.clearRect(0, 0, w, h);
    const max = Math.max(60, ...hist, 1) * 1.15;
    gctx.strokeStyle = 'rgba(255,255,255,.07)'; gctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) { const y = h * i / 4; gctx.beginPath(); gctx.moveTo(0, y); gctx.lineTo(w, y); gctx.stroke(); }
    if (hist.length < 2) return;
    const col = `rgb(${accentRgb})`, N = 600, x = i => w - (hist.length - 1 - i) / N * w, y = v => h - v / max * (h - 4) - 2;
    gctx.beginPath(); hist.forEach((v, i) => i ? gctx.lineTo(x(i), y(v)) : gctx.moveTo(x(i), y(v)));
    gctx.strokeStyle = col; gctx.lineWidth = 2; gctx.shadowColor = col; gctx.shadowBlur = 8; gctx.stroke(); gctx.shadowBlur = 0;
    gctx.lineTo(x(hist.length - 1), h); gctx.lineTo(x(0), h); gctx.closePath();
    const g = gctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, `rgba(${accentRgb},.35)`); g.addColorStop(1, `rgba(${accentRgb},0)`);
    gctx.fillStyle = g; gctx.fill();
  }

  // ---------- Warp background ----------
  const bctx = el.bg.getContext('2d');
  const stars = Array.from({ length: 170 }, () => ({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() }));
  let bw = 0, bh = 0;
  function resizeBg() { const d = Math.min(devicePixelRatio || 1, 1.5); bw = el.bg.width = innerWidth * d; bh = el.bg.height = innerHeight * d; }
  addEventListener('resize', resizeBg); resizeBg();
  function drawBg(dt) {
    bctx.clearRect(0, 0, bw, bh);
    const v = (REDUCED ? 0.02 : 0.05) + (S.speed / S.car.top) * (REDUCED ? 0.1 : 1.6), cx = bw / 2, cy = bh * 0.42, sc = Math.max(bw, bh) * 0.55;
    bctx.lineCap = 'round';
    for (const s of stars) {
      const pz = s.z; s.z -= v * dt;
      if (s.z <= 0.03) { s.x = Math.random() * 2 - 1; s.y = Math.random() * 2 - 1; s.z = 1; continue; }
      const trail = Math.min(pz, s.z + v * dt * 3 + 0.004);
      const x0 = cx + s.x / trail * sc * 0.25, y0 = cy + s.y / trail * sc * 0.25, x1 = cx + s.x / s.z * sc * 0.25, y1 = cy + s.y / s.z * sc * 0.25;
      const a = (1 - s.z) ** 1.5 * 0.9;
      bctx.strokeStyle = `rgba(${accentRgb},${a})`; bctx.lineWidth = 0.6 + (1 - s.z) * 1.8;
      bctx.beginPath(); bctx.moveTo(x0, y0); bctx.lineTo(x1, y1); bctx.stroke();
    }
  }

  // ---------- Frame loop ----------
  const frameHooks = []; let lastT = performance.now(), prevSpeed = 0, domT = 0;
  const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function frame(t) {
    const dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
    S.sweepT += dt;

    if (S.mode === 'test') {
      if (demo) runDemo(dt);
      if (S.keys.up) S.targetSpeed = Math.min(S.car.top, S.targetSpeed + 60 * dt);
      if (S.keys.down) S.targetSpeed = Math.max(0, S.targetSpeed - 90 * dt);
      if (S.keys.up || S.keys.down) { el.testSpeed.value = S.targetSpeed * unitFactor(); syncRanges(); }
      el.testSpeedVal.textContent = Math.round(S.targetSpeed * unitFactor());
    }
    S.speed += (S.targetSpeed - S.speed) * (1 - Math.exp(-dt * (S.mode === 'gps' ? 2.2 : 3)));
    if (S.speed < 0.15 && S.targetSpeed === 0) S.speed = 0;

    const acc = dt > 0 ? (S.speed - prevSpeed) / dt : 0; prevSpeed = S.speed;
    S.g += (clamp(acc / 3.6 / 9.81, -1.5, 1.5) - S.g) * (1 - Math.exp(-dt * 4));
    const thrT = S.running ? clamp(acc / 12 + (S.speed > 1 ? 0.12 : 0), 0, 1) : 0;
    S.throttle += (thrT - S.throttle) * (1 - Math.exp(-dt * 8));

    S.gear = pickGear(S.car, S.speed, S.gear);
    const tr = targetRpm(S.car, S.speed, S.gear, S.throttle);
    S.rpm += (tr - S.rpm) * (1 - Math.exp(-dt * (tr > S.rpm ? 10 : 5)));
    if (!S.running && S.sweepT >= 1.5 && S.rpm < 20) S.rpm = 0;

    if (S.running) { S.trip += S.speed / 3600 * dt; S.top = Math.max(S.top, S.speed); S.time += dt; }

    paintSegs(S.rpm / (gaugeMax * 1000)); paintShift(S.rpm);
    spFill.setAttribute('stroke-dasharray', `${clamp(S.speed / S.car.top, 0, 1) * 100} 100`);
    drawBg(dt);

    domT += dt;
    if (domT > 0.05) { // DOM text at ~20 Hz
      domT = 0;
      el.speed.textContent = Math.round(S.speed * unitFactor());
      el.rpm.textContent = Math.round(S.rpm / 10) * 10;
      el.gear.textContent = !S.running ? '–' : S.car.gears === 1 ? 'D' : S.speed < 1 ? 'N' : S.gear + 1;
      el.throttleFill.style.width = (S.throttle * 100).toFixed(0) + '%';
      el.tTrip.textContent = (S.trip * unitFactor()).toFixed(2);
      el.tTop.textContent = Math.round(S.top * unitFactor());
      const m = Math.floor(S.time / 60), s = Math.floor(S.time % 60);
      el.tTime.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      el.tG.textContent = S.g.toFixed(2);
      el.tLoad.textContent = Math.round(S.throttle * 100);
      el.tHead.textContent = S.heading == null ? '—' : Math.round(S.heading) + '°';
      el.tHeadD.textContent = S.heading == null ? ' ' : DIRS[Math.round(S.heading / 45) % 8];
      el.tMax.textContent = hist.length ? 'MAX ' + Math.round(Math.max(...hist) * unitFactor()) : '—';
    }
    histT += dt; if (histT > 0.1) { histT = 0; hist.push(S.speed); if (hist.length > 600) hist.shift(); }
    graphT += dt; if (graphT > 0.1) { graphT = 0; drawGraph(); }

    const data = { speed: S.speed, rpm: S.rpm, gear: S.gear + 1, throttle: S.throttle, car: S.car, running: S.running, volume: S.volume / 100, sweeping: S.sweepT < 1.5 };
    for (const f of frameHooks) f(data);
    requestAnimationFrame(frame);
  }

  // ---------- Wiring ----------
  el.simBtn.onclick = () => setDemo(!demo);
  const hold = (btn, key) => {
    const on = e => { e.preventDefault(); if (demo) setDemo(false); S.keys[key] = true; btn.classList.add('held'); };
    const off = () => { S.keys[key] = false; btn.classList.remove('held'); };
    btn.addEventListener('pointerdown', on); ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, off));
  };
  hold(el.gasBtn, 'up'); hold(el.brakeBtn, 'down');
  el.startBtn.onclick = () => setRunning(!S.running);
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  document.querySelectorAll('[data-unit]').forEach(b => b.onclick = () => setUnit(b.dataset.unit));
  el.testSpeed.oninput = () => { if (demo) setDemo(false); S.targetSpeed = el.testSpeed.value / unitFactor(); syncRanges(); };
  el.volume.oninput = () => { S.volume = +el.volume.value; el.volumeVal.textContent = S.volume + '%'; store.set('vol', S.volume); syncRanges(); };
  el.fsBtn.onclick = () => { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); };
  const keyMap = { ArrowUp: 'up', w: 'up', W: 'up', ArrowDown: 'down', s: 'down', S: 'down' };
  addEventListener('keydown', e => { if (keyMap[e.key] && e.target.tagName !== 'INPUT') { if (demo) setDemo(false); S.keys[keyMap[e.key]] = true; if (e.key.startsWith('Arrow')) e.preventDefault(); } });
  addEventListener('keyup', e => { if (keyMap[e.key]) S.keys[keyMap[e.key]] = false; });
  let wake = null;
  setInterval(async () => { try { if (S.running && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.onrelease = () => wake = null; } else if (!S.running && wake) wake.release(); } catch {} }, 2000);

  // init
  const vol = store.get('vol'); if (vol !== null && +vol >= 0 && +vol <= 100) { S.volume = +vol; el.volume.value = vol; el.volumeVal.textContent = vol + '%'; }
  selectCar(CARS.find(c => c.id === store.get('car')) || CARS[0]);
  setUnit(store.get('unit') === 'mph' ? 'mph' : 'kmh');
  setMode(store.get('mode') === 'test' ? 'test' : 'gps');
  requestAnimationFrame(frame);

  window.DriveFX = { state: S, cars: CARS, onFrame: fn => frameHooks.push(fn) };
})();
