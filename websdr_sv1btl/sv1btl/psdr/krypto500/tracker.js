// krypto500/tracker.js — baseband ring buffer + equalising symbol tracker
// ============================================================================
// Ring: the 9600 Hz complex baseband (4 samples/symbol) kept by absolute
// sample number, so an acquisition can look back at the symbols it has just
// recognised and the tracker can then run through them again.
//
// Tracker: a fractionally spaced (T/2) decision-feedback equaliser adapted by
// normalised LMS, with a second-order carrier loop on its output. Known
// symbols (preambles, probes) train it; unknown symbols use decisions taken
// from the constellation the caller allows. The 188-110 reference receiver
// found an adaptive DFE weaker than channel-estimate equalisers in fast
// fading, but it is cheap and works on the ordinary channels of a monitor.
// ============================================================================

import { SPS, BB_RATE, PSK_RE, PSK_IM } from './common.js';

export class Ring {
  constructor(bits = 17) {
    this.size = 1 << bits; this.mask = this.size - 1;
    this.re = new Float32Array(this.size); this.im = new Float32Array(this.size);
    this.n = 0;   // samples written (absolute index of the next one)
  }
  push(r, i) { const p = this.n & this.mask; this.re[p] = r; this.im[p] = i; this.n++; }
  has(idx) { return idx >= 0 && idx < this.n && idx > this.n - this.size; }
  r(idx) { return this.re[idx & this.mask]; }
  i(idx) { return this.im[idx & this.mask]; }
}

const NFF = 12, CEN = 4;   // FF taps at T/2 spacing; tap CEN sits on the symbol instant
const NFB = 5;

export class Tracker {
  /**
   * ring: Ring; t0: absolute sample index of symbol 0; foHz: carrier offset;
   * phase0: initial phase (rad); gain: complex channel gain estimate (re, im).
   */
  constructor(ring, t0, foHz, phase0 = 0, gainRe = 1, gainIm = 0) {
    this.ring = ring;
    this.t0 = t0;
    this.sps = SPS;                            // samples per symbol (follows the clock)
    this.k = 0;                                // next symbol index
    this.w = new Float64Array(NFF * 2);        // FF taps (re, im)
    this.b = new Float64Array(NFB * 2);        // FB taps
    this.d = new Float64Array(NFB * 2);        // past decisions
    // initial FF: 1 / gain on the centre tap (gain from the acquisition)
    const g2 = gainRe * gainRe + gainIm * gainIm || 1;
    this.w[2 * CEN] = gainRe / g2; this.w[2 * CEN + 1] = -gainIm / g2;
    this.theta = phase0;
    this.dtheta = 2 * Math.PI * foHz / BB_RATE * SPS;   // per symbol
    this.errAvg = 1; this.sigAvg = 1;
    this.errKnown = 1;                         // error on known symbols only
    this.mu = 0.03;
    this.kp = 0.02; this.ki = 0.0002;    // carrier loop (per symbol)
    this._x = new Float64Array(NFF * 2);
    this.slip = 0;
  }

  /** Is the window of the next symbol already in the ring? */
  ready() { return this.ring.n > this.t0 + this.k * this.sps + (NFF - CEN) * this.sps / 2 + 3; }

  /** linearly interpolated ring sample at a fractional index */
  _rd(x, out, j) {
    const i = Math.floor(x), f = x - i, ring = this.ring;
    out[j] = ring.r(i) * (1 - f) + ring.r(i + 1) * f;
    out[j + 1] = ring.i(i) * (1 - f) + ring.i(i + 1) * f;
  }

