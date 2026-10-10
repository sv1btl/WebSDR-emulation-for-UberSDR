// mt63.js — MT63 decoder (receive only): 500 / 1000 / 2000 Hz, short and long
// interleave.
//
// A port of the receiver in fldigi's src/mt63/ (mt63base.cxx MT63rx +
// MT63decoder, the parts of dsp.cxx they use, symbol.dat, mt63intl.dat), which
// is Pawel Jalocha SP9VRC's original MT63 code.
//
// How MT63 works
//   64 carriers at once, spaced 7.8125 Hz (MT63-500), 15.625 Hz (1000) or
//   31.25 Hz (2000), each sending one differential-BPSK bit per symbol at 5, 10
//   or 20 symbols a second. Every symbol carries one 7-bit character, spread
//   over all 64 carriers by a 64-point Walsh function, and the bits are then
//   interleaved in time across 32 (short) or 64 (long) symbols. A character
//   therefore survives losing a good part of its carriers and a burst of
//   symbols, which is why MT63 copies through QRM and selective fading that
//   wipe out narrower modes. Its price is the bandwidth and the delay: the text
//   lags the audio by the interleaver, 3.2 s (MT63-1000 short) to 12.8 s.
//
// The receiver follows Jalocha's: an I/Q split filter + decimation; a 512-point
// FFT probed four times per symbol; a synchroniser that correlates each
// carrier with itself one symbol later to find symbol timing and frequency
// offset at once (no preamble, no pilot); and a data demodulator that
// differentially decodes the carriers, de-interleaves, and picks the Walsh
// function — and the carrier alignment, +/- 8 carriers — that fits best.
//
// Interface mirrors mfsk.js:
//   new Mt63Decoder({sampleRate, centerHz, mode, squelch,
//                    onChar, onStatus, onMetrics});
//   .feed(Float32Array pcm)   .setSquelch(v)   .reset()

import { LinearResampler } from './fldigiFec.js';

const RATE = 8000;
const SYMBOL_LEN = 512;          // FFT window = symbol shape length
const SYMBOL_SEPAR = 200;        // samples between symbols on a carrier
const DATA_CARR_SEPAR = 4;       // carriers are 4 FFT bins apart
const DATA_CARRIERS = 64;
const SYMBOL_DIV = 4;            // the input is probed 4x per symbol
const SCAN_MARGIN = 8;
const DATA_SCAN_MARGIN = 8;
const INTEG = 16;                // fldigi default (mt63_rx_integration off)

export const MT63_MODES = [
  { key: 'mt63-500s', label: 'MT63-500 short', bw: 500, long: false },
  { key: 'mt63-500l', label: 'MT63-500 long', bw: 500, long: true },
  { key: 'mt63-1000s', label: 'MT63-1000 short', bw: 1000, long: false },
  { key: 'mt63-1000l', label: 'MT63-1000 long', bw: 1000, long: true },
  { key: 'mt63-2000s', label: 'MT63-2000 short', bw: 2000, long: false },
  { key: 'mt63-2000l', label: 'MT63-2000 long', bw: 2000, long: true },
];

/** Occupied bandwidth of a sub-mode, in Hz. */
export function mt63Bandwidth(key) {
  const m = MT63_MODES.find((x) => x.key === key) || MT63_MODES[2];
  return m.bw;
}

/** The usual audio centre: the lowest carrier at 500 Hz, as fldigi sends it. */
export function mt63DefaultCenter(key) {
  return 500 + mt63Bandwidth(key) / 2;
}

// Squelch on the FEC signal-to-noise (fldigi's MT63 metric, linear). Noise
// alone sits at 3.0-3.3; a locked signal reads 4.5 and up, usually far more.
export const MT63_SQUELCH_DEFAULT = 4;

