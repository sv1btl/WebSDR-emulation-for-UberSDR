// fldigiFec.js — the soft-decision Viterbi decoder and helpers shared by the
// fldigi-family decoders (thor.js via ifk.js, and anything else that needs a
// constraint length other than mfsk.js's fixed K=7).
//
// A port of fldigi's src/filters/viterbi.cxx (chunksize 1): soft symbols are
// 0..255 with 128 = erasure, the metric table is the linear one fldigi builds
// (mettab[0][s] = 128 - s, mettab[1][s] = s - 128), and every call returns the
// bit decided `traceback` steps back plus the metric of that step.
//
// State convention, as fldigi: the encoder shifts each new bit in at the LSB of
// a K-bit register, a decoder state is the low K-1 bits, and the previous state
// of full register s is s >> 1.

export const PUNCTURE = 128;
const PATHMEM = 256;

function parity(x) {
  let p = 0;
  while (x) { p ^= x & 1; x >>>= 1; }
  return p;
}

/** output[s] for every K-bit register value: bit 0 = poly1 parity, bit 1 = poly2. */
export function convOutputTable(k, poly1, poly2) {
  const t = new Uint8Array(1 << k);
  for (let i = 0; i < t.length; i++) t[i] = parity(poly1 & i) | (parity(poly2 & i) << 1);
  return t;
}

/** Rate-1/2 convolutional encoder (fldigi encoder::encode). Test helper. */
export class ConvEncoder {
  constructor(k, poly1, poly2) {
    this.mask = (1 << k) - 1;
    this.out = convOutputTable(k, poly1, poly2);
    this.shreg = 0;
  }
  encode(bit) {
    this.shreg = ((this.shreg << 1) | (bit ? 1 : 0)) & this.mask;
    return this.out[this.shreg];
  }
}

export class Viterbi {
  constructor(k, poly1, poly2, traceback = 45) {
    if (traceback >= PATHMEM) throw new Error('traceback too long');
    this.k = k;
    this.nstates = 1 << (k - 1);
    this.output = convOutputTable(k, poly1, poly2);
    this.traceback = traceback;
    // Int32 metrics (renormalised below) and Uint16 history keep a K=15 code
    // at 24 MB instead of the 48 MB doubles would take.
    this.metrics = Array.from({ length: PATHMEM }, () => new Int32Array(this.nstates));
    this.history = Array.from({ length: PATHMEM }, () => new Uint16Array(this.nstates));
    this.sequence = new Uint16Array(PATHMEM);
    this.ptr = 0;
    this.met = new Int32Array(4);
  }

  reset() {
    for (let i = 0; i < PATHMEM; i++) { this.metrics[i].fill(0); this.history[i].fill(0); }
    this.ptr = 0;
  }

  /**
   * One pair of soft symbols (0..255). Returns the decided bit; `out.metric`
   * gets the path-metric increment of that step (fldigi's *metric).
   */
  decode(s0, s1, out) {
    const cur = this.ptr;
    const prev = (cur + PATHMEM - 1) % PATHMEM;
    const m0 = 128 - s0, m1 = s0 - 128;
    const n0 = 128 - s1, n1 = s1 - 128;
    const met = this.met;
    met[0] = n0 + m0; met[1] = n0 + m1; met[2] = n1 + m0; met[3] = n1 + m1;

    const pm = this.metrics[prev], cm = this.metrics[cur], ch = this.history[cur];
    const ns = this.nstates, outp = this.output;
    for (let n = 0; n < ns; n++) {
      const s1i = n + ns;
      const p0 = n >> 1, p1 = s1i >> 1;
      const a = pm[p0] + met[outp[n]];
      const b = pm[p1] + met[outp[s1i]];
      if (a > b) { cm[n] = a; ch[n] = p0; } else { cm[n] = b; ch[n] = p1; }
    }

    this.ptr = (cur + 1) % PATHMEM;

    // fldigi renormalises at INT_MAX/2; do the same well inside Int32.
    if (cm[0] > 1e9 || cm[0] < -1e9) {
      const off = cm[0];
      for (let i = 0; i < PATHMEM; i++) {
        const row = this.metrics[i];
        for (let j = 0; j < ns; j++) row[j] -= off;
      }
    }

    let p = cur;
    const ms = this.metrics[p];
    let best = -Infinity, bestState = 0;
    for (let i = 0; i < ns; i++) if (ms[i] > best) { best = ms[i]; bestState = i; }
    const seq = this.sequence;
    seq[p] = bestState;
    for (let i = 0; i < this.traceback; i++) {
      const pr = (p + PATHMEM - 1) % PATHMEM;
      seq[pr] = this.history[p][seq[p]];
      p = pr;
    }
    if (out) {
      const pn = (p + 1) % PATHMEM;
      out.metric = this.metrics[pn][seq[pn]] - this.metrics[p][seq[p]];
    }
    return seq[p] & 1;
  }
}

/** fldigi's decayavg(). */
export function decayavg(average, input, weight) {
  if (weight <= 1) return input;
  return (input - average) / weight + average;
}

/** fldigi's Cmovavg: moving average that starts pre-filled with its first input. */
export class MovAvg {
  constructor(len) { this.len = len; this.buf = new Float64Array(len); this.empty = true; }
  reset() { this.empty = true; }
  run(a) {
    if (this.empty) {
      this.empty = false;
      this.buf.fill(a); this.sum = a * this.len; this.p = 0;
      return a;
    }
    this.sum += a - this.buf[this.p];
    this.buf[this.p] = a;
    if (++this.p >= this.len) this.p = 0;
    return this.sum / this.len;
  }
}

/**
 * Complex band-pass FIR (Hamming-windowed sinc shifted to fc): turns a real
 * signal into the analytic signal of one band, the job fldigi's Hilbert FIR +
 * fftfilt pair does. Returns {re, im} tap arrays.
 */
export function complexBandpass(taps, fc, halfWidth, rate) {
  const M = (taps - 1) / 2;
  const re = new Float64Array(taps), im = new Float64Array(taps);
  const x = 2 * halfWidth / rate;
  for (let i = 0; i < taps; i++) {
    const t = i - M;
    const sinc = t === 0 ? x : Math.sin(Math.PI * x * t) / (Math.PI * t);
    const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1));
    const ph = 2 * Math.PI * fc * t / rate;
    re[i] = sinc * w * Math.cos(ph);
    im[i] = sinc * w * Math.sin(ph);
  }
  return { re, im };
}

/** Streaming linear-interpolation resampler, as olivia.js / mfsk.js use. */
export class LinearResampler {
  constructor(outRate) { this.outRate = outRate; this.inRate = 0; this.phase = 0; this.prev = 0; }
  /** Calls sink(x) for every output sample. */
  run(pcm, inRate, sink) {
    if (inRate !== this.inRate) { this.inRate = inRate; this.step = this.outRate / inRate; }
    const step = this.step;
    let ph = this.phase, prev = this.prev;
    for (let n = 0; n < pcm.length; n++) {
      const x = pcm[n];
      ph += step;
      while (ph >= 1) {
        ph -= 1;
        sink(prev + (x - prev) * (1 - ph / step));
      }
      prev = x;
    }
    this.phase = ph; this.prev = prev;
  }
}
