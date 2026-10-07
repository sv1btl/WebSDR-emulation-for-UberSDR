// psk31.js — BPSK31 demodulator (receive only)
// ============================================================================
// PSK31 is differential BPSK at 31.25 baud: a phase reversal carries a 0, no
// reversal carries a 1, and the bit stream is cut into characters by the
// varicode alphabet, whose codewords never contain "00" — so a "00" pair is
// itself the character delimiter and no framing/UART layer is needed.
//
// Pipeline
// --------
//   1. Complex baseband — an incremental rotator NCO (no Math.cos per sample,
//        renormalised every 1024 samples) mixes the carrier to DC; two cascaded
//        biquad low-passes per arm form the anti-alias filter.
//   2. Decimation to 8 samples/symbol (250 Hz) through a fractional phase
//        accumulator, so any input rate works, not just 12 kHz.
//   3. Matched filter — a Hann-weighted FIR two symbols long.
//   4. Symbol timing — BPSK31's raised-cosine envelope peaks mid-symbol and
//        dips at every reversal, so an 8-bin envelope histogram indexed by the
//        free-running sample counter has its maximum at the symbol centre. The
//        sampling phase slews one bin at a time towards that maximum, which
//        keeps it from chattering on noise.
//   5. Differential detection — d = z[k]·conj(z[k-1]); Re(d) >= 0 is a 1. No
//        absolute carrier recovery is needed, which is what makes DBPSK cheap
//        and robust; the residual frequency error shows up as a rotation of d
//        and drives the AFC back into the NCO.
//   6. Varicode decode — bits shift into a register; when the low two bits are
//        00 the register above them IS the codeword, read as a binary number.
//
// Interface mirrors cwDecoder.js / the other engines in this tree:
//   new PSK31Demodulator({sampleRate, centerHz, afc, onChar, onStatus, onMetrics});
//   .feed(Float32Array); .setCenter(hz); .setAfc(on); .setSampleRate(hz); .reset();
// ============================================================================

import { transformFlat } from './lib/fftRadix2.js';

const SYMBOL_RATE = 31.25;          // baud
const SPS         = 8;              // baseband samples per symbol
const BB_RATE     = SYMBOL_RATE * SPS;   // 250 Hz
const MF_TAPS     = 2 * SPS;        // matched filter length (two symbols)

// AFC pull-in range around the user's centre, and the loop gain per symbol.
// The differential detector on its own can only track +/-baud/4 (~7.8 Hz), so
// a coarse spectral acquisition covers the rest of this range first.
const AFC_LIMIT_HZ = 25;
const AFC_GAIN     = 0.02;

// Coarse acquisition FFT length over the 250 Hz baseband (~1 s, ~1 Hz bins).
const COARSE_N = 256;

// Characters are only emitted above this decision coherence, so an empty band
// stays silent instead of spraying varicode noise into the text pane.
const SQUELCH_LOCK = 45;

// SNR display: the 3 kHz reference the RTTY panel uses. SNR_RAW_TABLE maps the
// raw symbol-bandwidth figure to it where the two stop being a fixed offset;
// points are [raw dB, SNR in 3 kHz], measured through the ±100 Hz passband.
const SNR_FLOOR_DB  = -25;
const SNR_OFFSET_DB = 20.2;
const SNR_RAW_TABLE = [[-12.0, -25], [-5.8, -20], [1.1, -15], [8.4, -10], [15.0, -5]];

function _rawSnrTo3k(raw) {
  const t = SNR_RAW_TABLE;
  if (raw >= t[t.length - 1][0]) return Math.min(40, raw - SNR_OFFSET_DB);
  if (raw <= t[0][0]) return SNR_FLOOR_DB;
  for (let k = 1; k < t.length; k++) {
    if (raw <= t[k][0]) {
      const [x0, y0] = t[k - 1], [x1, y1] = t[k];
      return y0 + (y1 - y0) * (raw - x0) / (x1 - x0);
    }
  }
  return SNR_FLOOR_DB;
}

