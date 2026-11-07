// fst4w.js — FST4W decoder (receive only) for the FLDIGI window
// ============================================================================
// FST4W is WSJT-X's weak-signal beacon mode for LF/MF (and HF): the same
// 50-bit message as WSPR (call, 4-character locator, power), protected by a
// CRC-24 and an LDPC(240,74) code, sent as 4-GFSK in 160 symbols (120 data
// + 40 sync in five 8-symbol blocks). One transmission fills one T/R period
// of 120, 300, 900 or 1800 s; the signal starts 1 s into the period.
//
// This is a port of the WSJT-X decoder (lib/fst4_decode.f90 with
// get_fst4_bitmetrics, decode240_74, fastosd240_74, get_crc24, encode240_74
// and the type 0.6 part of unpack77; GPL-3), with one change for the
// browser: instead of a real FFT of the whole period at 12 kHz (up to 21.6 M
// points), the audio is first mixed down around the receive frequency to a
// narrow complex baseband (750 Hz, or 2400 Hz for the 2-minute mode) whose
// FFT holds exactly the same bins (same df) as the WSJT-X big FFT. Everything
// after that — candidates, sync search, the 1/2/4/8-symbol bit metrics, BP +
// OSD decoding, SNR — follows the Fortran step by step (iwspr=1, depth 2:
// four metric blocks, three time jitters, Keff=66; no Keff=50 pass, which
// needs a list of previously heard calls).
//
// Interface:
//   new Fst4wDecoder({ sampleRate, period, centerHz, tolHz, onDecode, onStatus, now })
//   .feed(Float32Array) .reset() .flush()
//   onDecode({ utc, period, snr, dt, audioHz, msg, call, grid, dbm })
//   onStatus(text, { recorded, period, startsAt })
//   decodeFst4wBaseband(re, im, fsI, fLO, period, opts) — the pure decoder
// ============================================================================

import { fftMixed } from './lib/fftMixed.js';
import { MN, NM, NRW, G } from './lib/fst4wTables.js';
import { HashTable, pack28, unpackWspr50 } from './lib/pack77.js';

// T/R periods (fst4_decode.f90). D1 = our pre-decimation; it divides ndown,
// so nfft1/D1 is the length of the baseband FFT and nfft2 = nfft1/ndown.
export const FST4W_PERIODS = {
  120:  { nsps: 8200,   ndown: 205,  nfft1: 7200 * 200,  D1: 5,  calfac: 390 },
  300:  { nsps: 21504,  ndown: 512,  nfft1: 7020 * 512,  D1: 16, calfac: 340 },
  900:  { nsps: 66560,  ndown: 1664, nfft1: 6480 * 1664, D1: 16, calfac: 320 },
  1800: { nsps: 134400, ndown: 3360, nfft1: 6426 * 3360, D1: 16, calfac: 320 },
};

const NN = 160, N = 240, K = 74, M = N - K;
const SYNC1 = [0, 1, 3, 2, 1, 0, 2, 3];
const SYNC2 = [2, 3, 1, 0, 3, 2, 0, 1];
const GRAYMAP = [0, 1, 3, 2];
const HMOD = 1;

// ── CRC-24 (get_crc24.f90) ──────────────────────────────────────────────────
const CRC_P = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1];
/** CRC-24 of bits mc[0..len) (0/1), as the Fortran: 0 means the CRC checks. */
export function crc24(mc, len) {
  const r = new Uint8Array(25);
  for (let i = 0; i < 25; i++) r[i] = mc[i];
  for (let i = 0; i <= len - 25; i++) {
    r[24] = mc[i + 24];
    const r0 = r[0];
    if (r0) for (let j = 0; j < 25; j++) r[j] ^= CRC_P[j];
    // cshift(r,1): rotate left by one
    const first = r[0];
    for (let j = 0; j < 24; j++) r[j] = r[j + 1];
    r[24] = first;
  }
  let n = 0;
  for (let j = 0; j < 24; j++) n = n * 2 + r[j];
  return n;
}

// ── LDPC(240,74) encoder (encode240_74.f90) ─────────────────────────────────
let _gen = null;   // M rows × K, Uint8
function _genMatrix() {
  if (_gen) return _gen;
  _gen = [];
  for (let i = 0; i < M; i++) {
    const row = new Uint8Array(K);
    for (let j = 0; j < 19; j++) {
      const v = parseInt(G[i][j], 16);
      const ibmax = j === 18 ? 2 : 4;
      for (let jj = 1; jj <= ibmax; jj++) if (v & (1 << (4 - jj))) row[j * 4 + jj - 1] = 1;
    }
    _gen.push(row);
  }
  return _gen;
}
export function encode240_74(msg74) {
  const gen = _genMatrix();
  const cw = new Uint8Array(N);
  for (let i = 0; i < K; i++) cw[i] = msg74[i];
  for (let i = 0; i < M; i++) {
    let s = 0;
    const row = gen[i];
    for (let j = 0; j < K; j++) s += msg74[j] & row[j];
    cw[K + i] = s & 1;
  }
  return cw;
}

/** 74 message+CRC bits → 160 channel tones (genfst4 / get_fst4_tones_from_bits). */
export function fst4wTones(msg74) {
  const cw = encode240_74(msg74);
  const itmp = new Int32Array(120);
  for (let i = 0; i < 120; i++) {
    const is = cw[2 * i + 1] + 2 * cw[2 * i];
    itmp[i] = is <= 1 ? is : is === 2 ? 3 : 2;
  }
  const t = new Int32Array(NN);
  t.set(SYNC1, 0); t.set(itmp.subarray(0, 30), 8);
  t.set(SYNC2, 38); t.set(itmp.subarray(30, 60), 46);
  t.set(SYNC1, 76); t.set(itmp.subarray(60, 90), 84);
  t.set(SYNC2, 114); t.set(itmp.subarray(90, 120), 122);
  t.set(SYNC1, 152);
  return t;
}

