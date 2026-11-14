// mfskBrowser.js — MFSK16 / MFSK32 / MFSK64 signal browser for the FLDIGI window
// ============================================================================
// Decodes every MFSK signal of ONE sub-mode in the passband at once, one line
// per signal, as oliviaBrowser.js does for Olivia.
//
// MFSK is a weak-signal mode (MFSK16 copies from about -12 dB in 2.5 kHz), so
// signals are not found by their energy. The passband is tiled with ordinary
// MfskDecoder instances (mfsk.js) instead: each one searches ±ACQ_RANGE (75 Hz)
// around its own centre for the 16-tone block, so tiles TILE_STEP apart leave
// no gap. Each decoder keeps its own squelch (the Viterbi metric), so a tile
// on noise prints nothing. A signal found by two tiles is merged by the
// frequency each decoder locked on.
//
// Interface:
//   new MfskBrowser({ sampleRate, mode, squelch, lowHz, highHz, onUpdate, onStatus })
//   .feed(Float32Array); .reset(); .setSquelch(v)
//   onUpdate([{ id, hz, text, lock, snrDb, last }])  about 4 times a second
// ============================================================================

// SV1BTL (websdr_sv1btl): ?v= tags on the imports below so browsers fetch the updated files
// (UberSDR serves them without cache headers); otherwise unchanged from PhantomSDR-Plus.
import { MfskDecoder, MFSK_MODES, mfskBandwidth } from './mfsk.js?v=20261114';

const TEXT_KEEP = 4000;            // per line; the page shows ~6 lines and scrolls back
const FORGET_AFTER_MS = 120000;    // a line with no new text this long is dropped
// Tile spacing, Hz. Measured offline (2026-11-14): MFSK16/32 acquire a block up
// to ±75 Hz off (more than 10-20 Hz off costs the first sentence while the
// search settles), MFSK64 copies only within about ±30 Hz.
const TILE_STEP = { mfsk16: 120, mfsk32: 120, mfsk64: 50 };
const MAX_TILES = 32;
const TEXT_WINDOW = 32;
// A line shows only while its tones change like real MFSK (mfsk.js toneRepeat,
// median over its last 30 characters). Measured 2026-11-14: real signals
// 0.06-0.11 in every mode; FT8 next door decoded as MFSK16 0.34-0.45, as
// MFSK32 / MFSK64 0.12-0.25, with a Viterbi metric well over the squelch.
const REPEAT_MAX = { mfsk16: 0.20, mfsk32: 0.15, mfsk64: 0.15 };            // the text tests look at this many latest characters

