// krypto500/ale3g.js — 3G ALE (MIL-STD-188-141B Appendix C) receiver, BW0
// ============================================================================
// Every 3G-ALE link-establishment PDU (LE_Call, LE_Handshake, LE_Notification,
// LE_Broadcast, LE_Scanning_Call, time PDUs) travels in Burst Waveform 0:
// 613.33 ms of 8-PSK at 2400 symbols/s on 1800 Hz —
//   256 TLC/AGC guard symbols + 384 preamble symbols (both fixed, Tables C-V,
//   C-VI) + 832 data symbols: 26 payload bits, tail-biting K=7 r=1/2 code
//   (52 bits), 4x13 block interleaver, 4 bits per 16-ary Walsh symbol (16
//   tribits of 0/4, sent 4 times = 64), PN-spread by Table C-IX.
// The receiver correlates the preamble, then for each of the 13 Walsh symbols
// correlates the 16 patterns (non-coherently per 16-chip repeat), turns the
// scores into soft bits, deinterleaves, and decodes the tail-biting code. The
// PDU's CRC (4 or 8 bits) decides whether it is shown.
// BW1-BW4 (traffic management and data) are not decoded.
// ============================================================================

import { Downconverter, SPS, PSK_RE, PSK_IM, viterbiTailBiting, crcBits, bitsToInt } from './common.js';
import { Ring } from './tracker.js';