/** 50 message bits → 74 bits with the CRC-24 appended (genfst4, iwspr=1). */
export function fst4wAddCrc(bits50) {
  const m = new Uint8Array(K);
  for (let i = 0; i < 50; i++) m[i] = bits50[i];
  const c = crc24(m, K);
  for (let i = 0; i < 24; i++) m[50 + i] = (c >> (23 - i)) & 1;
  return m;
}

// ── message packing (type 0.6 of packjt77; the unpacking is lib/pack77.js) ──
export { HashTable, ihashcall } from './lib/pack77.js';

/** "CALL GRID4 DBM" → the 50 message bits of a WSPR type-1 FST4W message (test encoder). */
export function packWsprType1(call, grid, dbm) {
  const n28 = pack28(call);
  const g = grid.toUpperCase();
  const igrid4 = (((g.charCodeAt(0) - 65) * 18 + (g.charCodeAt(1) - 65)) * 10 + (g.charCodeAt(2) - 48)) * 10 + (g.charCodeAt(3) - 48);
  const idbm = Math.round(dbm * 3 / 10);
  const bits = new Uint8Array(50);
  const put = (v, from, len) => { for (let i = 0; i < len; i++) bits[from + i] = Math.floor(v / 2 ** (len - 1 - i)) % 2; };
  put(n28, 0, 28); put(igrid4, 28, 15); put(idbm, 43, 5);
  return bits;
}

/** The 50 message bits (type 0.6) → { msg, call, grid, dbm } or null. */
export function unpackFst4w(bits, hash = new HashTable()) {
  return unpackWspr50(bits, hash);
}

// ── LDPC decoding: BP (decode240_74) + fast OSD (fastosd240_74) ─────────────
function platanh(x) {
  const sign = x < 0 ? -1 : 1, z = Math.abs(x);
  if (z <= 0.664) return x / 0.83;
  if (z <= 0.9217) return sign * (z - 0.4064) / 0.322;
  if (z <= 0.9951) return sign * (z - 0.8378) / 0.0524;
  if (z <= 0.9998) return sign * (z - 0.9914) / 0.0012;
  return sign * 7.0;
}

function crcOk(cw) { return crc24(cw, K) === 0; }

// OSD generator for a given Keff (built as fastosd240_74 does), cached.
const _osdGen = new Map();
function _osdGenerator(k) {
  let g = _osdGen.get(k);
  if (g) return g;
  g = [];
  for (let i = 0; i < k; i++) {
    const m = new Uint8Array(K);
    m[i] = 1;
    if (i < 50) {
      const c = crc24(m, K);
      for (let j = 0; j < 24; j++) m[50 + j] = (c >> (23 - j)) & 1;
      for (let j = 50; j < k; j++) m[j] = 0;
    }
    g.push(encode240_74(m));
  }
  _osdGen.set(k, g);
  return g;
}

