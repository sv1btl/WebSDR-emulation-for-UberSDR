/**
 * wspr.js — WSPR-2 decoder for PhantomSDR-Plus
 *
 * This is a faithful JavaScript port of the KiwiSDR WSPR decoder
 * (extensions/wspr/*.cpp in jks-prv/Beagle_SDR_GPS), which is itself a port of
 * K1JT/K9AN `wsprd` from WSJT-X. The decode pipeline matches the Kiwi C code
 * step for step:
 *
 *   1. Front-end: real audio (12 kHz) is mixed to complex baseband around the
 *      WSPR passband center (1500 Hz), low-pass filtered and decimated by 32 to
 *      produce a 375 Hz complex IQ stream (idat/qdat), exactly the format the
 *      Kiwi decoder consumes (SRATE=375, TPOINTS≈45000).
 *   2. Spectrogram: 512-pt complex FFTs over 2 symbols, stepped by half a symbol
 *      (HSPS=128), sine-windowed, fft-shifted → pwr_samp[frame][bin].
 *   3. renormalize(): 7-bin smoothing + 30th-percentile noise floor → SNR.
 *   4. Peak list: local maxima limited to ±110 Hz, top MAX_NPK=12 by SNR.
 *   5. Coarse freq/time/drift search over the power spectrogram.
 *   6. sync_and_demodulate(): coherent matched-filter sync refinement and
 *      soft-symbol demodulation at the native 375 Hz IQ rate.
 *   7. deinterleave() + Fano soft-decision sequential decoder (K=32, r=1/2,
 *      Layland-Lushbaugh polynomials) with the Kiwi metric table.
 *   8. unpk_(): unpack call/grid/power incl. Type-2 (compound) and Type-3
 *      (hashed) messages, with the Jenkins nhash callsign hash table.
 *
 * Ported from Kiwi: wspr.cpp, wspr_util.cpp, fano.cpp, wspr_main.cpp (FFT
 * front-end), metric_tables.h, tab.cpp, nhash.cpp.
 *
 * Public interface is unchanged from the previous decoder:
 *   decodeWSPR(pcm, sampleRate, dialFreqHz) -> [{callsign,grid,dbm,freq,snr,dt,drift,sync}]
 *   WSPR_TOTAL_SAMPLES, wspr2SlotPosition(), isWSPRSlotStart()
 */

import { transformFlat } from '../lib/fftRadix2.js';

// ── Kiwi constants (wspr.h) ────────────────────────────────────────────────
const SRATE   = 375;
const FSRATE  = 375.0;
const DT      = 1.0 / FSRATE;
const SPS     = 256;            // samples per symbol at 375 Hz
const FSPS    = 256.0;
const NFFT    = SPS * 2;        // 512
const HSPS    = SPS / 2;        // 128
const DF      = FSRATE / FSPS;  // 1.4648 Hz tone spacing
const DF2     = FSRATE / FSPS / 2.0;   // 0.7324 Hz FFT bin spacing
const DF15    = DF * 1.5;
const DF05    = DF * 0.5;
const TWOPIDT = 2 * Math.PI * DT;

const NSYM    = 162;
const FHSYM   = 162.0 / 2;      // 81.0
const NBITS   = 81;
const LEN_DECODE = ((NBITS + 7) >> 3);   // 11

const NBINS_411 = Math.ceil(NFFT * 300.0 / FSRATE) + 1;   // 411
const HBINS_205 = (NBINS_411 - 1) >> 1;                   // 205

const FMIN = -110;
const FMAX =  110;
const MAX_NPK = 12;
const NPK     = 256;

// Front-end (real audio -> 375 Hz complex IQ)
const AUDIO_SR    = 12000;      // decoder operates on 12 kHz audio
const WSPR_CENTER = 1500;       // WSPR passband center in the USB audio (Hz)
const DECIM       = AUDIO_SR / SRATE;   // 32

// Fano tuning (wspr.cpp)
const SYMFAC   = 50;
const FANO_DELTA = 60;
const MINSYNC1 = 0.10;
const MINSYNC2 = 0.12;
const MINRMS   = 52.0 * (SYMFAC / 64.0);
const MAXDRIFT = 4;
const JIG_RANGE = 128;

// Wall-clock budget for the whole decode (a browser worker, unlike the Kiwi
// server, cannot run the unlimited MORE_EFFORT pass loop indefinitely).
const DECODE_BUDGET_MS = 30000;

// Fano polynomials (Layland-Lushbaugh), also the WSPR convolutional code.
const POLY1 = 0xf2d05351 >>> 0;
const POLY2 = 0xe4613c47 >>> 0;

// Kept only so WSPR_TOTAL_SAMPLES matches the previous module (audio.js gate).
const _NFFT_OLD = 8192, _HOP_OLD = 4096, _FPS_OLD = 2;
export const WSPR_TOTAL_SAMPLES = _NFFT_OLD + (NSYM * _FPS_OLD - 1) * _HOP_OLD;
export const WSPR_SR = AUDIO_SR;

// ── WSPR sync vector pr3 (wspr.cpp) ────────────────────────────────────────
const pr3 = new Uint8Array([
  1,1,0,0,0,0,0,0,1,0,0,0,1,1,1,0,0,0,1,0,
  0,1,0,1,1,1,1,0,0,0,0,0,0,0,1,0,0,1,0,1,
  0,0,0,0,0,0,1,0,1,1,0,0,1,1,0,1,0,0,0,1,
  1,0,1,0,0,0,0,1,1,0,1,0,1,0,1,0,1,0,0,1,
  0,0,1,0,1,1,0,0,0,1,1,0,1,0,1,0,0,0,1,0,
  0,0,0,0,1,0,0,1,0,0,1,1,1,0,1,1,0,0,1,1,
  0,1,0,0,0,1,1,1,0,0,0,0,0,1,0,1,0,0,1,1,
  0,0,0,0,0,0,0,1,1,0,1,0,1,1,0,0,0,1,1,0,
  0,0]);

