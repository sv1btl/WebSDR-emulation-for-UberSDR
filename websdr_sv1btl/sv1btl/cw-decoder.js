// cw-decoder.js — browser-side CW / Morse decoder for the SV1BTL WebSDR page.
// Ported from PhantomSDR-Plus (github.com/sv1btl/PhantomSDR-Plus, frontend/src/
// cwDecoder.js + lib/fftRadix2.js transformFlat + cw.worker.js), ES-module syntax
// removed so it loads as a plain script. It works two ways:
//   - as a Web Worker (new Worker('sv1btl/cw-decoder.js')): messages as in
//     cw.worker.js — {t:'init'|'sampleRate'|'reset', sampleRate}, {t:'pcm', pcm,
//     sampleRate}, {t:'destroy'}; it posts the decoder's events back;
//   - in the page (fallback): window.CWDecoder.
// Licence: GNU GPL v3, as PhantomSDR-Plus (the rest of this package is MIT, see LICENSE).
// Events: {type:'char',char} {type:'word'} {type:'freq',hz,wpm} {type:'silence'}
(function (root) {
'use strict';

// ── lib/fftRadix2.js (transformFlat only) ────────────────────────────────────
const _plans = new Map();

function _plan(n) {
  let p = _plans.get(n);
  if (p) return p;

  // Bit-reversal permutation.
  let bits = 0;
  while ((1 << bits) < n) bits++;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r >>> 0;
  }

  // Twiddle table for the FORWARD transform: W_n^k = exp(-2πi k / n).
  // The inverse reuses the same table with the imaginary part negated.
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    const a = (-2 * Math.PI * k) / n;
    cos[k] = Math.cos(a);
    sin[k] = Math.sin(a);
  }

  p = { rev, cos, sin, re: new Float64Array(n), im: new Float64Array(n) };
  _plans.set(n, p);
  return p;
}

function transformFlat(re, im, inverse) {
  const n = re.length;
  if (n === 0) return;
  if ((n & (n - 1)) !== 0) {
    throw new Error('FFT size must be a power of two, got ' + n);
  }
  const p = _plan(n);
  const rev = p.rev;
  const cos = p.cos;
  const sin = p.sin;
  const half = n >> 1;

  // In-place bit-reversal permutation (rev is an involution, so swapping each
  // i with rev[i] once — guarded by r > i — reproduces the reordered load that
  // _transform() does when it copies input[rev[i]] into slot i).
  for (let i = 0; i < n; i++) {
    const r = rev[i];
    if (r > i) {
      const tr = re[i]; re[i] = re[r]; re[r] = tr;
      const ti = im[i]; im[i] = im[r]; im[r] = ti;
    }
  }

  // Identical butterflies to _transform().
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const step = half / halfLen;
    for (let i = 0; i < n; i += len) {
      for (let j = 0, k = 0; j < halfLen; j++, k += step) {
        const wr = cos[k];
        const wi = inverse ? -sin[k] : sin[k];
        const a = i + j;
        const b = a + halfLen;
        const xr = re[b];
        const xi = im[b];
        const tr = wr * xr - wi * xi;
        const ti = wr * xi + wi * xr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }

  if (inverse) {
    const invN = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= invN;
      im[i] *= invN;
    }
  }
}

// ── cwDecoder.js ─────────────────────────────────────────────────────────────
// Signal gate on the estimator's on/off envelope ratio (see _estimateSpeed).
const SIG_OPEN  = 2.2;
const SIG_CLOSE = 1.7;

// QSB-tracking slicer (see _decodeFrame). Tuned 2026-10-24 on a fixed-seed
// bench of AWGN, sine QSB and Rayleigh fading: QSB fading to -10 dB went
// from 41 % to 11 % CER, Rayleigh fading at +6 dB from 32 % to 18 %, with
// steady signals, Farnsworth and 40 wpm unchanged.
const PK_DROP   = 0.4;   // the signal-level peak falls to 40 % ...
const PK_DOTS   = 7;     // ... over 7 dots (a word gap) without a mark
const NOISE_PCT = 0.3;   // noise level = 30th percentile of the matched filter
const FLOOR_R   = 2.2;   // signal level never below 2.2 × noise (the gate ratio)
const FLOOR_SPAN = 0.3;  // ... nor below 30 % of the estimator's on/off span
const IDLE_DOTS = 12;    // no mark for 12 dots (a pause, not a word gap) …
const IDLE_SPAN = 0.8;   // … and the level floor rises to 80 % of the span
const SLICE_HI  = 0.55;  // key-down above noise + 55 % of the span ...
const SLICE_LO  = 0.35;  // ... key-up below noise + 35 %

// ── Morse table (code → character) ──────────────────────────────────────────
const MORSE = {
  '.-':'A',   '-...':'B', '-.-.':'C', '-..':'D',  '.':'E',
  '..-.':'F', '--.':'G',  '....':'H', '..':'I',   '.---':'J',
  '-.-':'K',  '.-..':'L', '--':'M',   '-.':'N',   '---':'O',
  '.--.':'P', '--.-':'Q', '.-.':'R',  '...':'S',  '-':'T',
  '..-':'U',  '...-':'V', '.--':'W',  '-..-':'X', '-.--':'Y',
  '--..':'Z',
  '-----':'0','.----':'1','..---':'2','...--':'3','....-':'4',
  '.....':'5','-....':'6','--...':'7','---..':'8','----.':'9',
  '.-.-.-':'.','--..--':',','..--..':'?','-..-.':'/',
  '-.-.--':'!','.--.-.':'@','-....-':'-','...-..-':'$','-...-':'='
};

// Relative English letter frequencies (%) — a gentle MAP prior that only breaks
// ties between codewords that fit the timing about equally well.
const LETTER_FREQ = {
  E:12.7, T:9.06, A:8.17, O:7.51, I:6.97, N:6.75, S:6.33, H:6.09, R:5.99,
  D:4.25, L:4.03, C:2.78, U:2.76, M:2.41, W:2.36, F:2.22, G:2.02, Y:1.97,
  P:1.93, B:1.29, V:0.98, K:0.77, J:0.15, X:0.15, Q:0.10, Z:0.07
};

