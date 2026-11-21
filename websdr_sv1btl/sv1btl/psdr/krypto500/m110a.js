// krypto500/m110a.js — MIL-STD-188-110A serial-tone (single-tone) receiver
// ============================================================================
// Receive only, fixed-frequency operation, 75 … 4800 bps, zero/short/long
// interleave (MIL-STD-188-110B §5.3.2, unchanged since 110A). Tables and the
// readings of the ambiguous figures follow the MIT-licensed reference
// implementation github.com/Willt125/MIL-STD-188-110 (validated there against
// real 188-110A recordings): data scrambler x^12+x^6+x^4+x+1 from 0xBAD,
// count symbols by the text rule (not Table XII), D1/D2 in the last two probes
// of every interleaver block, payload bits LSB first.
//
// Signal: 8-PSK, 2400 symbols/s, 1800 Hz. A preamble of 3 (zero/short) or 24
// (long) 200 ms segments: channel symbols 0 1 3 0 1 3 1 2 0 D1 D2 C1 C2 C3 0,
// each spread to 32 tribits; D1/D2 name the rate and interleaver, C the
// segments still to come. Then frames of unknown data and known probes.
//
// The receiver: correlate the 288 fixed preamble tribits, read D1/D2/count,
// train the equaliser on the rest of the preamble, then demodulate, soft
// demap, deinterleave, Viterbi-decode and show the payload (async 8N1 text if
// it is there, else hex). EOM ends the message.
// ============================================================================

import { Downconverter, SPS, PSK_RE, PSK_IM, Viterbi, PayloadSink, printable } from './common.js';
import { Ring, Tracker, nearest, softBits } from './tracker.js';

// ── tables (MIL-STD-188-110B §5.3.2.3) ───────────────────────────────────
const SYNC_SCR = '74305150221157435026216200505266'.split('').map(Number);
const XIII = [
  [0, 0, 0, 0, 0, 0, 0, 0], [0, 4, 0, 4, 0, 4, 0, 4], [0, 0, 4, 4, 0, 0, 4, 4], [0, 4, 4, 0, 0, 4, 4, 0],
  [0, 0, 0, 0, 4, 4, 4, 4], [0, 4, 0, 4, 4, 0, 4, 0], [0, 0, 4, 4, 4, 4, 0, 0], [0, 4, 4, 0, 4, 0, 0, 4],
].map((p) => [...p, ...p, ...p, ...p]);                 // 32 tribits each
const PREFIX = [0, 1, 3, 0, 1, 3, 1, 2, 0];
const X_NORMAL = [[0, 0, 0, 0], [0, 4, 0, 4], [0, 0, 4, 4], [0, 4, 4, 0]].map((p) => Array(8).fill(p).flat());
const X_EXCEPT = [[0, 0, 0, 0, 4, 4, 4, 4], [0, 4, 0, 4, 4, 0, 4, 0], [0, 0, 4, 4, 4, 4, 0, 0], [0, 4, 4, 0, 4, 0, 0, 4]].map((p) => Array(4).fill(p).flat());

// data scrambler: 12-bit Galois register, 8 shifts per symbol, period 160
const DATA_SCR = (() => {
  const out = new Uint8Array(160);
  let s = 0xBAD;
  const FB = (1 << 0) | (1 << 1) | (1 << 4) | (1 << 6);
  for (let i = 0; i < 160; i++) {
    for (let k = 0; k < 8; k++) { const leave = (s >> 11) & 1; s = (s << 1) & 0xfff; if (leave) s ^= FB; }
    out[i] = (((s >> 2) & 1) << 2) | (((s >> 1) & 1) << 1) | (s & 1);
  }
  return out;
})();