// ── 8-bit parity table (tab.cpp) ───────────────────────────────────────────
const _Partab = new Uint8Array([
  0,1,1,0,1,0,0,1,1,0,0,1,0,1,1,0,1,0,0,1,0,1,1,0,0,1,1,0,1,0,0,1,
  1,0,0,1,0,1,1,0,0,1,1,0,1,0,0,1,0,1,1,0,1,0,0,1,1,0,0,1,0,1,1,0,
  1,0,0,1,0,1,1,0,0,1,1,0,1,0,0,1,0,1,1,0,1,0,0,1,1,0,0,1,0,1,1,0,
  0,1,1,0,1,0,0,1,1,0,0,1,0,1,1,0,1,0,0,1,0,1,1,0,0,1,1,0,1,0,0,1,
  1,0,0,1,0,1,1,0,0,1,1,0,1,0,0,1,0,1,1,0,1,0,0,1,1,0,0,1,0,1,1,0,
  0,1,1,0,1,0,0,1,1,0,0,1,0,1,1,0,1,0,0,1,0,1,1,0,0,1,1,0,1,0,0,1,
  0,1,1,0,1,0,0,1,1,0,0,1,0,1,1,0,1,0,0,1,0,1,1,0,0,1,1,0,1,0,0,1,
  1,0,0,1,0,1,1,0,0,1,1,0,1,0,0,1,0,1,1,0,1,0,0,1,1,0,0,1,0,1,1,0]);

// ── Kiwi metric_tables[2] (Es/No = 6 dB), 256 entries (metric_tables.h) ─────
const metric_table2 = [
  0.9999,0.9998,0.9998,0.9998,0.9998,0.9998,0.9997,0.9997,0.9997,0.9997,0.9997,0.9996,0.9996,0.9996,0.9995,0.9995,
  0.9994,0.9994,0.9994,0.9993,0.9993,0.9992,0.9991,0.9991,0.9990,0.9989,0.9988,0.9988,0.9988,0.9986,0.9985,0.9984,
  0.9983,0.9982,0.9980,0.9979,0.9977,0.9976,0.9974,0.9971,0.9969,0.9968,0.9965,0.9962,0.9960,0.9957,0.9953,0.9950,
  0.9947,0.9941,0.9937,0.9933,0.9928,0.9922,0.9917,0.9911,0.9904,0.9897,0.9890,0.9882,0.9874,0.9863,0.9855,0.9843,
  0.9832,0.9819,0.9806,0.9792,0.9777,0.9760,0.9743,0.9724,0.9704,0.9683,0.9659,0.9634,0.9609,0.9581,0.9550,0.9516,
  0.9481,0.9446,0.9406,0.9363,0.9317,0.9270,0.9218,0.9160,0.9103,0.9038,0.8972,0.8898,0.8822,0.8739,0.8647,0.8554,
  0.8457,0.8357,0.8231,0.8115,0.7984,0.7854,0.7704,0.7556,0.7391,0.7210,0.7038,0.6840,0.6633,0.6408,0.6174,0.5939,
  0.5678,0.5410,0.5137,0.4836,0.4524,0.4193,0.3850,0.3482,0.3132,0.2733,0.2315,0.1891,0.1435,0.0980,0.0493,0.0000,
  -0.0510,-0.1052,-0.1593,-0.2177,-0.2759,-0.3374,-0.4005,-0.4599,-0.5266,-0.5935,-0.6626,-0.7328,-0.8051,-0.8757,-0.9498,-1.0271,
  -1.1019,-1.1816,-1.2642,-1.3459,-1.4295,-1.5077,-1.5958,-1.6818,-1.7647,-1.8548,-1.9387,-2.0295,-2.1152,-2.2154,-2.3011,-2.3904,
  -2.4820,-2.5786,-2.6730,-2.7652,-2.8616,-2.9546,-3.0526,-3.1445,-3.2445,-3.3416,-3.4357,-3.5325,-3.6324,-3.7313,-3.8225,-3.9209,
  -4.0248,-4.1278,-4.2261,-4.3193,-4.4220,-4.5262,-4.6214,-4.7242,-4.8234,-4.9245,-5.0298,-5.1250,-5.2232,-5.3267,-5.4332,-5.5342,
  -5.6431,-5.7270,-5.8401,-5.9350,-6.0407,-6.1418,-6.2363,-6.3384,-6.4536,-6.5429,-6.6582,-6.7433,-6.8438,-6.9478,-7.0789,-7.1894,
  -7.2714,-7.3815,-7.4810,-7.5575,-7.6852,-7.8071,-7.8580,-7.9724,-8.1000,-8.2207,-8.2867,-8.4017,-8.5287,-8.6347,-8.7082,-8.8319,
  -8.9448,-9.0355,-9.1885,-9.2095,-9.2863,-9.4186,-9.5064,-9.6386,-9.7207,-9.8286,-9.9453,-10.0701,-10.1735,-10.3001,-10.2858,-10.5427,
  -10.5982,-10.7361,-10.7042,-10.9212,-11.0097,-11.0469,-11.1155,-11.2812,-11.3472,-11.4988,-11.5327,-11.6692,-11.9376,-11.8606,-12.1372,-13.2539];

// mettab[2][256], built at module load (wspr_init())
const mettab0 = new Int32Array(256);
const mettab1 = new Int32Array(256);
(function wspr_init() {
  const bias = 0.45;
  for (let i = 0; i < SPS; i++) {
    mettab0[i] = Math.round(10 * (metric_table2[i] - bias));
    mettab1[i] = Math.round(10 * (metric_table2[SPS - 1 - i] - bias));
  }
})();