// ── PSK31 varicode ──────────────────────────────────────────────────────────
// Index = ASCII code, value = the codeword. Every codeword starts and ends with
// a 1 and contains no "00" — that invariant is what makes "00" a safe delimiter,
// and _assertVaricodeInvariants() below re-checks it at module load.
export const VARICODE = [
  '1010101011', '1011011011', '1011101101', '1101110111', // 0–3
  '1011101011', '1101011111', '1011101111', '1011111101', // 4–7
  '1011111111', '11101111',   '11101',      '1101101111', // 8–11
  '1011011101', '11111',      '1101110101', '1110101011', // 12–15
  '1011110111', '1011110101', '1110101101', '1110101111', // 16–19
  '1101011011', '1101101011', '1101101101', '1101010111', // 20–23
  '1101111011', '1101111101', '1110110111', '1101010101', // 24–27
  '1101011101', '1110111011', '1011111011', '1101111111', // 28–31
  '1',          '111111111',  '101011111',  '111110101',  // ' ' ! " #
  '111011011',  '1011010101', '1010111011', '101111111',  // $ % & '
  '11111011',   '11110111',   '101101111',  '111011111',  // ( ) * +
  '1110101',    '110101',     '1010111',    '110101111',  // , - . /
  '10110111',   '10111101',   '11101101',   '11111111',   // 0 1 2 3
  '101110111',  '101011011',  '101101011',  '110101101',  // 4 5 6 7
  '110101011',  '110110111',  '11110101',   '110111101',  // 8 9 : ;
  '111101101',  '1010101',    '111010111',  '1010101111', // < = > ?
  '1010111101', '1111101',    '11101011',   '10101101',   // @ A B C
  '10110101',   '1110111',    '11011011',   '11111101',   // D E F G
  '101010101',  '1111111',    '111111101',  '101111101',  // H I J K
  '11010111',   '10111011',   '11011101',   '10101011',   // L M N O
  '11010101',   '111011101',  '10101111',   '1101111',    // P Q R S
  '1101101',    '101010111',  '110110101',  '101011101',  // T U V W
  '101110101',  '101111011',  '1010101101', '111110111',  // X Y Z [
  '111101111',  '111111011',  '1010111111', '101101101',  // \ ] ^ _
  '1011011111', '1011',       '1011111',    '101111',     // ` a b c
  '101101',     '11',         '111101',     '1011011',    // d e f g
  '101011',     '1101',       '111101011',  '10111111',   // h i j k
  '11011',      '111011',     '1111',       '111',        // l m n o
  '111111',     '110111111',  '10101',      '10111',      // p q r s
  '101',        '110111',     '1111011',    '1101011',    // t u v w
  '11011111',   '1011101',    '111010101',  '1010110111', // x y z {
  '110111011',  '1010110101', '1011010111', '1110110101', // | } ~ DEL
];

// Codeword-as-binary-number → ASCII code. The receiver shifts bits into an
// integer that is cleared after every delimiter, so the accumulated value is
// exactly the codeword read as binary — no string handling on the hot path.
const VARICODE_DECODE = (() => {
  const m = new Map();
  for (let c = 0; c < VARICODE.length; c++) {
    m.set(parseInt(VARICODE[c], 2), c);
  }
  return m;
})();

// Cheap self-check: a typo in the table above would show up as garbled text on
// air and nowhere else, so fail loudly at load time instead.
(function _assertVaricodeInvariants() {
  const seen = new Set();
  for (let c = 0; c < VARICODE.length; c++) {
    const code = VARICODE[c];
    if (!/^1[01]*1$|^1$/.test(code) || code.includes('00')) {
      console.error('[PSK31] bad varicode entry', c, code);
    }
    if (seen.has(code)) console.error('[PSK31] duplicate varicode entry', c, code);
    seen.add(code);
  }
  if (VARICODE.length !== 128) console.error('[PSK31] varicode table is not 128 entries');
})();

export class PSK31Demodulator {

  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate
      : (() => Number(options.sampleRate) || 12000);

    this._baseCenter = Number(options.centerHz) || 1000;
    this._afcOn      = options.afc !== false;

    this.onChar    = typeof options.onChar    === 'function' ? options.onChar    : null;
    this.onStatus  = typeof options.onStatus  === 'function' ? options.onStatus  : null;
    this.onMetrics = typeof options.onMetrics === 'function' ? options.onMetrics : null;

    this._buildMatchedFilter();
    this.reset();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setCenter(hz) {
    const f = Number(hz);
    if (!Number.isFinite(f) || f <= 0) return;
    this._baseCenter = f;
    this._afcHz = 0;
    this._configure();
  }

  setAfc(on) {
    this._afcOn = !!on;
    if (!this._afcOn) { this._afcHz = 0; this._configure(); }
  }

