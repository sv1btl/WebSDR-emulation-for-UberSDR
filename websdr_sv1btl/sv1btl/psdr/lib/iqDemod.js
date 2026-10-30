// ─────────────────────────────────────────────────────────────────────────────
// IQ demodulator bank — several receivers inside the 12 kHz IQ stream.
//
// In IQ the server stops demodulating and sends the band around the dial as
// I/Q (stereo FLAC, see src/signal.cpp). This bank listens to that stream in
// the browser, up to MAX_DEMODS times at once: each demodulator has its own
// offset from the dial, mode, filter width, level and place between the ears,
// so both sides of a split, or a net and the DX it is working, are one stream.
// It costs the receiver nothing — the server sends the same I/Q either way.
//
// Each demodulator, for every sample of the complex input x:
//   z = x · e^(−j2π·f1·t)          bring its passband centre to 0 Hz
//   y = LPF(z)                     windowed-sinc, half the passband wide
//   then by mode:
//     USB/LSB/CW  a = Re(y · e^(+j2π·c·t))   c = passband centre in audio Hz
//     AM          a = |y| − DC
//     DSB         a = Re(y · e^(−jθ)) − DC, θ from a Costas loop locked to
//                 the carrier (or to the suppressed one), so a few Hz of
//                 mistuning does not fade the audio; with a carrier it is SAM
//     FM          a = arg(y[n]·conj(y[n−1])), de-emphasised
//   and a peak AGC with a gain ceiling, so a quiet band stays quiet.
//
// SSB passbands follow the receiver's own defaults (USB 50 Hz to the width,
// LSB the mirror); CW puts the signal on a 600 Hz note, the receiver's pitch.
// Output: interleaved stereo at the input rate, mixed with equal-power pan.
// ─────────────────────────────────────────────────────────────────────────────

import { transformFlat } from './fftRadix2.js';

export const MAX_DEMODS = 6;
export const DEMOD_MODES = ['USB', 'LSB', 'CW', 'AM', 'DSB', 'FM'];
export const DEMOD_COLORS = ['#22d3ee', '#fbbf24', '#e879f9', '#a3e635', '#fb923c', '#60a5fa'];

// Default filter width per mode (Hz) and the range offered.
export const DEFAULT_BW = { USB: 2700, LSB: 2700, CW: 500, AM: 6000, DSB: 6000, FM: 10000 };
export const BW_RANGE = {
  USB: [500, 4000], LSB: [500, 4000], CW: [100, 1500], AM: [2000, 10000], DSB: [1000, 10000],
  FM: [5000, 12000],
};

const TAPS = 127;          // odd: linear phase about the middle tap
const CW_PITCH = 600;      // Hz, the receiver's CW note
const SSB_LOW = 50;        // Hz, low edge of an SSB passband
const AGC_TARGET = 0.25;   // peak level the AGC aims for
const AGC_MAX_GAIN = 10;   // +20 dB at most: band noise stays below speech
const SPEC_N = 512;
const PLL_BN = 15;         // Hz, DSB Costas loop natural frequency
const PLL_MAX = 60;        // Hz, how far the loop may pull from the offset        // spectrum FFT size (23 Hz bins at 12 kHz)

function lowpassTaps(halfHz, fs) {
  const fc = Math.min(0.49, Math.max(1e-4, halfHz / fs));
  const h = new Float32Array(TAPS);
  const m = (TAPS - 1) / 2;
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const n = i - m;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    // Blackman: about −74 dB stopband, enough to keep the neighbour out.
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (TAPS - 1)) +
              0.08 * Math.cos((4 * Math.PI * i) / (TAPS - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < TAPS; i++) h[i] /= sum;
  return h;
}

class Demod {
  constructor(fs, cfg) {
    this.fs = fs;
    this.id = cfg.id;
    this.hi = new Float32Array(TAPS * 2);   // history, written twice so a
    this.hq = new Float32Array(TAPS * 2);   // window is always contiguous
    this.pos = 0;
    this.ph1 = 0; this.ph2 = 0;             // NCO phases (cycles)
    this.dc = 0;                            // AM carrier level
    this.pi = 0; this.pq = 0;               // FM previous sample
    this.deem = 0;                          // FM de-emphasis state
    this.th = 0; this.fr = 0;               // DSB loop phase (rad), freq (rad/sample)
    this.env = 0;                           // AGC envelope
    this.pow = 0;                           // smoothed passband power
    this.set(cfg);
  }

