// krypto500/common.js — shared pieces of the Krypto500 decoders in SERVICES
// ============================================================================
// The PSK modems (MIL-STD-188-110A serial tone, STANAG 4285, 3G ALE BW0) all
// use 8-PSK at 2400 symbols/s on an 1800 Hz audio carrier, and the same K=7
// rate-1/2 convolutional code (generators 133/171 octal). This module holds
// what they share:
//   Downconverter  real audio (any rate) -> complex baseband at 9600 Hz,
//                  4 samples per symbol, root-raised-cosine matched filter
//   Viterbi        soft-decision K=7 decoder, streaming or block/tail-biting
//   crc, bits      small helpers, an async (UART) character deframer
// Soft bits follow one convention everywhere: a positive value means "0",
// negative "1", 0 = no information (an erasure).
// ============================================================================

export const SYM_RATE = 2400;
export const SPS = 4;                       // samples per symbol after the front end
export const BB_RATE = SYM_RATE * SPS;      // 9600 Hz
export const CARRIER = 1800;

// 8-PSK points: tribit n -> exp(j n pi/4)
export const PSK_RE = new Float64Array(8), PSK_IM = new Float64Array(8);
for (let n = 0; n < 8; n++) { PSK_RE[n] = Math.cos(n * Math.PI / 4); PSK_IM[n] = Math.sin(n * Math.PI / 4); }

/** Root-raised-cosine taps (unit energy), `span` symbols, `sps` samples per symbol. */
export function rrcTaps(alpha, span, sps) {
  const n = span * sps + 1, h = new Float64Array(n), mid = (n - 1) / 2;
  let e = 0;
  for (let i = 0; i < n; i++) {
    const t = (i - mid) / sps;
    let v;
    if (Math.abs(t) < 1e-9) v = 1 - alpha + 4 * alpha / Math.PI;
    else if (Math.abs(Math.abs(t) - 1 / (4 * alpha)) < 1e-9) {
      v = alpha / Math.SQRT2 * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * alpha)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * alpha)));
    } else {
      v = (Math.sin(Math.PI * t * (1 - alpha)) + 4 * alpha * t * Math.cos(Math.PI * t * (1 + alpha))) / (Math.PI * t * (1 - (4 * alpha * t) ** 2));
    }
    h[i] = v; e += v * v;
  }
  const g = 1 / Math.sqrt(e);
  for (let i = 0; i < n; i++) h[i] *= g;
  return h;
}

/** Windowed-sinc low-pass taps, cutoff in Hz at sample rate fs. */
export function lowpassTaps(cutoff, fs, n) {
  const h = new Float64Array(n), mid = (n - 1) / 2, fc = cutoff / fs;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1));
    h[i] = sinc * w; s += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= s;
  return h;
}

/**
 * Real audio -> complex baseband at 9600 Hz (4 samples/symbol), carrier
 * removed, RRC matched-filtered. `onSample(re, im)` is called per output.
 * The carrier can be moved (setCarrier) to follow a tuning offset.
 */
export class Downconverter {
  constructor({ carrier = CARRIER, alpha = 0.35, onSample }) {
    this.carrier = carrier;
    this.onSample = onSample;
    this._rrc = rrcTaps(alpha, 8, SPS);
    this._fs = 0;
    this.reset();
  }

  reset() {
    this._ph = 0;
    this._lp = null; this._fs = 0;
    this._rq = new Float64Array(this._rrc.length * 4); this._rpos = 0;
    this._res = 0;
  }

  setCarrier(hz) { this.carrier = hz; }

  _setup(fs) {
    this._fs = fs;
    this._lp = lowpassTaps(1500, fs, fs > 20000 ? 95 : 63);
    this._lq = new Float64Array(this._lp.length * 4); this._lpos = 0;
    this._step = BB_RATE / fs;
    this._res = 0;
    // last two low-passed samples for linear interpolation
    this._pr = 0; this._pi = 0; this._cr = 0; this._ci = 0;
  }

