/**
 * fax.js — HF FAX / WEFAX decoder (ITU-T T.4 / CCIR 574)
 *
 * Extracted verbatim from audio.js (the `_fax*` methods of AudioClient) so it can
 * run inside a Web Worker; see fax.worker.js.  The algorithm is unchanged — only
 * the state names lost their `_fax` prefix and the input sample rate now comes
 * from a supplied function instead of `this.audioOutputSps`.
 *
 *  Standard parameters:
 *    Black tone : 1500 Hz  (USB-demodulated audio)
 *    White tone : 2300 Hz  (shift = 800 Hz)
 *    Center freq: 1900 Hz  (FM discriminator reference)
 *    LPM        : 120  (lines per minute — most HF stations)
 *    IOC        : 576  (index of co-operation → π×IOC ≈ 1810 pixels/line)
 *    Start tone : 300 Hz alternating phasing (~5 min before image)
 *    Stop  tone : 450 Hz alternating phasing (~5 sec after image)
 *
 *  Algorithm: quadrature FM discriminator (mix → lowpass → atan2 derivative)
 *  followed by sub-sample pixel accumulation and optional sync-pulse
 *  auto-alignment.
 *
 * Emits, via the callback:
 *   { type:'line', pixels:Uint8Array, lineNum:number, phasing:bool, stopTone:bool }
 */

export class KiwiFAXDecoder {

  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate
      : (() => options.sampleRate || 12000);
    this._callback = typeof options.callback === 'function' ? options.callback : null;
    this._enabled  = false;

    // Operator-set parameters.  These live OUTSIDE reset() on purpose — see the
    // note there.
    this._lpm       = options.lpm   || 120;
    this._ioc       = options.ioc   || 576;
    this._shift     = options.shift || 800;
    this._usePhasing = options.autoAlign !== undefined ? !!options.autoAlign : true;

