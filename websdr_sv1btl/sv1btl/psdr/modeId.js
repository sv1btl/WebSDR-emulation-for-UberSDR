/**
 * modeId.js — "what am I listening to?" digital-mode identifier.
 *
 * Feeds off the same raw PCM tap as the decoders and reports a ranked guess at
 * the mode in the passband, so the operator can pick the right decoder without
 * trying all ten.  It NEVER decodes anything: it measures a handful of physical
 * properties of the signal and scores them against a table of known modes.
 *
 * The measurements, and why each one is here:
 *
 *   1. Averaged spectrum      occupied bandwidth, tone count, tone spacing.
 *                             An EMA over 4096-point Hann FFTs (2.93 Hz bins at
 *                             12 kHz).  Bandwidth is the contiguous -15 dB width
 *                             around the peak, NOT a 99%-power figure: keying
 *                             splatter puts long tails on the power integral and
 *                             made every narrow mode look several times too wide.
 *
 *   2. Symbol rate            from the INSTANTANEOUS FREQUENCY, not from tone
 *                             energies.  An energy split needs an integration
 *                             long enough to resolve a 170 Hz shift (~6 ms) yet
 *                             short enough to resolve a 100 Bd symbol (10 ms),
 *                             which does not work.  Mixing to baseband and
 *                             differentiating the phase gives a clean two-level
 *                             waveform whose shortest run is one symbol.
 *
 *   3. Keying rate            run lengths of the on/off envelope at 1 kHz, for
 *                             the OOK modes.  Doubles as a CW speed readout.
 *
 *   4. Burst cadence          in-band power at 50 Hz kept for 130 s, so the
 *                             UTC-slotted modes are recognised by timing alone:
 *                             FT8 keys up for 12.64 s on a 15 s grid, FT4 for
 *                             4.48 s on 7.5 s, WSPR for 110.6 s on an even
 *                             minute.  Grids are tried longest-first and a grid
 *                             shorter than the burst is rejected — otherwise
 *                             every 15 s signal also "fits" the 7.5 s grid.
 *
 *   5. Band flatness          separates a couple of discrete tones (RTTY) from a
 *                             filled band (FAX, SSTV).
 *
 * WHAT THIS CANNOT DO, by construction:
 *
 *   FT8, JS8 and FT2 are the same 8-FSK signal — 6.25 Hz tone spacing, ~50 Hz
 *   wide — and JS8 in normal mode shares FT8's 15 s cadence.  Nothing in the
 *   spectrum or the timing separates them, so this file deliberately reports
 *   them as ONE candidate family rather than inventing a distinction.  Settling
 *   it needs an actual decode.
 *
 * Interface mirrors the other engines (KiwiFSKDecoder, KiwiSSTVDecoder):
 *
 *   new ModeIdentifier({ sampleRate, callback, now })
 *   .setEnabled(bool) .setCallback(fn) .feedPCM(Float32Array) .destroy()
 *
 * Emits, about once a second:
 *
 *   { t:'result', ready, fill, candidates:[{key,variant,label,score,why}],
 *     features:{...} }
 */

import { transformFlat } from './lib/fftRadix2.js';

// ── Analysis constants ───────────────────────────────────────────────────────

const FFT_N = 4096;          // 2.93 Hz bins at 12 kHz
const SPEC_EMA = 0.12;       // per-FFT weight of the newest spectrum
const IF_HZ = 1000;          // instantaneous-frequency rate: 100 Bd = 10 frames
const IF_TAPS = 24;          // anti-alias window, 2x the decimation factor
const HIL_TAPS = 191;        // Hilbert FIR length (odd, so the delay is exact)
const ENV_HZ = 1000;         // envelope decision rate, for OOK keying
const CADENCE_HZ = 50;       // in-band power series rate
// Long enough to hold TWO whole WSPR transmissions.  130 s (one transmission
// plus its gap) looked sufficient and was not: a WSPR burst is 110.6 s of a
// 120 s slot, so the burst in progress is always clipped by the end of the
// buffer and the one before it only fits inside a 130 s window during the
// first ten seconds of each slot.  That is why WSPR was almost never named.
const CADENCE_SEC = 270;     // in-band power history retained, seconds
// How much louder the transmit window has to be than the quiet window, once
// the whole history is folded onto a grid period, before the grid is believed.
// Chosen from measurement, not taste.  Real WSPR under fades of 6-30 dB
// measures 3.8-10.3 dB here, and realistic multipath QSB on a bare carrier —
// several fade components at incommensurate periods — measures at most 0.9 dB,
// so 6 dB clears the noise by a wide margin while keeping ten of twelve fading
// WSPR cases.  What sits in between is a fade that is PERIODIC at a submultiple
// of 120 s: a pure 30.000 s tone locks to the fold and reached 6.6 dB.  That is
// why a folded grid scores lower than one placed from real bursts.
const FOLD_CONTRAST_DB = 6;
const AUDIO_LO = 120;        // ignore rumble and the DC corner
const AUDIO_HI = 3200;       // ...and anything above a normal SSB passband
const REPORT_MS = 1000;

const BW_DROP_DB = 15;       // bandwidth is the contiguous width this far down
const MIN_SNR_DB = 6;        // below this we say nothing at all
const PEAK_MERGE_HZ = 20;    // peaks closer than this are one tone
const NOISE_PCTL = 0.25;     // noise floor percentile of the passband spectrum

// Where in the audio passband the measurements are trustworthy.  Measured, not
// guessed: 97% at 400 Hz and 100% from 700 Hz to 3100 Hz, but nothing usable at
// 200 Hz, where the Hilbert transform's response near DC runs out.  Above
// ~2700 Hz an SSB filter starts clipping the upper tone of a wide shift.
// Exported so the UI can offer to move the dial rather than guess badly.
export const RELIABLE_LO_HZ = 400;
export const RELIABLE_HI_HZ = 2700;
export const RECENTRE_TARGET_HZ = 1500;
const IF_BIN_HZ = 2.5;       // instantaneous-frequency histogram resolution
const IF_BINS = 1201;        // +/-1500 Hz, which covers every shift we know
const IF_MERGE_HZ = 20;      // IF modes closer than this are the same tone
const IF_SETTLED_HZ = 25;    // frame-to-frame IF change that still counts as
                             // "holding a tone" rather than moving between two
const IF_MODE_CUT = 0.35;    // an IF mode must reach this fraction of the peak

/** Median of a numeric array slice. */
function median(arr, from, to) {
  return percentile(arr, from, to, 0.5);
}

/**
 * Percentile of a numeric array slice.  The noise floor is taken well below the
 * median because a busy sub-band — an FT8 segment holding dozens of signals —
 * is more than half occupied, and there the median IS signal.  Using it made
 * the measured S/N collapse and the identifier fall silent exactly where it was
 * most wanted.
 */
function percentile(arr, from, to, q) {
  const n = to - from;
  if (n <= 0) return 0;
  const tmp = Float64Array.from(arr.subarray(from, to));
  tmp.sort();
  const i = Math.min(n - 1, Math.max(0, Math.floor(n * q)));
  return tmp[i];
}

/**
 * Shortest well-populated run in a +/-1 series = one symbol period, in frames.
 * Returns 0 when the series has no usable structure: noise is dominated by
 * 1-frame runs, which the local-maximum test rejects.
 */
function shortestRun(series, fill, pos, maxLen, minLen = 2, tol = 0) {
  if (fill < maxLen) return 0;
  const start = (pos - fill + series.length) % series.length;
  const hist = new Int32Array(maxLen);
  let runs = 0, run = 1;
  let prev = series[start];
  for (let i = 1; i < fill; i++) {
    const v = series[(start + i) % series.length];
    if (v === prev) run++;
    else {
      if (run < maxLen) { hist[run]++; runs++; }
      run = 1; prev = v;
    }
  }
  if (runs < 20) return 0;
  const need = Math.max(4, runs * 0.12);
  if (tol > 0) {
    // Relative tolerance, for runs measured in many frames.  A 20 wpm dot is
    // ~60 frames of the 1 kHz envelope, and keying edges plus noise spread it
    // over several adjacent lengths, so no single length ever held 12 % of the
    // runs: CW measured keyRate 0 even at 34 dB S/N.  Here each length is
    // credited with every run within ±tol of it, the shortest such cluster
    // that is a local maximum wins, and the answer is that cluster's centroid.
    const S = (L) => { let a = 0; for (let k = Math.max(1, Math.round(L * (1 - tol))); k <= Math.min(maxLen - 1, Math.round(L * (1 + tol))); k++) a += hist[k]; return a; };
    for (let L = Math.max(2, minLen); L < maxLen - 1; L++) {
      const v = S(L);
      if (v >= need && v >= S(L - 1) && v >= S(L + 1)) {
        let w = 0, m = 0;
        for (let k = Math.max(1, Math.round(L * (1 - tol))); k <= Math.min(maxLen - 1, Math.round(L * (1 + tol))); k++) { w += hist[k]; m += hist[k] * k; }
        return w ? m / w : L;
      }
    }
    return 0;
  }
  for (let L = Math.max(2, minLen); L < maxLen - 1; L++) {
    if (hist[L] >= need && hist[L] >= hist[L - 1] && hist[L] >= hist[L + 1]) return L;
  }
  return 0;
}