// D1,D2 -> mode
const MODES = {
  '7,6': { rate: 4800, il: 'S' }, '7,7': { rate: 2400, il: 'S', voice: true },
  '6,4': { rate: 2400, il: 'S' }, '4,4': { rate: 2400, il: 'L' },
  '6,5': { rate: 1200, il: 'S' }, '4,5': { rate: 1200, il: 'L' },
  '6,6': { rate: 600, il: 'S' }, '4,6': { rate: 600, il: 'L' },
  '6,7': { rate: 300, il: 'S' }, '4,7': { rate: 300, il: 'L' },
  '7,4': { rate: 150, il: 'S' }, '5,4': { rate: 150, il: 'L' },
  '7,5': { rate: 75, il: 'S' }, '5,5': { rate: 75, il: 'L' },
};

// channel-symbol labels: allowed (unscrambled) tribit -> bits (first fetched first)
const LABELS = {
  1: [[0, [0]], [4, [1]]],
  2: [[0, [0, 0]], [2, [0, 1]], [4, [1, 1]], [6, [1, 0]]],
  3: [[0, [0, 0, 0]], [1, [0, 0, 1]], [3, [0, 1, 0]], [2, [0, 1, 1]], [7, [1, 0, 0]], [6, [1, 0, 1]], [4, [1, 1, 0]], [5, [1, 1, 1]]],
};
const MGD2_BITS = [[0, 0], [0, 1], [1, 1], [1, 0]];   // MGD value v (0..3) -> bits

function modeParams(d1, d2) {
  const m = MODES[`${d1},${d2}`];
  if (!m) return null;
  const p = { ...m, d1, d2 };
  const r = m.rate;
  p.bps = r === 4800 || r === 2400 ? 3 : r === 1200 ? 2 : r === 75 ? 2 : 1;
  p.U = r >= 2400 ? 32 : r === 75 ? 0 : 20;
  p.Kn = r >= 2400 ? 16 : r === 75 ? 0 : 20;
  p.reps = r === 300 ? 2 : r === 150 ? 4 : 1;
  p.coded = r !== 4800;
  p.blockSyms = m.il === 'L' ? 11520 : 1440;
  if (r !== 75) p.framesPerBlock = p.blockSyms / (p.U + p.Kn);
  if (r === 4800) { p.rows = 0; p.cols = 0; }
  else if (r === 75) { p.rows = m.il === 'L' ? 20 : 10; p.cols = m.il === 'L' ? 36 : 9; p.step = 7; p.dec = 7; p.excPeriod = m.il === 'L' ? 360 : 45; }
  else {
    const cols = { 2400: [576, 72], 1200: [288, 36], 600: [144, 18], 300: [144, 18], 150: [144, 18] }[r];
    p.rows = 40; p.cols = m.il === 'L' ? cols[0] : cols[1]; p.step = 9; p.dec = 17;
  }
  p.name = `${r} bps${m.voice ? ' (digital voice)' : ''}, ${r === 4800 ? 'no' : m.il === 'L' ? 'long' : 'short'} interleave`;
  return p;
}

/** inverse permutation: channel (fetch) index k -> coded (load) index */
function deintPerm(rows, cols, step, dec) {
  const n = rows * cols;
  const inputAtCell = new Int32Array(n);
  for (let k = 0; k < n; k++) { const row = (k * step) % rows, col = Math.floor(k / rows); inputAtCell[row * cols + col] = k; }
  const perm = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const diag = Math.floor(k / rows), row = k % rows;
    const col = (((diag - dec * row) % cols) + cols) % cols;
    perm[k] = inputAtCell[row * cols + col];
  }
  return perm;
}

// fixed 288-tribit preamble prefix, as conjugate reference points
const REF_N = 288;
const REF_RE = new Float64Array(REF_N), REF_IM = new Float64Array(REF_N);
for (let s = 0; s < REF_N; s++) {
  const t = (XIII[PREFIX[s >> 5]][s & 31] + SYNC_SCR[s & 31]) & 7;
  REF_RE[s] = PSK_RE[t]; REF_IM[s] = -PSK_IM[t];
}
const segTribit = (chanSym, i) => (XIII[chanSym][i & 31] + SYNC_SCR[i & 31]) & 7;

