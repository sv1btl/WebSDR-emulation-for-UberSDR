// hell.js — Hellschreiber decoders (receive only): Feld Hell, Slow Hell,
// Hell X5 / X9 (on-off keyed) and FSK Hell 245 / 105 and Hell 80 (two tones).
//
// A port of the receive side of fldigi's src/feld/feld.cxx.
//
// How Hellschreiber works
//   There are no characters on the air, only a picture: the transmitter scans
//   each character of a 7 x 14 font column by column, bottom to top, keying
//   the carrier on for ink and off for paper (or, in the FSK modes, shifting
//   between two tones). The receiver does not decode anything: it paints what
//   it hears, one column at a time, and the reader's eye does the rest. That is
//   why Hell survives conditions no text mode does — a damaged character is
//   still readable as a smudged one — and why the output is an image.
//
//   Every column is painted twice, one above the other (fldigi does the same),
//   so that a small timing error between the stations slants the text instead
//   of cutting each letter in half: one of the two copies is always whole.
//
// The receiver follows fldigi: mix the carrier to 0 Hz, low-pass, then per
// pixel take the peak envelope (AM) or the frequency discriminator (FSK),
// normalised against a slowly decaying peak hold. fldigi's 20-pixel receive
// column is used.
//
// Interface:
//   new HellDecoder({sampleRate, centerHz, mode, reverse, onColumn, onMetrics});
//   .feed(Float32Array pcm)   .reset()
//   onColumn(Uint8Array(2 * HELL_COLUMN_LEN)) — ink 0..255 (255 = full ink),
//   pixel 0 at the BOTTOM of the column.

import { MovAvg, LinearResampler } from './fldigiFec.js';

const RATE = 8000;               // FeldSampleRate
export const HELL_COLUMN_LEN = 20;   // fldigi HellRcvHeight default
const AGC_DECAY = 0.075;         // hellagc = 2 (medium), the default

export const HELL_MODES = [
  { key: 'feld', label: 'Feld Hell', colrate: 17.5, fsk: false },
  { key: 'slowhell', label: 'Slow Hell', colrate: 2.1875, fsk: false },
  { key: 'hellx5', label: 'Hell X5', colrate: 87.5, fsk: false },
  { key: 'hellx9', label: 'Hell X9', colrate: 157.5, fsk: false },
  { key: 'fskh245', label: 'FSK Hell 245', colrate: 17.5, fsk: true, shift: 122.5 },
  { key: 'fskh105', label: 'FSK Hell 105', colrate: 17.5, fsk: true, shift: 55 },
  { key: 'hell80', label: 'Hell 80', colrate: 35, fsk: true, shift: 300 },
];

// fldigi transmits a 14-pixel column.
const TX_COLUMN_LEN = 14;

/** Occupied bandwidth of a sub-mode, in Hz (fldigi's hell_bandwidth). */
export function hellBandwidth(key) {
  const m = HELL_MODES.find((x) => x.key === key) || HELL_MODES[0];
  return m.fsk ? m.shift : TX_COLUMN_LEN * m.colrate;
}

/** Receive low-pass cutoff (fldigi: HELL_BW / 2 after its first rx_process). */
function _cutoff(m) {
  const fb = m.fsk ? 5 * Math.round(4 * m.shift / 5) : 5 * Math.round(1.2 * TX_COLUMN_LEN * m.colrate / 5);
  return fb / 2;
}