  setSampleRate(hz) {
    const f = Number(hz);
    if (Number.isFinite(f) && f > 0) this._sampleRateFn = () => f;
    this._configure();
  }

  reset() {
    // NCO
    this._afcHz  = 0;
    this._oscC   = 1; this._oscS = 0;
    this._oscN   = 0;

    // Anti-alias low-pass state (two cascaded biquads per arm)
    this._lpI = [_biquadCreate(), _biquadCreate()];
    this._lpQ = [_biquadCreate(), _biquadCreate()];

    // Decimation
    this._decPhase = 0;

    // Matched filter delay lines
    this._mfI = new Float32Array(MF_TAPS);
    this._mfQ = new Float32Array(MF_TAPS);
    this._mfPos = 0;

    // Symbol timing
    this._envBins   = new Float32Array(SPS);
    this._sampleCnt = 0;
    this._symPhase  = 0;
    this._timingLocked = false;

    // Differential detection
    this._prevI = 0; this._prevQ = 0;
    this._havePrev = false;

    // Varicode shift register
    this._shreg = 0;

    // Coarse acquisition ring over the complex baseband
    this._acqRe  = new Float64Array(COARSE_N);
    this._acqIm  = new Float64Array(COARSE_N);
    this._acqPos = 0;
    this._acqFilled = 0;
    this._lastAcqAt = 0;
    this._charsSinceAcq = 0;

    // Quality tracking
    this._coherence = 0;
    this._sigPow    = 0;   // mean Re(d)^2 — signal after differential detection
    this._noisePow  = 0;   // mean Im(d)^2 — noise on the quadrature axis

    // IMD measurement — Goertzel accumulators over the input audio
    this._imdWin   = 0;
    this._imdDb    = 0;
    this._imdProbes = null;

    this._lastMetricsAt = 0;
    this._statusText    = '';

    this._configure();
  }

  /** Raw audio in, at the rate reported by the sampleRate function. */
  feed(pcm) {
    if (!pcm || !pcm.length) return;

    const sr = this._sampleRateFn() || 12000;
    if (sr !== this._sr) this._configure();

    const decStep = BB_RATE / this._sr;

    for (let n = 0; n < pcm.length; n++) {
      const x = pcm[n];

      // 1. Complex downconversion by the incremental rotator.
      const c = this._oscC, s = this._oscS;
      let i = x * c;
      let q = -x * s;
      this._oscC = c * this._stepC - s * this._stepS;
      this._oscS = s * this._stepC + c * this._stepS;
      if (++this._oscN >= 1024) {
        // Renormalise: the rotation is exact in theory, drifty in floating point.
        const m = Math.sqrt(this._oscC * this._oscC + this._oscS * this._oscS) || 1;
        this._oscC /= m; this._oscS /= m;
        this._oscN = 0;
      }

      // 2. Anti-alias low-pass, then fractional decimation to 250 Hz.
      i = _biquadStep(this._lpI[1], _biquadStep(this._lpI[0], i));
      q = _biquadStep(this._lpQ[1], _biquadStep(this._lpQ[0], q));

      this._imdFeed(x);

      this._decPhase += decStep;
      if (this._decPhase >= 1) {
        this._decPhase -= 1;
        this._basebandSample(i, q);
      }
    }

    // Re-acquire while nothing is actually being decoded. Decision coherence is
    // NOT a usable trigger here: an offset near half the baud rate rotates the
    // constellation ~180 degrees per symbol, which looks perfectly coherent
    // while producing pure garbage. Characters coming out is the honest signal.
    //
    // The interval is counted in samples, not wall-clock: the decoder must
    // behave identically whether audio arrives in real time or is pushed
    // through as fast as a test can feed it.
    if (this._sampleCnt - this._lastAcqAt >= BB_RATE) {
      this._lastAcqAt = this._sampleCnt;
      if (this._charsSinceAcq < 2) this._coarseAcquire();
      this._charsSinceAcq = 0;
    }

    this._maybeEmitMetrics();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  _configure() {
    this._sr = this._sampleRateFn() || 12000;

    // ~100 Hz corner: wide enough to pass the 31.25 baud BPSK main lobe whole
    // plus the AFC search range, narrow enough that decimating to 250 Hz does
    // not alias.
    for (const f of this._lpI) _biquadLowpass(f, 100, this._sr, 0.707);
    for (const f of this._lpQ) _biquadLowpass(f, 100, this._sr, 0.707);

    this._retune();
    this._imdConfigure();
  }

  /**
   * Point the NCO at the current carrier. Kept separate from _configure()
   * because the fine AFC runs once per symbol: rebuilding the biquads at that
   * rate would zero their state 31 times a second and destroy the signal.
   */
  _retune() {
    const w = 2 * Math.PI * (this._baseCenter + this._afcHz) / this._sr;
    this._stepC = Math.cos(w);
    this._stepS = Math.sin(w);
  }

  _buildMatchedFilter() {
    // Hann over two symbols, normalised to unit sum.
    this._mfTaps = new Float32Array(MF_TAPS);
    let sum = 0;
    for (let k = 0; k < MF_TAPS; k++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (k + 0.5) / MF_TAPS);
      this._mfTaps[k] = w;
      sum += w;
    }
    for (let k = 0; k < MF_TAPS; k++) this._mfTaps[k] /= sum;
  }

