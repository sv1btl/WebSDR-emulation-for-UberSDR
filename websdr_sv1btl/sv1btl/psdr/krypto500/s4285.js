// krypto500/s4285.js — STANAG 4285 receiver (receive only)
// ============================================================================
// Signal: 8-PSK at 2400 symbols/s on 1800 Hz, 256-symbol frames (106.67 ms):
// 80 sync symbols (2-PSK, the 31-chip sequence of x^5+x^2+1 from 11010),
// then data/probe blocks D32 P16 D32 P16 D32 P16 D32. Data and probes are
// scrambled (mod-8 add) by a 176-symbol sequence from a 9-bit register
// (x^9+x^4+1, all ones at each frame, three shifts per symbol).
// User rates 75…2400 bps coded (K=7 r=1/2, 133/171; 2400 punctured to 2/3;
// 300/150/75 repeat the pairs 2/4/8 times) with a 32-row convolutional
// interleaver (short 0.853 s / long 10.24 s), 1200/2400/3600 bps uncoded.
// Source: METU thesis "Implementation of STANAG 4285 HF modem software"
// (open.metu.edu.tr/handle/11511/14381), which quotes the STANAG.
//
// STANAG 4285 does not announce its rate or interleaver, so after locking to
// the frames this receiver identifies the modulation from the data symbols
// and runs every rate/interleaver that modulation allows in parallel; the
// Viterbi decoder that fits best wins (as Krypto500, Sorcerer and Wavecom
// do it). Where the thesis figures leave a register direction open, the
// receiver tries both and keeps the one that the signal itself confirms
// (sync correlation, probe coherence).
// ============================================================================

import { Downconverter, SPS, PSK_RE, PSK_IM, Viterbi, PayloadSink, printable } from './common.js';
import { Ring, Tracker, nearest, softBits } from './tracker.js';

const FRAME = 256, NSYNC = 80;
const ALL8 = [0, 1, 2, 3, 4, 5, 6, 7];

function syncSeq(variant) {
  // x4..x0 = 1 1 0 1 0; first symbol = x0
  let x = [0, 1, 0, 1, 1];                    // index = x_i
  const out = [];
  for (let i = 0; i < NSYNC; i++) {
    out.push(x[0]);
    const nb = variant ? (x[0] ^ x[3]) : (x[0] ^ x[2]);
    x = [x[1], x[2], x[3], x[4], nb];
  }
  return out.map((b) => (b ? 4 : 0));
}
function scrSeq(variant) {
  let x = new Array(9).fill(1);
  const out = [];
  for (let i = 0; i < 176; i++) {
    out.push(4 * x[2] + 2 * x[1] + x[0]);
    for (let k = 0; k < 3; k++) { const nb = variant ? (x[0] ^ x[5]) : (x[0] ^ x[4]); x = [...x.slice(1), nb]; }
  }
  return out;
}
const SYNC = [syncSeq(0), syncSeq(1)];
const SCR = [scrSeq(0), scrSeq(1)];

// frame position (0..255) -> 'S' sync, 'D' data, 'P' probe; scrambler index
const KIND = new Array(FRAME), DIDX = new Int16Array(FRAME);
(() => {
  for (let i = 0; i < NSYNC; i++) KIND[i] = 'S';
  let p = NSYNC, d = 0;
  for (let blk = 0; blk < 4; blk++) {
    for (let i = 0; i < 32; i++) { KIND[p] = 'D'; DIDX[p] = d++; p++; }
    if (blk < 3) for (let i = 0; i < 16; i++) { KIND[p] = 'P'; DIDX[p] = d++; p++; }
  }
})();

// transcoding (oldest bit first) — thesis tables 2.2-2.4
const LAB = {
  1: [[0, [0]], [4, [1]]],
  2: [[0, [0, 0]], [2, [0, 1]], [6, [1, 0]], [4, [1, 1]]],
  3: [[1, [0, 0, 0]], [0, [0, 0, 1]], [2, [0, 1, 0]], [3, [0, 1, 1]], [6, [1, 0, 0]], [7, [1, 0, 1]], [5, [1, 1, 0]], [4, [1, 1, 1]]],
};