// Per element-count, the candidate codewords with dit/dah bits and a log-prior.
const DECODE_BY_LEN = (() => {
  const byLen = {};
  for (const code in MORSE) {
    const ch = MORSE[code];
    const bits = new Uint8Array(code.length);
    for (let i = 0; i < code.length; i++) bits[i] = code[i] === '-' ? 1 : 0;
    const freq = LETTER_FREQ[ch] != null ? LETTER_FREQ[ch] : 0.05;
    (byLen[code.length] || (byLen[code.length] = [])).push(
      { bits, char: ch, logPrior: Math.log(freq) });
  }
  return byLen;
})();

// Codewords as element lists (1 = dot, 3 = dash) for the soft decoder.
const SOFT_CODES = Object.keys(MORSE).map((code) => {
  const ch = MORSE[code];
  const freq = LETTER_FREQ[ch] != null ? LETTER_FREQ[ch] : 0.05;
  return { char: ch, els: [...code].map((c) => (c === '-' ? 3 : 1)), logPrior: Math.log(freq) };
});
// Soft-decoder settings, tuned 2026-10-24 on perfectly timed AND ±15/25 %
// jittered synthetic Morse (tighter timing priors look better only on perfect
// timing). Letter errors vs the slicer-length MAP: −8 dB 72 -> 39, −10 dB
// 225 -> 177, ±25 % jitter at 0 dB 337 -> 211 (of 1056).
const SOFT_PRIOR_W = 0.5;    // weight of the letter-frequency prior
const SOFT_SIG_MK  = 0.25;   // log-normal spread of a mark's length
const SOFT_SIG_GP  = 0.3;    // ... of a gap inside a letter
const SOFT_LLR_W   = 0.3;    // quarter-dot steps are correlated (input filter)
const SOFT_GAP_MIN = 0.7;    // shortest gap inside a letter, in dots
const SOFT_MK_MIN  = 0.6;    // shortest mark, as a share of its nominal length

class CWDecoder {
  constructor({ sampleRate = 12000, callback = null } = {}) {
    this.sr = sampleRate || 12000;
    this.callback = callback || null;
    this.reset();
  }

  setCallback(cb) { this.callback = cb || null; }

  setSampleRate(sr) {
    sr = sr || 12000;
    if (sr !== this.sr) { this.sr = sr; this._configure(); this.reset(); }
  }

  reset() {
    this._configure();

    // Tone acquisition
    this.toneHz = 700; this.toneValid = false; this.jumpHz = -1;
    this.specAvg = null; this.specFrames = 0;
    this.fftBuf = new Float32Array(this.FFT_N); this.fftFill = 0;
    // Raw audio from just before the tone lock, replayed once it locks.
    this.preBuf = new Float32Array(this.PRE_N); this.prePos = 0; this.preFill = 0;
    this._prerollPending = false;

    // NCO + I/Q low-pass
    this.oscC = 1; this.oscS = 0; this.oscNorm = 0;
    this.lpI1 = 0; this.lpI2 = 0; this.lpQ1 = 0; this.lpQ2 = 0;

    // Decimation
    this.hopCount = 0; this.magAccum = 0;

    // Envelope ring buffer
    this.envBuf = new Float64Array(this.BUF);
    this.lvlBuf = new Float64Array(this.BUF);   // the slicer's signal level per frame (soft decoder)
    this.envPos = 0; this.envCount = 0;
    this.frameNo = 0;            // absolute frame counter
    this.decodePos = 0;          // next absolute frame index to decode

    // Speed / threshold estimation
    this.Td = 0;                 // dot period in frames (0 = unknown)
    this.sepEma = null;          // averaged separability-vs-period landscape
    this.mfWin = 8;              // matched-filter boxcar width (frames)
    this.onLvl = 0; this.offLvl = 0;
    // QSB-tracking slicer levels: noise from the estimator window, signal
    // from a decaying peak of the matched filter (see _decodeFrame).
    this.noiseLvl = 0; this.pk = 0; this.pkDecay = 1; this.idleFrames = 0;
    this.framesSinceEst = 0;

    // Keying state
    this.keyOn = false;
    this.markFrames = 0; this.spaceFrames = 0;

    // Character assembly
    this.curElems = [];
    this.charFlushed = true;
    this.wordEmitted = true;
    this.silent = false;
    this.gapHist = [];           // recent character/word gaps (frames), for _wordThresh
    this.charStartP = -1; this.charEndP = -1; this.prevCharEndP = -1; this.curP = 0;
    this.lvlFrom = Infinity;     // first frame with a slicer level in lvlBuf
    this.sigOpen = false;        // signal gate — see _estimateSpeed
    this.gateClosedAt = 0;       // frame the gate last closed at
    this.everOpen = false;       // the gate has opened since the tone locked
    this.openCand = 0;           // dot of the last estimate that would open the gate
    this._rewindTo = -1;         // re-decode from here when the gate reopens
    this._wordThrCache = 0;
  }

  _configure() {
    const sr = this.sr;
    this.FFT_N   = 2048;                                 // ~0.17 s @ 12 kHz
    this.PRE_N   = Math.max(7 * this.FFT_N, Math.round(sr * 1.2)); // tone-lock pre-roll
    this.hop     = Math.max(1, Math.round(sr * 0.002));  // ~2 ms frames
    this.frameMs = (this.hop / sr) * 1000;
    this._setToneCoeffs(this.toneHz || 700);
    this.lpA = 1 - Math.exp(-2 * Math.PI * 50 / sr);     // ~50 Hz per-arm LP

    // Frame-domain constants
    this.BUF        = Math.round(12000 / this.frameMs);  // 12 s ring
    this.EST_WIN    = Math.round(6000  / this.frameMs);  // 6 s estimation window
    this.EST_MIN    = Math.round(1400  / this.frameMs);  // min before 1st estimate
    this.EST_PERIOD = Math.round(700   / this.frameMs);  // re-estimate cadence
    this.TD_MIN     = Math.max(6, Math.round(18  / this.frameMs)); // ~67 wpm
    this.TD_MAX     = Math.round(260 / this.frameMs);              // ~4.6 wpm
    this.silenceFrames = Math.round(2000 / this.frameMs);
  }

  _setToneCoeffs(hz) {
    const dphi = 2 * Math.PI * hz / this.sr;
    this.oscStepC = Math.cos(dphi);
    this.oscStepS = Math.sin(dphi);
    this.oscFreq  = hz;
  }