  _basebandSample(i, q) {
    // Keep the raw (pre matched-filter) baseband for coarse acquisition.
    this._acqRe[this._acqPos] = i;
    this._acqIm[this._acqPos] = q;
    this._acqPos = (this._acqPos + 1) % COARSE_N;
    if (this._acqFilled < COARSE_N) this._acqFilled++;

    // 3. Matched filter.
    this._mfI[this._mfPos] = i;
    this._mfQ[this._mfPos] = q;
    this._mfPos = (this._mfPos + 1) % MF_TAPS;

    let fi = 0, fq = 0;
    for (let k = 0; k < MF_TAPS; k++) {
      const t = this._mfTaps[k];
      const p = (this._mfPos + k) % MF_TAPS;
      fi += this._mfI[p] * t;
      fq += this._mfQ[p] * t;
    }

    // 4. Symbol timing: bin the envelope by phase within the symbol.
    const mag = Math.sqrt(fi * fi + fq * fq);
    const bin = this._sampleCnt % SPS;
    this._envBins[bin] += 0.02 * (mag - this._envBins[bin]);

    if (bin === SPS - 1) this._updateSymbolPhase();

    if (bin === this._symPhase) this._symbol(fi, fq);
    this._sampleCnt++;
  }

  _updateSymbolPhase() {
    let best = 0, worst = 0, bestK = 0;
    for (let k = 0; k < SPS; k++) {
      const v = this._envBins[k];
      if (v > best) { best = v; bestK = k; }
      if (k === 0 || v < worst) worst = v;
    }
    // A flat histogram means noise only — hold the current phase.
    this._timingLocked = best > 0 && worst > 0 && (best / worst) > 1.3;
    if (!this._timingLocked) return;

    if (bestK !== this._symPhase) {
      // Slew one bin at a time along the shorter way round the circle.
      const fwd = (bestK - this._symPhase + SPS) % SPS;
      this._symPhase = (this._symPhase + (fwd <= SPS / 2 ? 1 : SPS - 1)) % SPS;
    }
  }

  _symbol(i, q) {
    if (!this._havePrev) {
      this._prevI = i; this._prevQ = q; this._havePrev = true;
      return;
    }

    // 5. Differential detection: d = z · conj(zPrev).
    const dr = i * this._prevI + q * this._prevQ;
    const di = q * this._prevI - i * this._prevQ;
    this._prevI = i; this._prevQ = q;

    const mag = Math.sqrt(dr * dr + di * di);
    if (mag < 1e-12) return;

    // Coherence: how close the decision vector is to the real axis. Random noise
    // averages to 2/pi (~0.64) here, a clean signal to nearly 1.
    this._coherence += 0.02 * (Math.abs(dr) / mag - this._coherence);

    // After differential detection the data sits entirely on the real axis, so
    // the imaginary part is a direct measure of the noise.
    this._sigPow   += 0.02 * (dr * dr - this._sigPow);
    this._noisePow += 0.02 * (di * di - this._noisePow);

    // AFC: the residual carrier offset rotates d away from 0 or pi. Folding the
    // angle into +/-pi/2 removes the data modulation and leaves the error. This
    // is gated on timing lock only — gating it on decision quality would
    // deadlock, since the quality is what the correction is meant to restore.
    if (this._afcOn && this._timingLocked) {
      const err = (dr >= 0) ? Math.atan2(di, dr) : Math.atan2(-di, -dr);
      const errHz = err * SYMBOL_RATE / (2 * Math.PI);
      const next = this._afcHz + AFC_GAIN * errHz;
      this._afcHz = Math.max(-AFC_LIMIT_HZ, Math.min(AFC_LIMIT_HZ, next));
      this._retune();
    }

    this._bit(dr >= 0 ? 1 : 0);
  }