function fastosd(llr, k, ndeep) {
  const gen = _osdGenerator(k);
  const absllr = llr.map(Math.abs);
  const indx = Array.from({ length: N }, (_, i) => i).sort((a, b) => absllr[a] - absllr[b]);
  let best = null;
  for (let ibasis = 1; ibasis <= 2; ibasis++) {
    // genmrb: k rows × N columns, columns ordered by reliability (most first)
    let indices = new Int32Array(N);
    for (let i = 0; i < N; i++) indices[i] = indx[N - 1 - i];
    const rows = gen.map((r) => { const o = new Uint8Array(N); for (let i = 0; i < N; i++) o[i] = r[indices[i]]; return o; });
    if (ibasis === 2) {
      const nswap = 20;
      for (let i = k - nswap; i < k; i++) {
        for (const r of rows) { const t = r[i]; r[i] = r[i + nswap]; r[i + nswap] = t; }
        const t = indices[i]; indices[i] = indices[i + nswap]; indices[i + nswap] = t;
      }
    }
    // Gaussian elimination with column skipping
    const indices2 = new Int32Array(N);
    let icol = 0, nskipped = 0;
    for (let id = 0; id < k; id++) {
      for (;;) {
        if (icol >= N) break;
        if (rows[id][icol] !== 1) {
          let found = -1;
          for (let j = id + 1; j < k; j++) if (rows[j][icol] === 1) { found = j; break; }
          if (found < 0) { indices2[k + nskipped] = icol; nskipped++; icol++; continue; }
          const t = rows[id]; rows[id] = rows[found]; rows[found] = t;
        }
        break;
      }
      indices2[id] = icol;
      for (let j = 0; j < k; j++) {
        if (j !== id && rows[j][icol] === 1) { const a = rows[id], b = rows[j]; for (let c = 0; c < N; c++) b[c] ^= a[c]; }
      }
      icol++;
    }
    for (let i = k + nskipped; i < N; i++) indices2[i] = i;
    const g2 = rows.map((r) => { const o = new Uint8Array(N); for (let i = 0; i < N; i++) o[i] = r[indices2[i]]; return o; });
    const idx = new Int32Array(N);
    for (let i = 0; i < N; i++) idx[i] = indices[indices2[i]];
    indices = idx;

    const hdec = new Uint8Array(N), absrx = new Float64Array(N);
    for (let i = 0; i < N; i++) { hdec[i] = llr[indices[i]] >= 0 ? 1 : 0; absrx[i] = absllr[indices[i]]; }
    // bitset rows (8 × 32 bits = 240 bits) for fast re-encoding
    const W = 8;
    const g2w = g2.map((r) => { const w = new Uint32Array(W); for (let j = 0; j < N; j++) if (r[j]) w[j >> 5] |= 1 << (j & 31); return w; });
    const hw = new Uint32Array(W);
    for (let j = 0; j < N; j++) if (hdec[j]) hw[j >> 5] |= 1 << (j & 31);
    const c0w = new Uint32Array(W);
    for (let i = 0; i < k; i++) if (hdec[i]) { const r = g2w[i]; for (let q = 0; q < W; q++) c0w[q] ^= r[q]; }
    const dist = (cw) => {   // weighted and hard distance of a codeword (bitset) to hdec
      let dd = 0, nh = 0;
      for (let q = 0; q < W; q++) {
        let x = (cw[q] ^ hw[q]) >>> 0;
        while (x) { const t = x & -x; const j = (q << 5) + (31 - Math.clz32(t)); dd += absrx[j]; nh++; x ^= t; }
      }
      return [dd, nh];
    };
    // 32-bit partial syndromes (rows k-1 .. k+30 of each generator row)
    const np = 32;
    const psyn = new Uint32Array(k);
    for (let i = 0; i < k; i++) { let v = 0; for (let b = 0; b < np; b++) v = (v << 1) | g2[i][k - 1 + b]; psyn[i] = v >>> 0; }
    let hsyn = 0;
    for (let b = 0; b < np; b++) hsyn = (hsyn << 1) | hdec[k - 1 + b];
    hsyn >>>= 0;

    let [dmin, nhardmin] = dist(c0w);
    let cwBest = c0w;
    let sp0 = 0;
    for (let i = 0; i < k; i++) if (hdec[i]) sp0 ^= psyn[i];
    sp0 >>>= 0;

    if (ndeep > 0) {
      const nd = Math.min(ndeep, 4);
      const nord = Math.min(nd, 3), xlambda = nd === 3 ? 4.0 : nd === 4 ? 3.4 : 0.0;
      const nsyndmax = nd === 3 ? 11 : nd === 4 ? 12 : np;
      let s1 = 0, s2 = 0;
      for (let i = 0; i < k; i++) s1 += absrx[i];
      for (let i = k; i < N; i++) s2 += absrx[i];
      const rho = s1 / (s1 + xlambda * s2);
      let rhodmin = rho * dmin;
      const ce = new Uint32Array(W);
      // One error pattern (positions a<b<c): same test as the Fortran loop.
      const tryPat = (d1, sp, a, b, c) => {
        if (d1 > rhodmin) return false;          // ends this order
        let x = (sp ^ hsyn) >>> 0, nw = 0;
        while (x) { x &= x - 1; nw++; }
        if (nw <= nsyndmax) {
          ce.set(c0w);
          for (const p of [a, b, c]) if (p >= 0) { const r = g2w[p]; for (let q = 0; q < W; q++) ce[q] ^= r[q]; }
          const [dd, nh] = dist(ce);
          if (dd < dmin) { dmin = dd; rhodmin = rho * dmin; cwBest = Uint32Array.from(ce); nhardmin = nh; }
        }
        return true;
      };
      // Patterns in nextpat74's order: the lowest set position runs down
      // from the end, and for each the rest follow the same rule above it.
      // The first pattern whose reliability sum exceeds rho·dmin ends the order.
      if (nord >= 1) {
        for (let a = k - 1; a >= 0; a--) if (!tryPat(absrx[a], sp0 ^ psyn[a], a, -1, -1)) break;
      }
      if (nord >= 2) {
        outer2: for (let a = k - 2; a >= 0; a--) {
          for (let b = k - 1; b > a; b--) if (!tryPat(absrx[a] + absrx[b], sp0 ^ psyn[a] ^ psyn[b], a, b, -1)) break outer2;
        }
      }
      if (nord >= 3) {
        outer3: for (let a = k - 3; a >= 0; a--) {
          for (let b = k - 2; b > a; b--) {
            for (let c = k - 1; c > b; c--) if (!tryPat(absrx[a] + absrx[b] + absrx[c], sp0 ^ psyn[a] ^ psyn[b] ^ psyn[c], a, b, c)) break outer3;
          }
        }
      }
    }
    const cw = new Uint8Array(N);
    for (let j = 0; j < N; j++) cw[j] = (cwBest[j >> 5] >>> (j & 31)) & 1;
    const out = new Uint8Array(N);
    for (let i = 0; i < N; i++) out[indices[i]] = cw[i];
    if (crcOk(out)) return { cw: out, nhardmin };
    best = { cw: out, nhardmin: -nhardmin };
  }
  return best;
}

/**
 * decode240_74 (no a-priori bits). Returns { msg74, cw, nharderror, ntype }
 * or null when nothing passed the CRC.
 */
export function decode240_74(llr, Keff = 66, maxosd = 2, norder = 3) {
  const maxiter = Keff === 50 ? 1 : 30;
  const nosd = Math.min(maxosd, 3);
  const zsave = [];
  const tov = new Float64Array(3 * N);
  const toc = new Float64Array(5 * M);
  const tanhtoc = new Float64Array(5 * M);
  const zn = new Float64Array(N), zsum = new Float64Array(N);
  const cw = new Uint8Array(N);
  let ncnt = 0, nclast = 0;
  const finish = (c, ntype) => {
    let nh = 0;
    for (let i = 0; i < N; i++) if ((llr[i] >= 0 ? 1 : 0) !== c[i]) nh++;
    return { msg74: c.slice(0, K), cw: c, nharderror: nh, ntype };
  };
  for (let j = 0; j < M; j++) for (let i = 0; i < NRW[j]; i++) toc[5 * j + i] = llr[NM[5 * j + i] - 1];
  for (let iter = 0; iter <= maxiter; iter++) {
    for (let i = 0; i < N; i++) {
      zn[i] = llr[i] + tov[3 * i] + tov[3 * i + 1] + tov[3 * i + 2];
      zsum[i] += zn[i];
    }
    if (iter > 0 && iter <= nosd) zsave[iter - 1] = Float64Array.from(zsum);
    for (let i = 0; i < N; i++) cw[i] = zn[i] > 0 ? 1 : 0;
    let ncheck = 0;
    for (let j = 0; j < M; j++) {
      let s = 0;
      for (let i = 0; i < NRW[j]; i++) s += cw[NM[5 * j + i] - 1];
      if (s & 1) ncheck++;
    }
    if (ncheck === 0 && crcOk(cw)) return finish(Uint8Array.from(cw), 1);
    if (iter > 0) {
      const nd = ncheck - nclast;
      if (nd < 0) ncnt = 0; else ncnt++;
      if (ncnt >= 5 && iter >= 10 && ncheck > 15) break;
    }
    nclast = ncheck;
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < NRW[j]; i++) {
        const ibj = NM[5 * j + i] - 1;
        let t = zn[ibj];
        for (let kk = 0; kk < 3; kk++) if (MN[3 * ibj + kk] - 1 === j) t -= tov[3 * ibj + kk];
        toc[5 * j + i] = t;
      }
      for (let i = 0; i < 5; i++) tanhtoc[5 * j + i] = Math.tanh(-toc[5 * j + i] / 2);
    }
    for (let jb = 0; jb < N; jb++) {
      for (let i = 0; i < 3; i++) {
        const ichk = MN[3 * jb + i] - 1;
        let tmn = 1;
        for (let q = 0; q < NRW[ichk]; q++) if (NM[5 * ichk + q] - 1 !== jb) tmn *= tanhtoc[5 * ichk + q];
        tov[3 * jb + i] = 2 * platanh(-tmn);
      }
    }
  }
  for (let i = 0; i < nosd && i < zsave.length; i++) {
    const r = fastosd(zsave[i], Keff, norder);
    if (r && r.nhardmin > 0) return finish(r.cw, 2 + i);
  }
  return null;
}