// Symbol shape (symbol.dat), first half: it is symmetric about 256.
const SHAPE_HALF = [
  .00000000, .00000665, .00002657, .00005975, .00010613, .00016562, .00023810, .00032341, .00042134, .00053162, .00065389, .00078773,
  .00093261, .00108789, .00125283, .00142653, .00160798, .00179599, .00198926, .00218628, .00238542, .00258487, .00278264, .00297662,
  .00316452, .00334394, .00351232, .00366701, .00380526, .00392424, .00402109, .00409288, .00413671, .00414969, .00412898, .00407182,
  .00397555, .00383764, .00365574, .00342767, .00315145, .00282534, .00244787, .00201781, .00153424, .00099653, .00040435, -.00024231,
  -.00094314, -.00169753, -.00250453, -.00336293, -.00427118, -.00522749, -.00622977, -.00727569, -.00836272, -.00948809, -.01064886, -.01184193,
  -.01306405, -.01431189, -.01558198, -.01687083, -.01817486, -.01949051, -.02081416, -.02214223, -.02347113, -.02479733, -.02611728, -.02742752,
  -.02872457, -.03000504, -.03126551, -.03250262, -.03371298, -.03489320, -.03603988, -.03714954, -.03821868, -.03924367, -.04022079, -.04114620,
  -.04201589, -.04282570, -.04357126, -.04424801, -.04485118, -.04537575, -.04581648, -.04616787, -.04642421, -.04657955, -.04662769, -.04656225,
  -.04637665, -.04606414, -.04561786, -.04503082, -.04429599, -.04340631, -.04235475, -.04113436, -.03973834, -.03816006, -.03639316, -.03443155,
  -.03226956, -.02990192, -.02732385, -.02453112, -.02152012, -.01828789, -.01483216, -.01115146, -.00724508, -.00311317, .00124328, .00582236,
  .01062127, .01563627, .02086273, .02629504, .03192674, .03775043, .04375787, .04993995, .05628681, .06278780, .06943159, .07620621,
  .08309914, .09009732, .09718730, .10435526, .11158715, .11886870, .12618560, .13352351, .14086819, .14820561, .15552198, .16280389,
  .17003841, .17721311, .18431620, .19133661, .19826401, .20508896, .21180289, .21839823, .22486845, .23120806, .23741270, .24347919,
  .24940549, .25519079, .26083547, .26634116, .27171067, .27694807, .28205857, .28704860, .29192571, .29669855, .30137684, .30597130,
  .31049362, .31495636, .31937292, .32375741, .32812465, .33249001, .33686936, .34127898, .34573545, .35025554, .35485613, .35955412,
  .36436627, .36930915, .37439902, .37965170, .38508250, .39070609, .39653642, .40258662, .40886890, .41539446, .42217341, .42921470,
  .43652603, .44411383, .45198311, .46013753, .46857925, .47730896, .48632585, .49562756, .50521021, .51506840, .52519520, .53558220,
  .54621950, .55709582, .56819849, .57951351, .59102568, .60271860, .61457478, .62657574, .63870210, .65093366, .66324951, .67562817,
  .68804763, .70048553, .71291922, .72532590, .73768272, .74996688, .76215572, .77422687, .78615828, .79792836, .80951602, .82090079,
  .83206287, .84298315, .85364335, .86402598, .87411443, .88389296, .89334677, .90246195, .91122553, .91962547, .92765062, .93529073,
  .94253642, .94937916, .95581122, .96182562, .96741616, .97257728, .97730410, .98159233, .98543825, .98883864, .99179079, .99429241,
  .99634163, .99793696, .99907728, .99976178, .99999000,
];

export const MT63_SYMBOL_SHAPE = (() => {
  const s = new Float64Array(SYMBOL_LEN);
  for (let i = 0; i <= 256; i++) s[i] = SHAPE_HALF[i];
  for (let k = 1; k < 256; k++) s[256 + k] = SHAPE_HALF[256 - k];
  return s;
})();

// Interleave patterns (mt63intl.dat).
export const MT63_SHORT_INTLV = Array.from({ length: 64 }, (_, i) => 4 + (i & 3));
export const MT63_LONG_INTLV = Array.from({ length: 64 }, (_, i) => (i + 1) & 63);

// ── dsp.cxx pieces ──────────────────────────────────────────────────────────

/** dsp_r2FFT: twiddles e^{+j2πk/N}, butterflies multiply by conj(W). */
export class R2FFT {
  constructor(size) {
    this.size = size;
    this.twRe = new Float64Array(size);
    this.twIm = new Float64Array(size);
    for (let k = 0; k < size; k++) {
      const ph = 2 * Math.PI * k / size;
      this.twRe[k] = Math.cos(ph); this.twIm[k] = Math.sin(ph);
    }
    this.bitRev = new Int32Array(size);
    for (let idx = 0; idx < size; idx++) {
      let r = 0;
      for (let mask = size >> 1, rmask = 1; mask; mask >>= 1, rmask <<= 1) if (idx & mask) r |= rmask;
      this.bitRev[idx] = r;
    }
  }

  /** In place on bit-reversed input (the caller scrambles, as fldigi). */
  core(re, im) {
    const N = this.size, half = N >> 1, wr = this.twRe, wi = this.twIm;
    for (let b = 0; b < N; b += 2) {
      const r1 = re[b + 1], i1 = im[b + 1];
      re[b + 1] = re[b] - r1; im[b + 1] = im[b] - i1;
      re[b] += r1; im[b] += i1;
    }
    for (let groups = half >> 1, ghs = 2; groups; groups >>= 1, ghs <<= 1) {
      for (let g = 0, bf = 0; g < groups; g++, bf += ghs) {
        for (let t = 0; t < half; t += groups, bf++) {
          const x1r = re[bf + ghs], x1i = im[bf + ghs];
          const Wr = wr[t], Wi = wi[t];
          const ar = x1r * Wr + x1i * Wi;
          const ai = -x1r * Wi + x1i * Wr;
          re[bf + ghs] = re[bf] - ar; im[bf + ghs] = im[bf] - ai;
          re[bf] += ar; im[bf] += ai;
        }
      }
    }
  }
}

function walshTrans(d, len) {
  for (let step = 1; step < len; step *= 2) {
    for (let p = 0; p < len; p += 2 * step) {
      for (let q = p; q - p < step; q++) {
        const b1 = d[q], b2 = d[q + step];
        d[q] = b1 + b2;
        d[q + step] = b2 - b1;
      }
    }
  }
}

