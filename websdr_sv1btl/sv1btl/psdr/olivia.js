// olivia.js — Olivia MFSK decoder (receive only)
// ============================================================================
// A port of Pawel Jalocha's MFSK receiver as carried in fldigi
// (src/include/jalocha/pj_mfsk.h, pj_fht.h, pj_gray.h, pj_lowpass3.h —
// (c) 1999-2004 Pawel Jalocha, (c) 2006-2019 Dave Freese W1HKJ, GPL-3).
// PhantomSDR-Plus is GPL-3 as well, so the port keeps the same terms.
//
// The FEC had to be ported rather than reinvented: the scrambling constant,
// the 13-bit-per-bit-plane code offset, the diagonal rotation and the Gray
// mapping all have to match the transmitter exactly or nothing decodes at all.
//
// How Olivia works
// ----------------
//   Tones tones spaced Bandwidth/Tones apart, one tone per symbol, symbol rate
//   equal to the tone spacing. A FEC block is 64 symbols and carries
//   log2(Tones) characters of 7 bits. Each character is turned into a 64-long
//   +/-1 Walsh sequence (inverse Hadamard of a single spike, negated for the
//   upper half of the alphabet), scrambled against a fixed 64-bit code at a
//   per-bit-plane offset of 13 bits, and laid diagonally across the block's
//   bit-planes. Receiving is the same in reverse: a forward Hadamard turns the
//   soft bits back into a spike whose position is the character.
//
//   Internals run at a fixed 8 kHz, which is what makes SymbolLen a power of
//   two for every tones/bandwidth pair, so the input is resampled first.
//
//   There is no preamble, so sync is brute force: run a decoder for every
//   (frequency offset x FFT slice) combination, integrate each one's FEC
//   signal-to-noise over several blocks, and emit the block from whichever
//   (block phase, frequency offset) is winning. That is why Olivia takes a few
//   seconds to lock and why this belongs in a worker.
//
// Deliberate omission: fldigi's MFSK_InputProcessor (an adaptive spectral
// equaliser / coherent-interference notcher) is NOT ported. It improves
// robustness against carriers inside the passband but is not needed for
// correct decoding; the audio goes to the demodulator unprocessed.
//
// Interface matches the other engines in this tree:
//   new OliviaDecoder({sampleRate, centerHz, tones, bandwidth,
//                      onChar, onStatus, onMetrics});
//   .feed(Float32Array); .setCenter(hz); .setMode(tones, bandwidth); .reset();
// ============================================================================

import { transformFlat } from './lib/fftRadix2.js';

const INTERNAL_RATE = 8000;      // fldigi's fixed internal processing rate
const BITS_PER_CHAR = 7;         // Olivia (Contestia would be 6)
const SYMBOLS_PER_BLOCK = 64;    // 2^(BITS_PER_CHAR-1)
const SLICES_PER_SYMBOL = 2;     // FFT slices per symbol period
const CARRIER_SEPAR = 2;         // tone spacing in FFT bins
const SYNC_MARGIN = 8;           // +/- this many bins of frequency search
const SYNC_INTEG_LEN = 4;        // blocks integrated by the sync filters
// FEC S/N needed before a block is emitted — the squelch. fldigi treats 3.0 as
// the floor and lets the operator raise it; the panel exposes the same control.
// At 3.0 pure noise leaks the occasional block (measured ~3.1), so the default
// sits just above that. A real signal scores ~8.5 even buried in noise.
export const SYNC_THRESHOLD_MIN = 3.0;
export const SYNC_THRESHOLD_MAX = 15.0;
export const SYNC_THRESHOLD_DEFAULT = 4.0;

// Reference span for the reported FEC quality percentage. Deliberately fixed
// rather than derived from the squelch, so moving the slider changes what gets
// through without changing what the meter says about the signal.
const QUALITY_FLOOR = 3.0;
const QUALITY_SPAN  = 6.0;
const CODE_SHIFT = 13;           // scrambling offset per bit-plane (Olivia)