  // ── Main entry ──────────────────────────────────────────────────────────
  feed(pcm) {
    for (let n = 0; n < pcm.length; n++) {
      const x = pcm[n];

      // Raw audio ring, for the replay after the tone locks.
      this.preBuf[this.prePos] = x;
      this.prePos = (this.prePos + 1) % this.PRE_N;
      if (this.preFill < this.PRE_N) this.preFill++;

      // (1) Tone acquisition buffer.
      this.fftBuf[this.fftFill++] = x;
      if (this.fftFill >= this.FFT_N) { this._detectTone(); this.fftFill = 0; }
      if (Math.abs(this.toneHz - this.oscFreq) > 1.5) this._setToneCoeffs(this.toneHz);

      // The tone has just locked: everything before it was mixed with the
      // wrong tone and is discarded, which cost the first element or two of
      // a cold start (P read as G, Q as K). Run the last ~1.2 s of raw audio,
      // this sample included, through the locked downconverter instead.
      if (this._prerollPending) {
        this._prerollPending = false;
        this.lpI1 = this.lpI2 = this.lpQ1 = this.lpQ2 = 0;
        this.hopCount = 0; this.magAccum = 0;
        const N = this.preFill, P = this.PRE_N;
        let i = (this.prePos - N + P) % P;
        for (let k = 0; k < N; k++) { this._baseband(this.preBuf[i]); i = (i + 1) % P; }
        continue;
      }
      this._baseband(x);
    }
  }

  // (2)+(3) of the pipeline for one sample: complex downconvert, I/Q
  // low-pass, envelope, decimation to ~2 ms frames.
  _baseband(x) {
    // Complex downconvert by e^{-jωn} via incremental rotator.
    const c = this.oscC, s = this.oscS;
    const iIn = x * c, qIn = -x * s;
    this.oscC = c * this.oscStepC - s * this.oscStepS;
    this.oscS = s * this.oscStepC + c * this.oscStepS;
    if (++this.oscNorm >= 1024) {
      const g = 1 / Math.hypot(this.oscC, this.oscS);
      this.oscC *= g; this.oscS *= g; this.oscNorm = 0;
    }

    // I/Q low-pass (2-pole each) → envelope magnitude.
    const a = this.lpA;
    this.lpI1 += a * (iIn - this.lpI1); this.lpI2 += a * (this.lpI1 - this.lpI2);
    this.lpQ1 += a * (qIn - this.lpQ1); this.lpQ2 += a * (this.lpQ1 - this.lpQ2);
    this.magAccum += Math.hypot(this.lpI2, this.lpQ2);

    // Decimate to a ~2 ms envelope frame.
    if (++this.hopCount >= this.hop) {
      const e = this.magAccum / this.hop;
      this.magAccum = 0; this.hopCount = 0;
      this._processFrame(e);
    }
  }

  // ── Tone detection (time-averaged spectrum) ───────────────────────────────
  _detectTone() {
    const N = this.FFT_N, sr = this.sr;
    const re = new Float64Array(N), im = new Float64Array(N);
    const buf = this.fftBuf;
    for (let i = 0; i < N; i++) {
      const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
      re[i] = buf[i] * w;
    }
    try { transformFlat(re, im, false); } catch (e) { return; }

    const half = N >> 1;
    if (!this.specAvg) this.specAvg = new Float64Array(half + 1);
    const beta = this.specFrames < 4 ? 0.5 : 0.25;
    for (let b = 1; b <= half; b++) {
      const p = re[b] * re[b] + im[b] * im[b];
      this.specAvg[b] = this.specAvg[b] * (1 - beta) + p * beta;
    }
    this.specFrames++;

    const res = sr / N;
    const bLo = Math.max(1, Math.floor(200 / res));
    const bHi = Math.min(half, Math.ceil(2500 / res));
    const spec = this.specAvg;
    let maxP = 0, maxB = bLo;
    for (let b = bLo; b <= bHi; b++) if (spec[b] > maxP) { maxP = spec[b]; maxB = b; }

    let sum = 0, cnt = 0;
    for (let b = Math.max(bLo, maxB - 20); b <= Math.min(bHi, maxB + 20); b++) {
      if (b === maxB) continue;
      sum += spec[b]; cnt++;
    }
    const meanNb = cnt ? sum / cnt : maxP;
    if (maxP <= 1e-12 || meanNb <= 0 || maxP < meanNb * 4.0) return;

    let delta = 0;
    if (maxB > bLo && maxB < bHi) {
      const yL = spec[maxB - 1], yC = spec[maxB], yR = spec[maxB + 1];
      const den = 2 * (2 * yC - yL - yR);
      if (den > 0) delta = (yL - yR) / den;
    }
    const hz = (maxB + delta) * res;
    if (hz > 150 && hz < 3000) {
      if (!this.toneValid) {
        if (this.specFrames < 2) { this._emitFreq(); return; }
        this.toneHz = hz; this.toneValid = true;
        this._resetTiming();   // discard pre-lock garbage …
        this._prerollPending = true;   // … and replay the raw audio instead (feed)
      } else if (!this.sigOpen && Math.abs(hz - this.toneHz) > 20) {
        // A jump while nothing is being read: the first lock was on noise or
        // on a station that has gone (it locked at 265 Hz on noise just
        // before a 700 Hz signal began, and the first element or two were
        // mixed with the wrong tone). Start over on the new tone, with the
        // pre-roll — but only once the new peak has held for two spectrum
        // frames: on a weak signal the peak hops to noise and back, and
        // restarting on every hop kept it from ever locking (nothing at all
        // was printed at −11 dB). A one-frame outlier is ignored.
        if (Math.abs(hz - this.jumpHz) < 6) {
          this.toneHz = hz;
          this.jumpHz = -1;
          this._resetTiming();
          this._prerollPending = true;
        } else {
          this.jumpHz = hz;
        }
        this._emitFreq();
        return;
      } else {
        this.jumpHz = -1;
        this.toneHz = hz;      // averaged spectrum is stable; follow directly
      }
      this._emitFreq();
    }
  }

  _resetTiming() {
    this.envPos = 0; this.envCount = 0;
    this.frameNo = 0; this.decodePos = 0;
    this.Td = 0; this.sepEma = null; this.framesSinceEst = 0;
    this.noiseLvl = 0; this.pk = 0; this.pkDecay = 1;
    this.keyOn = false; this.markFrames = 0; this.spaceFrames = 0;
    this.curElems = []; this.charFlushed = true; this.wordEmitted = true;
    this.silent = false; this.gapHist = []; this._wordThrCache = 0; this.sigOpen = false;
    this.gateClosedAt = 0; this._rewindTo = -1; this.everOpen = false; this.openCand = 0;
    this.lvlFrom = Infinity; this.charStartP = -1; this.charEndP = -1; this.prevCharEndP = -1;
  }