// ── ENCODE macro (fano.h) ──────────────────────────────────────────────────
function ENCODE(encstate) {
  let t = (encstate & POLY1) >>> 0;
  t ^= t >>> 16;
  let sym = _Partab[(t ^ (t >>> 8)) & 0xff] << 1;
  t = (encstate & POLY2) >>> 0;
  t ^= t >>> 16;
  sym |= _Partab[(t ^ (t >>> 8)) & 0xff];
  return sym;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public entry
// ═══════════════════════════════════════════════════════════════════════════
export async function decodeWSPR(pcm, sampleRate = AUDIO_SR, dialFreqHz = 0) {
  const t0 = Date.now();

  // Normalize to 12 kHz real audio.
  const audio = (sampleRate !== AUDIO_SR) ? _resample(pcm, sampleRate, AUDIO_SR) : pcm;
  if (audio.length < DECIM * (NFFT + HSPS * 4)) {
    console.warn(`[WSPR] Only ${audio.length} audio samples, too short`);
    return [];
  }

  // Front-end: 12 kHz real -> 375 Hz complex IQ.
  const { idat, qdat } = _downconvert(audio);
  const np = idat.length;

  // Spectrogram.
  const { pwr, psavg, nffts } = _buildSpectrogram(idat, qdat, np);
  console.log(`[WSPR] IQ=${np} samples, nffts=${nffts}`);

  const results = _wsprDecode(idat, qdat, np, pwr, psavg, nffts, dialFreqHz, t0);

  results.sort((a, b) => (a.freq - b.freq) || (b.snr - a.snr));
  console.log(`[WSPR] Total decoded: ${results.length} in ${Date.now() - t0} ms`);
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// Front-end: real 12 kHz audio -> complex 375 Hz IQ (mix + LPF + decimate ×32)
// ═══════════════════════════════════════════════════════════════════════════
let _firCoeffs = null;
function _fir() {
  if (_firCoeffs) return _firCoeffs;
  const taps = DECIM * 16 + 1;      // 513
  const center = (taps - 1) >> 1;
  const fc = 178.0;                 // cutoff Hz (passband >±110, reject >±187.5)
  const wc = 2 * Math.PI * fc / AUDIO_SR;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - center;
    const s = (n === 0) ? wc / Math.PI : Math.sin(wc * n) / (Math.PI * n);
    const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1)); // Hamming
    h[i] = s * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  _firCoeffs = { h, taps, center };
  return _firCoeffs;
}

function _downconvert(audio) {
  const n = audio.length;
  // Mix down by WSPR_CENTER: phase = 2π*1500/12000*k = k*π/4  (period 8).
  const NPH = AUDIO_SR / WSPR_CENTER;              // 8
  const cosT = new Float64Array(NPH), sinT = new Float64Array(NPH);
  for (let k = 0; k < NPH; k++) {
    const th = 2 * Math.PI * WSPR_CENTER * k / AUDIO_SR;
    cosT[k] = Math.cos(th);
    sinT[k] = Math.sin(th);
  }
  const mixRe = new Float32Array(n), mixIm = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const p = k % NPH;
    const s = audio[k];
    mixRe[k] =  s * cosT[p];       // real audio × e^{-jθ}
    mixIm[k] = -s * sinT[p];
  }

  const { h, taps, center } = _fir();
  const outLen = Math.floor((n - 1) / DECIM) + 1;
  const idat = new Float32Array(outLen), qdat = new Float32Array(outLen);
  for (let m = 0; m < outLen; m++) {
    const c = m * DECIM;
    let ar = 0, ai = 0;
    const j0 = Math.max(0, center - c);
    const j1 = Math.min(taps, center - c + n);
    for (let j = j0; j < j1; j++) {
      const idx = c + j - center;
      const cf = h[j];
      ar += mixRe[idx] * cf;
      ai += mixIm[idx] * cf;
    }
    idat[m] = ar;
    qdat[m] = ai;
  }
  return { idat, qdat };
}

// ═══════════════════════════════════════════════════════════════════════════
// Spectrogram (WSPR_FFT in wspr_main.cpp)
// ═══════════════════════════════════════════════════════════════════════════
let _window = null;
function _win() {
  if (_window) return _window;
  _window = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) _window[i] = Math.sin(i * Math.PI / (NFFT - 1));
  return _window;
}

function _buildSpectrogram(idat, qdat, np) {
  const window = _win();
  let nffts = Math.floor((np - NFFT) / HSPS) + 1;
  if (nffts < 1) nffts = 1;

  const pwr = new Array(nffts);
  const psavg = new Float64Array(NFFT);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);

  for (let i = 0; i < nffts; i++) {
    const base = i * HSPS;
    for (let j = 0; j < NFFT; j++) {
      const k = base + j;
      const w = window[j];
      re[j] = (k < np ? idat[k] : 0) * w;
      im[j] = (k < np ? qdat[k] : 0) * w;
    }
    transformFlat(re, im, false);

    // fft-shift: pwr_samp[j] = |fftout[(j+SPS) mod NFFT]|^2   (j=256 == DC)
    const ps = new Float32Array(NFFT);
    for (let j = 0; j < NFFT; j++) {
      let k = j + SPS;
      if (k > NFFT - 1) k -= NFFT;
      const p = re[k] * re[k] + im[k] * im[k];
      ps[j] = p;
      psavg[j] += p;
    }
    pwr[i] = ps;
  }
  return { pwr, psavg, nffts };
}

// ── renormalize() (wspr.cpp) ───────────────────────────────────────────────
// Returns { smspec:Float32Array(411), min_snr, snr_scaling } with smspec
// normalized so peaks approximate SNR in the WSPR bandwidth.
function _renormalize(psavg) {
  const smspec = new Float32Array(NBINS_411);
  for (let i = 0; i < NBINS_411; i++) {
    let s = 0;
    for (let j = -3; j <= 3; j++) {
      const k = SPS - HBINS_205 + i + j;
      if (k >= 0 && k < NFFT) s += psavg[k];
    }
    smspec[i] = s;
  }

  const tmp = Float32Array.from(smspec);
  tmp.sort();
  const noise = tmp[122] || 1e-30;     // ~30th percentile of 411

  const min_snr = Math.pow(10.0, -7.0 / 10.0);   // -7 dB in WSPR bw
  const snr_scaling = 26.3;                       // WSPR-2
  for (let j = 0; j < NBINS_411; j++) {
    smspec[j] = smspec[j] / noise - 1.0;
    if (smspec[j] < min_snr) smspec[j] = 0.1 * min_snr;
  }
  return { smspec, min_snr, snr_scaling };
}