export class HellDecoder {
  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate
      : (() => Number(options.sampleRate) || 12000);
    this._mode = HELL_MODES.find((m) => m.key === options.mode) || HELL_MODES[0];
    this._centerHz = Number(options.centerHz) || 1000;
    this._reverse = !!options.reverse;
    this.onColumn  = typeof options.onColumn  === 'function' ? options.onColumn  : null;
    this.onStatus  = typeof options.onStatus  === 'function' ? options.onStatus  : null;
    this.onMetrics = typeof options.onMetrics === 'function' ? options.onMetrics : null;
    this._preset();
  }

  // No squelch: Hell paints noise as speckle, which the eye ignores; that is
  // how it is meant to be read. Kept so fsk.js can treat every modem alike.
  setSquelch() {}

  setReverse(on) { this._reverse = !!on; }

  reset() { this._preset(); }

  feed(pcm) {
    if (!pcm || !pcm.length) return;
    this._rs.run(pcm, this._sampleRateFn() || 12000, this._sink);
    this._maybeEmitMetrics();
  }

  _preset() {
    const m = this._mode;
    const rxpixrate = HELL_COLUMN_LEN * m.colrate;
    const cutoff = _cutoff(m);
    // Run the filter output at a decimated rate, still ~4x the pixel rate.
    this._D = Math.max(1, Math.min(64, Math.floor(RATE / (rxpixrate * 4))));
    const D = this._D;
    let taps = Math.round(6 * RATE / cutoff) | 1;
    taps = Math.max(63, Math.min(4095, taps));
    this._taps = taps;
    const M = (taps - 1) / 2, x = 2 * cutoff / RATE;
    this._lpf = new Float64Array(taps);
    let g = 0;
    for (let i = 0; i < taps; i++) {
      const t = i - M;
      const sinc = t === 0 ? x : Math.sin(Math.PI * x * t) / (Math.PI * t);
      this._lpf[i] = sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1)));
      g += this._lpf[i];
    }
    for (let i = 0; i < taps; i++) this._lpf[i] /= g;
    this._bufRe = new Float64Array(2 * taps);
    this._bufIm = new Float64Array(2 * taps);
    this._bufPos = 0;
    this._dec = 0;

    this._phase = 0;
    this._inc = 2 * Math.PI * this._centerHz / RATE;
    this._downinc = D * rxpixrate / RATE;
    this._rxcounter = 0;
    this._peakval = 0;
    this._peakhold = 0;
    this._agc = 0;
    this._average = new MovAvg(Math.max(1, Math.round(500 * RATE / rxpixrate / D)));
    this._bbfilt = new MovAvg(Math.max(1, Math.round(8 / D)));
    this._phi2freq = m.fsk ? (RATE / D) / Math.PI / (m.shift / 2) : 0;
    this._prevRe = 0; this._prevIm = 0;
    this._col = new Uint8Array(2 * HELL_COLUMN_LEN);
    this._colPtr = 0;
    this._samples = 0;
    this._lastMetricsAt = 0;
    this._levelDb = -120;
    this._lvl = 0;
    this._rs = new LinearResampler(RATE);
    this._sink = (v) => this._sample(v);
  }

  _sample(v) {
    this._samples++;
    const c = Math.cos(this._phase), s = Math.sin(this._phase);
    this._phase -= this._inc;
    if (this._phase < 0) this._phase += 2 * Math.PI;
    this._lvl += (v * v - this._lvl) * 0.0005;
    const T = this._taps;
    let p = this._bufPos;
    const zr = v * c, zi = v * s;
    this._bufRe[p] = zr; this._bufRe[p + T] = zr;
    this._bufIm[p] = zi; this._bufIm[p + T] = zi;
    p = p + 1 === T ? 0 : p + 1;
    this._bufPos = p;
    if (++this._dec < this._D) return;
    this._dec = 0;
    let ar = 0, ai = 0;
    const h = this._lpf, br = this._bufRe, bi = this._bufIm;
    for (let k = 0; k < T; k++) { ar += br[p + k] * h[k]; ai += bi[p + k] * h[k]; }
    // A real input mixed down leaves half the amplitude in the wanted image.
    ar *= 2; ai *= 2;
    if (this._mode.fsk) this._fskRx(ar, ai); else this._amRx(ar, ai);
  }

  _agcStep(avg) {
    if (avg > this._agc) this._agc = avg;
    else this._agc *= 1 - AGC_DECAY / HELL_COLUMN_LEN;
  }

  _amRx(re, im) {
    const x = Math.hypot(re, im);
    if (x > this._peakval) this._peakval = x;
    const avg = this._average.run(x);
    this._rxcounter += this._downinc;
    if (this._rxcounter < 1) return;
    this._rxcounter -= 1;
    const pk = this._peakval;
    this._peakval = 0;
    if (pk > this._peakhold) this._peakhold = pk;
    else this._peakhold *= 1 - 0.02 / HELL_COLUMN_LEN;
    this._agcStep(avg);
    let ink = this._peakhold > 0 ? Math.round(255 * pk / this._peakhold) : 0;
    ink = Math.max(0, Math.min(255, ink));
    this._pixel(ink);
  }

  _fskRx(re, im) {
    // arg(conj(prev) * z)
    const pr = this._prevRe * re + this._prevIm * im;
    const pi = this._prevRe * im - this._prevIm * re;
    this._prevRe = re; this._prevIm = im;
    let f = Math.atan2(pi, pr) * this._phi2freq;
    f = this._bbfilt.run(f);
    const avg = this._average.run(Math.hypot(re, im));
    this._rxcounter += this._downinc;
    if (this._rxcounter < 1) return;
    this._rxcounter -= 1;
    this._agcStep(avg);
    let vid = Math.max(0, Math.min(1, 0.5 * (f + 1)));
    // fldigi paints the upper tone as paper; ink is the lower one.
    if (!this._reverse) vid = 1 - vid;
    this._pixel(Math.round(vid * 255));
  }

  _pixel(ink) {
    const L = HELL_COLUMN_LEN;
    this._col[this._colPtr + L] = ink;
    if (++this._colPtr >= L) {
      if (this.onColumn) this.onColumn(this._col.slice());
      this._colPtr = 0;
      this._col.copyWithin(0, L, 2 * L);
    }
  }

  _maybeEmitMetrics() {
    if (this._samples - this._lastMetricsAt < RATE / 4) return;
    this._lastMetricsAt = this._samples;
    if (!this.onMetrics) return;
    this.onMetrics({
      levelDb: Math.round(10 * Math.log10(this._lvl + 1e-12)),
      centerHz: this._centerHz,
      snrDb: 0,
      lockQuality: 0,
      timingLocked: false,
    });
  }
}

export default HellDecoder;
