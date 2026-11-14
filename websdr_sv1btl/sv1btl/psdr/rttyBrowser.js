// rttyBrowser.js — amateur RTTY signal browser for the FLDIGI window
// ============================================================================
// Decodes every RTTY signal of one shift / baud in the passband at once, one
// line per signal, as fldigi's signal browser does.
//
// Detection, as in pskBrowser.js: every half second an FFT of the last
// ~0.34 s is folded into an averaged spectrum and smoothed over one baud (each
// tone is a hump about a baud wide). An RTTY signal is TWO such humps one
// shift apart, both on, so the score at a centre f is the weaker of the two
// tones at f ± shift/2; local maxima well over the noise floor (the median)
// are candidate signals. A lone carrier scores nothing (its partner is
// noise). Each new signal gets its own ordinary RTTY decoder (KiwiFSKDecoder,
// role 'fsk', variant 'ham', with the window's shift / baud / framing / invert
// / squelch), which does all the decoding; its adaptive threshold absorbs the
// few Hz the centre estimate is off. Its auto-shift and auto-centre are off:
// they would wander onto a neighbour.
//
// Two real signals 340 Hz apart put a false pair (one's space, the other's
// mark) in between; it decodes garbage, so a line shows only once its text
// looks like text, and within shift + baud of each other only the line with
// the better S/N is kept.
//
// The decoder class is passed in (makeDecoder) so this module does not import
// fsk.js, which imports it.
//
// Interface:
//   new RttyBrowser({ sampleRate, config, makeDecoder, lowHz, highHz, onUpdate, onStatus })
//   .feed(Float32Array); .reset(); .setSquelch(dB)
//   onUpdate([{ id, hz, text, lock, snrDb, last }])  about 4 times a second
// ============================================================================

import { transformFlat } from './lib/fftRadix2.js';

const FFT_N = 4096;
const MAX_CHANNELS = 16;
const DETECT_DB = 7;             // the weaker tone's smoothed peak over the median floor
const DROP_AFTER_MS = 30000;     // silent and gone this long: dropped
const TEXT_KEEP = 4000;          // per line; the page shows ~6 lines and scrolls back

// The channel's own IF filter. Every channel otherwise hears the whole
// passband: a +20 dB station 300 Hz away wiped out a 0 dB one, which the single
// decoder copies clean behind the server's brick-wall passband — and a
// 4th-order Butterworth was not enough either (measured). So each channel gets
// a 1025-tap Blackman band-pass, -6 dB at centre ± (shift/2 + 1.43 baud) (the
// width the window sets for one signal, ±150 Hz for 170 Hz / 45.45 Bd), ~60 Hz
// transition, applied by overlap-save: one forward FFT of the audio per block,
// shared, then per channel a multiply and an inverse FFT.
const OS_N = 2048;              // FFT size
const OS_B = 1024;              // new samples per block (valid part)
const OS_M = OS_N - OS_B + 1;   // FIR length

function _bandpassSpectrum(centerHz, halfHz, sr) {
  const re = new Float64Array(OS_N), im = new Float64Array(OS_N);
  const mid = (OS_M - 1) / 2, f1 = Math.max(0, centerHz - halfHz) / sr, f2 = Math.min(sr / 2, centerHz + halfHz) / sr;
  for (let n = 0; n < OS_M; n++) {
    const t = n - mid;
    const ideal = t === 0 ? 2 * (f2 - f1) : (Math.sin(2 * Math.PI * f2 * t) - Math.sin(2 * Math.PI * f1 * t)) / (Math.PI * t);
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / (OS_M - 1)) + 0.08 * Math.cos(4 * Math.PI * n / (OS_M - 1));
    re[n] = ideal * w;
  }
  transformFlat(re, im, false);
  return { re, im };
}

