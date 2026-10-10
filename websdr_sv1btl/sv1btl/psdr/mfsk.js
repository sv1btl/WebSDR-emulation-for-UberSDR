// mfsk.js — MFSK16 / MFSK32 / MFSK64 decoder (receive only)
//
// A port of the IZ8BLY MFSK receiver as carried in fldigi
// (src/mfsk/mfsk.cxx, interleave.cxx, mfskvaricode.cxx, filters/viterbi.cxx,
// filters/sfft.cxx). Reference copies live in ~/sdr-shots/scripts/reference/mfsk.
//
// How MFSK16/32/64 works
//   16 tones, one at a time, spaced exactly one baud apart (15.625, 31.25 or
//   62.5 Hz), so each tone is 4 bits. The text is IZ8BLY varicode, protected
//   by the NASA K=7 rate-1/2 convolutional code (polys 0x6d / 0x4f), and the
//   coded bits are spread over 10 x 4 x 4 positions by a diagonal interleaver
//   before being Gray-mapped onto the tones. The three modes differ only in
//   baud rate; the sub-mode must match the transmission.
//
//   The receiver follows fldigi step for step: mix the lowest tone to bin
//   `basetone` of a sliding DFT one symbol long, pick a symbol every symlen
//   samples, form soft bits from all 16 bin magnitudes, de-interleave, Viterbi
//   decode, and split the varicode on "001". Symbol timing is pulled in from
//   the peak of the previous tone's bin; AFC from the phase rotation of a tone
//   held across two symbols. Like fldigi, it never "locks" — it decodes all the
//   time and the Viterbi metric is the quality figure the squelch acts on.
//
// Not carried over: the MFSK picture mode (the header is printed, the image
// itself is not decoded) and the PSKmail S/N report.
//
// Interface mirrors olivia.js:
//   new MfskDecoder({sampleRate, centerHz, mode, squelch,
//                    onChar, onStatus, onMetrics});
//   .feed(Float32Array pcm)   .setSquelch(v)   .reset()

const INTERNAL_RATE = 8000;       // fldigi runs every MFSK mode at 8 kHz
const NUM_TONES = 16;
const SYMBITS = 4;
const K = 7;                      // NASA_K
const POLY1 = 0x6d;
const POLY2 = 0x4f;
const PATHMEM = 256;
const TRACEBACK = 45;             // tracepair.trace
const PUNCTURE = 128;
const SFFT_K1 = 0.99999;          // sliding-DFT damping, as fldigi's sfft
const BPF_TAPS = 127;
const CWI_MAXCOUNT = 6;

/**
 * The three sub-modes. symlen / basetone are fldigi's numbers at 8 kHz; the
 * lowest tone always lands on bin `basetone`, i.e. a nominal 1000 Hz.
 */
export const MFSK_MODES = [
  { key: 'mfsk16', label: 'MFSK16', symlen: 512, basetone: 64, depth: 10 },
  { key: 'mfsk32', label: 'MFSK32', symlen: 256, basetone: 32, depth: 10 },
  { key: 'mfsk64', label: 'MFSK64', symlen: 128, basetone: 16, depth: 10 },
];

/** Occupied bandwidth (first to last tone) of a sub-mode, in Hz. */
export function mfskBandwidth(key) {
  const m = MFSK_MODES.find((x) => x.key === key) || MFSK_MODES[0];
  return (NUM_TONES - 1) * INTERNAL_RATE / m.symlen;
}

// Squelch on fldigi's 0..100 metric. Measured on synthetic signals: noise
// alone peaks at ~19.5 (median 12-13), and copy that reads cleanly scores 23+
// (MFSK16 from -12 dB SNR in 2.5 kHz, MFSK32 from -10, MFSK64 from -8).
export const MFSK_SQUELCH_DEFAULT = 22;