export class ModeIdentifier {

  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate
      : (() => options.sampleRate || 12000);
    this._callback = typeof options.callback === 'function' ? options.callback : null;
    // Injectable clock: the cadence analysis is pure timing, so tests need to be
    // able to drive it faster than real time.
    this._now = typeof options.now === 'function' ? options.now : (() => Date.now());
    this._enabled = false;
    this._reset();
  }

  _reset() {
    const sps = this._sampleRateFn() || 12000;

    // (1) spectrum
    this._acc = new Float32Array(FFT_N);
    this._accLen = 0;
    this._window = new Float64Array(FFT_N);
    for (let i = 0; i < FFT_N; i++) {
      this._window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1));
    }
    this._re = new Float64Array(FFT_N);
    this._im = new Float64Array(FFT_N);
    this._spec = new Float64Array(FFT_N >> 1);
    this._specSeen = 0;

    // (2) instantaneous frequency — complex mixer + boxcar + decimator
    this._mixPhase = 0;
    this._mixHz = 0;                 // set from the measured band centre
    // Hilbert transform first, so the mixer sees an ANALYTIC signal and there is
    // no image to reject at all.  Mixing the real signal instead leaves a sum
    // image at -(f + fc): filterable when fc is high, but at a 500 Hz centre it
    // lands within a few hundred Hz of the wanted tone and no low-pass can
    // separate them.  That was why anything below ~700 Hz audio failed — which
    // includes NAVTEX, conventionally tuned at 500 Hz.
    this._hil = new Float64Array(HIL_TAPS);
    const mid = (HIL_TAPS - 1) >> 1;
    for (let i = 0; i < HIL_TAPS; i++) {
      const k = i - mid;
      if (k % 2 === 0) { this._hil[i] = 0; continue; }
      // Blackman-windowed ideal Hilbert kernel.
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (HIL_TAPS - 1))
                     + 0.08 * Math.cos((4 * Math.PI * i) / (HIL_TAPS - 1));
      this._hil[i] = (2 / (Math.PI * k)) * w;
    }
    this._hilBuf = new Float64Array(HIL_TAPS);
    this._hilPos = 0;
    this._hilMid = mid;

    this._decim = Math.max(1, Math.round(sps / IF_HZ));
    this._ifHz = sps / this._decim;
    this._winI = new Float64Array(IF_TAPS);
    this._winQ = new Float64Array(IF_TAPS);
    this._winPos = 0;
    this._winN = 0;
    this._aaWin = new Float64Array(IF_TAPS);
    let wsum = 0;
    for (let i = 0; i < IF_TAPS; i++) {
      this._aaWin[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 1)) / (IF_TAPS + 1));
      wsum += this._aaWin[i];
    }
    for (let i = 0; i < IF_TAPS; i++) this._aaWin[i] /= wsum;
    this._prevI = 0; this._prevQ = 0;
    this._ifSeries = new Int8Array(IF_HZ * 4);      // 4 s of +/-1 decisions
    this._ifPos = 0; this._ifFill = 0;
    this._prevIfHz = null;
    // Histogram of the instantaneous frequency itself.  A tone pair or an MFSK
    // comb shows up here as sharp modes whose separation is the shift — and
    // unlike the spectrum, this is immune to the FSK sidebands that appear at a
    // modulation index near 2 and wrecked the spectral comb estimate.
    this._ifHist = new Float64Array(IF_BINS);

    // (3) envelope on/off at ENV_HZ
    this._envLen = Math.max(1, Math.round(sps / ENV_HZ));
    this._envAcc = 0; this._envN = 0;
    this._envPow = new Float64Array(ENV_HZ * 4);
    this._envPowPos = 0; this._envPowFill = 0;
    this._envSeries = new Int8Array(ENV_HZ * 4);
    this._envPos = 0; this._envFill = 0;
    // Narrow-band twins of the envelope and cadence series: the power of the
    // baseband signal the mixer already makes (centred on the measured signal,
    // ~750 Hz noise bandwidth) instead of the whole audio passband.  For a
    // narrow signal that is ~9 dB less noise under the same on/off ratio — a
    // 50 Hz FT8 carrier at 0 dB in 2500 Hz lifted the full-band power by under
    // 2 dB, so its bursts were invisible and it read as continuous.  Used only
    // while the measured signal is narrow (see _report); wide modes keep the
    // full-band series their gates were tuned on.
    this._envPowNb = new Float64Array(ENV_HZ * 4);
    this._nbEnvAcc = 0; this._nbEnvCnt = 0; this._nbEnvLast = 0;
    this._nbCadAcc = 0; this._nbCadCnt = 0; this._nbCadLast = 0;
    this._narrow = false;
    // A second, signal-sized low-pass on the baseband for those series: a
    // 25 Hz CW carrier in a 750 Hz window still sat ~15 dB deep in noise
    // it does not occupy.  Two one-pole stages, cutoff set in _report from
    // the measured width (25–200 Hz); even at 25 Hz the rise time is ~6 ms,
    // well inside a 60 wpm dot.
    this._lpI = 0; this._lpQ = 0; this._lpI2 = 0; this._lpQ2 = 0;
    this._lpA = 1 - Math.exp(-2 * Math.PI * 200 / this._ifHz);

    // (4) slow in-band power, for burst cadence
    this._cadLen = Math.max(1, Math.round(sps / CADENCE_HZ));
    this._cadPos = 0; this._cadAcc = 0;
    this._cad = new Float64Array(CADENCE_HZ * CADENCE_SEC);
    this._cadTime = new Float64Array(CADENCE_HZ * CADENCE_SEC);
    this._cadNb = new Float64Array(CADENCE_HZ * CADENCE_SEC);
    this._cadIdx = 0; this._cadFill = 0;

    this._lastReport = 0;
    this._samplesSeen = 0;
  }

  // ── Public surface ─────────────────────────────────────────────────────────

  setEnabled(on) {
    const next = !!on;
    if (next === this._enabled) return;
    this._enabled = next;
    if (next) this._reset();
  }

  setCallback(fn) { this._callback = typeof fn === 'function' ? fn : null; }

  /**
   * Throw away every measurement and start again.  Called after the dial moves:
   * the averaged spectrum and the 130 s cadence history describe the OLD
   * frequency, and blending them into the new one would take minutes to wash
   * out and give wrong answers meanwhile.
   */
  reset() { this._reset(); }

  destroy() { this._enabled = false; this._callback = null; }

  feedPCM(pcm) {
    if (!this._enabled || !pcm || !pcm.length) return;
    const sps = this._sampleRateFn() || 12000;

    // A chunk is a few hundred milliseconds of audio arriving at once.  Stamping
    // every cadence frame with the arrival time would smear burst edges by a
    // whole chunk — a large fraction of the grid tolerance — so interpolate.
    const tEnd = this._now();
    const tStart = tEnd - (pcm.length / sps) * 1000;
    const msPerSample = 1000 / sps;

    const TAU = 2 * Math.PI;
    const wMix = (TAU * this._mixHz) / sps;

    for (let i = 0; i < pcm.length; i++) {
      const s = pcm[i];

      // (1) spectrum, 50% overlapped
      this._acc[this._accLen++] = s;
      if (this._accLen >= FFT_N) {
        this._absorbSpectrum();
        this._acc.copyWithin(0, FFT_N >> 1);
        this._accLen = FFT_N >> 1;
      }

      // (2) instantaneous frequency
      if (this._mixHz > 0) {
        // Analytic signal: I is the input delayed by the Hilbert group delay,
        // Q is the Hilbert output.  Only the odd taps are non-zero.
        this._hilBuf[this._hilPos] = s;
        this._hilPos = (this._hilPos + 1) % HIL_TAPS;
        let q = 0;
        for (let k = 1; k < HIL_TAPS; k += 2) {
          q += this._hil[k] * this._hilBuf[(this._hilPos + k) % HIL_TAPS];
        }
        const iRe = this._hilBuf[(this._hilPos + this._hilMid) % HIL_TAPS];
        // (I + jQ) * e^-jphi
        const c = Math.cos(this._mixPhase), sn = Math.sin(this._mixPhase);
        this._winI[this._winPos] = iRe * c + q * sn;
        this._winQ[this._winPos] = q * c - iRe * sn;
        this._winPos = (this._winPos + 1) % IF_TAPS;
        this._mixPhase += wMix;
        if (this._mixPhase >= TAU) this._mixPhase -= TAU;
        if (++this._winN >= this._decim) {
          this._winN = 0;
          let I = 0, Q = 0;
          for (let k = 0; k < IF_TAPS; k++) {
            const j = (this._winPos + k) % IF_TAPS;   // oldest first
            const w = this._aaWin[k];
            I += this._winI[j] * w;
            Q += this._winQ[j] * w;
          }
          // d(phase) between consecutive baseband samples = frequency offset.
          const dI = I * this._prevI + Q * this._prevQ;
          const dQ = Q * this._prevI - I * this._prevQ;
          this._prevI = I; this._prevQ = Q;
          const df = Math.atan2(dQ, dI);
          this._ifSeries[this._ifPos] = df >= 0 ? 1 : -1;
          this._ifPos = (this._ifPos + 1) % this._ifSeries.length;
          if (this._ifFill < this._ifSeries.length) this._ifFill++;
          // Histogram only the SETTLED part of each symbol: while the signal
          // moves from one tone to the next, the instantaneous frequency sweeps
          // through everything in between.  On its own this changes nothing
          // measurable — the smoothing and the mode threshold below do the real
          // work — but with them in place it is what takes 100 Bd from 22/24
          // clean readings to 24/24.  Weighted by amplitude, so a key-up gap
          // contributes nothing.
          const hz = (df * this._ifHz) / (2 * Math.PI);
          const settled = this._prevIfHz !== null &&
                          Math.abs(hz - this._prevIfHz) < IF_SETTLED_HZ;
          this._prevIfHz = hz;
          if (settled) {
            const b = Math.round(hz / IF_BIN_HZ) + (IF_BINS >> 1);
            if (b >= 0 && b < IF_BINS) this._ifHist[b] += I * I + Q * Q;
          }
          const a = this._lpA;
          this._lpI += a * (I - this._lpI); this._lpQ += a * (Q - this._lpQ);
          this._lpI2 += a * (this._lpI - this._lpI2); this._lpQ2 += a * (this._lpQ - this._lpQ2);
          const pw = this._lpI2 * this._lpI2 + this._lpQ2 * this._lpQ2;
          this._nbEnvAcc += pw; this._nbEnvCnt++;
          this._nbCadAcc += pw; this._nbCadCnt++;
        }
      }

      // (3) envelope power at ENV_HZ
      this._envAcc += s * s;
      if (++this._envN >= this._envLen) {
        this._envPow[this._envPowPos] = this._envAcc / this._envLen;
        if (this._nbEnvCnt) { this._nbEnvLast = this._nbEnvAcc / this._nbEnvCnt; this._nbEnvAcc = 0; this._nbEnvCnt = 0; }
        this._envPowNb[this._envPowPos] = this._nbEnvLast;
        this._envPowPos = (this._envPowPos + 1) % this._envPow.length;
        if (this._envPowFill < this._envPow.length) this._envPowFill++;
        this._envAcc = 0; this._envN = 0;
      }

      // (4) cadence power at CADENCE_HZ
      this._cadAcc += s * s;
      if (++this._cadPos >= this._cadLen) {
        this._cad[this._cadIdx] = this._cadAcc / this._cadLen;
        if (this._nbCadCnt) { this._nbCadLast = this._nbCadAcc / this._nbCadCnt; this._nbCadAcc = 0; this._nbCadCnt = 0; }
        this._cadNb[this._cadIdx] = this._nbCadLast;
        this._cadTime[this._cadIdx] = tStart + (i + 1) * msPerSample;
        this._cadIdx = (this._cadIdx + 1) % this._cad.length;
        if (this._cadFill < this._cad.length) this._cadFill++;
        this._cadAcc = 0; this._cadPos = 0;
      }

      this._samplesSeen++;
    }

    if (tEnd - this._lastReport >= REPORT_MS) {
      this._lastReport = tEnd;
      this._report(sps);
    }
  }

  // ── Measurement ────────────────────────────────────────────────────────────

  _absorbSpectrum() {
    const N = FFT_N;
    const re = this._re, im = this._im;
    for (let i = 0; i < N; i++) { re[i] = this._acc[i] * this._window[i]; im[i] = 0; }
    transformFlat(re, im, false);
    const half = N >> 1;
    const a = this._specSeen === 0 ? 1 : SPEC_EMA;
    for (let k = 0; k < half; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      this._spec[k] = this._spec[k] * (1 - a) + p * a;
    }
    this._specSeen++;
  }

  _analyseSpectrum(sps) {
    const half = FFT_N >> 1;
    const binHz = sps / FFT_N;
    const kLo = Math.max(1, Math.floor(AUDIO_LO / binHz));
    const kHi = Math.min(half - 1, Math.ceil(AUDIO_HI / binHz));

    const floor = percentile(this._spec, kLo, kHi, NOISE_PCTL) || 1e-20;

    let peakPow = 0, peakBin = kLo;
    for (let k = kLo; k <= kHi; k++) {
      if (this._spec[k] > peakPow) { peakPow = this._spec[k]; peakBin = k; }
    }
    const snrDb = 10 * Math.log10(peakPow / floor);

    // Bandwidth: contiguous width BW_DROP_DB below the peak.  Immune to the
    // splatter tails that wreck a 99%-power measurement.
    // The width of the ONE strongest signal, walking out from its peak and
    // stopping at the first bin below the edge.  An earlier version bridged
    // quiet gaps up to 550 Hz so that an FSK tone pair counted as one signal —
    // but in a busy sub-band that welded every neighbouring signal together and
    // reported 3 kHz where an FT8 carrier is 50 Hz, which is precisely why the
    // FTx family stopped being recognised on air.  Tone structure comes from
    // the instantaneous-frequency histogram instead, which needs no bridging.
    const edge = peakPow * Math.pow(10, -BW_DROP_DB / 10);
    let lo = peakBin, hi = peakBin;
    while (lo > kLo && this._spec[lo - 1] >= edge) lo--;
    while (hi < kHi && this._spec[hi + 1] >= edge) hi++;
    let bwHz = (hi - lo + 1) * binHz;
    let centerHz = ((lo + hi) / 2) * binHz;

    // Flatness inside the band: geometric / arithmetic mean.  ~1 for a filled
    // band, small for a couple of discrete tones.
    let logSum = 0, linSum = 0, n = 0;
    for (let k = lo; k <= hi; k++) {
      const p = Math.max(this._spec[k], 1e-30);
      logSum += Math.log(p); linSum += p; n++;
    }
    const flatness = n > 0 ? Math.exp(logSum / n) / (linSum / n) : 0;

    // Tones: local maxima well above the floor, then MERGED — a single strong
    // tone spreads over several bins and each is a local max in noise, so
    // unmerged peaks made every signal look like a dense MFSK comb.
    const raw = [];
    const thresh = Math.max(floor * Math.pow(10, MIN_SNR_DB / 10), peakPow * 1e-3);
    for (let k = kLo + 1; k < kHi; k++) {
      const p = this._spec[k];
      if (p >= thresh && p > this._spec[k - 1] && p >= this._spec[k + 1]) {
        raw.push({ hz: k * binHz, pow: p });
      }
    }
    raw.sort((a, b) => a.hz - b.hz);
    const tones = [];
    for (const p of raw) {
      const last = tones[tones.length - 1];
      if (last && p.hz - last.hz < PEAK_MERGE_HZ) {
        if (p.pow > last.pow) { last.hz = p.hz; last.pow = p.pow; }
      } else tones.push({ hz: p.hz, pow: p.pow });
    }
    // -7 dB, not -13: at a modulation index near 2 an FSK signal grows sidebands
    // either side of each tone, and at -13 dB they joined the comb and destroyed
    // the spacing estimate.  Genuine MFSK tones are all within a few dB.
    const strong = tones.filter(t => t.pow >= peakPow * 0.2)
                        .sort((a, b) => b.pow - a.pow)
                        .slice(0, 12);
    const byHz = strong.map(t => t.hz).sort((a, b) => a - b);

    // A comb is only a comb if the gaps agree with each other.
    let toneSpacingHz = 0;
    if (byHz.length >= 2) {
      const gaps = [];
      for (let i = 1; i < byHz.length; i++) gaps.push(byHz[i] - byHz[i - 1]);
      const med = gaps.slice().sort((a, b) => a - b)[gaps.length >> 1];
      const consistent = gaps.filter(g => Math.abs(g - med) <= Math.max(8, med * 0.25));
      if (consistent.length >= Math.max(1, gaps.length - 1)) toneSpacingHz = med;
    }

    // For a tone pair or a comb the contiguous walk stops in the valley between
    // tones and reports one tone's width.  When the tones form a consistent
    // group, the bandwidth is the span of the group instead.
    if (toneSpacingHz > 0 && byHz.length >= 2) {
      const span = byHz[byHz.length - 1] - byHz[0];
      // Capped: a "comb" spanning more than this is several signals, not one.
      if (span > bwHz && span <= 1200) {
        centerHz = (byHz[0] + byHz[byHz.length - 1]) / 2;
        bwHz = span;
      }
    }

    // Two-level wide FM.  A weather fax is a black level and a white level
    // 800 Hz apart, and a typical chart is white about 80% of the time, so the
    // black level sits 7-15 dB down: it never survives the -7 dB filter above,
    // which the FSK spacing estimate needs and must keep.  Worse, the
    // contiguous -15 dB walk cannot cross the deep valley between the two
    // levels either, so a real weather chart measured as a bare 40 Hz carrier
    // sitting on the white level, and read as PSK31.
    //
    // Measured separately, and referenced to the NOISE FLOOR rather than to the
    // peak: the span of everything at least 12 dB out of the noise within 1 kHz
    // of the dominant level.  800 Hz for a fax, ~0 for a lone carrier.
    const lvlThresh = floor * Math.pow(10, 12 / 10);
    const peakHz = peakBin * binHz;
    let lvlLo = Infinity, lvlHi = -Infinity;
    for (const t of tones) {
      if (t.pow < lvlThresh) continue;
      if (Math.abs(t.hz - peakHz) > 1000) continue;
      // The SSTV line sync is a separate tone BELOW the picture, not part of
      // the picture band, and counting it dragged the measured lower edge down
      // to 1200 Hz — which then failed the very test that edge exists for.
      if (Math.abs(t.hz - 1200) <= 80) continue;
      if (t.hz < lvlLo) lvlLo = t.hz;
      if (t.hz > lvlHi) lvlHi = t.hz;
    }
    const levelSpanHz = lvlHi > lvlLo ? lvlHi - lvlLo : 0;
    const levelLoHz = lvlLo === Infinity ? 0 : lvlLo;

    // SSTV puts a sync pulse at 1200 Hz on every line; a fax picture does not.
    // Measured as the 1200 Hz bin against the median of the occupied band, this
    // is the only honest way to tell two filled ~800 Hz FM bands apart.
    // Measured as LOCAL contrast — the 1200 Hz bin against the median of its
    // own neighbourhood, 100-300 Hz either side.  Referencing it to the global
    // noise floor instead made the figure move whenever the floor estimator
    // changed, and a fax picture read as an SSTV sync the moment the floor was
    // taken lower.  What actually distinguishes them is that SSTV's sync is a
    // discrete LINE standing above its surroundings; a fax has no such line.
    const k1200 = Math.round(1200 / binHz);
    const nbLo = Math.round(100 / binHz), nbHi = Math.round(300 / binHz);
    let syncDb = -99;
    if (k1200 - nbHi > kLo && k1200 + nbHi < kHi) {
      const around = [];
      for (let d = nbLo; d <= nbHi; d++) {
        around.push(this._spec[k1200 - d], this._spec[k1200 + d]);
      }
      around.sort((a, b) => a - b);
      const nb = around[around.length >> 1] || 1e-20;
      // Take the strongest of the three bins at the line, so a slightly
      // off-frequency receiver does not lose the sync.
      const line = Math.max(this._spec[k1200 - 1], this._spec[k1200], this._spec[k1200 + 1]);
      syncDb = 10 * Math.log10(line / nb);
    }

    return {
      centerHz, bwHz, snrDb, flatness, toneSpacingHz, syncDb,
      levelSpanHz, levelLoHz,
      toneCount: strong.length,
      peaks: strong.slice(0, 8),
    };
  }

  /**
   * Tone structure from the instantaneous-frequency histogram: how many tones
   * the signal actually visits, and how far apart they are.  Returns zeros when
   * the histogram has no clear modes (noise, or a filled FM band).
   */
  _analyseIfHistogram() {
    // Smooth over +/-10 Hz first: a tone is a broad lumpy hill in this
    // histogram, and its local bumps were each being counted as a mode.
    const raw = this._ifHist;
    const h = new Float64Array(IF_BINS);
    const sm = Math.max(1, Math.round(10 / IF_BIN_HZ));
    for (let i = 0; i < IF_BINS; i++) {
      let acc = 0, n = 0;
      for (let d = -sm; d <= sm; d++) {
        const j = i + d;
        if (j >= 0 && j < IF_BINS) { acc += raw[j]; n++; }
      }
      h[i] = acc / n;
    }
    let max = 0, total = 0;
    for (let i = 0; i < IF_BINS; i++) { total += h[i]; if (h[i] > max) max = h[i]; }
    if (max <= 0 || total <= 0) return { toneSpacingHz: 0, toneCount: 0 };

    // Only modes of COMPARABLE strength count.  The tones of a real FSK or MFSK
    // signal are all within a few dB of each other; the low-level debris that a
    // 20% threshold admitted was inserting phantom tones between the real ones
    // and halving the measured shift.
    const cut = max * IF_MODE_CUT;
    const modes = [];
    for (let i = 1; i < IF_BINS - 1; i++) {
      if (h[i] >= cut && h[i] >= h[i - 1] && h[i] >= h[i + 1]) {
        const hz = (i - (IF_BINS >> 1)) * IF_BIN_HZ;
        const last = modes[modes.length - 1];
        // Merge distance is an absolute frequency, not a bin count: at 2.5 Hz
        // resolution a bin-based distance was far too small and one tone became
        // a dozen "modes".  20 Hz still keeps Olivia's 31.25 Hz tones apart.
        if (last && hz - last.hz <= IF_MERGE_HZ) {
          if (h[i] > last.pow) { last.hz = hz; last.pow = h[i]; }
        } else modes.push({ hz, pow: h[i] });
      }
    }
    if (modes.length < 2) return { toneSpacingHz: 0, toneCount: modes.length };

    // A filled FM band produces dozens of "modes" — that is not a comb.
    if (modes.length > 16) return { toneSpacingHz: 0, toneCount: 0 };

    const gaps = [];
    for (let i = 1; i < modes.length; i++) gaps.push(modes[i].hz - modes[i - 1].hz);
    const med = gaps.slice().sort((a, b) => a - b)[gaps.length >> 1];
    const consistent = gaps.filter(g => Math.abs(g - med) <= Math.max(10, med * 0.3));
    if (consistent.length < Math.max(1, gaps.length - 1)) {
      return { toneSpacingHz: 0, toneCount: modes.length };
    }
    return { toneSpacingHz: med, toneCount: modes.length };
  }

  /** Symbol rate from the instantaneous-frequency run lengths. */
  _estimateBaud(dutyOn) {
    // An instantaneous frequency taken through key-up gaps or through a filled
    // FM band flips sign every other frame; that 2-frame mode is noise, not a
    // symbol, so runs shorter than 4 frames are not eligible.  And a baud only
    // means something for a carrier that is actually present throughout.
    if (dutyOn < 0.8) return 0;
    const L = shortestRun(this._ifSeries, this._ifFill, this._ifPos, 400, 4);
    return L ? this._ifHz / L : 0;
  }

  /**
   * Keying rate from the on/off envelope.  Returns { rate, dutyOn } where rate
   * is elements per second — for CW that is one dot, so WPM ~= rate * 1.2.
   */
  _estimateKeying() {
    if (this._envPowFill < ENV_HZ) return { rate: 0, dutyOn: 1 };
    const n = this._envPowFill;
    const start = (this._envPowPos - n + this._envPow.length) % this._envPow.length;
    const vals = new Float64Array(n);
    const src = this._narrow ? this._envPowNb : this._envPow;
    for (let i = 0; i < n; i++) vals[i] = src[(start + i) % src.length];
    // Narrow band: a 9 ms moving average as well.  The shortest element worth
    // timing is a 60 wpm dot (20 ms), and without it the noise on a weak
    // keyed carrier dithers across the threshold every few milliseconds.
    if (this._narrow) {
      const c = Float64Array.from(vals);
      for (let i = 0; i < n; i++) { let a = 0, k = 0; for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) { a += c[j]; k++; } vals[i] = a / k; }
    }
    const sorted = Float64Array.from(vals).sort();
    const qLo = sorted[Math.floor(n * 0.05)] || 1e-20;
    const qHi = sorted[Math.floor(n * 0.95)] || 1e-20;
    if (10 * Math.log10(qHi / qLo) < 6) return { rate: 0, dutyOn: 1 };
    const thresh = Math.sqrt(qLo * qHi);
    // Narrow band: with hysteresis — on above 60 % of the span in dB, off
    // below 40 % — so noise riding on a weak element cannot chatter it into
    // a run of 1 ms "elements" (0 dB in 2500 Hz read 256 elements/s without).
    const hiT = Math.pow(qLo, 0.4) * Math.pow(qHi, 0.6), loT = Math.pow(qLo, 0.6) * Math.pow(qHi, 0.4);
    let on = 0, st = vals[0] >= thresh ? 1 : -1;
    for (let i = 0; i < n; i++) {
      let hot;
      if (this._narrow) { if (st > 0 && vals[i] < loT) st = -1; else if (st < 0 && vals[i] > hiT) st = 1; hot = st; }
      else hot = vals[i] >= thresh ? 1 : -1;
      if (hot > 0) on++;
      this._envSeries[this._envPos] = hot;
      this._envPos = (this._envPos + 1) % this._envSeries.length;
      if (this._envFill < this._envSeries.length) this._envFill++;
    }
    const L = shortestRun(this._envSeries, this._envFill, this._envPos, 500, 2, 0.15);
    return { rate: L ? ENV_HZ / L : 0, dutyOn: on / n };
  }

  /**
   * Dominant periodicity of the envelope, in Hz, by autocorrelation.
   *
   * This is what identifies PSK31 rather than merely failing to identify
   * anything else.  BPSK with raised-cosine shaping drives its amplitude
   * through a null at every phase reversal, so the envelope is periodic at the
   * symbol rate.  The constant-envelope MFSK modes — FT8, FT4, WSPR — have a
   * flat envelope and produce nothing here, which is exactly the distinction
   * that was missing: an FT8 carrier is about as wide as PSK31 and its tones
   * are unresolvable, so width alone cannot tell them apart.
   */
  _estimateEnvRate() {
    const n = this._envPowFill;
    if (n < ENV_HZ * 2) return 0;
    const start = (this._envPowPos - n + this._envPow.length) % this._envPow.length;
    const x = new Float64Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      x[i] = (this._narrow ? this._envPowNb : this._envPow)[(start + i) % this._envPow.length];
      mean += x[i];
    }
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) { x[i] -= mean; energy += x[i] * x[i]; }
    if (energy <= 0) return 0;

    // Lags spanning 15-400 Hz, which covers PSK31 at 31.25 Bd with room either
    // side without reaching down into the burst cadence.
    const loLag = Math.max(2, Math.floor(ENV_HZ / 400));
    const hiLag = Math.min(n - 1, Math.ceil(ENV_HZ / 15));
    const r = new Float64Array(hiLag + 2);
    for (let lag = loLag; lag <= hiLag + 1 && lag < n; lag++) {
      let acc = 0;
      for (let i = 0; i + lag < n; i++) acc += x[i] * x[i + lag];
      r[lag] = acc / energy;
    }

    // Take a LOCAL maximum, never the global one.  Autocorrelation always
    // starts high and decays — that slope is just the envelope's own
    // smoothness, and adjacent 1 ms frames are strongly correlated whatever the
    // signal is doing.  Reading the global maximum returned 500 Hz (lag 2) for
    // every input; the periodicity being looked for is the first real bump.
    let best = 0, bestLag = 0;
    for (let lag = loLag + 1; lag <= hiLag; lag++) {
      if (r[lag] > r[lag - 1] && r[lag] >= r[lag + 1] && r[lag] > best) {
        best = r[lag]; bestLag = lag;
      }
    }
    if (bestLag === 0 || best < 0.2) return 0;

    // Parabolic interpolation around the peak, so the rate is not quantised to
    // whole milliseconds — at 31.25 Bd one lag step is nearly 1 Bd.
    const a = r[bestLag - 1], b = r[bestLag], c = r[bestLag + 1];
    const denom = a - 2 * b + c;
    const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    const lag = bestLag + Math.max(-0.5, Math.min(0.5, delta));
    return ENV_HZ / lag;
  }

  /** Burst structure and its fit to the UTC grid. */
  _analyseCadence() {
    if (this._cadFill < CADENCE_HZ * 20) {
      return { continuous: null, burstSec: 0, runSec: 0, gridSec: 0, bursts: 0 };
    }
    const n = this._cadFill;
    const start = (this._cadIdx - n + this._cad.length) % this._cad.length;
    const vals = new Float64Array(n);
    const cad = this._narrow ? this._cadNb : this._cad;
    for (let i = 0; i < n; i++) vals[i] = cad[(start + i) % cad.length];
    // Smooth over 0.4 s BEFORE deciding anything.  Cadence is about whole
    // transmissions, not about what the amplitude does within a symbol: PSK31
    // drives its envelope through a null at every phase reversal, and judging
    // the raw series called that "bursty" and cost it the continuous modes.
    // Smoothing also stops a few signals beating against each other from
    // splitting one 12.64 s FT8 burst into several short ones — which then fit
    // the 7.5 s grid and read as FT4.
    const sm = new Float64Array(n);
    const half = Math.max(1, Math.round(CADENCE_HZ * 0.2));
    let acc0 = 0, cnt0 = 0;
    for (let i = 0; i < n; i++) {
      acc0 += vals[i]; cnt0++;
      if (i >= 2 * half) { acc0 -= vals[i - 2 * half]; cnt0--; }
      sm[i] = acc0 / cnt0;
    }

    const sorted = Float64Array.from(sm).sort();
    // 2nd/98th, not 10th/90th: WSPR has a 92% duty cycle, so a 10th percentile
    // lands inside the burst and the signal looks continuous.
    const qLo = sorted[Math.floor(n * 0.02)] || 1e-20;
    const qHi = sorted[Math.floor(n * 0.98)] || 1e-20;
    const ratioDb = 10 * Math.log10(qHi / qLo);
    // 3 dB, not 6: a receiver's AGC pulls the quiet gap between slots up, and a
    // 6 dB requirement made every AGC'd FT8 segment look continuous.
    if (ratioDb < 3) return { continuous: true, burstSec: 0, runSec: 0, gridSec: 0, bursts: 0, ratioDb };

    const thresh = Math.sqrt(qLo * qHi);
    const raw = [];
    let on = false, s0 = 0;
    for (let i = 0; i < n; i++) {
      const hot = sm[i] >= thresh;
      if (hot && !on) { on = true; s0 = i; }
      else if (!hot && on) { on = false; raw.push([s0, i]); }
    }
    if (on) raw.push([s0, n]);

    // Join runs separated by less than 1 s — still one transmission.
    const merged = [];
    for (const b of raw) {
      const last = merged[merged.length - 1];
      if (last && (b[0] - last[1]) / CADENCE_HZ < 1.0) last[1] = b[1];
      else merged.push([b[0], b[1]]);
    }
    // A burst clipped by the edge of the buffer is not worthless, and discarding
    // it outright was costing the long modes their cadence.  What a clipped
    // burst cannot give is its LENGTH; its START time is still exact, unless it
    // is the one clipped at the beginning of the buffer, whose apparent start is
    // just where the history happens to begin.  So the two are kept apart.
    const summarise = (merged) => {
      const bursts = [];
      for (const [a, b] of merged) {
        const len = (b - a) / CADENCE_HZ;
        if (len < 1.0) continue;
        bursts.push({
          sec: len,
          // The 0.4 s smoothing above is a TRAILING average, so every edge it
          // finds is 0.2 s late; FT4's grid allows 0.9 s and its bursts already
          // start 0.5 s into the slot, so weak FT4 lost its grid to this.
          atMs: this._cadTime[(start + Math.max(0, a - half)) % this._cad.length],
          headClipped: a === 0,
          tailClipped: b >= n,
        });
      }
      if (!bursts.length) return { burstSec: 0, runSec: 0, gridSec: 0, gridErr: 0, bursts: 0 };

      const whole = bursts.filter(b => !b.headClipped && !b.tailClipped);
      const lens = whole.map(b => b.sec).sort((a, b) => a - b);
      const burstSec = lens.length ? lens[lens.length >> 1] : 0;
      // How long the transmission currently in progress has been running.  A
      // minutes-long mode tuned in halfway through has no complete burst at
      // all, and reporting only `burstSec` said "nothing here" about a signal
      // that had been transmitting steadily for a minute.
      const tail = bursts[bursts.length - 1];
      const runSec = tail && tail.tailClipped && !tail.headClipped ? tail.sec : 0;
      // Only a burst whose start is real can place the UTC grid.
      const onGrid = bursts.filter(b => !b.headClipped);

      // Longest grid first, and never accept a grid the burst cannot fit inside
      // — otherwise a 15 s FT8 signal also "fits" the 7.5 s grid it straddles.
      let gridSec = 0, gridErr = 0;
      for (const g of [120, 15, 7.5]) {
        if (burstSec >= g) continue;
        if (!onGrid.length) break;
        // One burst fits any grid by luck.  WSPR is the exception — a second
        // 2-minute burst takes four minutes to see.
        if (onGrid.length < 2 && g !== 120) continue;
        let err = 0;
        for (const b of onGrid) {
          const phase = ((b.atMs / 1000) % g + g) % g;
          err += Math.min(phase, g - phase);
        }
        err /= onGrid.length;
        // How well they have to line up depends on how many there are.  Two
        // bursts land within a second and a half of a 15 s boundary by chance
        // often enough to matter — a teleprinter signal chopped up by QSB did
        // it about once in six tries, and was then named FT8 outright — so two
        // bursts must agree tightly, while three or more is evidence in its own
        // right and can stay loose.  Demanding three outright was tried first
        // and cost FT8 fifteen extra seconds before it could be named at all,
        // which is too much for the mode most operators are looking at.
        const tol = onGrid.length >= 3 ? Math.min(1.5, g * 0.12)
                                       : Math.min(0.5, g * 0.04);
        if (err < tol) { gridSec = g; gridErr = err; break; }
      }
      return { burstSec, runSec, gridSec, gridErr,
               bursts: whole.length || bursts.length };
    };

    // ── The folded-grid test, for the slow modes ─────────────────────────────
    //
    // Everything above works by cutting the history into bursts, and for a
    // 110.6 s WSPR transmission that breaks down under QSB.  A fade null lasts
    // ten seconds or more, so one transmission arrives as a dozen fragments,
    // the 120 s grid is never placed, and the mode falls back to its
    // bare-carrier floor.  Two repairs were tried and BOTH failed, for reasons
    // worth recording so they are not tried again:
    //
    //   - Widening the 1 s join.  Impossible: FT8's inter-burst gap is 2.36 s
    //     and FT4's is 3.02 s, so any tolerance able to bridge a fade destroys
    //     the 15 s and 7.5 s grids.
    //   - Joining across a gap whose floor stays above the off-level, on the
    //     theory that keying stops dead while a fade only dips.  The theory is
    //     sound; the reference is not.  With a signal that fades, the 2nd
    //     percentile used as "off" IS a fade null, so the floor of a gap
    //     measures barely 1 dB above it and nothing is ever joined.
    //
    // So do not segment at all.  The transmission window of a slotted mode is
    // fixed by its protocol and aligned to UTC, and fading is not: fold the
    // whole history onto the grid period and compare the power that lands in
    // the protocol's transmit window against the power in its quiet window.
    // Integrating over minutes is what makes this hold up — a fade moves both
    // windows together and cancels, while a real slotted signal does not.
    // The transmit window is checked in QUARTERS, and the weakest of them is
    // what counts.  Comparing the whole window against the quiet one in a
    // single ratio is not enough: it asks only "is there 120 s periodicity
    // here", which a carrier switching on for 60 s in every 120 also answers,
    // and that then scored as confidently as real WSPR.  Requiring every
    // quarter of the 110.6 s to be up rejects it, because a mode that
    // transmits for half the slot leaves the later quarters at the noise
    // floor.  It is also what separates a slotted signal from plain QSB, whose
    // fade cycle does not respect the slot boundary and so dips some quarter
    // wherever the fold is taken.
    const FOLD_PARTS = 4;
    const foldContrast = (g, onSec) => {
      const acc = new Float64Array(FOLD_PARTS), cnt = new Int32Array(FOLD_PARTS);
      let offAcc = 0, offN = 0;
      for (let i = 0; i < n; i++) {
        const tMs = this._cadTime[(start + i) % this._cad.length];
        if (!tMs) continue;
        const phase = ((tMs / 1000) % g + g) % g;
        // A second of guard either side of the switch-off: a sample landing on
        // the edge belongs to neither window, and counting it blunts the very
        // contrast being measured.
        if (phase < onSec - 1.0) {
          const q = Math.min(FOLD_PARTS - 1, Math.floor(phase / (onSec / FOLD_PARTS)));
          acc[q] += sm[i]; cnt[q]++;
        } else if (phase > onSec + 1.0) { offAcc += sm[i]; offN++; }
      }
      // Every quarter needs enough of the history behind it to mean anything,
      // and the quiet window needs two seconds.
      if (offN < CADENCE_HZ * 2) return 0;
      const off = offAcc / offN || 1e-20;
      let worst = Infinity;
      for (let q = 0; q < FOLD_PARTS; q++) {
        if (cnt[q] < CADENCE_HZ * 3) return 0;
        worst = Math.min(worst, 10 * Math.log10((acc[q] / cnt[q]) / off));
      }
      return worst;
    };

    const strict = summarise(merged);
    // Only the 120 s grid is folded.  The fast modes already place their grids
    // reliably from bursts — their transmissions are far shorter than a fade,
    // so QSB moves a whole burst up or down rather than splitting it — and
    // leaving them alone keeps this change off their path entirely.
    const foldDb = foldContrast(120, 110.6);
    const slowGridSec = foldDb >= FOLD_CONTRAST_DB ? 120 : 0;
    return { continuous: false, ...strict, ratioDb, slowGridSec, foldDb };
  }

  // ── Reporting ──────────────────────────────────────────────────────────────

  _report(sps) {
    // Two full FT8 cycles before we call ourselves ready: a single burst cannot
    // establish a cadence, and claiming otherwise produced confident nonsense.
    const fill = Math.min(1, this._cadFill / (CADENCE_HZ * 32));
    const spec = this._analyseSpectrum(sps);

    // Retune the baseband mixer to the measured band.  The boxcar length is
    // fixed by the IF rate (see _reset) — its ~1 kHz cutoff already passes every
    // shift we care about while rejecting the rest of the passband.
    if (spec.snrDb >= MIN_SNR_DB) this._mixHz = spec.centerHz;
    // Narrow enough for the baseband series to hold all of it (see _reset).
    this._narrow = spec.snrDb >= MIN_SNR_DB && spec.bwHz > 0 && spec.bwHz <= 300;
    if (this._narrow) {
      const fc = Math.max(25, Math.min(200, 0.6 * spec.bwHz));
      this._lpA = 1 - Math.exp(-2 * Math.PI * fc / this._ifHz);
    }

    if (spec.snrDb < MIN_SNR_DB) {
      this._emit({
        t: 'result', ready: fill >= 1, fill, quiet: true, candidates: [],
        features: { ...spec, baud: 0, envRate: 0, keyRate: 0, dutyOn: 1,
                    continuous: null, burstSec: 0, runSec: 0, gridSec: 0,
                    bursts: 0 },
      });
      return;
    }

    const key = this._estimateKeying();
    const baud = this._estimateBaud(key.dutyOn);
    const envRate = this._estimateEnvRate();
    const ifTones = this._analyseIfHistogram();
    const cad = this._analyseCadence();
    const f = {
      centerHz: spec.centerHz, bwHz: spec.bwHz, snrDb: spec.snrDb,
      flatness: spec.flatness, syncDb: spec.syncDb, peaks: spec.peaks,
      levelSpanHz: spec.levelSpanHz, levelLoHz: spec.levelLoHz,
      // The IF histogram is the authority on tone structure; the spectral comb
      // is kept only as a fallback for signals the mixer has not settled on.
      toneSpacingHz: ifTones.toneSpacingHz || spec.toneSpacingHz,
      toneCount: ifTones.toneCount || spec.toneCount,
      baud, envRate, keyRate: key.rate, dutyOn: key.dutyOn,
      continuous: cad.continuous, burstSec: cad.burstSec, runSec: cad.runSec,
      gridSec: cad.gridSec, bursts: cad.bursts,
      // Fade-tolerant cadence, for the modes whose transmissions are long
      // enough that a QSB null lands inside one.  See _analyseCadence.
      slowGridSec: cad.slowGridSec || 0, foldDb: cad.foldDb || 0,
    };

    const candidates = scoreAll(f).filter(c => c.score > 0.25).slice(0, 3);
    this._emit({ t: 'result', ready: fill >= 1, fill, candidates, features: f });
  }

  _emit(ev) {
    if (this._callback) {
      try { this._callback(ev); } catch (e) { console.error('[ModeID] callback', e); }
    }
  }
}

