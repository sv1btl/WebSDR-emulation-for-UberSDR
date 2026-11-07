// msk144.js — MSK144 decoder (receive only) for the FLDIGI window
// ============================================================================
// MSK144 is WSJT-X's meteor-scatter mode for 6 m and 2 m: 2000 bit/s MSK
// (tones 1000 / 2000 Hz around a 1500 Hz centre), 72 ms frames of 144 bits
// (two 8-bit sync words + an LDPC(128,90) codeword carrying a 77-bit
// WSJT-X message and a CRC-13), sent over and over through a T/R period, so
// a meteor ping of a tenth of a second can carry a whole message.
//
// A port of the WSJT-X real-time decoder (lib/mskrtd.f90 with analytic,
// msk144spd, msk144sync, msk144_freq_search, msk144decodeframe,
// bpdecode128_90 and chkcrc13a; GPL-3), run the way decode_msk144.f90 runs
// it: blocks of 7168 samples at 12 kHz, every 3584 samples. Each block is
// tried first with the short-ping decoder (one-to-three-frame windows around
// the strongest detections), then with coherent averages of 4–7 frames for
// longer, weaker pings. The 40-bit short messages (Sh) are left out: they
// need the operator's own and the DX call.
//
// Interface:
//   new Msk144Decoder({ sampleRate, centerHz, tolHz, period, depth, onDecode, onStatus, onMetrics, now })
//   .feed(Float32Array) .reset()
//   onDecode({ utc, t, snr, freq, msg, navg })
// ============================================================================

import { fftMixed } from './lib/fftMixed.js';
import { MN, NM, NRW, G } from './lib/msk144Tables.js';
import { HashTable, unpack77 } from './lib/pack77.js';

const FS = 12000;
const NSPM = 864;          // samples per 72 ms frame
const NZ = 7168;           // block
const STEP = NZ / 2;
const NFFT1 = 8192;
const N = 128, K = 90, M = N - K;
const S8 = [-1, 1, 1, 1, -1, -1, 1, -1];     // 2·[0,1,1,1,0,0,1,0] − 1

// ── half-sine pulse and the sync waveform (msk144sync / decodeframe) ────────
const PP = Float64Array.from({ length: 12 }, (_, i) => Math.sin(i * Math.PI / 12));
const RCW = Float64Array.from({ length: 12 }, (_, i) => (1 - Math.cos(i * Math.PI / 12)) / 2);
const CBR = new Float64Array(42), CBI = new Float64Array(42);
for (let i = 0; i < 6; i++) CBI[i] = PP[6 + i] * S8[0];
for (let i = 0; i < 12; i++) { CBI[6 + i] = PP[i] * S8[2]; CBI[18 + i] = PP[i] * S8[4]; CBI[30 + i] = PP[i] * S8[6]; }
for (let i = 0; i < 12; i++) { CBR[i] = PP[i] * S8[1]; CBR[12 + i] = PP[i] * S8[3]; CBR[24 + i] = PP[i] * S8[5]; }
for (let i = 0; i < 6; i++) CBR[36 + i] = PP[i] * S8[7];

// ── CRC-13 (boost augmented_crc<13, 0x15D7> over 12 bytes) ─────────────────
function crc13(bits96) {
  let r = 0;
  for (let i = 0; i < 96; i++) {
    const top = (r >> 12) & 1;
    r = ((r << 1) | bits96[i]) & 0x1fff;
    if (top) r ^= 0x15d7;
  }
  return r;
}
/** 77 message bits → their CRC-13 (encode_128_90 / chkcrc13a). */
export function msk144Crc(bits77) {
  const b = new Uint8Array(96);
  for (let i = 0; i < 77; i++) b[i] = bits77[i];
  return crc13(b);
}

