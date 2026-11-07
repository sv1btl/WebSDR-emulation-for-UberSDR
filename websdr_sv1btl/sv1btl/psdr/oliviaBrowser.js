// oliviaBrowser.js — Olivia / Contestia signal browser for the FLDIGI window
// ============================================================================
// Decodes every Olivia (or Contestia) signal of ONE configuration (tones /
// bandwidth) in the passband at once, one line per signal.
//
// Olivia is used mostly below the noise, so the signals are not found by
// their energy (that would miss exactly the weak ones). Instead the passband
// is tiled with ordinary OliviaDecoder instances (olivia.js): each one
// searches ±4 tone spacings around its own centre for sync, so tiles 1.5 x
// that margin apart leave no gap. Each decoder keeps its own squelch and
// block-quality guard, so a tile on noise prints nothing. A signal that sits
// between two tiles is found by both; the copies are merged by the frequency
// each decoder locked on.
//
// Interface:
//   new OliviaBrowser({ sampleRate, tones, bandwidth, contestia,
//                       syncThreshold, lowHz, highHz, onUpdate, onStatus })
//   .feed(Float32Array); .reset(); .setSyncThreshold(v)
//   onUpdate([{ id, hz, text, lock, snrDb, last }])  about 4 times a second
// ============================================================================

// SV1BTL (websdr_sv1btl): ?v= tags on the imports below so browsers fetch the updated files
// (UberSDR serves them without cache headers); otherwise unchanged from PhantomSDR-Plus.
import { OliviaDecoder } from './olivia.js?v=20261105';

const TEXT_KEEP = 4000;      // per line; the page shows ~6 lines and scrolls back (▲ ▼)
const FORGET_AFTER_MS = 120000;   // a line with no new text this long is dropped
const MAX_TILES = 24;

export class OliviaBrowser {
  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate : (() => Number(options.sampleRate) || 12000);
    this._tones = Number(options.tones) || 8;
    this._bandwidth = Number(options.bandwidth) || 250;
    this._contestia = !!options.contestia;
    this._syncThreshold = options.syncThreshold;
    this._lo = Number(options.lowHz) || 300;
    this._hi = Number(options.highHz) || 2700;
    this.onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null;
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
    // test hook: a clock other than Date.now()
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.reset();
  }

  /** Tile centres: the decoder searches ±4 tone spacings (SYNC_MARGIN = 8 bins of half a spacing). */
  _centres() {
    const spacing = this._bandwidth / this._tones;
    const margin = 4 * spacing;
    const step = Math.max(20, 1.5 * margin);
    const first = this._lo + this._bandwidth / 2;
    const last = this._hi - this._bandwidth / 2;
    const out = [];
    if (last < first) return [(this._lo + this._hi) / 2];
    const n = Math.min(MAX_TILES, Math.floor((last - first) / step) + 1);
    const used = (n - 1) * step;
    const start = first + ((last - first) - used) / 2;
    for (let i = 0; i < n; i++) out.push(start + i * step);
    return out;
  }

  reset() {
    this._tiles = this._centres().map((hz, i) => {
      const t = { id: i + 1, hz, text: '', last: 0, lockedHz: hz, q: [] };
      t.dec = new OliviaDecoder({
        sampleRate: this._sampleRateFn, centerHz: hz,
        tones: this._tones, bandwidth: this._bandwidth, contestia: this._contestia,
        syncThreshold: this._syncThreshold,
        onChar: (c) => {
          t.text = (t.text + (c === '\n' || c === '\r' ? ' ' : c)).slice(-TEXT_KEEP);
          t.last = this._now();
          t.lockedHz = hz + t.dec.frequencyOffsetHz;
          t.q.push(t.dec.snrDb);
          if (t.q.length > 30) t.q.shift();
        },
      });
      return t;
    });
    this._lastUpdate = 0;
    this._lastCount = -1;
  }

  setSyncThreshold(v) {
    this._syncThreshold = v;
    for (const t of this._tiles) t.dec.setSyncThreshold(v);
  }

  feed(pcm) {
    if (!pcm || !pcm.length) return;
    for (const t of this._tiles) t.dec.feed(pcm);
    const now = this._now();
    if (now - this._lastUpdate >= 250) { this._lastUpdate = now; this._emit(now); }
  }

  /** Sync S/N (dB) the tile's characters were printed at: the median of the last 30. */
  static _quality(t) {
    if (!t.q.length) return 0;
    const q = t.q.slice().sort((a, b) => a - b);
    return q[q.length >> 1];
  }

  /**
   * The lines to show: tiles with recent text, one per signal. Two real
   * Olivia signals cannot sit closer than one bandwidth without overlapping,
   * so within one bandwidth only the strongest lock is kept. That removes both
   * the second copy of a signal found by two tiles and the garbage a tile
   * prints when it locks a few tones off a strong neighbour (measured: those
   * lock 4 tone spacings away, at a sync S/N well below the real copy's).
   */
  /**
   * Text that looks like text: mostly letters, digits and spaces, with a space
   * now and then. A tile that locks onto something that is not a message — a
   * strong neighbour a few tones off, or another kind of signal — passes the
   * FEC with runs like "@@@``q`" or "AU)D:P4H\"J:C3N6O:G": no spaces, a third
   * punctuation. Measured on the fldigi recordings: every real line passes.
   * At least 4 characters too: a lone "V" came up on air at 14074 kHz (FT8).
   */
  static _plausible(text) {
    const t = text.trim().slice(-60);
    // A stray block on another mode's signal (FT8 next door) can pass the FEC
    // once and print a lone character; real copy brings several per block.
    if (t.replace(/ /g, '').length < 4) return false;
    const words = (t.match(/[A-Za-z0-9 ]/g) || []).length;
    const spaces = (t.match(/ /g) || []).length;
    return words >= 0.8 * t.length && spaces >= Math.floor(t.length / 16);
  }

  _signals(now) {
    const live = this._tiles.filter((t) => t.text && now - t.last < FORGET_AFTER_MS && OliviaBrowser._plausible(t.text));
    const merge = this._bandwidth * 0.95;
    live.sort((a, b) => (OliviaBrowser._quality(b) - OliviaBrowser._quality(a)) || (b.text.length - a.text.length));
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
      lock: Math.round(t.dec.lockQuality),
      snrDb: Math.round(t.dec.snrDb),
      last: t.last,
    })));
  }
}

export default OliviaBrowser;