const PREAMBLE = [
  7,7,7,7, 5,4,3,1, 1,2,0,2, 7,2,2,0, 1,3,4,7, 5,3,7,7, 4,3,1,0, 1,1,5,2,
  1,6,0,0, 4,7,6,2, 2,3,6,0, 5,1,7,6, 1,6,1,7, 6,6,6,1, 7,3,0,4, 7,1,2,2,
  3,3,6,7, 7,1,7,3, 1,5,0,3, 3,4,5,2, 5,2,5,3, 1,7,2,1, 5,7,6,1, 2,5,3,5,
  3,6,2,0, 7,5,6,6, 0,1,4,2, 5,4,1,1, 7,0,0,6, 6,7,5,6, 3,7,4,0, 2,6,3,6,
  4,5,1,0, 0,4,5,5, 4,7,1,5, 1,5,6,7, 3,3,5,2, 2,2,7,2, 3,3,0,4, 1,4,1,3,
  6,0,7,2, 6,1,5,0, 1,4,1,1, 7,0,7,4, 0,2,4,5, 3,0,0,3, 1,2,6,4, 6,5,2,6,
  0,0,7,3, 5,3,4,0, 6,2,7,2, 3,3,7,6, 7,1,0,0, 6,7,3,1, 5,5,0,2, 3,4,2,7,
  7,4,5,2, 1,6,1,0, 4,7,1,6, 1,2,4,0, 3,6,5,4, 5,4,4,6, 1,2,5,1, 3,6,2,7,
  2,6,7,4, 7,3,0,1, 5,0,5,3, 4,5,0,7, 3,2,7,0, 3,2,7,0, 6,1,6,7, 7,1,4,2,
  6,7,7,4, 2,7,2,7, 3,7,6,3, 2,6,5,6, 6,3,6,6, 4,1,0,6, 2,6,4,1, 5,5,4,3,
  3,4,6,3, 5,2,4,1, 1,7,5,3, 7,1,6,5, 4,6,6,2, 3,4,2,3, 3,7,4,1, 4,4,5,4,
  6,1,3,4, 6,1,7,4, 1,3,5,2, 6,5,5,4, 2,1,5,1, 6,1,2,7, 1,4,4,2, 3,4,7,3,
];
const TLC = [
  2,6,1,6, 1,6,3,0, 6,0,1,1, 5,0,0,6, 2,6,2,1, 6,2,3,2, 7,6,4,3, 0,2,3,5,
  2,7,5,1, 5,1,7,6, 1,7,1,5, 4,4,0,7, 2,2,6,2, 2,2,6,3, 3,3,7,7, 3,2,4,5,
  0,7,4,7, 7,7,2,3, 1,6,7,6, 5,7,0,5, 1,0,7,6, 2,4,0,2, 7,5,5,4, 1,5,1,5,
  6,7,3,0, 2,7,6,6, 4,0,7,4, 3,2,2,6, 6,7,4,7, 2,0,2,7, 2,1,5,4, 6,2,3,2,
  1,6,0,7, 1,1,2,6, 2,2,0,2, 2,3,6,7, 1,7,1,7, 1,5,7,7, 2,2,2,0, 4,3,4,2,
  0,6,7,6, 0,5,0,7, 1,7,4,1, 2,3,4,6, 7,2,2,0, 6,4,4,6, 6,4,2,2, 6,5,3,4,
  2,3,5,7, 7,1,0,0, 0,3,1,2, 0,1,6,2, 7,4,4,3, 2,5,4,5, 6,4,2,5, 6,2,2,4,
  7,0,6,2, 3,7,2,5, 4,2,4,1, 5,5,3,6, 1,1,3,2, 7,5,7,0, 7,3,5,0, 0,1,2,0,
];
const PN = [
  0,2,4,3, 3,6,4,5, 7,6,7,0, 5,5,4,3, 5,4,3,7, 0,7,6,2, 6,2,4,6, 7,2,4,7,
  5,5,7,0, 7,3,3,3, 7,3,3,1, 4,2,3,7, 0,2,7,7, 3,5,1,0, 1,4,0,5, 0,0,0,0,
  6,5,0,1, 2,7,6,5, 5,2,7,3, 3,3,2,1, 2,5,6,1, 3,4,2,1, 0,1,2,3, 6,4,7,5,
  2,2,6,2, 7,6,5,2, 4,6,5,4, 7,2,5,1, 0,0,7,7, 3,5,4,2, 1,4,2,7, 0,3,4,0,
  0,0,7,7, 3,5,4,2, 1,4,2,7, 0,3,4,0, 1,0,5,2, 6,0,3,5, 1,0,5,1, 5,2,5,6,
  3,2,3,7, 1,2,2,0, 7,1,3,6, 4,2,6,2, 7,4,3,7, 6,7,2,3, 1,7,4,1, 5,1,5,4,
  7,1,1,2, 3,6,7,7, 6,6,1,2, 2,4,1,7, 7,5,5,4, 7,7,5,0, 7,3,7,5, 7,7,5,0,
  6,6,6,1, 3,4,4,4, 0,3,3,2, 1,4,5,4, 5,3,1,1, 1,2,5,1, 7,1,5,7, 2,0,0,6,
];
// Table C-VIII: 4 coded bits (b3 first fetched) -> 16 tribits (0/4)
const W4 = [[0, 0, 0, 0], [0, 4, 0, 4], [0, 0, 4, 4], [0, 4, 4, 0]];
const WALSH = [];
for (let v = 0; v < 16; v++) {
  const lo = W4[v & 3], hi = v >> 2;                       // b1b0 pick the 4-chip row, b3b2 the block signs
  const signs = [[0, 0, 0, 0], [0, 4, 0, 4], [0, 0, 4, 4], [0, 4, 4, 0]][hi];
  const seq = [];
  for (let blk = 0; blk < 4; blk++) for (const c of lo) seq.push((c + signs[blk]) & 7);
  WALSH.push([...seq, ...seq, ...seq, ...seq]);            // 16 tribits, sent 4 times
}