// ── LDPC(128,90) ────────────────────────────────────────────────────────────
let _gen = null;
function _genMatrix() {
  if (_gen) return _gen;
  _gen = [];
  for (let i = 0; i < M; i++) {
    const row = new Uint8Array(K);
    for (let j = 0; j < 23; j++) {
      const v = parseInt(G[i][j], 16), ibmax = j === 22 ? 2 : 4;
      for (let jj = 1; jj <= ibmax; jj++) if (v & (1 << (4 - jj))) row[j * 4 + jj - 1] = 1;
    }
    _gen.push(row);
  }
  return _gen;
}
/** 77 message bits → 128-bit codeword (encode_128_90). */
export function encode128_90(bits77) {
  const m = new Uint8Array(K);
  for (let i = 0; i < 77; i++) m[i] = bits77[i];
  const c = msk144Crc(bits77);
  for (let i = 0; i < 13; i++) m[77 + i] = (c >> (12 - i)) & 1;
  const gen = _genMatrix(), cw = new Uint8Array(N);
  cw.set(m);
  for (let i = 0; i < M; i++) { let s = 0; for (let j = 0; j < K; j++) s += m[j] & gen[i][j]; cw[K + i] = s & 1; }
  return cw;
}

function platanh(x) {
  const sign = x < 0 ? -1 : 1, z = Math.abs(x);
  if (z <= 0.664) return x / 0.83;
  if (z <= 0.9217) return sign * (z - 0.4064) / 0.322;
  if (z <= 0.9951) return sign * (z - 0.8378) / 0.0524;
  if (z <= 0.9998) return sign * (z - 0.9914) / 0.0012;
  return sign * 7.0;
}

/** bpdecode128_90 → { msg77, nharderror } or null. */
export function bpdecode128_90(llr, maxiter = 10) {
  const tov = new Float64Array(3 * N), toc = new Float64Array(11 * M), tanhtoc = new Float64Array(11 * M);
  const zn = new Float64Array(N), cw = new Uint8Array(N);
  let ncnt = 0, nclast = 0;
  for (let j = 0; j < M; j++) for (let i = 0; i < NRW[j]; i++) toc[11 * j + i] = llr[NM[11 * j + i] - 1];
  for (let iter = 0; iter <= maxiter; iter++) {
    for (let i = 0; i < N; i++) { zn[i] = llr[i] + tov[3 * i] + tov[3 * i + 1] + tov[3 * i + 2]; cw[i] = zn[i] > 0 ? 1 : 0; }
    let ncheck = 0;
    for (let j = 0; j < M; j++) { let s = 0; for (let i = 0; i < NRW[j]; i++) s += cw[NM[11 * j + i] - 1]; if (s & 1) ncheck++; }
    if (ncheck === 0) {
      const b = new Uint8Array(96);
      for (let i = 0; i < 77; i++) b[i] = cw[i];
      let rx = 0;
      for (let i = 0; i < 13; i++) rx = (rx << 1) | cw[77 + i];
      if (crc13(b) === rx) {
        let nh = 0;
        for (let i = 0; i < N; i++) if ((2 * cw[i] - 1) * llr[i] < 0) nh++;
        return { msg77: cw.slice(0, 77), nharderror: nh, iter };
      }
    }
    if (iter > 0) {
      if (ncheck - nclast < 0) ncnt = 0; else ncnt++;
      if (ncnt >= 3 && iter >= 5 && ncheck > 10) return null;
    }
    nclast = ncheck;
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < NRW[j]; i++) {
        const ibj = NM[11 * j + i] - 1;
        let t = zn[ibj];
        for (let kk = 0; kk < 3; kk++) if (MN[3 * ibj + kk] - 1 === j) t -= tov[3 * ibj + kk];
        toc[11 * j + i] = t;
        tanhtoc[11 * j + i] = Math.tanh(-t / 2);
      }
    }
    for (let jb = 0; jb < N; jb++) {
      for (let i = 0; i < 3; i++) {
        const ichk = MN[3 * jb + i] - 1;
        let tmn = 1;
        for (let q = 0; q < NRW[ichk]; q++) if (NM[11 * ichk + q] - 1 !== jb) tmn *= tanhtoc[11 * ichk + q];
        tov[3 * jb + i] = 2 * platanh(-tmn);
      }
    }
  }
  return null;
}