// fldigi's metric averages over 50 bits, so after a transmission ends it takes
// ~100 bits (3 s of MFSK16) to sink below the squelch, and noise prints until
// then. Every fldigi transmission is framed CR STX CR ... CR EOT CR, so after
// an EOT the output is muted until the next STX, or until the squelch has
// closed and opened again (a sender that does not frame). A faster metric for
// the gate was tried and measured: it halved that tail but cost 2 dB of weak-
// signal copy.

// ── IZ8BLY varicode (mfskvaricode.cxx) ──────────────────────────────────────
// Each code includes its trailing "00"; the receiver recognises the end of a
// character by "001" (the two zeros plus the next character's leading 1).

export const MFSK_VARICODE = [
  '11101011100', '11101100000', '11101101000', '11101101100', '11101110000', '11101110100', '11101111000', '11101111100',
  '10101000', '11110000000', '11110100000', '11110101000', '11110101100', '10101100', '11110110000', '11110110100',
  '11110111000', '11110111100', '11111000000', '11111010000', '11111010100', '11111011000', '11111011100', '11111100000',
  '11111101000', '11111101100', '11111110000', '11111110100', '11111111000', '11111111100', '100000000000', '101000000000',
  '100', '111000000', '111111100', '1011011000', '1010101000', '1010100000', '1000000000', '110111100',
  '111110100', '111110000', '1010110100', '111100000', '10100000', '111011000', '111010100', '111101000',
  '11100000', '11110000', '101000000', '101010100', '101110100', '101100000', '101101100', '110100000',
  '110000000', '110101100', '111101100', '111111000', '1011000000', '111011100', '1010111100', '111010000',
  '1010000000', '10111100', '100000000', '11010100', '11011100', '10111000', '11111000', '101010000',
  '101011000', '11000000', '110110100', '101111100', '11110100', '11101000', '11111100', '11010000',
  '11101100', '110110000', '11011000', '10110100', '10110000', '101011100', '110101000', '101101000',
  '101110000', '101111000', '110111000', '1011101000', '1011010000', '1011101100', '1011010100', '1010110000',
  '1010101100', '10100', '1100000', '111000', '110100', '1000', '1010000', '1011000',
  '110000', '11000', '10000000', '1110000', '101100', '1000000', '11100', '10000',
  '1010100', '1111000', '100000', '101000', '1100', '111100', '1101100', '1101000',
  '1110100', '1011100', '1111100', '1011011100', '1010111000', '1011100000', '1011110000', '101010000000',
  '101010100000', '101010101000', '101010101100', '101010110000', '101010110100', '101010111000', '101010111100', '101011000000',
  '101011010000', '101011010100', '101011011000', '101011011100', '101011100000', '101011101000', '101011101100', '101011110000',
  '101011110100', '101011111000', '101011111100', '101100000000', '101101000000', '101101010000', '101101010100', '101101011000',
  '101101011100', '101101100000', '101101101000', '101101101100', '101101110000', '101101110100', '101101111000', '101101111100',
  '1011110100', '1011111000', '1011111100', '1100000000', '1101000000', '1101010000', '1101010100', '1101011000',
  '1101011100', '1101100000', '1101101000', '1101101100', '1101110000', '1101110100', '1101111000', '1101111100',
  '1110000000', '1110100000', '1110101000', '1110101100', '1110110000', '1110110100', '1110111000', '1110111100',
  '1111000000', '1111010000', '1111010100', '1111011000', '1111011100', '1111100000', '1111101000', '1111101100',
  '1111110000', '1111110100', '1111111000', '1111111100', '10000000000', '10100000000', '10101000000', '10101010000',
  '10101010100', '10101011000', '10101011100', '10101100000', '10101101000', '10101101100', '10101110000', '10101110100',
  '10101111000', '10101111100', '10110000000', '10110100000', '10110101000', '10110101100', '10110110000', '10110110100',
  '10110111000', '10110111100', '10111000000', '10111010000', '10111010100', '10111011000', '10111011100', '10111100000',
  '10111101000', '10111101100', '10111110000', '10111110100', '10111111000', '10111111100', '11000000000', '11010000000',
  '11010100000', '11010101000', '11010101100', '11010110000', '11010110100', '11010111000', '11010111100', '11011000000',
  '11011010000', '11011010100', '11011011000', '11011011100', '11011100000', '11011101000', '11011101100', '11011110000',
  '11011110100', '11011111000', '11011111100', '11100000000', '11101000000', '11101010000', '11101010100', '11101011000',
];