// ═══════════════════════════════════════════════════════════════════════════
// sync_and_demodulate() (wspr.cpp)
//   mode: 0 = FIND_BEST_TIME_LAG, 1 = FIND_BEST_FREQ, 2 = CALC_SOFT_SYMS
//   st = { f1, shift1, symbols:Uint8Array(162) }  (mutated for FIND / SOFT)
//   returns sync (number)
// ═══════════════════════════════════════════════════════════════════════════
const MODE_TIME = 0, MODE_FREQ = 1, MODE_SOFT = 2;

const _c0 = new Float64Array(SPS), _s0 = new Float64Array(SPS);
const _c1 = new Float64Array(SPS), _s1 = new Float64Array(SPS);
const _c2 = new Float64Array(SPS), _s2 = new Float64Array(SPS);
const _c3 = new Float64Array(SPS), _s3 = new Float64Array(SPS);
const _fsymb = new Float64Array(NSYM);

function sync_and_demodulate(idat, qdat, np, st, ifmin, ifmax, fstep,
                             lagmin, lagmax, lagstep, drift1, symfac, mode) {
  if (mode === MODE_TIME) { ifmin = 0; ifmax = 0; fstep = 0.0; }
  if (mode === MODE_FREQ) { lagmin = st.shift1; lagmax = st.shift1; }
  if (mode === MODE_SOFT) { lagmin = st.shift1; lagmax = st.shift1; ifmin = 0; ifmax = 0; }

  let syncmax = -1e30;
  let best_shift = 0, fbest = 0.0;

  for (let ifreq = ifmin; ifreq <= ifmax; ifreq++) {
    const f0 = st.f1 + ifreq * fstep;
    for (let lag = lagmin; lag <= lagmax; lag += lagstep) {
      let ss = 0.0, totp = 0.0;
      let fplast = NaN;
      for (let i = 0; i < NSYM; i++) {
        const fp = f0 + (drift1 / 2.0) * (i - FHSYM) / FHSYM;
        if (i === 0 || fp !== fplast) {
          const dphi0 = TWOPIDT * (fp - DF15), cd0 = Math.cos(dphi0), sd0 = Math.sin(dphi0);
          const dphi1 = TWOPIDT * (fp - DF05), cd1 = Math.cos(dphi1), sd1 = Math.sin(dphi1);
          const dphi2 = TWOPIDT * (fp + DF05), cd2 = Math.cos(dphi2), sd2 = Math.sin(dphi2);
          const dphi3 = TWOPIDT * (fp + DF15), cd3 = Math.cos(dphi3), sd3 = Math.sin(dphi3);
          _c0[0] = 1; _s0[0] = 0; _c1[0] = 1; _s1[0] = 0;
          _c2[0] = 1; _s2[0] = 0; _c3[0] = 1; _s3[0] = 0;
          for (let j = 1; j < SPS; j++) {
            _c0[j] = _c0[j-1]*cd0 - _s0[j-1]*sd0; _s0[j] = _c0[j-1]*sd0 + _s0[j-1]*cd0;
            _c1[j] = _c1[j-1]*cd1 - _s1[j-1]*sd1; _s1[j] = _c1[j-1]*sd1 + _s1[j-1]*cd1;
            _c2[j] = _c2[j-1]*cd2 - _s2[j-1]*sd2; _s2[j] = _c2[j-1]*sd2 + _s2[j-1]*cd2;
            _c3[j] = _c3[j-1]*cd3 - _s3[j-1]*sd3; _s3[j] = _c3[j-1]*sd3 + _s3[j-1]*cd3;
          }
          fplast = fp;
        }

        let i0 = 0, q0 = 0, i1 = 0, q1 = 0, i2 = 0, q2 = 0, i3 = 0, q3 = 0;
        const kbase = lag + i * SPS;
        for (let j = 0; j < SPS; j++) {
          const k = kbase + j;
          if (k > 0 && k < np) {
            const rk = idat[k], qk = qdat[k];
            i0 += rk*_c0[j] + qk*_s0[j]; q0 += -rk*_s0[j] + qk*_c0[j];
            i1 += rk*_c1[j] + qk*_s1[j]; q1 += -rk*_s1[j] + qk*_c1[j];
            i2 += rk*_c2[j] + qk*_s2[j]; q2 += -rk*_s2[j] + qk*_c2[j];
            i3 += rk*_c3[j] + qk*_s3[j]; q3 += -rk*_s3[j] + qk*_c3[j];
          }
        }
        const p0 = Math.sqrt(i0*i0 + q0*q0);
        const p1 = Math.sqrt(i1*i1 + q1*q1);
        const p2 = Math.sqrt(i2*i2 + q2*q2);
        const p3 = Math.sqrt(i3*i3 + q3*q3);

        totp += p0 + p1 + p2 + p3;
        const cmet = (p1 + p3) - (p0 + p2);
        ss += (pr3[i] === 1) ? cmet : -cmet;
        if (mode === MODE_SOFT) {
          _fsymb[i] = (pr3[i] === 1) ? (p3 - p1) : (p2 - p0);
        }
      }
      ss = ss / totp;
      if (ss > syncmax) { syncmax = ss; best_shift = lag; fbest = f0; }
    }
  }

  if (mode === MODE_TIME || mode === MODE_FREQ) {
    st.shift1 = best_shift;
    st.f1 = fbest;
    return syncmax;
  }

  // CALC_SOFT_SYMS: normalize soft symbols to symfac RMS, offset by 128.
  let fsum = 0, f2sum = 0;
  for (let i = 0; i < NSYM; i++) { fsum += _fsymb[i] / NSYM; f2sum += _fsymb[i] * _fsymb[i] / NSYM; }
  const fac = Math.sqrt(f2sum - fsum * fsum);
  for (let i = 0; i < NSYM; i++) {
    let v = symfac * _fsymb[i] / fac;
    if (v > 127) v = 127.0;
    if (v < -128) v = -128.0;
    st.symbols[i] = (v + 128) & 0xff;
  }
  return syncmax;
}