/** Test helper: dspWalshInvTrans. */
export function walshInvTrans(d, len) {
  for (let step = len / 2; step; step = Math.floor(step / 2)) {
    for (let p = 0; p < len; p += 2 * step) {
      for (let q = p; q - p < step; q++) {
        const b1 = d[q], b2 = d[q + step];
        d[q] = b1 - b2;
        d[q + step] = b1 + b2;
      }
    }
  }
}

function blackman3(ph) {
  return 0.35875 + 0.48829 * Math.cos(ph) + 0.14128 * Math.cos(2 * ph) + 0.01168 * Math.cos(3 * ph);
}

/** dspLowPass2 state for an array of reals: two cascaded integrators. */
function lp2(inp, mid, out, k, W1, W2, W5) {
  const sum = mid[k] + out[k], diff = mid[k] - out[k];
  mid[k] += W2 * inp - W1 * sum;
  out[k] += W5 * diff;
}

/** dspSelFitAver for reals: mean of the values within SelThres sigma. */
function selFitAverReal(data, len, selThres, loops) {
  let sum = 0, err = 0;
  for (let i = 0; i < len; i++) { sum += data[i]; err += data[i] * data[i]; }
  let lev = sum / len;
  err = err / len - lev * lev;
  for (let loop = 0; loop < loops; loop++) {
    const thres = selThres * selThres * err;
    let s = 0, e = 0, incl = 0;
    for (let i = 0; i < len; i++) {
      const d = (data[i] - lev) * (data[i] - lev);
      if (d <= thres) { s += data[i]; e += d; incl++; }
    }
    s /= incl;
    const dl = s - lev;
    e = e / incl - dl * dl;
    lev += dl;
    err = Math.abs(e);
  }
  return { aver: lev, rms: Math.sqrt(err) };
}

/** dspSelFitAver for complex values. */
function selFitAverCmpx(re, im, len, selThres, loops) {
  let sr = 0, si = 0, err = 0;
  for (let i = 0; i < len; i++) { sr += re[i]; si += im[i]; err += re[i] * re[i] + im[i] * im[i]; }
  let lr = sr / len, li = si / len;
  err = err / len - (lr * lr + li * li);
  for (let loop = 0; loop < loops; loop++) {
    const thres = 0.5 * selThres * selThres * err;
    let ar = 0, ai = 0, e = 0, incl = 0;
    for (let i = 0; i < len; i++) {
      const dr = re[i] - lr, di = im[i] - li, d = dr * dr + di * di;
      if (d <= thres) { ar += re[i]; ai += im[i]; e += d; incl++; }
    }
    ar /= incl; ai /= incl;
    const dlr = ar - lr, dli = ai - li;
    e = e / incl - (dlr * dlr + dli * dli);
    err = Math.abs(e);
    lr += dlr; li += dli;
  }
  return { re: lr, im: li, rms: Math.sqrt(err) };
}

// ── MT63decoder: de-interleave + Walsh FEC ─────────────────────────────────

class Mt63FecDecoder {
  constructor(intlv, pattern) {
    const C = DATA_CARRIERS;
    this.scanLen = 2 * DATA_SCAN_MARGIN + 1;
    this.scanSize = C + 2 * DATA_SCAN_MARGIN;
    this.W1 = 1 / INTEG; this.W2 = 2 / INTEG; this.W5 = 5 / INTEG;
    this.decodeLen = INTEG / 2;
    this.decodeSize = this.decodeLen * this.scanLen;
    this.decodePipe = new Int32Array(this.decodeSize);
    this.decodePtr = 0;
    this.intlvLen = intlv;
    this.intlvPatt = new Int32Array(C);
    for (let p = 0, i = 0; i < C; i++) {
      this.intlvPatt[i] = p * this.scanSize;
      p += pattern[i];
      if (p >= intlv) p -= intlv;
    }
    this.intlvSize = (intlv + 1) * this.scanSize;
    this.intlvPipe = new Float64Array(this.intlvSize);
    this.intlvPtr = 0;
    this.walsh = new Float64Array(C);
    this.snrMid = new Float64Array(this.scanLen);
    this.snrOut = new Float64Array(this.scanLen);
    this.output = 0;
    this.snr = 0;
    this.carrOfs = 0;
  }