// 0xE257E6D0291574EC — expanded once into per-position signs so the hot path
// never touches 64-bit arithmetic.
const SCRAMBLE_HI = 0xE257E6D0 >>> 0;
const SCRAMBLE_LO = 0x291574EC >>> 0;
const SCRAMBLE_SIGN = (() => {
  const s = new Int8Array(SYMBOLS_PER_BLOCK);
  for (let b = 0; b < SYMBOLS_PER_BLOCK; b++) {
    const word = b < 32 ? SCRAMBLE_LO : SCRAMBLE_HI;
    const bit = b < 32 ? b : b - 32;
    s[b] = ((word >>> bit) & 1) ? -1 : 1;
  }
  return s;
})();

/** The four configurations offered in the UI.  The first is the default. */
export const OLIVIA_MODES = [
  { label: '8 / 250',   tones: 8,  bandwidth: 250 },
  { label: '16 / 500',  tones: 16, bandwidth: 500 },
  { label: '32 / 1000', tones: 32, bandwidth: 1000 },
  { label: '16 / 1000', tones: 16, bandwidth: 1000 },
];

// ── Fast Hadamard transform (pj_fht.h) ──────────────────────────────────────

export function FHT(data, len) {
  for (let step = 1; step < len; step *= 2) {
    for (let ptr = 0; ptr < len; ptr += 2 * step) {
      for (let p = ptr; p - ptr < step; p++) {
        const b1 = data[p], b2 = data[p + step];
        data[p] = b2 + b1;
        data[p + step] = b2 - b1;
      }
    }
  }
}

export function IFHT(data, len) {
  for (let step = len >> 1; step; step >>= 1) {
    for (let ptr = 0; ptr < len; ptr += 2 * step) {
      for (let p = ptr; p - ptr < step; p++) {
        const b1 = data[p], b2 = data[p + step];
        data[p] = b1 - b2;
        data[p + step] = b1 + b2;
      }
    }
  }
}

// ── Gray code (pj_gray.h) ───────────────────────────────────────────────────

export const grayCode = (b) => (b ^ (b >>> 1)) & 0xff;

export function binaryCode(g) {
  g ^= g >>> 4;
  g ^= g >>> 2;
  g ^= g >>> 1;
  return g & 0xff;
}

// ── LowPass3_Filter (pj_lowpass3.h), flattened into parallel arrays ─────────
// One filter per (block phase, frequency offset); there are thousands of them,
// so they live in three Float32Arrays rather than a few thousand objects.

function lp3Process(out1, out2, out, i, inp, weight, feedback = 0.1) {
  const w = weight * 2.0;
  const diffI1 = (inp - out1[i]) * w;
  const diff12 = (out1[i] - out2[i]) * w;
  let diff23 = (out2[i] - out[i]) * w;
  out1[i] += diffI1;
  out2[i] += diff12;
  out[i] += diff23;
  diff23 *= feedback;
  out2[i] += diff23;
}

// ── Soft decoder: one candidate (slice, frequency offset) ───────────────────
// A faithful port of MFSK_SoftDecoder. Holds a sliding window of one block's
// worth of soft bits and re-decodes the whole block on every symbol.

class SoftDecoder {
  constructor(bitsPerSymbol) {
    this.bitsPerSymbol = bitsPerSymbol;
    this.inputBufferLen = SYMBOLS_PER_BLOCK * bitsPerSymbol;
    this.inputBuffer = new Float32Array(this.inputBufferLen);
    this.fht = new Float32Array(SYMBOLS_PER_BLOCK);
    this.outputBlock = new Uint8Array(bitsPerSymbol);
    this.inputPtr = 0;
    this.signal = 0;
    this.noiseEnergy = 0;
  }

  reset() {
    this.inputBuffer.fill(0);
    this.inputPtr = 0;
    this.signal = 0;
    this.noiseEnergy = 0;
  }

  input(symbol) {
    for (let b = 0; b < this.bitsPerSymbol; b++) {
      this.inputBuffer[this.inputPtr++] = symbol[b];
    }
    if (this.inputPtr >= this.inputBufferLen) this.inputPtr -= this.inputBufferLen;
  }