/** Interleaver of C.5.1.2: returns fetch order as matrix cells, and stuff order. */
function interleaverOrders(R, C, p) {
  const stuff = [], fetch = [];
  let rs = 0, cs = 0;
  for (let s = 0; s < R * C;) {
    stuff.push(rs * C + cs); s++;
    cs = (s % R === 0) ? (cs + p.ics + p.dics) % C : (cs + p.ics) % C;
    rs = (s % C === 0) ? (rs + p.irs + p.dirs) % R : (rs + p.irs) % R;
  }
  let rf = 0, cf = 0;
  for (let f = 0; f < R * C;) {
    fetch.push(rf * C + cf); f++;
    cf = (f % R === 0) ? (cf + p.icf + p.dicf) % C : (cf + p.icf) % C;
    rf = (f % C === 0) ? (rf + p.irf + p.dirf) % R : (rf + p.irf) % R;
  }
  return { stuff, fetch };
}
const BW0_IL = interleaverOrders(4, 13, { irs: 0, ics: 1, dirs: 1, dics: 0, irf: 1, icf: 0, dirf: 0, dicf: 1 });
// fetched bit k sits in the cell stuffed by input bit STUFF_AT[cell]
const STUFF_AT = new Int32Array(52);
BW0_IL.stuff.forEach((cell, i) => { STUFF_AT[cell] = i; });

const CALL_TYPES = ['3G ARQ packet data', 'HF modem circuit', 'Analog voice circuit', 'High-quality circuit', 'Unicast ARQ packet', 'Unicast circuit', 'Multicast circuit', 'Control'];
const COMMANDS = { 0: 'Continue handshake', 1: 'Commence traffic setup', 2: 'Voice traffic', 3: 'Link release', 4: 'Sync check', 6: 'Data', 7: 'Abort handshake' };
const REASONS = ['NO_RESPONSE', 'REJECTED', 'NO_TRAF_CHAN', 'LOW_QUALITY'];
const STATUS = { 0: 'Nominal', 1: 'Time server', 6: 'Commencing EMCON', 7: 'Leaving network' };

/** 26 payload bits -> decoded PDU or null when the CRC fails. */
export function decodePdu(b) {
  const f = (from, n) => bitsToInt(b, from, n);
  const crc = (n, k, poly) => crcBits(b.slice(0, 26 - k), poly, k) === f(26 - k, k);
  const addr = (m, g) => ({ member: m, group: g, text: `${g}.${m}` });
  if (b[0] === 1 && b[1] === 0) {
    if (!crc(22, 4, 0xB)) return null;
    const called = f(2, 6), x = f(8, 3), cm = f(11, 6), cg = f(17, 5);
    if (called === 0x3f) return { type: 'LE_Notification', status: STATUS[x] || `status ${x}`, caller: addr(cm, cg) };
    return { type: 'LE_Call', called: `member ${called} (group ${cg})`, calledMember: called, callType: CALL_TYPES[x], caller: addr(cm, cg) };
  }
  if (!crc(18, 8, 0x9B)) return null;
  if (b[0] === 0 && b[1] === 0) {
    const cmd = f(8, 3), arg = f(11, 7);
    const argText = cmd === 0 || cmd === 7 ? (REASONS[arg] || `reason ${arg}`) : cmd === 4 ? `quality ${arg >> 4}, slot ${arg & 15}` : cmd === 6 ? `data 0x${arg.toString(16)}` : `channel ${arg}`;
    return { type: 'LE_Handshake', linkId: f(2, 6), command: COMMANDS[cmd] || `command ${cmd}`, argument: argText };
  }
  const sub = f(2, 3);
  if (sub === 4) return { type: 'LE_Time_Offset', quality: f(5, 3), offset: (b[8] ? -1 : 1) * f(9, 9) };
  if (sub === 5) return { type: 'LE_Group_Time_Broadcast', serverGroup: f(6, 5), dwell: f(11, 4), slot: f(15, 3) };
  if (sub === 6) return { type: 'LE_Broadcast', countdown: f(5, 3), callType: CALL_TYPES[f(8, 3)], channel: f(11, 7) };
  if (sub === 7) { const a = f(7, 11); return { type: 'LE_Scanning_Call', called: `address ${a} (group ${a >> 6}, member ${a & 63})` }; }
  return { type: 'reserved PDU', bits: b.join('') };
}