  _emitFreq() {
    if (!this.callback || !this.sigOpen) return;
    const wpm = this.Td > 0 ? Math.round(1200 / (this.Td * this.frameMs)) : 0;
    this.callback({ type: 'freq', hz: Math.round(this.toneHz), wpm });
  }

  // ── Per-frame processing ──────────────────────────────────────────────────
  _processFrame(e) {
    if (!this.toneValid) return;

    // Buffer the raw envelope.
    this.envBuf[this.envPos] = e;
    this.envPos = (this.envPos + 1) % this.BUF;
    if (this.envCount < this.BUF) this.envCount++;
    this.frameNo++;

    // Periodic speed / threshold estimation.
    const hadTd = this.Td;
    if (++this.framesSinceEst >= this.EST_PERIOD || (this.Td === 0 && this.envCount >= this.EST_MIN)) {
      if (this.envCount >= this.EST_MIN) { this._estimateSpeed(); this.framesSinceEst = 0; }
    }
    if (this.Td === 0) { this.decodePos = this.frameNo; return; }  // keep pointer at "now"

    // #3 look-back: on the FIRST speed lock, rewind the decode pointer to the
    // oldest buffered frame and replay everything captured during acquisition,
    // recovering the first word/character otherwise lost to the ~1.5 s lock
    // latency. Td/levels from the lock are applied to those buffered frames.
    if (hadTd === 0) {
      this.decodePos = this._findOnset(this.frameNo - this.envCount);
      this._restartKeying();
    }
    else if (this._rewindTo >= 0) {
      // The gate has just reopened (see _estimateSpeed): decode again, with
      // the new estimate, the start of the new transmission — it was decoded
      // while the gate was shut and never shown.
      this.decodePos = this._findOnset(Math.max(this._rewindTo, this.frameNo - this.envCount));
      this._restartKeying();
    }
    this._rewindTo = -1;

    // Decode all frames up to the current one (normally just the newest; a whole
    // buffer's worth on the first-lock replay).
    while (this.decodePos < this.frameNo) { this._decodeFrame(this.decodePos); this.decodePos++; }
  }

  // Where the transmission that is on now began, searching back no further
  // than frame `from`. A replay from the start of the buffer decoded the
  // noise before the signal with the signal's levels and printed junk ahead
  // of the first word ("I PEIEEE S ES MT CQ …" at −8 dB). Looking back from
  // now, the signal ends at the last stretch of ONSET_GAP dots or more whose
  // 8-dot envelope mean sits near the noise; word gaps, even Farnsworth ones,
  // are far shorter.
  _findOnset(from) {
    const T = this.Td, now = this.frameNo;
    const bufStart = now - this.envCount;
    if (from < bufStart) from = bufStart;
    const n = now - from;
    const W = Math.max(4, Math.round(8 * T)), GAP = Math.round(20 * T);
    if (n < W + GAP) return from;
    const cum = new Float64Array(n + 1);
    const BUF = this.BUF;
    for (let k = 0; k < n; k++) {
      const idx = ((this.envPos - (now - (from + k))) % BUF + BUF) % BUF;
      cum[k + 1] = cum[k] + this.envBuf[idx];
    }
    const off = this.noiseLvl > 0 ? this.noiseLvl : this.offLvl;
    const thr = off + 0.15 * (this.onLvl - off);
    let low = 0;
    for (let k = n - W; k >= 0; k--) {
      const m = (cum[k + W] - cum[k]) / W;
      if (m < thr) { if (++low >= GAP) return from + k + low - Math.round(2 * T); }
      else low = 0;
    }
    return from;
  }

  // Fresh keying/character state for a re-decode; timing and levels stay.
  _restartKeying() {
    this.lvlFrom = this.decodePos;
    this.keyOn = false; this.markFrames = 0; this.spaceFrames = 0;
    this.curElems = []; this.charFlushed = true; this.wordEmitted = true;
    this.silent = false; this.pk = this.onLvl;
    this.idleFrames = Infinity;   // nothing came before: start with the idle floor
    // Gaps learned from the earlier, gate-shut decode of this stretch are
    // noise; keeping them set the word threshold so the first space went
    // missing ("VK3ABCDE SV1BTL").
    this.gapHist = []; this._wordThrCache = 0; this.afterRestart = true;
  }

  // Slice + edge-detect one buffered frame (absolute index p) through the
  // matched filter → keying state. Used for both live decoding and replay.
  _decodeFrame(p) {
    this.curP = p;
    const sm = this._boxcarAt(p, this.mfWin);

    // QSB-tracking slice levels. The old followers learned the on-level only
    // from marks and the off-level only from spaces, so in a fade the marks
    // fell under the threshold, were counted as spaces and raised the
    // off-level: the threshold climbed while the signal sank, and nothing was
    // read until the signal came back strongly. Now the signal level is a
    // peak of the matched filter that jumps up on any mark and decays by
    // itself (to 40 % over 7 dots), so it follows a fade down without needing
    // marks to be found first, never above the estimator's on-level (a peak
    // is biased up by noise, which mattered for weak signals) and never below
    // 2.2 × noise nor 30 % of the estimator's span, so the long gaps of
    // Farnsworth or a pause cannot open the slicer to noise. The noise
    // level is a low percentile from the estimator window, which hidden marks
    // cannot raise; noise does not fade with the signal.
    const off = this.noiseLvl > 0 ? this.noiseLvl : this.offLvl;
    if (this.keyOn) this.idleFrames = 0; else this.idleFrames++;
    const idle = this.idleFrames > IDLE_DOTS * this.Td;
    const floor = Math.max(off * FLOOR_R, off + (idle ? IDLE_SPAN : FLOOR_SPAN) * (this.onLvl - off));
    let pk = Math.max(sm, this.pk * this.pkDecay);
    if (pk < floor) pk = floor;
    this.pk = pk;
    const span = Math.max(Math.min(pk, this.onLvl), floor) - off;
    this.lvlBuf[((p % this.BUF) + this.BUF) % this.BUF] = off + span;
    const HIGH = off + SLICE_HI * span;
    const LOW  = off + SLICE_LO * span;
    let on = this.keyOn;
    if (!this.keyOn && sm > HIGH) on = true;
    else if (this.keyOn && sm < LOW) on = false;

    if (on !== this.keyOn) {
      if (on) this._risingEdge(); else this._fallingEdge();
      this.keyOn = on;
    }

    if (this.keyOn) { this.markFrames++; }
    else { this.spaceFrames++; this._handleGaps(); }

  }