// ── demodulation helpers (fst4_decode.f90) ──────────────────────────────────
function pctile(arr, npct) {
  const t = Float64Array.from(arr).sort();
  let j = Math.round(t.length * 0.01 * npct);
  j = Math.min(Math.max(j, 1), t.length);
  return t[j - 1];
}

/** fst4_baseline: lower-envelope quadratic fit of s (dB), over [ia, ib]. */
function baseline(s, ia, ib, npct) {
  const sbase = new Float64Array(s.length).fill(1);
  const nseg = 8, nlen = Math.floor((ib - ia + 1) / nseg), i0 = Math.floor((ib - ia + 1) / 2);
  if (nlen < 2) return sbase;
  const sw = new Float64Array(s.length);
  for (let i = ia; i <= ib; i++) sw[i] = 10 * Math.log10(Math.max(s[i], 1e-30));
  const xs = [], ys = [];
  for (let n = 0; n < nseg; n++) {
    const ja = ia + n * nlen, jb = ja + nlen - 1;
    const base = pctile(sw.subarray(ja, jb + 1), npct);
    for (let i = ja; i <= jb; i++) if (sw[i] <= base && xs.length < 1000) { xs.push(i - i0); ys.push(sw[i]); }
  }
  // least-squares quadratic (polyfit, nterms=3, equal weights)
  const S = new Float64Array(5), T = new Float64Array(3);
  for (let q = 0; q < xs.length; q++) {
    let p = 1;
    for (let e = 0; e < 5; e++) { S[e] += p; if (e < 3) T[e] += p * ys[q]; p *= xs[q]; }
  }
  const a = solve3([[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]], [T[0], T[1], T[2]]);
  for (let i = ia; i <= ib; i++) {
    const t = i - i0;
    sbase[i] = Math.pow(10, (a[0] + t * (a[1] + t * a[2]) + 0.2) / 10);
  }
  return sbase;
}
function solve3(A, b) {
  const m = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    if (Math.abs(m[c][c]) < 1e-300) return [0, 0, 0];
    for (let r = 0; r < 3; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let q = c; q < 4; q++) m[r][q] -= f * m[c][q]; }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

function normalizebmet(b) {
  const n = b.length;
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) { s += b[i]; s2 += b[i] * b[i]; }
  const av = s / n, av2 = s2 / n, v = av2 - av * av;
  const sig = v > 0 ? Math.sqrt(v) : Math.sqrt(av2);
  if (sig > 0) for (let i = 0; i < n; i++) b[i] /= sig;
}

// popcount-free bit tables for the metric maxima
function _bitMax(s2, nbits, out, base) {
  // out[base + ib] = max(s2 | bit (nbits-1-ib) = 1) − max(s2 | bit = 0)
  const n = 1 << nbits;
  const m1 = new Float64Array(nbits).fill(-Infinity), m0 = new Float64Array(nbits).fill(-Infinity);
  for (let v = 0; v < n; v++) {
    const x = s2[v];
    for (let b = 0; b < nbits; b++) {
      if (v & (1 << b)) { if (x > m1[b]) m1[b] = x; } else if (x > m0[b]) m0[b] = x;
    }
  }
  for (let ib = 0; ib < nbits; ib++) {
    const b = nbits - 1 - ib;
    if (base + ib < 2 * NN) out[base + ib] = m1[b] - m0[b];
  }
}

/**
 * get_fst4_bitmetrics: cframe (160·nss complex) → 4 blocks of 320 bit
 * metrics, s4 tone powers; null when the sync is bad.
 */
