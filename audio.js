/* DriveFX audio — synthesized engine sounds (Web Audio). Driven by DriveFX.onFrame({speed, rpm, gear, throttle, car, running, volume, sweeping}). */
(() => {
  'use strict';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // Harmonic recipes (index 0 = fundamental = firing frequency). Different recipes give each engine its own timbre.
  const H = {
    v8:  [1, .8, .6, .42, .3, .2, .15, .1, .07, .05, .04, .03, .02, .02, .01, .01],
    f6:  [1, .35, .8, .3, .55, .25, .35, .2, .2, .12, .1, .07, .05, .04, .03, .02],
    v12: [1, .45, .3, .5, .25, .35, .2, .25, .14, .14, .09, .08, .05, .05, .03, .03],
    v10: [1, .4, .35, .3, .7, .3, .25, .3, .2, .4, .15, .12, .08, .06, .04, .03],
    i4t: [1, .9, .5, .55, .3, .3, .18, .15, .1, .08, .06, .05, .03, .03, .02, .02],
    i6:  [1, .3, .55, .2, .35, .15, .2, .1, .1, .06, .05, .03, .03, .02, .01, .01],
    box: [1, .7, .65, .3, .35, .2, .18, .1, .08, .06, .04, .03, .02, .02, .01, .01],
    rot: [1, .95, .9, .8, .75, .65, .55, .5, .4, .35, .3, .22, .18, .12, .1, .08],
    old: [1, .9, .5, .3, .2, .12, .08, .05, .03, .02, .02, .01, .01, 0, 0, 0],
  };
  // cyl = cylinders (firing pulses per 2 revs), drive = distortion, bright = filter openness, noise = intake/exhaust hiss,
  // lope = idle roughness, rumble = detune (cents) for uneven firing, sub = half-order growl, turbo = whistle/blow-off, pops = overrun crackle
  const P = {
    flat6:    { cyl: 6,  harm: H.f6,  drive: 2.0, bright: 1.5, noise: .9, lope: .15, rumble: 4,  sub: .3, level: 1.0,  pops: true },
    v8:       { cyl: 8,  harm: H.v8,  drive: 3.0, bright: 1.0, noise: 1.0, lope: .8, rumble: 9,  sub: .6, level: 1.1,  pops: true },
    v12:      { cyl: 12, harm: H.v12, drive: 1.6, bright: 1.8, noise: .6, lope: .05, rumble: 3, sub: .2, level: .9, pops: true },
    roadster: { ev: true },
    rally:    { cyl: 4,  harm: H.i4t, drive: 3.5, bright: 1.1, noise: 1.2, lope: .3, rumble: 6, sub: .5, level: 1.0, turbo: 1, pops: true },
    hearse:   { cyl: 8,  harm: H.old, drive: 1.5, bright: .55, noise: 1.1, lope: 1.6, rumble: 25, sub: .8, level: 1.0 },
    v10:      { cyl: 10, harm: H.v10, drive: 2.2, bright: 1.9, noise: .8, lope: .1, rumble: 3,  sub: .2, level: .95, pops: true },
    i6t:      { cyl: 6,  harm: H.i6,  drive: 1.8, bright: 1.2, noise: .8, lope: .05, rumble: 2, sub: .3, level: 1.0, turbo: 1.3, pops: true },
    boxer:    { cyl: 4,  harm: H.box, drive: 2.6, bright: 1.0, noise: 1.0, lope: .7, rumble: 22, sub: .7, level: 1.05, pops: true },
    rotary:   { cyl: 4,  harm: H.rot, drive: 3.5, bright: 2.2, noise: .7, lope: .2, rumble: 2,  sub: .1, level: .85, pops: true },
  };

  let ctx = null, master, analyser, noiseBuf, voice = null, voiceId = null, preview = null;
  const prev = { gear: 1, thr: 0, running: false, lift: 0 };
  const curves = {};

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC({ latencyHint: 'interactive' });
      master = ctx.createGain(); master.gain.value = 0.9;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.2;
      analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
      master.connect(comp); comp.connect(ctx.destination); comp.connect(analyser);
      const n = ctx.sampleRate * 2; noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }
  const curve = k => curves[k] || (curves[k] = (() => {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; c[i] = Math.tanh(x * k) / Math.tanh(k); }
    return c;
  })());

  // ---------- Voice (one per car) ----------
  function buildVoice(car) {
    const p = P[car.id] || P.v8, v = { p, src: [], dipUntil: 0 };
    const add = n => { v.src.push(n); n.start(); return n; };
    const out = ctx.createGain(); out.gain.value = 0; out.connect(master); v.out = out;

    const noise = ctx.createBufferSource(); noise.buffer = noiseBuf; noise.loop = true;
    v.nbp = ctx.createBiquadFilter(); v.nbp.type = 'bandpass'; v.nbp.Q.value = 0.8;
    v.ng = ctx.createGain(); v.ng.gain.value = 0;
    noise.connect(v.nbp); v.nbp.connect(v.ng); v.ng.connect(out); add(noise);

    if (p.ev) {
      v.ev = [[1, 'sine', .5], [2, 'triangle', .28], [3, 'sine', .16], [4.02, 'triangle', .09]].map(([m, type, a]) => {
        const o = ctx.createOscillator(); o.type = type; const g = ctx.createGain(); g.gain.value = a;
        o.connect(g); g.connect(out); add(o); return { o, m };
      });
      return v;
    }
    const wave = ctx.createPeriodicWave(new Float32Array(p.harm.length + 1), Float32Array.from([0, ...p.harm]));
    const mix = ctx.createGain();
    v.osc = ctx.createOscillator(); v.osc.setPeriodicWave(wave);
    v.osc2 = ctx.createOscillator(); v.osc2.setPeriodicWave(wave); v.osc2.detune.value = p.rumble;
    v.sub = ctx.createOscillator(); v.sub.type = 'triangle';
    const g2 = ctx.createGain(); g2.gain.value = 0.6; const gs = ctx.createGain(); gs.gain.value = p.sub;
    v.osc.connect(mix); v.osc2.connect(g2); g2.connect(mix); v.sub.connect(gs); gs.connect(mix);
    v.lfo = ctx.createOscillator(); v.lfo.frequency.value = 4; v.lfoG = ctx.createGain(); v.lfoG.gain.value = 0;
    v.lfo.connect(v.lfoG); v.lfoG.connect(v.osc.frequency); v.lfoG.connect(v.osc2.frequency);
    const shaper = ctx.createWaveShaper(); shaper.curve = curve(p.drive); shaper.oversample = '2x';
    v.lp = ctx.createBiquadFilter(); v.lp.type = 'lowpass'; v.lp.Q.value = 0.8;
    // exhaust body resonances (give the low "boom" of a big pipe)
    const r1 = ctx.createBiquadFilter(); r1.type = 'peaking'; r1.frequency.value = 95; r1.Q.value = 1.2; r1.gain.value = 9;
    const r2 = ctx.createBiquadFilter(); r2.type = 'peaking'; r2.frequency.value = 190; r2.Q.value = 1.4; r2.gain.value = 5;
    mix.connect(shaper); shaper.connect(v.lp); v.lp.connect(r1); r1.connect(r2); r2.connect(out);
    // GROWL: saw at half firing order, chopped at firing rate (pulsing "rrrrr"), then crushed by heavy distortion
    v.gr = ctx.createOscillator(); v.gr.type = 'sawtooth';
    v.grm = ctx.createOscillator(); v.grm.type = 'sine';
    const grAM = ctx.createGain(); grAM.gain.value = 0.45; const grDepth = ctx.createGain(); grDepth.gain.value = 0.45;
    v.grm.connect(grDepth); grDepth.connect(grAM.gain);
    const grShape = ctx.createWaveShaper(); grShape.curve = curve(7); grShape.oversample = '2x';
    v.grLp = ctx.createBiquadFilter(); v.grLp.type = 'lowpass'; v.grLp.Q.value = 2.5;
    v.grOut = ctx.createGain(); v.grOut.gain.value = 0;
    v.gr.connect(grAM); grAM.connect(grShape); grShape.connect(v.grLp); v.grLp.connect(v.grOut); v.grOut.connect(out);
    // RASP: noise chopped at firing rate = crackly exhaust bark
    const rn = ctx.createBufferSource(); rn.buffer = noiseBuf; rn.loop = true;
    v.rbp = ctx.createBiquadFilter(); v.rbp.type = 'bandpass'; v.rbp.Q.value = 1.1;
    const rAM = ctx.createGain(); rAM.gain.value = 0.5; const rDepth = ctx.createGain(); rDepth.gain.value = 0.5;
    v.rm = ctx.createOscillator(); v.rm.type = 'square'; v.rm.connect(rDepth); rDepth.connect(rAM.gain);
    v.rg = ctx.createGain(); v.rg.gain.value = 0;
    rn.connect(v.rbp); v.rbp.connect(rAM); rAM.connect(v.rg); v.rg.connect(out);
    [v.osc, v.osc2, v.sub, v.lfo, v.gr, v.grm, v.rm, rn].forEach(add);
    if (p.turbo) {
      v.turbo = ctx.createOscillator(); v.turbo.type = 'sine'; v.tg = ctx.createGain(); v.tg.gain.value = 0;
      v.turbo.connect(v.tg); v.tg.connect(master); add(v.turbo);
    }
    return v;
  }
  function swapVoice(car) {
    const old = voice, t = ctx.currentTime;
    if (old) { old.out.gain.cancelScheduledValues(t); old.out.gain.setTargetAtTime(0, t, 0.03); setTimeout(() => { old.src.forEach(n => { try { n.stop(); } catch {} }); old.out.disconnect(); }, 300); }
    voice = buildVoice(car); voiceId = car.id;
  }

  // ---------- One-shots ----------
  function pop(when, amp = 0.55, fq = 800) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = fq * (0.7 + Math.random() * 0.6); bp.Q.value = 0.9;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(amp, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.07 + Math.random() * 0.05);
    src.connect(bp); bp.connect(g); g.connect(master); src.start(when, Math.random() * 1.5, 0.15);
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(140, when); o.frequency.exponentialRampToValueAtTime(45, when + 0.08);
    const og = ctx.createGain(); og.gain.setValueAtTime(amp * 0.5, when); og.gain.exponentialRampToValueAtTime(0.001, when + 0.1);
    o.connect(og); og.connect(master); o.start(when); o.stop(when + 0.12);
  }
  function pops(n) { const t = ctx.currentTime; let at = t + 0.03; n = Math.ceil(n * 1.6); for (let i = 0; i < n; i++) { pop(at, 0.5 + Math.random() * 0.5, 500 + Math.random() * 900); at += 0.04 + Math.random() * 0.11; } }
  function blowOff(amp) {
    const t = ctx.currentTime, src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(4200, t); bp.frequency.exponentialRampToValueAtTime(1400, t + 0.6);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + 0.03); g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    src.connect(bp); bp.connect(g); g.connect(master); src.start(t, Math.random(), 0.8);
  }

  // ---------- Per-frame update ----------
  function update(d) {
    if (!ctx || ctx.state !== 'running') return;
    if (preview) {
      const t = (ctx.currentTime - preview.t0), c = preview.car, up = 0.9, hold = 0.35, down = 1.1;
      if (t > up + hold + down + 0.2) preview = null;
      else {
        const k = t < up ? (t / up) ** 1.5 : t < up + hold ? 1 : Math.max(0, 1 - (t - up - hold) / down);
        d = { ...d, car: c, running: true, sweeping: false, speed: 0, gear: 1, rpm: c.idle + (c.redline * 0.97 - c.idle) * k, throttle: t < up + hold ? 0.9 : 0 };
      }
    }
    if (!d.running && !(preview) && !voice) return;
    if (!voice || voiceId !== d.car.id) swapVoice(d.car);
    const v = voice, p = v.p, t = ctx.currentTime, car = d.car;
    const rpmF = clamp(d.rpm / car.redline, 0, 1.05), thr = clamp(d.throttle, 0, 1);
    const load = d.sweeping ? 0.9 : clamp(thr * 1.25 + (d.speed > 1 ? 0.1 : 0), 0, 1);
    const on = d.running && d.rpm > 5;
    master.gain.setTargetAtTime(clamp(d.volume, 0, 1) * 0.9, t, 0.05);

    // events: shift, lift-off
    if (on && d.gear !== prev.gear && !d.sweeping) {
      v.dipUntil = t + 0.09;
      if (p.pops && d.gear > prev.gear && load > 0.4) pops(1 + (Math.random() > 0.6));
      if (p.pops && d.gear < prev.gear) pops(2);
    }
    if (on && prev.thr > 0.35 && thr < 0.12 && rpmF > 0.35 && t > prev.lift + 0.7) {
      prev.lift = t;
      if (p.turbo) blowOff(0.3 * p.turbo);
      if (p.pops) pops(2 + Math.floor(Math.random() * 4));
    }
    if (on && p.pops && thr < 0.05 && rpmF > 0.4 && d.speed > 20 && Math.random() < 0.08) pop(t, 0.4 + Math.random() * 0.5, 600);
    prev.gear = d.gear; prev.thr = thr; prev.running = on;

    // engine level
    const limiter = on && !d.sweeping && rpmF >= 0.985 && Math.floor(t * 18) % 2 ? 0.4 : 1;
    const dip = t < v.dipUntil ? 0.25 : 1;
    const level = on ? (0.3 + 0.35 * rpmF + 0.4 * load) * (p.level || 1) * limiter * dip : 0;
    v.out.gain.setTargetAtTime(level, t, 0.03);

    if (p.ev) {
      const f = d.rpm / 60 * 6;
      v.ev.forEach(e => e.o.frequency.setTargetAtTime(Math.max(20, f * e.m), t, 0.03));
      v.ng.gain.setTargetAtTime(on ? 0.02 + 0.05 * rpmF : 0, t, 0.05); v.nbp.frequency.setTargetAtTime(2500 + rpmF * 3000, t, 0.05);
      return;
    }
    const f = Math.max(10, d.rpm / 60 * p.cyl / 2);
    v.osc.frequency.setTargetAtTime(f, t, 0.025); v.osc2.frequency.setTargetAtTime(f, t, 0.025); v.sub.frequency.setTargetAtTime(f / 2, t, 0.025);
    v.lfo.frequency.setTargetAtTime(2 + d.rpm / 500, t, 0.1);
    v.lfoG.gain.setTargetAtTime(f * 0.035 * p.lope * clamp(1 - rpmF * 1.6, 0, 1), t, 0.1);
    v.lp.frequency.setTargetAtTime((500 + rpmF * 3200 + load * 3500) * p.bright, t, 0.04);
    v.lp.Q.setTargetAtTime(0.8 + load * 2, t, 0.05);
    v.nbp.frequency.setTargetAtTime(400 + rpmF * 2200, t, 0.05);
    v.ng.gain.setTargetAtTime(on ? p.noise * (0.03 + 0.2 * load * rpmF) : 0, t, 0.05);
    // growl + rasp follow firing rate; louder under load (the harder you push, the louder it roars)
    const gk = 0.35 + p.sub * 0.8 + (p.drive > 2.5 ? 0.2 : 0);
    v.gr.frequency.setTargetAtTime(f / 2, t, 0.025); v.grm.frequency.setTargetAtTime(f, t, 0.025);
    v.grLp.frequency.setTargetAtTime(260 + rpmF * 900 + load * 700, t, 0.05);
    v.grOut.gain.setTargetAtTime(on ? gk * (0.35 + 0.65 * load) * (1 - rpmF * 0.3) : 0, t, 0.04);
    v.rm.frequency.setTargetAtTime(f, t, 0.025);
    v.rbp.frequency.setTargetAtTime(500 + rpmF * 1500 + load * 600, t, 0.05);
    v.rg.gain.setTargetAtTime(on ? p.noise * 0.35 * (0.1 + 0.9 * load) * (0.4 + rpmF) : 0, t, 0.04);
    if (p.turbo) {
      v.turbo.frequency.setTargetAtTime(1500 + rpmF * 4500, t, 0.1);
      v.tg.gain.setTargetAtTime(on ? p.turbo * load * rpmF * rpmF * 0.05 : 0, t, 0.25); // spool lag
    }
  }

  // ---------- Wiring ----------
  const unlock = () => { ensure(); };
  ['pointerdown', 'pointerup', 'click', 'touchend', 'keydown'].forEach(ev => addEventListener(ev, unlock, { passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend(); else ctx.resume();
  });
  // Sound status chip: shows whether the browser has allowed audio; tap = enable + short test beep
  const chip = document.getElementById('chipSound');
  function beep() {
    if (!ensure()) return;
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 440; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.45);
  }
  if (chip) {
    chip.onclick = () => { beep(); const D = window.DriveFX; if (D && !D.state.running) D.audio.preview(D.state.car); };
    setInterval(() => {
      const ok = ctx && ctx.state === 'running';
      chip.dataset.state = ok ? 'ok' : 'wait';
      chip.innerHTML = '<i></i>' + (ok ? 'SOUND ON' : 'TAP FOR SOUND');
    }, 400);
  }
  const boot = () => {
    if (!window.DriveFX) return requestAnimationFrame(boot);
    window.DriveFX.onFrame(update);
    window.DriveFX.audio = {
      ensure,
      preview(car) { if (!ensure() || window.DriveFX.state.running) return; preview = { car, t0: ctx.currentTime + 0.02 }; },
      level() { if (!analyser) return 0; const a = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(a); let s = 0; for (const x of a) s += (x - 128) ** 2; return Math.sqrt(s / a.length) / 128; },
      get state() { return ctx ? ctx.state : 'none'; },
    };
  };
  boot();
})();
