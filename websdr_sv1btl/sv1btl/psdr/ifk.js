// ifk.js — DominoEX and THOR decoders (receive only)
//
// A port of fldigi's src/dominoex/dominoex.cxx + dominovar.cxx and
// src/thor/thor.cxx + thorvaricode.cxx, which share one receiver.
//
// How IFK+ (incremental frequency keying) works
//   18 tones, one at a time. A 4-bit nibble is not sent as a tone but as a
//   STEP from the previous tone: tone = (previous + 2 + nibble) mod 18, so the
//   same tone never repeats and a slow drift of the whole signal cancels out.
//   DominoEX sends its own nibble varicode as-is (no FEC: one bad nibble costs
//   one character). THOR runs the IZ8BLY varicode through a K=7 (K=15 for the
//   fast modes) rate-1/2 convolutional code and a diagonal interleaver first,
//   like MFSK16, so it copies through static crashes and fades.
//
// The receiver follows fldigi step for step: mix the tone block to its fixed
// base frequency, run `paths` sliding DFTs one symbol long, each offset by a
// fraction of a bin, so one of them always lands near the true tone; take the
// strongest of the paths x bins every symlen samples; and turn the step from
// the previous symbol back into a nibble. Symbol timing comes from where in
// the last two symbols the previous tone peaked. fldigi defaults are used:
// slow-CPU mode (3 paths), hard decision for DominoEX, soft symbols + soft bits
// + preamble detection for THOR, DominoEX's MultiPSK FEC off.
//
// Not carried over: the secondary-text channel (the station's idle beacon,
// which fldigi shows in its status bar, not the receive pane), THOR pictures,
// the CWI notch, which fldigi's default threshold leaves inactive, and fldigi's
// S/N estimate (see _evalS2n).
//
// Interface mirrors mfsk.js:
//   new IfkDecoder({sampleRate, centerHz, family: 'dominoex'|'thor', mode,
//                   squelch, onChar, onStatus, onMetrics});
//   .feed(Float32Array pcm)   .setSquelch(v)   .reset()

import { Viterbi, MovAvg, decayavg, complexBandpass, LinearResampler, PUNCTURE } from './fldigiFec.js';
import { Interleaver, MFSK_VARICODE } from './mfsk.js';

const NUMTONES = 18;
const PATHS = 3;                  // fldigi slowcpu = true (its default)
const EXTONES = 4;
const BPF_TAPS = 255;

/**
 * Sub-modes. sr / symlen / ds (tone spacing in bins) are fldigi's numbers;
 * `k` / `depth` only matter for THOR.
 */
export const DOMINOEX_MODES = [
  { key: 'domexmicro', label: 'DominoEX Micro', sr: 8000, symlen: 4000, ds: 1 },
  { key: 'domex4', label: 'DominoEX 4', sr: 8000, symlen: 2048, ds: 2 },
  { key: 'domex5', label: 'DominoEX 5', sr: 11025, symlen: 2048, ds: 2 },
  { key: 'domex8', label: 'DominoEX 8', sr: 8000, symlen: 1024, ds: 2 },
  { key: 'domex11', label: 'DominoEX 11', sr: 11025, symlen: 1024, ds: 1 },
  { key: 'domex16', label: 'DominoEX 16', sr: 8000, symlen: 512, ds: 1 },
  { key: 'domex22', label: 'DominoEX 22', sr: 11025, symlen: 512, ds: 1 },
  { key: 'domex44', label: 'DominoEX 44', sr: 11025, symlen: 256, ds: 2 },
  { key: 'domex88', label: 'DominoEX 88', sr: 11025, symlen: 128, ds: 1 },
];