// ── test transmitter (genmsk_128_90 + msk144sim) ────────────────────────────
/** 77 message bits → 144 tones (0 = lower, 1 = upper). */
export function msk144Tones(bits77) {
  const cw = encode128_90(bits77);
  const seq = new Int8Array(144);
  const s8 = [0, 1, 1, 1, 0, 0, 1, 0];
  for (let i = 0; i < 8; i++) { seq[i] = s8[i]; seq[56 + i] = s8[i]; }
  for (let i = 0; i < 48; i++) seq[8 + i] = cw[i];
  for (let i = 0; i < 80; i++) seq[64 + i] = cw[48 + i];
  const b = Int8Array.from(seq, (x) => 2 * x - 1);
  const t = new Int8Array(144);
  for (let i = 1; i <= 72; i++) {
    t[2 * i - 2] = (b[2 * i - 1] * b[2 * i - 2] + 1) / 2;
    t[2 * i - 1] = -(b[2 * i - 1] * b[(2 * i) % 144] - 1) / 2;
  }
  for (let i = 0; i < 144; i++) t[i] = -t[i] + 1;
  return t;
}
/** Continuous MSK waveform at 12 kHz for `nframes` frames, carrier freq (Hz). */
export function msk144Wave(tones, nframes, freq = 1500) {
  const out = new Float32Array(nframes * NSPM);
  const d0 = 2 * Math.PI * (freq - 500) / FS, d1 = 2 * Math.PI * (freq + 500) / FS;
  let phi = 0, k = 0;
  for (let r = 0; r < nframes; r++) for (let i = 0; i < 144; i++) {
    const d = tones[i] ? d1 : d0;
    for (let j = 0; j < 6; j++) { out[k++] = Math.cos(phi); phi = (phi + d) % (2 * Math.PI); }
  }
  return out;
}

// ── analytic signal of one block (analytic.f90, no equaliser) ───────────────
let _h = null;
function _bpf() {
  if (_h) return _h;
  const df = FS / NFFT1, nh = NFFT1 / 2, t = 1 / 2000, beta = 0.1;
  _h = new Float64Array(nh + 1);
  for (let i = 0; i <= nh; i++) {
    const f = Math.abs(i * df - 1500);
    let h = 1;
    if (f > (1 - beta) / (2 * t) && f <= (1 + beta) / (2 * t)) h = 0.5 * (1 + Math.cos((Math.PI * t / beta) * (f - (1 - beta) / (2 * t))));
    else if (f > (1 + beta) / (2 * t)) h = 0;
    _h[i] = h;
  }
  return _h;
}
function analytic(d) {
  const re = new Float64Array(NFFT1), im = new Float64Array(NFFT1);
  const fac = 2 / NFFT1;
  for (let i = 0; i < d.length; i++) re[i] = fac * d[i];
  fftMixed(re, im, false);
  const h = _bpf(), nh = NFFT1 / 2;
  for (let i = 0; i <= nh; i++) { re[i] *= h[i]; im[i] *= h[i]; }
  re[0] *= 0.5; im[0] *= 0.5;
  for (let i = nh + 1; i < NFFT1; i++) { re[i] = 0; im[i] = 0; }
  fftMixed(re, im, true);
  return { re, im };
}