  decodeCharacter(freqBit) {
    const N = SYMBOLS_PER_BLOCK;
    const bps = this.bitsPerSymbol;
    const buf = this.inputBuffer;
    const fht = this.fht;

    let ptr = this.inputPtr;
    let rotate = freqBit;
    let codeBit = (freqBit * CODE_SHIFT) & (N - 1);

    for (let t = 0; t < N; t++) {
      const bit = buf[ptr + rotate];
      fht[t] = SCRAMBLE_SIGN[codeBit] < 0 ? -bit : bit;
      codeBit = (codeBit + 1) & (N - 1);
      if (++rotate >= bps) rotate -= bps;
      ptr += bps;
      if (ptr >= this.inputBufferLen) ptr -= this.inputBufferLen;
    }

    FHT(fht, N);

    let peak = 0, peakPos = 0, sqrSum = 0;
    for (let t = 0; t < N; t++) {
      const s = fht[t];
      sqrSum += s * s;
      if (Math.abs(s) > Math.abs(peak)) { peak = s; peakPos = t; }
    }

    let char = peakPos;
    if (peak < 0) char += N;
    sqrSum -= peak * peak;

    this.outputBlock[freqBit] = char;
    this.noiseEnergy += sqrSum / (N - 1);
    this.signal += Math.abs(peak);
  }

  process() {
    this.signal = 0;
    this.noiseEnergy = 0;
    for (let b = 0; b < this.bitsPerSymbol; b++) this.decodeCharacter(b);
    this.signal /= this.bitsPerSymbol;
    this.noiseEnergy /= this.bitsPerSymbol;
  }
}

function _clampThreshold(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return SYNC_THRESHOLD_DEFAULT;
  return Math.max(SYNC_THRESHOLD_MIN, Math.min(SYNC_THRESHOLD_MAX, n));
}

// ── The decoder ─────────────────────────────────────────────────────────────

export class OliviaDecoder {

  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate
      : (() => Number(options.sampleRate) || 12000);

    this._centerHz = Number(options.centerHz) || 1000;
    this._tones     = Number(options.tones) || OLIVIA_MODES[0].tones;
    this._bandwidth = Number(options.bandwidth) || OLIVIA_MODES[0].bandwidth;
    this._syncThreshold = _clampThreshold(options.syncThreshold);

    this.onChar    = typeof options.onChar    === 'function' ? options.onChar    : null;
    this.onStatus  = typeof options.onStatus  === 'function' ? options.onStatus  : null;
    this.onMetrics = typeof options.onMetrics === 'function' ? options.onMetrics : null;

    this._preset();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setCenter(hz) {
    const f = Number(hz);
    if (!Number.isFinite(f) || f <= 0 || f === this._centerHz) return;
    this._centerHz = f;
    this._preset();
  }

  setMode(tones, bandwidth) {
    const t = Number(tones), b = Number(bandwidth);
    if (!Number.isFinite(t) || !Number.isFinite(b)) return;
    if (t === this._tones && b === this._bandwidth) return;
    this._tones = t;
    this._bandwidth = b;
    this._preset();
  }

  /**
   * Squelch: the FEC signal-to-noise a block must reach before its characters
   * are emitted. Takes effect immediately — no re-preset, so it can be dragged
   * while decoding without losing sync.
   */
  setSyncThreshold(v) {
    this._syncThreshold = _clampThreshold(v);
  }

  reset() { this._preset(); }