export const THOR_MODES = [
  { key: 'thormicro', label: 'THOR Micro', sr: 8000, symlen: 4000, ds: 1, depth: 4, k: 7 },
  { key: 'thor4', label: 'THOR 4', sr: 8000, symlen: 2048, ds: 2, depth: 10, k: 7 },
  { key: 'thor5', label: 'THOR 5', sr: 11025, symlen: 2048, ds: 2, depth: 10, k: 7 },
  { key: 'thor8', label: 'THOR 8', sr: 8000, symlen: 1024, ds: 2, depth: 10, k: 7 },
  { key: 'thor11', label: 'THOR 11', sr: 11025, symlen: 1024, ds: 1, depth: 10, k: 7 },
  { key: 'thor16', label: 'THOR 16', sr: 8000, symlen: 512, ds: 1, depth: 10, k: 7 },
  { key: 'thor22', label: 'THOR 22', sr: 11025, symlen: 512, ds: 1, depth: 10, k: 7 },
  { key: 'thor25x4', label: 'THOR 25 x4', sr: 8000, symlen: 320, ds: 4, depth: 50, k: 15 },
  { key: 'thor50x1', label: 'THOR 50 x1', sr: 8000, symlen: 160, ds: 1, depth: 50, k: 15 },
  { key: 'thor50x2', label: 'THOR 50 x2', sr: 8000, symlen: 160, ds: 2, depth: 50, k: 15 },
  { key: 'thor100', label: 'THOR 100', sr: 8000, symlen: 80, ds: 1, depth: 50, k: 15 },
];

const FAMILY = {
  dominoex: { modes: DOMINOEX_MODES, basefreq: 1000, firstif: 1500, syncLen: 16 },
  thor: { modes: THOR_MODES, basefreq: 1500, firstif: 2000, syncLen: 8 },
};

/** Occupied bandwidth (18 tones) of a sub-mode, in Hz. */
export function ifkBandwidth(key) {
  const m = DOMINOEX_MODES.find((x) => x.key === key) || THOR_MODES.find((x) => x.key === key);
  if (!m) return 0;
  return NUMTONES * m.sr * m.ds / m.symlen;
}

// Squelch on a 0..100 metric, 6 x the tone-to-floor ratio in dB (see
// _evalS2n). Noise alone stays at or under 20; readable copy reads 37 and up.
export const DOMINOEX_SQUELCH_DEFAULT = 25;
export const THOR_SQUELCH_DEFAULT = 25;

// ── DominoEX varicode (dominovar.cxx) ───────────────────────────────────────
// 512 entries x 3 nibbles (primary alphabet, then secondary). A nibble with
// its MSB set continues the character; the first nibble of a character never
// has it set, which is how the receiver finds the boundaries.
const DOMINO_VARICODE_HEX = [
  '1f91fa1fb1fc1fd1fe1ff2882c028928a28b28c2d028d28e28f29829929a29b29c29d29e29f2a82a92aa2ab2ac2ad2ae',
  '0007b008e0ab09a09908f7a008c08b09d0882b07e07d00893f04a04f05906805c05e06c06b06e008a08d0a87f009f7c0',
  '0983904e03c03e03804c05805a03a07806a04b04804d03b04906f03d02f02e05b06d05d05f06907900ae0a90af0aa09c',
  '09b4001b00c00b01000f01900a05002a01e00900e06003001802807000802000d01d01c01f01a02900ac09e0ad0b82af',
  '2b82b92ba2bb2bc2bd2be2bf2c82c92ca2cb2cc2cd2ce2cf2d82d92da2db2dc2dd2de2df2e82e92ea2eb2ec2ed2ee2ef',
  '0b90ba0bb0bc0bd0be0bf0c80c90ca0cb0cc0cd0ce0cf0d80d90da0db0dc0dd0de0df0e80e90ea0eb0ec0ed0ee0ef0f8',
  '0f90fa0fb0fc0fd0fe0ff18818918a18b18c18d18e18f19819919a19b19c19d19e19f1a81a91aa1ab1ac1ad1ae1af1b8',
  '1b91ba1bb1bc1bd1be1bf1c81c91ca1cb1cc1cd1ce1cf1d81d91da1db1dc1dd1de1df1e81e91ea1eb1ec1ed1ee1ef1f8',
  '6f96fa6fb6fc6fd6fe6ff7884ac78978a78b78c4ad78d78e78f79879979a79b79c79d79e79f7a87a97aa7ab7ac7ad7ae',
  '3884fb58e5ab59a59958f4fa58c58b59d5884ab4fe4fd5894bf4ca4cf4d94e84dc4de4ec4eb4ee58a58d5a84ff59f4fc',
  '5984b94ce4bc4be4b84cc4d84da4ba4f84ea4cb4c84cd4bb4c94ef4bd4af4ae4db4ed4dd4df4e94f95ae5a95af5aa59c',
  '59b38c49b48c48b38948f49948a38d4aa49e48948e38e38b4984a838f48838a48d49d49c49f49a4a95ac59e5ac5b87af',
  '7b87b97ba7bb7bc7bd7be7bf7c87c97ca7cb7cc7cd7ce7cf7d87d97da7db7dc7dd7de7df7e87e97ea7eb7ec7ed7ee7ef',
  '5b95ba5bb5bc5bd5be5bf5c85c95ca5cb5cc5cd5ce5cf5d85d95da5db5dc5dd5de5df5e85e95ea5eb5ec5ed5ee5ef5f8',
  '5f95fa5fb5fc5fd5fe5ff68868968a68b68c68d68e68f69869969a69b69c69d69e69f6a86a96aa6ab6ac6ad6ae6af6b8',
  '6b96ba6bb6bc6bd6be6bf6c86c96ca6cb6cc6cd6ce6cf6d86d96da6db6dc6dd6de6df6e86e96ea6eb6ec6ed6ee6ef6f8',
].join('');