  /**
   * Timing error (in samples) of the known symbols k0.. (tribits): the
   * correlation peak over offsets ±1.5 samples, non-coherent in chunks of
   * 16 so a residual carrier offset does not matter. Then follows it: half
   * of the error at once, and the symbol spacing a little (clock offset).
   */
  syncTiming(k0, tribits) {
    const v = new Float64Array(2);
    const met = (off) => {
      let tot = 0;
      for (let c = 0; c < tribits.length; c += 16) {
        let cr = 0, ci = 0;
        for (let q = c; q < Math.min(tribits.length, c + 16); q++) {
          this._rd(this.t0 + (k0 + q) * this.sps + off, v, 0);
          const t = tribits[q] & 7, rr = PSK_RE[t], ri = -PSK_IM[t];
          cr += v[0] * rr - v[1] * ri; ci += v[0] * ri + v[1] * rr;
        }
        tot += Math.hypot(cr, ci);
      }
      return tot;
    };
    const offs = [-1.5, -1, -0.5, 0, 0.5, 1, 1.5], m = offs.map(met);
    let b = 3; for (let i = 0; i < m.length; i++) if (m[i] > m[b]) b = i;
    let e = offs[b];
    if (b > 0 && b < m.length - 1) { const den = m[b - 1] - 2 * m[b] + m[b + 1]; if (den < 0) e += 0.5 * 0.5 * (m[b - 1] - m[b + 1]) / den; }
    const dk = Math.max(1, k0 - (this._lastSyncK ?? k0 - 256));
    this._lastSyncK = k0;
    // gentle: in multipath the peak is broad and jumps; the equaliser's
    // own taps take the rest
    this.t0 += (this.timingGain ?? 0.5) * e;
    this.sps += (this.timingGain ?? 0.5) * 0.5 * e / dk;
    this.sps = Math.max(SPS * 0.99, Math.min(SPS * 1.01, this.sps));
    return e;
  }

  /** Offset of the carrier loop in Hz. */
  get foHz() { return this.dtheta / (2 * Math.PI) / SPS * BB_RATE; }

  /** SNR estimate in dB from the error of trained/decided symbols. */
  get snrDb() { return 10 * Math.log10(Math.max(1e-6, this.sigAvg) / Math.max(1e-6, this.errAvg)); }

  /**
   * One symbol. known: tribit (0..7) or -1. decide(yr, yi) -> tribit used as
   * the reference for unknown symbols. Returns { yr, yi } after equalisation
   * and carrier removal (the caller descrambles/demaps).
   */
  step(known, decide, mu = this.mu) {
    const x = this._x;
    const base = this.t0 + this.k * this.sps, half = this.sps / 2;
    for (let i = 0; i < NFF; i++) this._rd(base + (i - CEN) * half, x, 2 * i);
    // FF output
    let yr = 0, yi = 0, px = 1e-9;
    const w = this.w;
    for (let i = 0; i < NFF; i++) {
      const a = x[2 * i], c = x[2 * i + 1], wr = w[2 * i], wi = w[2 * i + 1];
      yr += wr * a - wi * c; yi += wr * c + wi * a; px += a * a + c * c;
    }
    // carrier removal
    const cs = Math.cos(this.theta), sn = Math.sin(this.theta);
    let zr = yr * cs + yi * sn, zi = yi * cs - yr * sn;
    // feedback (in the derotated domain)
    const b = this.b, d = this.d;
    for (let j = 0; j < NFB; j++) {
      zr -= b[2 * j] * d[2 * j] - b[2 * j + 1] * d[2 * j + 1];
      zi -= b[2 * j] * d[2 * j + 1] + b[2 * j + 1] * d[2 * j];
    }
    const t = known >= 0 ? known : decide(zr, zi);
    const rr = PSK_RE[t & 7], ri = PSK_IM[t & 7];
    const er = rr - zr, ei = ri - zi;
    // tap updates: error back in the rotated (input) domain for the FF part
    const ur = er * cs - ei * sn, ui = ei * cs + er * sn;
    const g = mu / px;
    for (let i = 0; i < NFF; i++) {
      const a = x[2 * i], c = x[2 * i + 1];
      // w += g * e * conj(x)
      w[2 * i] += g * (ur * a + ui * c);
      w[2 * i + 1] += g * (ui * a - ur * c);
    }
    const gb = mu / (NFB + 1e-9);
    for (let j = 0; j < NFB; j++) {
      // FB is subtracted: b -= gb * e * conj(d)  →  b += gb*... with sign
      b[2 * j] -= gb * (er * d[2 * j] + ei * d[2 * j + 1]);
      b[2 * j + 1] -= gb * (ei * d[2 * j] - er * d[2 * j + 1]);
    }
    for (let j = NFB - 1; j > 0; j--) { d[2 * j] = d[2 * j - 2]; d[2 * j + 1] = d[2 * j - 1]; }
    d[0] = rr; d[1] = ri;
    // carrier loop on the phase error
    const pe = Math.atan2(zi * rr - zr * ri, zr * rr + zi * ri);
    // known symbols steer the loop fully, decided ones at half weight (a
    // wrong decision would otherwise walk it into a cycle slip)
    const kw = known >= 0 ? 1 : 0.5;
    this.theta += this.dtheta + this.kp * kw * pe;
    this.dtheta += this.ki * kw * pe;
    if (this.theta > Math.PI) this.theta -= 2 * Math.PI; else if (this.theta < -Math.PI) this.theta += 2 * Math.PI;
    const e2 = er * er + ei * ei;
    this.errAvg += 0.01 * (e2 - this.errAvg);
    if (known >= 0) this.errKnown += 0.01 * (e2 - this.errKnown);
    this.sigAvg += 0.01 * (1 - this.sigAvg);
    this.k++;
    this._timing();
    return { yr: zr, yi: zi, err: e2 };
  }