  // Trailing matched-filter boxcar of `win` frames ending at absolute frame
  // index p (mean of the envelope). Reads the ring by absolute index so it works
  // for replayed frames, not just the newest.
  _boxcarAt(p, win) {
    const BUF = this.BUF, bufStart = this.frameNo - this.envCount;
    const start = Math.max(bufStart, p - win + 1);
    let sum = 0, cnt = 0;
    for (let a = start; a <= p; a++) {
      const idx = ((this.envPos - (this.frameNo - a)) % BUF + BUF) % BUF;
      sum += this.envBuf[idx]; cnt++;
    }
    return cnt > 0 ? sum / cnt : 0;
  }

  _risingEdge() {
    // A mark begins. Remember the gap that just ended (character and word gaps
    // only) so the word threshold can find this operator's two gap widths —
    // see _wordThresh().
    const gap = this.spaceFrames, T = this.Td;
    // Not the gap before the first mark after a silence or a restart: that is
    // a pause, and learned as a word gap it pushed the threshold over the
    // real word gaps (one 23·T "gap" among 2.8·T ones split them at 8·T).
    if (T > 0 && gap > T * 1.5 && gap < T * 25 && !this.silent && !this.afterRestart) {
      this.gapHist.push(gap);
      if (this.gapHist.length > 40) this.gapHist.shift();
      this._wordThrCache = 0;
    }
    this.afterRestart = false;
    if (this.curElems.length === 0 && this.charStartP < 0) this.charStartP = this.curP;
    this.spaceFrames = 0;
    this.markFrames = 0;
    this.charFlushed = false;
    this.wordEmitted = false;
    this.silent = false;
  }

  // Word-gap threshold, from this operator's own spacing. The recent gaps
  // (character and word gaps) fall into two groups; the threshold sits between
  // them, wherever they are. That covers standard 3:7 spacing and any
  // Farnsworth stretch alike. The old rule learned the character gap only from
  // gaps already below a 6·T threshold, so at ×2.5 Farnsworth (7.5·T character
  // gaps) it never learned, and every letter came out as a word of its own.
  _wordThresh() {
    const T = this.Td;
    if (this._wordThrCache && this._wordThrT === T) return this._wordThrCache;
    const g = this.gapHist;
    // Until it has learned (6 gaps), 4.5·T: the matched filter shortens a
    // measured gap by most of a dot, so a 7·T word gap reads ~6.3·T and 6·T
    // dropped the first spaces after a replay; letter gaps read ~2.3·T.
    let thr = T * 4.5;
    if (g.length >= 6) {
      const v = g.map(Math.log).sort((a, b) => a - b), n = v.length;
      const tot = v.reduce((a, b) => a + b, 0);
      let best = -1, bi = 0, lo = 0;
      for (let i = 1; i < n; i++) {           // Otsu split in the log domain
        lo += v[i - 1];
        const m0 = lo / i, m1 = (tot - lo) / (n - i);
        const sb = i * (n - i) * (m1 - m0) * (m1 - m0);
        if (sb > best) { best = sb; bi = i; }
      }
      let s0 = 0; for (let i = 0; i < bi; i++) s0 += v[i];
      const m0 = s0 / bi, m1 = (tot - s0) / (n - bi);
      if (m1 - m0 > Math.log(1.6)) {
        thr = Math.exp((m0 + m1) / 2);        // two groups: split between them
      } else {
        // One group so far. Characters outnumber words, so it is the character
        // gap: a word gap is clearly longer than that.
        thr = Math.max(T * 6, 1.8 * Math.exp(v[n >> 1]));
      }
      thr = Math.min(T * 15, Math.max(T * 4, thr));
    }
    this._wordThrCache = thr; this._wordThrT = T;
    return thr;
  }

  _fallingEdge() {
    const d = this.markFrames;
    this.markFrames = 0;
    this.spaceFrames = 0;
    // Reject marks shorter than ~40 % of a dot (noise spikes through the slicer).
    if (d < this.Td * 0.4) return;
    this.charEndP = this.curP;
    if (this.curElems.length < 8) this.curElems.push(d);
    this.charFlushed = false;
  }

  // Timeout-driven gap classification against the known dot period T:
  //   <2·T inter-element (do nothing — the char keeps growing)
  //    2·T character gap → flush the character
  //    5·T word gap      → emit a word space
  //   silence            → flush + silence event
  _handleGaps() {
    const T = this.Td;
    if (!this.charFlushed && this.curElems.length > 0 && this.spaceFrames >= T * 2) {
      this._flushChar();
    }
    if (this.charFlushed && !this.wordEmitted && this.spaceFrames >= this._wordThresh()) {
      this.wordEmitted = true;
      this._emitWord();
    }
    const silenceThresh = Math.max(this.silenceFrames, T * 20);
    if (!this.silent && this.spaceFrames >= silenceThresh) {
      this.silent = true;
      this._flushChar();
      if (this.callback) this.callback({ type: 'silence' });
    }
  }

  _emitWord() { if (this.callback && this.sigOpen) this.callback({ type: 'word' }); }