// candidates per modulation: [rate, interleave 'S'|'L'|'', coded, reps, k]
const CANDS = {
  1: [[1200, '', false, 1, 0], [600, 'S', true, 1, 1], [600, 'L', true, 1, 12], [300, 'S', true, 2, 1], [300, 'L', true, 2, 12],
    [150, 'S', true, 4, 1], [150, 'L', true, 4, 12], [75, 'S', true, 8, 1], [75, 'L', true, 8, 12]],
  2: [[2400, '', false, 1, 0], [1200, 'S', true, 1, 2], [1200, 'L', true, 1, 24]],
  3: [[3600, '', false, 1, 0], [2400, 'S', true, 1, 4], [2400, 'L', true, 1, 48]],
};
// data/probe index (0..175) -> frame position, and the index lists
const PROBE_POS = new Int16Array(176), PROBE_K = [], DATA_K = [];
for (let p = 0; p < FRAME; p++) if (KIND[p] !== 'S') { PROBE_POS[DIDX[p]] = p; (KIND[p] === 'P' ? PROBE_K : DATA_K).push(DIDX[p]); }
const PUNCT_ROWS = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17, 18, 20, 21, 22, 24, 25, 26, 28, 29, 30];
const INV9 = 25;   // 9 * 25 = 225 = 1 (mod 32)

/** Streaming convolutional deinterleaver: channel soft values in, coded order out. */
class Deinterleaver {
  constructor(k, punctured) {
    this.k = k; this.punct = punctured;
    this.cycle = 0; this.pos = 0;
    this.buf = new Map();           // coded index -> soft
    this.next = 0;                  // next coded index to emit
    this.out = [];
  }
  push(v) {
    const r = this.punct ? PUNCT_ROWS[this.pos] : this.pos;
    const cin = this.cycle - r * this.k;
    if (cin >= 0) this.buf.set(32 * cin + ((INV9 * r) & 31), v);
    this.pos++;
    if (this.pos === (this.punct ? 24 : 32)) { this.pos = 0; this.cycle++; this._emit(); }
  }
  _emit() {
    // coded bit n is complete once cycle > floor(n/32) + row(n)*k
    for (;;) {
      const n = this.next, row = (9 * n) & 31;
      if (Math.floor(n / 32) + row * this.k >= this.cycle) break;
      let v = this.buf.get(n);
      if (v === undefined) v = 0;      // punctured (or before the start)
      this.buf.delete(n);
      this.out.push(v);
      this.next++;
    }
  }
}

// decoy: a fixed pseudo-random shuffle of 1024 soft values — what a code fit
// looks like for data that is not a code sequence, at this SNR
const SHUF = (() => { const p = Array.from({ length: 1024 }, (_, i) => i); let s = 12345; for (let i = 1023; i > 0; i--) { s = (s * 1103515245 + 12345) >>> 0; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]]; } return p; })();

class Candidate {
  constructor([rate, il, coded, reps, k], bps, onBits, decoy = false) {
    this.decoy = decoy; this.shufBuf = [];
    this.rate = rate; this.il = il; this.coded = coded; this.reps = reps;
    this.name = `${rate} bps ${coded ? (il === 'L' ? 'long' : 'short') + ' interleave' : 'uncoded'}`;
    this.onBits = onBits;
    this.held = [];
    this.fit = 0; this.fitN = 0;
    if (coded) {
      this.di = new Deinterleaver(k, bps === 3);
      this.vit = new Viterbi({ onBit: (b) => this._bit(b) });
      this.pend = [];
      this.cOnes = 0; this.cBits = 0; this.rawDen = 0;
    }
  }
  push(v) {
    if (!this.coded) { this._bit(v < 0 ? 1 : 0); return; }
    if (this.decoy) {
      this.shufBuf.push(v);
      if (this.shufBuf.length < 1024) return;
      const b = this.shufBuf; this.shufBuf = [];
      for (let i = 0; i < 1024; i++) this._pushDi(b[SHUF[i]]);
      return;
    }
    this._pushDi(v);
  }
  _pushDi(v) {
    this.di.push(v);
    const o = this.di.out;
    if (o.length) {
      for (const x of o) this.pend.push(x);
      o.length = 0;
      const per = 2 * this.reps;
      while (this.pend.length >= per) {
        let a = 0, b = 0;
        for (let q = 0; q < this.reps; q++) { a += this.pend[2 * q]; b += this.pend[2 * q + 1]; }
        this.vit.push(a, b);
        // the fit is measured against the raw (uncombined) copies: copies
        // that disagree are not a repetition code, and must cost
        for (let q = 0; q < per; q++) this.rawDen += Math.abs(this.pend[q]);
        this.pend.splice(0, per);
        if (a || b) { this.cOnes += (a < 0) + (b < 0); this.cBits += 2; }
      }
      // constant input (zero fill, idle) fits every code: only chunks with
      // balanced bits count towards the fit
      if (this.rawDen > 400) {
        const f = this.vit._fitNum / this.rawDen, p = this.cBits ? this.cOnes / this.cBits : 0;
        this.vit.takeFit(); this.rawDen = 0;
        if (p > 0.25 && p < 0.75) { this.fit = this.fitN ? 0.7 * this.fit + 0.3 * f : f; this.fitN++; }
        this.cOnes = 0; this.cBits = 0;
      }
    }
  }
  _bit(b) { if (this.onBits) this.onBits(b); else if (this.held.length < 200000) this.held.push(b); }
}