  process(data) {
    const C = DATA_CARRIERS, S = this.scanSize, pipe = this.intlvPipe, w = this.walsh;
    pipe.set(data.subarray(0, S), this.intlvPtr);
    for (let s = 0; s < this.scanLen; s++) {
      for (let i = 0; i < C; i++) {
        let k = this.intlvPtr - S - this.intlvPatt[i];
        if (k < 0) k += this.intlvSize;
        if ((s & 1) && (i & 1)) {
          k += S;
          if (k >= this.intlvSize) k -= this.intlvSize;
        }
        w[i] = pipe[k + s + i];
      }
      walshTrans(w, C);
      let min = w[0], minPos = 0, max = w[0], maxPos = 0;
      for (let i = 1; i < C; i++) {
        if (w[i] < min) { min = w[i]; minPos = i; }
        if (w[i] > max) { max = w[i]; maxPos = i; }
      }
      let code, sig;
      if (Math.abs(max) > Math.abs(min)) { code = maxPos + C; sig = Math.abs(max); w[maxPos] = 0; }
      else { code = minPos; sig = Math.abs(min); w[minPos] = 0; }
      let pw = 0;
      for (let i = 0; i < C; i++) pw += w[i] * w[i];
      const noise = Math.sqrt(pw / C);
      const snr = noise > 0 ? sig / noise : 0;
      lp2(snr, this.snrMid, this.snrOut, s, this.W1, this.W2, this.W5);
      this.decodePipe[this.decodePtr + s] = code;
    }
    this.intlvPtr += S;
    if (this.intlvPtr >= this.intlvSize) this.intlvPtr = 0;
    this.decodePtr += this.scanLen;
    if (this.decodePtr >= this.decodeSize) this.decodePtr = 0;
    let max = this.snrOut[0], maxPos = 0;
    for (let s = 1; s < this.scanLen; s++) if (this.snrOut[s] > max) { max = this.snrOut[s]; maxPos = s; }
    this.output = this.decodePipe[this.decodePtr + maxPos];
    this.snr = max;
    this.carrOfs = maxPos - (this.scanLen - 1) / 2;
  }
}

// ── The receiver ────────────────────────────────────────────────────────────

function _clampSquelch(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return MT63_SQUELCH_DEFAULT;
  return Math.max(0, Math.min(40, n));
}