// ── msk144_freq_search + msk144sync ─────────────────────────────────────────
// cdat: complex samples (re, im, offset off, nframes·NSPM long).
function msk144sync(cr, ci, off, nframes, ntol, delf, navmask, npeaks, fc) {
  const n = nframes * NSPM;
  let navg = 0;
  for (let i = 0; i < nframes; i++) navg += navmask[i];
  const fac = 1 / (48 * Math.sqrt(navg));
  const lim = Math.round(ntol / delf);
  let xmax = 0, bestf = 0;
  let csR = null, csI = null, xccBest = null;
  const cR = new Float64Array(NSPM), cI = new Float64Array(NSPM);
  const xcc = new Float64Array(NSPM);
  const pR = new Float64Array(NSPM + 42), pI = new Float64Array(NSPM + 42);
  for (let ifr = -lim; ifr <= lim; ifr++) {
    const ferr = ifr * delf;
    const dphi = 2 * Math.PI * -(fc + ferr) / FS;
    cR.fill(0); cI.fill(0);
    for (let fr = 0; fr < nframes; fr++) {
      if (!navmask[fr]) continue;
      const b = fr * NSPM;
      // w = exp(j·dphi·(i+1)), i the sample index (tweak1 starts at w = wstep)
      let wr = Math.cos(dphi * (b + 1)), wi = Math.sin(dphi * (b + 1));
      const sr = Math.cos(dphi), si = Math.sin(dphi);
      for (let i = 0; i < NSPM; i++) {
        const xr = cr[off + b + i], xi = ci[off + b + i];
        cR[i] += xr * wr - xi * wi; cI[i] += xr * wi + xi * wr;
        const t = wr * sr - wi * si; wi = wr * si + wi * sr; wr = t;
      }
    }
    // both sync words at once: p[i] = c[i] + c[i + 336], wrapped (ct2 in the Fortran)
    for (let i = 0; i < NSPM; i++) { const j = i < NSPM - 336 ? i + 336 : i + 336 - NSPM; pR[i] = cR[i] + cR[j]; pI[i] = cI[i] + cI[j]; }
    for (let i = 0; i < 42; i++) { pR[NSPM + i] = pR[i]; pI[NSPM + i] = pI[i]; }
    let xb = 0;
    for (let ish = 0; ish < NSPM; ish++) {
      let ar = 0, ai = 0;
      for (let k = 0; k < 42; k++) {
        const pr = pR[ish + k], pi = pI[ish + k];
        // conj(p) · cb
        ar += pr * CBR[k] + pi * CBI[k]; ai += pr * CBI[k] - pi * CBR[k];
      }
      const v = Math.sqrt(ar * ar + ai * ai);
      xcc[ish] = v;
      if (v > xb) xb = v;
    }
    xb *= fac;
    if (xb > xmax) { xmax = xb; bestf = ferr; csR = Float64Array.from(cR); csI = Float64Array.from(cI); xccBest = Float64Array.from(xcc); }
  }
  if (!csR) return null;
  const peaks = [];
  for (let p = 0; p < npeaks; p++) {
    let e = 0;
    for (let i = 1; i < NSPM; i++) if (xccBest[i] > xccBest[e]) e = i;
    peaks.push(e + 1);     // 1-based, as Fortran maxloc
    for (let i = Math.max(0, e + 1 - 7); i <= Math.min(NSPM - 1, e + 1 + 7); i++) xccBest[i] = 0;
  }
  return { ok: xmax >= 1.3, xmax, fest: fc + bestf, cR: csR, cI: csI, peaks };
}

// ── msk144decodeframe ───────────────────────────────────────────────────────
function decodeFrame(cR0, cI0, ic0, hash) {
  const cR = new Float64Array(NSPM), cI = new Float64Array(NSPM);
  for (let i = 0; i < NSPM; i++) { const j = (i + ic0 - 1) % NSPM; cR[i] = cR0[j]; cI[i] = cI0[j]; }
  let ar = 0, ai = 0, br = 0, bi = 0;
  for (let k = 0; k < 42; k++) {
    ar += cR[k] * CBR[k] + cI[k] * CBI[k]; ai += cI[k] * CBR[k] - cR[k] * CBI[k];
    br += cR[336 + k] * CBR[k] + cI[336 + k] * CBI[k]; bi += cI[336 + k] * CBR[k] - cR[336 + k] * CBI[k];
  }
  const ph = Math.atan2(ai + bi, ar + br), pc = Math.cos(ph), ps = Math.sin(ph);
  for (let i = 0; i < NSPM; i++) { const r = cR[i] * pc + cI[i] * ps, q = cI[i] * pc - cR[i] * ps; cR[i] = r; cI[i] = q; }
  const sb = new Float64Array(144);
  let s = 0;
  for (let k = 0; k < 6; k++) s += cI[k] * PP[6 + k] + cI[NSPM - 6 + k] * PP[k];
  sb[0] = s;
  s = 0; for (let k = 0; k < 12; k++) s += cR[k] * PP[k];
  sb[1] = s;
  for (let i = 2; i <= 72; i++) {
    let a = 0, b = 0;
    const i0 = (i - 1) * 12 - 6;            // 0-based start of the imag window
    for (let k = 0; k < 12; k++) { a += cI[i0 + k] * PP[k]; b += cR[i0 + 6 + k] * PP[k]; }
    sb[2 * i - 2] = a; sb[2 * i - 1] = b;
  }
  let bad = 0;
  for (let i = 0; i < 8; i++) { if ((sb[i] >= 0 ? 1 : -1) !== S8[i]) bad++; if ((sb[56 + i] >= 0 ? 1 : -1) !== S8[i]) bad++; }
  if (bad > 4) return null;
  let sav = 0, s2 = 0;
  for (let i = 0; i < 144; i++) { sav += sb[i]; s2 += sb[i] * sb[i]; }
  sav /= 144; s2 /= 144;
  const ssig = Math.sqrt(Math.max(1e-30, s2 - sav * sav));
  const llr = new Float64Array(N), k2 = 2 / (0.6 * 0.6);
  for (let i = 0; i < 48; i++) llr[i] = k2 * sb[8 + i] / ssig;
  for (let i = 0; i < 80; i++) llr[48 + i] = k2 * sb[64 + i] / ssig;
  const d = bpdecode128_90(llr, 10);
  if (!d || d.nharderror >= 18) return null;
  const v = (from, len) => { let x = 0; for (let i = 0; i < len; i++) x = x * 2 + d.msg77[from + i]; return x; };
  const n3 = v(71, 3), i3 = v(74, 3);
  if ((i3 === 0 && (n3 === 1 || n3 === 3 || n3 === 4 || n3 > 5)) || i3 === 3 || i3 > 5) return null;
  const u = unpack77(d.msg77, hash);
  if (!u.ok) return null;
  return { msg: u.msg, nharderror: d.nharderror };
}