// ── deinterleave() (wspr_util.cpp) ─────────────────────────────────────────
function deinterleave(sym) {
  const tmp = new Uint8Array(NSYM);
  let p = 0, i = 0;
  while (p < NSYM) {
    // bit-reversal of the low 8 bits of i
    let ii = i & 0xff, j = 0;
    for (let b = 0; b < 8; b++) j = (j << 1) | ((ii >> b) & 1);
    if (j < NSYM) { tmp[p] = sym[j]; p++; }
    i++;
  }
  for (i = 0; i < NSYM; i++) sym[i] = tmp[i];
}

// ═══════════════════════════════════════════════════════════════════════════
// Fano sequential decoder (fano.cpp)
//   symbols: Uint8Array(162) soft symbols (0..255)
//   returns { ok, metric, data:Uint8Array(LEN_DECODE) } or {ok:false}
// ═══════════════════════════════════════════════════════════════════════════
function fano(symbols, nbits, delta, maxcycles) {
  // node arrays
  const N = nbits + 1;
  const encstate = new Float64Array(N);   // holds up to 32-bit shift regs (use Number)
  const gamma = new Int32Array(N);
  const met0 = new Int32Array(N), met1 = new Int32Array(N), met2 = new Int32Array(N), met3 = new Int32Array(N);
  const tm0 = new Int32Array(N), tm1 = new Int32Array(N);
  const ni = new Int32Array(N);

  const lastnode = nbits - 1;
  const tail = nbits - 31;

  // branch metrics per node
  for (let k = 0; k < nbits; k++) {
    const s0 = symbols[2*k], s1 = symbols[2*k+1];
    met0[k] = mettab0[s0] + mettab0[s1];
    met1[k] = mettab0[s0] + mettab1[s1];
    met2[k] = mettab1[s0] + mettab0[s1];
    met3[k] = mettab1[s0] + mettab1[s1];
  }
  const metricsOf = (k, idx) => (idx === 0 ? met0[k] : idx === 1 ? met1[k] : idx === 2 ? met2[k] : met3[k]);

  let npi = 0;              // current node index (np - nodes)
  encstate[0] = 0;

  let lsym = ENCODE(encstate[0] >>> 0);
  let m0 = metricsOf(0, lsym);
  let m1 = metricsOf(0, 3 ^ lsym);
  if (m0 > m1) { tm0[0] = m0; tm1[0] = m1; }
  else { tm0[0] = m1; tm1[0] = m0; encstate[0] = (encstate[0] + 1); }
  ni[0] = 0;
  let t = 0;
  gamma[0] = 0;

  const totalCycles = maxcycles * nbits;
  let i;
  for (i = 1; i <= totalCycles; i++) {
    const tmCur = (ni[npi] === 0) ? tm0[npi] : tm1[npi];
    const ngamma = gamma[npi] + tmCur;
    if (ngamma >= t) {
      if (gamma[npi] < t + delta) {
        while (ngamma >= t + delta) t += delta;
      }
      gamma[npi + 1] = ngamma;
      encstate[npi + 1] = (encstate[npi] * 2) % 4294967296;
      npi++;
      if (npi === lastnode + 1) break;   // done

      lsym = ENCODE(encstate[npi] >>> 0);
      if (npi >= tail) {
        tm0[npi] = metricsOf(npi, lsym);
      } else {
        m0 = metricsOf(npi, lsym);
        m1 = metricsOf(npi, 3 ^ lsym);
        if (m0 > m1) { tm0[npi] = m0; tm1[npi] = m1; }
        else { tm0[npi] = m1; tm1[npi] = m0; encstate[npi] = encstate[npi] + 1; }
      }
      ni[npi] = 0;
      continue;
    }
    // threshold violated — look backward
    for (;;) {
      if (npi === 0 || gamma[npi - 1] < t) {
        t -= delta;
        if (ni[npi] !== 0) { ni[npi] = 0; encstate[npi] = _xor1(encstate[npi]); }
        break;
      }
      npi--;
      if (npi < tail && ni[npi] !== 1) {
        ni[npi]++;
        encstate[npi] = _xor1(encstate[npi]);
        break;
      }
    }
  }

  const metric = gamma[npi];
  // copy decoded bytes: np = &nodes[7], step 8, nbits>>3 bytes
  const nbytes = nbits >> 3;
  const data = new Uint8Array(LEN_DECODE);
  let node = 7;
  for (let b = 0; b < nbytes; b++) {
    data[b] = (encstate[node] >>> 0) & 0xff;
    node += 8;
  }
  return { ok: i < totalCycles, metric, data };
}

// toggle low bit of a value held as a Number (may exceed 2^31)
function _xor1(v) {
  return (v % 2 === 0) ? v + 1 : v - 1;
}

// ═══════════════════════════════════════════════════════════════════════════
// Unpack (wspr_util.cpp) + Jenkins nhash callsign hashtable
// ═══════════════════════════════════════════════════════════════════════════
const A37 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ ';

function unpack50(d) {
  const call_28b = ((d[0] << 20) | (d[1] << 12) | (d[2] << 4) | (d[3] >> 4)) >>> 0;
  const grid_pwr_22b = (((d[3] & 0xf) << 18) | (d[4] << 10) | (d[5] << 2) | (d[6] >> 6)) >>> 0;
  const grid_15b = grid_pwr_22b >>> 7;
  const pwr_7b = grid_pwr_22b & 0x7f;
  return { call_28b, grid_pwr_22b, grid_15b, pwr_7b };
}

function unpackcall(call_28b) {
  if (call_28b >= 262177560) return null;
  let n = call_28b;
  const tmp = new Array(6);
  tmp[5] = A37[n % 27 + 10]; n = Math.floor(n / 27);
  tmp[4] = A37[n % 27 + 10]; n = Math.floor(n / 27);
  tmp[3] = A37[n % 27 + 10]; n = Math.floor(n / 27);
  tmp[2] = A37[n % 10];      n = Math.floor(n / 10);
  tmp[1] = A37[n % 36];      n = Math.floor(n / 36);
  tmp[0] = A37[n];
  let s = tmp.join('');
  s = s.replace(/^ +/, '').replace(/ +$/, '');
  return s;
}

