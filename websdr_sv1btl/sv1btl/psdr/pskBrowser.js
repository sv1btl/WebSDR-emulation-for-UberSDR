// pskBrowser.js — PSK31 signal browser for the FLDIGI window (receive only)
// ============================================================================
// Decodes every BPSK31 signal in the passband at once, one line per signal,
// as fldigi's signal browser does. Detection: once a second a 1.46 Hz-bin FFT
// of the last ~0.7 s is folded into an averaged spectrum; a PSK31 signal is
// a hump about a baud wide (idle: two lines ±15.6 Hz), so the spectrum is
// smoothed over ±16 Hz and its local maxima well above the noise floor
// (the median) are candidate carriers. Each new one gets its own
// PSK31Demodulator (psk31.js, with its AFC and squelch), which does all the
// decoding; a channel that stays silent and weak is dropped, and two that
// drift onto the same signal are merged.
//
// Interface:
//   new PskBrowser({ sampleRate, lowHz, highHz, onUpdate, onStatus })
//   .feed(Float32Array); .reset();
//   onUpdate([{ id, hz, text, lock, snrDb, last }])  about 4 times a second
// ============================================================================

// SV1BTL (websdr_sv1btl): ?v= tags on the imports below so browsers fetch the updated files
// (UberSDR serves them without cache headers); otherwise unchanged from PhantomSDR-Plus.
import { PSK31Demodulator } from './psk31.js?v=20261106';
import { transformFlat } from './lib/fftRadix2.js';

const FFT_N = 8192;
const MAX_CHANNELS = 16;
const MIN_SPACING_HZ = 45;       // two channels closer than this are one signal
const DETECT_DB = 8;             // smoothed peak over the median floor
const DROP_AFTER_MS = 30000;     // silent and weak this long: dropped
const TEXT_KEEP = 4000;      // per line; the page shows ~6 lines and scrolls back (▲ ▼)

export class PskBrowser {
  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate : (() => Number(options.sampleRate) || 12000);
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
  }

  feed(pcm) {
    if (!pcm || !pcm.length) return;
    const sr = this._sampleRateFn() || 12000;
    for (let n = 0; n < pcm.length; n++) {
      this._ring[this._ringPos] = pcm[n];
      this._ringPos = (this._ringPos + 1) % FFT_N;
    }
    this._filled = Math.min(FFT_N, this._filled + pcm.length);
    for (const ch of this._channels) ch.dem.feed(pcm);
    this._sinceScan += pcm.length;
    if (this._sinceScan >= sr && this._filled >= FFT_N) {
      this._sinceScan = 0;
      this._scan(sr);
    }
    const now = this._now();
    if (now - this._lastUpdate >= 250) { this._lastUpdate = now; this._emit(); }
  }

  _scan(sr) {
    const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N);
    for (let k = 0; k < FFT_N; k++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / FFT_N);
      re[k] = this._ring[(this._ringPos + k) % FFT_N] * w;
    }
    transformFlat(re, im, false);
    const bin = sr / FFT_N;
    const lo = Math.max(1, Math.floor(this._lo / bin)), hi = Math.min(FFT_N / 2 - 1, Math.ceil(this._hi / bin));
    if (!this._avg || this._avg.length !== FFT_N / 2) this._avg = new Float64Array(FFT_N / 2);
    for (let k = lo; k <= hi; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      this._avg[k] = this._avg[k] ? this._avg[k] + 0.4 * (p - this._avg[k]) : p;
    }
    // smooth over ±16 Hz (a PSK31 signal's width)
    const half = Math.max(1, Math.round(16 / bin));
    const sm = new Float64Array(FFT_N / 2);
    let acc = 0;
    for (let k = lo; k <= hi; k++) {
      acc = 0;
      for (let j = -half; j <= half; j++) acc += this._avg[Math.min(hi, Math.max(lo, k + j))];
      sm[k] = acc / (2 * half + 1);
    }
    const sorted = Array.from(sm.subarray(lo, hi + 1)).sort((a, b) => a - b);
    const floor = sorted[sorted.length >> 1] || 1e-30;
    const thr = floor * Math.pow(10, DETECT_DB / 10);
    this._floor = floor;
    // local maxima above threshold, strongest first
    const peaks = [];
    const guard = Math.round(MIN_SPACING_HZ / bin);
    for (let k = lo + guard; k <= hi - guard; k++) {
      if (sm[k] < thr) continue;
      let isMax = true;
      for (let j = -guard; j <= guard && isMax; j++) if (j && sm[k + j] > sm[k]) isMax = false;
      if (isMax) peaks.push({ hz: k * bin, p: sm[k] });
    }
    peaks.sort((a, b) => b.p - a.p);
    const now = this._now();
    // keep channels alive while their signal is there
    for (const ch of this._channels) {
      const k = Math.round(ch.dem._baseCenter / bin + ch.dem._afcHz / bin);
      if (k > lo && k < hi && sm[k] > thr / 2) ch.seen = now;
    }
    for (const pk of peaks) {
      if (this._channels.length >= MAX_CHANNELS) break;
      if (this._channels.some((c) => Math.abs(this._chanHz(c) - pk.hz) < MIN_SPACING_HZ)) continue;
      this._open(pk.hz, now);
    }
    // drop silent, faded channels; merge ones that drifted together
    this._channels = this._channels.filter((c) => now - Math.max(c.seen, c.last) < DROP_AFTER_MS);
    this._channels.sort((a, b) => this._chanHz(a) - this._chanHz(b));
    for (let i = 1; i < this._channels.length; i++) {
      const a = this._channels[i - 1], b = this._channels[i];
      if (Math.abs(this._chanHz(a) - this._chanHz(b)) < 20) {
        const drop = a.text.length >= b.text.length ? b : a;
        this._channels = this._channels.filter((c) => c !== drop);
        i--;
      }
    }
    if (this.onStatus) this.onStatus(`${this._channels.length} signal${this._channels.length === 1 ? '' : 's'}`);
  }

  _chanHz(c) { return c.dem._baseCenter + c.dem._afcHz; }

  _open(hz, now) {
    const ch = { id: this._nextId++, text: '', seen: now, last: 0, opened: now };
    ch.dem = new PSK31Demodulator({
      sampleRate: this._sampleRateFn, centerHz: hz, mode: 'bpsk31', afc: true,
      onChar: (c) => {
        ch.text = (ch.text + (c === '\n' || c === '\r' ? ' ' : c)).slice(-TEXT_KEEP);
        ch.last = this._now();
      },
    });
    this._channels.push(ch);
  }

  _emit() {
    if (!this.onUpdate) return;
    this.onUpdate(this._channels.map((c) => ({
      id: c.id,
      hz: Math.round(this._chanHz(c)),
      text: c.text,
      lock: c.dem.lockQuality,
      snrDb: Math.round(c.dem.snrDb),
      last: c.last,
    })));
  }
}

export default PskBrowser;