function tryDecode(sync, hash) {
  for (const pk of sync.peaks) {
    for (let is = 1; is <= 3; is++) {
      let ic0 = pk;
      if (is === 2) ic0 = Math.max(1, ic0 - 1);
      if (is === 3) ic0 = Math.min(NSPM, ic0 + 1);
      const r = decodeFrame(sync.cR, sync.cI, ic0, hash);
      if (r) return r;
    }
  }
  return null;
}

// ── msk144spd: the short-ping decoder ───────────────────────────────────────
const NAVPATTERNS = [[0, 1, 0], [1, 0, 0], [0, 0, 1], [1, 1, 0], [0, 1, 1], [1, 1, 1]];
function msk144spd(cr, ci, n, ntol, fc, hash) {
  const df = FS / NSPM;
  const nstep = Math.trunc((n - NSPM) / 216);
  const detmet = new Float64Array(nstep), detmet2 = new Float64Array(nstep), detfer = new Float64Array(nstep).fill(-999.99);
  const nfhi = 2 * (fc + 500), nflo = 2 * (fc - 500);
  // 0-based bin indices (Fortran's +1 dropped)
  const ihlo = Math.round((nfhi - 2 * ntol) / df), ihhi = Math.round((nfhi + 2 * ntol) / df);
  const illo = Math.round((nflo - 2 * ntol) / df), ilhi = Math.round((nflo + 2 * ntol) / df);
  const i2000 = Math.round(nflo / df), i4000 = Math.round(nfhi / df);
  const tr = new Float64Array(NSPM), ti = new Float64Array(NSPM), spec = new Float64Array(NSPM);
  const peak = (lo, hi) => {
    let ip = lo;
    for (let i = lo; i <= hi; i++) if (spec[i] > spec[ip]) ip = i;
    // delta = −Re((c[ip−1] − c[ip+1]) / (2c[ip] − c[ip−1] − c[ip+1]))
    const a = ip - 1, b = ip + 1;
    const nr = tr[a] - tr[b], ni = ti[a] - ti[b];
    const dr = 2 * tr[ip] - tr[a] - tr[b], di = 2 * ti[ip] - ti[a] - ti[b];
    const den = dr * dr + di * di;
    const delta = den > 0 ? -(nr * dr + ni * di) / den : 0;
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += spec[i];
    const amp = spec[ip], avp = (sum - amp) / (hi - lo + 1);
    return { ip, delta, amp, rat: amp / (avp + 0.01) };
  };
  for (let st = 0; st < nstep; st++) {
    const ns = 216 * st;
    for (let i = 0; i < NSPM; i++) {
      const xr = cr[ns + i], xi = ci[ns + i];
      tr[i] = xr * xr - xi * xi; ti[i] = 2 * xr * xi;
    }
    for (let i = 0; i < 12; i++) {
      tr[i] *= RCW[i]; ti[i] *= RCW[i];
      tr[NSPM - 12 + i] *= RCW[11 - i]; ti[NSPM - 12 + i] *= RCW[11 - i];
    }
    fftMixed(tr, ti, false);
    for (let i = 0; i < NSPM; i++) spec[i] = tr[i] * tr[i] + ti[i] * ti[i];
    const h = peak(ihlo, ihhi), l = peak(illo, ilhi);
    const ferrh = (h.ip + h.delta - i4000) * df / 2, ferrl = (l.ip + l.delta - i2000) * df / 2;
    detmet[st] = Math.max(h.amp, l.amp);
    detmet2[st] = Math.max(h.rat, l.rat);
    detfer[st] = h.amp >= l.amp ? ferrh : ferrl;
  }
  if (nstep < 4) return null;
  const sorted = Array.from(detmet).sort((a, b) => a - b);
  const xmed = sorted[Math.trunc(nstep / 4) - 1] || 1e-30;
  for (let i = 0; i < nstep; i++) detmet[i] /= xmed;
  const cands = [];
  for (let p = 0; p < 5; p++) {
    let il = 0;
    for (let i = 1; i < nstep; i++) if (detmet[i] > detmet[il]) il = i;
    if (detmet[il] < 3.0) break;
    if (Math.abs(detfer[il]) <= ntol) cands.push({ nstart: 1 + il * 216 + 1, ferr: detfer[il] });
    detmet[il] = 0;
  }
  if (cands.length < 3) {
    const room = 5 - cands.length;
    for (let p = 0; p < room; p++) {
      let il = 0;
      for (let i = 1; i < nstep; i++) if (detmet2[i] > detmet2[il]) il = i;
      if (detmet2[il] < 12.0) break;
      if (Math.abs(detfer[il]) <= ntol) cands.push({ nstart: 1 + il * 216 + 1, ferr: detfer[il] });
      detmet2[il] = 0;
    }
  }
  for (const c of cands) {
    let ib = Math.max(1, c.nstart - NSPM), ie = ib - 1 + 3 * NSPM;
    if (ie > n) { ie = n; ib = ie - 3 * NSPM + 1; }
    const fo = fc + c.ferr;
    for (const mask of NAVPATTERNS) {
      const sync = msk144sync(cr, ci, ib - 1, 3, 8, 2.0, mask, 2, fo);
      if (!sync || !sync.ok) continue;
      const r = tryDecode(sync, hash);
      if (r) return { ...r, fest: sync.fest, t: (c.nstart + NSPM / 2) / FS, navg: mask.reduce((a, b) => a + b, 0) };
    }
  }
  return null;
}