export class M110aDecoder {
  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function' ? options.sampleRate : (() => Number(options.sampleRate) || 12000);
    this.onMessage = options.onMessage || null;
    this.onStatus = options.onStatus || null;
    this.onMetrics = options.onMetrics || null;
    this._ring = new Ring(17);
    this._dc = new Downconverter({ onSample: (r, i) => this._sample(r, i) });
    this.reset();
  }

  reset() {
    this._dc.reset();
    this._ring.n = 0;
    this._state = 'search';
    this._peak = null;
    this._eAcc = new Float64Array(REF_N);    // per-symbol energy history for the detector
    this._lastMetricsAt = 0;
    this._metric = 0;
    this._mode = null;
    this._rx = null;
    this._skipUntil = 0;
    this._text = '';
    this._lastTextAt = 0;
  }

  feed(pcm) {
    if (!pcm || !pcm.length) return;
    this._dc.feed(pcm, this._sampleRateFn() || 12000);
    this._maybeMetrics();
  }

  _sample(r, i) {
    const ring = this._ring;
    ring.push(r, i);
    if (this._state === 'search') this._search();
    else if (this._state === 'header') this._readHeader();
    else if (this._state === 'run') this._run();
  }

  // ── acquisition ───────────────────────────────────────────────────────
  _search() {
    const ring = this._ring, n = ring.n - 1;
    const first = n - SPS * (REF_N - 1);
    if (first < 0 || n < this._skipUntil) return;
    // nine 32-tribit chunk correlations
    const c = this._c || (this._c = new Float64Array(18));
    let e = 0, sum = 0;
    for (let j = 0; j < 9; j++) {
      let cr = 0, ci = 0;
      for (let i = 0; i < 32; i++) {
        const s = 32 * j + i, idx = first + SPS * s;
        const xr = ring.r(idx), xi = ring.i(idx);
        cr += xr * REF_RE[s] - xi * REF_IM[s]; ci += xr * REF_IM[s] + xi * REF_RE[s];
        e += xr * xr + xi * xi;
      }
      c[2 * j] = cr; c[2 * j + 1] = ci;
      sum += Math.hypot(cr, ci);
    }
    const metric = sum / Math.sqrt(REF_N * e + 1e-12);
    this._metric = Math.max(this._metric * 0.999, metric);
    if (this._peak) {
      if (metric > this._peak.metric) this._peak = { metric, first, at: this._peak.at, c: Float64Array.from(c) };
      if (n - this._peak.at > 12) { const p = this._peak; this._peak = null; this._acquire(p); }
      return;
    }
    if (metric > 0.45) this._peak = { metric, first, at: n, c: Float64Array.from(c) };
  }

  _acquire(p) {
    const c = p.c;
    let ar = 0, ai = 0;
    for (let j = 0; j < 8; j++) { ar += c[2 * j + 2] * c[2 * j] + c[2 * j + 3] * c[2 * j + 1]; ai += c[2 * j + 3] * c[2 * j] - c[2 * j + 2] * c[2 * j + 1]; }
    const dphi = Math.atan2(ai, ar);                  // per 32 symbols
    const w = dphi / 32;                              // rad per symbol
    let gr = 0, gi = 0;
    for (let j = 0; j < 9; j++) {
      const ph = -w * (32 * j + 15.5), cs = Math.cos(ph), sn = Math.sin(ph);
      gr += c[2 * j] * cs - c[2 * j + 1] * sn; gi += c[2 * j] * sn + c[2 * j + 1] * cs;
    }
    gr /= REF_N; gi /= REF_N;
    this._acq = { first: p.first, w, gr, gi, metric: p.metric };
    this._state = 'header';
  }

  _readHeader() {
    const a = this._acq, ring = this._ring;
    const end = a.first + SPS * (15 * 32) + 8;
    if (ring.n <= end) return;
    // classify slots 9..13 coherently with the acquisition model
    const g = Math.hypot(a.gr, a.gi) || 1, p0 = Math.atan2(a.gi, a.gr);
    const slot = (k) => {
      let best = -1, bv = -Infinity;
      for (let cs = 0; cs < 8; cs++) {
        let v = 0;
        for (let i = 0; i < 32; i++) {
          const s = 32 * k + i, idx = a.first + SPS * s;
          const ph = p0 + a.w * s, t = segTribit(cs, i);
          const ang = ph + t * Math.PI / 4;
          v += ring.r(idx) * Math.cos(ang) + ring.i(idx) * Math.sin(ang);
        }
        if (v > bv) { bv = v; best = cs; }
      }
      return best;
    };
    const d1 = slot(9), d2 = slot(10), c1 = slot(11), c2 = slot(12), c3 = slot(13);
    const mode = modeParams(d1, d2);
    const countOk = c1 >= 4 && c2 >= 4 && c3 >= 4;
    const count = ((c1 & 3) << 4) | ((c2 & 3) << 2) | (c3 & 3);
    if (!mode || !countOk || count > 23 || (mode.il === 'L' ? false : count > 2)) {
      this._state = 'search';
      this._skipUntil = a.first + SPS * 400;
      return;
    }
    this._mode = mode;
    this._startRx(a, mode, count, g);
  }

  _startRx(a, mode, count, g) {
    const tr = new Tracker(this._ring, a.first, a.w / (2 * Math.PI) * 2400, Math.atan2(a.gi, a.gr), a.gr, a.gi);
    const rx = {
      tr, mode,
      preSyms: (count + 1) * 480,           // preamble symbols from this segment on
      seg: { d1: mode.d1, d2: mode.d2, count },
      dataSym: 0, frame: 0, set: 0,
      soft: new Float64Array(mode.rows * mode.cols * (mode.rate === 4800 ? 0 : 1) || 1), softN: 0,
      perm: mode.rows ? deintPerm(mode.rows, mode.cols, mode.step, mode.dec) : null,
      vit: null, vitZero: null, firstBlock: true, useZero: false,
      sink: null, chars: 0, startedAt: Date.now(), badRun: 0,
    };
    rx.sink = new PayloadSink((ev) => this._payload(ev));
    if (mode.coded) {
      // Zero and short interleave share D1/D2: both are decoded over the
      // first block, the better Viterbi fit wins (bits held until then).
      rx.held = { main: [], zero: [] };
      const route = (which) => (b) => {
        if (!rx.firstDone) rx.held[which].push(b);
        else if ((which === 'zero') === rx.useZero) rx.sink.push(b);
      };
      rx.vit = new Viterbi({ onBit: route('main') });
      rx.vit.reset(true);
      if (mode.il === 'S' && mode.rate !== 75) {
        rx.vitZero = new Viterbi({ onBit: route('zero') });
        rx.vitZero.reset(true);
      } else rx.firstDone = true;
    }
    this._rx = rx;
    this._state = 'run';
    this._text = '';
    this._emit({ kind: 'start', mode: mode.name, snrDb: null });
    this._status(`Receiving ${mode.name}`);
  }

  /** Expected preamble tribit for symbol s (counted from the acquired segment). */
  _preTribit(s) {
    const rx = this._rx, segIdx = Math.floor(s / 480), within = s % 480, slot = within >> 5;
    const cnt = rx.seg.count - segIdx;
    let cs;
    if (slot < 9) cs = PREFIX[slot];
    else if (slot === 9) cs = rx.seg.d1;
    else if (slot === 10) cs = rx.seg.d2;
    else if (slot === 11) cs = 4 | ((cnt >> 4) & 3);
    else if (slot === 12) cs = 4 | ((cnt >> 2) & 3);
    else if (slot === 13) cs = 4 | (cnt & 3);
    else cs = 0;
    return segTribit(cs, within & 31);
  }

  // ── demodulation ──────────────────────────────────────────────────────
  _run() {
    const rx = this._rx, tr = rx.tr, m = rx.mode;
    while (tr.ready()) {
      const k = tr.k;
      if (k < rx.preSyms) { tr.step(this._preTribit(k), null, 0.05); continue; }
      if (m.rate === 75) { if (!this._set75()) return; continue; }
      const fl = m.U + m.Kn, pos = rx.dataSym % fl;
      const scr = DATA_SCR[rx.dataSym % 160];
      if (pos < m.U) {
        const allowed = LABELS[m.bps].map((x) => x[0]);
        const o = tr.step(-1, (zr, zi) => nearest(zr, zi, allowed, scr), 0.012);
        // descramble and soft-demap
        const ang = -scr * Math.PI / 4, cs = Math.cos(ang), sn = Math.sin(ang);
        const zr = o.yr * cs - o.yi * sn, zi = o.yr * sn + o.yi * cs;
        if (!m.coded) this._hard4800(zr, zi);
        else {
          softBits(zr, zi, LABELS[m.bps], m.bps, tr.errKnown, rx.soft, rx.softN);
          rx.softN += m.bps;
          if (rx.softN >= rx.soft.length) this._block();
        }
      } else {
        // probe: zeros, or D1/D2 in the last two probes of a block
        const fpb = m.framesPerBlock, f = rx.frame % fpb, i = pos - m.U;
        let t = 0;
        if (i < 16 && (f === fpb - 2 || f === fpb - 1)) t = XIII[f === fpb - 2 ? m.d1 : m.d2][i];
        const o = tr.step((t + scr) & 7, null, 0.03);
        rx.badRun = o.err > 1.0 ? rx.badRun + 1 : Math.max(0, rx.badRun - 2);
        if (pos === fl - 1) rx.frame++;
      }
      rx.dataSym++;
      if (rx.badRun > 400) { this._finish('signal lost'); return; }
      if (rx.sink.eom) { this._finish('end of message'); return; }
      if (rx.dataSym > 2400 * 600) { this._finish('time limit'); return; }
    }
  }

  _hard4800(zr, zi) {
    const rx = this._rx;
    let best = 0, bd = Infinity;
    for (const [t, bits] of LABELS[3]) {
      const d = (zr - PSK_RE[t]) ** 2 + (zi - PSK_IM[t]) ** 2;
      if (d < bd) { bd = d; best = bits; }
    }
    for (const b of best) rx.sink.push(b);
  }

  _set75() {
    const rx = this._rx, tr = rx.tr, m = rx.mode;
    // 32 symbols per set; collect them through the tracker (BPSK decisions
    // drive its carrier loop, adaptation kept slow)
    if (!rx.set75) rx.set75 = { zr: new Float64Array(32), zi: new Float64Array(32), n: 0 };
    const st = rx.set75;
    while (st.n < 32) {
      if (!tr.ready()) return false;
      const scr = DATA_SCR[rx.dataSym % 160];
      const o = tr.step(-1, (zr, zi) => nearest(zr, zi, [0, 4], scr), 0.004);
      const ang = -scr * Math.PI / 4, cs = Math.cos(ang), sn = Math.sin(ang);
      st.zr[st.n] = o.yr * cs - o.yi * sn; st.zi[st.n] = o.yr * sn + o.yi * cs;
      st.n++; rx.dataSym++;
    }
    st.n = 0;
    const exc = (rx.set + 1) % m.excPeriod === 0;
    const pats = exc ? X_EXCEPT : X_NORMAL;
    const met = [0, 0, 0, 0];
    for (let v = 0; v < 4; v++) { let s = 0; for (let i = 0; i < 32; i++) s += pats[v][i] ? -st.zr[i] : st.zr[i]; met[v] = s; }
    rx.set++;
    const sc = 0.5 / Math.max(0.05, tr.errAvg);
    for (let b = 0; b < 2; b++) {
      let m0 = -Infinity, m1 = -Infinity;
      for (let v = 0; v < 4; v++) { if (MGD2_BITS[v][b]) m1 = Math.max(m1, met[v]); else m0 = Math.max(m0, met[v]); }
      rx.soft[rx.softN++] = Math.max(-40, Math.min(40, (m0 - m1) * sc / 4));
    }
    if (rx.softN >= rx.soft.length) this._block();
    if (rx.sink.eom) { this._finish('end of message'); return false; }
    return true;
  }

  /** One interleaver block of soft values is complete. */
  _block() {
    const rx = this._rx, m = rx.mode, n = rx.softN;
    const coded = new Float64Array(n);
    for (let k = 0; k < n; k++) coded[rx.perm[k]] = rx.soft[k];
    const feed = (v, arr) => {
      const r = m.reps;
      for (let i = 0; i + 2 * r <= arr.length; i += 2 * r) {
        let a = 0, b = 0;
        for (let q = 0; q < r; q++) { a += arr[i + 2 * q]; b += arr[i + 2 * q + 1]; }
        v.push(a, b);
      }
    };
    if (rx.firstBlock && rx.vitZero) {
      feed(rx.vit, coded); feed(rx.vitZero, rx.soft.slice(0, n));
      const f1 = rx.vit.takeFit(), f0 = rx.vitZero.takeFit();
      rx.useZero = f0 > f1;
      rx.firstDone = true;
      for (const b of rx.held[rx.useZero ? 'zero' : 'main']) rx.sink.push(b);
      rx.held = null;
      if (rx.useZero) this._emit({ kind: 'info', text: 'zero interleave (0.0 s)' });
    } else if (rx.useZero) feed(rx.vitZero, rx.soft.slice(0, n));
    else feed(rx.vit, coded);
    rx.firstBlock = false;
    rx.softN = 0;
  }

  _payload(ev) {
    if (ev.format) { this._emit({ kind: 'info', text: 'payload: ' + ev.format }); return; }
    if (ev.eom) return;
    if (ev.ch !== undefined) this._text += printable(ev.ch);
    else if (ev.hex !== undefined) this._text += ev.hex.toString(16).padStart(2, '0') + ' ';
    const now = Date.now();
    if (this._text.length > 120 || (this._text && now - this._lastTextAt > 1500)) this._flushText();
  }

  _flushText() {
    if (!this._text) return;
    this._emit({ kind: 'text', text: this._text });
    this._text = ''; this._lastTextAt = Date.now();
  }

  _finish(reason) {
    const rx = this._rx;
    if (rx && rx.vit) {
      if (rx.useZero && rx.vitZero) rx.vitZero.flush(); else rx.vit.flush();
    }
    this._flushText();
    this._emit({ kind: 'end', reason, mode: rx && rx.mode.name });
    this._rx = null; this._mode = null;
    this._state = 'search';
    this._skipUntil = this._ring.n + SPS * 480;
    this._status('Searching for a 188-110A preamble…');
  }

  _emit(msg) {
    msg.time = new Date().toISOString().slice(11, 19);
    if (this.onMessage) this.onMessage(msg);
  }

  _status(t) { if (t !== this._st) { this._st = t; if (this.onStatus) this.onStatus(t); } }

  _maybeMetrics() {
    const now = Date.now();
    if (now - this._lastMetricsAt < 500) return;
    this._lastMetricsAt = now;
    const rx = this._rx;
    if (this._state === 'search') this._status('Searching for a 188-110A preamble…');
    if (this._rx && this._text && now - this._lastTextAt > 1500) this._flushText();
    if (this.onMetrics) this.onMetrics({
      receiving: !!rx, mode: rx ? rx.mode.name : '', snrDb: rx ? rx.tr.snrDb : null,
      offsetHz: rx ? rx.tr.foHz : null, detect: this._metric,
    });
    this._metric *= 0.5;
  }
}

export default M110aDecoder;

// for the offline tests (~/sdr-shots/scripts/k5): the tables a transmitter needs
export const _m110aTables = { DATA_SCR, SYNC_SCR, XIII, PREFIX, X_NORMAL, X_EXCEPT, LABELS, MODES, modeParams, deintPerm };
