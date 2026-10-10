// throb.js — THROB and THROBX decoders (receive only)
//
// A port of fldigi's src/throb/throb.cxx.
//
// How THROB works
//   Each character is ONE symbol made of two tones sounding together (or a
//   single tone for a few characters), picked from 9 tones (THROB) or 11
//   (THROBX). The symbol is shaped by a raised-cosine pulse, so the signal
//   "throbs" once per character. 1, 2 or 4 symbols a second. THROB has only
//   capitals, figures and a few marks, plus a SHIFT pair for ? @ = and newline;
//   THROBX has a larger set and alternates two pairs for space / idle.
//
// The receiver follows fldigi: mix the centre tone to 0 Hz, low-pass, decimate
// by 32, correlate the last symbol against every tone's pulse-shaped reference,
// take the two strongest, and look the pair up. Symbol timing comes from the
// peak of the pulse-filtered envelope; AFC from the phase rotation of the
// strongest tone over one decimated sample.
//
// Interface mirrors mfsk.js:
//   new ThrobDecoder({sampleRate, centerHz, mode, squelch,
//                     onChar, onStatus, onMetrics});
//   .feed(Float32Array pcm)   .setSquelch(v)   .reset()

import { MovAvg, LinearResampler } from './fldigiFec.js';

const RATE = 8000;               // THROB_SAMPLE_RATE
const DOWN = 32;                 // DOWN_SAMPLE
const LPF_TAPS = 2047;           // stands in for fldigi's 8192-point FFT filter
const AFC_LIMIT = 30;            // Hz either side of the operator's centre

const NAR9 = [-32, -24, -16, -8, 0, 8, 16, 24, 32];
const WID9 = [-64, -48, -32, -16, 0, 16, 32, 48, 64];
const NAR11 = [-39.0625, -31.25, -23.4375, -15.625, -7.8125, 0, 7.8125, 15.625, 23.4375, 31.25, 39.0625];
const WID11 = [-78.125, -62.5, -46.875, -31.25, -15.625, 0, 15.625, 31.25, 46.875, 62.5, 78.125];

export const THROB_MODES = [
  { key: 'throb1', label: 'THROB 1', symlen: 8192, x: false, freqs: NAR9, bw: 36, semi: true },
  { key: 'throb2', label: 'THROB 2', symlen: 4096, x: false, freqs: NAR9, bw: 36, semi: true },
  { key: 'throb4', label: 'THROB 4', symlen: 2048, x: false, freqs: WID9, bw: 72, semi: false },
  { key: 'throbx1', label: 'THROBX 1', symlen: 8192, x: true, freqs: NAR11, bw: 47, semi: true },
  { key: 'throbx2', label: 'THROBX 2', symlen: 4096, x: true, freqs: NAR11, bw: 47, semi: true },
  { key: 'throbx4', label: 'THROBX 4', symlen: 2048, x: true, freqs: WID11, bw: 94, semi: false },
];

/** Occupied bandwidth (first to last tone) of a sub-mode, in Hz. */
export function throbBandwidth(key) {
  const m = THROB_MODES.find((x) => x.key === key) || THROB_MODES[0];
  return m.freqs[m.freqs.length - 1] - m.freqs[0];
}

// Squelch on the S/N fldigi shows for THROB (dB, 0 = always print). Noise
// alone stays under 1 dB; the real recordings copy at 14 dB and up.
export const THROB_SQUELCH_DEFAULT = 4;

// Tone pairs (1-based, as fldigi) and the characters they carry.
const THROB_PAIRS = [
  [5, 5], [4, 5], [1, 2], [1, 3], [1, 4], [4, 6], [1, 5], [1, 6], [1, 7], [3, 7],
  [1, 8], [2, 3], [2, 4], [2, 8], [2, 5], [5, 6], [2, 6], [2, 9], [3, 4], [3, 5],
  [1, 9], [3, 6], [8, 9], [3, 8], [3, 3], [2, 2], [1, 1], [3, 9], [4, 7], [4, 8],
  [4, 9], [5, 7], [5, 8], [5, 9], [6, 7], [6, 8], [6, 9], [7, 8], [7, 9], [8, 8],
  [7, 7], [6, 6], [4, 4], [9, 9], [2, 7],
];
const THROB_CHARS = '\0ABCD\0FGHIJKLMNOPQRSTUVWXYZ1234567890,.\'/)(E ';