function bitmetrics(cr, ci, nss) {
  const csr = new Float64Array(4 * NN), csi = new Float64Array(4 * NN);
  const s4 = new Float64Array(4 * NN);
  // ideal tone waveforms
  const wr = [], wi = [];
  for (let t = 0; t < 4; t++) {
    const dp = (t - 1.5) * 2 * Math.PI / nss;
    const r = new Float64Array(nss), im = new Float64Array(nss);
    let phi = 0;
    for (let j = 0; j < nss; j++) { r[j] = Math.cos(phi); im[j] = Math.sin(phi); phi = (phi + dp) % (2 * Math.PI); }
    wr.push(r); wi.push(im);
  }
  for (let k = 0; k < NN; k++) {
    const i1 = k * nss;
    for (let t = 0; t < 4; t++) {
      let ar = 0, ai = 0;
      const r = wr[t], im = wi[t];
      for (let j = 0; j < nss; j++) {
        const xr = cr[i1 + j], xi = ci[i1 + j];
        ar += xr * r[j] + xi * im[j];      // x · conj(w)
        ai += xi * r[j] - xr * im[j];
      }
      csr[4 * k + t] = ar; csi[4 * k + t] = ai;
      s4[4 * k + t] = ar * ar + ai * ai;
    }
  }
  const argmax = (k) => { let b = 0; for (let t = 1; t < 4; t++) if (s4[4 * k + t] > s4[4 * k + b]) b = t; return b; };
  let nsync = 0;
  for (let k = 0; k < 8; k++) {
    if (SYNC1[k] === argmax(k)) nsync++;
    if (SYNC2[k] === argmax(k + 38)) nsync++;
    if (SYNC1[k] === argmax(k + 76)) nsync++;
    if (SYNC2[k] === argmax(k + 114)) nsync++;
    if (SYNC1[k] === argmax(k + 152)) nsync++;
  }
  if (nsync < 16) return null;

  const bm = [new Float64Array(2 * NN), new Float64Array(2 * NN), new Float64Array(2 * NN), new Float64Array(2 * NN)];
  const s2 = new Float64Array(65536);
  const c1r = new Float64Array(32), c1i = new Float64Array(32);       // [m*4 + n]
  const c2r = new Float64Array(64), c2i = new Float64Array(64);       // [m*16 + is]
  const c4r = new Float64Array(512), c4i = new Float64Array(512);     // [m*256 + is]
  for (let k = 0; k < NN; k += 8) {
    for (let m = 0; m < 8; m++) {
      for (let n = 0; n < 4; n++) {
        const t = GRAYMAP[n];
        c1r[m * 4 + n] = csr[4 * (k + m) + t]; c1i[m * 4 + n] = csi[4 * (k + m) + t];
        s2[n] = Math.hypot(c1r[m * 4 + n], c1i[m * 4 + n]);
      }
      _bitMax(s2, 2, bm[0], k * 2 + 2 * m);
    }
    for (let m = 0; m < 4; m++) {
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        const is = i * 4 + j, a = (2 * m) * 4 + i, b = (2 * m + 1) * 4 + j;
        const r = c1r[a] - c1r[b], im = c1i[a] - c1i[b];
        c2r[m * 16 + is] = r; c2i[m * 16 + is] = im;
        s2[is] = Math.hypot(r, im);
      }
      _bitMax(s2, 4, bm[1], k * 2 + 4 * m);
    }
    for (let m = 0; m < 2; m++) {
      for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) {
        const is = i * 16 + j, a = (2 * m) * 16 + i, b = (2 * m + 1) * 16 + j;
        const r = c2r[a] + c2r[b], im = c2i[a] + c2i[b];
        c4r[m * 256 + is] = r; c4i[m * 256 + is] = im;
        s2[is] = Math.hypot(r, im);
      }
      _bitMax(s2, 8, bm[2], k * 2 + 8 * m);
    }
    for (let i = 0; i < 256; i++) {
      const ar = c4r[i], ai = c4i[i];
      for (let j = 0; j < 256; j++) {
        const r = ar + c4r[256 + j], im = ai + c4i[256 + j];
        s2[i * 256 + j] = Math.sqrt(r * r + im * im);
      }
    }
    _bitMax(s2, 16, bm[3], k * 2);
  }
  // sync quality from the hard 1-symbol bits
  const pat1 = [0, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0];
  const pat2 = [1, 1, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1];
  let nq = 0;
  for (const [off, pat] of [[0, pat1], [76, pat2], [152, pat1], [228, pat2], [304, pat1]]) {
    for (let i = 0; i < 16; i++) if ((bm[0][off + i] >= 0 ? 1 : 0) === pat[i]) nq++;
  }
  if (nq < 46) return null;
  for (const b of bm) { normalizebmet(b); for (let i = 0; i < b.length; i++) b[i] *= 2.83; }
  return { bm, s4, nsyncQual: nq };
}

/**
 * The pure decoder. re/im: complex baseband at fsI (= 12000/D1) mixed down by
 * fLO, starting at the period start. Returns decodes (strongest first).
 */