function unpackgrid(grid_15b) {
  if (grid_15b >= 32400) return null;
  const dlat = (grid_15b % 180) - 90;
  let dlong = Math.floor(grid_15b / 180) * 2 - 180 + 2;
  if (dlong < -180) dlong += 360;
  if (dlong > 180) dlong += 360;
  const g = ['', '', '', ''];
  let nlong = Math.floor(60.0 * (180.0 - dlong) / 5.0);
  let n1 = Math.floor(nlong / 240);
  let n2 = Math.floor((nlong - 240 * n1) / 24);
  g[0] = A37[10 + n1];
  g[2] = A37[n2];
  let nlat = Math.floor(60.0 * (dlat + 90) / 2.5);
  n1 = Math.floor(nlat / 240);
  n2 = Math.floor((nlat - 240 * n1) / 24);
  g[1] = A37[10 + n1];
  g[3] = A37[n2];
  return g[0] + g[1] + g[2] + g[3];
}

function unpackpfx(nprefix, call) {
  const tmpcall = call;
  if (nprefix < 60000) {
    let n = nprefix;
    const pfx = [' ', ' ', ' '];
    for (let i = 2; i >= 0; i--) {
      const nc = n % 37;
      if (nc >= 0 && nc <= 9) pfx[i] = String.fromCharCode(nc + 48);
      else if (nc >= 10 && nc <= 35) pfx[i] = String.fromCharCode(nc - 10 + 65);
      else pfx[i] = ' ';
      n = Math.floor(n / 37);
    }
    let p = pfx.join('');
    const idx = p.lastIndexOf(' ');
    p = (idx >= 0) ? p.slice(idx + 1) : p;
    return p + '/' + tmpcall;
  } else {
    const nc = nprefix - 60000;
    if (nc >= 0 && nc <= 9) return tmpcall + '/' + String.fromCharCode(nc + 48);
    if (nc >= 10 && nc <= 35) return tmpcall + '/' + String.fromCharCode(nc - 10 + 65);
    if (nc >= 36 && nc <= 125) {
      const a = String.fromCharCode(Math.floor((nc - 26) / 10) + 48);
      const b = String.fromCharCode((nc - 26) % 10 + 48);
      return tmpcall + '/' + a + b;
    }
    return null;
  }
}

// Jenkins hashlittle (nhash.cpp), initval 146, result masked to 15 bits.
function nhash(str) {
  const key = [];
  for (let i = 0; i < str.length; i++) key.push(str.charCodeAt(i) & 0xff);
  let length = key.length;
  const u32 = (x) => x >>> 0;
  const rot = (x, k) => u32((x << k) | (x >>> (32 - k)));
  let a, b, c;
  a = b = c = u32(0xdeadbeef + length + 146);
  let off = 0;
  function mix() {
    a = u32(a - c); a = u32(a ^ rot(c, 4)); c = u32(c + b);
    b = u32(b - a); b = u32(b ^ rot(a, 6)); a = u32(a + c);
    c = u32(c - b); c = u32(c ^ rot(b, 8)); b = u32(b + a);
    a = u32(a - c); a = u32(a ^ rot(c, 16)); c = u32(c + b);
    b = u32(b - a); b = u32(b ^ rot(a, 19)); a = u32(a + c);
    c = u32(c - b); c = u32(c ^ rot(b, 4)); b = u32(b + a);
  }
  while (length > 12) {
    a = u32(a + key[off] + (key[off+1]<<8) + (key[off+2]<<16) + (key[off+3]*16777216));
    b = u32(b + key[off+4] + (key[off+5]<<8) + (key[off+6]<<16) + (key[off+7]*16777216));
    c = u32(c + key[off+8] + (key[off+9]<<8) + (key[off+10]<<16) + (key[off+11]*16777216));
    mix();
    length -= 12; off += 12;
  }
  const K = (i) => (off + i < key.length ? key[off + i] : 0);
  switch (length) {
    case 12: c = u32(c + K(11)*16777216);
    case 11: c = u32(c + (K(10)<<16));
    case 10: c = u32(c + (K(9)<<8));
    case 9:  c = u32(c + K(8));
    case 8:  b = u32(b + K(7)*16777216);
    case 7:  b = u32(b + (K(6)<<16));
    case 6:  b = u32(b + (K(5)<<8));
    case 5:  b = u32(b + K(4));
    case 4:  a = u32(a + K(3)*16777216);
    case 3:  a = u32(a + (K(2)<<16));
    case 2:  a = u32(a + (K(1)<<8));
    case 1:  a = u32(a + K(0)); break;
    case 0:  return c & 32767;
  }
  // final(a,b,c)
  c = u32(c ^ b); c = u32(c - rot(b, 14));
  a = u32(a ^ c); a = u32(a - rot(c, 11));
  b = u32(b ^ a); b = u32(b - rot(a, 25));
  c = u32(c ^ b); c = u32(c - rot(b, 16));
  a = u32(a ^ c); a = u32(a - rot(c, 4));
  b = u32(b ^ a); b = u32(b - rot(a, 14));
  c = u32(c ^ b); c = u32(c - rot(b, 24));
  return c & 32767;
}

// Persistent callsign hash table (module-level, mirrors Kiwi's static ht[]).
const _hashtab = new Map();   // hash(15b) -> callsign
function hash_update(call) { _hashtab.set(nhash(call), call); }
function hash_lookup(hash) { return _hashtab.has(hash) ? _hashtab.get(hash) : null; }

const _isAlpha = (ch) => /[A-Za-z]/.test(ch);
const _isDigit = (ch) => /[0-9]/.test(ch);