    this.reset();
  }

  setEnabled(enabled) {
    this._enabled = !!enabled;
    if (!this._enabled) this.reset();
  }

  setCallback(fn) {
    this._callback = typeof fn === 'function' ? fn : null;
  }

  /**
   * @param {number} lpm   Lines per minute (60 | 90 | 100 | 120 | 240)
   * @param {number} ioc   Index of co-operation (288 | 576)
   * @param {number} shift Frequency shift Hz (400 | 800)
   */
  setParams(lpm, ioc, shift) {
    this._lpm   = lpm   || 120;
    this._ioc   = ioc   || 576;
    this._shift = shift || 800;
    this._updateTiming();
    console.log(`[FAX] Params: ${this._lpm} LPM, IOC ${this._ioc}, shift ${this._shift} Hz`);
  }

  /** Enable / disable automatic sync-pulse line alignment. */
  setAutoAlign(enabled) {
    this._usePhasing = !!enabled;
  }

  destroy() {
    this._enabled  = false;
    this._callback = null;
  }

  // ── Internal state reset ───────────────────────────────────────────────────
  //
  // NOTE: LPM / IOC / shift / auto-align are deliberately NOT reset here.
  // audio.js calls reset() on every enable (to rebuild the filters at the current
  // sample rate), and the UI sets the station's parameters BEFORE enabling — so
  // resetting them here silently threw away the operator's selection and decoded
  // every station at 120 LPM / IOC 576 until they touched a control again.
  reset() {
    this._black  = 1500;
    this._white  = 2300;
    this._center = 1900;
    this._startTone  = 300;
    this._stopToneHz = 450;
    this._decodeSps  = 12000;

    // Kiwi uses three ACfax LPF coefficient sets; "middle" is the default.
    // Keep raw integer taps because magnitude normalization follows.
    this._firCoeffs = new Float64Array([
       0, -18, -38, -39, 0, 83, 191, 284, 320,
     284, 191, 83, 0, -39, -38, -18, 0
    ]);
    this._firLen = this._firCoeffs.length;
    this._bufI = new Float64Array(this._firLen);
    this._bufQ = new Float64Array(this._firLen);
    this._bufPosI = 0;
    this._bufPosQ = 0;

    this._mixerPhase = 0.0;    // normalized 0..1
    this._Iprev = 0.0;
    this._Qprev = 0.0;
    this._prevRaw = 0.0;
    this._dc = 0.0;

    this._resamplePhase = 0.0;
    this._resampleLast = 0.0;
    this._resampleInSps = 0.0;
    this._resampleRatio = 1.0;

    this._pixPerLine = 1810;
    this._sampPerLine = 6000;
    this._sampPerPix = this._sampPerLine / this._pixPerLine;

    this._lineBuf = new Uint8Array(8192);
    this._linePix = new Uint8Array(2048);
    this._lineOut = new Uint8Array(2048);
    this._lineBufPos = 0;
    this._lineCount = 0;

    // Kiwi-style phasing alignment.
    this._phasingLines = 40;
    this._phasingSkipLines = 1;
    this._phasingPos = new Int32Array(this._phasingLines);
    this._phasingSum = null;      // sum of the phasing lines, for the weak-signal fallback
    this._phasingSumCount = 0;
    this._phasingLinesLeft = 0;
    this._phasingSkipData = 0;
    this._havePhasing = false;
    this._skip = 0;
    this._pendingSkip = 0;

    this._phasing = false;
    this._stopDetected = false;
    this._includeHeadersInImages = false;
    this._startCount = 0;
    this._stopCount = 0;
    this._toneConfirmLines = 3;

    this._updateTiming();
  }

  _updateTiming() {
    const inSr = this._sampleRateFn() || 12000;
    const sr = this._decodeSps || 12000;
    this._resampleInSps = inSr;
    this._resampleRatio = inSr / sr;
    this._black  = 1500;
    this._white  = this._black + this._shift;
    this._center = (this._black + this._white) / 2.0;
    this._pixPerLine = Math.round(Math.PI * this._ioc);
    this._sampPerLine = Math.max(1, Math.round(sr * 60.0 / this._lpm));
    this._sampPerPix = this._sampPerLine / this._pixPerLine;

    this._lineBuf = new Uint8Array(this._sampPerLine + 64);
    this._linePix = new Uint8Array(Math.max(2048, this._pixPerLine + 64));
    this._lineOut = new Uint8Array(Math.max(2048, this._pixPerLine + 64));
    this._lineBufPos = 0;

    console.log(
      `[FAX] Kiwi-style discriminator | in_sr=${inSr} Hz -> decode_sr=${sr} Hz | ` +
      `${this._pixPerLine} px/line, ${this._sampPerLine} samp/line | ` +
      `carrier=${this._center} Hz shift=${this._shift} Hz`
    );
  }

  _applyFir(buffer, posKey, sample) {
    const coeffs = this._firCoeffs;
    const len = this._firLen;
    let pos = this[posKey];
    buffer[pos] = sample;

    let sum = 0.0;
    let idx = pos;
    for (let i = 0; i < len; i++) {
      sum += buffer[idx] * coeffs[i];
      idx++;
      if (idx >= len) idx = 0;
    }

    pos--;
    if (pos < 0) pos = len - 1;
    this[posKey] = pos;
    return sum;
  }

  _fourierTransformSub(buffer, sampsPerLine, bufferLen, freq) {
    const k = -2 * Math.PI * freq * 60.0 / this._lpm / sampsPerLine;
    let retr = 0.0, reti = 0.0;
    for (let n = 0; n < bufferLen; n++) {
      const v = buffer[n];
      retr += v * Math.cos(k * n);
      reti += v * Math.sin(k * n);
    }
    return Math.hypot(retr, reti);
  }

  _detectLineType(buffer, sampsPerLine, bufferLen) {
    // Robust Kiwi-style tone gating: remove DC first and normalize against line
    // energy so ordinary image content does not trip START/STOP detection.
    let mean = 0.0;
    for (let i = 0; i < bufferLen; i++) mean += buffer[i];
    mean /= Math.max(1, bufferLen);

    let energy = 0.0;
    const centered = new Float64Array(bufferLen);
    for (let i = 0; i < bufferLen; i++) {
      const v = buffer[i] - mean;
      centered[i] = v;
      energy += v * v;
    }
    const rms = Math.sqrt(energy / Math.max(1, bufferLen)) + 1e-9;
    // Look at each quarter of the line (1500 samples: 8 Hz bins, so an Opus
    // offset of a few Hz costs only ~2%) and require the tone in ALL FOUR.
    // The start/stop signals fill the whole line; chart content does not. With
    // only the first quarter examined, a hatched area whose spacing matched
    // 300 Hz (~12 px) scored up to 0.67 — measured 17 lines in a row detected as
    // START in the middle of a chart, after which the next 40 chart lines were
    // swallowed as "phasing". All-quarters, the same chart peaks at 0.106.
    // That margin allows the lower threshold 0.18: the real start signal holds
    // 0.61 at 10 dB SNR, 0.38 at 3 dB and 0.23 at 0 dB (was missed below ~2 dB
    // at 0.30). For a perfect square wave the ratio is 4/(π√2) ≈ 0.637.
    const q = Math.max(512, Math.floor(bufferLen / 4));
    let startDet = Infinity, stopDet = Infinity;
    for (let k = 0; k + q <= bufferLen; k += q) {
      const seg = centered.subarray(k, k + q);
      const sd = this._fourierTransformSub(seg, sampsPerLine, q, this._startTone) / q;
      const td = this._fourierTransformSub(seg, sampsPerLine, q, this._stopToneHz) / q;
      if (sd < startDet) startDet = sd;
      if (td < stopDet) stopDet = td;
    }
    const startRatio = startDet / rms;
    const stopRatio  = stopDet / rms;

    if (startRatio > 0.18 && startDet > 8) return 'START';
    if (stopRatio  > 0.18 && stopDet  > 8) return 'STOP';
    return 'IMAGE';
  }

  _phasingLinePosition(image, samplesPerLine) {
    const n = Math.max(1, Math.floor(samplesPerLine * 0.07));
    const sampsIncr = Math.max(1, Math.floor(samplesPerLine / this._pixPerLine * 4));
    let minTotal = Number.POSITIVE_INFINITY;
    let minPos = 0;

    for (let i = 0; i < samplesPerLine; i += sampsIncr) {
      let total = 0;
      const half = Math.floor(n / 2);

      for (let j = 0; j < half; j++) {
        const idx = (j + i) % samplesPerLine;
        total += image[idx] * j;
      }
      for (let j = half; j < n; j++) {
        const idx = (j + i) % samplesPerLine;
        total += image[idx] * (n - j);
      }

      if (total < minTotal) {
        minTotal = total;
        minPos = i;
      }
    }
    return minPos;
  }

  _averagedPhasingPos(spl) {
    const sum = this._phasingSum, n = this._phasingSumCount;
    if (!sum || sum.length !== spl || n < 10) return 0;
    const avg = new Float64Array(spl);
    for (let i = 0; i < spl; i++) avg[i] = sum[i] / n;
    const pos = this._phasingLinePosition(avg, spl);
    // Contrast check: the 5% pulse (inside the 7% search window) against the
    // median of the whole averaged line. At −1 dB the discriminator's noise
    // clicks wash black and white towards grey: real phasing measured 0.33–0.36.
    const w = Math.max(1, Math.floor(spl * 0.07)), pw = Math.max(1, Math.floor(spl * 0.05));
    const c0 = pos + Math.floor((w - pw) / 2);
    let pulse = 0;
    for (let j = 0; j < pw; j++) pulse += avg[(c0 + j) % spl];
    pulse /= pw;
    const sorted = Array.from(avg).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    if (median - pulse < 0.25 * median) return 0;
    // Width check: phasing is a 5% pulse. Contrast alone cannot tell it from
    // chart content — a solid black block scores 1.00 — but width can. Smooth
    // over 1% of the line, then measure the run below the pulse/line midpoint.
    const sw = Math.max(1, Math.floor(spl * 0.01)), mid = (pulse + median) / 2;
    const sm = (i) => { let a = 0; for (let j = -sw; j <= sw; j++) a += avg[((i + j) % spl + spl) % spl]; return a / (2 * sw + 1); };
    const centre = c0 + (pw >> 1);
    let lo = 0, hi = 0;
    while (lo < spl / 4 && sm(centre - lo - 1) < mid) lo++;
    while (hi < spl / 4 && sm(centre + hi + 1) < mid) hi++;
    const width = (lo + hi + 1) / spl;
    if (width < 0.025 || width > 0.10) return 0;
    console.log(`[FAX] phasing: per-line estimates disagreed; averaged ${n} lines, pulse ${pulse.toFixed(0)} vs line ${median.toFixed(0)}, ${(100 * width).toFixed(1)}% wide`);
    return pos;
  }

  _medianFromArray(arr, count, pctLo = 10, pctHi = 90) {
    if (!count) return { median: 0, lo: 0, hi: 0 };
    const vals = Array.from(arr.slice(0, count)).sort((a, b) => a - b);
    const mid = vals[Math.floor(vals.length / 2)];
    const lo = vals[Math.max(0, Math.floor(vals.length * pctLo / 100))];
    const hi = vals[Math.min(vals.length - 1, Math.floor(vals.length * pctHi / 100))];
    return { median: mid, lo, hi, vals };
  }

  _averagePhasingPos(arr, count, samplesPerLine) {
    if (!count || samplesPerLine <= 0) return 0;

    const { median, lo, hi, vals } = this._medianFromArray(arr, count, 10, 90);
    if ((hi - lo) > samplesPerLine / 6) {
      return 0;
    }

    // Kiwi stores multiple phasing-line positions and then uses a robust center.
    // Here we keep the same 10/90% spread rejection, then do a wrapped average
    // around the median so lines that straddle the line boundary still average
    // correctly instead of pulling the estimate apart.
    const window = Math.max(8, Math.floor(samplesPerLine * 0.03));
    let acc = 0;
    let used = 0;

    for (let i = 0; i < vals.length; i++) {
      let d = vals[i] - median;
      if (d >  samplesPerLine / 2) d -= samplesPerLine;
      if (d < -samplesPerLine / 2) d += samplesPerLine;
      if (Math.abs(d) <= window) {
        acc += d;
        used++;
      }
    }

    if (!used) return ((median % samplesPerLine) + samplesPerLine) % samplesPerLine;
    const avg = median + acc / used;
    return ((Math.round(avg) % samplesPerLine) + samplesPerLine) % samplesPerLine;
  }

  _decodeImageLine(buffer, bufferLen, outPixels) {
    const spl = bufferLen;
    const width = this._pixPerLine;

    for (let i = 0; i < width; i++) {
      const first = Math.floor(spl * i / width);
      const last  = Math.max(first, Math.floor(spl * (i + 1) / width) - 1);
      let acc = 0;
      let cnt = 0;
      for (let s = first; s <= last; s++) {
        acc += buffer[s];
        cnt++;
      }
      outPixels[i] = cnt ? Math.round(acc / cnt) : buffer[first] || 0;
    }
  }

  _emitLine(rawPixels, phasing, stopTone) {
    const PPL = this._pixPerLine;
    const out = this._lineOut;
    out[0] = rawPixels[0];
    out[PPL - 1] = rawPixels[PPL - 1];

    for (let p = 1; p < PPL - 1; p++) {
      const a = rawPixels[p - 1], b = rawPixels[p], c = rawPixels[p + 1];
      const lo = (a < b) ? a : b;
      const hi = (a < b) ? b : a;
      out[p] = (c <= lo) ? lo : (c >= hi) ? hi : c;
    }

    if (this._callback) {
      const pixels = new Uint8Array(PPL);
      pixels.set(out.subarray(0, PPL));
      this._callback({
        type: 'line',
        pixels,
        lineNum: this._lineCount,
        phasing,
        stopTone,
      });
    }
  }

  _processLine() {
    const spl = this._sampPerLine;
    const buf = this._lineBuf.subarray(0, spl);
    const rawType = this._detectLineType(buf, spl, spl);

    if (rawType === 'START') {
      this._startCount++;
      this._stopCount = 0;
    } else if (rawType === 'STOP') {
      this._stopCount++;
      this._startCount = 0;
    } else {
      this._startCount = 0;
      this._stopCount = 0;
    }

    const type =
      (this._startCount >= this._toneConfirmLines) ? 'START' :
      (this._stopCount  >= this._toneConfirmLines) ? 'STOP'  : 'IMAGE';

    this._phasing = (type === 'START');
    this._stopDetected = (type === 'STOP');

    if (type === 'START') {
      this._phasingSum = new Float64Array(spl);
      this._phasingSumCount = 0;
      this._phasingLinesLeft = this._phasingLines;
      this._phasingSkipData = 0;
      this._havePhasing = false;
      this._skip = 0;
      this._pendingSkip = 0;
    }

    if (this._usePhasing && rawType === 'IMAGE' &&
        this._phasingLinesLeft > this._phasingSkipLines) {
      const idx = this._phasingLinesLeft - this._phasingSkipLines - 1;
      if (idx >= 0 && idx < this._phasingPos.length) {
        this._phasingPos[idx] = this._phasingLinePosition(buf, spl);
        if (this._phasingSum && this._phasingSum.length === spl) {
          for (let i = 0; i < spl; i++) this._phasingSum[i] += buf[i];
          this._phasingSumCount++;
        }
      }
    }

    if (this._usePhasing && rawType === 'IMAGE' &&
        this._phasingLinesLeft >= -this._phasingSkipLines) {
      this._phasingLinesLeft--;
      if (this._phasingLinesLeft === 0) {
        const used = Math.max(1, this._phasingLines - this._phasingSkipLines);
        this._phasingSkipData = this._averagePhasingPos(this._phasingPos, used, spl);
        // Weak-signal fallback. Each phasing line locates the pulse on its own,
        // and around −1 dB SNR those estimates scatter past the spread limit
        // (about 1 run in 6), so alignment gave up and the chart came out
        // shifted sideways. Averaging the phasing lines first cuts the noise
        // ~6× (40 lines); the result must still look like a phasing pulse —
        // clearly darker than the line and 2.5–10% wide (see _averagedPhasingPos).
        if (!this._phasingSkipData) this._phasingSkipData = this._averagedPhasingPos(spl);
      }
    }

    const shouldEmit =
      this._includeHeadersInImages ||
      !this._usePhasing ||
      (rawType === 'IMAGE' && this._phasingLinesLeft < -this._phasingSkipLines);

    if (shouldEmit) {
      this._decodeImageLine(buf, spl, this._linePix);

      if (this._phasingSkipData && this._usePhasing && !this._havePhasing) {
        this._pendingSkip = this._phasingSkipData;
        this._havePhasing = true;
        console.log(`[FAX] phasing aligned: skip=${this._phasingSkipData} samples (multi-line avg)`);
      }

      this._lineCount++;
      this._emitLine(this._linePix, this._phasing, this._stopDetected);
    }
  }

  /**
   * Feed raw PCM into the KiwiSDR-style HF FAX discriminator.
   * The PCM is expected to be post-demod audio at the input sample rate,
   * unless an explicit inputSampleRate is supplied (used for native-rate Opus FAX).
   */
  feedPCM(pcm, inputSampleRate = null) {
    if (!this._enabled || !pcm || pcm.length === 0) return;

    const inSr = inputSampleRate || this._sampleRateFn() || 12000;
    const sr = this._decodeSps || 12000;
    const carrier = this._center;
    const phInc = carrier / sr;
    const ratio = inSr / sr;

    let f = this._mixerPhase;
    let Iprev = this._Iprev;
    let Qprev = this._Qprev;
    let prevRaw = this._prevRaw;
    let dc = this._dc;
    let rsp = this._resamplePhase;
    let linePos = this._lineBufPos;
    let skip = this._skip;
    let pendingSkip = this._pendingSkip;

    const processSample = (sample) => {
      // DC blocking ahead of discriminator materially improves long-run stability.
      dc = 0.9995 * dc + 0.0005 * sample;
      const hp = sample - dc;

      const phase = 2 * Math.PI * f;
      const Icur0 = this._applyFir(this._bufI, '_bufPosI', hp * Math.cos(phase));
      const Qcur0 = this._applyFir(this._bufQ, '_bufPosQ', hp * Math.sin(phase));

      f += phInc;
      if (f >= 1.0) f -= 1.0;

      const mag = Math.hypot(Icur0, Qcur0);
      if (mag < 1e-12) return;

      const Icur = Icur0 / mag;
      const Qcur = Qcur0 / mag;

      // Exact phase-difference discriminator is much less likely to drift than
      // the small-angle approximation when the signal level varies.
      let dphi = Math.atan2(Iprev * Qcur - Qprev * Icur, Iprev * Icur + Qprev * Qcur);
      let freq = (dphi * sr) / (2 * Math.PI);
      freq = this._center + freq;

      let x = (freq - this._black) / Math.max(1.0, this._white - this._black);
      x = 1.0 - x;
      if (!Number.isFinite(x)) return;
      if (x < 0) x = 0;
      else if (x > 1) x = 1;

      Iprev = Icur;
      Qprev = Qcur;

      let pixel = Math.round(x * 255.0);
      if (pixel < 0) pixel = 0;
      else if (pixel > 255) pixel = 255;

      if (skip > 0) {
        skip--;
        return;
      }

      this._lineBuf[linePos++] = pixel;
      if (linePos >= this._sampPerLine) {
        this._lineBufPos = linePos;
        this._skip = skip;
        this._pendingSkip = pendingSkip;
        this._Iprev = Iprev;
        this._Qprev = Qprev;
        this._mixerPhase = f;
        this._dc = dc;

        this._processLine();
        linePos = 0;

        pendingSkip = this._pendingSkip;
        if (pendingSkip > 0) {
          skip = pendingSkip;
          pendingSkip = 0;
          this._pendingSkip = 0;
        }
      }
    };

    if (Math.abs(inSr - sr) < 1e-6) {
      for (let i = 0; i < pcm.length; i++) processSample(pcm[i]);
    } else {
      for (let i = 0; i < pcm.length; i++) {
        const cur = pcm[i];
        while (rsp <= 1.0) {
          const s = prevRaw + (cur - prevRaw) * rsp;
          processSample(s);
          rsp += ratio;
        }
        rsp -= 1.0;
        prevRaw = cur;
      }
    }

    this._mixerPhase = f;
    this._Iprev = Iprev;
    this._Qprev = Qprev;
    this._prevRaw = prevRaw;
    this._dc = dc;
    this._resamplePhase = rsp;
    this._lineBufPos = linePos;
    this._skip = skip;
    this._pendingSkip = pendingSkip;
  }
}