// ── The mode table ───────────────────────────────────────────────────────────
//
// Each entry scores the measured features from 0 to 1.  `key`/`variant` say
// which decoder to launch.  Scorers are independent — several may fire at once,
// and the UI shows the ranking, not just the winner.

/** Triangular tolerance: 1 at target, 0 at target +/- tol. */
function near(value, target, tol) {
  if (!value || !tol) return 0;
  const d = Math.abs(value - target);
  return d >= tol ? 0 : 1 - d / tol;
}

/** Same, but proportional — for values that span decades. */
function nearRel(value, target, frac) { return near(value, target, target * frac); }

/** 1 when v is inside [lo,hi], tapering to 0 over a 30% margin outside. */
function within(v, lo, hi) {
  if (!v) return 0;
  if (v >= lo && v <= hi) return 1;
  const m = v < lo ? (lo - v) / (lo * 0.3) : (v - hi) / (hi * 0.3);
  return Math.max(0, 1 - m);
}

/**
 * The occupied band of a picture mode, from whichever of the two measurements
 * actually saw it.  A photograph fills its band and the contiguous -15 dB width
 * finds it; a weather chart is black on white, and its two levels are separate
 * spikes 800 Hz apart with a valley between that no contiguous walk will cross.
 * Returns the span, its lower edge, and its midpoint — the midpoint being the
 * FM centre, which for a mostly-white chart is nowhere near the strongest bin.
 */