export class MfskBrowser {
  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate : (() => Number(options.sampleRate) || 12000);
    this._mode = MFSK_MODES.some((m) => m.key === options.mode) ? options.mode : MFSK_MODES[0].key;
    this._bandwidth = mfskBandwidth(this._mode);
    this._squelch = options.squelch;
    this._lo = Number(options.lowHz) || 300;
    this._hi = Number(options.highHz) || 2700;
    this.onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null;
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
    // test hook: a clock other than Date.now()
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.reset();
  }

  /** Tile centres: the whole block (centre ± bandwidth/2) inside lowHz..highHz. */
  _centres() {
    const first = this._lo + this._bandwidth / 2;
    const last = this._hi - this._bandwidth / 2;
    if (last < first) return [(this._lo + this._hi) / 2];
    const stepHz = TILE_STEP[this._mode] || 120;
    const n = Math.min(MAX_TILES, Math.floor((last - first) / stepHz) + 1);
    const step = n > 1 ? Math.max(stepHz, (last - first) / (n - 1)) : 0;
    const used = (n - 1) * step;
    const start = first + ((last - first) - used) / 2;
    const out = [];
    for (let i = 0; i < n; i++) out.push(start + i * step);
    return out;
  }

  reset() {
    this._tiles = this._centres().map((hz, i) => {
      const t = { id: i + 1, hz, text: '', last: 0, lockedHz: hz, q: [], rep: [] };
      t.dec = new MfskDecoder({
        sampleRate: this._sampleRateFn, centerHz: hz, mode: this._mode, squelch: this._squelch,
        onChar: (c) => {
          t.text = (t.text + (c === '\n' || c === '\r' ? ' ' : c)).slice(-TEXT_KEEP);
          t.last = this._now();
          t.lockedHz = hz + t.dec._freqErr;
          t.q.push(t.dec.lockQuality);
          if (t.q.length > 30) t.q.shift();
          t.rep.push(t.dec.toneRepeat);
          if (t.rep.length > 30) t.rep.shift();
        },
      });
      return t;
    });
    this._lastUpdate = 0;
    this._lastCount = -1;
  }

  setSquelch(v) {
    this._squelch = v;
    for (const t of this._tiles) t.dec.setSquelch(v);
  }

  feed(pcm) {
    if (!pcm || !pcm.length) return;
    for (const t of this._tiles) t.dec.feed(pcm);
    const now = this._now();
    if (now - this._lastUpdate >= 250) { this._lastUpdate = now; this._emit(now); }
  }

  /** Viterbi metric the tile's characters were printed at: the median of the last 30. */
  static _quality(t) {
    if (!t.q.length) return 0;
    const q = t.q.slice().sort((a, b) => a - b);
    return q[q.length >> 1];
  }

  /** Share of the latest characters that are letters, digits, spaces or . , ? / - */
  static _wordy(text) {
    const t = text.trim().slice(-TEXT_WINDOW);
    return t.length ? (t.match(/[A-Za-z0-9 .,?/-]/g) || []).length / t.length : 0;
  }

  /**
   * Text that looks like text: mostly letters, digits and spaces, with a space
   * now and then, and at least 4 characters (as the Olivia Browser). A tile
   * that sits next to a strong signal, or a few tones off one, opens its
   * squelch now and then and prints runs that carry Latin-1 bytes
   * (å ± ¢ ï Ú ¼ in the offline test) and brackets or symbols; real copy almost
   * never has more than one. Only the latest characters count,
   * so the junk a decoder prints while it acquires does not hold a good line back.
   */
  static _plausible(text) {
    const t = text.trim().slice(-TEXT_WINDOW);
    if (t.replace(/ /g, '').length < 4) return false;
    // At most one character outside plain text (letters, digits, . , ? / ' = : + ! -).
    if ((t.match(/[^A-Za-z0-9 .,?/'=:+!-]/g) || []).length > 1) return false;
    // At most one word with a capital after a small letter: the FT8 signals
    // at 14074 kHz make MFSK16 tiles print "etRetR treeSt eeoUv" at a
    // metric of 50 (squelch 22); real copy is all caps or ordinary case.
    if (t.split(' ').filter((w) => /[a-z][A-Z]/.test(w)).length > 1) return false;
    const spaces = (t.match(/ /g) || []).length;
    return MfskBrowser._wordy(t) >= 0.85 && spaces >= Math.floor(t.length / 16);
  }

  /** Median share of repeated tones over the tile's last 30 characters. */
  static _repeat(t) {
    if (!t.rep.length) return 1;
    const r = t.rep.slice().sort((a, b) => a - b);
    return r[r.length >> 1];
  }

  /**
   * One line per signal: two MFSK signals cannot sit closer than one
   * bandwidth without overlapping, so within one bandwidth only the best
   * line is kept (the one that reads most like text, then the best lock) —
   * the second copy of a signal found by two tiles, or a tile
   * that locked a tone or two off it.
   */
  _signals(now) {
    const repMax = REPEAT_MAX[this._mode] || 0.15;
    const live = this._tiles.filter((t) => t.text && now - t.last < FORGET_AFTER_MS &&
      MfskBrowser._repeat(t) < repMax && MfskBrowser._plausible(t.text));
    const merge = this._bandwidth * 0.95;
    live.sort((a, b) => (MfskBrowser._wordy(b.text) - MfskBrowser._wordy(a.text)) ||
      (MfskBrowser._quality(b) - MfskBrowser._quality(a)) || (b.text.length - a.text.length));
    const out = [];
    for (const t of live) {
      if (out.some((o) => Math.abs(o.lockedHz - t.lockedHz) < merge)) continue;
      out.push(t);
    }
    return out.sort((a, b) => a.lockedHz - b.lockedHz);
  }

  _emit(now) {
    const sig = this._signals(now);
    if (this.onStatus && sig.length !== this._lastCount) {
      this._lastCount = sig.length;
      this.onStatus(`${sig.length} signal${sig.length === 1 ? '' : 's'} · ${this._tiles.length} decoders`);
    }
    if (!this.onUpdate) return;
    this.onUpdate(sig.map((t) => ({
      id: t.id,
      hz: Math.round(t.lockedHz),
      text: t.text,
      lock: t.dec.lockQuality,
      snrDb: Math.round(t.dec.snrDb),
      last: t.last,
    })));
  }
}

export default MfskBrowser;