export class S4285Decoder {
  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function' ? options.sampleRate : (() => Number(options.sampleRate) || 12000);
    this.onMessage = options.onMessage || null;
    this.onStatus = options.onStatus || null;
    this.onMetrics = options.onMetrics || null;
    this._ring = new Ring(17);
    this._dc = new Downconverter({ onSample: (r, i) => this._sample(r, i) });
    // conjugate sync references for both register variants
    this._sref = SYNC.map((s) => s.map((t) => [PSK_RE[t], -PSK_IM[t]]));
    this.reset();
  }

  reset() {
    this._dc.reset();
    this._ring.n = 0;
    this._state = 'search';
    this._peak = null;
    this._rx = null;
    this._metric = 0;
    this._lastMetricsAt = 0;
    this._text = ''; this._lastTextAt = 0;
    this._skipUntil = 0;
  }

  feed(pcm) {
    if (!pcm || !pcm.length) return;
    this._dc.feed(pcm, this._sampleRateFn() || 12000);
    this._maybeMetrics();
  }

  _sample(r, i) {
    this._ring.push(r, i);
    if (this._state === 'search') this._search();
    else if (this._state === 'confirm') this._confirm();
    else if (this._state === 'run') this._run();
  }

  /** chunked (4 x 20) non-coherent correlation of the sync at `first`. */
  _corr(first, v) {
    const ring = this._ring, ref = this._sref[v];
    let sum = 0, e = 0;
    const c = [];
    for (let j = 0; j < 4; j++) {
      let cr = 0, ci = 0;
      for (let i = 0; i < 20; i++) {
        const s = 20 * j + i, idx = first + SPS * s, xr = ring.r(idx), xi = ring.i(idx);
        cr += xr * ref[s][0] - xi * ref[s][1]; ci += xr * ref[s][1] + xi * ref[s][0];
        e += xr * xr + xi * xi;
      }
      c.push(cr, ci); sum += Math.hypot(cr, ci);
    }
    return { m: sum / Math.sqrt(NSYNC * e + 1e-12), c };
  }

  _search() {
    const n = this._ring.n - 1, first = n - SPS * (NSYNC - 1);
    if (first < 0 || n < this._skipUntil) return;
    for (let v = 0; v < 2; v++) {
      const { m, c } = this._corr(first, v);
      if (m > this._metric) this._metric = m;
      if (this._peak) {
        if (this._peak.v === v && m > this._peak.m) Object.assign(this._peak, { m, c, first });
      } else if (m > 0.5) this._peak = { m, c, first, v, at: n };
    }
    // the sync repeats every 31 symbols: look a full period past the first crossing
    if (this._peak && n - this._peak.at > SPS * 40) { this._cand = this._peak; this._peak = null; this._state = 'confirm'; }
  }

  /** The next sync, one frame later, must correlate too. */
  _confirm() {
    const p = this._cand, next = p.first + SPS * FRAME;
    if (this._ring.n <= next + SPS * NSYNC + 8) return;
    let best = { m: 0 };
    for (let d = -2; d <= 2; d++) { const r = this._corr(next + d, p.v); if (r.m > best.m) best = { ...r, d }; }
    if (best.m < 0.4) { this._state = 'search'; this._skipUntil = p.first + SPS * 40; return; }
    // carrier offset from the phase advance across one frame, refined by chunks
    const c = p.c, c2 = best.c;
    let ar = 0, ai = 0;
    for (let j = 0; j < 4; j++) { ar += c2[2 * j] * c[2 * j] + c2[2 * j + 1] * c[2 * j + 1]; ai += c2[2 * j + 1] * c[2 * j] - c2[2 * j] * c[2 * j + 1]; }
    let w0 = 0;
    { let br = 0, bi = 0; for (let j = 0; j < 3; j++) { br += c[2 * j + 2] * c[2 * j] + c[2 * j + 3] * c[2 * j + 1]; bi += c[2 * j + 3] * c[2 * j] - c[2 * j + 2] * c[2 * j + 1]; } w0 = Math.atan2(bi, br) / 20; }
    // resolve the 2pi ambiguity of the frame-to-frame phase with the coarse w0
    const dFrame = Math.atan2(ai, ar);
    const kk = Math.round((w0 * FRAME - dFrame) / (2 * Math.PI));
    const w = (dFrame + 2 * Math.PI * kk) / FRAME;
    let gr = 0, gi = 0;
    for (let j = 0; j < 4; j++) { const ph = -w * (20 * j + 9.5), cs = Math.cos(ph), sn = Math.sin(ph); gr += c[2 * j] * cs - c[2 * j + 1] * sn; gi += c[2 * j] * sn + c[2 * j + 1] * cs; }
    gr /= NSYNC; gi /= NSYNC;
    this._startRx(p.first, w, gr, gi, p.v);
  }

  _startRx(first, w, gr, gi, sv) {
    const tr = new Tracker(this._ring, first, w / (2 * Math.PI) * 2400, Math.atan2(gi, gr), gr, gi);
    tr.timingGain = 0.15;
    this._rx = {
      tr, sv, scrV: 0, scrScore: [0, 0], frame: 0, pos: 0,
      mod: 0, zs: null, pts: null, bal: 0.5, cur: null, pending: [], sps1: 1,
      cands: null, chosen: null, sink: null, badRun: 0, frames: 0,
      dataZ: [],
    };
    this._state = 'run';
    this._text = '';
    this._emit({ kind: 'start', mode: 'STANAG 4285 — identifying rate…' });
  }

  _run() {
    const rx = this._rx, tr = rx.tr;
    while (tr.ready()) {
      const pos = tr.k % FRAME, kind = KIND[pos];
      // at each frame start: re-time on the 80 sync symbols (clock offset)
      if (pos === 0 && tr.k > 0 && rx.timedAt !== tr.k) {
        if (this._ring.n <= tr.t0 + (tr.k + NSYNC) * tr.sps + 8) return;
        rx.timedAt = tr.k;
        tr.syncTiming(tr.k, SYNC[rx.sv]);
      }
      if (pos === 0 && !rx.dataZ && rx.frames >= 3 && (!rx.cur || rx.cur.k0 !== tr.k)) {
        rx.cur = { k0: tr.k, p0: tr.t0 + tr.k * tr.sps, sps: tr.sps, dfe: [], dfeErr: 0, nP: 0 };
      }
      if (kind === 'S') {
        tr.step(SYNC[rx.sv][pos], null, 0.03);
      } else {
        const di = DIDX[pos];
        if (kind === 'P') {
          // probes = scrambled zeros; the scrambler variant is chosen by them
          if (rx.frames < 3) {
            // measure both variants without letting the wrong one train
            // non-coherent per 16-symbol probe block, so it does not depend
            // on the carrier loop holding phase at low SNR
            const o = tr.step(-1, (zr, zi) => nearest(zr, zi, ALL8, 0), 0);
            if (!rx.pb) rx.pb = new Float64Array(4);
            for (let v = 0; v < 2; v++) { const a = SCR[v][di] * Math.PI / 4, cs = Math.cos(a), sn = Math.sin(a); rx.pb[2 * v] += o.yr * cs + o.yi * sn; rx.pb[2 * v + 1] += o.yi * cs - o.yr * sn; }
            if (KIND[pos + 1] !== 'P') { for (let v = 0; v < 2; v++) rx.scrScore[v] += Math.hypot(rx.pb[2 * v], rx.pb[2 * v + 1]); rx.pb.fill(0); }
          } else {
            const o = tr.step(SCR[rx.scrV][di], null, 0.03);
            if (rx.cur) { rx.cur.dfeErr += o.err; rx.cur.nP++; }
          }
        } else {
          const scr = SCR[rx.scrV][di];
          // until the rate is settled, decisions over all 8 points and no
          // adaptation on data (sync + probes train the equaliser)
          const allowed = rx.chosen ? LAB[rx.mod].map((x) => x[0]) : ALL8;
          const o = tr.step(-1, (zr, zi) => nearest(zr, zi, allowed, rx.chosen ? scr : 0), rx.chosen ? 0.012 : 0.0);
          // until the modulation is known: keep the raw symbol and its index
          if (rx.dataZ) rx.dataZ.push(o.yr, o.yi, di);
          else if (rx.cur) {
            const a = -scr * Math.PI / 4, cs = Math.cos(a), sn = Math.sin(a);
            rx.cur.dfe.push(o.yr * cs - o.yi * sn, o.yr * sn + o.yi * cs);
          }
        }
      }
      if (pos === FRAME - 1) {
        if (rx.cur && rx.cur.k0 === tr.k - FRAME) { rx.pending.push(rx.cur); rx.cur = null; }   // step() already advanced k
        this._frameEnd();
      }
      if (!this._rx) return;
      this._pendingFrames();
      if (!this._rx) return;
    }
    this._pendingFrames();
  }

  /** interpolated baseband sample at a fractional ring index */
  _rd(x) {
    const ring = this._ring, i = Math.floor(x), f = x - i;
    return [ring.r(i) * (1 - f) + ring.r(i + 1) * f, ring.i(i) * (1 - f) + ring.i(i + 1) * f];
  }

  /** complex gain of the sync at p (and its normalised correlation) */
  _syncGain(p, sv) {
    let cr = 0, ci = 0, e = 0;
    const sy = SYNC[sv];
    for (let s = 0; s < NSYNC; s++) {
      const [xr, xi] = this._rd(p + SPS * s * this._rx.sps1);
      const sg = sy[s] ? -1 : 1;
      cr += sg * xr; ci += sg * xi; e += xr * xr + xi * xi;
    }
    return { gr: cr / NSYNC, gi: ci / NSYNC, m: Math.hypot(cr, ci) / Math.sqrt(NSYNC * e + 1e-12) };
  }

  /**
   * Second demodulator, per frame: one-tap channel estimates on the sync
   * and on the three probe blocks, interpolated across the frame. It rides
   * fast fading that the adaptive equaliser cannot follow (found on a real
   * French Navy 600L signal); the equaliser keeps the multipath cases. Each
   * frame uses whichever has the smaller error on its known symbols.
   */
  _pendingFrames() {
    const rx = this._rx;
    while (rx && rx.pending.length) {
      const fr = rx.pending[0];
      const sps = fr.sps; rx.sps1 = sps / SPS;
      const p1guess = fr.p0 + FRAME * sps;
      if (this._ring.n <= p1guess + (NSYNC + 4) * sps + 8) return;
      rx.pending.shift();
      // refine both sync positions (±1.5 samples)
      const refine = (p, w) => { let b = { m: -1 }; for (let d = -w; d <= w; d += 0.25) { const g = this._syncGain(p + d, rx.sv); if (g.m > b.m) b = { ...g, p: p + d }; } return b; };
      // the anchored path keeps its own frame timing (carried from frame to
      // frame); a faded sync is searched for more widely
      const stepA = rx.aStep || sps;
      const start = rx.aNext !== undefined ? rx.aNext : fr.p0;
      let g0 = refine(start, 1);
      if (g0.m < 0.3) { const w = refine(start, 12); if (w.m > g0.m + 0.1) g0 = w; }
      const g1 = refine(g0.p + FRAME * stepA, 1.5);
      rx.aNext = g0.m > 0.3 && g1.m > 0.3 ? g1.p : g0.p + FRAME * stepA;
      const meas = (g1.p - g0.p) / FRAME;
      if (g0.m > 0.35 && g1.m > 0.35 && Math.abs(meas - SPS) < 0.03) rx.aStep = 0.9 * stepA + 0.1 * meas;
      rx.syncM = 0.7 * (rx.syncM ?? g0.m) + 0.3 * g0.m;
      if (rx.syncM < 0.2) { this._finish('signal lost'); return; }
      const a0 = Math.atan2(g0.gi, g0.gr), A0 = Math.hypot(g0.gr, g0.gi) || 1e-9;
      let dphi = Math.atan2(g1.gi, g1.gr) - a0;
      const fo = rx.foA ?? rx.tr.foHz;
      const expect = 2 * Math.PI * fo * FRAME / 2400;
      dphi += 2 * Math.PI * Math.round((expect - dphi) / (2 * Math.PI));
      rx.foA = 0.8 * fo + 0.2 * dphi / (2 * Math.PI) * 2400 / FRAME;
      const step = (g1.p - g0.p) / FRAME;
      const zAt = (fp) => {
        const [xr, xi] = this._rd(g0.p + fp * step);
        const ph = -(a0 + dphi * (fp - 40) / FRAME), c = Math.cos(ph), sn = Math.sin(ph);
        return [(xr * c - xi * sn) / A0, (xr * sn + xi * c) / A0];
      };
      // anchors: sync (40), the probe blocks, next sync (296)
      const anchors = [[40, 1, 0]];
      for (const [start, centre] of [[32, 119.5], [80, 167.5], [128, 215.5]]) {
        let cr = 0, ci = 0;
        for (let k = start; k < start + 16; k++) {
          const fp = PROBE_POS[k], [zr, zi] = zAt(fp), t = SCR[rx.scrV][k] * Math.PI / 4;
          cr += zr * Math.cos(t) + zi * Math.sin(t); ci += zi * Math.cos(t) - zr * Math.sin(t);
        }
        anchors.push([centre, cr / 16, ci / 16]);
      }
      anchors.push([296, Math.hypot(g1.gr, g1.gi) / A0, 0]);
      const gainAt = (fp) => {
        let j = 0; while (j + 2 < anchors.length && anchors[j + 1][0] < fp) j++;
        const [x0, r0, i0] = anchors[j], [x1, r1, i1] = anchors[j + 1], w = (fp - x0) / (x1 - x0);
        return [r0 + (r1 - r0) * w, i0 + (i1 - i0) * w];
      };
      const eq = (fp, k) => {
        const [zr, zi] = zAt(fp), [gr, gi] = gainAt(fp), g2 = gr * gr + gi * gi || 1e-9;
        const er = (zr * gr + zi * gi) / g2, ei = (zi * gr - zr * gi) / g2;
        const t = -SCR[rx.scrV][k] * Math.PI / 4, c = Math.cos(t), sn = Math.sin(t);
        return [er * c - ei * sn, er * sn + ei * c];
      };
      // error of each path on the probes (the anchored one is measured on
      // the probes it was fitted to: a real 600L channel needed it that way)
      let eA = 0;
      for (const k of PROBE_K) { const [zr, zi] = eq(PROBE_POS[k], k); eA += (zr - 1) ** 2 + zi * zi; }
      eA /= PROBE_K.length;
      const eD = fr.nP ? fr.dfeErr / fr.nP : 9;
      const useA = eA < eD;
      rx.pathA = (rx.pathA || 0) + (useA ? 1 : 0); rx.pathN = (rx.pathN || 0) + 1;
      let n = 0;
      for (const k of DATA_K) {
        let zr, zi;
        if (useA) [zr, zi] = eq(PROBE_POS[k], k);
        else { zr = fr.dfe[2 * n]; zi = fr.dfe[2 * n + 1]; }
        n++;
        if (zr === undefined) continue;
        this._data(zr, zi, false, useA ? eA : eD);
      }
    }
  }

  _frameEnd() {
    const rx = this._rx;
    rx.frames++;
    if (rx.frames === 3) rx.scrV = rx.scrScore[1] > rx.scrScore[0] ? 1 : 0;
    if (rx.frames >= 6 && !rx.chosen) {
      if (rx.dataZ) this._descrambleEarly();
      const m = this._classify();
      // re-evaluated every frame until a rate is chosen (a transmission
      // opens with the interleaver's zero fill, which looks like 2-PSK);
      // on a change every symbol so far is replayed into new candidates
      // downgrades only early (a start-up misjudgement); later a run of fill
      // or idle would look like a lower order
      if (m && m !== rx.mod && (m > rx.mod || rx.frames < 40)) { this._setMod(m); rx.modAt = rx.frames; }
      if (rx.cands) this._maybeChoose();
    }
  }

  _descrambleEarly() {
    const rx = this._rx, raw = rx.dataZ;
    rx.dataZ = null;
    for (let i = 0; i < raw.length; i += 3) {
      const t = -SCR[rx.scrV][raw[i + 2]] * Math.PI / 4, cs = Math.cos(t), sn = Math.sin(t);
      this._store(raw[i] * cs - raw[i + 1] * sn, raw[i] * sn + raw[i + 1] * cs);
    }
  }

  /** keep a descrambled data symbol (for replays) and count its phase point */
  _store(zr, zi) {
    const rx = this._rx;
    if (!rx.zs) { rx.zs = []; rx.pts = new Float64Array(8); }
    if (rx.zs.length < 2400 * 2 * 40) rx.zs.push(zr, zi);
    // per-symbol log-likelihood under 2-, 4- and 8-PSK (uniform over the
    // points), noise from the known symbols; averaged over ~1.5 s
    if (rx.frames < 4) return;               // the loops are still settling
    const P = rx.pts, g = 1 / 2000, s2 = Math.max(0.01, rx.tr.errKnown);
    for (let m = 1; m <= 3; m++) {
      const pts = LAB[m];
      let acc = 0;
      for (const [t] of pts) acc += Math.exp(-((zr - PSK_RE[t]) ** 2 + (zi - PSK_IM[t]) ** 2) / s2);
      const ll = Math.log(acc / pts.length + 1e-300);
      P[m - 1] += g * (Math.max(-50, ll) - P[m - 1]);
    }
    P[6]++; P[7] += g * (1 - P[7]);        // P[7]: EMA warm-up correction
    // which 8-PSK point each symbol is nearest to (used when the noise is low)
    if (!rx.occ) rx.occ = new Float64Array(8);
    const r = ((Math.round(Math.atan2(zi, zr) / (Math.PI / 4)) % 8) + 8) % 8;
    for (let q = 0; q < 8; q++) rx.occ[q] *= 0.9995;
    rx.occ[r] += 1;
  }

  _classify() {
    // the constellation that explains the symbols best (ties go to the
    // lower order: an interleaver filling with zeros uses one point only)
    const P = this._rx.pts;
    if (!P || P[6] < 600) return 0;
    const l = [0, P[0] / P[7], P[1] / P[7], P[2] / P[7]];
    let best = 1;
    for (let m = 2; m <= 3; m++) if (l[m] > l[best] + 0.05) best = m;
    // a quiet channel shows the points directly: symbols on the 90°/270°
    // points (or the odd ones) mean a higher order, however rarely the data
    // uses them (ASCII under async framing favours some dibits)
    const o = this._rx.occ, nk = this._rx.tr.errKnown;
    if (o && nk < 0.15) {
      const tot = o.reduce((x, y) => x + y, 0) || 1, odd = (o[1] + o[3] + o[5] + o[7]) / tot, q26 = (o[2] + o[6]) / tot;
      if (odd > 0.2 && best < 3) best = 3;
      else if (q26 > 0.12 && best < 2) best = 2;
    }
    // hysteresis: stay with the current choice unless clearly beaten
    const cur = this._rx.mod;
    if (cur && best !== cur && l[best] < l[cur] + 0.15) return cur;
    return best;
  }

  _setMod(m) {
    const rx = this._rx;
    rx.mod = m;
    rx.modName = ['', '2-PSK', '4-PSK', '8-PSK'][m];
    rx.cands = CANDS[m].map((c) => new Candidate(c, m, null));
    rx.decoy = new Candidate(CANDS[m].find((c) => c[2] && c[1] === 'S'), m, null, true);
    rx.bal = 0.5; rx.balN = 0;
    const z = rx.zs;
    for (let i = 0; i < z.length; i += 2) this._data(z[i], z[i + 1], true);
    this._emit({ kind: 'info', text: `${rx.modName} data, trying ${rx.cands.length} rate/interleaver settings` });
  }

  _data(zr, zi, replay = false, noise = null) {
    const rx = this._rx, nb = rx.mod;
    if (!replay && !rx.chosen) this._store(zr, zi);
    if (!nb) return;
    const soft = this._soft || (this._soft = new Float64Array(3));
    softBits(zr, zi, LAB[nb], nb, noise ?? rx.tr.errKnown, soft, 0);
    for (let k = 0; k < nb; k++) {
      if (rx.chosen) rx.chosen.push(soft[k]);
      else {
        rx.bal += 0.002 * ((soft[k] < 0 ? 1 : 0) - rx.bal);
        for (const c of rx.cands) c.push(soft[k]);
        if (rx.decoy) rx.decoy.push(soft[k]);
      }
    }
  }

  _maybeChoose() {
    const rx = this._rx;
    const symsSec = (rx.frames * FRAME) / 2400;
    // wait while the channel bits are mostly constant (an interleaver still
    // filling with zeros) and for the modulation to settle
    if (rx.bal < 0.3 || rx.bal > 0.7 || rx.frames - rx.modAt < 10) return;
    const coded = rx.cands.filter((c) => c.coded && c.fitN >= 5).sort((x, y) => y.fit - x.fit);
    const best = coded[0], second = coded[1];
    const margin = best && second ? best.fit - second.fit : 1;
    // a short-interleave winner waits for its long-interleave sibling (it
    // only produces output after ~10 s), unless it is beyond doubt
    const sib = best && best.il === 'S' ? rx.cands.find((c) => c.rate === best.rate && c.il === 'L') : null;
    const sibWait = sib && sib.fitN < 5 && symsSec < 14 && best.fit < 0.95;
    // and it must clearly beat the decoy (non-code data fitting the code)
    const dec = rx.decoy && rx.decoy.fitN >= 3 ? rx.decoy.fit : null;
    // (a punctured rate-2/3 code fits random data closely: smaller margin)
    const aboveDecoy = best && dec !== null && best.fit - dec > (rx.mod === 3 ? 0.025 : 0.06);
    if (best && best.fit > 0.85 && margin > 0.03 && best.fitN >= 8 && aboveDecoy && !sibWait) this._choose(best);
    else if (symsSec > 14 && (!best || !aboveDecoy || best.fit < 0.85)) this._choose(rx.cands.find((c) => !c.coded));
  }

  _choose(c) {
    const rx = this._rx;
    rx.chosen = c;
    rx.sink = new PayloadSink((ev) => this._payload(ev));
    this._emit({ kind: 'info', text: `${c.name} (${rx.modName})${c.coded ? `, Viterbi fit ${(c.fit * 100).toFixed(0)} %` : ''}` });
    this._emit({ kind: 'mode', mode: `STANAG 4285 ${c.name}` });
    for (const b of c.held) rx.sink.push(b);
    c.held = [];
    c.onBits = (b) => rx.sink.push(b);
    rx.cands = null;
  }

  _payload(ev) {
    if (ev.format) { this._emit({ kind: 'info', text: 'payload: ' + ev.format }); return; }
    if (ev.eom) { this._emit({ kind: 'info', text: 'end-of-message pattern' }); return; }
    if (ev.ch !== undefined) this._text += printable(ev.ch);
    else if (ev.hex !== undefined) this._text += ev.hex.toString(16).padStart(2, '0') + ' ';
    if (this._text.length > 120) this._flushText();
  }

  _flushText() {
    if (!this._text) return;
    this._emit({ kind: 'text', text: this._text });
    this._text = ''; this._lastTextAt = Date.now();
  }

  _finish(reason) {
    const rx = this._rx;
    if (rx && rx.chosen && rx.chosen.vit) rx.chosen.vit.flush();
    this._flushText();
    this._emit({ kind: 'end', reason, mode: rx && rx.chosen ? `STANAG 4285 ${rx.chosen.name}` : 'STANAG 4285' });
    this._rx = null;
    this._state = 'search';
    this._skipUntil = this._ring.n + SPS * 40;
  }

  _emit(msg) { msg.time = new Date().toISOString().slice(11, 19); if (this.onMessage) this.onMessage(msg); }
  _status(t) { if (t !== this._st) { this._st = t; if (this.onStatus) this.onStatus(t); } }

  _maybeMetrics() {
    const now = Date.now();
    if (now - this._lastMetricsAt < 500) return;
    this._lastMetricsAt = now;
    const rx = this._rx;
    this._status(!rx ? 'Searching for STANAG 4285 frames…' : rx.chosen ? `Receiving ${rx.chosen.name}` : rx.mod ? `Locked, ${rx.modName}: identifying the rate…` : 'Locked to frames: reading the constellation…');
    if (rx && this._text && now - this._lastTextAt > 1500) this._flushText();
    if (this.onMetrics) this.onMetrics({
      receiving: !!rx, mode: rx && rx.chosen ? rx.chosen.name : rx ? rx.modName || '' : '',
      snrDb: rx ? rx.tr.snrDb : null, offsetHz: rx ? rx.tr.foHz : null, detect: this._metric,
      cands: rx && rx.cands ? rx.cands.filter((c) => c.coded).map((c) => [c.name, Math.round(c.fit * 100)]).concat(rx.decoy && rx.decoy.fitN ? [['decoy', Math.round(rx.decoy.fit * 100)]] : []) : null,
    });
    this._metric *= 0.5;
  }
}

export const _s4285Tables = { SYNC, SCR, KIND, DIDX, LAB, PUNCT_ROWS, FRAME, CANDS, Candidate };
export default S4285Decoder;