  /** Follow a slow clock offset: keep the strongest FF tap on the centre. */
  _timing() {
    if (this.k % 96) return;
    const w = this.w;
    let mx = 0, at = CEN;
    for (let i = 0; i < NFF; i++) { const m = w[2 * i] ** 2 + w[2 * i + 1] ** 2; if (m > mx) { mx = m; at = i; } }
    if (at === CEN) return;
    const sh = at > CEN ? 1 : -1;     // taps shift by one T/2 position
    this.t0 += sh * this.sps / 2;
    this.slip += sh;
    if (sh > 0) { for (let i = 0; i < NFF - 1; i++) { w[2 * i] = w[2 * i + 2]; w[2 * i + 1] = w[2 * i + 3]; } w[2 * NFF - 2] = 0; w[2 * NFF - 1] = 0; }
    else { for (let i = NFF - 1; i > 0; i--) { w[2 * i] = w[2 * i - 2]; w[2 * i + 1] = w[2 * i - 1]; } w[0] = 0; w[1] = 0; }
  }
}

/** Nearest tribit among `allowed` (array) after adding `rot` (mod 8). */
export function nearest(zr, zi, allowed, rot) {
  let best = 0, bd = Infinity;
  for (const a of allowed) {
    const t = (a + rot) & 7;
    const dr = zr - PSK_RE[t], di = zi - PSK_IM[t];
    const dd = dr * dr + di * di;
    if (dd < bd) { bd = dd; best = t; }
  }
  return best;
}

/**
 * Max-log soft bits for a symbol: `labels` maps each allowed (unscrambled)
 * tribit to its bit tuple. z is descrambled already. Returns soft values,
 * positive = 0, scaled by 1/noise.
 */
export function softBits(zr, zi, labels, nbits, noise, out, at) {
  const best0 = new Array(nbits).fill(Infinity), best1 = new Array(nbits).fill(Infinity);
  for (const [t, bits] of labels) {
    const dr = zr - PSK_RE[t], di = zi - PSK_IM[t];
    const dd = dr * dr + di * di;
    for (let k = 0; k < nbits; k++) {
      if (bits[k]) { if (dd < best1[k]) best1[k] = dd; } else if (dd < best0[k]) best0[k] = dd;
    }
  }
  const s = 1 / Math.max(0.02, noise);
  for (let k = 0; k < nbits; k++) out[at + k] = Math.max(-20, Math.min(20, (best1[k] - best0[k]) * s * 0.5));
}