const NPRE = 384;
const PRE_REF = PREAMBLE.map((t) => [PSK_RE[t], -PSK_IM[t]]);

export class Ale3gDecoder {
  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function' ? options.sampleRate : (() => Number(options.sampleRate) || 12000);
    this.onMessage = options.onMessage || null;
    this.onStatus = options.onStatus || null;
    this.onMetrics = options.onMetrics || null;
    this._ring = new Ring(15);
    this._dc = new Downconverter({ onSample: (r, i) => this._sample(r, i) });
    this.reset();
  }

  reset() {
    this._dc.reset();
    this._ring.n = 0;
    this._peak = null; this._burst = null;
    this._metric = 0; this._skipUntil = 0;
    this._lastMetricsAt = 0;
    this._bursts = 0; this._good = 0;
  }

  feed(pcm) {
    if (!pcm || !pcm.length) return;
    this._dc.feed(pcm, this._sampleRateFn() || 12000);
    this._maybeMetrics();
  }

  _sample(r, i) {
    const ring = this._ring;
    ring.push(r, i);
    if (this._burst) { this._tryData(); return; }
    const n = ring.n - 1, first = n - SPS * (NPRE - 1);
    if (first < 0 || n < this._skipUntil) return;
    // 12 chunks of 32: non-coherent sum, tolerant to ~±35 Hz
    let sum = 0, e = 0;
    const c = this._c || (this._c = new Float64Array(24));
    for (let j = 0; j < 12; j++) {
      let cr = 0, ci = 0;
      for (let q = 0; q < 32; q++) {
        const s = 32 * j + q, idx = first + SPS * s, xr = ring.r(idx), xi = ring.i(idx), ref = PRE_REF[s];
        cr += xr * ref[0] - xi * ref[1]; ci += xr * ref[1] + xi * ref[0];
        e += xr * xr + xi * xi;
      }
      c[2 * j] = cr; c[2 * j + 1] = ci; sum += Math.hypot(cr, ci);
    }
    const m = sum / Math.sqrt(NPRE * e + 1e-12);
    if (m > this._metric) this._metric = m;
    if (this._peak) {
      if (m > this._peak.m) Object.assign(this._peak, { m, first, c: Float64Array.from(c) });
      if (n - this._peak.at > 16) { const p = this._peak; this._peak = null; this._startBurst(p); }
    } else if (m > 0.4) this._peak = { m, first, at: n, c: Float64Array.from(c) };
  }

  _startBurst(p) {
    const c = p.c;
    let ar = 0, ai = 0;
    for (let j = 0; j < 11; j++) { ar += c[2 * j + 2] * c[2 * j] + c[2 * j + 3] * c[2 * j + 1]; ai += c[2 * j + 3] * c[2 * j] - c[2 * j + 2] * c[2 * j + 1]; }
    const w = Math.atan2(ai, ar) / 32;          // rad per symbol
    let gr = 0, gi = 0;
    for (let j = 0; j < 12; j++) { const ph = -w * (32 * j + 15.5), cs = Math.cos(ph), sn = Math.sin(ph); gr += c[2 * j] * cs - c[2 * j + 1] * sn; gi += c[2 * j] * sn + c[2 * j + 1] * cs; }
    this._burst = { dataFirst: p.first + SPS * NPRE, w, ph0: Math.atan2(gi, gr) + w * NPRE, m: p.m };
    this._bursts++;
  }

  _tryData() {
    const b = this._burst, ring = this._ring;
    if (ring.n <= b.dataFirst + SPS * 832 + 8) return;
    this._burst = null;
    // descrambled, de-rotated data symbols; timing may be off a sample: try ±1
    let best = null;
    for (const dt of [0, -1, 1]) {
      const r = this._demod(b, dt);
      if (!best || r.score > best.score) best = r;
    }
    this._skipUntil = b.dataFirst + SPS * 832;
    if (best.pdu) {
      this._good++;
      const msg = { kind: 'pdu', ...best.pdu, snrDb: best.snrDb, quality: Math.round(best.agreement * 100), time: new Date().toISOString().slice(11, 19) };
      if (this.onMessage) this.onMessage(msg);
    } else if (this.onMessage) {
      this.onMessage({ kind: 'burst', text: `BW0 burst, CRC failed (decode quality ${Math.round(best.agreement * 100)} %)`, time: new Date().toISOString().slice(11, 19) });
    }
  }

  _demod(b, dt) {
    const ring = this._ring, soft = new Float64Array(52);
    let sig = 0, tot = 0;
    for (let blk = 0; blk < 13; blk++) {
      const z = new Float64Array(128);
      for (let i = 0; i < 64; i++) {
        const k = blk * 64 + i, idx = b.dataFirst + dt + SPS * k;
        const ang = -(b.ph0 + b.w * k) - PN[k & 255] * Math.PI / 4, cs = Math.cos(ang), sn = Math.sin(ang);
        const xr = ring.r(idx), xi = ring.i(idx);
        z[2 * i] = xr * cs - xi * sn; z[2 * i + 1] = xr * sn + xi * cs;
      }
      // non-coherent over each 16-chip repeat (phase drift tolerant)
      const met = new Float64Array(16);
      for (let v = 0; v < 16; v++) {
        let s = 0;
        for (let rep = 0; rep < 4; rep++) {
          let cr = 0, ci = 0;
          for (let i = 0; i < 16; i++) { const t = WALSH[v][rep * 16 + i], sg = t ? -1 : 1, q = rep * 16 + i; cr += sg * z[2 * q]; ci += sg * z[2 * q + 1]; }
          s += cr * cr + ci * ci;
        }
        met[v] = s;
      }
      let mx = 0, sm = 0; for (let v = 0; v < 16; v++) { sm += met[v]; if (met[v] > mx) mx = met[v]; }
      sig += mx; tot += sm;
      // soft bits b3 b2 b1 b0 (b3 fetched first), max-log, scaled
      const scale = 1 / (sm / 16 + 1e-12);
      for (let bit = 0; bit < 4; bit++) {
        let m0 = 0, m1 = 0;
        for (let v = 0; v < 16; v++) { if ((v >> (3 - bit)) & 1) m1 = Math.max(m1, met[v]); else m0 = Math.max(m0, met[v]); }
        soft[blk * 4 + bit] = Math.max(-30, Math.min(30, (m0 - m1) * scale * 2));
      }
    }
    // deinterleave: fetched bit k -> coded bit STUFF_AT[fetch cell k]
    const coded = new Float64Array(52);
    for (let k = 0; k < 52; k++) coded[STUFF_AT[BW0_IL.fetch[k]]] = soft[k];
    const { bits, agreement } = viterbiTailBiting(coded);
    const pdu = decodePdu(bits);
    const noise = (tot - sig) / 15 / 13;
    const snrDb = 10 * Math.log10(Math.max(1e-6, (sig / 13 - noise) / Math.max(1e-9, noise)) / 64);
    return { pdu, agreement, score: (pdu ? 2 : 0) + agreement, snrDb };
  }

  _maybeMetrics() {
    const now = Date.now();
    if (now - this._lastMetricsAt < 500) return;
    this._lastMetricsAt = now;
    if (this.onStatus) this.onStatus(this._burst ? 'BW0 burst…' : 'Listening for 3G ALE (BW0) bursts…');
    if (this.onMetrics) this.onMetrics({ receiving: !!this._burst, detect: this._metric, bursts: this._bursts, good: this._good });
    this._metric *= 0.5;
  }
}

export const _ale3gTables = { PREAMBLE, TLC, PN, WALSH, BW0_IL };
export default Ale3gDecoder;