// ── one block (mskrtd) ──────────────────────────────────────────────────────
const IAVPATTERNS = [[1, 1, 1, 1, 0, 0, 0, 0], [0, 0, 1, 1, 1, 1, 0, 0], [1, 1, 1, 1, 1, 0, 0, 0], [1, 1, 1, 1, 1, 1, 1, 0]];
const XMC = [2.0, 4.5, 2.5, 3.5];

/**
 * Decode one 7168-sample block at 12 kHz. state: { pnoise, hash }.
 * Returns { msg, snr, freq, t, navg } or null.
 */
export function msk144DecodeBlock(block, state, opts = {}) {
  const ntol = opts.tolHz ?? 100, fc = opts.centerHz ?? 1500, depth = opts.depth ?? 3;
  let s2 = 0;
  for (let i = 0; i < NZ; i++) s2 += block[i] * block[i];
  const rms = Math.sqrt(s2 / NZ);
  if (!(rms > 1e-9)) return null;
  const d = new Float64Array(NZ);
  for (let i = 0; i < NZ; i++) d[i] = block[i] / rms;
  const { re, im } = analytic(d);
  const pow = [];
  for (let f = 0; f < 8; f++) {
    let p = 0;
    for (let i = f * NSPM; i < (f + 1) * NSPM; i++) p += re[i] * re[i] + im[i] * im[i];
    pow.push(p * rms * rms);
  }
  const pmax = Math.max(...pow), pavg = pow.reduce((a, b) => a + b, 0) / 8;
  let r = msk144spd(re, im, 8 * NSPM, ntol, fc, state.hash);
  if (!r) {
    const npat = depth === 1 ? 0 : depth === 2 ? 2 : 4;
    for (let iavg = 0; iavg < npat && !r; iavg++) {
      const mask = IAVPATTERNS[iavg];
      const navg = mask.reduce((a, b) => a + b, 0);
      const sync = msk144sync(re, im, 0, 8, ntol, 10 / navg, mask, 2, fc);
      if (!sync || !sync.ok) continue;
      const dec = tryDecode(sync, state.hash);
      if (dec) r = { ...dec, fest: sync.fest, t: XMC[iavg] * NSPM / FS, navg };
    }
  }
  if (!r) {
    if (state.pnoise < 0) state.pnoise = pavg;
    else if (pavg > state.pnoise) state.pnoise = 0.9 * state.pnoise + 0.1 * pavg;
    else state.pnoise = pavg;
    return null;
  }
  let snr = state.pnoise > 0 ? 10 * Math.log10(Math.max(1e-9, pmax / state.pnoise - 1)) : 0;
  snr = Math.max(-8, Math.min(24, Math.round(snr)));
  return { msg: r.msg, snr, freq: Math.round(r.fest), t: r.t, navg: r.navg };
}