export function decodeFst4wBaseband(re, im, fsI, fLO, period, opts = {}) {
  const P = FST4W_PERIODS[period];
  if (!P) throw new Error('FST4W: unsupported period ' + period);
  const hash = opts.hash || new HashTable();
  const nfqso = opts.centerHz ?? 1500, ntol = opts.tolHz ?? 100;
  const jittermax = opts.jittermax ?? 2;
  const t0 = Date.now();
  const { nsps, ndown, D1, calfac } = P;
  const nss = nsps / ndown;
  const fs2 = 12000 / ndown;
  const nspsecDec = Math.round(fs2), nspsecSync = Math.trunc(fs2);
  const baud = 12000 / nsps, sigbw = 4 * baud;
  const nfft2 = Math.trunc(P.nfft1 / ndown), nfft1 = nfft2 * ndown;
  const nfftI = nfft1 / D1, R = ndown / D1;
  const df1 = 12000 / nfft1;
  const loBins = Math.round(fLO / df1);

  // the big FFT of the baseband
  const Xr = new Float64Array(nfftI), Xi = new Float64Array(nfftI);
  const nIn = Math.min(nfftI, re.length);
  for (let i = 0; i < nIn; i++) { Xr[i] = re[i]; Xi[i] = im[i]; }
  fftMixed(Xr, Xi, false);
  const binIdx = (j) => { let k = j - loBins; k %= nfftI; if (k < 0) k += nfftI; return k; };
  const pw = (j) => { const k = binIdx(j); return Xr[k] * Xr[k] + Xi[k] * Xi[k]; };

  // ── get_candidates_fst4 ──
  const nfa = Math.max(100, nfqso - ntol - 100), nfb = Math.min(4800, nfqso + ntol + 100);
  const fa = Math.max(100, Math.round(nfqso + 1.5 * baud - ntol)), fb = Math.min(4800, Math.round(nfqso + 1.5 * baud + ntol));
  const df2 = baud / 2;
  const nd = Math.trunc(df2 / df1), ndh = Math.trunc(nd / 2);
  let ia = Math.round(Math.max(100, fa) / df2), ib = Math.round(Math.min(4800, fb) / df2);
  let ina = Math.round(Math.max(100, nfa) / df2), inb = Math.round(Math.min(4800, nfb) / df2);
  if (ia < ina) ia = ina;
  if (ib > inb) ib = inb;
  const nnw = inb + 8;
  const s = new Float64Array(nnw);
  for (let i = ina; i <= inb; i++) {
    const j0 = Math.round(i * df2 / df1);
    let acc = 0;
    for (let j = j0 - ndh; j <= j0 + ndh; j++) acc += pw(j);
    s[i] = acc;
  }
  ina = Math.max(ina, 1 + 3 * HMOD);
  inb = Math.min(inb, nnw - 3 * HMOD - 1);
  const s2 = new Float64Array(nnw);
  for (let i = ina; i <= inb; i++) s2[i] = s[i - 3 * HMOD] + s[i - HMOD] + s[i + HMOD] + s[i + 3 * HMOD];
  const sbase = baseline(s2, ina + 3 * HMOD, inb - 3 * HMOD, 30);
  for (let i = ina; i <= inb; i++) s2[i] /= sbase[i];
  const xdb = [0.25, 0.5, 0.75, 1.0, 0.75, 0.5, 0.25];
  const cands = [];
  const minsync = 1.2;
  if (ia < 3) ia = 3;
  while (cands.length < 200) {
    let ip = ia;
    for (let i = ia; i <= ib; i++) if (s2[i] > s2[ip]) ip = i;
    const pval = s2[ip];
    if (!(pval >= minsync)) break;
    for (let i = -3; i <= 3; i++) {
      const k = ip + 2 * HMOD * i;
      if (k >= ia && k <= ib) s2[k] = Math.max(0, s2[k] - 0.9 * pval * xdb[i + 3]);
    }
    cands.push({ f0: df2 * ip, pval, base: sbase[ip] });
  }

  // ── fst4_downsample ──
  const c2r = new Float64Array(nfft2), c2i = new Float64Array(nfft2);
  const downsample = (f0) => {
    c2r.fill(0); c2i.fill(0);
    const i0 = Math.round(f0 / df1), ih = Math.round((f0 + 1.3 * sigbw / 2) / df1);
    const nbw = ih - i0 + 1;
    let k = binIdx(i0);
    c2r[0] = Xr[k]; c2i[0] = Xi[k];
    for (let i = 1; i <= nbw; i++) {
      k = binIdx(i0 + i); c2r[i] = Xr[k]; c2i[i] = Xi[k];
      k = binIdx(i0 - i); c2r[nfft2 - i] = Xr[k]; c2i[nfft2 - i] = Xi[k];
    }
    for (let i = 0; i < nfft2; i++) { c2r[i] /= nfft2; c2i[i] /= nfft2; }
    fftMixed(c2r, c2i, true);
  };

  // ── sync_fst4 / fst4_sync_search ──
  const nz = 8 * nss;
  const cs1r = new Float64Array(nz), cs1i = new Float64Array(nz), cs2r = new Float64Array(nz), cs2i = new Float64Array(nz);
  {
    let k = 0, p1 = 0, p2 = 0;
    for (let i = 0; i < 8; i++) {
      const d1 = 2 * Math.PI * HMOD * (SYNC1[i] - 1.5) / nss, d2 = 2 * Math.PI * HMOD * (SYNC2[i] - 1.5) / nss;
      for (let j = 0; j < nss; j++) {
        cs1r[k] = Math.cos(p1); cs1i[k] = Math.sin(p1); cs2r[k] = Math.cos(p2); cs2i[k] = Math.sin(p2);
        p1 = (p1 + d1) % (2 * Math.PI); p2 = (p2 + d2) % (2 * Math.PI); k++;
      }
    }
  }
  const t1r = new Float64Array(nz), t1i = new Float64Array(nz), t2r = new Float64Array(nz), t2i = new Float64Array(nz);
  let f0save = NaN;
  const syncAt = (i0, f0) => {
    if (f0 !== f0save) {
      const dphi = 2 * Math.PI * f0 / fs2;
      let phi = 0;
      for (let i = 0; i < nz; i++) {
        const c = Math.cos(phi), sn = Math.sin(phi);
        t1r[i] = c * cs1r[i] - sn * cs1i[i]; t1i[i] = c * cs1i[i] + sn * cs1r[i];
        t2r[i] = c * cs2r[i] - sn * cs2i[i]; t2i[i] = c * cs2i[i] + sn * cs2r[i];
        phi = (phi + dphi) % (2 * Math.PI);
      }
      f0save = f0;
    }
    const corr = (st, tr, ti) => {
      if (st < 0 || st + nz > nfft2) return 0;
      let ar = 0, ai = 0;
      for (let i = 0; i < nz; i++) {
        const xr = c2r[st + i], xi = c2i[st + i];
        ar += xr * tr[i] + xi * ti[i]; ai += xi * tr[i] - xr * ti[i];
      }
      return Math.hypot(ar, ai) / nz;
    };
    return corr(i0, t1r, t1i) + corr(i0 + 38 * nss, t2r, t2i) + corr(i0 + 76 * nss, t1r, t1i)
      + corr(i0 + 114 * nss, t2r, t2i) + corr(i0 + 152 * nss, t1r, t1i);
  };
  const syncSearch = () => {
    let is0 = Math.trunc(1.5 * nspsecSync), ishw = Math.trunc(1.5 * nspsecSync);
    let sbest = -1e30, fcbest = 0, isbest = 0;
    for (let jf = -12; jf <= 12; jf++) {
      const fc = 0.1 * baud * jf;
      for (let st = Math.max(1, is0 - ishw); st <= is0 + ishw; st += 4 * HMOD) {
        const v = syncAt(st, fc);
        if (v > sbest) { sbest = v; fcbest = fc; isbest = st; }
      }
    }
    const fc1 = fcbest;
    is0 = isbest; ishw = 4 * HMOD;
    sbest = 0;
    for (let jf = -7; jf <= 7; jf++) {
      const fc = fc1 + 0.02 * baud * jf;
      for (let st = Math.max(1, is0 - ishw); st <= is0 + ishw; st += HMOD) {
        const v = syncAt(st, fc);
        if (v > sbest) { sbest = v; fcbest = fc; isbest = st; }
      }
    }
    return { fcbest, isbest, sbest };
  };

  for (const c of cands) {
    downsample(c.f0);
    const r = syncSearch();
    c.fc = c.f0 + r.fcbest;
    c.is = r.isbest;
  }
  // drop duplicates (same frequency and start)
  for (let i = 0; i < cands.length; i++) {
    if (cands[i].fc <= 0) continue;
    for (let j = i + 1; j < cands.length; j++) {
      if (cands[j].fc > 0 && Math.abs(cands[j].fc - cands[i].fc) < 0.1 * baud && Math.abs(cands[j].is - cands[i].is) <= 2) cands[j].fc = -1;
    }
  }
  const list = cands.filter((c) => c.fc > 0);

  const decodes = [], seen = new Set();
  const fr = new Float64Array(NN * nss), fi = new Float64Array(NN * nss);
  for (const c of list) {
    if (opts.budgetMs && Date.now() - t0 > opts.budgetMs) break;
    downsample(c.fc);
    const xdt = (c.is - nspsecDec) / fs2;
    let done = false;
    for (let ij = 0; ij <= jittermax && !done; ij++) {
      const is0 = c.is + (ij === 0 ? 0 : ij === 1 ? 1 : -1);
      const iend = is0 + NN * nss - 1;
      if (is0 < 0 || iend > nfft2 - 1) continue;
      for (let i = 0; i < NN * nss; i++) { fr[i] = c2r[is0 + i]; fi[i] = c2i[is0 + i]; }
      const met = bitmetrics(fr, fi, nss);
      if (!met) continue;
      for (let itry = 0; itry < 4 && !done; itry++) {
        const b = met.bm[itry];
        const llr = new Float64Array(N);
        llr.set(b.subarray(16, 76), 0);
        llr.set(b.subarray(92, 152), 60);
        llr.set(b.subarray(168, 228), 120);
        llr.set(b.subarray(244, 304), 180);
        const d = decode240_74(llr, 66, 2, 3);
        if (!d) continue;
        if (!d.cw.some((x) => x === 1)) continue;
        const u = unpackFst4w(d.msg74.subarray(0, 50), hash);
        if (!u) continue;
        done = true;
        if (seen.has(u.msg)) break;
        seen.add(u.msg);
        const tones = fst4wTones(d.msg74);
        let xsig = 0;
        for (let i = 0; i < NN; i++) xsig += met.s4[4 * i + tones[i]];
        const arg = calfac * xsig / c.base - 1;
        const snr = arg > 0 ? 10 * Math.log10(arg) + 10 * Math.log10(1.46 / 2500) + 10 * Math.log10(8200 / nsps) : -99.9;
        decodes.push({
          ...u, snr: Math.round(snr), dt: Math.round(xdt * 10) / 10,
          audioHz: Math.round((c.fc - 1.5 * baud) * 10) / 10,
          ntype: d.ntype, nharderror: d.nharderror, try: itry + 1,
        });
      }
    }
  }
  decodes.sort((a, b) => b.snr - a.snr);
  return { decodes, candidates: list.length, ms: Date.now() - t0, R };
}