  /** pcm: Float32Array at sample rate fs. */
  feed(pcm, fs) {
    if (fs !== this._fs) this._setup(fs);
    const lp = this._lp, L = lp.length, lq = this._lq;
    const dph = 2 * Math.PI * this.carrier / fs;
    for (let n = 0; n < pcm.length; n++) {
      const x = pcm[n];
      this._ph += dph; if (this._ph > Math.PI) this._ph -= 2 * Math.PI;
      // mix down (x * e^{-j ph}); store I,Q interleaved twice for a linear FIR read
      const i = x * Math.cos(this._ph), q = -x * Math.sin(this._ph);
      const p = this._lpos;
      lq[2 * p] = i; lq[2 * p + 1] = q;
      lq[2 * (p + L)] = i; lq[2 * (p + L) + 1] = q;
      this._lpos = (p + 1) % L;
      // the new low-passed sample (computed lazily only when an output is due
      // close to it would save time; at 12 kHz in / 9.6 kHz out nearly every
      // input yields an output, so compute it always)
      let fr = 0, fi = 0;
      const base = this._lpos;
      for (let k = 0; k < L; k++) { const c = lp[k]; fr += c * lq[2 * (base + k)]; fi += c * lq[2 * (base + k) + 1]; }
      this._pr = this._cr; this._pi = this._ci; this._cr = 2 * fr; this._ci = 2 * fi;
      // outputs that fall between the previous and this input sample
      this._res += this._step;
      while (this._res >= 1) {
        this._res -= 1;
        const t = 1 - this._res / this._step;   // 0 = previous, 1 = current
        this._out(this._pr + (this._cr - this._pr) * t, this._pi + (this._ci - this._pi) * t);
      }
    }
  }

  _out(re, im) {
    const h = this._rrc, M = h.length, q = this._rq;
    const p = this._rpos;
    q[2 * p] = re; q[2 * p + 1] = im;
    q[2 * (p + M)] = re; q[2 * (p + M) + 1] = im;
    this._rpos = (p + 1) % M;
    let r = 0, s = 0;
    const base = this._rpos;
    for (let k = 0; k < M; k++) { const c = h[k]; r += c * q[2 * (base + k)]; s += c * q[2 * (base + k) + 1]; }
    this.onSample(r, s);
  }
}

// ── K=7 rate-1/2 convolutional code, generators 133 / 171 (octal) ─────────
// The newest bit is at delay 0. T1 taps (delay 0..6) 1011011, T2 1111001.
const K = 7, NS = 64;
const T1 = [1, 0, 1, 1, 0, 1, 1], T2 = [1, 1, 1, 1, 0, 0, 1];
// state = previous 6 input bits, most recent in bit 5. Input u in state s goes
// to (u << 5) | (s >> 1); outputs computed below.
const OUT1 = new Uint8Array(NS * 2), OUT2 = new Uint8Array(NS * 2);
for (let s = 0; s < NS; s++) for (let u = 0; u < 2; u++) {
  const w = [u]; for (let d = 1; d < K; d++) w.push((s >> (6 - d)) & 1);
  let a = 0, b = 0; for (let d = 0; d < K; d++) { a ^= w[d] & T1[d]; b ^= w[d] & T2[d]; }
  OUT1[s * 2 + u] = a; OUT2[s * 2 + u] = b;
}

/** Encode bits (array of 0/1) from a cleared register, or a given 6-bit state. */
export function convEncode(bits, state = 0) {
  const out = new Uint8Array(bits.length * 2);
  let s = state;
  for (let i = 0; i < bits.length; i++) {
    const u = bits[i] & 1;
    out[2 * i] = OUT1[s * 2 + u]; out[2 * i + 1] = OUT2[s * 2 + u];
    s = (u << 5) | (s >> 1);
  }
  return out;
}

/**
 * Streaming soft Viterbi decoder for the 133/171 code. push(s1, s2) takes the
 * two soft values of one input bit; decoded bits come out `depth` bits late
 * through onBit. `fit` is a running quality score (1 = the soft values are
 * exactly a code sequence, ~0.75-0.86 for noise).
 */
export class Viterbi {
  constructor({ depth = 96, onBit = null } = {}) {
    this.depth = depth;
    this.onBit = onBit;
    this.reset();
  }

  reset(knownZeroState = false) {
    this._m = new Float64Array(NS).fill(knownZeroState ? -1e9 : 0);
    if (knownZeroState) this._m[0] = 0;
    this._n = new Float64Array(NS);
    this._hist = [];          // per step: Uint8Array(64) of the chosen predecessor bit
    this._out = 0;
    this._fitNum = 0; this._fitDen = 0;
    this.bits = 0;
  }