  // ── Speed & threshold estimation ──────────────────────────────────────────
  // Search dot periods; score each by the best-phase Otsu separability of the
  // envelope integrated into dot-length slots. The winning period is the dot;
  // its on/off class means become the slicer levels. Refuses to lock on noise
  // (separability below MIN_SEP) so idle periods don't produce garbage.
  _estimateSpeed() {
    const W = Math.min(this.envCount, this.EST_WIN);
    if (W < this.EST_MIN) return;

    // Copy the recent window (oldest→newest) and build a cumulative sum.
    const win = new Float64Array(W);
    let idx = this.envPos - W; if (idx < 0) idx += this.BUF;
    for (let j = 0; j < W; j++) { win[j] = this.envBuf[idx++]; if (idx >= this.BUF) idx -= this.BUF; }
    const cum = new Float64Array(W + 1);
    for (let j = 0; j < W; j++) cum[j + 1] = cum[j] + win[j];

    const tdMax = Math.min(this.TD_MAX, W >> 4);   // need ≥16 slots to score
    const scoreArr = new Float64Array(tdMax + 1);
    const m0Arr = new Float64Array(tdMax + 1);
    const m1Arr = new Float64Array(tdMax + 1);
    for (let Td = this.TD_MIN; Td <= tdMax; Td++) {
      const step = Math.max(1, Math.floor(Td / 5));
      let sTd = 0, m0 = 0, m1 = 0, bestVals = null;
      for (let ph = 0; ph < Td; ph += step) {
        const nSlots = Math.floor((W - ph) / Td);
        if (nSlots < 12) continue;
        const vals = new Float64Array(nSlots);
        for (let k = 0; k < nSlots; k++) {
          const x = ph + k * Td;
          vals[k] = (cum[x + Td] - cum[x]) / Td;
        }
        const r = this._separability(vals);
        if (r.sep > sTd) { sTd = r.sep; m0 = r.m0; m1 = r.m1; bestVals = vals; }
      }
      // Separability alone is ambiguous — it is high at the dot, its harmonics,
      // AND every sub-period (all separate cleanly). CW STRUCTURE breaks the tie:
      // at the true dot, runs of "on" slots cluster at 1 (dot) and 3 (dash), and
      // "off" runs at 1/3/7. Combine separability with that run-integer score.
      const runScore = bestVals ? this._runScore(bestVals, (m0 + m1) / 2) : 0;
      scoreArr[Td] = sTd * (0.4 + 0.6 * runScore);
      m0Arr[Td] = m0; m1Arr[Td] = m1;
    }

    // Average the combined score across windows (the true dot is persistent;
    // spurious peaks are random per window). Same idea as the averaged tone lock.
    if (!this.sepEma || this.sepEma.length < tdMax + 1) {
      const prev = this.sepEma; this.sepEma = new Float64Array(tdMax + 1);
      if (prev) this.sepEma.set(prev.subarray(0, Math.min(prev.length, tdMax + 1)));
    }
    const ema = this.sepEma, beta = 0.45;
    let bestScore = 0, bestTd = 0;
    for (let Td = this.TD_MIN; Td <= tdMax; Td++) {
      ema[Td] = ema[Td] * (1 - beta) + scoreArr[Td] * beta;
      if (ema[Td] > bestScore) { bestScore = ema[Td]; bestTd = Td; }
    }
    if (bestTd === 0 || bestScore < 0.35) {   // no confident CW
      this._closeGate();
      if (this.everOpen) return;
    }

    // Signal gate, decided BEFORE anything is adopted. The lock score above
    // cannot tell Morse from noise — pure noise scores 0.56–0.82, well over
    // 0.35 — so the decoder used to lock on an empty channel and print ~200
    // junk characters every 5 minutes. The on/off level ratio does separate
    // them: 99% of noise estimates stay below 1.74, while a still-readable
    // −10 dB signal sits at 2.3–2.8. At 2.0 noise still opened the gate about
    // once an hour (one burst of ~15 characters); at SIG_OPEN = 2.2 two hours
    // of noise opened it never, and weak-signal copy did not change. Close
    // below SIG_CLOSE (hysteresis).
    //
    // Once the gate has been open, a shut gate adopts nothing: an estimate of
    // a window of pure noise (a pause in the QSO) used to replace the
    // station's speed and levels with random ones, and the next transmission
    // was decoded with them until a new lock — its first characters came out
    // wrong. Before the first opening the estimates ARE adopted, gate shut or
    // not: the input filter narrowing to the keying speed is what lifts a
    // weak signal over SIG_OPEN (without it −11 dB never opened the gate).
    const ratio = m1Arr[bestTd] / Math.max(1e-12, m0Arr[bestTd]);
    //
    // The gate REopens only when two estimates in a row agree on the dot (within
    // 25 %): a window that holds the first tenth of a second of a reply and
    // six seconds of pause can pass SIG_OPEN with a dot four times too long,
    // and the replay then decoded the reply's first letters with it ("SV1BTL"
    // came out as "M1BTL"). Waiting one estimate costs nothing — the replay
    // goes back to the onset anyway.
    if (bestTd === 0 || bestScore < 0.35 || (this.sigOpen ? ratio < SIG_CLOSE : ratio < SIG_OPEN)) {
      this._closeGate(); this.openCand = 0;
      if (this.everOpen || bestTd === 0) return;
    } else if (!this.sigOpen) {
      // (Reopening only: before the first opening a weak signal's estimates
      // wander more than that, and −12 dB never opened at all.)
      if (!this.everOpen || (this.openCand > 0 && Math.abs(bestTd - this.openCand) <= 0.25 * this.openCand)) {
        this.sigOpen = true; this.everOpen = true; this.openCand = 0;
        if (this.Td > 0) this._rewindTo = this.gateClosedAt;   // see _processFrame
      } else {
        this.openCand = bestTd;
        if (this.everOpen) return;
      }
    }

    // Adopt / smooth the estimate.
    if (this.Td === 0 || Math.abs(bestTd - this.Td) > 0.3 * this.Td) this.Td = bestTd;
    else this.Td = Math.round(0.6 * this.Td + 0.4 * bestTd);

    this.mfWin = Math.max(2, Math.round(this.Td * 0.7));

    // #1: narrow the front-end I/Q low-pass to the keying bandwidth now that the
    // dot rate is known. A CW signal only occupies a few × its dot rate; the
    // fixed 50 Hz default passes far more noise (and adjacent QRM) than a slow
    // signal needs. Rejecting it BEFORE the nonlinear magnitude step — where
    // out-of-band noise would otherwise rectify into the envelope — is real
    // weak-signal gain (≈5 dB at 12 wpm). Clamped so fast CW keeps enough
    // bandwidth for clean dit edges.
    // fc ≈ 4.5× the keying rate keeps the 2-pole LP wide enough not to smear a
    // fast dit's edges (rise ≈ 0.35/fc must stay well under a dot), while still
    // narrowing well below the 50 Hz default for slow CW where noise dominates.
    const dotSec = this.Td * this.frameMs / 1000;
    const baud = 1 / (2 * dotSec);                 // dot-dot keying rate
    const fc = Math.min(90, Math.max(15, 4.5 * baud));
    this.lpA = 1 - Math.exp(-2 * Math.PI * fc / this.sr);

    // Slicer noise level: a low percentile of the matched-filter output over
    // the window (CW is key-up more than 30 % of the time even in a fade).
    {
      const mw = this.mfWin, n = W - mw;
      if (n > 50) {
        const sv = new Float64Array(n);
        for (let j = 0; j < n; j++) sv[j] = (cum[j + mw] - cum[j]) / mw;
        sv.sort();
        this.noiseLvl = sv[Math.floor(n * NOISE_PCT)];
      }
      // spread of quarter-dot averages of the raw envelope, from its key-up
      // (lower) part: what _softDecode scores against
      const st = Math.max(1, Math.round(this.Td / 4)), m = Math.floor(W / st);
      if (m > 50) {
        const sa = new Float64Array(m);
        for (let j = 0; j < m; j++) sa[j] = (cum[(j + 1) * st] - cum[j * st]) / st;
        sa.sort();
        this.stepSd = Math.max(1e-9, (sa[Math.floor(m * 0.3)] - sa[Math.floor(m * 0.05)]) / 1.46);
      }
    }
    this.pkDecay = Math.pow(PK_DROP, 1 / (PK_DOTS * this.Td));

    this.offLvl = m0Arr[bestTd];
    this.onLvl  = m1Arr[bestTd];
    if (this.onLvl <= this.offLvl) this.onLvl = this.offLvl * 1.5 + 1e-9;

    if (this.pk === 0) this.pk = this.onLvl;   // seed the peak on the first lock
    this._emitFreq();
  }

