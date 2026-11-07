// ale.js — ALE 2G (MIL-STD-188-141A/B) decoder for SERVICES (receive only)
// ============================================================================
// A port of gr-ale (Milen Rangelov, GPL-3) as carried in KiwiSDR's ALE_2G
// extension (John Seamons, ZL4VO/KF6VO), which in turn builds on LinuxALE
// (Charles Brain G4GUO, Ilkka Toivanen). GPL-3, like this project.
//
// The signal: eight phase-continuous tones 750…2500 Hz (250 Hz apart), one at
// a time, 8 ms each (125 baud), 3 bits per tone, Gray-coded. A 24-bit word is
// split into two 12-bit halves, each Golay(24,12) coded (the second with its
// parity bits inverted), the two codewords bit-interleaved plus a stuff bit:
// 49 bits, sent three times in a row and majority-voted on reception.
// A word: 3-bit preamble (DATA THRU TO TWAS FROM TIS CMD REP) + three 7-bit
// characters.
//
// The receiver, as the original: a 64-point sliding DFT at 8 kHz (125 Hz bins,
// two per tone). 17 decoders run in parallel, each assuming a different bin
// offset (125 Hz steps), so a signal up to ±1 kHz off is still found; the
// symbol timing is the sample position, within the 8 ms, where the strongest
// bin is strongest on average. A decoder syncs when a word's three copies
// disagree on at most 25 of 48 bits and Golay finds at most one error, then
// reads a word every 49 symbols.
//
// Interface, like the other engines:
//   new AleDecoder({ sampleRate, onMessage, onStatus, onMetrics })
//   .feed(Float32Array); .reset();
// ============================================================================

const FS = 8000;
const N = 64;                 // FFT size = samples per symbol
const HALF = 32;
const NTIME = 17;             // bin-offset decoders
const SYMS_PER_WORD = 49;
const VOTE_LEN = 48;
const VOTE_ARRAY = SYMS_PER_WORD * 3;   // 147 bits = three copies
const BAD_VOTES_MAX = 25;
const SYNC_ERRORS_MAX = 1;
const HIGH_BER = 30;
const NOSYM = 8;

const PREAMBLE = ['DATA', 'THRU', 'TO', 'TWAS', 'FROM', 'TIS', 'CMD', 'REP'];
const P = { DATA: 0, THRU: 1, TO: 2, TWAS: 3, FROM: 4, TIS: 5, CMD: 6, REP: 7 };
const S = { START: 0, TO: 1, TWAS: 2, TIS: 3, FROM: 4, CALL_EST: 5, CMD: 6, END: 7 };

// Gray code of the eight tones 750 … 2500 Hz (A.5.1.2 of the ALE spec).
const GRAY = [0, 1, 3, 2, 6, 7, 5, 4];

// Character sets: 1 = ASCII-38 (A–Z 0–9 @ ?), 3 = ASCII-64 only, 4 = CR/LF.
const ASCII_SET = new Uint8Array(128);
for (let c = 0x20; c < 0x60; c++) ASCII_SET[c] = 3;
for (let c = 0x30; c <= 0x39; c++) ASCII_SET[c] = 1;
ASCII_SET[0x3f] = 1;
for (let c = 0x40; c <= 0x5a; c++) ASCII_SET[c] = 1;
ASCII_SET[0x0a] = 4; ASCII_SET[0x0d] = 4;