// unpk_() → { rtn, callsign, grid, dBm } or null on error (rtn<=0)
function unpk_(decdata) {
  const { call_28b, grid_pwr_22b, grid_15b, pwr_7b } = unpack50(decdata);
  let callsign = unpackcall(call_28b);
  if (callsign == null) return null;                       // -1
  let grid = unpackgrid(grid_15b);
  if (grid == null) return null;                           // -2

  const ntype = pwr_7b - 64;
  let dBm, rtn;

  if (ntype >= 0 && ntype <= 62) {
    const nu = ntype % 10;
    if (nu === 0 || nu === 3 || nu === 7) {
      dBm = ntype;
      hash_update(callsign);
      rtn = 1;
    } else {
      let nadd = nu;
      if (nu > 3) nadd = nu - 3;
      if (nu > 7) nadd = nu - 7;
      const n3 = grid_15b + 32768 * (nadd - 1);
      const c = unpackpfx(n3, callsign);
      if (c == null) return null;                          // -3
      callsign = c;
      grid = '';
      dBm = ntype - nadd;
      const nu2 = dBm % 10;
      if (nu2 === 0 || nu2 === 3 || nu2 === 7 || nu2 === 10) hash_update(callsign);
      else return null;                                    // -4
      rtn = 2;
    }
  } else if (ntype < 0) {
    dBm = -(ntype + 1);
    // grid6 was packed as L2N1N2L3L4L1 → reconstruct: callsign[5] + callsign[0..4]
    const cs = callsign.padEnd(6, ' ');
    grid = cs[5] + cs.slice(0, 5);
    const nu = dBm % 10;
    if ((nu !== 0 && nu !== 3 && nu !== 7 && nu !== 10) ||
        !_isAlpha(grid[0]) || !_isAlpha(grid[1]) ||
        !_isDigit(grid[2]) || !_isDigit(grid[3])) {
      return null;                                         // -5
    }
    const callp = hash_lookup(Math.floor((grid_pwr_22b - ntype - 64) / 128));
    callsign = callp ? callp : '...';
    if (ntype === -64) return null;                        // -6
    rtn = 3;
  } else {
    return null;                                           // -7
  }

  return { rtn, callsign, grid: grid.trim ? grid.trim() : grid, dBm };
}