// varidecode[]: the same codes as numbers, for lookup.
const VARIDECODE = new Map(MFSK_VARICODE.map((c, i) => [parseInt(c, 2), i]));

// ── Small helpers (misc.h / misc.cxx) ───────────────────────────────────────

// fldigi's names, which are SWAPPED relative to the textbook Gray code (see
// the commented-out signatures in misc.cxx): its "grayencode" is the prefix
// XOR and its "graydecode" is x ^ (x >> 1). This is what is on the air — the
// textbook pair round-trips against itself but prints garbage from real
// fldigi signals at a perfect metric, verified on recordings of all three modes.
export function grayEncode(x) {
  let bits = x;
  for (let s = 1; s < 8; s++) bits ^= x >> s;
  return bits & 0xff;
}

export function grayDecode(x) { return x ^ (x >> 1); }

function parity(x) {
  let p = 0;
  while (x) { p ^= x & 1; x >>>= 1; }
  return p;
}

function decayavg(average, input, weight) {
  if (weight <= 1) return input;
  return (input - average) / weight + average;
}

// output[] of fldigi's encoder/viterbi: bit 0 = POLY1 parity, bit 1 = POLY2.
export const CONV_OUTPUT = (() => {
  const t = new Uint8Array(1 << K);
  for (let i = 0; i < t.length; i++) t[i] = parity(POLY1 & i) | (parity(POLY2 & i) << 1);
  return t;
})();

// ── Interleaver (interleave.cxx) ────────────────────────────────────────────

export class Interleaver {
  constructor(size, depth, forward) {
    this.size = size;
    this.depth = depth;
    this.forward = !!forward;
    this.table = new Uint8Array(size * size * depth);
    // RX starts full of punctures, TX full of zeros.
    this.table.fill(this.forward ? 0 : PUNCTURE);
  }

  /** In place on an array of `size` soft (or hard 0/1) symbols. */
  symbols(psyms) {
    const n = this.size, t = this.table;
    for (let k = 0; k < this.depth; k++) {
      const base = n * n * k;
      for (let i = 0; i < n; i++) {
        const row = base + n * i;
        for (let j = 0; j < n - 1; j++) t[row + j] = t[row + j + 1];
        t[row + n - 1] = psyms[i];
      }
      for (let i = 0; i < n; i++) {
        psyms[i] = this.forward ? t[base + n * i + (n - i - 1)] : t[base + n * i + i];
      }
    }
  }
}

// ── Viterbi decoder (viterbi.cxx, chunksize 1) ──────────────────────────────

class Viterbi {
  constructor() {
    this.nstates = 1 << (K - 1);
    this.metrics = Array.from({ length: PATHMEM }, () => new Float64Array(this.nstates));
    this.history = Array.from({ length: PATHMEM }, () => new Uint8Array(this.nstates));
    this.sequence = new Uint8Array(PATHMEM);
    this.ptr = 0;
    this.met = new Float64Array(4);
  }