// ── Golay (24,12), tables regenerated from the generator rows ─────────────
const GOLAY_ROWS = [0x5c7, 0xb8d, 0x2de, 0x5bc, 0xb78, 0x337, 0x66d, 0xcd9, 0xc76, 0xd2b, 0xf92, 0xae3];
const ENC = new Uint16Array(4096);
for (let d = 0; d < 4096; d++) { let p = 0; for (let i = 0; i < 12; i++) if (d >> i & 1) p ^= GOLAY_ROWS[i]; ENC[d] = p; }
// error[syndrome] = data-bit error pattern | (number of bit errors << 12);
// syndromes no pattern of weight ≤ 3 explains are marked 4 errors.
const ERR = new Uint16Array(4096).fill(0x4000);
(() => {
  const seen = new Uint8Array(4096);
  const add = (e, w) => {
    const syn = (e & 0xfff) ^ ENC[e >>> 12];
    if (seen[syn]) return;
    seen[syn] = 1; ERR[syn] = (e >>> 12) | (w << 12);
  };
  add(0, 0);
  for (let a = 0; a < 24; a++) {
    add(1 << a, 1);
    for (let b = a + 1; b < 24; b++) {
      add((1 << a) | (1 << b), 2);
      for (let c = b + 1; c < 24; c++) add((1 << a) | (1 << b) | (1 << c), 3);
    }
  }
})();
export function golayEncode(data) { return ((data & 0xfff) << 12) | ENC[data & 0xfff]; }
function golayDecode(code) {
  const data = (code >>> 12) & 0xfff, syn = (code & 0xfff) ^ ENC[data];
  return { data: data ^ (ERR[syn] & 0xfff), errors: ERR[syn] >>> 12 };
}

const bf = (w, hi, lo) => (w >>> lo) & ((1 << (hi - lo + 1)) - 1);
const chr = (c) => String.fromCharCode(c);