export class RttyBrowser {
  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate : (() => Number(options.sampleRate) || 12000);
    const cfg = { ...(options.config || {}) };
    delete cfg.browse;
    this._cfg = cfg;
    this._shift = Math.max(20, Number(cfg.shift) || 170);
    this._baud = Math.max(10, Number(cfg.baud) || 45.45);
    this._make = options.makeDecoder;
    this._lo = Number(options.lowHz) || 300;
    this._hi = Number(options.highHz) || 2700;
    this.onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null;
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
    // test hook: a clock other than Date.now()
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.reset();
  }

  reset() {
    this._ring = new Float32Array(FFT_N);
    this._ringPos = 0;
    this._filled = 0;
    this._sinceScan = 0;
    this._avg = null;
    this._channels = [];
    this._nextId = 1;
    this._lastUpdate = 0;
    this._lastCount = -1;
    this._osIn = new Float64Array(OS_N);   // last OS_N input samples
    this._osFill = 0;                      // new samples since the last block
    this._osOut = new Float32Array(OS_B);
  }

  setSquelch(db) {
    this._cfg = { ...this._cfg, squelch: Number(db) };
    for (const ch of this._channels) ch.dec.setConfig({ ...this._cfg, center: ch.hz });
  }

  feed(pcm) {
    if (!pcm || !pcm.length) return;
    const sr = this._sampleRateFn() || 12000;
    for (let n = 0; n < pcm.length; n++) {
      this._ring[this._ringPos] = pcm[n];
      this._ringPos = (this._ringPos + 1) % FFT_N;
    }
    this._filled = Math.min(FFT_N, this._filled + pcm.length);
    for (let n = 0; n < pcm.length; n++) {
      this._osIn[OS_N - OS_B + this._osFill] = pcm[n];
      if (++this._osFill === OS_B) { this._osFill = 0; this._block(sr); }
    }
    this._sinceScan += pcm.length;
    if (this._sinceScan >= sr / 2 && this._filled >= FFT_N) {
      this._sinceScan = 0;
      this._scan(sr);
    }
    const now = this._now();
    if (now - this._lastUpdate >= 250) { this._lastUpdate = now; this._emit(now); }
  }

  /** One overlap-save block: every channel gets OS_B filtered samples. */
  _block(sr) {
    const inp = this._osIn;
    if (this._channels.length) {
      const xr = Float64Array.from(inp), xi = new Float64Array(OS_N);
      transformFlat(xr, xi, false);
      const yr = new Float64Array(OS_N), yi = new Float64Array(OS_N);
      for (const ch of this._channels) {
        if (!ch.H || ch.Hsr !== sr) { ch.H = _bandpassSpectrum(ch.hz, this._shift / 2 + 1.43 * this._baud, sr); ch.Hsr = sr; }
        const hr = ch.H.re, hi = ch.H.im;
        for (let k = 0; k < OS_N; k++) {
          yr[k] = xr[k] * hr[k] - xi[k] * hi[k];
          yi[k] = xr[k] * hi[k] + xi[k] * hr[k];
        }
        transformFlat(yr, yi, true);
        const out = this._osOut;
        for (let n = 0; n < OS_B; n++) out[n] = yr[OS_M - 1 + n];
        ch.dec.feedPCM(out);
      }
    }
    inp.copyWithin(0, OS_B);   // keep the last OS_N - OS_B samples as history
  }

  _scan(sr) {
    const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N);
    for (let k = 0; k < FFT_N; k++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / FFT_N);
      re[k] = this._ring[(this._ringPos + k) % FFT_N] * w;
    }
    transformFlat(re, im, false);
    const bin = sr / FFT_N;
    const half = Math.round(this._shift / 2 / bin);
    const lo = Math.max(1, Math.floor(this._lo / bin)), hi = Math.min(FFT_N / 2 - 1, Math.ceil(this._hi / bin));
    if (!this._avg || this._avg.length !== FFT_N / 2) this._avg = new Float64Array(FFT_N / 2);
    for (let k = lo; k <= hi; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      this._avg[k] = this._avg[k] ? this._avg[k] + 0.3 * (p - this._avg[k]) : p;
    }
    // smooth over one baud (a tone's width)
    const w = Math.max(1, Math.round(this._baud / 2 / bin));
    const sm = new Float64Array(FFT_N / 2);
    for (let k = lo; k <= hi; k++) {
      let acc = 0;
      for (let j = -w; j <= w; j++) acc += this._avg[Math.min(hi, Math.max(lo, k + j))];
      sm[k] = acc / (2 * w + 1);
    }
    const sorted = Array.from(sm.subarray(lo, hi + 1)).sort((a, b) => a - b);
    const floor = sorted[sorted.length >> 1] || 1e-30;
    const thr = floor * Math.pow(10, DETECT_DB / 10);
    // pair score at each centre: the weaker of the two tones
    const c0 = lo + half, c1 = hi - half;
    const score = new Float64Array(FFT_N / 2);
    for (let k = c0; k <= c1; k++) score[k] = Math.min(sm[k - half], sm[k + half]);
    const guard = Math.max(2, Math.round(Math.max(30, 0.4 * this._shift) / bin));
    const peaks = [];
    for (let k = c0 + 1; k < c1; k++) {
      if (score[k] < thr) continue;
      let isMax = true;
      for (let j = -guard; j <= guard && isMax; j++) {
        const q = k + j;
        if (j && q >= c0 && q <= c1 && score[q] > score[k]) isMax = false;
      }
      if (!isMax) continue;
      // The centre is the midpoint of the two tones, each found on its own:
      // the score's own peak leans away from a strong neighbour's skirt
      // (measured 25 Hz off next to a +20 dB station).
      const tone = (k0) => {
        let best = k0;
        for (let j = -w; j <= w; j++) { const q = k0 + j; if (q > lo && q < hi && sm[q] > sm[best]) best = q; }
        const a = sm[best - 1], b = sm[best], c = sm[best + 1], d = a - 2 * b + c;
        return best + (d < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d)) : 0);
      };
      peaks.push({ hz: 0.5 * (tone(k - half) + tone(k + half)) * bin, p: score[k] });
    }
    peaks.sort((x, y) => y.p - x.p);
    const now = this._now();
    // keep channels alive while their two tones are there
    for (const ch of this._channels) {
      const k = Math.round(ch.hz / bin);
      if (k >= c0 && k <= c1 && score[k] > thr / 2) ch.seen = now;
    }
    const minSpacing = Math.max(40, 0.6 * this._shift);
    for (const pk of peaks) {
      if (this._channels.length >= MAX_CHANNELS) break;
      if (this._channels.some((c) => Math.abs(c.hz - pk.hz) < minSpacing)) continue;
      this._open(pk.hz, now);
    }
    this._channels = this._channels.filter((c) => now - Math.max(c.seen, c.last) < DROP_AFTER_MS);
  }

  _open(hz, now) {
    const ch = { id: this._nextId++, hz: Math.round(hz), text: '', seen: now, last: 0 };
    ch.dec = this._make({
      role: 'fsk', variant: 'ham', sampleRate: this._sampleRateFn, noAuto: true,
      config: { ...this._cfg, center: ch.hz },
      callback: (e) => {
        if (e.type !== 'char') return;
        const c = e.char;
        ch.text = (ch.text + (c === '\n' || c === '\r' ? ' ' : c)).slice(-TEXT_KEEP);
        if (c !== '\n' && c !== '\r' && c !== ' ') ch.last = this._now();
      },
    });
    ch.dec.setAutoShift(false);
    ch.dec.setEnabled(true);
    this._channels.push(ch);
  }

  /** Text that looks like text (as the Olivia Browser): ITA2 garbage is FIGS punctuation without spaces. */
  static _plausible(text) {
    const t = text.trim().slice(-60);
    if (t.replace(/ /g, '').length < 4) return false;
    const words = (t.match(/[A-Za-z0-9 ]/g) || []).length;
    const spaces = (t.match(/ /g) || []).length;
    return words >= 0.75 * t.length && spaces >= Math.floor(t.length / 16);
  }

  static _snr(ch) { return Number.isFinite(ch.dec._fskSnrDb) ? ch.dec._fskSnrDb : -30; }

  static _lock(ch) {
    const ok = ch.dec._fskCharsDecoded || 0, bad = ch.dec._fskInvalidFrames || 0;
    return Math.round(100 * ok / Math.max(1, ok + bad));
  }

  _signals(now) {
    const live = this._channels.filter((c) => c.text && now - c.last < DROP_AFTER_MS && RttyBrowser._plausible(c.text));
    const merge = this._shift + this._baud;
    live.sort((a, b) => (RttyBrowser._snr(b) - RttyBrowser._snr(a)) || (b.text.length - a.text.length));
    const out = [];
    for (const c of live) {
      if (out.some((o) => Math.abs(o.hz - c.hz) < merge)) continue;
      out.push(c);
    }
    return out.sort((a, b) => a.hz - b.hz);
  }

  _emit(now) {
    const sig = this._signals(now);
    if (this.onStatus && sig.length !== this._lastCount) {
      this._lastCount = sig.length;
      this.onStatus(`${sig.length} signal${sig.length === 1 ? '' : 's'}`);
    }
    if (!this.onUpdate) return;
    this.onUpdate(sig.map((c) => ({
      id: c.id,
      hz: c.hz,
      text: c.text,
      lock: RttyBrowser._lock(c),
      snrDb: Math.round(RttyBrowser._snr(c)),
      last: c.last,
    })));
  }
}

export default RttyBrowser;