  /** sym = [first, second] soft symbols 0..255; returns a bit or -1. */
  decode(s0, s1, out) {
    const cur = this.ptr;
    const prev = (cur + PATHMEM - 1) % PATHMEM;
    const m0 = 128 - s0, m1 = s0 - 128;        // mettab[0|1][sym[0]]
    const n0 = 128 - s1, n1 = s1 - 128;        // mettab[0|1][sym[1]]
    const met = this.met;
    met[0] = n0 + m0; met[1] = n0 + m1; met[2] = n1 + m0; met[3] = n1 + m1;

    const pm = this.metrics[prev], cm = this.metrics[cur], ch = this.history[cur];
    const ns = this.nstates;
    for (let n = 0; n < ns; n++) {
      const s0i = n, s1i = n + ns;
      const p0 = s0i >> 1, p1 = s1i >> 1;
      const a = pm[p0] + met[CONV_OUTPUT[s0i]];
      const b = pm[p1] + met[CONV_OUTPUT[s1i]];
      if (a > b) { cm[n] = a; ch[n] = p0; } else { cm[n] = b; ch[n] = p1; }
    }

    this.ptr = (this.ptr + 1) % PATHMEM;

    // Keep the path metrics bounded (fldigi does the same at INT_MAX/2).
    if (cm[0] > 1e12 || cm[0] < -1e12) {
      const off = cm[0];
      for (let i = 0; i < PATHMEM; i++) {
        const row = this.metrics[i];
        for (let j = 0; j < ns; j++) row[j] -= off;
      }
    }

    return this._traceback(out);
  }

  _traceback(out) {
    let p = (this.ptr + PATHMEM - 1) % PATHMEM;
    const ms = this.metrics[p];
    let best = -Infinity, bestState = 0;
    for (let i = 0; i < this.nstates; i++) {
      if (ms[i] > best) { best = ms[i]; bestState = i; }
    }
    const seq = this.sequence;
    seq[p] = bestState;
    for (let i = 0; i < TRACEBACK; i++) {
      const pr = (p + PATHMEM - 1) % PATHMEM;
      seq[pr] = this.history[p][seq[p]];
      p = pr;
    }
    const before = this.metrics[p][seq[p]];
    // low bit of state is the previous input bit
    const c = seq[p] & 1;
    const pn = (p + 1) % PATHMEM;
    out.metric = this.metrics[pn][seq[pn]] - before;
    return c;
  }
}

// ── Decoder ─────────────────────────────────────────────────────────────────

function _clampSquelch(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return MFSK_SQUELCH_DEFAULT;
  return Math.max(0, Math.min(100, n));
}

export class MfskDecoder {

  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate
      : (() => Number(options.sampleRate) || 12000);

    this._centerHz = Number(options.centerHz) || 1500;
    this._modeKey = MFSK_MODES.some((m) => m.key === options.mode) ? options.mode : MFSK_MODES[0].key;
    this._squelch = _clampSquelch(options.squelch);

    this.onChar    = typeof options.onChar    === 'function' ? options.onChar    : null;
    this.onStatus  = typeof options.onStatus  === 'function' ? options.onStatus  : null;
    this.onMetrics = typeof options.onMetrics === 'function' ? options.onMetrics : null;

    this._preset();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Squelch on the 0..100 metric; live, no reset. 0 = always print. */
  setSquelch(v) { this._squelch = _clampSquelch(v); }

  reset() { this._preset(); }