  _bit(bit) {
    // 6. Varicode: "00" closes a character, and the register then holds the
    // codeword as a binary number (it was cleared at the previous delimiter).
    this._shreg = ((this._shreg << 1) | bit) >>> 0;
    if ((this._shreg & 3) !== 0) return;

    const code = this._shreg >>> 2;
    this._shreg = 0;
    if (!code) return;

    const ascii = VARICODE_DECODE.get(code);
    if (ascii === undefined) return;

    // A valid codeword is itself evidence that the carrier is right, so it
    // counts towards suppressing re-acquisition even when squelched.
    this._charsSinceAcq++;

    if (this.lockQuality < SQUELCH_LOCK) return;
    if (!this.onChar) return;

    this.onChar(String.fromCharCode(ascii));
  }

  get lockQuality() {
    // Map the 0.64 (noise) .. 1.0 (clean) coherence range onto 0..100.
    const q = (this._coherence - 0.64) / 0.34;
    return Math.max(0, Math.min(100, Math.round(q * 100)));
  }

  get snrDb() {
    // Re(d)^2 carries signal + half the noise, Im(d)^2 carries the other half,
    // so the ratio below is the S/N in the symbol bandwidth. Reported on the
    // same 3 kHz scale as the RTTY panel: measured on calibrated noise, the raw
    // figure is the 3 kHz SNR + 20.2 dB (10·log(3000/31.25) = 19.8, plus the
    // matched filter) from −5 dB up; below that noise × noise terms in the
    // differential product compress it, which the table undoes.
    if (this._noisePow <= 0) return SNR_FLOOR_DB;
    const ratio = this._sigPow / this._noisePow - 1;
    if (!(ratio > 0)) return SNR_FLOOR_DB;
    return _rawSnrTo3k(10 * Math.log10(ratio));
  }

  /**
   * Coarse frequency acquisition — the power-weighted centroid of the baseband
   * spectrum, which is the carrier offset.
   *
   * The centroid is used rather than a peak search because a BPSK31 signal
   * looks completely different idle and loaded: idle (continuous reversals) is
   * two discrete lines at +/-15.625 Hz, while random data is a broad hump one
   * baud wide. Both are symmetric about the carrier, so their centroid is the
   * offset either way. The correction is additive on top of whatever the fine
   * AFC has already done, since the spectrum is measured after the NCO.
   */
  _coarseAcquire() {
    if (this._acqFilled < COARSE_N) return;

    const re = new Float64Array(COARSE_N);
    const im = new Float64Array(COARSE_N);
    for (let k = 0; k < COARSE_N; k++) {
      const p = (this._acqPos + k) % COARSE_N;
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / COARSE_N);
      re[k] = this._acqRe[p] * w;
      im[k] = this._acqIm[p] * w;
    }
    transformFlat(re, im, false);

    // Bin k maps to k·BB_RATE/N for the lower half, (k−N)·BB_RATE/N above it.
    const binHz = BB_RATE / COARSE_N;
    const pow = new Float64Array(COARSE_N);
    let total = 0;
    for (let k = 0; k < COARSE_N; k++) {
      pow[k] = re[k] * re[k] + im[k] * im[k];
      total += pow[k];
    }
    if (total <= 0) return;

    // Noise floor: the mean over everything outside the search window, so the
    // signal itself does not raise the floor that is subtracted from it.
    const SEARCH_HZ = AFC_LIMIT_HZ + SYMBOL_RATE;   // signal is one baud wide
    let floorSum = 0, floorCnt = 0;
    for (let k = 0; k < COARSE_N; k++) {
      const hz = (k < COARSE_N / 2) ? k * binHz : (k - COARSE_N) * binHz;
      if (Math.abs(hz) > SEARCH_HZ) { floorSum += pow[k]; floorCnt++; }
    }
    const floor = floorCnt ? floorSum / floorCnt : 0;