  push(s1, s2) {
    const m = this._m, n = this._n, dec = new Uint8Array(NS);
    for (let ns = 0; ns < NS; ns++) {
      const u = ns >> 5;
      const p0 = (ns & 31) << 1, p1 = p0 | 1;
      // branch metric = correlation: + s when the code bit is 0
      const b0 = m[p0] + (OUT1[p0 * 2 + u] ? -s1 : s1) + (OUT2[p0 * 2 + u] ? -s2 : s2);
      const b1 = m[p1] + (OUT1[p1 * 2 + u] ? -s1 : s1) + (OUT2[p1 * 2 + u] ? -s2 : s2);
      if (b1 > b0) { n[ns] = b1; dec[ns] = 1; } else { n[ns] = b0; dec[ns] = 0; }
    }
    let best = -Infinity;
    for (let i = 0; i < NS; i++) if (n[i] > best) best = n[i];
    for (let i = 0; i < NS; i++) m[i] = n[i] - best;   // normalise
    // metrics were normalised to a best of 0 last step, so `best` is the gain
    this._fitNum += best; this._fitDen += Math.abs(s1) + Math.abs(s2);
    this._hist.push(dec);
    if (this._hist.length > this.depth) this._traceOne();
  }

  /** Best-path fit since the last call (and resets the counters). */
  takeFit() {
    const f = this._fitDen > 0 ? this._fitNum / this._fitDen : 0;
    this._fitNum = 0; this._fitDen = 0;
    return f;
  }

  _bestState() {
    let b = 0; for (let i = 1; i < NS; i++) if (this._m[i] > this._m[b]) b = i; return b;
  }

  _traceOne() {
    // trace back from the best state through the whole history; emit the oldest bit
    let s = this._bestState();
    const H = this._hist;
    for (let k = H.length - 1; k > 0; k--) s = ((s & 31) << 1) | H[k][s];
    const bit = s >> 5;   // input bit that led to the state at step 0
    H.shift();
    this.bits++;
    if (this.onBit) this.onBit(bit);
  }

  /** Emit everything still held (end of a transmission). */
  flush() {
    let s = this._bestState();
    const H = this._hist, out = new Uint8Array(H.length);
    for (let k = H.length - 1; k >= 0; k--) { out[k] = s >> 5; s = ((s & 31) << 1) | H[k][s]; }
    this._hist = [];
    if (this.onBit) for (const b of out) { this.bits++; this.onBit(b); }
    return out;
  }
}

/**
 * Block decode of a tail-biting code word (soft values, 2 per bit). The word
 * is wrapped around three times and the middle copy is kept.
 */
export function viterbiTailBiting(soft) {
  const nb = soft.length / 2, out = [];
  const v = new Viterbi({ depth: 1e9 });
  for (let r = 0; r < 3; r++) for (let i = 0; i < nb; i++) v.push(soft[2 * i], soft[2 * i + 1]);
  const all = v.flush();
  for (let i = 0; i < nb; i++) out.push(all[nb + i]);
  // re-encode to measure agreement
  const state = (() => { let s = 0; for (let i = nb - 6; i < nb; i++) s = (out[i] << 5) | (s >> 1); return s; })();
  const code = convEncode(out, state);
  let agree = 0, tot = 0;
  for (let i = 0; i < soft.length; i++) { const w = Math.abs(soft[i]); tot += w; if ((soft[i] < 0 ? 1 : 0) === code[i]) agree += w; }
  return { bits: out, agreement: tot > 0 ? agree / tot : 0 };
}

// ── CRC, MSB-first shift register (MIL-STD-188-141B C.4.12) ───────────────
/** poly without the x^K term, e.g. x^8+x^7+x^4+x^3+x+1 -> 0x9B, K=8. */
export function crcBits(bits, poly, k) {
  let reg = 0; const top = 1 << (k - 1), mask = (1 << k) - 1;
  for (const b of bits) {
    const fb = ((reg & top) ? 1 : 0) ^ (b & 1);
    reg = (reg << 1) & mask;
    if (fb) reg ^= poly;
  }
  return reg;
}

export const bitsToInt = (bits, from, n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | (bits[from + i] & 1); return v >>> 0; };

/**
 * Streaming bit sink that turns a payload bit stream into readable output:
 * finds 8N1 / 7E1 asynchronous characters if they are there, else shows the
 * octets (LSB first) as hex. EOM (0x4B65A5B2, MSB first) is detected.
 */
