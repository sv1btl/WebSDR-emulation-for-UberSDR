// krypto500/arqfsk.js — synchronous ARQ FSK modes: SITOR-A, ARQ-E, ARQ-E3
// ============================================================================
// Receive-only monitors of three utility ARQ systems (one side or both sides
// as heard on the dial):
//   SITOR-A  CCIR 476 / ITU-R M.476: 100 Bd, usually 170 Hz; the ISS sends
//            blocks of 3 characters (210 ms) every 450 ms, the IRS answers
//            with one control character. 7-bit code, 4 B : 3 Y (table as in
//            the NAVTEX/SITOR-B decoder, fsk.js / Kiwi CCIR476.js).
//   ARQ-E    ARQ-1000 duplex: continuous, ITA2-P (sync bit, 5 ITA2 bits, odd
//            parity), every 4th or 8th character inverted; 46…288 Bd.
//   ARQ-E3   CCIR 519 variant: continuous, ITA3 (CCIR 342-2) 7-bit constant
//            ratio code (3 : 4), repetition cycle 4 or 8; 48…200 Bd.
// Code tables: R. Prösch, Technical Handbook for Radio Monitoring (2003),
// ITA2/ITA2P/ITA3 table (bits in transmission order, 1 = mark).
//
// Demodulator: mix the FSK centre to baseband, low-pass, FM discriminator,
// bit clock locked to the transitions; then the 7-bit character phase (and
// polarity, and for ARQ-E the inversion cycle) is found by testing all
// alignments for valid code words.
// ============================================================================

import { lowpassTaps } from './common.js';

// ITA2 letters / figures indexed by the 5 bits read in transmission order
// (first bit = MSB): handbook column "ITA 2".
const ITA2 = {
  '11000': ['A', '-'], '10011': ['B', '?'], '01110': ['C', ':'], '10010': ['D', '$'], '10000': ['E', '3'], '10110': ['F', '!'],
  '01011': ['G', '&'], '00101': ['H', '#'], '01100': ['I', '8'], '11010': ['J', "'"], '11110': ['K', '('], '01001': ['L', ')'],
  '00111': ['M', '.'], '00110': ['N', ','], '00011': ['O', '9'], '01101': ['P', '0'], '11101': ['Q', '1'], '01010': ['R', '4'],
  '10100': ['S', "'"], '00001': ['T', '5'], '11100': ['U', '7'], '01111': ['V', '='], '11001': ['W', '2'], '10111': ['X', '/'],
  '10101': ['Y', '6'], '10001': ['Z', '+'], '00010': ['\r', '\r'], '01000': ['\n', '\n'], '11111': ['LTRS', 'LTRS'], '11011': ['FIGS', 'FIGS'],
  '00100': [' ', ' '], '00000': ['', ''],
};
// ITA3 (CCIR 342-2), same order of characters as the handbook table
const ITA3_LIST = [
  ['0011010', 'A', '-'], ['0011001', 'B', '?'], ['1001100', 'C', ':'], ['0011100', 'D', '$'], ['0111000', 'E', '3'], ['0010011', 'F', '!'],
  ['1100001', 'G', '&'], ['1010010', 'H', '#'], ['1110000', 'I', '8'], ['0100011', 'J', "'"], ['0001011', 'K', '('], ['1100010', 'L', ')'],
  ['1010001', 'M', '.'], ['1010100', 'N', ','], ['1000110', 'O', '9'], ['1001010', 'P', '0'], ['0001101', 'Q', '1'], ['1100100', 'R', '4'],
  ['0101010', 'S', "'"], ['1000101', 'T', '5'], ['0110010', 'U', '7'], ['1001001', 'V', '='], ['0100101', 'W', '2'], ['0010110', 'X', '/'],
  ['0010101', 'Y', '6'], ['0110001', 'Z', '+'], ['1000011', '\r', '\r'], ['1011000', '\n', '\n'], ['0001110', 'LTRS', 'LTRS'], ['0100110', 'FIGS', 'FIGS'],
  ['1101000', ' ', ' '], ['0000111', '', ''], ['0101100', 'α', 'α'], ['0101001', 'β', 'β'], ['0110100', 'RQ', 'RQ'],
];
const ITA3 = new Map(ITA3_LIST.map(([c, l, f]) => [parseInt(c, 2), [l, f]]));
// CCIR 476: Kiwi convention (first bit in bit 0, 4 ones per valid code)
const C476 = new Map([
  [0x17, ['J', "'"]], [0x1B, ['F', '!']], [0x1D, ['C', ':']], [0x1E, ['K', '(']], [0x27, ['W', '2']], [0x2B, ['Y', '6']], [0x2D, ['P', '0']], [0x2E, ['Q', '1']],
  [0x35, ['G', '&']], [0x39, ['M', '.']], [0x3A, ['X', '/']], [0x3C, ['V', ';']], [0x47, ['A', '-']], [0x4B, ['S', "'"]], [0x4D, ['I', '8']], [0x4E, ['U', '7']],
  [0x53, ['D', '$']], [0x55, ['R', '4']], [0x56, ['E', '3']], [0x59, ['N', ',']], [0x5C, [' ', ' ']], [0x63, ['Z', '"']], [0x65, ['L', ')']], [0x69, ['H', '#']],
  [0x6C, ['\n', '\n']], [0x71, ['O', '9']], [0x72, ['B', '?']], [0x74, ['T', '5']], [0x78, ['\r', '\r']],
  [0x5A, ['LTRS', 'LTRS']], [0x36, ['FIGS', 'FIGS']], [0x0F, ['α', 'α']], [0x33, ['β', 'β']], [0x66, ['RQ', 'RQ']], [0x6A, ['', '']],
]);
const weight = (v) => { let n = 0; while (v) { n += v & 1; v >>= 1; } return n; };