// ── streaming front end + period scheduler ──────────────────────────────────
const PASS_HZ = 280;

export class Fst4wDecoder {
  constructor(options = {}) {
    this._srFn = typeof options.sampleRate === 'function' ? options.sampleRate : (() => Number(options.sampleRate) || 12000);
    this.onDecode = typeof options.onDecode === 'function' ? options.onDecode : null;
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();
    this._period = FST4W_PERIODS[options.period] ? Number(options.period) : 120;
    this._center = Number(options.centerHz) || 1500;
    this._tol = Math.min(150, Number(options.tolHz) || 100);
    this._hash = new HashTable();
    this.reset();
  }

  setPeriod(p) { p = Number(p); if (FST4W_PERIODS[p] && p !== this._period) { this._period = p; this.reset(); } }
  setCenter(hz) { hz = Number(hz); if (hz > 300 && hz < 4500 && hz !== this._center) { this._center = hz; this.reset(); } }
  // ≤ 150 Hz: the search also needs 100 Hz of noise floor either side, and
  // the front end passes ±280 Hz around the centre.
  setTolerance(hz) { hz = Number(hz); if (hz >= 10) this._tol = Math.min(150, hz); }
  get period() { return this._period; }

  reset() {
    const P = FST4W_PERIODS[this._period];
    this._P = P;
    this._fsI = 12000 / P.D1;
    const nfft1 = Math.trunc(P.nfft1 / P.ndown) * P.ndown;
    const df1 = 12000 / nfft1;
    this._fLO = Math.round(this._center / df1) * df1;
    this._sr = 0;           // front end built on the first feed
    this._buf = null;
    this._lastStatus = 0;
    this._last = '';
  }