  /** Raw audio in, at the rate reported by the sampleRate function. */
  feed(pcm) {
    if (!pcm || !pcm.length) return;

    const sr = this._sampleRateFn() || 12000;
    if (sr !== this._inputRate) {
      this._inputRate = sr;
      this._resampleStep = INTERNAL_RATE / sr;
    }

    // Resample to 8 kHz by linear interpolation, as olivia.js does: the IF
    // filter has already band-limited the signal to the tone block.
    for (let n = 0; n < pcm.length; n++) {
      const x = pcm[n];
      this._resPhase += this._resampleStep;
      while (this._resPhase >= 1) {
        this._resPhase -= 1;
        const u = 1 - this._resPhase;
        this._pushSample(this._resPrev + (x - this._resPrev) * u);
      }
      this._resPrev = x;
    }

    this._maybeEmitMetrics();
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  _preset() {
    const m = MFSK_MODES.find((x) => x.key === this._modeKey) || MFSK_MODES[0];
    this._mode = m;
    this._symlen = m.symlen;
    this._basetone = m.basetone;
    this._tonespacing = INTERNAL_RATE / m.symlen;
    this._bandwidth = (NUM_TONES - 1) * this._tonespacing;
    this._freqErr = 0;                  // AFC, Hz, applied on top of _centerHz

    // Mixer + complex band-pass. fldigi makes the signal analytic with a
    // Hilbert FIR first; a complex band-pass after the mixer does the same job
    // (it passes the shifted tone block and rejects its mirror image).
    const basefreq = this._tonespacing * this._basetone;
    const fc = basefreq + this._bandwidth / 2;
    const half = this._bandwidth / 2 + 2 * this._tonespacing;
    const M = (BPF_TAPS - 1) / 2;
    this._bpfRe = new Float64Array(BPF_TAPS);
    this._bpfIm = new Float64Array(BPF_TAPS);
    for (let i = 0; i < BPF_TAPS; i++) {
      const t = i - M;
      const x = 2 * half / INTERNAL_RATE;
      const sinc = t === 0 ? x : Math.sin(Math.PI * x * t) / (Math.PI * t);
      const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (BPF_TAPS - 1));
      const ph = 2 * Math.PI * fc * t / INTERNAL_RATE;
      this._bpfRe[i] = sinc * w * Math.cos(ph);
      this._bpfIm[i] = sinc * w * Math.sin(ph);
    }
    this._bpfBufRe = new Float64Array(BPF_TAPS * 2);
    this._bpfBufIm = new Float64Array(BPF_TAPS * 2);
    this._bpfPos = 0;
    this._phaseAcc = 0;

    // Sliding DFT over bins basetone .. basetone+15 (sfft.cxx).
    const N = this._symlen;
    this._vrotRe = new Float64Array(NUM_TONES);
    this._vrotIm = new Float64Array(NUM_TONES);
    for (let k = 0; k < NUM_TONES; k++) {
      const phi = 2 * Math.PI * (this._basetone + k) / N;
      this._vrotRe[k] = SFFT_K1 * Math.cos(phi);
      this._vrotIm[k] = SFFT_K1 * Math.sin(phi);
    }
    this._k2 = Math.pow(SFFT_K1, N);
    this._delayRe = new Float64Array(N);
    this._delayIm = new Float64Array(N);
    this._delayPtr = 0;
    this._binRe = new Float64Array(NUM_TONES);
    this._binIm = new Float64Array(NUM_TONES);

    // The "pipe": the last 2*symlen bin vectors, for symbol sync and AFC.
    this._pipeLen = 2 * N;
    this._pipeRe = new Float64Array(this._pipeLen * NUM_TONES);
    this._pipeIm = new Float64Array(this._pipeLen * NUM_TONES);
    this._pipePtr = 0;

    // FEC chain.
    this._rxinlv = new Interleaver(SYMBITS, m.depth, false);
    this._dec = new Viterbi();
    this._vout = { metric: 0 };
    this._symbolPair = [0, 0];
    this._symCounter = 0;
    this._met2 = 0;
    this._afterEot = false;
    this._metric = 0;
    this._datashreg = 1;
    this._lastChar = 0;

    // Symbol sync / AFC state (rx_init).
    this._syncCounter = 0;
    this._syncHist = new Float64Array(8);   // Cmovavg(8)
    this._syncHistPos = 0;
    this._syncHistFull = false;
    this._syncHistSum = 0;
    this._currSymbol = 0;
    this._prev1Symbol = 0;
    this._prev2Symbol = 0;
    this._staticBurst = false;
    this._afcMetric = 0;
    this._s2n = 0;
    this._cwiCounter = new Int32Array(NUM_TONES);
    this._soft = new Uint8Array(SYMBITS);
    this._b = new Float64Array(SYMBITS);
    this._mag = new Float64Array(NUM_TONES);

    this._resPhase = 0;
    this._resPrev = 0;
    this._inputRate = 0;
    this._lastMetricsAt = 0;
    this._statusText = '';
  }