/** The nibbles fldigi keys for character c (secondary: c + 256). */
export function dominoVaricode(c) {
  const h = DOMINO_VARICODE_HEX;
  const a = parseInt(h[3 * c], 16), b = parseInt(h[3 * c + 1], 16), d = parseInt(h[3 * c + 2], 16);
  const out = [a];
  if (b & 8) { out.push(b); if (d & 8) out.push(d); }
  return out;
}

// varidecode[symbol & 0xFFF]: the last nibble received sits in the low 4 bits.
// Secondary characters come back with 0x100 set, -1 is "no such code".
export const DOMINO_VARIDECODE = (() => {
  const t = new Int16Array(4096).fill(-1);
  for (let c = 0; c < 512; c++) {
    const nib = dominoVaricode(c);
    let sym = 0;
    for (const v of nib) sym = (sym << 4) | v;
    t[sym & 0xfff] = c < 256 ? c : ((c - 256) | 0x100);
  }
  return t;
})();

// THOR's primary alphabet is the IZ8BLY MFSK varicode; codes include their
// trailing "00". Its 12-bit secondary codes (>= 0xB80) are not printed.
const MFSK_VARIDECODE = new Map(MFSK_VARICODE.map((c, i) => [parseInt(c, 2), i]));

function _clampSquelch(v, fb) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.max(0, Math.min(100, n));
}

export class IfkDecoder {
  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate
      : (() => Number(options.sampleRate) || 12000);
    this._family = options.family === 'thor' ? 'thor' : 'dominoex';
    this._fam = FAMILY[this._family];
    const modes = this._fam.modes;
    this._mode = modes.find((m) => m.key === options.mode) || modes.find((m) => /16$/.test(m.key)) || modes[0];
    this._centerHz = Number(options.centerHz) || 1500;
    this._sqDefault = this._family === 'thor' ? THOR_SQUELCH_DEFAULT : DOMINOEX_SQUELCH_DEFAULT;
    this._squelch = _clampSquelch(options.squelch, this._sqDefault);

    this.onChar    = typeof options.onChar    === 'function' ? options.onChar    : null;
    this.onStatus  = typeof options.onStatus  === 'function' ? options.onStatus  : null;
    this.onMetrics = typeof options.onMetrics === 'function' ? options.onMetrics : null;