const THROBX_PAIRS = [
  [6, 11], [1, 6], [2, 6], [2, 5], [2, 7], [2, 8], [5, 6], [2, 9], [2, 10], [4, 8],
  [4, 6], [2, 11], [3, 4], [3, 5], [3, 6], [6, 9], [6, 10], [3, 7], [3, 8], [3, 9],
  [6, 8], [6, 7], [3, 10], [3, 11], [4, 5], [4, 7], [4, 9], [4, 10], [1, 2], [1, 3],
  [1, 4], [1, 5], [1, 7], [1, 8], [1, 9], [1, 10], [2, 3], [2, 4], [4, 11], [5, 7],
  [5, 8], [5, 9], [5, 10], [5, 11], [7, 8], [7, 9], [7, 10], [7, 11], [8, 9], [8, 10],
  [8, 11], [9, 10], [9, 11], [10, 11], [1, 11],
];
const THROBX_CHARS = '\0 ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890,.\'/)(#"+-;:?!@=\n';

/** Test helper: the tone pair (0-based) fldigi keys for a character index. */
export function throbPair(modeKey, index) {
  const m = THROB_MODES.find((x) => x.key === modeKey);
  const p = (m.x ? THROBX_PAIRS : THROB_PAIRS)[index];
  return [p[0] - 1, p[1] - 1];
}
export { THROB_CHARS, THROBX_CHARS };

function semiPulse(len) {
  const p = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    if (i < len / 5) p[i] = 0.5 * (1 - Math.cos(Math.PI * i / (len / 5)));
    if (i >= len / 5 && i < len * 4 / 5) p[i] = 1;
    if (i >= len * 4 / 5) {
      const j = i - Math.floor(len * 4 / 5);
      p[i] = 0.5 * (1 + Math.cos(Math.PI * j / (len / 5)));
    }
  }
  return p;
}

function fullPulse(len) {
  const p = new Float64Array(len);
  for (let i = 0; i < len; i++) p[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / len));
  return p;
}

/** Test helper: the pulse fldigi shapes a symbol with. */
export function throbPulse(modeKey) {
  const m = THROB_MODES.find((x) => x.key === modeKey);
  return m.semi ? semiPulse(m.symlen) : fullPulse(m.symlen);
}

function _clampSquelch(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return THROB_SQUELCH_DEFAULT;
  return Math.max(0, Math.min(40, n));
}