  set(cfg) {
    const prev = { mode: this.mode, bw: this.bw };
    this.mode = DEMOD_MODES.includes(cfg.mode) ? cfg.mode : (this.mode || 'AM');
    const [lo, hi] = BW_RANGE[this.mode];
    const bw = cfg.bw != null ? cfg.bw : (prev.mode === this.mode ? this.bw : DEFAULT_BW[this.mode]);
    this.bw = Math.min(hi, Math.max(lo, Number(bw) || DEFAULT_BW[this.mode]));
    if (cfg.offset != null) this.offset = Math.max(-6000, Math.min(6000, Number(cfg.offset) || 0));
    if (this.offset == null) this.offset = 0;
    if (cfg.vol != null) this.vol = Math.max(0, Math.min(2, Number(cfg.vol)));
    if (this.vol == null) this.vol = 1;
    if (cfg.pan != null) this.pan = Math.max(-1, Math.min(1, Number(cfg.pan)));
    if (this.pan == null) this.pan = 0;
    if (cfg.mute != null) this.mute = !!cfg.mute;
    if (this.mute == null) this.mute = false;

    // Audio passband [a, b] in Hz once the dial (offset) is at 0 Hz, and its
    // centre c: the first NCO moves c to 0 Hz, the low-pass keeps ±(b−a)/2.
    let a, b;
    switch (this.mode) {
      case 'USB': a = SSB_LOW; b = this.bw; break;
      case 'LSB': a = -this.bw; b = -SSB_LOW; break;
      case 'CW':  a = -this.bw / 2; b = this.bw / 2; break;   // around the signal
      default:    a = -this.bw / 2; b = this.bw / 2;          // AM, FM
    }
    this.c = (a + b) / 2;
    this.f1 = this.offset + this.c;
    // CW: the signal itself is the centre, heard as a CW_PITCH note.
    this.f2 = this.mode === 'CW' ? CW_PITCH : this.c;
    if (prev.mode !== this.mode || prev.bw !== this.bw || !this.h) {
      this.h = lowpassTaps((b - a) / 2, this.fs);
      this.env = 0;
      this.th = 0; this.fr = 0; this.dc = 0;
    } else if (cfg.offset != null) {
      this.fr = 0;                          // retuned: start the loop afresh
    }
    const g = (this.pan + 1) * Math.PI / 4;
    this.gl = Math.cos(g); this.gr = Math.sin(g);
  }

  // Adds this demodulator's audio for `n` frames of interleaved I/Q `x` into
  // the interleaved stereo `out`.
  run(x, n, out) {
    const fs = this.fs, h = this.h, hi = this.hi, hq = this.hq;
    const d1 = this.f1 / fs, d2 = this.f2 / fs;
    const deemA = Math.exp(-1 / (fs * 530e-6));     // NBFM de-emphasis
    const dcA = 1 - 1 / (fs * 0.2);                 // AM/DSB carrier, ~0.2 s
    // DSB: second-order Costas loop, damping 0.707.
    const wT = 2 * Math.PI * PLL_BN / fs;
    const pa = 1.414 * wT, pb = wT * wT, frMax = 2 * Math.PI * PLL_MAX / fs;
    const atk = 0.3, rel = Math.exp(-1 / (fs * 0.6));
    const vol = this.mute ? 0 : this.vol;
    const gl = this.gl * vol, gr = this.gr * vol;
    let ph1 = this.ph1, ph2 = this.ph2, pos = this.pos;
    let pw = 0;
    for (let k = 0; k < n; k++) {
      const xi = x[2 * k], xq = x[2 * k + 1];
      const c1 = Math.cos(2 * Math.PI * ph1), s1 = Math.sin(2 * Math.PI * ph1);
      ph1 += d1; ph1 -= Math.floor(ph1);
      // z = x · e^(−jθ)
      const zi = xi * c1 + xq * s1;
      const zq = xq * c1 - xi * s1;
      hi[pos] = hi[pos + TAPS] = zi;
      hq[pos] = hq[pos + TAPS] = zq;
      pos = pos + 1 === TAPS ? 0 : pos + 1;
      let yi = 0, yq = 0;
      for (let t = 0; t < TAPS; t++) { yi += h[t] * hi[pos + t]; yq += h[t] * hq[pos + t]; }
      pw += yi * yi + yq * yq;

      let a;
      if (this.mode === 'AM') {
        const m = Math.sqrt(yi * yi + yq * yq);
        this.dc = this.dc * dcA + m * (1 - dcA);
        a = m - this.dc;
      } else if (this.mode === 'DSB') {
        const ct = Math.cos(this.th), st = Math.sin(this.th);
        const ui = yi * ct + yq * st;         // y · e^(−jθ)
        const uq = yq * ct - yi * st;
        // I·Q / |u|² = ½·sin 2φ whatever the level; the π ambiguity only
        // inverts the audio.
        const e = (ui * uq) / (ui * ui + uq * uq + 1e-20);
        this.fr = Math.max(-frMax, Math.min(frMax, this.fr + pb * e));
        this.th += this.fr + pa * e;
        if (this.th > Math.PI) this.th -= 2 * Math.PI; else if (this.th < -Math.PI) this.th += 2 * Math.PI;
        this.dc = this.dc * dcA + ui * (1 - dcA);
        a = ui - this.dc;
      } else if (this.mode === 'FM') {
        // arg(y · conj(prev)), scaled so ±3 kHz deviation is about ±1
        const re = yi * this.pi + yq * this.pq, im = yq * this.pi - yi * this.pq;
        this.pi = yi; this.pq = yq;
        const f = Math.atan2(im, re) * fs / (2 * Math.PI * 3000);
        this.deem = this.deem * deemA + f * (1 - deemA);
        a = this.deem;
      } else {
        const c2 = Math.cos(2 * Math.PI * ph2), s2 = Math.sin(2 * Math.PI * ph2);
        a = yi * c2 - yq * s2;                // Re(y · e^(+jφ))
      }
      ph2 += d2; ph2 -= Math.floor(ph2);

      if (this.mode === 'FM') {
        // FM is already at a fixed level; the AGC would only pump on noise.
        a *= 0.5;
      } else {
        const m = Math.abs(a);
        this.env = m > this.env ? this.env + (m - this.env) * atk : this.env * rel;
        a *= Math.min(AGC_MAX_GAIN, AGC_TARGET / Math.max(this.env, 1e-9));
      }
      out[2 * k] += a * gl;
      out[2 * k + 1] += a * gr;
    }
    this.ph1 = ph1; this.ph2 = ph2; this.pos = pos;
    if (n) this.pow = this.pow * 0.8 + (pw / n) * 0.2;
  }