export class Mt63Decoder {
  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate
      : (() => Number(options.sampleRate) || 12000);
    this._mode = MT63_MODES.find((m) => m.key === options.mode) || MT63_MODES[2];
    this._centerHz = Number(options.centerHz) || mt63DefaultCenter(this._mode.key);
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
    this._run();
    this._maybeEmitMetrics();
  }

  // ── Preset (MT63rx::Preset) ───────────────────────────────────────────────

  _preset() {
    const bw = this._mode.bw, freq = this._centerHz;
    const hbw = 1.5 * bw / 2;
    let wl = freq - hbw, wh = freq + hbw;
    if (wl < 100) wl = 100;
    if (wh > 4000) wh = 4000;
    wl *= Math.PI / 4000; wh *= Math.PI / 4000;
    let alias;
    if (bw === 500) { this._first = Math.floor((freq - bw / 2) * 256 / 500 + 0.5); alias = 128; this._decim = 8; }
    else if (bw === 1000) { this._first = Math.floor((freq - bw / 2) * 128 / 500 + 0.5); alias = 64; this._decim = 4; }
    else { this._first = Math.floor((freq - bw / 2) * 64 / 500 + 0.5); alias = 64; this._decim = 2; }

    // dspQuadrSplit with a Blackman3 band-pass (dspWinFirI / WinFirQ, shift 0).
    this._aliasLen = alias;
    this._shapeI = new Float64Array(alias);
    this._shapeQ = new Float64Array(alias);
    for (let i = 0; i < alias; i++) {
      const time = i + 1 - alias / 2;
      const ph = 2 * Math.PI * time / alias;
      const win = blackman3(ph);
      const si = time === 0 ? wh - wl : (Math.sin(wh * time) - Math.sin(wl * time)) / time;
      const sq = time === 0 ? 0 : (-Math.cos(wh * time) + Math.cos(wl * time)) / time;
      this._shapeI[i] = si * win / Math.PI;
      this._shapeQ[i] = -sq * win / Math.PI;
    }
    this._tap = new Float64Array(2 * alias);
    this._tapPos = 0;
    this._tapCount = 0;
    this._decCount = 0;

    const W = SYMBOL_LEN;
    this._W = W;
    this._mask = W - 1;
    this._fft = new R2FFT(W);
    this._window = MT63_SYMBOL_SHAPE;
    this._fbRe = new Float64Array(W); this._fbIm = new Float64Array(W);
    this._fb2Re = new Float64Array(W); this._fb2Im = new Float64Array(W);

    this._syncStep = SYMBOL_SEPAR / SYMBOL_DIV;
    this._procDelay = INTEG * SYMBOL_SEPAR;
    this._trackLen = INTEG;
    const intlv = this._mode.long ? 64 : 32;
    const pattern = this._mode.long ? MT63_LONG_INTLV : MT63_SHORT_INTLV;

    // Processing line: a ring of complex samples with absolute positions.
    const maxDelay = this._procDelay + W + SYMBOL_SEPAR;
    let ring = 1;
    while (ring < 4 * maxDelay) ring <<= 1;
    this._lineRe = new Float64Array(ring);
    this._lineIm = new Float64Array(ring);
    this._lineMask = ring - 1;
    this._lineLen = maxDelay;          // zeros already "in" the line
    this._syncAbs = maxDelay;
    this._dataAbs = maxDelay - this._procDelay;

    this._scanFirst = this._first - SCAN_MARGIN * DATA_CARR_SEPAR;
    if (this._scanFirst < 0) this._scanFirst += W;
    this._scanLen = (DATA_CARRIERS + 2 * SCAN_MARGIN) * DATA_CARR_SEPAR;
    const SL = this._scanLen;
    this._syncPipe = Array.from({ length: SYMBOL_DIV }, () => ({ re: new Float64Array(SL), im: new Float64Array(SL) }));
    this._syncPtr = 0;
    this._phCorrRe = new Float64Array(SL); this._phCorrIm = new Float64Array(SL);
    const tw = this._fft;
    for (let c = (this._scanFirst * SYMBOL_SEPAR) & this._mask, i = 0; i < SL; i++) {
      const r = tw.twRe[c], m = tw.twIm[c];
      this._phCorrRe[i] = r * r - m * m;
      this._phCorrIm[i] = 2 * r * m;
      c = (c + SYMBOL_SEPAR) & this._mask;
    }
    this._corrMid = Array.from({ length: SYMBOL_DIV }, () => ({ re: new Float64Array(SL), im: new Float64Array(SL) }));
    this._corrOut = Array.from({ length: SYMBOL_DIV }, () => ({ re: new Float64Array(SL), im: new Float64Array(SL) }));
    this._W1 = 1 / INTEG; this._W2 = 2 / INTEG; this._W5 = 5 / INTEG;
    this._pwrMid = new Float64Array(SL); this._pwrOut = new Float64Array(SL);
    const ip = INTEG * SYMBOL_DIV;
    this._W1p = 1 / ip; this._W2p = 2 / ip; this._W5p = 5 / ip;
    this._corrNorm = Array.from({ length: SYMBOL_DIV }, () => ({ re: new Float64Array(SL), im: new Float64Array(SL) }));
    this._fitLen = 2 * SCAN_MARGIN * DATA_CARR_SEPAR;
    this._corrAver = Array.from({ length: SYMBOL_DIV }, () => ({ re: new Float64Array(this._fitLen), im: new Float64Array(this._fitLen) }));
    this._fitRe = new Float64Array(this._fitLen); this._fitIm = new Float64Array(this._fitLen);
    this._symbPipeRe = new Float64Array(this._trackLen);
    this._symbPipeIm = new Float64Array(this._trackLen);
    this._freqPipe = new Float64Array(this._trackLen);
    this._trackPtr = 0;
    this._symbFitPos = SCAN_MARGIN * DATA_CARR_SEPAR;
    this._locked = 0;
    this._symbConf = 0;
    this._freqOfs = 0;
    this._freqDev = 0;
    this._symbPtr = 0;
    this._symbShift = 0;
    this._averFreq = 0;
    this._averSymbRe = 0; this._averSymbIm = 0;
    this._holdThres = 1.5 * Math.sqrt(1 / (INTEG * DATA_CARRIERS));
    this._lockThres = 1.5 * this._holdThres;

    this._dataScanLen = DATA_CARRIERS + 2 * DATA_SCAN_MARGIN;
    this._dataScanFirst = this._first - DATA_SCAN_MARGIN * DATA_CARR_SEPAR;
    const DL = this._dataScanLen;
    this._refRe = new Float64Array(DL); this._refIm = new Float64Array(DL);
    this._dataPipeLen = INTEG / 2;
    this._dataPipe = Array.from({ length: this._dataPipeLen }, () => ({ re: new Float64Array(DL), im: new Float64Array(DL) }));
    this._dataPipePtr = 0;
    this._dW1 = 1 / INTEG; this._dW2 = 2 / INTEG; this._dW5 = 5 / INTEG;
    this._dPwrMid = new Float64Array(DL); this._dPwrOut = new Float64Array(DL);
    this._vecRe = new Float64Array(DL); this._vecIm = new Float64Array(DL);
    this._phase = new Float64Array(DL);
    this._dec = new Mt63FecDecoder(intlv, pattern);
    this._escape = 0;
    this._lastChar = 0;

    this._samples = 0;
    this._lastMetricsAt = 0;
    this._lastPrinted = -1e9;
    this._rs = new LinearResampler(RATE);
    this._sink = (v) => this._input(v);
  }

  // dspQuadrSplit::Process, one real sample at a time: an output every
  // `decim` inputs, from the last aliasLen inputs (oldest first).
  _input(v) {
    this._samples++;
    const L = this._aliasLen;
    let p = this._tapPos;
    this._tap[p] = v; this._tap[p + L] = v;
    p = p + 1 === L ? 0 : p + 1;
    this._tapPos = p;
    if (this._tapCount < L) { this._tapCount++; if (this._tapCount < L) return; this._decCount = this._decim; }
    if (++this._decCount < this._decim) return;
    this._decCount = 0;
    let si = 0, sq = 0;
    const t = this._tap, hI = this._shapeI, hQ = this._shapeQ;
    for (let k = 0; k < L; k++) { const x = t[p + k]; si += x * hI[k]; sq += x * hQ[k]; }
    const j = this._lineLen & this._lineMask;
    this._lineRe[j] = si; this._lineIm[j] = sq;
    this._lineLen++;
  }

  _run() {
    while (this._syncAbs + this._W < this._lineLen) {
      this._syncProcess(this._syncAbs);
      if (this._syncPtr === this._symbPtr) {
        const s1 = this._syncAbs - this._procDelay + (Math.trunc(this._symbShift) - this._symbPtr * this._syncStep);
        const s2 = s1 + SYMBOL_SEPAR / 2;
        this._dataProcess(s1, s2, this._freqOfs, s1 - this._dataAbs);
        this._dataAbs = s1;
      }
      this._syncAbs += this._syncStep;
    }
  }

  _loadSlice(abs, re, im, freqOfs) {
    const W = this._W, br = this._fft.bitRev, win = this._window, m = this._lineMask;
    if (freqOfs == null) {
      for (let i = 0; i < W; i++) {
        const r = br[i], j = (abs + i) & m;
        re[r] = this._lineRe[j] * win[i];
        im[r] = this._lineIm[j] * win[i];
      }
      return;
    }
    const P = -2 * Math.PI * freqOfs / W;
    const fr = Math.cos(P), fi = Math.sin(P);
    let pr = 1, pi = 0;
    for (let i = 0; i < W; i++) {
      const r = br[i], j = (abs + i) & m;
      const xr = this._lineRe[j], xi = this._lineIm[j];
      re[r] = (xr * pr - xi * pi) * win[i];
      im[r] = (xr * pi + xi * pr) * win[i];
      const nr = pr * fr - pi * fi;
      pi = pr * fi + pi * fr; pr = nr;
    }
  }

  // ── SyncProcess ───────────────────────────────────────────────────────────

  _doCorrelSum(c1, o1, c2, o2, aver, oa) {
    const s = 2 * DATA_CARR_SEPAR, d = DATA_CARRIERS * DATA_CARR_SEPAR, N = DATA_CARRIERS;
    let sr = 0, si = 0;
    for (let i = 0; i < d; i += s) {
      sr += c1.re[o1 + i] + c2.re[o2 + i];
      si += c1.im[o1 + i] + c2.im[o2 + i];
    }
    aver.re[oa] = sr / N; aver.im[oa] = si / N;
    for (let i = 0; i < this._fitLen - s;) {
      sr -= c1.re[o1 + i]; si -= c1.im[o1 + i];
      sr -= c2.re[o2 + i]; si -= c2.im[o2 + i];
      // fldigi subtracts the imaginary parts of the incoming terms here
      // (sx.im -= ...); kept as is — it is what every MT63 station decodes with.
      sr += c1.re[o1 + i + d]; si -= c1.im[o1 + i + d];
      sr += c2.re[o2 + i + d]; si -= c2.im[o2 + i + d];
      i += s;
      aver.re[oa + i] = sr / N; aver.im[oa + i] = si / N;
    }
  }

  _syncProcess(abs) {
    this._syncPtr = (this._syncPtr + 1) & (SYMBOL_DIV - 1);
    const re = this._fbRe, im = this._fbIm;
    this._loadSlice(abs, re, im, null);
    this._fft.core(re, im);

    const SL = this._scanLen, mask = this._mask;
    const prev = this._syncPipe[this._syncPtr];
    const cm = this._corrMid[this._syncPtr], co = this._corrOut[this._syncPtr];
    for (let i = 0; i < SL; i++) {
      const k = (this._scanFirst + i) & mask;
      const I = re[k], Q = im[k];
      const P = I * I + Q * Q;
      const A = Math.sqrt(P);
      let dI = 0, dQ = 0;
      if (P > 0) { dI = (I * I - Q * Q) / A; dQ = (2 * I * Q) / A; }
      lp2(P, this._pwrMid, this._pwrOut, i, this._W1p, this._W2p, this._W5p);
      const pI = prev.re[i] * this._phCorrRe[i] - prev.im[i] * this._phCorrIm[i];
      const pQ = prev.re[i] * this._phCorrIm[i] + prev.im[i] * this._phCorrRe[i];
      const cr = dQ * pQ + dI * pI;
      const ci = dQ * pI - dI * pQ;
      lp2(cr, cm.re, co.re, i, this._W1, this._W2, this._W5);
      lp2(ci, cm.im, co.im, i, this._W1, this._W2, this._W5);
      prev.re[i] = dI; prev.im[i] = dQ;
    }

    if (this._syncPtr !== (this._symbPtr ^ 2)) return;

    for (let s = 0; s < SYMBOL_DIV; s++) {
      const n = this._corrNorm[s], o = this._corrOut[s];
      for (let i = 0; i < SL; i++) {
        const p = this._pwrOut[i];
        if (p > 0) { n.re[i] = o.re[i] / p; n.im[i] = o.im[i] / p; } else { n.re[i] = n.im[i] = 0; }
      }
    }
    for (let s = 0; s < SYMBOL_DIV; s++) {
      const s2 = (s + SYMBOL_DIV / 2) & (SYMBOL_DIV - 1);
      for (let k = 0; k < 2 * DATA_CARR_SEPAR; k++) {
        this._doCorrelSum(this._corrNorm[s], k, this._corrNorm[s2], k + DATA_CARR_SEPAR, this._corrAver[s], k);
      }
    }
    const FL = this._fitLen, av = this._corrAver, fr = this._fitRe, fi = this._fitIm;
    const amp = (c, i) => Math.hypot(c.re[i], c.im[i]);
    for (let i = 0; i < FL; i++) {
      fr[i] = amp(av[0], i) - amp(av[2], i);
      fi[i] = amp(av[1], i) - amp(av[3], i);
    }
    // dspFindMaxdspPower(SymbFit + 2, FitLen - 4, j)
    let P = fr[2] * fr[2] + fi[2] * fi[2], j = 0;
    for (let i = 1; i < FL - 4; i++) {
      const pw = fr[i + 2] * fr[i + 2] + fi[i + 2] * fi[i + 2];
      if (pw > P) { P = pw; j = i; }
    }
    j += 2;
    let k = Math.trunc((j - this._symbFitPos) / DATA_CARR_SEPAR);
    if (k > 1) j -= (k - 1) * DATA_CARR_SEPAR;
    else if (k < -1) j -= (k + 1) * DATA_CARR_SEPAR;
    this._symbFitPos = j;

    let stRe, stIm, freqOfs;
    if (P > 0) {
      const I = fr[j] + 0.5 * (fr[j - 1] + fr[j + 1]);
      const Q = fi[j] + 0.5 * (fi[j - 1] + fi[j + 1]);
      stRe = I; stIm = Q;
      let symbShift = (Math.atan2(Q, I) / (2 * Math.PI)) * SYMBOL_DIV;
      if (symbShift < 0) symbShift += SYMBOL_DIV;
      const sp = (n) => I * fr[n] + Q * fi[n];
      const pI = sp(j) + 0.7 * sp(j - 1) + 0.7 * sp(j + 1);
      const pQ = 0.7 * sp(j + 1) - 0.7 * sp(j - 1) + 0.5 * sp(j + 2) - 0.5 * sp(j - 2);
      freqOfs = j + Math.atan2(pQ, pI) / (2 * Math.PI / 8);
      const i = Math.floor(freqOfs + 0.5);
      const s = Math.floor(symbShift);
      const s2 = (s + 1) & (SYMBOL_DIV - 1);
      const w0 = s + 1 - symbShift, w1 = symbShift - s;
      const A = (0.5 * this._W) / SYMBOL_SEPAR;
      const II = w0 * av[s].re[i] + w1 * av[s2].re[i];
      const QQ = w0 * av[s].im[i] + w1 * av[s2].im[i];
      const F0 = i + Math.atan2(QQ, II) / (2 * Math.PI) * A - freqOfs;
      const Fl = F0 - A, Fu = F0 + A;
      if (Math.abs(Fl) < Math.abs(F0)) freqOfs += Math.abs(Fu) < Math.abs(Fl) ? Fu : Fl;
      else freqOfs += Math.abs(Fu) < Math.abs(F0) ? Fu : F0;
    } else {
      stRe = stIm = 0; freqOfs = 0;
    }

    if (this._locked) {
      if (stRe * this._averSymbRe + stIm * this._averSymbIm < 0) {
        stRe = -stRe; stIm = -stIm; freqOfs -= DATA_CARR_SEPAR;
      }
      let A = 2 * DATA_CARR_SEPAR;
      const kk = Math.floor((freqOfs - this._averFreq) / A + 0.5);
      freqOfs -= kk * A;
      A = (0.5 * this._W) / SYMBOL_SEPAR;
      const F0 = freqOfs - this._averFreq, Fl = F0 - A, Fu = F0 + A;
      if (Math.abs(Fl) < Math.abs(F0)) freqOfs += Math.abs(Fu) < Math.abs(Fl) ? A : -A;
      else freqOfs += Math.abs(Fu) < Math.abs(F0) ? A : 0;
    } else {
      const tp = this._trackPtr;
      if (stRe * this._symbPipeRe[tp] + stIm * this._symbPipeIm[tp] < 0) {
        stRe = -stRe; stIm = -stIm; freqOfs -= DATA_CARR_SEPAR;
      }
      const A = 2 * DATA_CARR_SEPAR;
      const kk = Math.floor(freqOfs / A + 0.5);
      freqOfs -= kk * A;
      const F0 = freqOfs - this._freqPipe[tp], Fl = F0 - A, Fu = F0 + A;
      if (Math.abs(Fl) < Math.abs(F0)) freqOfs += Math.abs(Fu) < Math.abs(Fl) ? A : -A;
      else freqOfs += Math.abs(Fu) < Math.abs(F0) ? A : 0;
    }

    this._trackPtr += 1;
    if (this._trackPtr >= this._trackLen) this._trackPtr -= this._trackLen;
    this._symbPipeRe[this._trackPtr] = stRe;
    this._symbPipeIm[this._trackPtr] = stIm;
    this._freqPipe[this._trackPtr] = freqOfs;

    const as = selFitAverCmpx(this._symbPipeRe, this._symbPipeIm, this._trackLen, 3.0, 4);
    this._averSymbRe = as.re; this._averSymbIm = as.im;
    const af = selFitAverReal(this._freqPipe, this._trackLen, 2.5, 4);
    this._averFreq = af.aver;
    this._freqDev = af.rms;

    const conf = Math.hypot(as.re, as.im);
    this._symbConf = conf;
    this._freqOfs = this._averFreq;
    if (conf > 0) {
      const ph = Math.atan2(as.im, as.re) / (2 * Math.PI);
      let shift = ph * SYMBOL_SEPAR;
      if (shift < 0) shift += SYMBOL_SEPAR;
      let sp = Math.floor(ph * SYMBOL_DIV);
      if (sp < 0) sp += SYMBOL_DIV;
      this._symbPtr = sp;
      this._symbShift = shift;
    }

    if (this._locked) {
      if (this._symbConf < this._holdThres || this._freqDev > 0.25) this._locked = 0;
    } else if (this._symbConf > this._lockThres && this._freqDev < 0.125) {
      this._locked = 1;
    }
    this._symbConf *= 0.5;
  }

  // ── DataProcess ───────────────────────────────────────────────────────────

  _dataProcess(evenAbs, oddAbs, freqOfs, timeDist) {
    const W = this._W, mask = this._mask, tw = this._fft;
    const r1 = this._fbRe, i1 = this._fbIm, r2 = this._fb2Re, i2 = this._fb2Im;
    this._loadSlice(evenAbs, r1, i1, freqOfs);
    this._loadSlice(oddAbs, r2, i2, freqOfs);
    tw.core(r1, i1);
    tw.core(r2, i2);

    const DL = this._dataScanLen;
    const incr = (timeDist * DATA_CARR_SEPAR) & mask;
    let p = (timeDist * this._dataScanFirst) & mask;
    let c = this._dataScanFirst & mask;
    const vr = this._vecRe, vi = this._vecIm, rr = this._refRe, ri = this._refIm;
    for (let i = 0; i < DL;) {
      for (let half = 0; half < 2; half++) {
        const fr = half ? r2 : r1, fi = half ? i2 : i1;
        const Pr = tw.twRe[p], Pi = tw.twIm[p];
        // Dtmp = Ref * Phas; DataVect = FFT[c] * conj(Dtmp)
        const dr = rr[i] * Pr - ri[i] * Pi;
        const di = rr[i] * Pi + ri[i] * Pr;
        const xr = fr[c], xi = fi[c];
        vr[i] = xr * dr + xi * di;
        vi[i] = xi * dr - xr * di;
        lp2(xr * xr + xi * xi, this._dPwrMid, this._dPwrOut, i, this._dW1, this._dW2, this._dW5);
        rr[i] = xr; ri[i] = xi;
        i++;
        c = (c + DATA_CARR_SEPAR) & mask;
        p = (p + incr) & mask;
      }
    }

    const P = (-timeDist * 2 * Math.PI * freqOfs) / W;
    const Fr = Math.cos(P), Fi = Math.sin(P);
    const pipe = this._dataPipe[this._dataPipePtr];
    for (let i = 0; i < DL; i++) {
      const tr = vr[i] * Fr - vi[i] * Fi;
      const ti = vr[i] * Fi + vi[i] * Fr;
      vr[i] = pipe.re[i]; vi[i] = pipe.im[i];
      pipe.re[i] = tr; pipe.im[i] = ti;
    }
    this._dataPipePtr += 1;
    if (this._dataPipePtr >= this._dataPipeLen) this._dataPipePtr = 0;

    const ph = this._phase;
    for (let i = 0; i < DL; i++) {
      const pw = this._dPwrOut[i];
      if (pw > 0) {
        let x = vr[i] / pw;
        if (x > 1) x = 1; else if (x < -1) x = -1;
        ph[i] = x;
      } else ph[i] = 0;
    }
    this._dec.process(ph);
    this._putChar(this._dec.output);
  }

  _open() { return this._squelch <= 0 || this._dec.snr >= this._squelch; }

  // fldigi mt63::rx_process with mt63_8bit on (its default): codes below 8
  // are idle fill, 127 escapes the next code into 128..255.
  _putChar(c) {
    if (!this._open()) return;
    if (c < 8 && this._escape === 0) return;
    if (c === 127) { this._escape = 1; return; }
    if (this._escape) { c += 128; this._escape = 0; }
    this._lastPrinted = this._samples;
    const last = this._lastChar;
    this._lastChar = c;
    if (!this.onChar) return;
    if (c === 13) this.onChar('\n');
    else if (c === 10) { if (last !== 13) this.onChar('\n'); }
    else if ((c >= 32 && c <= 126) || c >= 160) this.onChar(String.fromCharCode(c));
  }

  /** Frequency offset the synchroniser and FEC measured, in Hz. */
  get freqOffsetHz() {
    return (this._freqOfs + DATA_CARR_SEPAR * this._dec.carrOfs) * (RATE / this._decim) / this._W;
  }

  _maybeEmitMetrics() {
    if (this._samples - this._lastMetricsAt < RATE / 4) return;
    this._lastMetricsAt = this._samples;
    if (!this.onMetrics) return;
    const snr = this._dec.snr;
    const open = this._open();
    this.onMetrics({
      snrDb: Math.round(10 * Math.log10(snr > 0.001 ? snr : 0.001) * 10) / 10,
      lockQuality: Math.round(Math.min(100, snr * 10)),
      fecSnr: Math.round(snr * 10) / 10,
      // Only a locked synchroniser's offset means anything; before that it
      // wanders, and the panel would chase it with the passband.
      centerHz: this._locked ? Math.round(this._centerHz + this.freqOffsetHz) : this._centerHz,
      timingLocked: !!this._locked,
      squelchOpen: open,
    });
  }
}

export default Mt63Decoder;