    let num = 0, den = 0;
    for (let k = 0; k < COARSE_N; k++) {
      const hz = (k < COARSE_N / 2) ? k * binHz : (k - COARSE_N) * binHz;
      if (Math.abs(hz) > SEARCH_HZ) continue;
      const p = pow[k] - floor;
      if (p <= 0) continue;
      num += hz * p;
      den += p;
    }
    // Nothing meaningfully above the floor — this is an empty band.
    if (den <= 0 || den < 4 * floor * (2 * SEARCH_HZ / binHz)) return;

    const offset = num / den;
    // Leave a good lock alone; only step in when the error is real.
    if (Math.abs(offset) < 1) return;

    const next = this._afcHz + offset;
    this._afcHz = Math.max(-AFC_LIMIT_HZ, Math.min(AFC_LIMIT_HZ, next));
    this._retune();
  }

  // ── IMD: Goertzel probes on the input audio ──────────────────────────────
  // A clean BPSK31 signal has its two primary lobes at carrier +/- 15.625 Hz;
  // an overdriven transmitter throws third-order products out at +/- 46.875 Hz.
  // IMD is the ratio between them, which is what the on-air convention reports.

  _imdConfigure() {
    const mk = (offset) => {
      const w = 2 * Math.PI * (this._baseCenter + this._afcHz + offset) / this._sr;
      return { coeff: 2 * Math.cos(w), s1: 0, s2: 0 };
    };
    this._imdProbes = {
      sig: [mk(-15.625), mk(+15.625)],
      imd: [mk(-46.875), mk(+46.875)],
    };
    this._imdWin = 0;
    this._imdLen = Math.max(256, Math.round(this._sr * 0.5));
  }

  _imdFeed(x) {
    const p = this._imdProbes;
    if (!p) return;
    for (const g of p.sig) { const s = x + g.coeff * g.s1 - g.s2; g.s2 = g.s1; g.s1 = s; }
    for (const g of p.imd) { const s = x + g.coeff * g.s1 - g.s2; g.s2 = g.s1; g.s1 = s; }

    if (++this._imdWin < this._imdLen) return;
    this._imdWin = 0;

    const power = (g) => g.s1 * g.s1 + g.s2 * g.s2 - g.coeff * g.s1 * g.s2;
    let sig = 0, imd = 0;
    for (const g of p.sig) { sig += Math.max(0, power(g)); g.s1 = g.s2 = 0; }
    for (const g of p.imd) { imd += Math.max(0, power(g)); g.s1 = g.s2 = 0; }

    if (sig > 0 && imd > 0) {
      const db = 10 * Math.log10(imd / sig);
      this._imdDb = Math.max(-60, Math.min(0, db));
    }

    // Re-aim the probes at wherever the AFC has settled, now that the
    // accumulators are empty and retuning costs nothing.
    this._imdConfigure();
  }

  _maybeEmitMetrics() {
    const now = Date.now();
    if (now - this._lastMetricsAt < 250) return;
    this._lastMetricsAt = now;

    const lock = this.lockQuality;

    if (this.onStatus) {
      const text = !this._timingLocked ? 'Searching…'
                 : lock < SQUELCH_LOCK  ? 'Weak signal'
                 : 'Locked';
      if (text !== this._statusText) {
        this._statusText = text;
        this.onStatus(text);
      }
    }

    if (this.onMetrics) {
      this.onMetrics({
        snrDb:        this.snrDb,
        lockQuality:  lock,
        centerHz:     this._baseCenter + this._afcHz,
        imdDb:        this._imdDb,
        timingLocked: this._timingLocked,
      });
    }
  }
}

// ── RBJ biquad, same design as the one in fsk.js but standalone ─────────────

function _biquadCreate() {
  return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

function _biquadLowpass(f, freq, sampleRate, Q) {
  f.x1 = f.x2 = f.y1 = f.y2 = 0;
  const omega = 2 * Math.PI * freq / sampleRate;
  const sn = Math.sin(omega);
  const cs = Math.cos(omega);
  const alpha = sn / (2 * (Q || 1e-9));
  const a0 = 1 + alpha;
  f.b0 = ((1 - cs) / 2) / a0;
  f.b1 = (1 - cs) / a0;
  f.b2 = f.b0;
  f.a1 = (-2 * cs) / a0;
  f.a2 = (1 - alpha) / a0;
}

function _biquadStep(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1; f.x1 = x;
  f.y2 = f.y1; f.y1 = y;
  return y;
}

export default PSK31Demodulator;