// ── streaming: resample to 12 kHz, blocks of 7168 every 3584 ────────────────
// Windowed-sinc fractional resampler to 12 kHz: 32 taps, coefficients
// precomputed for NPHASE fractional positions (nearest one is used).
const TAPS = 32, HALF = 16, NPHASE = 512, RING = 64;   // RING: input history kept (≥ TAPS + a sample of lag)
function _resamplerTable(fcut) {
  const tab = new Float64Array(NPHASE * TAPS);
  for (let ph = 0; ph < NPHASE; ph++) {
    const mu = ph / NPHASE;
    let sum = 0;
    for (let j = 0; j < TAPS; j++) {
      const x = j - (HALF - 1) - mu;             // tap offset from the output position
      const w = 0.42 + 0.5 * Math.cos(Math.PI * x / HALF) + 0.08 * Math.cos(2 * Math.PI * x / HALF);
      const sn = x === 0 ? 2 * fcut : Math.sin(2 * Math.PI * fcut * x) / (Math.PI * x);
      tab[ph * TAPS + j] = sn * w;
      sum += sn * w;
    }
    for (let j = 0; j < TAPS; j++) tab[ph * TAPS + j] /= sum;
  }
  return tab;
}
export class Msk144Decoder {
  constructor(options = {}) {
    this._srFn = typeof options.sampleRate === 'function' ? options.sampleRate : (() => Number(options.sampleRate) || 12000);
    this.onDecode = typeof options.onDecode === 'function' ? options.onDecode : null;
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
    this.onMetrics = typeof options.onMetrics === 'function' ? options.onMetrics : null;
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();
    this._center = Number(options.centerHz) || 1500;
    this._tol = Number(options.tolHz) || 100;
    this._period = Number(options.period) === 30 ? 30 : 15;
    this._depth = [1, 2, 3].includes(Number(options.depth)) ? Number(options.depth) : 3;
    this._hash = new HashTable();
    this.reset();
  }
  setTolerance(hz) { hz = Number(hz); if (hz >= 10 && hz <= 500) this._tol = hz; }
  setCenter(hz) { hz = Number(hz); if (hz >= 1000 && hz <= 2000) this._center = hz; }
  setPeriod(p) { this._period = Number(p) === 30 ? 30 : 15; }
  setDepth(d) { if ([1, 2, 3].includes(Number(d))) this._depth = Number(d); }

