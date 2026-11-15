/*
 * DriveFX engine model: a time-domain combustion-engine synthesizer (AudioWorklet).
 *
 * Instead of oscillators, the sound is built the way an engine builds it:
 *   crank angle (one four-stroke cycle = 720 degrees) -> each cylinder fires at its real angle in the
 *   firing order -> every firing is one exhaust pressure pulse plus a burst of gas noise, never two alike
 *   (fixed per-cylinder differences, random cycle-to-cycle variation, weak cycles at idle) -> the pulse
 *   travels down its header (per-cylinder delay) into its bank's pipe (a lossy resonating delay line)
 *   -> exhaust resonances that stay put while the revs move -> muffler that opens with load -> intake
 *   roar, valvetrain tick, turbo / supercharger, overrun crackle -> soft saturation -> short reflections.
 *
 * The page sends { car, rpm, load, overrun, cut, on } messages; everything else happens per sample here.
 * The file also loads in Node (module.exports) so sounds can be rendered and measured offline.
 */
(function () {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const pole = (sr, sec) => 1 - Math.exp(-1 / (sr * sec));
  const white = () => Math.random() * 2 - 1;
  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;
  // output safety: untouched below 0.7, eased towards 1 above it
  const limit = x => { const a = x < 0 ? -x : x; return a < 0.7 ? x : (x < 0 ? -1 : 1) * (0.7 + 0.3 * sat((a - 0.7) / 0.3)); };
  const sat = x => { if (x > 3) return 1; if (x < -3) return -1; const q = x * x; return x * (27 + q) / (27 + 9 * q); };

  // Exhaust pulse shape: the valve cracks open (fast rise), the cylinder blows down (slower fall).
  const PN = 1024, PULSE = new Float32Array(PN + 1);
  for (let i = 0; i <= PN; i++) PULSE[i] = Math.pow(Math.sin(Math.PI * Math.pow(i / PN, 0.55)), 2);

  // ---------- Cars ----------
  // firing: [crank angle, cylinder, bank]. even(n) = n cylinders evenly spaced, banks alternating.
  const even = (order, banks) => order.map((c, i) => [i * 720 / order.length, c, banks ? banks[i] : 0]);
  const CROSSPLANE = [[0, 1, 0], [90, 8, 1], [180, 4, 1], [270, 3, 0], [360, 6, 1], [450, 5, 0], [540, 7, 0], [630, 2, 1]]; // each bank fires 270-180-90-180
  const BASE = {
    refl: -0.5, damp: 0.3, dry: 0.4,       // pipe: end reflection, loss in the loop, unfiltered share
    pulse: [3.5, 46],                      // longest pulse (ms, low revs) and its length in crank degrees (high revs)
    noise: 0.5, jitter: 0.03, trim: 0.04,  // gas noise per firing, cycle-to-cycle variation, fixed cylinder differences
    timing: 0.01, lope: 0.05,              // firing-time scatter (share of a firing interval), weak cycles at idle
    muffler: [1200, 7000],                 // muffler cut-off, closed throttle -> wide open
    body: [100, 3], intake: 0.15, intakeHz: 700, tick: 0.02,
    crackle: 0.5, pop: 0.4, drive: 3, gain: 0.6,
    out: 1,                                // loudness trim after everything else, so the cars match each other
  };
  const CARS = {
    // 4.0 flat-six, 1-6-2-4-3-5: banks alternate, induction howl on top
    flat6: { idle: 900, redline: 9000, firing: even([1, 6, 2, 4, 3, 5], [0, 1, 0, 1, 0, 1]),
      banks: [{ ms: 4.4, pan: -0.4 }, { ms: 4.7, pan: 0.4, tune: 1.03 }],
      formants: [[160, 1.0, 0.8], [640, 2.2, 0.65], [1950, 2.5, 0.5], [3400, 2.0, 0.22]],
      pulse: [3.0, 44], muffler: [1200, 7500], intake: 0.3, intakeHz: 520, body: [110, 2], drive: 3.2, gain: 0.58, out: 1.25 },
    // supercharged cross-plane V8: uneven banks = burble, deep body, blower whine under boost
    v8: { idle: 700, redline: 6500, firing: CROSSPLANE,
      banks: [{ ms: 2.9, pan: -0.5 }, { ms: 2.6, pan: 0.5, tune: 1.08 }],
      formants: [[52, 1.2, 1.0], [185, 0.9, 1.0], [720, 1.4, 1.5], [1500, 1.6, 1.6], [2900, 2.0, 0.3]],
      pulse: [5.5, 40], noise: 0.8, jitter: 0.035, trim: 0.08, lope: 0.1, muffler: [1300, 7500], body: [58, 8],
      intake: 0.08, intakeHz: 620, crackle: 0.25, drive: 3.6, gain: 0.6, out: 0.92,
      blower: { ratio: 9.44, level: 0.06, load: [0.25, 0.75], harm: [0.6, 1, 0.5, 0.3], voices: [[1, 1], [1.003, 0.8], [0.9955, 0.6]] } },
    // naturally aspirated V12, even 60 degrees: smooth, dense, shrieking
    v12: { idle: 1000, redline: 8500, firing: even([1, 7, 5, 11, 3, 9, 6, 12, 2, 8, 4, 10], [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]),
      banks: [{ ms: 3.4, pan: -0.45 }, { ms: 3.55, pan: 0.45, tune: 1.02 }],
      formants: [[190, 1.0, 0.6], [780, 2.0, 0.7], [2300, 2.5, 0.65], [4200, 2.5, 0.38]],
      pulse: [2.4, 50], noise: 0.4, jitter: 0.015, trim: 0.02, lope: 0, muffler: [1500, 9000], body: [120, 2],
      intake: 0.28, intakeHz: 800, drive: 2.6, gain: 0.55, out: 1.17 },
    // turbo inline-four, 1-3-4-2: the turbine smooths the pulses; whistle and blow-off
    rally: { idle: 1000, redline: 7500, firing: even([1, 3, 4, 2]),
      banks: [{ ms: 5.8, pan: 0 }],
      formants: [[120, 1.0, 0.9], [380, 1.5, 0.7], [1100, 2.0, 0.5], [2600, 2.0, 0.25]],
      pulse: [4.2, 62], noise: 0.6, lope: 0.05, muffler: [1000, 5500], body: [95, 5], crackle: 0.8, drive: 3.4, gain: 0.62, out: 0.95,
      turbo: { level: 0.08, hz: [2400, 8200], bov: 0.5, flutter: 0.6 } },
    // 90-degree V10 on shared crankpins: firing gaps alternate 90 / 54 degrees
    v10: { idle: 950, redline: 8700,
      firing: [[0, 1, 0], [90, 6, 1], [144, 5, 0], [234, 10, 1], [288, 2, 0], [378, 7, 1], [432, 3, 0], [522, 8, 1], [576, 4, 0], [666, 9, 1]],
      banks: [{ ms: 3.6, pan: -0.45 }, { ms: 3.9, pan: 0.45, tune: 1.04 }],
      formants: [[170, 1.0, 0.7], [700, 2.0, 0.7], [1700, 2.4, 0.75], [3300, 2.4, 0.42]],
      pulse: [2.6, 48], noise: 0.45, jitter: 0.02, lope: 0.02, muffler: [1400, 8500], body: [115, 2],
      intake: 0.25, intakeHz: 700, crackle: 0.7, drive: 3.0, gain: 0.56, out: 1.13 },
    // twin-turbo inline-six, 1-5-3-6-2-4: cylinders 1-3 and 4-6 each feed their own turbo and pipe
    i6t: { idle: 800, redline: 7000, firing: even([1, 5, 3, 6, 2, 4], [0, 1, 0, 1, 0, 1]),
      banks: [{ ms: 5.2, pan: -0.3 }, { ms: 5.5, pan: 0.3, tune: 1.03 }],
      formants: [[130, 1.0, 0.9], [420, 1.6, 0.6], [1200, 2.0, 0.38], [2500, 2.0, 0.15]],
      pulse: [3.6, 58], noise: 0.35, jitter: 0.015, trim: 0.03, lope: 0.02, muffler: [900, 4800], body: [90, 5],
      crackle: 0.7, drive: 2.8, gain: 0.6, out: 1.12, turbo: { level: 0.045, hz: [2800, 9000], bov: 0.25, flutter: 0 } },
    // turbo flat-four with unequal-length headers: two cylinders arrive late and weaker = the boxer rumble
    boxer: { idle: 850, redline: 7500, firing: even([1, 3, 2, 4]),
      banks: [{ ms: 6.2, pan: 0 }], runner: { 2: [1.9, 0.72], 4: [1.9, 0.72] },
      formants: [[105, 1.1, 1.0], [320, 1.4, 0.7], [900, 1.8, 0.45], [2200, 2.0, 0.2]],
      pulse: [4.6, 62], noise: 0.6, jitter: 0.035, lope: 0.08, muffler: [950, 5000], body: [80, 6],
      crackle: 0.5, drive: 3.2, gain: 0.62, out: 1.07, turbo: { level: 0.055, hz: [2200, 7600], bov: 0.35, flutter: 0.8 } },
    // twin-rotor: two firings per shaft turn through wide-open ports = sharp pulses, "brap" idle, buzzing top end
    rotary: { idle: 900, redline: 9500, firing: even([1, 2, 1, 2]),
      banks: [{ ms: 3.9, pan: 0 }],
      formants: [[150, 1.0, 0.6], [520, 1.8, 0.8], [1500, 2.2, 0.85], [3200, 2.2, 0.45]],
      pulse: [2.2, 34], noise: 0.7, jitter: 0.04, trim: 0.05, lope: 0.35, muffler: [1500, 8500], body: [110, 3],
      crackle: 0.6, drive: 3.6, gain: 0.52, out: 1.4, turbo: { level: 0.035, hz: [2600, 8600], bov: 0.25, flutter: 0 } },
    // tired old cross-plane V8: long soft pulses, uneven cylinders, lazy lope, ticking lifters, closed-up exhaust
    hearse: { idle: 600, redline: 5000, firing: CROSSPLANE,
      banks: [{ ms: 4.2, pan: -0.3 }, { ms: 3.6, pan: 0.3, tune: 1.1 }],
      formants: [[46, 1.2, 1.0], [150, 0.9, 1.0], [480, 1.4, 0.7], [1100, 1.5, 0.3]],
      pulse: [7, 70], noise: 0.9, jitter: 0.07, trim: 0.14, timing: 0.03, lope: 0.3, muffler: [700, 3200], body: [50, 8],
      intake: 0.05, tick: 0.07, crackle: 0, drive: 2.4, gain: 0.62, out: 0.82 },
  };

  // RBJ cookbook biquad (transposed direct form II)
  class Biquad {
    constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
    set(type, hz, q, db, sr) {
      const w = TAU * clamp(hz, 10, sr * 0.45) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
      let b0, b1, b2, a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
      if (type === 'lp') { b1 = 1 - c; b0 = b2 = b1 / 2; }
      else if (type === 'hp') { b1 = -(1 + c); b0 = b2 = (1 + c) / 2; }
      else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; }
      else { const A = Math.pow(10, db / 40); b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a2 = 1 - al / A; }
      this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    }
    run(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
  }

  // One exhaust bank: the pulses now travelling in it -> pipe -> resonances
  const NP = 14;
  class Bank {
    constructor(sr, b, s) {
      this.age = new Float32Array(NP); this.len = new Float32Array(NP); this.amp = new Float32Array(NP);
      this.nz = new Float32Array(NP); this.dec = new Float32Array(NP); this.slot = 0;
      this.d = Math.max(2, Math.round(b.ms * sr / 1000));
      let size = 1; while (size <= this.d + 2) size <<= 1;
      this.pipe = new Float32Array(size); this.mask = size - 1; this.w = 0; this.lp = 0;
      this.refl = s.refl; this.damp = s.damp; this.dry = s.dry; this.exc = 0; this.nlp = 0; this.kN = 1 - Math.exp(-TAU * 250 / sr);
      this.f = s.formants.map(([hz, q, g]) => { const bq = new Biquad(); bq.set('bp', hz * (b.tune || 1), q, 0, sr); return { bq, g }; });
      this.gl = Math.sqrt(0.5 * (1 - b.pan)); this.gr = Math.sqrt(0.5 * (1 + b.pan));
    }
    add(delay, len, amp, nz, dec) {
      const k = this.slot; this.slot = (k + 1) % NP;
      this.age[k] = -delay; this.len[k] = Math.max(4, len); this.amp[k] = amp; this.nz[k] = nz; this.dec[k] = dec;
    }
    tick() {
      const age = this.age, len = this.len, nz = this.nz;
      let exc = 0, hiss = 0;
      for (let k = 0; k < NP; k++) {
        const l = len[k]; if (l === 0) continue;
        const a = age[k]; age[k] = a + 1;
        if (a < 0) continue;
        if (a < l) exc += this.amp[k] * PULSE[(a / l * PN) | 0];
        if (nz[k] > 1e-4) { hiss += nz[k]; nz[k] *= this.dec[k]; } else if (a >= l) len[k] = 0;
      }
      if (hiss > 0) { const w = white(); this.nlp += this.kN * (w - this.nlp); exc += hiss * (w - this.nlp); } // gas noise: little below 250 Hz
      this.exc = exc;
      // pipe: what went in comes back from the open end, inverted and duller, again and again
      this.lp += this.damp * (this.pipe[(this.w - this.d) & this.mask] - this.lp);
      const y = exc + this.refl * this.lp + 1e-20;
      this.pipe[this.w] = y; this.w = (this.w + 1) & this.mask;
      let out = y * this.dry;
      for (let i = 0; i < this.f.length; i++) out += this.f[i].bq.run(y) * this.f[i].g;
      return out;
    }
  }

  class EngineModel {
    constructor(sr, id) {
      this.sr = sr; this.t = { rpm: 0, load: 0, overrun: 0, cut: 0, on: 0 };
      this.rpm = 0; this.load = 0; this.over = 0; this.g = 0; this.blk = 0; this.next = null;
      this.kRpm = pole(sr, 0.02); this.kG = pole(sr, 0.025);
      this.configure(id || 'v8');
    }
    configure(id) {
      const sr = this.sr, s = this.s = Object.assign({}, BASE, CARS[id] || CARS.v8);
      this.id = id;
      const ev = s.firing.slice().sort((a, b) => a[0] - b[0]);
      this.nEv = ev.length; this.evPos = new Float64Array(ev.length + 1); this.evPos[ev.length] = 1; // sentinel: end of the cycle
      this.evCyl = ev.map(e => e[1]); this.evBank = ev.map(e => e[2]);
      ev.forEach((e, i) => { this.evPos[i] = (e[0] % 720) / 720; });
      this.ne = 0; this.phase = 0;
      this.trim = []; this.evCyl.forEach(c => { if (this.trim[c] === undefined) this.trim[c] = 1 + s.trim * gauss(); });
      this.banks = s.banks.map(b => new Bank(sr, b, s));
      const bq = (type, hz, q, db) => { const b = new Biquad(); b.set(type, hz, q, db || 0, sr); return b; };
      this.hp = [bq('hp', 28, 0.707), bq('hp', 28, 0.707)];
      this.muf = [new Biquad(), new Biquad(), new Biquad(), new Biquad()];
      this.body = [bq('pk', s.body[0], 0.9, s.body[1]), bq('pk', s.body[0], 0.9, s.body[1])];
      this.inA = bq('bp', s.intakeHz, 1.6); this.inB = bq('bp', s.intakeHz * 2.3, 1.2); this.inEnv = 0; this.inLp = 0;
      this.kIn = pole(sr, 0.004); this.kInLp = pole(sr, 0.0012);
      this.tickBp = bq('bp', 3800, 1.2); this.tickEnv = 0; this.tickDec = Math.exp(-1 / (sr * 0.0012));
      this.popBp = bq('bp', 1500, 0.9); this.popEnv = 0; this.popDec = 0.99;
      this.crkOn = false; this.crkT = 0;
      this.wander = 0; this.wob = 1;
      // turbo / blow-off / supercharger
      this.spool = 0; this.tPh = 0; this.tBp = bq('bp', 3000, 3); this.bovEnv = 0; this.bovArmed = false; this.bovBp = bq('bp', 3000, 1.3); this.bovT = 0;
      this.bPh = s.blower ? new Float64Array(s.blower.voices.length) : null;
      // reflections: ground bounce (one tap each side) and two short damped echoes
      const dl = ms => ({ b: new Float32Array(Math.max(2, Math.round(ms * sr / 1000))), p: 0, lp: 0 });
      this.tap = [dl(2.1), dl(3.3)]; this.echo = [dl(9.1), dl(12.7)];
      this.derive();
    }
    set(m) {
      const t = this.t;
      if (typeof m.rpm === 'number') t.rpm = m.rpm;
      if (typeof m.load === 'number') t.load = clamp(m.load, 0, 1);
      if (typeof m.overrun === 'number') t.overrun = m.overrun;
      if (typeof m.cut === 'number') t.cut = m.cut;
      if (typeof m.on === 'number') t.on = m.on;
      if (m.car && m.car !== this.id && CARS[m.car]) this.next = m.car; // swapped once the old car has faded out
    }
    // slow-moving values, refreshed every 64 samples
    derive() {
      const s = this.s, sr = this.sr, t = this.t;
      this.load += (t.load - this.load) * 0.03;
      this.over += (t.overrun - this.over) * 0.06;
      const load = this.load, n = this.rpmN = clamp((this.rpm - s.idle) / (s.redline - s.idle), 0, 1);
      // idle never sits perfectly still: the revs hunt a little
      this.wander += (gauss() * 0.9 - this.wander) * 0.02;
      this.wob = 1 + this.wander * 0.012 * (1 - n) * (1 - load);
      this.ampBase = s.gain * (0.26 + 0.74 * Math.pow(load, 0.8)) * (0.75 + 0.42 * n) * (1 - 0.4 * this.over);
      // blow-down takes a fixed time at low revs and a fixed crank angle at high revs; harder and shorter under load
      const rpm = Math.max(this.rpm, 200);
      this.pulseLen = sr * Math.min(s.pulse[0] / 1000, s.pulse[1] / (6 * rpm)) * (1.18 - 0.36 * load);
      this.noiseAmt = s.noise * (0.3 + 0.7 * load);
      this.noiseDec = Math.exp(-1 / (sr * lerp(0.0045, 0.0012, n)));
      this.jit = s.jitter * (1 + 1.6 * (1 - n));
      this.lope = s.lope * (1 - clamp(n * 5, 0, 1)) * (1 - load);
      this.interval = sr * 120 / (rpm * this.nEv);
      const open = clamp(0.1 + 0.68 * load + 0.25 * n, 0, 1), hz = s.muffler[0] * Math.pow(s.muffler[1] / s.muffler[0], open);
      this.muf[0].set('lp', hz, 0.75, 0, sr); this.muf[1].set('lp', hz, 0.75, 0, sr);
      this.muf[2].set('lp', hz * 1.2, 0.6, 0, sr); this.muf[3].set('lp', hz * 1.2, 0.6, 0, sr);
      this.drive = 1 + (s.drive - 1) * (0.25 + 0.75 * load);
      this.norm = 0.62 / sat(this.drive * 0.62);
      this.inNoise = s.intake * load * (0.25 + 0.75 * n);
      this.inTone = s.intake * 1.6 * load * (0.3 + 0.7 * n);
      this.tickAmp = s.tick * (0.5 + 0.5 * n);
      // afterfire comes in ragged bursts, not a steady patter
      this.crkT -= 64;
      if (this.crkT <= 0) { this.crkOn = !this.crkOn; this.crkT = sr * (this.crkOn ? 0.04 + 0.18 * Math.random() : 0.08 + 0.42 * Math.random()); }
      this.crkP = s.crackle * this.over * (this.crkOn ? 0.3 : 0.02);
      const tb = s.turbo;
      if (tb) {
        const want = clamp(load * 1.15 * (0.2 + 0.8 * n), 0, 1);
        this.spool += (want - this.spool) * (want > this.spool ? 0.0028 : 0.006);
        if (load > 0.45) this.bovArmed = true;
        if (this.bovArmed && t.load < 0.12 && this.spool > 0.3) { this.bovArmed = false; this.bovEnv = this.spool * tb.bov; this.bovT = 0; this.spool *= 0.35; }
        this.tHz = lerp(tb.hz[0], tb.hz[1], this.spool);
        this.tBp.set('bp', this.tHz * 0.8, 2.5, 0, sr);
        this.tAmp = tb.level * this.spool * this.spool;
        if (this.bovEnv > 1e-4) { this.bovT += 64 / sr; this.bovBp.set('bp', 3800 * Math.exp(-this.bovT * 2.4) + 1100, 1.3, 0, sr); this.bovEnv *= Math.exp(-64 / (sr * 0.16)); }
      }
      const bl = s.blower;
      this.bAmp = bl ? bl.level * clamp((load - bl.load[0]) / (bl.load[1] - bl.load[0]), 0, 1) * (0.15 + 0.85 * clamp(this.rpm / s.redline, 0, 1)) : 0;
    }
    pop(bank, k) {
      const sr = this.sr, g = this.s.gain;
      bank.add(0, sr * 0.0011, k * g * 1.5, k * g * 1.1, Math.exp(-1 / (sr * (0.002 + 0.004 * Math.random()))));
      if (k > this.popEnv) { this.popEnv = k; this.popBp.set('bp', 800 + 1800 * Math.random(), 0.8, 0, sr); this.popDec = Math.exp(-1 / (sr * (0.005 + 0.011 * Math.random()))); }
    }
    fire(e) {
      const s = this.s, bank = this.banks[this.evBank[e]], cyl = this.evCyl[e];
      if (this.t.cut > 0.5) { // ignition cut: the engine only pumps air, and unburnt fuel lights up in the pipe
        bank.add(0, this.pulseLen, this.ampBase * 0.16, 0, 0);
        if (Math.random() < 0.1 * s.crackle) this.pop(bank, 0.5 + 0.5 * Math.random());
        return;
      }
      let amp = this.ampBase * this.trim[cyl] * (1 + this.jit * gauss());
      if (this.lope > 0 && Math.random() < this.lope) amp *= 0.3 + 0.35 * Math.random();
      if (amp < 0) amp = 0;
      const run = s.runner && s.runner[cyl];
      if (run) amp *= run[1];
      const delay = (run ? run[0] * this.sr / 1000 : 0) + Math.random() * s.timing * this.interval;
      bank.add(delay, this.pulseLen * (0.86 + 0.28 * Math.random()), amp, amp * this.noiseAmt, this.noiseDec);
      const tk = this.tickAmp * (0.5 + Math.random()); if (tk > this.tickEnv) this.tickEnv = tk;
      if (this.crkP > 0 && Math.random() < this.crkP) this.pop(bank, 0.25 + 0.75 * Math.random());
    }
    process(outL, outR, n) {
      const sr = this.sr, t = this.t, banks = this.banks, nb = banks.length, cps = 1 / (120 * sr), s = this.s;
      for (let i = 0; i < n; i++) {
        if (this.blk === 0) {
          if (this.next && this.g < 0.003) { const id = this.next; this.next = null; this.configure(id); }
          this.derive();
        }
        this.blk = (this.blk + 1) & 63;
        this.g += ((this.next ? 0 : t.on) - this.g) * this.kG;
        if (this.g < 1e-4 && !t.on) { outL[i] = 0; outR[i] = 0; this.rpm = t.rpm; continue; }
        this.rpm += (t.rpm - this.rpm) * this.kRpm;

        this.phase += this.rpm * this.wob * cps;
        while (this.phase >= this.evPos[this.ne]) {
          if (this.ne === this.nEv) { this.phase -= 1; this.ne = 0; } else this.fire(this.ne++);
        }

        let L = 0, R = 0, exc = 0;
        for (let b = 0; b < nb; b++) { const bk = banks[b], y = bk.tick(); L += y * bk.gl; R += y * bk.gr; exc += bk.exc; }
        L = this.body[0].run(this.muf[2].run(this.muf[0].run(this.hp[0].run(L))));
        R = this.body[1].run(this.muf[3].run(this.muf[1].run(this.hp[1].run(R))));

        // intake: the same pulses, heard from the other end of the engine (tone) plus rushing air that breathes with them
        const ax = exc < 0 ? -exc : exc;
        this.inEnv += (ax - this.inEnv) * this.kIn; this.inLp += (exc - this.inLp) * this.kInLp;
        if (this.inNoise > 1e-4) {
          const x = white() * this.inNoise * (0.3 + 2.2 * this.inEnv) + this.inLp * this.inTone;
          const y = this.inA.run(x) + 0.5 * this.inB.run(x);
          L += y; R += y;
        }
        if (this.tAmp > 1e-5) { // turbo: a whistle that climbs with boost, inside a hiss of air
          this.tPh += this.tHz / sr; if (this.tPh >= 1) this.tPh -= 1;
          const y = this.tAmp * (0.5 * Math.sin(TAU * this.tPh) + 2.2 * this.tBp.run(white()));
          L += y; R += y;
        }

        L = sat(L * this.drive + 0.1) * this.norm; R = sat(R * this.drive + 0.1) * this.norm;

        // after the saturation: sounds that are not exhaust gas
        let extra = 0;
        if (this.popEnv > 1e-4) { extra += this.popBp.run(white() * this.popEnv) * s.pop; this.popEnv *= this.popDec; }
        if (this.tickEnv > 1e-4) { extra += this.tickBp.run(white() * this.tickEnv); this.tickEnv *= this.tickDec; }
        if (this.bovEnv > 1e-4) {
          const fl = s.turbo.flutter ? 1 - s.turbo.flutter * (0.5 + 0.5 * Math.sin(TAU * this.bovT * (34 - 30 * this.bovT))) : 1;
          extra += this.bovBp.run(white()) * this.bovEnv * fl * 1.6;
        }
        if (this.bAmp > 1e-5) { // supercharger: a few rotors' worth of whine, slightly apart, beating
          const bl = s.blower, dp = this.rpm / 60 * bl.ratio / sr; let w = 0;
          for (let j = 0; j < bl.voices.length; j++) {
            let ph = this.bPh[j] + dp * bl.voices[j][0]; if (ph >= 1) ph -= 1; this.bPh[j] = ph;
            let v = 0; for (let h = 0; h < bl.harm.length && (h + 1) * dp < 0.45; h++) v += bl.harm[h] * Math.sin(TAU * ph * (h + 1));
            w += v * bl.voices[j][1];
          }
          extra += w * this.bAmp;
        }

        // reflections
        const ta = this.tap[0], tb2 = this.tap[1], ea = this.echo[0], eb = this.echo[1];
        const l1 = ta.b[ta.p], r1 = tb2.b[tb2.p]; ta.b[ta.p] = L; tb2.b[tb2.p] = R;
        ta.p = (ta.p + 1) % ta.b.length; tb2.p = (tb2.p + 1) % tb2.b.length;
        ea.lp += 0.3 * (ea.b[ea.p] - ea.lp); eb.lp += 0.3 * (eb.b[eb.p] - eb.lp);
        ea.b[ea.p] = L + eb.lp * 0.38 + 1e-20; eb.b[eb.p] = R + ea.lp * 0.38 + 1e-20;
        ea.p = (ea.p + 1) % ea.b.length; eb.p = (eb.p + 1) % eb.b.length;
        L += l1 * 0.3 + ea.lp * 0.22; R += r1 * 0.3 + eb.lp * 0.22;

        const og = this.g * s.out * 1.25;
        outL[i] = limit((L + extra) * og); outR[i] = limit((R + extra) * og);
      }
    }
  }

  if (typeof registerProcessor === 'function') {
    registerProcessor('drivefx-engine', class extends AudioWorkletProcessor {
      constructor() { super(); this.m = new EngineModel(sampleRate, 'v8'); this.port.onmessage = e => this.m.set(e.data); }
      process(_, outputs) {
        const o = outputs[0], L = o[0], R = o[1] || (this.tmp || (this.tmp = new Float32Array(L.length)));
        this.m.process(L, R, L.length);
        return true;
      }
    });
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { EngineModel, CARS };
})();