export class AleDecoder {
  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate : (() => Number(options.sampleRate) || 12000);
    this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : null;
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
    this.onMetrics = typeof options.onMetrics === 'function' ? options.onMetrics : null;
    this._cos = new Float64Array(HALF); this._sin = new Float64Array(HALF);
    for (let i = 0; i < HALF; i++) { this._cos[i] = Math.cos(-2 * Math.PI * i / N); this._sin[i] = Math.sin(-2 * Math.PI * i / N); }
    this.reset();
  }

  reset() {
    // resampler to 8 kHz (4-point cubic: linear interpolation lost ~8 % of
    // the events on the test recordings when fed at 12 kHz)
    this._resPhase = 0; this._x0 = 0; this._x1 = 0; this._x2 = 0; this._x3 = 0;
    // sliding DFT
    this._hist = new Float64Array(N); this._histPos = 0;
    this._re = new Float64Array(HALF); this._im = new Float64Array(HALF);
    this._sampInSym = 0; this._symInWord = 0;
    this._magSum = new Float64Array(N);
    this._lastSyncPos = new Int32Array(NTIME);
    this._lastSymbol = new Int32Array(NTIME).fill(NOSYM);
    this._bits = Array.from({ length: NTIME }, () => new Uint8Array(VOTE_ARRAY));
    this._bufPos = new Int32Array(NTIME);
    this._wordSync = new Uint8Array(NTIME);
    this._wordSyncPos = new Int32Array(NTIME);
    this._ber = new Int32Array(NTIME).fill(HIGH_BER);
    this._bestPos = 0;
    // call state
    this._state = S.START; this._stateCount = 0; this._stage = 0;
    this._current = ''; this._current2 = '';
    this._lastBer = HIGH_BER; this._bestBer = HIGH_BER;
    this._inCmd = false; this._binary = false; this._cmds = []; this._prevData2 = '';
    this._words = 0; this._active = false;
    this._lastMetricsAt = 0; this._statusText = '';
    this._level = 0;
  }

  feed(pcm) {
    if (!pcm || !pcm.length) return;
    const step = FS / (this._sampleRateFn() || 12000);
    for (let n = 0; n < pcm.length; n++) {
      // history x0 x1 x2 x3 (x3 newest); output points fall between x1 and x2
      this._x0 = this._x1; this._x1 = this._x2; this._x2 = this._x3; this._x3 = pcm[n];
      this._resPhase += step;
      while (this._resPhase >= 1) {
        this._resPhase -= 1;
        const t = 1 - this._resPhase / step;            // position between x1 and x2
        const x0 = this._x0, x1 = this._x1, x2 = this._x2, x3 = this._x3;
        const c1 = 0.5 * (x2 - x0), c2 = x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3, c3 = 0.5 * (x3 - x0) + 1.5 * (x1 - x2);
        this._sample(((c3 * t + c2) * t + c1) * t + x1);
      }
    }
    this._maybeMetrics();
  }

  /** One 8 kHz sample: sliding DFT, symbol timing and decisions. */
  _sample(xNew) {
    const old = this._hist[this._histPos];
    this._hist[this._histPos] = xNew;
    this._histPos = (this._histPos + 1) & (N - 1);
    let maxMag = 0, maxBin = 0;
    const re = this._re, im = this._im, cs = this._cos, sn = this._sin;
    for (let k = 0; k < HALF; k++) {
      const tr = re[k] - old + xNew, ti = im[k];
      re[k] = tr * cs[k] - ti * sn[k];
      im[k] = tr * sn[k] + ti * cs[k];
      if (k >= 1 && k <= HALF - 5) {
        const m = re[k] * re[k] + im[k] * im[k];   // squared: only compared
        if (m > maxMag) { maxMag = m; maxBin = k; }
      }
    }
    this._level += 0.0005 * (maxMag - this._level);
    const pos = this._sampInSym;
    this._magSum[pos] += Math.sqrt(maxMag);
    // symbol timing for the decoders not in sync: where the peak is strongest
    let best = 0, bestPos = 0;
    for (let i = 0; i < N; i++) if (this._magSum[i] > best) { best = this._magSum[i]; bestPos = i; }
    for (let nt = 0; nt < NTIME; nt++) {
      if (!this._wordSync[nt]) this._lastSyncPos[nt] = bestPos;
      if (pos === this._lastSyncPos[nt]) {
        const k = maxBin - nt;
        this._lastSymbol[nt] = k < 0 || (k >> 1) > 7 ? NOSYM : GRAY[k >> 1];
      }
    }
    if (pos === 0) this._symbolTick();
    this._sampInSym = (this._sampInSym + 1) % N;
    if (this._sampInSym === 0) {
      this._symInWord = (this._symInWord + 1) % SYMS_PER_WORD;
      if (this._symInWord === 0) this._magSum.fill(0);
    }
  }

  /** Once per symbol: every decoder takes its symbol; the call logic runs. */
  _symbolTick() {
    this._words1 = { to: null, from: null, tis: null, twas: null, rep: null, data: null, cmd: null };
    let goodCnt = 0, temppos = 0;
    this._bestBer = HIGH_BER;
    for (let nt = 0; nt < NTIME; nt++) {
      const rv = this._newSymbol(this._lastSymbol[nt], nt);
      if (rv) goodCnt++;
      const isBestBer = this._ber[nt] < this._bestBer;
      const isBestPos = this._bestPos === 0 || this._bestPos === nt;
      if (isBestBer && isBestPos) { this._bestBer = this._ber[nt]; temppos = nt; }
    }
    // KiwiSDR fix: two decoders must agree a word arrived before it counts.
    const w = goodCnt >= 2 ? this._words1 : null;
    if (temppos !== 0) this._bestPos = temppos;
    if (w) this._callLogic(w);
    this._stateCount += N;
    if (this._stateCount >= 2 * FS && this._state !== S.START) {
      this._log('QUIET');
      this._state = S.START; this._stateCount = 0; this._active = false;
    }
  }

  _newSymbol(sym, nt) {
    const b = this._bits[nt];
    for (const mask of [4, 2, 1]) {
      b[this._bufPos[nt]] = (sym & mask) ? 1 : 0;
      this._bufPos[nt] = (this._bufPos[nt] + 1) % VOTE_ARRAY;
    }
    const pos = this._bufPos[nt];
    const vote = this._vote || (this._vote = new Uint8Array(VOTE_LEN));
    let bad = 0;
    for (let i = 0; i < VOTE_LEN; i++) {
      const sum = b[(i + pos) % VOTE_ARRAY] + b[(i + pos + SYMS_PER_WORD) % VOTE_ARRAY] + b[(i + pos + 2 * SYMS_PER_WORD) % VOTE_ARRAY];
      if (sum === 1 || sum === 2) bad++;
      vote[i] = sum >= 2 ? 1 : 0;
    }
    this._ber[nt] = HIGH_BER;
    if (!this._wordSync[nt]) {
      if (bad <= BAD_VOTES_MAX) {
        const { word, errors } = this._deinterleave(vote);
        if (errors <= SYNC_ERRORS_MAX) {
          this._decodeWord(word, nt, bad);
          this._wordSync[nt] = 1;
          this._wordSyncPos[nt] = pos;
          return 1;
        }
      }
    } else if (pos === this._wordSyncPos[nt]) {
      const { word } = this._deinterleave(vote);
      this._decodeWord(word, nt, bad);
      return 2;
    } else {
      this._wordSync[nt] = 0;
    }
    return 0;
  }

  _deinterleave(v) {
    let a = 0, b = 0;
    for (let i = 0; i < VOTE_LEN;) { a = (a << 1) | v[i++]; b = (b << 1) | v[i++]; }
    b ^= 0xfff;
    const ga = golayDecode(a >>> 0), gb = golayDecode(b >>> 0);
    return { word: ((ga.data << 12) | gb.data) >>> 0, errors: Math.max(ga.errors, gb.errors) };
  }

  _decodeWord(w, nt, berw) {
    const pre = bf(w, 23, 21), a = bf(w, 20, 14), b = bf(w, 13, 7), c = bf(w, 6, 0);
    const s3 = chr(a) + chr(b) + chr(c);
    const a38 = ASCII_SET[a] === 1 && ASCII_SET[b] === 1 && ASCII_SET[c] === 1;
    const a64 = (ASCII_SET[a] & 3) && (ASCII_SET[b] & 3) && (ASCII_SET[c] & 3);
    const anl = [a, b, c].every((x) => (ASCII_SET[x] & 3) || ASCII_SET[x] === 4);
    this._a64 = !!a64;
    const w1 = this._words1;
    const cp = this._cmds[this._cmds.length - 1];
    const textCmd = this._inCmd && cp && (cp.cmd === 'AMD' || cp.cmd === 'DTM');
    if (pre === P.CMD) { this._ber[nt] = berw; w1.cmd = s3; w1.cmdW = w; }
    else if (pre === P.DATA) { if (a38 || (anl && textCmd)) { this._ber[nt] = berw; w1.data = s3; } }
    else if (pre === P.REP) { if (a38 || (anl && textCmd)) { this._ber[nt] = berw; w1.rep = s3; } }
    else if (a38) {
      this._ber[nt] = berw;
      if (pre === P.TO) w1.to = s3;
      else if (pre === P.TWAS) w1.twas = s3;
      else if (pre === P.FROM) w1.from = s3;
      else if (pre === P.TIS) w1.tis = s3;
    }
    // (AQC-ALE packed words are recognised by the original but not shown.)
    this._words++;
  }

  /** do_modem2(): advance the call state on the words of this symbol. */
  _callLogic(w) {
    const closeCmd = () => { this._inCmd = false; this._binary = false; };
    if (w.to) {
      if (this._state !== S.START && this._state !== S.TO) this._log('TO');
      closeCmd();
      this._prevData2 = ''; this._current = w.to; this._state = S.TO; this._stateCount = 0; this._lastBer = this._bestBer;
    }
    if (w.twas) {
      if (this._state !== S.START) this._log('TWAS');
      closeCmd();
      this._prevData2 = ''; this._current = w.twas; this._state = S.TWAS; this._stateCount = 0; this._lastBer = this._bestBer;
    }
    if (w.tis) {
      if (![S.START, S.TO, S.TIS, S.CALL_EST].includes(this._state)) this._log('TIS');
      closeCmd();
      if (this._state === S.TO) {
        const s1 = this._current.slice(0, 3), s2 = this._current2.slice(0, 3);
        this._current2 = this._current;
        this._state = S.CALL_EST;
        if (this._stage === 0 || this._stage > 3) this._stage = 0;
        if (this._stage > 0 && w.tis.slice(0, 3) === s2 && this._current.slice(0, 3) === s1) this._stage++;
        else this._stage = 1;
      } else {
        this._state = S.TIS;
      }
      this._stateCount = 0;
      this._prevData2 = ''; this._current = w.tis; this._lastBer = this._bestBer;
    }
    if (w.from) {
      if (this._state !== S.START && this._state !== S.FROM) this._log('FROM');
      closeCmd();
      this._prevData2 = ''; this._current = w.from; this._state = S.FROM; this._stateCount = 0; this._lastBer = this._bestBer;
    }
    // A DATA word right after an address word continues that address
    // (addresses longer than 3 characters); the duplicate check only skips
    // the same DATA word seen twice in a row.
    if (w.data || w.rep) {
      const add = w.data || w.rep;
      const cp = this._cmds[this._cmds.length - 1];
      const intoCmd = this._inCmd && cp;
      if (this._state > S.START && this._state < S.END) {
        if (w.data && add === this._prevData2) { /* duplicate */ }
        else if (intoCmd) cp.text += add; else this._current += add;
        if (w.data) this._prevData2 = add;
      }
      this._stateCount = 0; this._lastBer = this._bestBer;
    }
    if (w.cmd) {
      this._inCmd = true;
      const ch = w.cmd.charCodeAt(0);
      const cp = { raw: w.cmd, w: w.cmdW, text: w.cmd, cmd: 'OTH' };
      if (this._a64) cp.cmd = 'AMD';
      else {
        this._binary = true;
        const map = { '"': 'Advanced LQA', a: 'LQA', b: 'Data block', c: 'Channels', d: 'DTM', f: 'Freq', m: 'Mode selection',
          n: 'Noise report', p: 'Power control', r: 'LQA report', t: 'Scheduling', v: 'Versions/capabilities',
          x: 'CRC', y: 'CRC', z: 'CRC', '{': 'CRC', '|': 'User function', '~': 'Time exchange' };
        cp.cmd = map[chr(ch)] || 'OTH';
        if (cp.cmd === 'DTM') { cp.text = ''; this._binary = false; }
      }
      this._cmds.push(cp);
      this._stateCount = 0; this._lastBer = this._bestBer;
    }
  }

  /** log(): one finished call or sounding becomes a message. */
  _log(why) {
    const clean = (s) => s.replace(/@/g, '').replace(/[\r\n]+/g, ' ').trim();
    const cur = clean(this._current), cur2 = clean(this._current2);
    const ber = this._lastBer;
    let msg = null;
    switch (this._state) {
      case S.TWAS: msg = { kind: 'Sounding (this was)', from: cur }; break;
      case S.TIS: msg = { kind: 'Sounding (this is)', from: cur }; break;
      case S.TO: msg = { kind: 'Call', to: cur }; break;
      case S.CALL_EST:
        msg = { kind: this._stage === 3 ? 'Link established' : this._stage === 2 ? 'Call acknowledged' : 'Call', from: cur, to: cur2 };
        break;
      case S.FROM: msg = { kind: 'From', from: cur }; break;
    }
    const cmds = [];
    for (const cp of this._cmds) {
      if (cp.cmd === 'AMD') cmds.push({ type: 'AMD', text: clean(cp.text) });
      else if (cp.cmd === 'DTM') cmds.push({ type: 'DTM', text: clean(cp.text) });
      else if (cp.cmd === 'LQA' && cp.w !== undefined) cmds.push({ type: 'LQA', text: `SINAD ${bf(cp.w, 9, 5)} BER ${bf(cp.w, 4, 0)}` });
      else cmds.push({ type: cp.cmd, text: '' });
    }
    this._cmds = []; this._inCmd = false; this._binary = false; this._prevData2 = '';
    this._state = S.START; this._current = '';
    if (!msg && !cmds.length) return;
    msg = msg || { kind: 'Message' };
    msg.cmds = cmds;
    msg.ber = ber;
    msg.time = new Date().toISOString().slice(11, 19);
    if (this.onMessage) this.onMessage(msg);
  }

  _status(text) {
    if (text === this._statusText) return;
    this._statusText = text;
    if (this.onStatus) this.onStatus(text);
  }

  _maybeMetrics() {
    const now = Date.now();
    if (now - this._lastMetricsAt < 500) return;
    this._lastMetricsAt = now;
    const synced = Array.from(this._wordSync).filter(Boolean).length;
    this._status(this._state !== S.START ? 'Receiving a call…' : synced ? 'ALE signal — reading words' : 'Listening…');
    if (this.onMetrics) this.onMetrics({ words: this._words, synced, active: this._state !== S.START });
  }
}

export default AleDecoder;