  reset() {
    this._sr = 0;
    this._buf = new Float32Array(NZ);
    this._fill = 0;
    this._state = { pnoise: -1, hash: this._hash };
    this._last = new Map();       // msg → { period, snr } for the dupe check
    this._blocks = 0; this._decodes = 0; this._busyMs = 0;
    this._lastStatus = 0;
  }

  _build(sr) {
    this._sr = sr;
    this._ratio = sr / FS;                 // input samples per output sample
    this._hist = new Float64Array(2 * RING);   // the last RING inputs, stored twice
    this._hpos = 0;
    this._hn = 0;                          // input samples received
    this._tOut = RING;                     // next output position (input-sample units)
    // anti-alias corner well above MSK144's 2.5 kHz top, below 6 kHz
    this._tab = _resamplerTable(Math.min(0.5, 0.5 / this._ratio) * 0.9);
    this._direct = Math.abs(sr - FS) < 0.5;
  }

  feed(pcm) {
    if (!pcm || !pcm.length) return;
    const sr = this._srFn() || 12000;
    if (!this._sr || Math.abs(sr - this._sr) > 0.5) this._build(sr);
    if (this._direct) { for (let i = 0; i < pcm.length; i++) this._push(pcm[i]); }
    else {
      const H = this._hist, tab = this._tab;
      for (let i = 0; i < pcm.length; i++) {
        H[this._hpos] = pcm[i]; H[this._hpos + RING] = pcm[i];
        this._hpos = (this._hpos + 1) % RING;
        this._hn++;
        // output at input position t needs inputs floor(t) − 15 … floor(t) + 16
        const last = this._hn - HALF - 1;
        while (this._tOut <= last) {
          const i0 = Math.floor(this._tOut);
          const ph = Math.min(NPHASE - 1, Math.round((this._tOut - i0) * NPHASE));
          // H holds inputs hn−RING … hn−1 from this._hpos on; the first tap is input i0 − 15
          const start = this._hpos + (i0 - (HALF - 1)) - (this._hn - RING);
          let acc = 0;
          const c0 = ph * TAPS;
          for (let j = 0; j < TAPS; j++) acc += H[start + j] * tab[c0 + j];
          this._push(acc);
          this._tOut += this._ratio;
        }
      }
    }
    const now = this._now();
    if (now - this._lastStatus > 1000) {
      this._lastStatus = now;
      if (this.onStatus) this.onStatus(`Listening ±${this._tol} Hz around ${this._center} Hz · ${this._decodes} decode${this._decodes === 1 ? '' : 's'}`);
      if (this.onMetrics) this.onMetrics({ blocks: this._blocks, decodes: this._decodes, load: this._busyMs / Math.max(1, this._blocks * STEP / FS * 1000) });
    }
  }

  _push(x) {
    this._buf[this._fill++] = x;
    if (this._fill < NZ) return;
    // block complete: decode it, then keep its second half
    const t0 = Date.now();
    const blockEnd = this._now() / 1000;
    let r = null;
    try { r = msk144DecodeBlock(this._buf, this._state, { tolHz: this._tol, centerHz: this._center, depth: this._depth }); }
    catch (e) { if (this.onStatus) this.onStatus('Decoder error: ' + (e && e.message)); }
    this._busyMs += Date.now() - t0;
    this._blocks++;
    this._buf.copyWithin(0, STEP);
    this._fill = NZ - STEP;
    if (!r) return;
    // when the decoded frame was on the air
    const tAbs = blockEnd - NZ / FS + r.t;
    const T = this._period, start = Math.floor(tAbs / T) * T;
    const prev = this._last.get(r.msg);
    if (prev && prev.period === start && r.snr <= prev.snr) return;   // dupe in this period
    this._last.set(r.msg, { period: start, snr: r.snr });
    if (this._last.size > 200) this._last.delete(this._last.keys().next().value);
    this._decodes++;
    if (this.onDecode) this.onDecode({
      utc: new Date(tAbs * 1000).toISOString().slice(11, 19), t: Math.round((tAbs - start) * 10) / 10,
      snr: r.snr, freq: r.freq, msg: r.msg, navg: r.navg, period: T,
    });
  }
}

export default Msk144Decoder;