  _closeGate() {
    if (this.sigOpen) { this.sigOpen = false; this.gateClosedAt = this.frameNo; }
  }

  // CW structure score: slice slot values at `thr`, then measure how well the
  // run lengths match valid element counts — on-runs at {1,3} (dot/dash), off-
  // runs at {1,3,7} (element/char/word gaps). Peaks sharply at the true dot,
  // unlike separability which plateaus across every sub-multiple.
  _runScore(vals, thr) {
    const n = vals.length;
    if (n < 8) return 0;
    const runs = [];
    let cur = vals[0] > thr ? 1 : 0, len = 1;
    for (let i = 1; i < n; i++) {
      const on = vals[i] > thr ? 1 : 0;
      if (on === cur) len++; else { runs.push([cur, len]); cur = on; len = 1; }
    }
    runs.push([cur, len]);
    if (runs.length < 4) return 0;
    const onV = [1, 3];
    let sum = 0, cnt = 0, ones = 0;
    for (let i = 1; i < runs.length - 1; i++) {   // skip partial first/last runs
      const on = runs[i][0], L = runs[i][1];
      if (L > 10) continue;
      let sc;
      if (on) {
        let d = Infinity; for (const v of onV) d = Math.min(d, Math.abs(L - v));
        sc = Math.max(0, 1 - d);
      } else {
        // Any gap of 3+ slots is a legal character or word gap: Farnsworth
        // senders stretch them (5.4·T at 18/10 wpm). Scoring only exactly 3
        // and 7 marked the true dot down on such signals until a third of it
        // won — every element then read as a dash ("TTTT TTT").
        sc = L === 1 ? 1 : (L >= 3 ? 1 : 0);
      }
      if (L === 1) ones++;
      sum += sc; cnt++;
    }
    if (cnt < 3) return 0;
    // Real Morse at the true dot is full of 1-slot runs (every dot and every
    // gap inside a character). At a third of the dot there are none, though
    // its 3-slot runs fit perfectly — so demand them.
    const shortOk = Math.min(1, (ones / cnt) / 0.25);
    return (sum / cnt) * shortOk;
  }

  // Otsu two-class split of `vals`; returns {sep, m0(off mean), m1(on mean)}.
  _separability(vals) {
    const n = vals.length;
    const s = Float64Array.from(vals).sort();
    let total = 0; for (let i = 0; i < n; i++) total += s[i];
    const mean = total / n;
    let varTot = 0; for (let i = 0; i < n; i++) { const d = s[i] - mean; varTot += d * d; }
    varTot /= n;
    if (varTot <= 0) return { sep: 0, m0: mean, m1: mean };

    let best = 0, bestK = 1, wsum = 0;
    for (let k = 1; k < n; k++) {
      wsum += s[k - 1];
      const w0 = k / n, w1 = 1 - w0;
      const m0 = wsum / k, m1 = (total - wsum) / (n - k);
      const bc = w0 * w1 * (m0 - m1) * (m0 - m1);
      if (bc > best) { best = bc; bestK = k; }
    }
    let s0 = 0; for (let i = 0; i < bestK; i++) s0 += s[i];
    const m0 = s0 / bestK, m1 = (total - s0) / (n - bestK);
    return { sep: best / varTot, m0, m1 };
  }

  // ── Dictionary-constrained MAP character decode ───────────────────────────
  _flushChar() {
    const durs = this.curElems;
    const a = this.charStartP, b = this.charEndP;
    this.curElems = [];
    this.charFlushed = true;
    this.charStartP = -1;
    if (durs.length === 0) return;
    const ch = this._softDecode(a, b) || this._mapDecode(durs);
    this.prevCharEndP = b;
    if (ch && this.callback && this.sigOpen) this.callback({ type: 'char', char: ch });
  }

  // Raw envelope at absolute frame p (0 outside the buffer).
  _envAt(p) {
    const bufStart = this.frameNo - this.envCount;
    if (p < bufStart || p >= this.frameNo) return 0;
    const BUF = this.BUF;
    return this.envBuf[((this.envPos - (this.frameNo - p)) % BUF + BUF) % BUF];
  }