// ═══════════════════════════════════════════════════════════════════════════
// wspr_decode() — orchestration (wspr.cpp)
// ═══════════════════════════════════════════════════════════════════════════
function _wsprDecode(idat, qdat, np, pwr, psavg, nffts, dialFreqHz, t0) {
  const { smspec, min_snr, snr_scaling } = _renormalize(psavg);

  // ── Build peak list (local maxima), limit to ±110 Hz, top MAX_NPK by SNR ──
  let peaks = [];
  for (let j = 1; j < NBINS_411 - 1; j++) {
    if (smspec[j] > smspec[j-1] && smspec[j] > smspec[j+1] && peaks.length < NPK) {
      const freq0 = (j - HBINS_205) * DF2;
      const snr0 = 10 * Math.log10(smspec[j]) - snr_scaling;
      peaks.push({ bin0: j, freq0, snr0, drift0: 0, shift0: 0, sync0: 0, ignore: false });
    }
  }
  peaks = peaks.filter(p => p.freq0 >= FMIN && p.freq0 <= FMAX);
  peaks.sort((a, b) => b.snr0 - a.snr0);
  if (peaks.length > MAX_NPK) peaks.length = MAX_NPK;
  console.log(`[WSPR] peaks: ${peaks.length}`);

  // ── Coarse freq/time/drift estimate over the power spectrogram ────────────
  for (const p of peaks) {
    let smax = -1e30;
    const if0 = Math.trunc(p.freq0 / DF2) + SPS;
    for (let ifr = if0 - 2; ifr <= if0 + 2; ifr++) {
      for (let k0 = -10; k0 < 22; k0++) {
        for (let idrift = -MAXDRIFT; idrift <= MAXDRIFT; idrift++) {
          let ss = 0.0, power = 0.0;
          for (let k = 0; k < NSYM; k++) {
            const ifd = Math.trunc(ifr + ((k - FHSYM) / FHSYM) * idrift / (2.0 * DF2));
            const kindex = k0 + 2 * k;
            if (kindex >= 0 && kindex < nffts &&
                ifd - 3 >= 0 && ifd + 3 < NFFT) {
              const fr = pwr[kindex];
              const p0 = Math.sqrt(fr[ifd - 3]);
              const p1 = Math.sqrt(fr[ifd - 1]);
              const p2 = Math.sqrt(fr[ifd + 1]);
              const p3 = Math.sqrt(fr[ifd + 3]);
              ss += (2 * pr3[k] - 1) * ((p1 + p3) - (p0 + p2));
              power += p0 + p1 + p2 + p3;
            }
          }
          const sync1 = ss / power;
          if (sync1 > smax) {
            smax = sync1;
            p.shift0 = HSPS * (k0 + 1);
            p.drift0 = idrift;
            p.freq0 = (ifr - SPS) * DF2;
            p.sync0 = sync1;
          }
        }
      }
    }
  }

  const uniques = [];   // { call, freq }
  const results = [];
  const st = { f1: 0, shift1: 0, symbols: new Uint8Array(NSYM) };

  // ── MORE_EFFORT pass loop (bounded by time budget for the browser) ────────
  let maxcycles = 200, iifac = 2;
  for (let ipass = 0; ; ipass++) {
    if (Date.now() - t0 > DECODE_BUDGET_MS) break;
    if (ipass > 0) {
      if (maxcycles < 10000) maxcycles *= 5;
      iifac = 1;
    }

    let candidates = 0;
    for (const p of peaks) {
      if (Date.now() - t0 > DECODE_BUDGET_MS) break;
      if (ipass !== 0 && p.ignore) continue;
      candidates++;

      st.f1 = p.freq0; st.shift1 = p.shift0;
      let drift1 = p.drift0;
      let sync1 = p.sync0;

      // coarse lag then freq search
      let lagmin = st.shift1 - 128, lagmax = st.shift1 + 128, lagstep = 64;
      sync_and_demodulate(idat, qdat, np, st, 0, 0, 0.0, lagmin, lagmax, lagstep, drift1, SYMFAC, MODE_TIME);
      sync1 = sync_and_demodulate(idat, qdat, np, st, -2, 2, 0.25, lagmin, lagmax, lagstep, drift1, SYMFAC, MODE_FREQ);

      // drift refine
      const syncp = sync_and_demodulate(idat, qdat, np, st, 0, 0, 0.0, lagmin, lagmax, lagstep, drift1 + 0.5, SYMFAC, MODE_FREQ);
      const syncm = sync_and_demodulate(idat, qdat, np, st, 0, 0, 0.0, lagmin, lagmax, lagstep, drift1 - 0.5, SYMFAC, MODE_FREQ);
      if (syncp > sync1) { drift1 += 0.5; sync1 = syncp; }
      else if (syncm > sync1) { drift1 -= 0.5; sync1 = syncm; }

      const r_minsync1 = (sync1 > MINSYNC1);
      if (r_minsync1) {
        lagmin = st.shift1 - 32; lagmax = st.shift1 + 32; lagstep = 16;
        sync_and_demodulate(idat, qdat, np, st, 0, 0, 0.0, lagmin, lagmax, lagstep, drift1, SYMFAC, MODE_TIME);
        sync1 = sync_and_demodulate(idat, qdat, np, st, -2, 2, 0.05, lagmin, lagmax, lagstep, drift1, SYMFAC, MODE_FREQ);
      } else {
        p.ignore = true;
        continue;
      }

      // jig over DT, decode via Fano
      const baseShift = st.shift1;
      let decoded = null;
      let idt = 0;
      while (idt <= (JIG_RANGE / iifac)) {
        if (Date.now() - t0 > DECODE_BUDGET_MS) break;
        let ii = Math.floor((idt + 1) / 2);
        if ((idt & 1) === 1) ii = -ii;
        ii = iifac * ii;
        st.shift1 = baseShift + ii;

        sync1 = sync_and_demodulate(idat, qdat, np, st, 0, 0, 0.0, lagmin, lagmax, lagstep, drift1, SYMFAC, MODE_SOFT);

        let sq = 0.0;
        for (let i = 0; i < NSYM; i++) { const y = st.symbols[i] - 128.0; sq += y * y; }
        const rms = Math.sqrt(sq / NSYM);

        if (sync1 > MINSYNC2 && rms > MINRMS) {
          const syms = Uint8Array.from(st.symbols);
          deinterleave(syms);
          const fr = fano(syms, NBITS, FANO_DELTA, maxcycles);
          if (fr.ok) { decoded = fr; break; }
        }
        idt++;
      }

      if (!decoded) continue;

      p.ignore = true;
      const msg = unpk_(decoded.data);
      if (!msg) continue;

      // dedupe: same call & freq within 3 Hz, or same non-hashed call
      const isHash = (msg.callsign === '...');
      let dupe = false;
      for (const u of uniques) {
        const match = (u.call === msg.callsign);
        const close = Math.abs(st.f1 - u.freq) < 3.0;
        if ((match && close) || (match && !isHash)) { dupe = true; break; }
      }
      if (dupe) continue;

      uniques.push({ call: msg.callsign, freq: st.f1 });

      const audioHz = WSPR_CENTER + st.f1;
      const absFreq = dialFreqHz ? (dialFreqHz + audioHz) : audioHz;
      const dt = st.shift1 * DT - 1.0;

      results.push({
        callsign: msg.callsign,
        grid: msg.grid || '',
        dbm: msg.dBm,
        type: msg.rtn,
        freq: +absFreq.toFixed(0),
        // Audio-baseband frequency, kept separate from the rounded absolute
        // freq above: the panel spectrum plots an audio axis only 220 Hz wide,
        // where 1 Hz of rounding is a visible marker offset.
        audioHz: +audioHz.toFixed(1),
        snr: +p.snr0.toFixed(1),
        dt: +dt.toFixed(1),
        drift: +drift1.toFixed(1),
        sync: +sync1.toFixed(3),
        confidence: +sync1.toFixed(3),
      });
      console.log(`[WSPR] decode: ${msg.callsign} ${msg.grid} ${msg.dBm}dBm  f=${audioHz.toFixed(1)}Hz snr=${p.snr0.toFixed(1)} dt=${dt.toFixed(1)} drift=${drift1} sync=${sync1.toFixed(3)}`);
    }

    if (candidates === 0) break;
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// Resampler (unchanged from previous module) + slot helpers
// ═══════════════════════════════════════════════════════════════════════════
function _resample(pcm, fromSR, toSR) {
  if (fromSR === toSR) return pcm;
  const ratio = fromSR / toSR;
  const intRatio = Math.round(ratio);

  if (Number.isFinite(ratio) && Math.abs(ratio - intRatio) < 1e-9 && intRatio >= 2) {
    const tapsPerPhase = 24;
    const taps = tapsPerPhase * intRatio * 2 + 1;
    const center = Math.floor(taps / 2);
    const fc = 0.5 / intRatio;
    const coeffs = new Float64Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const n = i - center;
      const x = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
      const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1));
      const c = x * w;
      coeffs[i] = c;
      sum += c;
    }
    for (let i = 0; i < taps; i++) coeffs[i] /= sum;

    const outLen = Math.floor((pcm.length - 1) / intRatio);
    const out = new Float32Array(Math.max(0, outLen));
    for (let oi = 0; oi < out.length; oi++) {
      const centerIdx = oi * intRatio;
      let acc = 0;
      for (let j = 0; j < taps; j++) {
        const idx = centerIdx + j - center;
        if (idx >= 0 && idx < pcm.length) acc += pcm[idx] * coeffs[j];
      }
      out[oi] = acc;
    }
    return out;
  }

  const outLen = Math.floor(pcm.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, pcm.length - 1);
    out[i] = pcm[lo] * (1 - (pos - lo)) + pcm[hi] * (pos - lo);
  }
  return out;
}

export function wspr2SlotPosition() {
  const now = new Date();
  return (now.getUTCMinutes() % 2) * 60 + now.getUTCSeconds();
}

export function isWSPRSlotStart() {
  return wspr2SlotPosition() === 0;
}