/**
 * A picture band has to sit above the 1200 Hz slot where an SSTV line sync
 * lives — 1500 Hz black is the lowest level either mode uses.  The threshold is
 * well below 1500 because wide FM spreads sidebands a couple of hundred Hz
 * below the black level, and a tighter gate was rejecting perfectly good SSTV
 * whose measured edge landed at 1290 Hz.  It can afford to be loose: the sync
 * slot itself is excluded from the level span, so a 450 Hz weather-RTTY pair
 * centred low is anchored by its LOWER tone, hundreds of Hz beneath this.
 */
const PICTURE_LO_HZ = 1150;

function pictureBand(f) {
  const contiguous = f.bwHz || 0;
  const levels = f.levelSpanHz || 0;
  if (levels > contiguous) {
    const lo = f.levelLoHz || 0;
    return { span: levels, lo, mid: lo + levels / 2 };
  }
  const lo = (f.centerHz || 0) - contiguous / 2;
  return { span: contiguous, lo, mid: f.centerHz || 0 };
}

const MODES = [
  {
    key: 'ft8', variant: null,
    label: 'FT8 / JS8 / FT2 (8-FSK, 15 s)',
    why: '~50 Hz wide, 12.6 s burst on the 15 s UTC grid',
    // Weighted towards the timing on purpose.  In a real FT8 segment the
    // measured bandwidth is whatever the strongest carrier happens to be, and
    // two stations a few tens of Hz apart merge into one wider "signal" — so
    // bandwidth is a weak witness there, while the 15 s cadence is decisive.
    // The burst length has to corroborate the grid, and the floor under that
    // term is what decides how much.  It was 0.4, which handed a signal 40% of
    // the grid credit for a transmission of ANY length — enough that a CW
    // signal chopped up by QSB, landing on a 15 s boundary by chance, was
    // named FT8 outright.  At 0.2 a grid with no plausible burst behind it no
    // longer reaches the display threshold, while a real 12.64 s burst is
    // barely affected: clean FT8 moves 96% -> 94%.
    score: (f) => {
      // A wide tone PAIR is a teleprinter, not an FTx comb: FT8's tones are
      // 6.25 Hz apart and FT4's 20.83, so these measure 0 and 44 Hz here while
      // RTTY and NAVTEX measure 170.  Without this, a teleprinter signal
      // chopped up by QSB that happened to land on the grid was named FT8 at
      // full confidence.  The tone pair is the right thing to veto on because
      // it is the measurement that survives the noise that causes the mix-up.
      if (f.toneSpacingHz >= 100) return 0;
      const grid = near(f.gridSec, 15, 0.1), burst = nearRel(f.burstSec, 12.64, 0.25);
      const base = 0.20 * within(f.bwHz, 30, 250) + 0.15 * (f.continuous === false ? 1 : 0);
      // Width and "not continuous" alone are no evidence of FTx — every keyed
      // CW signal has both, and collected 27–35 % FT8 for it.  Without a grid
      // or a burst of the right length, keep that credit below the display.
      if (!(grid > 0) && !(burst > 0)) return 0.5 * base;
      return 0.65 * grid * (0.2 + 0.8 * burst) + base;
    },
  },
  {
    key: 'ft4', variant: null,
    label: 'FT4 (4-FSK, 7.5 s)',
    why: '~90 Hz wide, 4.5 s burst on the 7.5 s UTC grid',
    score: (f) => {
      if (f.toneSpacingHz >= 100) return 0;    // see FT8 above
      const grid = near(f.gridSec, 7.5, 0.05), burst = nearRel(f.burstSec, 4.48, 0.3);
      const base = 0.20 * within(f.bwHz, 50, 300) + 0.15 * (f.continuous === false ? 1 : 0);
      if (!(grid > 0) && !(burst > 0)) return 0.5 * base;  // see FT8 above
      return 0.65 * grid * (0.2 + 0.8 * burst) + base;
    },
  },
  {
    key: 'wspr', variant: null,
    label: 'WSPR (4-FSK, 2 min)',
    why: 'a few Hz wide, unkeyed, ~111 s starting on an even minute',
    score: (f) => {
      // 4-FSK at 1.46 Hz spacing is 6 Hz wide in total — far too fine to
      // resolve as tones here, so WSPR measures as one very narrow carrier.
      // 3-40 Hz, not 3-30: the WSPR window is only 200 Hz wide and busy, so two
      // carriers within a few Hz of each other merge into one measured signal.
      const bw = within(f.bwHz, 3, 40);
      if (bw <= 0) return 0;
      // Unkeyed.  This is what separates WSPR from a CW signal of exactly the
      // same width, which used to collect the bandwidth credit and sit second
      // on every Morse signal on the band.
      //
      // The upper bound matters as much as the lower one.  keyRate is the modal
      // run length of the envelope over a 4 s window, and a signal fading
      // through the on/off threshold dithers across it in a few milliseconds —
      // which reads as a "keying rate" of several hundred elements per second
      // while the duty cycle sits near a half.  That is QSB, not a fist, and
      // vetoing on it killed exactly the weak fading WSPR this is for.  Only a
      // rate a hand could actually send counts as evidence of keying, which is
      // the same range the CW scorer below demands before it claims a signal
      // is keyed at all.
      if (f.keyRate > 3 && f.keyRate < 60 && f.dutyOn < 0.85) return 0;
      // A 110.6 s transmission is long enough that a QSB null lands INSIDE it
      // rather than between transmissions, so WSPR reads the fade-tolerant
      // cadence in preference to the strict one.  Both are reported; the strict
      // figures are what the 15 s and 7.5 s modes use, and are untouched.
      const grid = near(f.slowGridSec || f.gridSec, 120, 0.02);
      const burst = nearRel(f.burstSec, 110.6, 0.15);
      // A grid recovered by folding is weaker evidence than one placed from
      // whole bursts, because a fade that happens to be periodic near a
      // submultiple of 120 s can imitate it.  Say so in the score rather than
      // claiming the same confidence for both.
      const gridWeight = f.gridSec === 120 ? 0.45 : 0.45 * 0.65;
      // A grid placed from WHOLE bursts has to have the right burst behind it.
      // A carrier switching on for 60 s in every 120 sits exactly on the
      // 2-minute grid without being remotely like WSPR, and it was collecting
      // the full grid credit anyway — 82%, the same as the real thing.  If a
      // complete transmission was measured and it is not about 110 s long,
      // this is not WSPR.  A FADED signal is exempt: its bursts are fade
      // fragments of a few seconds, which is why the fold exists at all, and
      // demanding a whole burst there would undo the fading fix entirely.
      const byBurst = f.gridSec === 120;
      if (byBurst && !(burst > 0) && !(f.slowGridSec === 120)) {
        // fall through to the no-grid paths below
      } else if (grid > 0) {
        return gridWeight * grid + 0.30 * (0.4 + 0.6 * burst) + 0.25 * bw;
      }
      // No grid yet.  Placing a 2-minute cadence takes minutes of listening, so
      // for the first couple of slots it is genuinely unknown — but a narrow
      // unkeyed carrier of very nearly the right length is already worth saying
      // out loud rather than leaving the operator with nothing.
      if (burst > 0) return 0.40 * burst + 0.25 * bw;
      // A bare steady carrier is indistinguishable from WSPR mid-transmission.
      // Say so quietly: below the display threshold unless something has at
      // least been seen to switch on and off.
      return (f.continuous === false ? 0.30 : 0.20) * bw;
    },
  },
  {
    key: 'navtex', variant: null,
    label: 'NAVTEX / SITOR-B',
    why: '170 Hz shift at 100 Bd — the baud is what separates it from RTTY',
    score: (f) =>
      0.35 * near(f.toneSpacingHz, 170, 70) +
      0.50 * nearRel(f.baud, 100, 0.18) +
      0.15 * (f.continuous !== false ? 1 : 0),
  },
  {
    // Same 170 Hz / 100 Bd as NAVTEX, so the signal alone cannot separate them.
    // What does: DSC calls are sub-second bursts, NAVTEX broadcasts run for
    // minutes — and they sit on different channels, which modePriors.js knows.
    // Use starts SERVICES on DSC and puts the carrier on its 1700 Hz.
    key: 'services', variant: 'dsc',
    label: 'DSC (marine selective calling)',
    why: '170 Hz shift at 100 Bd in short bursts, on a DSC calling channel',
    score: (f) => {
      if (f.continuous !== false) return 0;      // NAVTEX runs continuously
      if (f.gridSec) return 0;                   // not a UTC-slotted mode
      return 0.35 * near(f.toneSpacingHz, 170, 70) +
             0.45 * nearRel(f.baud, 100, 0.18) +
             0.20 * (f.burstSec > 0 && f.burstSec < 3 ? 1 : 0);
    },
  },
  {
    key: 'fsk', variant: 'ham',
    label: 'RTTY (45.45 Bd)',
    why: '170 Hz shift at 45.45 Bd — the amateur standard',
    score: (f) =>
      0.35 * near(f.toneSpacingHz, 170, 70) +
      0.50 * nearRel(f.baud, 45.45, 0.12) +
      0.15 * (f.continuous !== false ? 1 : 0),
  },
  {
    key: 'fsk', variant: 'weather',
    label: 'Weather RTTY (50 Bd, 450 Hz)',
    why: '450 Hz shift at 50 Bd — the DWD Pinneberg outlets',
    score: (f) =>
      0.40 * near(f.toneSpacingHz, 450, 160) +
      0.45 * nearRel(f.baud, 50, 0.10) +
      0.15 * (f.continuous !== false ? 1 : 0),
  },
  {
    key: 'fsk', variant: 'psk31',
    label: 'PSK31 (BPSK)',
    why: 'a single ~60 Hz carrier with a 31.25 Bd envelope and no tone pair',
    score: (f) => {
      // A tone PAIR is not BPSK — but a pair needs TWO tones, and this was
      // vetoing on a spacing reported next to a tone count of one.  A single
      // BPSK carrier picks up a spurious 21-23 Hz "spacing" about a quarter of
      // the time even at full strength, and that silently threw the mode away:
      // measured at 30/40 before this line was qualified, 40/40 after.
      if (f.toneCount >= 2 && f.toneSpacingHz !== 0) return 0;
      // PSK31 is a conversational mode, never slotted to the UTC clock.  This
      // one line is what stops an FT8 or FT4 carrier — the same width, tones
      // too close to resolve — from scoring as PSK31 by elimination.
      if (f.gridSec) return 0;
      const bw = within(f.bwHz, 30, 90);
      if (bw <= 0) return 0;
      // The envelope periodicity is the positive evidence.  Without it this is
      // only "a narrow signal with no tone pair", which is far too many things.
      //
      // Deliberately a WINDOW around 31.25 Bd rather than a tight match: the
      // autocorrelation peak of a real raised-cosine PSK31 envelope is a broad
      // hump, and its position moves with the data. What is being claimed here
      // is "an envelope periodicity in the PSK31 region", which is honest —
      // not a precise measurement of the symbol rate.
      const env = Math.max(within(f.envRate, 22, 42),
                           nearRel(f.baud, 31.25, 0.2));
      if (env <= 0) return 0.35 * bw;
      return 0.45 * env + 0.35 * bw + 0.20 * (f.toneCount <= 2 ? 1 : 0);
    },
  },
  // The three modes below are defined by broad properties rather than a sharp
  // number, so their scores are PRODUCTS of gates, not weighted sums.  Summed,
  // they became catch-alls: on a noisy signal each collected enough partial
  // credit from vague terms to beat the mode that was actually there, which is
  // the worst failure this tool can have — a confident wrong answer.
  {
    key: 'fsk', variant: 'olivia',
    label: 'Olivia (MFSK)',
    why: 'an evenly spaced comb of many tones at a low symbol rate',
    score: (f) => {
      if (!(f.toneCount >= 4)) return 0;
      // Real Olivia tone spacings are bandwidth/tones: 31.25 or 62.5 Hz.
      if (!(f.toneSpacingHz >= 15 && f.toneSpacingHz <= 120)) return 0;
      // Not slotted to the UTC clock.  FT4's 20.83 Hz spacing falls inside the
      // comb window above, so without this an FT4 signal whose grid was missed
      // could be offered as Olivia.
      if (f.gridSec) return 0;
      // The symbol rate stays a GATE here, unlike everywhere else in this file
      // where a collapsing measurement was loosened into a weighted term.  It
      // was tried that way — scoring the comb alone at reduced confidence when
      // the rate could not be had — and it cost more than it bought: noise
      // shreds a weak NAVTEX pair into what reads as a six-tone comb, and a
      // faded weather fax fills its band with enough tones to look like one
      // too, so both were named Olivia outright.  An even comb is simply not
      // distinctive enough on its own to name a mode, and a silent miss is the
      // better failure.  Olivia therefore goes quiet below about 30 dB S/N.
      if (!(f.baud > 0 && f.baud < 40)) return 0;
      return 0.55 + 0.25 * within(f.bwHz, 200, 1100) +
             0.20 * Math.min(1, f.toneCount / 8);
    },
  },
  {
    key: 'hffax', variant: null,
    label: 'HF FAX / WEFAX',
    why: 'an ~800 Hz picture band held for minutes, with no 1200 Hz line sync',
    score: (f) => {
      // Constant envelope.  FM carrying a picture is never keyed and never
      // stops between lines, which is what separates it from everything that
      // switches on and off inside the same band.
      if (f.dutyOn < 0.75) return 0;
      const b = pictureBand(f);
      if (!(b.span >= 500 && b.span <= 1400)) return 0;
      // It sits above where an SSTV sync tone would be: 1500 Hz black to
      // 2300 Hz white, with 1200 Hz empty below.
      if (b.lo < PICTURE_LO_HZ) return 0;
      // 4 dB, the same figure at which SSTV starts crediting its line sync.
      // At 6 there was a dead band: a weak picture whose sync had washed down
      // to 5 dB was claimed by BOTH, and fax won the tie on an equal score.
      if (f.syncDb >= 4) return 0;             // that would be SSTV
      // An 850 Hz shift RTTY pair has the same span as a fax and lives in the
      // same part of the passband, so it has to be ruled out — but not on the
      // symbol rate alone.  A picture IS periodic: pixels arrive at 1809 a
      // second and a chart's black runs are only a few pixels long, so a real
      // fax can easily produce a modal run length in the teleprinter range and
      // veto itself.  What actually separates the two is the tone structure,
      // not the timing: a teleprinter is a clean PAIR of tones, while a picture
      // fills its band with every grey level in the image.
      //
      // The symbol rate is deliberately NOT part of this test.  It is the
      // cleanest separator when it can be had — 50 Bd against 1809 pixels a
      // second — but it is the first measurement to collapse in noise, and a
      // weak 850 Hz teleprinter with baud=0 was being called a weather chart
      // at full confidence.  The tone pair survives that noise; the baud does
      // not.  The cost is a chart of pure black and white, with no greys and
      // both levels equally used, which would measure as a 800 Hz pair and be
      // refused; real charts carry enough grey and enough white to avoid it.
      // Measured across every fax variant here — swept, black-and-white chart,
      // coarse chart, at four signal levels — the widest consistent spacing a
      // picture ever produced was 413 Hz, so 600 leaves room and still catches
      // the teleprinter pair however many tones the noise adds around it.
      if (f.toneSpacingHz >= 600) return 0;
      // A broadcast runs for many minutes, so either continuous or a long
      // burst — over a four-minute window a single deep fade is enough to
      // break `continuous` on its own, and insisting on it lost real fax.
      if (f.continuous === false &&
          !(Math.max(f.burstSec || 0, f.runSec || 0) >= 10)) return 0;
      return 0.40 + 0.25 * within(b.span, 500, 1400) +
             0.20 * within(b.mid, 1700, 2100) +
             0.15 * Math.min(1, f.flatness / 0.25);
    },
  },
  {
    key: 'sstv', variant: null,
    label: 'SSTV',
    why: 'a filled 1500-2300 Hz band with a 1200 Hz line-sync tone',
    score: (f) => {
      // The tone-pair gate is narrowed to what it was really there for: weather
      // RTTY at a 1000 Hz centre with a 450 Hz shift puts its upper tone on
      // 1225 Hz, one bin from the sync slot, and read as a huge sync line.
      // That is a TWO-tone signal.  A real picture's spectrum is lumpy — large
      // flat areas of an image concentrate energy at one grey level — so
      // demanding no tone structure at all was rejecting genuine SSTV.
      if (f.toneSpacingHz !== 0 && f.toneCount <= 3) return 0;
      // An SSTV transmission runs a minute or two and then stops, so it is far
      // more often seen as a long burst than as continuous.  Insisting on
      // `continuous` was the single biggest reason real pictures were missed.
      if (f.continuous === false &&
          !(Math.max(f.burstSec || 0, f.runSec || 0) >= 15)) return 0;
      // A picture band is wide, and it sits ABOVE its own sync tone — 1500 Hz
      // black to 2300 Hz white, with the 1200 Hz sync in the gap below.  Both
      // facts are load-bearing: a 450 Hz weather-RTTY pair centred on 1000 Hz
      // is neither wide enough nor high enough, which is what stops its upper
      // tone at 1225 Hz being read as a sync line once the noise has smeared
      // the pair into something that no longer measures as two tones.
      const b = pictureBand(f);
      if (!(b.span >= 600)) return 0;
      if (b.lo < PICTURE_LO_HZ) return 0;
      const bw = within(b.span, 500, 1400);
      if (bw <= 0) return 0;
      // The line sync is graded rather than a cliff at 6 dB: it is on for only
      // about 2% of each line, so on a busy band it clears its neighbourhood by
      // very little even when it is plainly there.
      const sync = within(f.syncDb, 4, 60);
      if (sync <= 0) return 0;
      return 0.30 + 0.25 * sync + 0.25 * bw +
             0.20 * within(b.mid, 1500, 2100);
    },
  },
  {
    key: 'cw', variant: null,
    label: 'CW (Morse)',
    why: 'one keyed tone, under ~200 Hz wide',
    score: (f) => {
      // A tone PAIR is not Morse — but a pair needs TWO tones, and this was
      // vetoing on a spacing reported next to a tone count of one.  A single
      // BPSK carrier picks up a spurious 21-23 Hz "spacing" about a quarter of
      // the time even at full strength, and that silently threw the mode away:
      // measured at 30/40 before this line was qualified, 40/40 after.
      //
      // And only tones that are really there: in the key-up gaps of a weak
      // Morse signal the noise leaves a few phantom modes ~30 Hz apart in the
      // IF histogram, which vetoed real CW at −5 dB.  Phantoms spread far
      // beyond the measured width (97 Hz of "tones" on a 26 Hz carrier); a
      // real MFSK signal such as DominoEX keeps its tones inside it.
      if (f.toneCount >= 2 && f.toneSpacingHz !== 0 &&
          (f.toneSpacingHz >= 50 || (f.toneCount - 1) * f.toneSpacingHz <= 1.2 * f.bwHz)) return 0;
      // One tone means one LEVEL.  Speech is keyed too — syllables switch on
      // and off at Morse-like rates — and a strong vowel harmonic can measure
      // under 200 Hz wide, so SSB voice was named CW at up to 100 %.  But its
      // energy sits at many levels across the band (470–1300 Hz measured on
      // real voices), where a Morse tone measures 0–50 Hz.
      if (f.levelSpanHz > 300) return 0;
      const bw = within(f.bwHz, 5, 200);
      if (bw <= 0) return 0;
      // Actually keyed: elements at a plausible speed and a duty cycle that is
      // not simply "always on".
      const keyed = f.keyRate > 3 && f.keyRate < 60 && f.dutyOn < 0.9;
      return keyed ? 0.55 + 0.45 * bw : 0.30 * bw;
    },
  },
];

/** Run every scorer and return them ranked. */
export function scoreAll(features) {
  const out = [];
  for (const m of MODES) {
    let s = 0;
    try { s = m.score(features) || 0; } catch (_) { s = 0; }
    out.push({
      key: m.key, variant: m.variant, label: m.label, why: m.why,
      score: Math.max(0, Math.min(1, s)),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export default ModeIdentifier;