  // ── Per-sample chain (rx_process) ─────────────────────────────────────────

  _pushSample(x) {
    // mixer(): shift so the lowest tone sits on bin `basetone`.
    const f = (this._centerHz + this._freqErr) - this._tonespacing * this._basetone - this._bandwidth / 2;
    const c = Math.cos(this._phaseAcc), s = Math.sin(this._phaseAcc);
    let zr = x * c, zi = x * s;
    this._phaseAcc -= 2 * Math.PI * f / INTERNAL_RATE;
    if (this._phaseAcc < 0) this._phaseAcc += 2 * Math.PI;
    if (this._phaseAcc >= 2 * Math.PI) this._phaseAcc -= 2 * Math.PI;

    // Complex band-pass (doubled ring buffer, so the taps read contiguously).
    const p = this._bpfPos;
    this._bpfBufRe[p] = this._bpfBufRe[p + BPF_TAPS] = zr;
    this._bpfBufIm[p] = this._bpfBufIm[p + BPF_TAPS] = zi;
    this._bpfPos = (p + 1) % BPF_TAPS;
    let yr = 0, yi = 0;
    const hr = this._bpfRe, hi = this._bpfIm, br = this._bpfBufRe, bi = this._bpfBufIm;
    // Newest sample is at p; tap i multiplies sample p - i.
    for (let i = 0; i < BPF_TAPS; i++) {
      const j = p + BPF_TAPS - i;
      const ar = br[j], ai = bi[j];
      yr += ar * hr[i] - ai * hi[i];
      yi += ar * hi[i] + ai * hr[i];
    }
    zr = yr; zi = yi;

    // Sliding DFT.
    const d = this._delayPtr;
    const ur = zr - this._k2 * this._delayRe[d];
    const ui = zi - this._k2 * this._delayIm[d];
    this._delayRe[d] = zr; this._delayIm[d] = zi;
    this._delayPtr = d + 1 >= this._symlen ? 0 : d + 1;

    const base = this._pipePtr * NUM_TONES;
    const vr = this._vrotRe, vi = this._vrotIm, Br = this._binRe, Bi = this._binIm;
    for (let k = 0; k < NUM_TONES; k++) {
      const ar = Br[k] + ur, ai = Bi[k] + ui;
      const nr = ar * vr[k] - ai * vi[k];
      const ni = ar * vi[k] + ai * vr[k];
      Br[k] = nr; Bi[k] = ni;
      this._pipeRe[base + k] = nr;
      this._pipeIm[base + k] = ni;
    }

    if (--this._syncCounter <= 0) {
      this._syncCounter = this._symlen;
      this._symbolDecision(base);
    }
    this._pipePtr = (this._pipePtr + 1) % this._pipeLen;
  }

  _symbolDecision(base) {
    const mag = this._mag;
    for (let k = 0; k < NUM_TONES; k++) {
      const r = this._pipeRe[base + k], i = this._pipeIm[base + k];
      mag[k] = Math.sqrt(r * r + i * i);
    }
    this._currSymbol = this._hardDecode(mag);
    this._softDecode(mag);
    this._synchronize();
    this._afc(base);
    this._evalS2n(base);
    this._prev2Symbol = this._prev1Symbol;
    this._prev1Symbol = this._currSymbol;
  }

  // harddecode(): strongest tone; flags a static burst that lifts every bin.
  _hardDecode(mag) {
    let avg = 0;
    for (let i = 0; i < NUM_TONES; i++) avg += mag[i];
    avg /= NUM_TONES;
    if (avg < 1e-20) avg = 1e-20;
    let max = 0, symbol = 0, burst = 0;
    for (let i = 0; i < NUM_TONES; i++) {
      const x = mag[i];
      if (x > max) { max = x; symbol = i; }
      if (x > 2 * avg) burst++;
    }
    this._staticBurst = burst === NUM_TONES;
    this._afcMetric = this._staticBurst ? 0 : 0.95 * this._afcMetric + 0.05 * (2 * max / avg);
    return symbol;
  }