    this._preset();
  }

  setSquelch(v) { this._squelch = _clampSquelch(v, this._sqDefault); }

  reset() { this._preset(); }

  feed(pcm) {
    if (!pcm || !pcm.length) return;
    const sr = this._sampleRateFn() || 12000;
    this._rs.run(pcm, sr, this._sink);
    this._maybeEmitMetrics();
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  _preset() {
    const m = this._mode, fam = this._fam;
    const sr = m.sr;
    this._sr = sr;
    this._symlen = m.symlen;
    this._ds = m.ds;
    this._tonespacing = sr * m.ds / m.symlen;
    this._bandwidth = NUMTONES * this._tonespacing;
    this._basetone = Math.floor(fam.basefreq * m.symlen / sr + 0.5);
    this._lotone = this._basetone - EXTONES * m.ds;
    this._hitone = this._basetone + NUMTONES * m.ds + EXTONES * m.ds;
    this._numbins = this._hitone - this._lotone;
    this._width = PATHS * this._numbins;
    this._twosym = 2 * m.symlen;

    // Analytic band around the signal (fldigi: Hilbert + fftfilt at
    // FIRSTIF +/- bandwidth, i.e. its default filter factor 2.0).
    const bp = complexBandpass(BPF_TAPS, this._centerHz, this._bandwidth, sr);
    this._bpfRe = bp.re; this._bpfIm = bp.im;
    this._hist = new Float64Array(2 * BPF_TAPS);
    this._histPos = 0;

    // Mixers: [0] moves the signal centre to FIRSTIF, [1..PATHS] move the
    // tone block onto the sliding-DFT bins, each a fraction of a bin apart.
    this._phase = new Float64Array(PATHS + 1);
    this._mixInc = new Float64Array(PATHS + 1);
    this._mixInc[0] = 2 * Math.PI * (this._centerHz - fam.firstif) / sr;
    for (let n = 1; n <= PATHS; n++) {
      const f = this._family === 'thor'
        ? fam.firstif - fam.basefreq - this._bandwidth * 0.5 + (sr / m.symlen) * (n / PATHS)
        : fam.firstif - fam.basefreq - this._bandwidth / 2 + this._tonespacing * ((n - 1) / PATHS);
      this._mixInc[n] = 2 * Math.PI * f / sr;
    }

    // Sliding DFTs (fldigi sfft, K1 = 0.99999).
    const K1 = 0.99999, L = m.symlen, nb = this._numbins;
    this._k2 = Math.pow(K1, L);
    this._vrRe = new Float64Array(nb); this._vrIm = new Float64Array(nb);
    for (let b = 0; b < nb; b++) {
      const phi = 2 * Math.PI * (this._lotone + b) / L;
      this._vrRe[b] = K1 * Math.cos(phi); this._vrIm[b] = K1 * Math.sin(phi);
    }
    this._binRe = Array.from({ length: PATHS }, () => new Float64Array(nb));
    this._binIm = Array.from({ length: PATHS }, () => new Float64Array(nb));
    this._dlyRe = Array.from({ length: PATHS }, () => new Float64Array(L));
    this._dlyIm = Array.from({ length: PATHS }, () => new Float64Array(L));
    this._dlyPtr = 0;

    // Two symbols of bin magnitudes (fldigi's pipe[]; only abs() is ever used).
    this._pipe = new Float32Array(this._twosym * this._width);
    this._pipeptr = 0;

    this._syncfilter = new MovAvg(fam.syncLen);
    this._synccounter = 0;
    this._currsymbol = this._prev1symbol = this._prev2symbol = 0;
    this._staticburst = false;
    this._sig = this._noise = 0;
    this._s2n = 0;
    this._metric = 0;

    // DominoEX varicode assembler.
    this._symbolbuf = [0, 0, 0];
    this._symcounter = 0;

    // THOR FEC chain.
    if (this._family === 'thor') {
      const k15 = m.k === 15;
      this._viterbi = k15
        ? new Viterbi(15, 0o44735, 0o63057, 15 * 12)
        : new Viterbi(7, 0x6d, 0x4f, 45);
      this._rxinlv = new Interleaver(4, m.depth, false);
      this._pair = [0, 0];
      this._paircount = 0;
      this._datashreg = 1;
      this._fecConf = 0;
      this._softSym = { lastCWI: new Uint8Array(this._width + 2), nextCWI: new Uint8Array(this._width + 2) };
      this._sb = { lastc: 0, lastmag: 0, nowmag: 0, prev1rawdoppler: 0, lastdoppler: 0, nowdoppler: 0 };
      this._pre = { check: 0, twocount: 0, neg16: false };
      this._vout = { metric: 0 };
    }

    this._rs = new LinearResampler(sr);
    this._sink = (x) => this._sample(x);
    this._lastMetricsAt = 0;
    this._lastPrinted = 0;
    this._samples = 0;
  }

  // ── Per-sample front end ────────────────────────────────────────────────

  _sample(x) {
    this._samples++;
    // Complex band-pass of the real input.
    const T = BPF_TAPS, h = this._hist;
    let p = this._histPos;
    h[p] = x; h[p + T] = x;
    p = p + 1 === T ? 0 : p + 1;
    this._histPos = p;
    let zr = 0, zi = 0;
    const br = this._bpfRe, bi = this._bpfIm;
    for (let k = 0; k < T; k++) {
      const v = h[p + k];
      zr += v * br[T - 1 - k];
      zi += v * bi[T - 1 - k];
    }
    // Mixer 0 (fldigi's mixer(): multiply by e^{j phase}, phase decreasing).
    let ph = this._phase[0];
    let c = Math.cos(ph), s = Math.sin(ph);
    const r0 = zr * c - zi * s, i0 = zr * s + zi * c;
    ph -= this._mixInc[0];
    if (ph < 0) ph += 2 * Math.PI;
    this._phase[0] = ph;

    const nb = this._numbins, vr = this._vrRe, vi = this._vrIm, k2 = this._k2;
    const dp = this._dlyPtr;
    const row = this._pipeptr * this._width;
    const pipe = this._pipe;
    for (let j = 0; j < PATHS; j++) {
      let pj = this._phase[j + 1];
      c = Math.cos(pj); s = Math.sin(pj);
      const ir = r0 * c - i0 * s, ii = r0 * s + i0 * c;
      pj -= this._mixInc[j + 1];
      if (pj < 0) pj += 2 * Math.PI;
      this._phase[j + 1] = pj;

      const dr = this._dlyRe[j], di = this._dlyIm[j];
      const ur = ir - k2 * dr[dp], ui = ii - k2 * di[dp];
      dr[dp] = ir; di[dp] = ii;
      const bre = this._binRe[j], bim = this._binIm[j];
      for (let b = 0; b < nb; b++) {
        // bins = (bins + z) * vrot
        const ar = bre[b] + ur, ai = bim[b] + ui;
        const nr = ar * vr[b] - ai * vi[b];
        const ni = ar * vi[b] + ai * vr[b];
        bre[b] = nr; bim[b] = ni;
        pipe[row + b * PATHS + j] = Math.sqrt(nr * nr + ni * ni);
      }
    }
    this._dlyPtr = dp + 1 === this._symlen ? 0 : dp + 1;

    if (--this._synccounter <= 0) {
      this._synccounter = this._symlen;
      if (this._family === 'thor') {
        this._currsymbol = this._softdecode();
        this._evalS2n();
        this._softdecodesymbol();
      } else {
        this._currsymbol = this._harddecode();
        this._dominoSymbol();
        this._evalS2n();
      }
      this._synchronize();
      this._prev2symbol = this._prev1symbol;
      this._prev1symbol = this._currsymbol;
    }
    if (++this._pipeptr >= this._twosym) this._pipeptr = 0;
  }

  _mag(ptr, i) { return this._pipe[ptr * this._width + i]; }

  // ── Symbol decisions ──────────────────────────────────────────────────────

  _harddecode() {
    const W = this._width, row = this._pipeptr * W, pipe = this._pipe;
    let avg = 0, max = 0, symbol = 0;
    for (let i = 0; i < W; i++) avg += pipe[row + i];
    avg /= W;
    if (avg < 1e-10) avg = 1e-10;
    // fldigi adds the magnitudes to the average a second time here (its CWI
    // loop); kept, because the static-burst threshold was tuned with it.
    for (let i = 0; i < W; i++) {
      const x = pipe[row + i];
      avg += x;
      if (x > max) { max = x; symbol = i; }
    }
    avg /= W;
    this._staticburst = max / avg < 1.2;
    return symbol;
  }

  _softdecode() {
    const W = this._width, row = this._pipeptr * W, pipe = this._pipe;
    const { lastCWI, nextCWI } = this._softSym;
    const BAIL = 6;
    nextCWI.fill(0);
    const p2 = this._prev2symbol;
    if (p2 && p2 < W - 1) lastCWI[p2 - 1] = lastCWI[p2] = lastCWI[p2 + 1] = 0;
    const lo = 1, hi = W - 1;
    let avg = 0, cnt = 0;
    for (let i = lo; i < hi; i++) if (!lastCWI[i]) { avg += pipe[row + i]; cnt++; }
    avg /= Math.max(1, cnt);
    if (avg < 1e-10) avg = 1e-10;
    let tries = 0, max = 0, symbol = 0;
    do {
      tries++;
      max = 0;
      for (let i = lo; i < hi; i++) {
        const x = pipe[row + i];
        if (x > max && !nextCWI[i - 1] && !nextCWI[i] && !nextCWI[i + 1]) { max = x; symbol = i; }
      }
      if (symbol && symbol < W - 1) {
        if (Math.abs(this._prev1symbol - symbol) < PATHS) {
          nextCWI[symbol - 1] = nextCWI[symbol] = nextCWI[symbol + 1] = 1;
        } else if (lastCWI[symbol - 1] || lastCWI[symbol] || lastCWI[symbol + 1]) {
          nextCWI[symbol - 1] = nextCWI[symbol] = nextCWI[symbol + 1] = 1;
        }
      }
    } while (nextCWI[symbol] && tries < BAIL);
    lastCWI.set(nextCWI);
    this._staticburst = max / avg < 1.2;
    return tries >= BAIL ? 0 : symbol;
  }

  _synchronize() {
    if (this._staticburst) return;
    if (this._currsymbol === this._prev1symbol) return;
    if (this._prev1symbol === this._prev2symbol) return;
    let syn = -1, max = 0;
    const T = this._twosym, ps = this._prev1symbol;
    for (let i = 0, j = this._pipeptr; i < T; i++) {
      const v = this._mag(j, ps);
      if (v > max) { max = v; syn = i; }
      j = j + 1 === T ? 0 : j + 1;
    }
    syn = this._syncfilter.run(syn);
    this._synccounter += Math.floor((syn - this._symlen) / NUMTONES + 0.5);
  }

  // NOT fldigi's estimate. fldigi takes the noise from the same bin one
  // symbol earlier, which reads low on some perfectly clean signals: the real
  // DominoEX 16 recording scores 26 of 100 at any tuning (DominoEX 11 scores
  // 100), so any squelch that keeps noise out cuts it off. Here the noise is
  // the mean of all the other bins of the current symbol: measured, noise
  // alone stays at or under 20, every recording reads 83 and up, and the
  // weakest copy that is still readable reads 37 or more.
  _evalS2n() {
    const W = this._width, row = this._pipeptr * W, p = this._pipe, cur = this._currsymbol;
    const s = p[row + cur];
    let sum = 0, n = 0;
    for (let i = 0; i < W; i++) {
      if (Math.abs(i - cur) <= PATHS) continue;
      sum += p[row + i]; n++;
    }
    // x2: a Rayleigh-distributed bin's mean against the strongest of ~150.
    const nz = n ? 2 * sum / n : 0;
    this._sig = decayavg(this._sig, s, 8);
    this._noise = decayavg(this._noise, nz, 8);
    this._s2n = this._noise > 0 ? 20 * Math.log10(this._sig / this._noise) : 0;
    const met = 6 * this._s2n;
    this._metric = met < 0 ? 0 : met > 100 ? 100 : met;
  }

  _open() { return this._squelch <= 0 || this._metric > this._squelch; }

  _emit(ch) {
    if (ch < 0 || ch & 0x100) return;        // secondary channel: not printed
    if (ch === 0) return;                    // idle NUL
    this._lastPrinted = this._samples;
    const last = this._lastChar;
    this._lastChar = ch;
    if (!this.onChar) return;
    if (ch === 13) this.onChar('\n');
    else if (ch === 10) { if (last !== 13) this.onChar('\n'); }
    else if ((ch >= 32 && ch <= 126) || ch >= 160) this.onChar(String.fromCharCode(ch));
  }

  // ── DominoEX: nibble varicode, no FEC ──────────────────────────────────────

  _dominoSymbol() {
    let fdiff = (this._currsymbol - this._prev1symbol) / this._ds / PATHS;
    let c = Math.floor(fdiff + 0.5) - 2;
    if (c < 0) c += NUMTONES;
    const buf = this._symbolbuf;
    if (!(c & 0x8)) {
      if (this._symcounter <= 3) {
        let sym = 0;
        for (let i = 0; i < this._symcounter; i++) sym |= buf[i] << (4 * i);
        const ch = DOMINO_VARIDECODE[sym & 0xfff];
        if (!this._staticburst && this._open()) this._emit(ch);
      }
      this._symcounter = 0;
    }
    buf[2] = buf[1]; buf[1] = buf[0]; buf[0] = c;
    if (++this._symcounter > 4) this._symcounter = 4;
  }

  // ── THOR: soft bits -> interleaver -> Viterbi -> MFSK varicode ───────────

  _preambledetect(c) {
    const P = this._pre;
    if (P.twocount > 14) P.twocount = 0;
    if (c === -16 && P.twocount > 2) P.neg16 = true;
    else if (c !== 2) P.neg16 = false;
    else P.twocount++;
    if (c !== -16 && c !== 2 && P.twocount > 1) P.twocount -= 2;
    if (P.twocount > 4 && P.neg16) {
      if (++P.check > 4) return true;
    } else P.check = 0;
    return false;
  }

  _softflushrx() {
    const f = [PUNCTURE, PUNCTURE, PUNCTURE, PUNCTURE];
    for (let i = 0; i < 90; i++) this._rxinlv.symbols(f);
    for (let j = 0; j < 128; j++) this._viterbi.decode(PUNCTURE, PUNCTURE, null);
  }

  _softdecodesymbol() {
    const S = this._sb, W = PATHS * this._ds;
    let nextmag = 127;
    let outofrange = false;
    const fdiff = (this._currsymbol - this._prev1symbol) / PATHS / this._ds;
    let c = Math.floor(fdiff + 0.5);
    if (c < -16 || c === 0 || c === 1 || c > 17) outofrange = true;
    if (this._preambledetect(c)) {
      this._softflushrx();
      S.lastmag = 0;
      return;
    }
    c -= 2;
    if (c < 0) c += NUMTONES;

    // C's % keeps the sign of the dividend.
    let raw = (this._currsymbol - this._prev1symbol) % W;
    if (raw === 0) S.nowdoppler = 1;
    else {
      if (-S.prev1rawdoppler === raw) { raw = 0; S.lastdoppler = 1; }
      S.nowdoppler = Math.abs(raw) <= W / 2 ? 1 - Math.abs(raw) / W : Math.abs(raw) / W;
    }
    S.prev1rawdoppler = raw;

    if (outofrange) { S.lastmag = Math.trunc(S.lastmag / 2); S.nowmag = 0; nextmag = Math.trunc(nextmag / 2); }
    if (this._currsymbol === 0) { S.nowmag = 0; nextmag = 0; }
    if (!this._open()) S.nowmag = 0;
    if (this._staticburst) { S.nowmag = Math.trunc(S.nowmag / 16); nextmag = Math.trunc(nextmag / 16); }

    S.lastmag = Math.trunc(S.lastmag * S.lastdoppler);
    let one, zero;
    if (S.lastmag <= 0) { one = zero = PUNCTURE; }
    else if (S.lastmag > 127) { one = 255; zero = 0; }
    else { one = S.lastmag + 128; zero = 127 - S.lastmag; }

    let lc = S.lastc;
    const syms = [0, 0, 0, 0];
    syms[3] = lc & 1 ? one : zero; lc >>= 1;
    syms[2] = lc & 1 ? one : zero; lc >>= 1;
    syms[1] = lc & 1 ? one : zero; lc >>= 1;
    syms[0] = lc & 1 ? one : zero;
    this._rxinlv.symbols(syms);
    for (let i = 0; i < 4; i++) this._decodePairs(syms[i]);

    S.lastc = c;
    S.lastmag = S.nowmag;
    S.nowmag = nextmag;
    S.lastdoppler = S.nowdoppler;
  }

  _decodePairs(symbol) {
    this._pair[0] = this._pair[1];
    this._pair[1] = symbol;
    this._paircount = this._paircount ? 0 : 1;
    if (this._paircount) return;
    const c = this._viterbi.decode(this._pair[0], this._pair[1], this._vout);
    if (this._vout.metric < 255 / 2) this._fecConf -= 2 + Math.trunc(this._fecConf / 2);
    else this._fecConf += 2;
    this._fecConf = Math.max(0, Math.min(100, this._fecConf));
    if (!this._open()) return;
    this._datashreg = ((this._datashreg << 1) | (c ? 1 : 0)) >>> 0;
    if ((this._datashreg & 7) === 1) {
      const code = this._datashreg >>> 1;
      const ch = code < 0xb80 ? MFSK_VARIDECODE.get(code) : undefined;
      this._emit(ch === undefined ? -1 : ch);
      this._datashreg = 1;
    }
    // A long run of zeros (no character boundary) must not overflow.
    if (this._datashreg > 0x3fffffff) this._datashreg = 1;
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  _maybeEmitMetrics() {
    if (this._samples - this._lastMetricsAt < this._sr / 4) return;
    this._lastMetricsAt = this._samples;
    if (!this.onMetrics) return;
    const open = this._open();
    // Where the signal sits: the current tone's bin back in audio Hz.
    this.onMetrics({
      snrDb: Math.round(this._s2n * 10) / 10,
      lockQuality: this._family === 'thor' ? this._fecConf : Math.round(this._metric),
      metric: Math.round(this._metric),
      centerHz: this._centerHz,
      timingLocked: open && this._samples - this._lastPrinted < 3 * this._symlen * 4,
      squelchOpen: open,
    });
  }
}

export default IfkDecoder;