  /** Raw audio in, at the rate reported by the sampleRate function. */
  feed(pcm) {
    if (!pcm || !pcm.length) return;

    const sr = this._sampleRateFn() || 12000;
    if (sr !== this._inputRate) {
      this._inputRate = sr;
      this._resampleStep = INTERNAL_RATE / sr;
    }

    // Resample to 8 kHz by linear interpolation. The signal has already been
    // band-limited to the Olivia passband by the receiver's IF filter, so the
    // interpolation error lands well below the tone energies.
    for (let n = 0; n < pcm.length; n++) {
      const x = pcm[n];
      this._resPhase += this._resampleStep;
      while (this._resPhase >= 1) {
        this._resPhase -= 1;
        const u = 1 - this._resPhase;
        this._pushSample(this._resPrev + (x - this._resPrev) * u);
      }
      this._resPrev = x;
    }

    this._maybeEmitMetrics();
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  _preset() {
    const bps = Math.max(1, Math.round(Math.log2(this._tones)));
    this._bitsPerSymbol = bps;
    this._carriers = 1 << bps;

    // SymbolLen = 2^(BitsPerSymbol + 7 - log2(Bandwidth/125)), which keeps
    // 2*INTERNAL_RATE/SymbolLen equal to the tone spacing for every mode.
    const bwExp = Math.round(Math.log2(this._bandwidth / 125));
    this._symbolLen = 1 << (bps + 7 - bwExp);
    this._symbolSepar = this._symbolLen >> 1;
    this._symbolSepar2 = this._symbolSepar >> 1;

    // fldigi centres the tone block on the dial frequency by backing off half
    // the bandwidth (less half a tone), then converts to an FFT bin index.
    const fcOffset = this._bandwidth * (1 - 0.5 / this._carriers) / 2;
    const mult = (this._centerHz - fcOffset) / 500.0;
    this._firstCarrier = Math.floor((this._symbolLen / 16) * mult) + 1;

    this._decodeMargin = Math.min(SYNC_MARGIN, this._firstCarrier);
    this._decodeWidth = (this._carriers * CARRIER_SEPAR - 1) + 2 * this._decodeMargin;
    this._freqOffsets = 2 * this._decodeMargin + 1;
    this._blockPhases = SLICES_PER_SYMBOL * SYMBOLS_PER_BLOCK;

    // Symbol shape: MFSK_SymbolFreqShape is {1,1}, which works out to a Hann
    // window scaled by 1/SymbolLen.
    this._shape = new Float64Array(this._symbolLen);
    for (let t = 0; t < this._symbolLen; t++) {
      this._shape[t] = (1 - Math.cos(2 * Math.PI * t / this._symbolLen)) / this._symbolLen;
    }

    this._inpTap = new Float64Array(this._symbolLen);
    this._inpTapPtr = 0;
    this._wrapMask = this._symbolLen - 1;

    this._fftRe = new Float64Array(this._symbolLen);
    this._fftIm = new Float64Array(this._symbolLen);
    this._energy = [
      new Float64Array(this._decodeWidth),
      new Float64Array(this._decodeWidth),
    ];

    this._symbol = new Float32Array(bps);

    // One decoder per (slice, frequency offset).
    this._decoders = [];
    for (let i = 0; i < SLICES_PER_SYMBOL * this._freqOffsets; i++) {
      this._decoders.push(new SoftDecoder(bps));
    }

    // DecodePipe[blockPhase] is a SYNC_INTEG_LEN-deep ring of decoded blocks,
    // one block per frequency offset, each block being bps characters.
    this._pipe = [];
    this._pipePtr = new Int32Array(this._blockPhases);
    for (let p = 0; p < this._blockPhases; p++) {
      const slots = [];
      for (let s = 0; s < SYNC_INTEG_LEN; s++) {
        slots.push(new Uint8Array(this._freqOffsets * bps));
      }
      this._pipe.push(slots);
    }

    const filters = this._blockPhases * this._freqOffsets;
    this._sigOut1 = new Float32Array(filters);
    this._sigOut2 = new Float32Array(filters);
    this._sigOut  = new Float32Array(filters);
    this._nseOut1 = new Float32Array(filters);
    this._nseOut2 = new Float32Array(filters);
    this._nseOut  = new Float32Array(filters);

    this._syncFilterWeight = 1.0 / SYNC_INTEG_LEN;
    this._blockPhase = 0;
    this._syncBestSignal = 0;
    this._syncBestBlockPhase = 0;
    this._syncBestFreqOffset = 0;
    this._syncSNR = 0;

    this._inputRate = this._sampleRateFn() || 12000;
    this._resampleStep = INTERNAL_RATE / this._inputRate;
    this._resPhase = 0;
    this._resPrev = 0;

    this._symbolFill = 0;
    this._symbolBuf = new Float64Array(this._symbolSepar);

    this._lastMetricsAt = 0;
    this._statusText = '';
    this._synced = false;
  }

  // ── Demodulator ───────────────────────────────────────────────────────────

  _pushSample(x) {
    this._symbolBuf[this._symbolFill++] = x;
    if (this._symbolFill < this._symbolSepar) return;
    this._symbolFill = 0;
    this._processSymbol(this._symbolBuf);
  }

  /**
   * One symbol period of audio in, two FFT slices out. The slices are half a
   * symbol apart, which is what gives two decision opportunities per symbol.
   */
  _demodulate(input) {
    const N = this._symbolLen;
    const tap = this._inpTap;

    for (let i = 0; i < this._symbolSepar2; i++) {
      tap[this._inpTapPtr] = input[i];
      this._inpTapPtr = (this._inpTapPtr + 1) & this._wrapMask;
    }
    this._fftSlice(0);

    for (let i = this._symbolSepar2; i < this._symbolSepar; i++) {
      tap[this._inpTapPtr] = input[i];
      this._inpTapPtr = (this._inpTapPtr + 1) & this._wrapMask;
    }
    this._fftSlice(1);
  }

  _fftSlice(slice) {
    const N = this._symbolLen;
    const re = this._fftRe, im = this._fftIm;
    let p = this._inpTapPtr;
    for (let t = 0; t < N; t++) {
      re[t] = this._inpTap[p] * this._shape[t];
      im[t] = 0;
      p = (p + 1) & this._wrapMask;
    }
    transformFlat(re, im, false);

    // Energies for the tone block plus the frequency search margin either side.
    const out = this._energy[slice];
    let freq = this._firstCarrier - this._decodeMargin;
    for (let i = 0; i < this._decodeWidth; i++, freq++) {
      out[i] = re[freq] * re[freq] + im[freq] * im[freq];
    }
  }

  /**
   * Soft-demap one slice at one frequency offset into bps soft bits.
   * Faithful to MFSK_Demodulator::SoftDecode, including squaring the bin
   * energy and the Gray-to-binary mapping of the tone index.
   */
  _softDecode(symbol, slice, freqOffset) {
    const bps = this._bitsPerSymbol;
    for (let b = 0; b < bps; b++) symbol[b] = 0;

    const e = this._energy[slice];
    const base = this._decodeMargin + freqOffset;
    let total = 0;
    let freq = 0;

    for (let idx = 0; idx < this._carriers; idx++, freq += CARRIER_SEPAR) {
      const symbIdx = binaryCode(idx);
      let energy = e[base + freq];
      energy *= energy;
      total += energy;
      for (let b = 0; b < bps; b++) {
        if (symbIdx & (1 << b)) symbol[b] -= energy;
        else                    symbol[b] += energy;
      }
    }

    if (total > 0) {
      for (let b = 0; b < bps; b++) symbol[b] /= total;
    }
  }

  // ── Sync search + block emission ──────────────────────────────────────────

  _processSymbol(input) {
    this._demodulate(input);

    const bps = this._bitsPerSymbol;
    const offsets = this._freqOffsets;
    let decIdx = 0;

    for (let slice = 0; slice < SLICES_PER_SYMBOL; slice++) {
      const phase = this._blockPhase;
      const filterBase = phase * offsets;
      const slot = this._pipe[phase][this._pipePtr[phase]];

      let bestSliceSignal = 0;
      let bestSliceOffset = 0;

      for (let off = 0; off < offsets; off++) {
        this._softDecode(this._symbol, slice, off - (offsets >> 1));

        const dec = this._decoders[decIdx++];
        dec.input(this._symbol);
        dec.process();
        slot.set(dec.outputBlock, off * bps);

        const fi = filterBase + off;
        lp3Process(this._nseOut1, this._nseOut2, this._nseOut, fi,
                   dec.noiseEnergy, this._syncFilterWeight);
        lp3Process(this._sigOut1, this._sigOut2, this._sigOut, fi,
                   dec.signal, this._syncFilterWeight);

        const sig = this._sigOut[fi];
        if (sig > bestSliceSignal) { bestSliceSignal = sig; bestSliceOffset = off; }
      }

      this._pipePtr[phase] = (this._pipePtr[phase] + 1) % SYNC_INTEG_LEN;

      if (phase === this._syncBestBlockPhase) {
        this._syncBestSignal = bestSliceSignal;
        this._syncBestFreqOffset = bestSliceOffset;
      } else if (bestSliceSignal > this._syncBestSignal) {
        this._syncBestSignal = bestSliceSignal;
        this._syncBestBlockPhase = phase;
        this._syncBestFreqOffset = bestSliceOffset;
      }

      // Half a block after the winning phase, that block has fully integrated:
      // read it out and decide whether its FEC S/N clears the threshold.
      let dist = phase - this._syncBestBlockPhase;
      if (dist < 0) dist += this._blockPhases;

      if (dist === (this._blockPhases >> 1)) {
        const noise = Math.sqrt(this._nseOut[filterBase + offsets - 1]);
        this._syncSNR = noise === 0 ? 0 : this._syncBestSignal / noise;

        if (this._syncSNR >= this._syncThreshold) {
          this._synced = true;
          const bestPipe = this._pipe[this._syncBestBlockPhase];
          const best = bestPipe[this._pipePtr[this._syncBestBlockPhase]];
          const at = this._syncBestFreqOffset * bps;
          for (let c = 0; c < bps; c++) this._emit(best[at + c]);
        } else {
          this._synced = false;
        }

        if (this._syncSNR > 100) this._syncSNR = 0;
      }

      this._blockPhase++;
      if (this._blockPhase >= this._blockPhases) this._blockPhase -= this._blockPhases;
    }
  }

  _emit(code) {
    if (!this.onChar) return;
    if (code === 0) return;                    // idle / fill
    if (code === 13) { this.onChar('\n'); return; }
    if (code === 10) { this.onChar('\n'); return; }
    if (code < 32 || code > 126) return;       // non-printable, drop
    this.onChar(String.fromCharCode(code));
  }

  // ── Reporting ─────────────────────────────────────────────────────────────

  get lockQuality() {
    // Fixed reference, not the squelch setting — see QUALITY_FLOOR above.
    const q = (this._syncSNR - QUALITY_FLOOR) / QUALITY_SPAN;
    return Math.max(0, Math.min(100, Math.round(q * 100)));
  }

  get snrDb() {
    if (!(this._syncSNR > 0)) return 0;
    return Math.max(0, Math.min(40, 20 * Math.log10(this._syncSNR)));
  }

  /** Frequency error the sync search has settled on, in Hz. */
  get frequencyOffsetHz() {
    const binHz = INTERNAL_RATE / this._symbolLen;
    return (this._syncBestFreqOffset - (this._freqOffsets >> 1)) * binHz;
  }

  _maybeEmitMetrics() {
    const now = Date.now();
    if (now - this._lastMetricsAt < 250) return;
    this._lastMetricsAt = now;

    if (this.onStatus) {
      const off = this.frequencyOffsetHz;
      const text = this._synced
        ? `Sync ${this._tones}/${this._bandwidth} @ ${off >= 0 ? '+' : ''}${off.toFixed(1)} Hz`
        : 'Searching…';
      if (text !== this._statusText) {
        this._statusText = text;
        this.onStatus(text);
      }
    }

    if (this.onMetrics) {
      this.onMetrics({
        snrDb:        this.snrDb,
        lockQuality:  this.lockQuality,
        centerHz:     this._centerHz + this.frequencyOffsetHz,
        timingLocked: this._synced,
      });
    }
  }
}

export default OliviaDecoder;
