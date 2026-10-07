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
    this.toneHz = 700; this.toneValid = false;
    this.specAvg = null; this.specFrames = 0;
    this.fftBuf = new Float32Array(this.FFT_N); this.fftFill = 0;

    // NCO + I/Q low-pass
    this.oscC = 1; this.oscS = 0; this.oscNorm = 0;
    this.lpI1 = 0; this.lpI2 = 0; this.lpQ1 = 0; this.lpQ2 = 0;

    // Decimation
    this.hopCount = 0; this.magAccum = 0;

    // Envelope ring buffer
    this.envBuf = new Float64Array(this.BUF);
    this.envPos = 0; this.envCount = 0;
    this.frameNo = 0;            // absolute frame counter
    this.decodePos = 0;          // next absolute frame index to decode

    // Speed / threshold estimation
    this.Td = 0;                 // dot period in frames (0 = unknown)
    this.sepEma = null;          // averaged separability-vs-period landscape
    this.mfWin = 8;              // matched-filter boxcar width (frames)
    this.onLvl = 0; this.offLvl = 0;
    // Fast local on/off level followers that ride QSB between the (slow, ~0.7 s)
    // estimator updates. Anchored to onLvl/offLvl; null until the first lock.
    this.onLvlLocal = null; this.offLvlLocal = null;
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
    this.sigOpen = false;        // signal gate — see _estimateSpeed
    this._wordThrCache = 0;
  }

  _configure() {
    const sr = this.sr;
    this.FFT_N   = 2048;                                 // ~0.17 s @ 12 kHz
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

      // (1) Tone acquisition buffer.
      this.fftBuf[this.fftFill++] = x;
      if (this.fftFill >= this.FFT_N) { this._detectTone(); this.fftFill = 0; }
      if (Math.abs(this.toneHz - this.oscFreq) > 1.5) this._setToneCoeffs(this.toneHz);

      // (2) Complex downconvert by e^{-jωn} via incremental rotator.
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

      // (3) Decimate to a ~2 ms envelope frame.
      if (++this.hopCount >= this.hop) {
        const e = this.magAccum / this.hop;
        this.magAccum = 0; this.hopCount = 0;
        this._processFrame(e);
      }
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
        this._resetTiming();   // discard pre-lock garbage
      } else {
        this.toneHz = hz;      // averaged spectrum is stable; follow directly
      }
      this._emitFreq();
    }
  }

  _resetTiming() {
    this.envPos = 0; this.envCount = 0;
    this.frameNo = 0; this.decodePos = 0;
    this.Td = 0; this.sepEma = null; this.framesSinceEst = 0;
    this.onLvlLocal = null; this.offLvlLocal = null;
    this.keyOn = false; this.markFrames = 0; this.spaceFrames = 0;
    this.curElems = []; this.charFlushed = true; this.wordEmitted = true;
    this.silent = false; this.gapHist = []; this._wordThrCache = 0; this.sigOpen = false;
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
    if (hadTd === 0) this.decodePos = this.frameNo - this.envCount;

    // Decode all frames up to the current one (normally just the newest; a whole
    // buffer's worth on the first-lock replay).
    while (this.decodePos < this.frameNo) { this._decodeFrame(this.decodePos); this.decodePos++; }
  }

  // Slice + edge-detect one buffered frame (absolute index p) through the
  // matched filter → keying state. Used for both live decoding and replay.
  _decodeFrame(p) {
    const sm = this._boxcarAt(p, this.mfWin);

    // QSB-tracking slice levels. The estimator's onLvl/offLvl are stable but only
    // refreshed every ~0.7 s; a fading signal drifts between updates, so slicing
    // against a static level chops dashes / merges characters. Ride the fade with
    // fast local followers (onLvlLocal/offLvlLocal) that update per-frame from the
    // matched-filter output while gated by the current key state — anchored to the
    // estimator so they can't run away, and with a static fallback if a deep fade
    // collapses the local span.
    let eOn = this.onLvlLocal, eOff = this.offLvlLocal;
    const estSpan = this.onLvl - this.offLvl;
    if (eOn === null || eOn - eOff < 0.25 * estSpan) { eOn = this.onLvl; eOff = this.offLvl; }
    const span = eOn - eOff;
    const HIGH = eOff + 0.55 * span;
    const LOW  = eOff + 0.35 * span;
    let on = this.keyOn;
    if (!this.keyOn && sm > HIGH) on = true;
    else if (this.keyOn && sm < LOW) on = false;

    if (on !== this.keyOn) {
      if (on) this._risingEdge(); else this._fallingEdge();
      this.keyOn = on;
    }

    if (this.keyOn) { this.markFrames++; }
    else { this.spaceFrames++; this._handleGaps(); }

    // Advance the local followers AFTER the decision, gated by key state so marks
    // train the on-level and spaces the off-level. Time constant ≈ 5 dots: fast
    // enough for typical QSB (≈1–3 Hz), slow enough not to collapse within a dash.
    // Followers are clamped to a plausible band around the estimator levels.
    if (this.onLvlLocal !== null) {
      const a = 1 / Math.max(3, 5 * this.Td);
      if (this.keyOn) this.onLvlLocal += a * (sm - this.onLvlLocal);
      else            this.offLvlLocal += a * (sm - this.offLvlLocal);
      const lo = this.offLvl - 0.5 * estSpan, hi = this.onLvl + 0.7 * estSpan;
      if (this.onLvlLocal > hi) this.onLvlLocal = hi;
      if (this.onLvlLocal < this.offLvl + 0.3 * estSpan) this.onLvlLocal = this.offLvl + 0.3 * estSpan;
      if (this.offLvlLocal < lo) this.offLvlLocal = lo;
      if (this.offLvlLocal > this.onLvl - 0.3 * estSpan) this.offLvlLocal = this.onLvl - 0.3 * estSpan;
    }
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
    if (T > 0 && gap > T * 1.5 && gap < T * 25) {
      this.gapHist.push(gap);
      if (this.gapHist.length > 40) this.gapHist.shift();
      this._wordThrCache = 0;
    }
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
    let thr = T * 6;
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
    if (bestTd === 0 || bestScore < 0.35) { this.sigOpen = false; return; }   // no confident CW

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

    this.offLvl = m0Arr[bestTd];
    this.onLvl  = m1Arr[bestTd];
    if (this.onLvl <= this.offLvl) this.onLvl = this.offLvl * 1.5 + 1e-9;

    // Signal gate. The lock score above cannot tell Morse from noise — pure
    // noise scores 0.56–0.82, well over 0.35 — so the decoder used to lock on
    // an empty channel and print ~200 junk characters every 5 minutes. The
    // on/off level ratio does separate them: 99% of noise estimates stay below
    // 1.74, while a still-readable −10 dB signal sits at 2.3–2.8. At 2.0 noise
    // still opened the gate about once an hour (one burst of ~15 characters);
    // at SIG_OPEN = 2.2 two hours of noise opened it never, and weak-signal
    // copy did not change. Close below SIG_CLOSE (hysteresis).
    const ratio = this.onLvl / Math.max(1e-12, this.offLvl);
    if (!this.sigOpen && ratio >= SIG_OPEN) this.sigOpen = true;
    else if (this.sigOpen && ratio < SIG_CLOSE) this.sigOpen = false;
    // Seed the fast local followers on the first lock; afterwards leave them to
    // track QSB on their own (nudge only if they've drifted implausibly far).
    if (this.onLvlLocal === null) { this.onLvlLocal = this.onLvl; this.offLvlLocal = this.offLvl; }
    this._emitFreq();
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
    this.curElems = [];
    this.charFlushed = true;
    if (durs.length === 0) return;
    const ch = this._mapDecode(durs);
    if (ch && this.callback && this.sigOpen) this.callback({ type: 'char', char: ch });
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