  // Soft-decision letter decode. At −10 dB 115 of 121 wrong letters had the
  // wrong NUMBER of elements — a dot lost in noise, two dots merged across a
  // gap the slicer missed — which a decision among codewords of the slicer's
  // length cannot repair. So the letter is decided on the envelope itself:
  // the stretch around the slicer's letter, in steps of a quarter dot, is
  // fitted to every Morse character of any length with a duration-tolerant
  // Viterbi alignment (each mark and gap may stretch, log-normally), scored by
  // the Gaussian likelihood of each step being key-down or key-up between the
  // letter's own on-level and the noise level, plus the letter prior.
  _softDecode(a, b) {
    const T = this.Td;
    if (T < 4 || a < 0 || b <= a) return null;
    const step = Math.max(1, Math.round(T / 4)), dot = T / step;
    let lo = a - Math.round(2 * T), hi = b + Math.round(1 * T);
    if (this.prevCharEndP >= 0) lo = Math.max(lo, this.prevCharEndP + Math.round(0.5 * T));
    lo = Math.max(lo, this.frameNo - this.envCount); hi = Math.min(hi, this.frameNo);
    const n = Math.floor((hi - lo) / step);
    if (n < 4) return null;
    const x = new Float64Array(n);
    for (let s = 0; s < n; s++) { let acc = 0; for (let k = 0; k < step; k++) acc += this._envAt(lo + s * step + k); x[s] = acc / step; }
    // levels: noise from the estimator; the key-down level step by step from
    // the slicer's own QSB-tracking level (one level per letter misread fast
    // fades: 1 Hz QSB went from 26 % to 44 % errors); spread from the
    // estimator window
    const off = this.noiseLvl > 0 ? this.noiseLvl : this.offLvl;
    const sd = this.stepSd;
    if (!(sd > 0)) return null;
    const BUF = this.BUF, P = new Float64Array(n + 1), k2 = SOFT_LLR_W / (2 * sd * sd);
    // the slicer's level lags the envelope by its boxcar; read it half a window later
    const lag = Math.round(this.mfWin / 2);
    for (let s = 0; s < n; s++) {
      const q = Math.min(this.curP, lo + s * step + (step >> 1) + lag);
      // before the decode (re)started there is no slicer level yet: use the
      // estimator's (the first letter of a transmission, C of CQ, misread)
      const on = q < this.lvlFrom ? this.onLvl : Math.max(this.lvlBuf[((q % BUF) + BUF) % BUF], off * 1.05);
      const v = x[s];
      P[s + 1] = P[s] + ((v - off) * (v - off) - (v - on) * (v - on)) * k2;
    }
    const segOn = (u, v) => 0.5 * (P[v] - P[u]), segOff = (u, v) => -0.5 * (P[v] - P[u]);
    const lp = (d, nom, sg) => { const z = Math.log(d / nom) / sg; return -0.5 * z * z; };
    let best = -Infinity, bestCh = null;
    let cur = new Float64Array(n + 1), nxt = new Float64Array(n + 1);
    for (const cw of SOFT_CODES) {
      // lead-in key-up of any length
      for (let t = 0; t <= n; t++) cur[t] = segOff(0, t);
      const els = cw.els;
      for (let e = 0; e < els.length; e++) {
        // mark
        const nomM = els[e] * dot, dminM = Math.max(1, Math.floor(nomM * SOFT_MK_MIN)), dmaxM = Math.ceil(nomM * 1.8);
        nxt.fill(-Infinity);
        for (let t = 0; t <= n; t++) { if (cur[t] === -Infinity) continue;
          for (let d = dminM; d <= dmaxM && t + d <= n; d++) { const v = cur[t] + segOn(t, t + d) + lp(d, nomM, SOFT_SIG_MK); if (v > nxt[t + d]) nxt[t + d] = v; } }
        [cur, nxt] = [nxt, cur];
        if (e === els.length - 1) break;
        // gap inside the letter
        const nomG = dot, dminG = Math.max(1, Math.round(nomG * SOFT_GAP_MIN)), dmaxG = Math.ceil(nomG * 2.2);
        nxt.fill(-Infinity);
        for (let t = 0; t <= n; t++) { if (cur[t] === -Infinity) continue;
          for (let d = dminG; d <= dmaxG && t + d <= n; d++) { const v = cur[t] + segOff(t, t + d) + lp(d, nomG, SOFT_SIG_GP); if (v > nxt[t + d]) nxt[t + d] = v; } }
        [cur, nxt] = [nxt, cur];
      }
      // tail key-up of any length
      let sc = -Infinity; for (let t = 0; t <= n; t++) if (cur[t] > -Infinity) { const v = cur[t] + segOff(t, n); if (v > sc) sc = v; }
      sc += SOFT_PRIOR_W * cw.logPrior;
      if (sc > best) { best = sc; bestCh = cw.char; }
    }
    return bestCh;
  }

  _mapDecode(durs) {
    const n = durs.length;
    const T = this.Td;
    if (T < 1) return null;

    const SIG = 0.35;
    const lnT = Math.log(T), ln3T = Math.log(3 * T);
    const Ldit = new Float64Array(n), Ldah = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const ln = Math.log(durs[i] + 1e-9);
      const zd = (ln - lnT) / SIG;   Ldit[i] = -zd * zd;
      const za = (ln - ln3T) / SIG;  Ldah[i] = -za * za;
    }

    const list = DECODE_BY_LEN[n];
    if (!list) {
      let code = '';
      for (let i = 0; i < n; i++) code += (Ldah[i] > Ldit[i]) ? '-' : '.';
      return MORSE[code] || `[${code}]`;
    }

    const PRIOR_W = 0.5;
    let best = -Infinity, bestChar = null;
    for (let k = 0; k < list.length; k++) {
      const { bits, char, logPrior } = list[k];
      let score = PRIOR_W * logPrior;
      for (let i = 0; i < n; i++) score += bits[i] ? Ldah[i] : Ldit[i];
      if (score > best) { best = score; bestChar = char; }
    }
    return bestChar;
  }
}

// ── Worker host (cw.worker.js) ──────────────────────────────────────────────
if (typeof window === 'undefined' && typeof self !== 'undefined' && typeof importScripts === 'function') {
  let sampleRate = 12000;
  let decoder = null;
  const ensure = () => decoder || (decoder = new CWDecoder({
    sampleRate, callback: (event) => { self.postMessage(event); } }));
  self.onmessage = ({ data }) => {
    const d = data || {};
    try {
      switch (d.t) {
        case 'init': {
          if (d.sampleRate) sampleRate = d.sampleRate;
          const existed = !!decoder;
          ensure().setSampleRate(sampleRate);
          if (existed) decoder.reset();
          break;
        }
        case 'sampleRate':
          if (d.sampleRate && d.sampleRate !== sampleRate) { sampleRate = d.sampleRate; ensure().setSampleRate(sampleRate); }
          break;
        case 'reset':
          if (d.sampleRate) sampleRate = d.sampleRate;
          ensure().setSampleRate(sampleRate);
          decoder.reset();
          break;
        case 'pcm':
          if (d.sampleRate && d.sampleRate !== sampleRate) { sampleRate = d.sampleRate; ensure().setSampleRate(sampleRate); }
          if (d.pcm && d.pcm.length) ensure().feed(d.pcm);
          break;
        case 'destroy':
          decoder = null;
          self.close();
          break;
      }
    } catch (e) { console.error('[CW worker]', e); }
  };
} else {
  root.CWDecoder = CWDecoder;
}
})(typeof window !== 'undefined' ? window : self);