export class PayloadSink {
  constructor(onText) {
    this.onText = onText;
    this.reset();
  }
  reset() {
    this._bits = [];
    this._delay = [];
    this._recent = []; this._since = 0;
    this._eomReg = 0;
    this._mode = '';        // '', 'async8', 'async7', 'sync'
    this._count = 0;
    this.eom = false;
  }
  push(bit) {
    if (this.eom) return;
    // 32 bits are held back, so the EOM pattern itself is never shown
    this._eomReg = ((this._eomReg << 1) | bit) >>> 0;
    if (!this._delay) this._delay = [];
    this._delay.push(bit);
    if (this._eomReg === 0x4B65A5B2 && this._count >= 32) {
      this.eom = true; this._delay = []; this._drain(true); this.onText({ eom: true }); return;
    }
    if (this._delay.length <= 32) { this._count++; return; }
    bit = this._delay.shift();
    this._bits.push(bit);
    // in hex mode, look again now and then: the first bits of a stream are
    // often a decoder's start-up or fill, not the payload
    if (this._mode === 'sync') {
      this._recent.push(bit);
      if (this._recent.length > 600) this._recent.shift();
      if (++this._since >= 400 && this._recent.length >= 600) {
        this._since = 0;
        const s8 = this._bestPhase(this._recent, false);
        let zeros = 0; for (const x of this._recent) if (!x) zeros++;
        if (zeros > 60 && s8.score > 0.85) {
          this._mode = this._bestPhase(this._recent, true).score > 0.95 ? 'async7' : 'async8';
          this._bits = this._recent.slice(s8.phase); this._recent = []; this._bad = [];
          this.onText({ format: this._mode === 'async7' ? 'async 7E1 text' : 'async 8N1 text' });
        }
      }
    }
    this._count++;
    if (!this._mode && this._bits.length >= 400) this._choose();
    if (this._mode) this._drain(false);
  }
  /** Bit phase (0..9) at which the most 10-bit frames look like 8N1/7E1. */
  _bestPhase(b, par) {
    let best = 0, bp = 0;
    for (let ph = 0; ph < 10; ph++) {
      let good = 0, frames = 0;
      for (let i = ph; i + 10 <= b.length; i += 10) {
        frames++;
        if (b[i] !== 0 || b[i + 9] !== 1) continue;
        if (par) { let s = 0; for (let k = 1; k <= 8; k++) s += b[i + k]; if (s % 2) continue; }
        good++;
      }
      const f = frames ? good / frames : 0;
      if (f > best) { best = f; bp = ph; }
    }
    return { score: best, phase: bp };
  }
  _choose() {
    const b = this._bits;
    const s8 = this._bestPhase(b, false), s7 = this._bestPhase(b, true);
    // idle lines (all ones) look like frames too: needs real start bits
    let zeros = 0; for (const x of b) if (!x) zeros++;
    if (zeros > b.length * 0.1 && s8.score > 0.85) {
      this._mode = s7.score > 0.95 ? 'async7' : 'async8';
      // back-to-back characters leave no idle gap for a start-bit hunt to
      // fall into step: start at the phase where the frames line up
      b.splice(0, s8.phase);
    } else this._mode = 'sync';
    this._bad = [];
    this.onText({ format: this._mode === 'sync' ? 'synchronous / binary (hex)' : this._mode === 'async7' ? 'async 7E1 text' : 'async 8N1 text' });
  }
  _drain(final) {
    const b = this._bits;
    if (this._mode === 'sync') {
      while (b.length >= 8) {
        let v = 0; for (let k = 0; k < 8; k++) v |= b[k] << k;
        b.splice(0, 8);
        this.onText({ hex: v });
      }
      return;
    }
    // async: hunt start bit; re-phase after repeated framing errors
    while (b.length >= 10) {
      if (this._rephase) {
        if (b.length < 200 && !final) return;
        const { phase } = this._bestPhase(b.slice(0, 200), false);
        b.splice(0, phase);
        this._rephase = false; this._bad = [];
        continue;
      }
      if (b[0] === 1) { b.shift(); continue; }
      let v = 0; for (let k = 0; k < 8; k++) v |= b[1 + k] << k;
      const ok = b[9] === 1;
      b.splice(0, 10);
      this._bad.push(ok ? 0 : 1);
      if (this._bad.length > 8) this._bad.shift();
      if (this._bad.reduce((x, y) => x + y, 0) >= 3) { this._rephase = true; continue; }
      if (this._mode === 'async7') v &= 0x7f;
      this.onText({ ch: v, ok });
    }
  }
}

/** Printable text for a byte, or a dot. */
export function printable(v) {
  if (v === 10) return '\n';
  if (v === 13) return '';
  if (v === 9) return ' ';
  if (v >= 32 && v < 127) return String.fromCharCode(v);
  return '·';
}