  // softdecode(), including fldigi's dynamic CW-interference avoidance.
  _softDecode(mag) {
    const cwi = this._cwiCounter;
    const b = this._b;
    b.fill(0);

    let sum = 0;
    for (let i = 0; i < NUM_TONES; i++) if (cwi[i] < CWI_MAXCOUNT) sum += mag[i];
    const avg = sum / NUM_TONES;
    if (sum < 1e-10) sum = 1e-10;

    const cwiSymbol = this._currSymbol;
    for (let k = 1; k < NUM_TONES; k++) {
      if (k === cwiSymbol) cwi[k]++; else cwi[k]--;
      if (cwi[k] < 0) cwi[k] = 0;
      if (cwi[k] > CWI_MAXCOUNT) cwi[k] = CWI_MAXCOUNT + 1;
    }

    for (let i = 0; i < NUM_TONES; i++) {
      const j = grayDecode(i);
      let binmag;
      if (cwi[i] > CWI_MAXCOUNT) binmag = avg;         // a steady carrier: puncture
      else if (cwiSymbol === i)  binmag = 2 * mag[i];  // give harddecode a vote
      else                       binmag = mag[i];
      for (let k = 0; k < SYMBITS; k++) {
        b[k] += (j & (1 << (SYMBITS - k - 1))) ? binmag : -binmag;
      }
    }

    const soft = this._soft;
    for (let i = 0; i < SYMBITS; i++) {
      soft[i] = this._staticBurst
        ? PUNCTURE
        : Math.max(0, Math.min(255, Math.trunc(128 + (b[i] / sum) * 256)));
    }

    this._rxinlv.symbols(soft);
    for (let i = 0; i < SYMBITS; i++) this._decodeSymbol(soft[i]);
  }

  // decodesymbol(): 4 bits per tone is even, so one decoder on every 2nd bit.
  _decodeSymbol(symbol) {
    this._symbolPair[0] = this._symbolPair[1];
    this._symbolPair[1] = symbol;
    this._symCounter = this._symCounter ? 0 : 1;
    if (this._symCounter) return;

    const c = this._dec.decode(this._symbolPair[0], this._symbolPair[1], this._vout);
    if (c < 0) return;
    this._met2 = decayavg(this._met2, this._vout.metric, 50);
    this._metric = Math.max(0, Math.min(100, (this._met2 - 60) * 0.5));

    if (this._metric < this._squelch) {
      this._afterEot = false;          // squelch closed: the next signal is new
      return;
    }
    this._recvBit(c);
  }

  _recvBit(bit) {
    this._datashreg = ((this._datashreg << 1) | (bit ? 1 : 0)) >>> 0;
    if ((this._datashreg & 7) === 1) {
      const code = this._datashreg >>> 1;
      const c = VARIDECODE.has(code) ? VARIDECODE.get(code) : -1;
      this._emit(c);
      this._datashreg = 1;
    } else if (this._datashreg > 0xfffff) {
      // Noise with no "001" in it; varicode is never longer than 12 bits.
      this._datashreg = 1;
    }
  }

  // synchronize(): the previous tone's bin peaks when the DFT window sat
  // squarely on it; steer the sample instant toward that peak.
  _synchronize() {
    if (this._currSymbol === this._prev1Symbol) return;
    if (this._prev1Symbol === this._prev2Symbol) return;

    const L = this._pipeLen, sym = this._prev1Symbol;
    let j = this._pipePtr, max = 0, syn = -1;
    for (let i = 0; i < L; i++) {
      const r = this._pipeRe[j * NUM_TONES + sym], im = this._pipeIm[j * NUM_TONES + sym];
      const v = r * r + im * im;
      if (v > max) { max = v; syn = i; }
      j = (j + 1) % L;
    }

    // Cmovavg(8): the first value fills the whole window.
    if (!this._syncHistFull) {
      this._syncHist.fill(syn);
      this._syncHistSum = 8 * syn;
      this._syncHistFull = true;
    } else {
      this._syncHistSum += syn - this._syncHist[this._syncHistPos];
      this._syncHist[this._syncHistPos] = syn;
      this._syncHistPos = (this._syncHistPos + 1) & 7;
    }
    const avg = this._syncHistSum / 8;

    this._syncCounter += Math.floor((avg - this._symlen) / NUM_TONES + 0.5);
  }