  config() {
    return { id: this.id, mode: this.mode, offset: this.offset, bw: this.bw,
             vol: this.vol, pan: this.pan, mute: this.mute };
  }
}

export class IQDemodBank {
  constructor(fs = 12000) {
    this.fs = fs;
    this.demods = [];
    this.listening = true;     // false: the raw I/Q plays, as without the bank
    this._nextId = 1;
    this._spec = { re: new Float64Array(SPEC_N), im: new Float64Array(SPEC_N),
                   ring: new Float32Array(SPEC_N * 2), w: 0,
                   avg: new Float32Array(SPEC_N), fresh: false };
    const win = new Float32Array(SPEC_N);
    for (let i = 0; i < SPEC_N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (SPEC_N - 1));
    this._spec.win = win;
  }

  setRate(fs) {
    if (!fs || fs === this.fs) return;
    this.fs = fs;
    const cfgs = this.demods.map((d) => d.config());
    this.demods = cfgs.map((c) => new Demod(fs, c));
  }

  add(cfg = {}) {
    if (this.demods.length >= MAX_DEMODS) return null;
    const d = new Demod(this.fs, { mode: 'AM', offset: 0, ...cfg, id: this._nextId++ });
    this.demods.push(d);
    return d.id;
  }

  update(id, patch) {
    const d = this.demods.find((x) => x.id === id);
    if (d) d.set(patch);
  }

  remove(id) {
    this.demods = this.demods.filter((x) => x.id !== id);
  }

  configs() { return this.demods.map((d) => d.config()); }

  load(cfgs) {
    this.demods = [];
    for (const c of (cfgs || []).slice(0, MAX_DEMODS)) this.add({ ...c });
  }

  // Passband power per demodulator, dBFS (for the row meters).
  levels() {
    const o = {};
    for (const d of this.demods) o[d.id] = 10 * Math.log10(d.pow + 1e-12);
    return o;
  }

  // One decoded IQ block (interleaved I,Q at ±1) in, interleaved stereo out.
  process(iq) {
    const n = iq.length >> 1;
    this._feedSpectrum(iq, n);
    if (!this.listening || this.demods.length === 0) return iq;
    const out = new Float32Array(n * 2);
    for (const d of this.demods) d.run(iq, n, out);
    for (let i = 0; i < out.length; i++) {
      const v = out[i];
      out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
    return out;
  }

  _feedSpectrum(iq, n) {
    const s = this._spec;
    for (let k = 0; k < n; k++) {
      s.ring[2 * s.w] = iq[2 * k];
      s.ring[2 * s.w + 1] = iq[2 * k + 1];
      s.w = (s.w + 1) % SPEC_N;
      s.fresh = true;
    }
  }

  // The last SPEC_N samples as a spectrum, −fs/2 … +fs/2, in dBFS, averaged
  // over a few calls. Null until the stream has delivered anything.
  spectrum() {
    const s = this._spec;
    if (!s.fresh) return null;
    for (let i = 0; i < SPEC_N; i++) {
      const j = (s.w + i) % SPEC_N;
      s.re[i] = s.ring[2 * j] * s.win[i];
      s.im[i] = s.ring[2 * j + 1] * s.win[i];
    }
    transformFlat(s.re, s.im, false);
    const half = SPEC_N / 2;
    for (let i = 0; i < SPEC_N; i++) {
      const b = (i + half) % SPEC_N;                    // fftshift
      const p = (s.re[b] * s.re[b] + s.im[b] * s.im[b]) / (SPEC_N * SPEC_N / 4);
      const db = 10 * Math.log10(p + 1e-14);
      s.avg[i] = s.avg[i] === 0 ? db : s.avg[i] * 0.6 + db * 0.4;
    }
    return { db: s.avg, fs: this.fs };
  }
}