export const ARQ_MODES = {
  sitora: { name: 'SITOR-A (CCIR 476 ARQ)', baud: 100, shift: 170, bauds: [100], shifts: [170, 400, 850] },
  arqe: { name: 'ARQ-E (ARQ-1000 duplex)', baud: 96, shift: 400, bauds: [46.2, 48, 50, 64, 72, 85.7, 96, 144, 192, 288], shifts: [170, 400, 850] },
  arqe3: { name: 'ARQ-E3 (CCIR 519)', baud: 96, shift: 400, bauds: [48, 50, 64, 72, 96, 100, 192, 200], shifts: [170, 270, 300, 400, 850] },
};

export class ArqFskDecoder {
  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function' ? options.sampleRate : (() => Number(options.sampleRate) || 12000);
    this.onMessage = options.onMessage || null;
    this.onStatus = options.onStatus || null;
    this.onMetrics = options.onMetrics || null;
    this.mode = options.mode || 'sitora';
    this.center = options.centerHz || 1700;
    this.baud = options.baud || ARQ_MODES[this.mode].baud;
    this.shift = options.shift || ARQ_MODES[this.mode].shift;
    this._fs = 0;
    this.reset();
  }

  setOptions(o) {
    let re = false;
    if (o.mode && o.mode !== this.mode) { this.mode = o.mode; this.baud = ARQ_MODES[o.mode].baud; this.shift = ARQ_MODES[o.mode].shift; re = true; }
    if (o.baud && o.baud !== this.baud) { this.baud = o.baud; re = true; }
    if (o.shift && o.shift !== this.shift) { this.shift = o.shift; re = true; }
    if (o.centerHz && o.centerHz !== this.center) { this.center = o.centerHz; re = true; }
    if (re) this.reset();
  }

  reset() {
    this._fs = 0;
    this._bits = [];           // recent decided bits (for the alignment search)
    this._q = [];              // recent bit qualities
    this._lock = null;         // { phase, inv, cycle, cyc0 } once characters line up
    this._sinceCheck = 0;
    this._shiftState = 0;      // 0 letters, 1 figures
    this._text = ''; this._lastTextAt = 0; this._lastMetricsAt = 0;
    this._chars = 0; this._errors = 0;
    this._burst = []; this._burstQ = [];   // SITOR-A: bits (and their quality) of the current burst
    this._lastCs = null; this._lastBlock = null; this._skipNext = false;
    this._sq = 0;
  }

  _setup(fs) {
    this._fs = fs;
    this._dec = Math.max(1, Math.floor(fs / (this.baud * 12)));
    this._fsd = fs / this._dec;
    const cut = Math.max(120, this.shift / 2 + this.baud * 0.8);
    this._lp = lowpassTaps(cut, fs, Math.min(255, Math.round(4 * fs / cut) | 1));
    this._buf = new Float64Array(this._lp.length * 4); this._bp = 0;
    this._ph = 0; this._di = 0;
    this._pr = 0; this._pi = 0;
    this._spb = this._fsd / this.baud;
    this._t = 0; this._acc = 0; this._accN = 0; this._last = 0;
  }

  feed(pcm) {
    if (!pcm || !pcm.length) return;
    const fs = this._sampleRateFn() || 12000;
    if (fs !== this._fs) this._setup(fs);
    const lp = this._lp, L = lp.length, buf = this._buf, w = 2 * Math.PI * this.center / fs;
    for (let n = 0; n < pcm.length; n++) {
      this._ph += w; if (this._ph > Math.PI) this._ph -= 2 * Math.PI;
      const x = pcm[n], p = this._bp;
      const i = x * Math.cos(this._ph), q = -x * Math.sin(this._ph);
      buf[2 * p] = i; buf[2 * p + 1] = q; buf[2 * (p + L)] = i; buf[2 * (p + L) + 1] = q;
      this._bp = (p + 1) % L;
      if (++this._di < this._dec) continue;
      this._di = 0;
      let r = 0, s = 0;
      const base = this._bp;
      for (let k = 0; k < L; k++) { const c = lp[k]; r += c * buf[2 * (base + k)]; s += c * buf[2 * (base + k) + 1]; }
      // FM discriminator, in units of half the shift (+1 = mark = upper tone)
      const dr = r * this._pr + s * this._pi, di = s * this._pr - r * this._pi;
      this._pr = r; this._pi = s;
      const f = Math.atan2(di, dr) * this._fsd / (2 * Math.PI) / (this.shift / 2);
      const amp = r * r + s * s;
      this._sample(Math.max(-2, Math.min(2, f)), amp);
    }
    this._maybeMetrics();
  }

  /** bit clock: integrate-and-dump, phase pulled to the zero crossings */
  _sample(f, amp) {
    if (this.mode === 'sitora') { this._sitorSample(f, amp); return; }
    this._sq += 0.002 * (amp - this._sq);
    if ((f > 0) !== (this._last > 0)) {
      // a transition should fall on a bit boundary (t = 0)
      let e = this._t; if (e > this._spb / 2) e -= this._spb;
      this._t -= 0.06 * e;
    }
    this._last = f;
    this._acc += f; this._accN++;
    this._t += 1;
    if (this._t >= this._spb) {
      this._t -= this._spb;
      const v = this._acc / Math.max(1, this._accN);
      this._acc = 0; this._accN = 0;
      this._bit(v > 0 ? 1 : 0, Math.min(1, Math.abs(v)));
    }
  }

  _bit(b, q) {
    if (this.mode === 'sitora') { this._sitorBit(b, q); return; }
    this._bits.push(b); this._q.push(q);
    if (this._bits.length > 7 * 64) { this._bits.splice(0, 7); this._q.splice(0, 7); if (this._lock) this._lock.base -= 7; }
    if (!this._lock) { if (this._bits.length >= 7 * 40 && this._bits.length % 7 === 0) this._findLock(); return; }
    // re-check the alignment now and then: a run of identical idle
    // characters is just as valid one bit rotated
    if (++this._sinceCheck >= 7 * 40 && this._bits.length >= 7 * 50) { this._sinceCheck = 0; this._findLock(true); }
    // locked: consume whole characters
    const L = this._lock;
    while (L.base + 7 <= this._bits.length) {
      const code = this._code(L.base, L.inv);
      L.base += 7;
      this._char(code, L.cnt++);
    }
  }

  _code(at, inv) { let v = 0; for (let k = 0; k < 7; k++) v = (v << 1) | (this._bits[at + k] ^ inv); return v; }

  /** valid code word? for ARQ-E also whether it is a cycle-inverted one */
  _valid(v, pos, L) {
    if (this.mode === 'arqe3') return weight(v) === 3;
    // ITA2-P: odd weight, first bit 0 (data) or 1 (idle/RQ); inverted copies even
    const inv = L && L.cycle ? ((pos - L.cyc0) % L.cycle + L.cycle) % L.cycle === 0 : false;
    const u = inv ? (~v & 0x7f) : v;
    return weight(u) % 2 === 1;
  }

  _findLock(recheck = false) {
    const b = this._bits, n = b.length;
    let best = null;
    // the codes must vary: repeated idle fits several phases
    const distinct = (ph) => { const set = new Set(); for (let at = ph; at + 7 <= n; at += 7) { let v = 0; for (let k = 0; k < 7; k++) v = (v << 1) | b[at + k]; set.add(v); } return set.size; };
    if (distinct(0) < 10) return;
    for (let ph = 0; ph < 7; ph++) for (const inv of [0, 1]) {
      const codes = [];
      for (let at = ph; at + 7 <= n; at += 7) { let v = 0; for (let k = 0; k < 7; k++) v = (v << 1) | (b[at + k] ^ inv); codes.push(v); }
      if (this.mode === 'arqe3') {
        const sc = codes.filter((v) => weight(v) === 3).length / codes.length;
        if (!best || sc > best.sc) best = { sc, ph, inv, cycle: 0, cyc0: 0 };
      } else {
        for (const cycle of [4, 8]) for (let c0 = 0; c0 < cycle; c0++) {
          let ok = 0;
          codes.forEach((v, i) => { const isInv = (i - c0) % cycle === 0; const u = isInv ? (~v & 0x7f) : v; if (weight(u) % 2 === 1) ok++; });
          const sc = ok / codes.length;
          if (!best || sc > best.sc + 1e-9) best = { sc, ph, inv, cycle, cyc0: c0 };
        }
      }
    }
    const need = this.mode === 'arqe3' ? 0.8 : 0.92;
    if (recheck) {
      const L = this._lock;
      if (!L || !best) return;
      // where the current lock would put its characters inside this buffer
      const curPh = ((L.base % 7) + 7) % 7;
      const same = best.ph === curPh && best.inv === L.inv && best.cycle === L.cycle;
      if (same || best.sc < need + 0.03) return;
      // switch: re-anchor the cycle to the buffer start
      const cyc0 = best.cycle ? best.cyc0 : 0;
      const nAhead = Math.floor((L.base - best.ph) / 7);
      this._lock = { base: best.ph + 7 * nAhead, inv: best.inv, cycle: best.cycle, cyc0: ((cyc0 - nAhead) % (best.cycle || 1) + (best.cycle || 1)) % (best.cycle || 1), cnt: 0 };
      this._emit({ kind: 'info', text: 're-aligned to the characters' });
      return;
    }
    if (best && best.sc >= need) {
      this._lock = { base: best.ph, inv: best.inv, cycle: best.cycle, cyc0: best.cyc0, cnt: 0 };
      this._emit({ kind: 'info', text: `${ARQ_MODES[this.mode].name} in step${best.cycle ? `, inversion every ${best.cycle}th character` : ''}${best.inv ? ', reversed polarity' : ''}` });
    }
  }

  _char(code, idx) {
    const L = this._lock;
    let entry = null, ctrl = null;
    if (this.mode === 'arqe3') {
      if (weight(code) !== 3) { this._fail(); return; }
      entry = ITA3.get(code);
    } else {
      const isInv = ((idx - L.cyc0) % L.cycle + L.cycle) % L.cycle === 0;
      const u = isInv ? (~code & 0x7f) : code;
      if (weight(u) % 2 !== 1) { this._fail(); return; }
      if (u & 0x40) ctrl = u === 0b1110000 ? 'RQ' : 'α/β';
      else entry = ITA2[((u >> 1) & 31).toString(2).padStart(5, '0')];
    }
    this._good();
    if (ctrl) { this._ctrl(ctrl); return; }
    if (!entry) return;
    this._out(entry);
  }

  _ctrl(c) { if (c === 'RQ') this._rq = (this._rq || 0) + 1; }

  _out(entry) {
    const ch = entry[this._shiftState];
    if (ch === 'LTRS') { this._shiftState = 0; return; }
    if (ch === 'FIGS') { this._shiftState = 1; return; }
    if (ch === 'α' || ch === 'β' || ch === 'RQ') { this._ctrl(ch); return; }
    if (ch === '\r') return;
    if (ch === ' ') this._shiftState = this._shiftState;   // USOS not assumed
    this._text += ch; this._chars++;
    if (this._text.length > 100 || ch === '\n') this._flushText();
  }

  _good() { this._errRun = 0; }
  _fail() {
    this._errors++;
    this._errRun = (this._errRun || 0) + 1;
    this._text += '·';
    if (this._errRun > 12) { this._lock = null; this._flushText(); this._emit({ kind: 'info', text: 'character sync lost' }); }
  }

  // ── SITOR-A: bursts of 3 characters (ISS) and single control characters
  // A burst is only 7 or 21 bits: no clock loop settles in that, so bursts
  // are cut on the signal amplitude and each one gets its own bit timing
  // (the sample offset that gives the most decisive bits).
  _sitorSample(f, amp) {
    this._bitTime = (this._bitTime || 0) + 1 / this._fsd;
    const fast = (this._af = (this._af || 0) + 0.25 * (amp - (this._af || 0)));
    this._peak = Math.max(fast, (this._peak || 0) * (1 - 1 / (this._fsd * 3)));
    this._floor = this._floor === undefined ? fast : Math.min(fast, this._floor * (1 + 1 / this._fsd) + 1e-12);
    const on = fast > 0.25 * this._peak && fast > 6 * this._floor;
    if (on) { this._bs = this._bs || []; this._bs.push(f); this._off = 0; return; }
    if (this._bs && this._bs.length) {
      if (++this._off < this._spb * 1.5) { this._bs.push(0); return; }   // silence carries no bit
      const smp = this._bs; this._bs = [];
      const nb = Math.round((smp.length - this._off) / this._spb);
      if (nb >= 6) this._sitorTiming(smp, nb);
    }
  }

  _sitorTiming(smp, nb) {
    const spb = this._spb;
    let best = null;
    for (let o = -spb / 2; o <= spb / 2; o += Math.max(1, spb / 12)) {
      const bits = [], qs = []; let sc = 0;
      for (let k = 0; k < nb + 1; k++) {
        const a = Math.round(o + k * spb), e = Math.round(o + (k + 1) * spb);
        if (a < 0 || e > smp.length) continue;
        let v = 0; for (let i = a; i < e; i++) v += smp[i];
        v /= (e - a);
        bits.push(v > 0 ? 1 : 0); qs.push(Math.min(1, Math.abs(v))); sc += Math.min(1, Math.abs(v));
      }
      if (!best || sc > best.sc) best = { sc, bits, qs };
    }
    if (best && best.bits.length >= 7) this._sitorBurst(best.bits, best.qs);
  }


  _sitorBit(b, q) {
    const on = q > 0.45 && this._sq > 1e-9;
    if (on) { this._burst.push(b); this._burstQ.push(q); this._quiet = 0; return; }
    if (++this._quiet === 3 && this._burst.length >= 7) this._sitorBurst(this._burst, this._burstQ);
    if (this._quiet >= 3) { this._burst = []; this._burstQ = []; }
  }

  _sitorBurst(bits, qs) {
    // 3 characters = 21 bits (ISS block), 1 character = 7 bits (IRS control);
    // the burst edges carry a bit or two of junk: take the window (and
    // polarity) where the characters are valid code words
    const isBlock = bits.length >= 17;
    const nCh = isBlock ? 3 : 1;
    let best = null;
    for (const inv of [0, 1]) for (let ph = 0; ph + 7 * nCh <= bits.length; ph++) {
      const codes = [];
      for (let c = 0; c < nCh; c++) { let v = 0; for (let k = 0; k < 7; k++) v |= (bits[ph + 7 * c + k] ^ inv) << k; codes.push(v); }
      // every weight-4 word is a CCIR 476 character, and a rotated one is
      // too: among valid windows take the one over the strongest bits
      const ok = codes.filter((v) => weight(v) === 4).length;
      let qq = 0; for (let k = ph; k < ph + 7 * nCh; k++) qq += qs[k];
      const sc = ok * 100 + qq;
      if (!best || sc > best.sc) best = { sc, ok, codes, inv };
    }
    if (!best || !best.ok) return;
    const codes = best.codes;
    if (!isBlock) {
      // IRS control signal: the same CS again means "repeat"
      const cs = codes[0];
      this._skipNext = this._lastCs !== null && cs === this._lastCs;
      this._lastCs = cs;
      return;
    }
    // a block: 19-25 bits, all three characters valid, decisive bits
    let qm = 0; for (const x of qs) qm += x; qm /= qs.length;
    const valid = bits.length <= 25 && best.ok === 3 && qm > 0.5;
    const now = this._bitTime || 0;
    if (!this._sitorOn) {
      // the ARQ rhythm proves it: three valid blocks 450 ms (or a multiple) apart
      if (!valid) return;
      const h = this._hist = (this._hist || []).filter((x) => now - x.t < 5);
      h.push({ t: now, codes });
      const steady = h.length >= 3 && h.slice(-3).every((x, i, a) => i === 0 || Math.abs(((x.t - a[i - 1].t) / 0.45) - Math.round((x.t - a[i - 1].t) / 0.45)) < 0.15);
      if (!steady) return;
      this._sitorOn = true; this._sitorLastAt = now;
      this._emit({ kind: 'info', text: 'SITOR-A blocks (450 ms ARQ cycle)' });
      for (const x of h.slice(-3)) this._sitorBlock(x.codes);
      this._hist = [];
      return;
    }
    if (!valid) { if (now - this._sitorLastAt > 10) { this._sitorOn = false; this._flushText(); this._emit({ kind: 'info', text: 'SITOR-A: no blocks' }); } return; }
    this._sitorLastAt = now;
    this._sitorBlock(codes);
  }

  _sitorBlock(codes) {
    const key = codes.join(',');
    if (this._skipNext && key === this._lastBlock) { this._skipNext = false; return; }
    this._skipNext = false;
    this._lastBlock = key;
    for (const v of codes) {
      const e = C476.get(v);
      if (!e) { this._text += '·'; this._errors++; continue; }
      this._out(e);
    }
  }

  _flushText() {
    if (!this._text) return;
    this._emit({ kind: 'text', text: this._text });
    this._text = ''; this._lastTextAt = Date.now();
  }
  _emit(m) { m.time = new Date().toISOString().slice(11, 19); if (this.onMessage) this.onMessage(m); }

  _maybeMetrics() {
    const now = Date.now();
    if (now - this._lastMetricsAt < 500) return;
    this._lastMetricsAt = now;
    if (this._text && now - this._lastTextAt > 1500) this._flushText();
    const locked = this.mode === 'sitora' ? !!this._sitorOn : !!this._lock;
    if (this.onStatus) this.onStatus(locked ? `${ARQ_MODES[this.mode].name}: receiving` : `${ARQ_MODES[this.mode].name}: searching ${this.baud} Bd / ${this.shift} Hz…`);
    if (this.onMetrics) this.onMetrics({ receiving: locked, chars: this._chars, errors: this._errors, rq: this._rq || 0 });
  }
}

export const _arqTables = { ITA2, ITA3_LIST, C476 };
export default ArqFskDecoder;