  // afc(): a tone held over two symbols rotates at its true frequency.
  _afc(base) {
    if (this._staticBurst) return;
    if (this._metric < this._squelch) return;
    if (this._afcMetric < 3.0) return;
    if (this._currSymbol !== this._prev1Symbol) return;

    const k = this._currSymbol;
    const prevBase = ((this._pipePtr + this._pipeLen - 1) % this._pipeLen) * NUM_TONES;
    const ar = this._pipeRe[prevBase + k], ai = -this._pipeIm[prevBase + k];
    const br = this._pipeRe[base + k], bi = this._pipeIm[base + k];
    const zr = ar * br - ai * bi, zi = ar * bi + ai * br;
    const f = Math.atan2(zi, zr) * INTERNAL_RATE / (2 * Math.PI);
    const f1 = this._tonespacing * (this._basetone + k);

    if (Math.abs(f1 - f) < this._tonespacing / 4) {
      const step = decayavg(0, f1 - f, 32);
      // fldigi moves the dial by the running error; bound the total pull to
      // two tone spacings so a burst of interference cannot walk it away.
      const lim = 2 * this._tonespacing;
      this._freqErr = Math.max(-lim, Math.min(lim, this._freqErr - step));
    }
  }

  _evalS2n(base) {
    const r = this._pipeRe[base + this._currSymbol], i = this._pipeIm[base + this._currSymbol];
    const nr = this._pipeRe[base + this._prev2Symbol], ni = this._pipeIm[base + this._prev2Symbol];
    const sig = Math.sqrt(r * r + i * i);
    const noise = (NUM_TONES - 1) * Math.sqrt(nr * nr + ni * ni);
    if (noise > 0) this._s2n = decayavg(this._s2n, sig / noise, 64);
  }

  _emit(code) {
    if (code < 0 || code === 0) return;
    if (code === 4) { this._afterEot = true; return; }     // EOT
    if (code === 2) { this._afterEot = false; return; }    // STX
    if (this._afterEot) return;
    if (!this.onChar) { this._lastChar = code; return; }
    if (code === 13) this.onChar('\n');
    else if (code === 10) { if (this._lastChar !== 13) this.onChar('\n'); }
    else if (code >= 32 && code <= 126) this.onChar(String.fromCharCode(code));
    else if (code >= 160) this.onChar(String.fromCharCode(code));   // Latin-1
    this._lastChar = code;
  }

  // ── Reporting ─────────────────────────────────────────────────────────────

  get snrDb() {
    if (!(this._s2n > 0)) return 0;
    return Math.max(-30, Math.min(40, 20 * Math.log10(this._s2n)));
  }

  get lockQuality() { return Math.round(this._metric); }

  _maybeEmitMetrics() {
    const now = Date.now();
    if (now - this._lastMetricsAt < 250) return;
    this._lastMetricsAt = now;

    const open = this._metric >= this._squelch && this._metric > 0;
    const centre = this._centerHz + this._freqErr;

    if (this.onStatus) {
      const text = open
        ? `${this._mode.label} @ ${centre.toFixed(1)} Hz`
        : 'Searching…';
      if (text !== this._statusText) {
        this._statusText = text;
        this.onStatus(text);
      }
    }

    if (this.onMetrics) {
      this.onMetrics({
        snrDb:        this.snrDb,
        lockQuality:  this.lockQuality,
        centerHz:     centre,
        timingLocked: open,
        squelchOpen:  open,
      });
    }
  }
}

export default MfskDecoder;