  _build(sr) {
    this._sr = sr;
    const fsI = this._fsI;
    this._k = Math.max(1, Math.floor(sr / (2 * fsI)));
    const rI = sr / this._k;
    const stop = Math.min(fsI, rI) - PASS_HZ;
    let taps = Math.ceil(5.5 * sr / (stop - PASS_HZ)) | 1;
    taps = Math.min(taps, 2047);
    const fc = (PASS_HZ + stop) / 2 / sr;
    const h = new Float64Array(taps), c = (taps - 1) / 2;
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const n = i - c;
      const x = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1));
      h[i] = x * w; sum += h[i];
    }
    for (let i = 0; i < taps; i++) h[i] /= sum;
    this._h = h; this._taps = taps;
    this._ringR = new Float64Array(2 * taps); this._ringI = new Float64Array(2 * taps);
    this._rpos = 0; this._dec = 0;
    this._loPhase = 0; this._loStep = 2 * Math.PI * this._fLO / sr;
    // intermediate (rate rI) history for the cubic interpolator
    this._yr = [0, 0, 0, 0]; this._yi = [0, 0, 0, 0]; this._ny = 0;
    this._tStep = rI / fsI;   // output spacing in intermediate samples
    this._tNext = 0;          // next output position, relative to y[1]
    this._delay = c / sr;     // FIR group delay (s)
  }

  feed(pcm) {
    if (!pcm || !pcm.length) return;
    const sr = this._srFn() || 12000;
    if (!this._sr || Math.abs(sr - this._sr) > 0.5) this._build(sr);
    if (!this._buf) this._startPeriod(this._now() / 1000 - pcm.length / sr - this._delay);
    const h = this._h, taps = this._taps, k = this._k;
    for (let n = 0; n < pcm.length; n++) {
      const x = pcm[n];
      const r = x * Math.cos(this._loPhase), q = -x * Math.sin(this._loPhase);
      this._loPhase += this._loStep;
      if (this._loPhase > 2 * Math.PI) this._loPhase -= 2 * Math.PI;
      this._ringR[this._rpos] = r; this._ringR[this._rpos + taps] = r;
      this._ringI[this._rpos] = q; this._ringI[this._rpos + taps] = q;
      this._rpos = (this._rpos + 1) % taps;
      if (++this._dec < k) continue;
      this._dec = 0;
      let ar = 0, ai = 0;
      const base = this._rpos;   // oldest sample
      for (let j = 0; j < taps; j++) { ar += h[j] * this._ringR[base + j]; ai += h[j] * this._ringI[base + j]; }
      this._pushIntermediate(ar, ai);
    }
    const t = this._now();
    if (this.onStatus && t - this._lastStatus > 2000) { this._lastStatus = t; this._status(); }
  }

  _pushIntermediate(r, i) {
    const yr = this._yr, yi = this._yi;
    yr[0] = yr[1]; yr[1] = yr[2]; yr[2] = yr[3]; yr[3] = r;
    yi[0] = yi[1]; yi[1] = yi[2]; yi[2] = yi[3]; yi[3] = i;
    if (++this._ny < 4) return;
    // outputs between y[1] and y[2]
    while (this._tNext < 1) {
      const mu = this._tNext;
      const out = (y) => {
        // cubic Lagrange through y0..y3 at 1 + mu
        const a = y[0], b = y[1], c = y[2], d = y[3];
        return b + 0.5 * mu * (c - a + mu * (2 * a - 5 * b + 4 * c - d + mu * (3 * (b - c) + d - a)));
      };
      this._emit(out(yr), out(yi));
      this._tNext += this._tStep;
    }
    this._tNext -= 1;
  }

  _startPeriod(tFirst) {
    const T = this._period;
    const start = Math.floor(tFirst / T) * T;
    const n = Math.round(T * this._fsI);
    this._buf = { start, re: new Float32Array(n), im: new Float32Array(n), pos: Math.max(0, Math.round((tFirst - start) * this._fsI)) };
    this._buf.first = this._buf.pos;
  }

  _emit(r, i) {
    const b = this._buf;
    if (!b) return;
    if (b.pos < b.re.length) { b.re[b.pos] = r; b.im[b.pos] = i; }
    b.pos++;
    if (b.pos >= b.re.length) {
      this._buf = null;
      const T = this._period;
      // next period continues seamlessly from this sample stream
      const nb = { start: b.start + T, re: new Float32Array(b.re.length), im: new Float32Array(b.re.length), pos: 0, first: 0 };
      this._buf = nb;
      this._decode(b);
    }
  }

  /** Decode what is in the buffer now (tests; the scheduler calls _decode at period end). */
  flush() { if (this._buf) { const b = this._buf; this._buf = null; this._decode(b); } }

  _decode(b) {
    const T = this._period;
    const utc = new Date(b.start * 1000).toISOString().slice(11, 16);
    if (b.first > 1.0 * this._fsI) {
      this._last = `${utc} joined ${Math.round(b.first / this._fsI)} s late, skipped`;
      if (this.onStatus) this.onStatus(`${utc} period joined ${Math.round(b.first / this._fsI)} s late — not decoded; next one is complete`, this._progress());
      return;
    }
    if (this.onStatus) this.onStatus(`Decoding the ${utc} UTC period…`, this._progress());
    let res;
    try {
      res = decodeFst4wBaseband(b.re, b.im, this._fsI, this._fLO, T, { centerHz: this._center, tolHz: this._tol, hash: this._hash, budgetMs: 60000 });
    } catch (e) {
      if (this.onStatus) this.onStatus('Decoder error: ' + (e && e.message), this._progress());
      return;
    }
    for (const d of res.decodes) if (this.onDecode) this.onDecode({ ...d, utc, period: T });
    this._last = `${utc}: ${res.decodes.length} decode${res.decodes.length === 1 ? '' : 's'}`;
    if (this.onStatus) this.onStatus(`${utc} UTC: ${res.decodes.length} decode${res.decodes.length === 1 ? '' : 's'} (${res.candidates} candidate${res.candidates === 1 ? '' : 's'}, ${(res.ms / 1000).toFixed(1)} s)`, this._progress(), true);
  }

  _progress() {
    const b = this._buf, T = this._period;
    if (!b) return { recorded: 0, period: T, startsAt: null };
    return { recorded: Math.min(T, b.pos / this._fsI), period: T, startsAt: b.start, late: b.first / this._fsI };
  }

  _status() {
    const p = this._progress();
    if (!p.startsAt && p.startsAt !== 0) return;
    const end = new Date((p.startsAt + p.period) * 1000).toISOString().slice(11, 19);
    this.onStatus(`Recording ${fmtMS(p.recorded)} / ${fmtMS(p.period)} — decode at ${end} UTC${this._last ? ` · last ${this._last}` : ''}`, p);
  }
}

function fmtMS(s) { s = Math.floor(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

export default Fst4wDecoder;