export class ThrobDecoder {
  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate
      : (() => Number(options.sampleRate) || 12000);
    this._mode = THROB_MODES.find((m) => m.key === options.mode) || THROB_MODES[1];
    this._centerHz = Number(options.centerHz) || 1000;
    this._squelch = _clampSquelch(options.squelch);
    this.onChar    = typeof options.onChar    === 'function' ? options.onChar    : null;
    this.onStatus  = typeof options.onStatus  === 'function' ? options.onStatus  : null;
    this.onMetrics = typeof options.onMetrics === 'function' ? options.onMetrics : null;
    this._preset();
  }

  setSquelch(v) { this._squelch = _clampSquelch(v); }

  reset() { this._preset(); }

  feed(pcm) {
    if (!pcm || !pcm.length) return;
    this._rs.run(pcm, this._sampleRateFn() || 12000, this._sink);
    this._maybeEmitMetrics();
  }

  _preset() {
    const m = this._mode;
    this._freqs = m.freqs;
    this._ntones = m.freqs.length;
    this._rxsymlen = m.symlen / DOWN;
    const pulse = m.semi ? semiPulse(m.symlen) : fullPulse(m.symlen);
    const fp = m.semi ? semiPulse(this._rxsymlen) : fullPulse(this._rxsymlen);
    this._syncTaps = fp;

    // Decimated, pulse-shaped references for each tone (mk_rxtone).
    const L = this._rxsymlen;
    this._toneRe = []; this._toneIm = [];
    for (const f of m.freqs) {
      const re = new Float64Array(L), im = new Float64Array(L);
      for (let i = 0; i < m.symlen; i += DOWN) {
        const x = -2 * Math.PI * f * i / RATE;
        re[i / DOWN] = pulse[i] * Math.cos(x);
        im[i / DOWN] = pulse[i] * Math.sin(x);
      }
      this._toneRe.push(re); this._toneIm.push(im);
    }

    // Low-pass at the mode's bandwidth (real taps), evaluated only at the
    // decimation points.
    const M = (LPF_TAPS - 1) / 2, x = 2 * m.bw / RATE;
    this._lpf = new Float64Array(LPF_TAPS);
    for (let i = 0; i < LPF_TAPS; i++) {
      const t = i - M;
      const sinc = t === 0 ? x : Math.sin(Math.PI * x * t) / (Math.PI * t);
      this._lpf[i] = sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (LPF_TAPS - 1)));
    }
    this._bufRe = new Float64Array(2 * LPF_TAPS);
    this._bufIm = new Float64Array(2 * LPF_TAPS);
    this._bufPos = 0;

    this._freq = this._centerHz;
    this._phase = 0;
    this._deccntr = 0;
    this._rxcntr = L;
    this._waitsync = 1;
    this._symptr = 0;
    this._symRe = new Float64Array(L);
    this._symIm = new Float64Array(L);
    this._syncIn = new Float64Array(L);   // last L envelope samples (Irun window)
    this._syncInPos = 0;
    this._syncbuf = new Float64Array(L);
    this._snfilter = new MovAvg(16);
    this._metric = 0;
    this._s2n = 0;
    this._shift = false;
    this._lastchar = 0;
    this._idlesym = 0;
    this._spacesym = m.x ? 1 : 44;
    this._samples = 0;
    this._lastMetricsAt = 0;
    this._lastPrinted = -1e9;
    this._rs = new LinearResampler(RATE);
    this._sink = (v) => this._sample(v);
  }

  _sample(v) {
    this._samples++;
    // mixer(): multiply by e^{j phase}, phase decreasing at the centre frequency.
    const c = Math.cos(this._phase), s = Math.sin(this._phase);
    this._phase -= 2 * Math.PI * this._freq / RATE;
    if (this._phase < 0) this._phase += 2 * Math.PI;
    const T = LPF_TAPS;
    let p = this._bufPos;
    const zr = v * c, zi = v * s;
    this._bufRe[p] = zr; this._bufRe[p + T] = zr;
    this._bufIm[p] = zi; this._bufIm[p + T] = zi;
    p = p + 1 === T ? 0 : p + 1;
    this._bufPos = p;
    if (++this._deccntr < DOWN) return;
    this._deccntr = 0;

    let ar = 0, ai = 0;
    const h = this._lpf, br = this._bufRe, bi = this._bufIm;
    for (let k = 0; k < T; k++) { ar += br[p + k] * h[k]; ai += bi[p + k] * h[k]; }

    this._rxcntr -= 1;
    this._sync(ar, ai);
    this._rx(ar, ai);
    this._symptr = (this._symptr + 1) % this._rxsymlen;
  }

  _sync(re, im) {
    const L = this._rxsymlen;
    // syncfilt->Irun(): the FIR sees the L samples BEFORE this one.
    const w = this._syncIn, taps = this._syncTaps;
    let f = 0;
    for (let k = 0; k < L; k++) f += w[(this._syncInPos + k) % L] * taps[k];
    w[this._syncInPos] = Math.hypot(re, im);
    this._syncInPos = (this._syncInPos + 1) % L;
    this._syncbuf[this._symptr] = f;

    if (this._waitsync === 0 || this._rxcntr > L / 2) return;
    let maxval = 0, maxpos = 0;
    for (let i = 0; i < L; i++) {
      const v = this._syncbuf[(i + this._symptr + 1) % L];
      if (v > maxval) { maxval = v; maxpos = i; }
    }
    this._rxcntr += (maxpos - L / 2) / (this._ntones - 1);
    this._waitsync = 0;
  }

  _corr(t, start) {
    const L = this._rxsymlen, a = this._toneRe[t], b = this._toneIm[t];
    let zr = 0, zi = 0, q = start % L;
    for (let i = 0; i < L; i++) {
      const xr = this._symRe[q], xi = this._symIm[q];
      zr += a[i] * xr - b[i] * xi;
      zi += a[i] * xi + b[i] * xr;
      q = q + 1 === L ? 0 : q + 1;
    }
    return [zr, zi];
  }

  _rx(re, im) {
    this._symRe[this._symptr] = re;
    this._symIm[this._symptr] = im;
    if (this._rxcntr > 0) return;

    const n = this._ntones;
    const words = [];
    for (let i = 0; i < n; i++) words.push(this._corr(i, this._symptr + 1));
    const mag = words.map((w) => Math.hypot(w[0], w[1]));

    let max1 = 0, tone1 = 0;
    for (let i = 0; i < n; i++) if (mag[i] > max1) { max1 = mag[i]; tone1 = i; }
    const maxtone = tone1;
    let max2 = 0, tone2 = 0;
    for (let i = 0; i < n; i++) if (i !== tone1 && mag[i] > max2) { max2 = mag[i]; tone2 = i; }
    if (!this._mode.x && max1 > max2 * 2) tone2 = tone1;
    if (tone1 > tone2) { const t = tone1; tone1 = tone2; tone2 = t; }
    let signal = 0, noise = 0;
    for (let i = 0; i < n; i++) {
      if (i === tone1 || i === tone2) signal += mag[i] / 2;
      else noise += mag[i] / (n - 2);
    }
    this._metric = this._snfilter.run(signal / (noise + 1e-6));
    this._s2n = Math.max(0, Math.min(100, 10 * Math.log10(this._metric) - 3));

    this._decodechar(tone1, tone2);

    // AFC: phase step of the strongest tone over one decimated sample.
    if (this._open()) {
      const z1 = words[maxtone];
      const z2 = this._corr(maxtone, this._symptr + 2);
      // arg(conj(z1) * z2)
      const pr = z1[0] * z2[0] + z1[1] * z2[1];
      const pi = z1[0] * z2[1] - z1[1] * z2[0];
      let f = Math.atan2(pi, pr) / (2 * DOWN * Math.PI / RATE);
      f -= this._freqs[maxtone];
      const nf = this._freq + f / (n - 1);
      this._freq = Math.max(this._centerHz - AFC_LIMIT, Math.min(this._centerHz + AFC_LIMIT, nf));
    }

    this._rxcntr = this._rxsymlen;
    this._waitsync = 1;
  }

  _open() { return this._squelch <= 0 || this._s2n > this._squelch; }

  _show(ch) {
    if (!this._open() || !this.onChar) return;
    this._lastPrinted = this._samples;
    this.onChar(ch);
  }

  _decodechar(t1, t2) {
    if (!this._mode.x) {
      if (this._shift) {
        if (t1 === 0 && t2 === 8) this._show('?');
        if (t1 === 1 && t2 === 7) this._show('@');
        if (t1 === 2 && t2 === 6) this._show('=');
        if (t1 === 4 && t2 === 4) this._show('\n');
        this._shift = false;
        return;
      }
      if (t1 === 3 && t2 === 5) { this._shift = true; return; }
      for (let i = 0; i < THROB_PAIRS.length; i++) {
        if (THROB_PAIRS[i][0] === t1 + 1 && THROB_PAIRS[i][1] === t2 + 1) {
          const ch = THROB_CHARS[i];
          if (ch !== '\0') this._show(ch);
          break;
        }
      }
      return;
    }
    for (let i = 0; i < THROBX_PAIRS.length; i++) {
      if (THROBX_PAIRS[i][0] !== t1 + 1 || THROBX_PAIRS[i][1] !== t2 + 1) continue;
      if (i === this._spacesym || i === this._idlesym) {
        if (this._lastchar !== 0 && this._lastchar !== ' ') {
          this._show(' ');
          this._lastchar = ' ';
        } else {
          this._lastchar = 0;
        }
        // flip_syms(): space and idle swap after every use.
        if (this._idlesym === 0) { this._idlesym = 1; this._spacesym = 0; } else { this._idlesym = 0; this._spacesym = 1; }
      } else {
        this._show(THROBX_CHARS[i]);
        this._lastchar = THROBX_CHARS[i];
      }
    }
  }

  _maybeEmitMetrics() {
    if (this._samples - this._lastMetricsAt < RATE / 4) return;
    this._lastMetricsAt = this._samples;
    if (!this.onMetrics) return;
    const open = this._open();
    this.onMetrics({
      snrDb: Math.round(this._s2n * 10) / 10,
      lockQuality: Math.round(Math.min(100, this._s2n * 5)),
      centerHz: Math.round(this._freq),
      timingLocked: open && this._samples - this._lastPrinted < 3 * this._mode.symlen,
      squelchOpen: open,
    });
  }
}

export default ThrobDecoder;
