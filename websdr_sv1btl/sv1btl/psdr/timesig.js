// timesig.js — time-signal decoders for SERVICES (receive only)
// ============================================================================
// Stations: DCF77 (77.5 kHz, Germany), MSF (60 kHz, England), WWV/WWVH
// (2.5–25 MHz, USA) and RWM (4996/9996/14996 kHz, Russia). CHU (Canada) closed
// on 22 June 2026 and is not offered.
//
// Front end, the same for all: the USB dial goes 1 kHz below the carrier, so
// the carrier is a 1000 Hz tone in the audio. It is mixed to DC, low-passed
// and decimated to 1 kHz, so the decoders work on its envelope with 1 ms
// resolution. WWV's code rides on a 100 Hz subcarrier, which appears in that
// envelope as a 100 Hz ripple; its strength is what the WWV reader measures.
//
// Readers (pulse lengths from the stations' published formats):
//   DCF77  carrier cut to 15 % for 100 ms (0) / 200 ms (1) at each second;
//          no cut at second 59 marks the minute. BCD with 3 even parities;
//          the code gives the civil time (CET/CEST) of the NEXT minute.
//   MSF    carrier off 100 ms at each second, then bit A (100–200 ms) and
//          bit B (200–300 ms), off = 1; 500 ms off at second 0. A bits carry
//          the next minute's UK civil time, B bits 4 odd parities, BST, DUT1.
//   WWV    100 Hz subcarrier from +30 ms, cut at 200 ms (0), 500 ms (1) or
//          800 ms (marker, seconds 9, 19 … 59); none in second 0. Gives UTC of
//          the minute the frame started, day of year, DUT1, DST.
//   RWM    carrier pulses: 100 ms each second, 500 ms on the minute, a second
//          pulse 200–300 ms after seconds that carry DUT1 (1 Hz mode, minutes
//          :10–:20 and :40–:50). No date or time of day: only the timing.
//
// Interface, like the other engines:
//   new TimeSignalDecoder({ sampleRate, station, onMessage, onStatus, onMetrics })
//   .feed(Float32Array); .setStation(key); .reset();
// ============================================================================

export const TIME_STATIONS = [
  { key: 'dcf77', label: 'DCF77 · Germany', khz: [77.5], note: 'Mainflingen, 50 kW, day and night across Europe' },
  { key: 'msf', label: 'MSF · England', khz: [60], note: 'Anthorn, 17 kW; best at night outside the UK' },
  { key: 'rwm', label: 'RWM · Russia', khz: [4996, 9996, 14996], note: 'Moscow; timing only (no date), 1 Hz pulses at :10–:20 and :40–:50' },
  { key: 'wwv', label: 'WWV / WWVH · USA', khz: [2500, 5000, 10000, 15000, 20000, 25000], note: 'Fort Collins / Hawaii; from Europe mostly 10 and 15 MHz at times' },
];

const CARRIER_HZ = 1000;      // where the carrier sits in the USB audio
const ENV_RATE = 1000;        // envelope samples per second (1 ms)
const HIST_MS = 3000;         // envelope history kept, ms
// The edge detector (60 Hz low-pass + hysteresis) reports an edge this much
// before/after the true one; measured on synthetic signals, compensated in
// the arrival-time offset.
const DETECT_BIAS_MS = 42;

const pad2 = (n) => String(n).padStart(2, '0');
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function bcd(bits, from, weights) {
  let v = 0;
  for (let i = 0; i < weights.length; i++) {
    const b = bits[from + i];
    if (b === undefined || b < 0) return NaN;
    if (b) v += weights[i];
  }
  return v;
}
const ones = (bits, a, b) => { let n = 0; for (let i = a; i <= b; i++) if (bits[i] === 1) n++; return n; };
const allKnown = (bits, a, b) => { for (let i = a; i <= b; i++) if (bits[i] !== 0 && bits[i] !== 1) return false; return true; };

export class TimeSignalDecoder {
  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate : (() => Number(options.sampleRate) || 12000);
    this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : null;
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
    this.onMetrics = typeof options.onMetrics === 'function' ? options.onMetrics : null;
    this._station = TIME_STATIONS.some((s) => s.key === options.station) ? options.station : 'dcf77';
    // Test hook: a clock other than Date.now() (offline decoding of files).
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.reset();
  }

  setStation(key) {
    if (!TIME_STATIONS.some((s) => s.key === key) || key === this._station) return;
    this._station = key;
    this.reset();
  }

  reset() {
    this._oscC = 1; this._oscS = 0; this._oscN = 0;
    this._lp = [_biq(), _biq(), _biq(), _biq()];
    this._dec = 0;
    this._ms = 0;                         // envelope sample counter (ms)
    this._hist = new Float32Array(HIST_MS);
    this._state = new Uint8Array(HIST_MS); // 1 = carrier/subcarrier high
    // WWV: 100 Hz subcarrier detector on the envelope
    this._bp = _biq(); this._bpEnv = 0;
    this._lvlLp = _biq();
    // adaptive levels
    this._hi = 0; this._lo = 0; this._lvlInit = 0;
    this._high = true; this._edgeT = 0;
    // per-format state
    this._lastFall = -1e9; this._lastRise = -1e9;
    this._minuteT = null;                  // ms of the current minute's start
    this._bits = [];                       // second index → 0/1/2(marker)/-1
    this._phC = 0; this._phS = 0;          // DCF77/MSF: phase of the seconds (vector mean)
    this._nextSlot = null;                 // ms at which the next second slot is judged
    this._prevSlot = '';
    this._pulses = [];                     // RWM pulse starts in this minute
    this._decoded = 0;
    this._frames = [];                     // last minutes, for integration
    this._lastMetricsAt = 0;
    this._statusText = '';
    this._wallAt = { wall: 0, ms: 0 };
    this._configure();
  }

  _configure() {
    this._sr = this._sampleRateFn() || 12000;
    const w = 2 * Math.PI * CARRIER_HZ / this._sr;
    this._stepC = Math.cos(w); this._stepS = Math.sin(w);
    // WWV needs the ±100 Hz subcarrier sidebands through; the others only the
    // carrier's on/off (a few ms edges) and as little noise as possible.
    const corner = this._station === 'wwv' ? 160 : 60;
    for (const f of this._lp) _biqLowpass(f, corner, this._sr);
    _biqBandpass(this._bp, 100, ENV_RATE, 4);
    _biqLowpass(this._lvlLp, 25, ENV_RATE);
  }

  feed(pcm) {
    if (!pcm || !pcm.length) return;
    const sr = this._sampleRateFn() || 12000;
    if (sr !== this._sr) this._configure();
    const step = ENV_RATE / this._sr;
    for (let n = 0; n < pcm.length; n++) {
      const x = pcm[n];
      const c = this._oscC, s = this._oscS;
      let i = x * c, q = -x * s;
      this._oscC = c * this._stepC - s * this._stepS;
      this._oscS = s * this._stepC + c * this._stepS;
      if (++this._oscN >= 1024) { const m = Math.hypot(this._oscC, this._oscS) || 1; this._oscC /= m; this._oscS /= m; this._oscN = 0; }
      i = _biqStep(this._lp[1], _biqStep(this._lp[0], i));
      q = _biqStep(this._lp[3], _biqStep(this._lp[2], q));
      this._dec += step;
      if (this._dec >= 1) { this._dec -= 1; this._env(Math.hypot(i, q)); }
    }
    // Wall clock of the newest envelope sample (for the arrival-time offset).
    this._wallAt = { wall: this._now(), ms: this._ms };
    this._maybeMetrics();
  }

  _wallOf(ms) { return this._wallAt.wall - (this._wallAt.ms - ms) + DETECT_BIAS_MS; }

  /** One envelope sample (1 ms). */
  _env(mag) {
    let v = mag;
    if (this._station === 'wwv') {
      // 100 Hz ripple on the carrier envelope = the subcarrier; its strength,
      // relative to the carrier, is the signal the WWV code is read from.
      const b = _biqStep(this._bp, mag);
      v = _biqStep(this._lvlLp, Math.abs(b)) / (mag + 1e-12);
    }
    const t = this._ms++;
    this._hist[t % HIST_MS] = v;

    // Adaptive high/low levels with hysteresis.
    if (this._lvlInit < 300) { this._lvlInit++; this._hi = Math.max(this._hi, v); this._lo = this._lvlInit === 1 ? v : Math.min(this._lo, v); }
    const mid = (this._hi + this._lo) / 2;
    if (v > mid) this._hi += 0.002 * (v - this._hi); else this._lo += 0.002 * (v - this._lo);
    if (this._hi < this._lo * 1.15) this._hi = this._lo * 1.15 + 1e-9;
    const span = this._hi - this._lo;
    const up = this._lo + 0.6 * span, down = this._lo + 0.4 * span;
    if (this._high && v < down) { this._high = false; this._fall(t); }
    else if (!this._high && v > up) { this._high = true; this._rise(t); }
    this._state[t % HIST_MS] = this._high ? 1 : 0;

    if (this._station === 'dcf77' || this._station === 'msf') this._slotClock(t);
    // Nothing at all for 10 s: lost (short fades are ridden through).
    if (this._minuteT !== null && t - Math.max(this._lastFall, this._lastRise) > 10000) {
      this._minuteT = null; this._bits = []; this._nextSlot = null; this._phC = this._phS = 0;
      this._status('Signal lost — searching');
    }
  }

  /**
   * DCF77 / MSF: every second starts with a falling edge at the same point
   * within the second. That phase is averaged over the edges (a fade or a
   * spike moves it very little), and each second is then judged on its own
   * from the envelope history, 450 ms after it started.
   */
  _slotClock(t) {
    const len = Math.hypot(this._phC, this._phS);
    if (len < 0.5) { this._nextSlot = null; return; }
    const phase = Math.round(((Math.atan2(this._phS, this._phC) / (2 * Math.PI)) * 1000 + 1000) % 1000);
    if (this._nextSlot === null) {
      // the next second start after now, judged 450 ms later
      let start = Math.floor(t / 1000) * 1000 + phase;
      if (start <= t - 450) start += 1000;
      this._nextSlot = start + 450;
      return;
    }
    if (t < this._nextSlot) return;
    // follow the phase as it is refined
    let start = this._nextSlot - 450;
    const drift = ((phase - (start % 1000)) + 1500) % 1000 - 500;
    if (Math.abs(drift) < 60) start += Math.round(drift * 0.5);
    start = Math.round(start);
    this._nextSlot = start + 1000 + 450;
    if (this._station === 'dcf77') this._dcfSlot(start); else this._msfSlot(start);
  }

  /** Fraction of the ms in [start+a, start+b) with the carrier low. */
  _lowFrac(start, a, b) {
    let low = 0, n = 0;
    for (let ms = start + a; ms < start + b; ms++) {
      const h = this._isHigh(ms);
      if (h === null) continue;
      n++; if (!h) low++;
    }
    return n ? low / n : 0.5;
  }

  _dcfSlot(start) {
    const red = this._lowFrac(start, 15, 85), late = this._lowFrac(start, 120, 180);
    let sym = '?';
    if (red > 0.6) sym = late > 0.6 ? '1' : late < 0.25 ? '0' : '?';
    else if (red < 0.15 && late < 0.15) sym = 'M';          // no reduction: second 59
    // Second 59 (M) right after a reduced second: the next second is 00.
    // Once a minute is running, it is closed after second 59 even when the
    // mark itself was lost in a fade (a flywheel, as radio clocks do).
    const s = this._minuteT === null ? null : Math.round((start - this._minuteT) / 1000);
    if (sym === 'M' && (this._prevSlot === '0' || this._prevSlot === '1')) this._newMinute(start + 1000);
    else if (s === 59 && sym !== '0' && sym !== '1') this._newMinute(start + 1000);
    else if (s !== null && s >= 60) this._newMinute(this._minuteT + 60000);
    else if (sym === '0' || sym === '1') this._putBit(start, Number(sym));
    else this._putBit(start, -1);
    this._prevSlot = sym;
  }

  _msfSlot(start) {
    const s0 = this._minuteT === null ? null : Math.round((start - this._minuteT) / 1000);
    if (this._lowFrac(start, 350, 450) > 0.6 && this._lowFrac(start, 20, 90) > 0.6) { this._newMinute(start); return; }  // 500 ms off: 00
    if (s0 !== null && s0 >= 60) { this._newMinute(this._minuteT + 60000); return; }   // flywheel
    if (this._lowFrac(start, 20, 90) < 0.6) { this._putBit(start, -1); return; }   // no second marker
    if (this._minuteT === null) return;
    const s = Math.round((start - this._minuteT) / 1000);
    if (s <= 0 || s > 60) return;
    const a = this._lowFrac(start, 120, 180), b = this._lowFrac(start, 220, 280);
    this._bits[s] = a > 0.6 ? 1 : a < 0.25 ? 0 : -1;
    (this._bitsB || (this._bitsB = []))[s] = b > 0.6 ? 1 : b < 0.25 ? 0 : -1;
  }

  _isHigh(ms) { return ms >= 0 && ms > this._ms - HIST_MS ? this._state[ms % HIST_MS] === 1 : null; }

  // ── Edges, per station ────────────────────────────────────────────────────

  _fall(t) {
    const prev = this._lastFall;
    this._lastFall = t;
    if (this._station === 'dcf77' || this._station === 'msf') {
      // Only edges about a whole number of seconds after the previous one
      // vote for the phase (MSF's A/B bits add edges inside the second).
      const gap = t - prev;
      const frac = Math.abs(gap - Math.round(gap / 1000) * 1000);
      if (prev < 0 || frac < 80 || Math.hypot(this._phC, this._phS) < 0.3) {
        const a = 2 * Math.PI * (t % 1000) / 1000;
        this._phC += 0.15 * (Math.cos(a) - this._phC);
        this._phS += 0.15 * (Math.sin(a) - this._phS);
      }
    } else if (this._station === 'wwv') {
      const dur = t - this._lastRise;
      this._wwvPulse(this._lastRise, dur);
    } else if (this._station === 'rwm') {
      const dur = t - this._lastRise;
      this._rwmPulse(this._lastRise, dur);
    }
  }

  _rise(t) {
    this._lastRise = t;
  }

  /** Store a bit at the second it belongs to (counted from the minute start). */
  _putBit(t, bit) {
    if (this._minuteT === null) return;
    const s = Math.round((t - this._minuteT) / 1000);
    if (s < 0 || s > 60) return;
    if (Math.abs(t - (this._minuteT + s * 1000)) > 120) return;   // not on a second
    this._bits[s] = bit;
  }

  _newMinute(t) {
    const prevT = this._minuteT, bits = this._bits;
    this._minuteT = t;
    this._bits = [];
    if (prevT !== null && Math.abs(t - prevT - 60000) < 300) this._decodeMinute(bits, prevT, t);
    else this._status('Minute mark found — reading the next minute');
  }

  // ── WWV: subcarrier pulse lengths ────────────────────────────────────────
  _wwvPulse(rise, dur) {
    const start = rise - 30;                 // the subcarrier starts 30 ms in
    let sym = -1;
    if (dur >= 120 && dur <= 230) sym = 0;
    else if (dur >= 400 && dur <= 530) sym = 1;
    else if (dur >= 700 && dur <= 830) sym = 2;   // marker
    else return;
    // P0 (second 59) followed by a second with no subcarrier = minute start.
    if (this._wwvLast && sym !== -1) {
      const gap = start - this._wwvLast.start;
      if (this._wwvLast.sym === 2 && gap > 1800 && gap < 2200) this._newMinute(this._wwvLast.start + 1000);
    }
    this._wwvLast = { start, sym };
    this._putBit(start, sym);
  }

  // ── RWM: carrier pulses ──────────────────────────────────────────────────
  _rwmPulse(rise, dur) {
    if (dur >= 400 && dur <= 600) {
      // the minute pulse; DUT1 from the doubled pulses of the minute before
      const prevT = this._minuteT;
      const pulses = this._pulses;
      this._minuteT = rise;
      this._pulses = [];
      if (prevT !== null && Math.abs(rise - prevT - 60000) < 300) {
        this._status('Locked — timing every minute');
        let pos = 0, neg = 0;
        for (const p of pulses) {
          const s = Math.floor((p - prevT) / 1000), off = (p - prevT) - s * 1000;
          if (off >= 150 && off <= 320) { if (s >= 1 && s <= 8) pos++; else if (s >= 9 && s <= 16) neg++; }
        }
        // Fewer than ~30 one-second pulses: the 10 Hz period (no DUT1 code).
        if (pulses.length < 30) this._emitRwm(rise, null, 0, '10 Hz pulse period (no DUT1 in it)');
        else this._emitRwm(rise, pos ? pos / 10 : -neg / 10, pulses.length);
      } else {
        this._status('Minute pulse found — timing the next one');
        this._emitRwm(rise, null, 0);
      }
      return;
    }
    if (dur >= 60 && dur <= 140 && this._minuteT !== null) this._pulses.push(rise);
  }

  _emitRwm(t, dut1, pulses, note) {
    const wall = this._wallOf(t);
    const minute = Math.round(wall / 60000) * 60000;
    const d = new Date(minute);
    this._decoded++;
    this._emit({
      station: 'rwm', ok: true, timingOnly: true, utcMs: minute,
      utc: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`,
      text: `Minute pulse at ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`,
      dut1: dut1 === null ? null : Math.round(dut1 * 10) / 10,
      offsetMs: Math.round(wall - minute),
      details: note || (dut1 === null ? 'first minute pulse (DUT1 from the next minute)' : `1 Hz pulse period, ${pulses} second pulses`),
    });
  }

  // ── Decoding a complete minute ───────────────────────────────────────────
  _decodeMinute(bits, startT, endT) {
    let r = null;
    const bitsB = this._bitsB || [];
    if (this._station === 'dcf77') r = this._dcf77(bits, endT);
    else if (this._station === 'msf') r = this._msf(bits, bitsB, endT);
    else if (this._station === 'wwv') r = this._wwv(bits, startT);
    this._bitsB = [];
    // The minute each frame names: DCF77/MSF the one starting at its end,
    // WWV the one it started at.
    const markT = this._station === 'wwv' ? startT : endT;
    this._frames.push({ bits: bits.slice(), bitsB: bitsB.slice(), markT });
    if (this._frames.length > 6) this._frames.shift();
    if (!r) r = this._integrate();
    if (r) { this._decoded++; this._emit(r); this._status(r.integrated ? `Locked (read over ${r.integrated} minutes)` : 'Locked — decoding every minute'); }
    else this._status('Minute received with errors — adding up minutes');
  }

  // ── Minute integration ────────────────────────────────────────────────────
  // With a fading signal few minutes arrive whole. The date and hour do not
  // change from minute to minute and the minute only counts up, so a time T
  // for the newest frame is checked against every frame kept: frame j minutes
  // older must carry T − j minutes. Candidates come from reading each frame
  // without its parities; one is accepted when it agrees with nearly all the
  // bits of several minutes and clearly beats the next best.
  _integrate() {
    const F = this._frames;
    if (F.length < 2) return null;
    const newest = F[F.length - 1];
    // frames must be whole minutes apart
    const lag = F.map((f) => Math.round((newest.markT - f.markT) / 60000));
    const cands = new Set();
    for (let j = 0; j < F.length; j++) {
      for (const c of this._looseTimes(F[j])) cands.add(c + lag[j] * 60000);
    }
    // The page's own clock suggests candidates too (±10 min). They only pass
    // if the received bits confirm them, so a wrong computer clock cannot
    // put its time on the screen: it just narrows the search.
    const wallMin = Math.round(this._wallOf(newest.markT) / 60000) * 60000;
    for (let k = -10; k <= 10; k++) cands.add(wallMin + k * 60000);
    let best = null, second = null;
    for (const T of cands) {
      for (const zone of this._station === 'wwv' ? [0] : [0, 1]) {
        let cmp = 0, err = 0;
        for (let j = 0; j < F.length; j++) {
          const exp = this._expected(T - lag[j] * 60000, zone);
          if (!exp) { cmp = -1; break; }
          for (const [i, v, which] of exp) {
            const got = which === 'B' ? F[j].bitsB[i] : F[j].bits[i];
            if (got !== 0 && got !== 1 && got !== 2) continue;
            cmp++; if (got !== v) err++;
          }
        }
        if (cmp < 0) continue;
        const sc = { T, zone, cmp, err, rate: cmp ? err / cmp : 1 };
        if (!best || sc.err - sc.cmp * 0.02 < best.err - best.cmp * 0.02) { if (best && best.T !== sc.T) second = best; best = sc; }
        else if ((!second || sc.err < second.err) && sc.T !== best.T) second = sc;
      }
    }
    if (!best || best.cmp < 80 || best.rate > 0.12) return null;
    if (second && second.err - best.err < 4) return null;
    const frames = F.length;
    const r = this._resultFor(best.T, best.zone, newest.markT);
    r.integrated = frames;
    return r;
  }

  /** Times a frame suggests when read without parities (UTC ms, both zones). */
  _looseTimes(f) {
    const b = f.bits, out = [];
    if (this._station === 'dcf77') {
      const mi = bcd(b, 21, [1, 2, 4, 8, 10, 20, 40]), hh = bcd(b, 29, [1, 2, 4, 8, 10, 20]);
      const dd = bcd(b, 36, [1, 2, 4, 8, 10, 20]), mo = bcd(b, 45, [1, 2, 4, 8, 10]), yy = bcd(b, 50, [1, 2, 4, 8, 10, 20, 40, 80]);
      if ([mi, hh, dd, mo, yy].some(isNaN) || mi > 59 || hh > 23 || dd < 1 || dd > 31 || mo < 1 || mo > 12) return out;
      for (const off of [1, 2]) out.push(Date.UTC(2000 + yy, mo - 1, dd, hh - off, mi));
    } else if (this._station === 'msf') {
      const yy = bcd(b, 17, [80, 40, 20, 10, 8, 4, 2, 1]), mo = bcd(b, 25, [10, 8, 4, 2, 1]);
      const dd = bcd(b, 30, [20, 10, 8, 4, 2, 1]), hh = bcd(b, 39, [20, 10, 8, 4, 2, 1]), mi = bcd(b, 45, [40, 20, 10, 8, 4, 2, 1]);
      if ([mi, hh, dd, mo, yy].some(isNaN) || mi > 59 || hh > 23 || dd < 1 || dd > 31 || mo < 1 || mo > 12) return out;
      for (const off of [0, 1]) out.push(Date.UTC(2000 + yy, mo - 1, dd, hh - off, mi));
    } else if (this._station === 'wwv') {
      const yy = bcd(b, 4, [1, 2, 4, 8]) + bcd(b, 51, [10, 20, 40, 80]);
      const mi = bcd(b, 10, [1, 2, 4, 8]) + bcd(b, 15, [10, 20, 40]);
      const hh = bcd(b, 20, [1, 2, 4, 8]) + bcd(b, 25, [10, 20]);
      const doy = bcd(b, 30, [1, 2, 4, 8]) + bcd(b, 35, [10, 20, 40, 80]) + bcd(b, 40, [100, 200]);
      if ([mi, hh, doy, yy].some(isNaN) || mi > 59 || hh > 23 || doy < 1 || doy > 366) return out;
      out.push(Date.UTC(2000 + yy, 0, 1, hh, mi) + (doy - 1) * 86400000);
    }
    return out;
  }

  /**
   * The bits a station sends for UTC minute T (zone: DCF77 1 = CEST,
   * MSF 1 = BST): [[index, value, 'A'|'B'], ...] for the fields that are
   * fully determined by the time (not DUT1, warnings or weather bits).
   */
  _expected(T, zone) {
    const out = [];
    const put = (v, i, w, which) => {
      const order = w.map((x, k) => [x, k]).sort((a, b) => b[0] - a[0]);
      const bits = new Array(w.length).fill(0);
      for (const [x, k] of order) if (v >= x) { v -= x; bits[k] = 1; }
      bits.forEach((x, k) => out.push([i + k, x, which]));
      return bits;
    };
    if (this._station === 'dcf77') {
      const d = new Date(T + (zone ? 2 : 1) * 3600000);
      out.push([17, zone ? 1 : 0], [18, zone ? 0 : 1], [20, 1]);
      const m = put(d.getUTCMinutes(), 21, [1, 2, 4, 8, 10, 20, 40]);
      out.push([28, m.reduce((a, x) => a + x, 0) % 2]);
      const h = put(d.getUTCHours(), 29, [1, 2, 4, 8, 10, 20]);
      out.push([35, h.reduce((a, x) => a + x, 0) % 2]);
      const p3 = [...put(d.getUTCDate(), 36, [1, 2, 4, 8, 10, 20]), ...put(d.getUTCDay() || 7, 42, [1, 2, 4]),
        ...put(d.getUTCMonth() + 1, 45, [1, 2, 4, 8, 10]), ...put(d.getUTCFullYear() % 100, 50, [1, 2, 4, 8, 10, 20, 40, 80])];
      out.push([58, p3.reduce((a, x) => a + x, 0) % 2]);
    } else if (this._station === 'msf') {
      const d = new Date(T + (zone ? 3600000 : 0));
      put(d.getUTCFullYear() % 100, 17, [80, 40, 20, 10, 8, 4, 2, 1], 'A');
      put(d.getUTCMonth() + 1, 25, [10, 8, 4, 2, 1], 'A');
      put(d.getUTCDate(), 30, [20, 10, 8, 4, 2, 1], 'A');
      put(d.getUTCDay(), 36, [4, 2, 1], 'A');
      put(d.getUTCHours(), 39, [20, 10, 8, 4, 2, 1], 'A');
      put(d.getUTCMinutes(), 45, [40, 20, 10, 8, 4, 2, 1], 'A');
      [0, 1, 1, 1, 1, 1, 1, 0].forEach((x, k) => out.push([52 + k, x, 'A']));
      out.push([58, zone ? 1 : 0, 'B']);
    } else if (this._station === 'wwv') {
      const d = new Date(T);
      const yy = d.getUTCFullYear() % 100, mi = d.getUTCMinutes(), hh = d.getUTCHours();
      const doy = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
      put(yy % 10, 4, [1, 2, 4, 8]); put(yy - yy % 10, 51, [10, 20, 40, 80]);
      put(mi % 10, 10, [1, 2, 4, 8]); put(mi - mi % 10, 15, [10, 20, 40]);
      put(hh % 10, 20, [1, 2, 4, 8]); put(hh - hh % 10, 25, [10, 20]);
      put(doy % 10, 30, [1, 2, 4, 8]); put(doy % 100 - doy % 10, 35, [10, 20, 40, 80]); put(doy - doy % 100, 40, [100, 200]);
      for (const sMark of [9, 19, 29, 39, 49, 59]) out.push([sMark, 2]);
    } else return null;
    return out;
  }

  /** A result object for UTC minute T found by integration. */
  _resultFor(T, zone, markT) {
    const d = new Date(T);
    const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    const extra = { date, weekday: WEEKDAY[d.getUTCDay()], flags: [] };
    if (this._station === 'dcf77') {
      const l = new Date(T + (zone ? 2 : 1) * 3600000);
      extra.local = `${pad2(l.getUTCHours())}:${pad2(l.getUTCMinutes())} ${zone ? 'CEST' : 'CET'}`;
      extra.date = `${l.getUTCFullYear()}-${pad2(l.getUTCMonth() + 1)}-${pad2(l.getUTCDate())}`;
      extra.weekday = WEEKDAY[l.getUTCDay()];
    } else if (this._station === 'msf') {
      const l = new Date(T + (zone ? 3600000 : 0));
      extra.local = `${pad2(l.getUTCHours())}:${pad2(l.getUTCMinutes())} ${zone ? 'BST' : 'GMT'}`;
    }
    return this._result(this._station, T, markT, extra);
  }

  _dcf77(b, markT) {
    if (!allKnown(b, 15, 58) || b[20] !== 1) return null;
    if (ones(b, 21, 28) % 2 || ones(b, 29, 35) % 2 || ones(b, 36, 58) % 2) return null;
    const mi = bcd(b, 21, [1, 2, 4, 8, 10, 20, 40]), hh = bcd(b, 29, [1, 2, 4, 8, 10, 20]);
    const dd = bcd(b, 36, [1, 2, 4, 8, 10, 20]), wd = bcd(b, 42, [1, 2, 4]);
    const mo = bcd(b, 45, [1, 2, 4, 8, 10]), yy = bcd(b, 50, [1, 2, 4, 8, 10, 20, 40, 80]);
    const cest = b[17] === 1, cet = b[18] === 1;
    if (cest === cet || mi > 59 || hh > 23 || dd < 1 || dd > 31 || mo < 1 || mo > 12 || wd < 1) return null;
    const utcMs = Date.UTC(2000 + yy, mo - 1, dd, hh - (cest ? 2 : 1), mi);
    const flags = [];
    if (b[16]) flags.push('summer/winter time change at the end of this hour');
    if (b[19]) flags.push('leap second at the end of this hour');
    if (b[15]) flags.push('call bit set (abnormal transmitter operation)');
    return this._result('dcf77', utcMs, markT, {
      local: `${pad2(hh)}:${pad2(mi)} ${cest ? 'CEST' : 'CET'}`,
      date: `${2000 + yy}-${pad2(mo)}-${pad2(dd)}`, weekday: WEEKDAY[wd % 7], flags,
    });
  }

  _msf(a, b, markT) {
    if (!allKnown(a, 17, 59)) return null;
    // fixed marker 01111110 in A 52..59
    const mk = [0, 1, 1, 1, 1, 1, 1, 0];
    for (let i = 0; i < 8; i++) if (a[52 + i] !== mk[i]) return null;
    for (const [lo, hi, pb] of [[17, 24, 54], [25, 35, 55], [36, 38, 56], [39, 51, 57]]) {
      if (b[pb] !== 0 && b[pb] !== 1) return null;
      if ((ones(a, lo, hi) + b[pb]) % 2 !== 1) return null;   // odd parity
    }
    const yy = bcd(a, 17, [80, 40, 20, 10, 8, 4, 2, 1]), mo = bcd(a, 25, [10, 8, 4, 2, 1]);
    const dd = bcd(a, 30, [20, 10, 8, 4, 2, 1]), wd = bcd(a, 36, [4, 2, 1]);
    const hh = bcd(a, 39, [20, 10, 8, 4, 2, 1]), mi = bcd(a, 45, [40, 20, 10, 8, 4, 2, 1]);
    if (mi > 59 || hh > 23 || dd < 1 || dd > 31 || mo < 1 || mo > 12) return null;
    const bst = b[58] === 1;
    const utcMs = Date.UTC(2000 + yy, mo - 1, dd, hh - (bst ? 1 : 0), mi);
    let dut1 = 0;
    for (let s = 1; s <= 8; s++) if (b[s] === 1) dut1 += 0.1;
    for (let s = 9; s <= 16; s++) if (b[s] === 1) dut1 -= 0.1;
    const flags = [];
    if (b[53]) flags.push('summer time change within the hour');
    return this._result('msf', utcMs, markT, {
      local: `${pad2(hh)}:${pad2(mi)} ${bst ? 'BST' : 'GMT'}`,
      date: `${2000 + yy}-${pad2(mo)}-${pad2(dd)}`, weekday: WEEKDAY[wd], flags,
      dut1: Math.round(dut1 * 10) / 10,
    });
  }

  _wwv(b, startT) {
    for (const s of [9, 19, 29, 39, 49, 59]) if (b[s] !== 2) return null;
    const need = [4, 5, 6, 7, 10, 11, 12, 13, 15, 16, 17, 20, 21, 22, 23, 25, 26, 30, 31, 32, 33, 35, 36, 37, 38, 40, 41, 50, 51, 52, 53, 54, 56, 57, 58];
    for (const s of need) if (b[s] !== 0 && b[s] !== 1) return null;
    const yy = bcd(b, 4, [1, 2, 4, 8]) + bcd(b, 51, [10, 20, 40, 80]);
    const mi = bcd(b, 10, [1, 2, 4, 8]) + bcd(b, 15, [10, 20, 40]);
    const hh = bcd(b, 20, [1, 2, 4, 8]) + bcd(b, 25, [10, 20]);
    const doy = bcd(b, 30, [1, 2, 4, 8]) + bcd(b, 35, [10, 20, 40, 80]) + bcd(b, 40, [100, 200]);
    if (mi > 59 || hh > 23 || doy < 1 || doy > 366) return null;
    const utcMs = Date.UTC(2000 + yy, 0, 1, hh, mi) + (doy - 1) * 86400000;
    const dut1 = (b[50] ? 1 : -1) * bcd(b, 56, [1, 2, 4]) / 10;
    const d = new Date(utcMs);
    const flags = [];
    if (b[2] || b[55]) flags.push(`US daylight saving time ${b[2] && b[55] ? 'in effect' : 'changes today'}`);
    return this._result('wwv', utcMs, startT, {
      date: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} (day ${doy})`,
      weekday: WEEKDAY[d.getUTCDay()], flags, dut1: Math.round(dut1 * 10) / 10,
    });
  }

  _result(station, utcMs, markT, extra) {
    const d = new Date(utcMs);
    const wall = this._wallOf(markT);
    return {
      station, ok: true,
      utc: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`,
      utcMs,
      // how late the minute mark reached this page, against the computer clock
      offsetMs: Math.round(wall - utcMs),
      ...extra,
    };
  }

  _emit(r) {
    r.received = new Date(this._now()).toISOString().slice(11, 19);
    if (this.onMessage) this.onMessage(r);
  }

  _status(text) {
    if (text === this._statusText) return;
    this._statusText = text;
    if (this.onStatus) this.onStatus(text);
  }

  _maybeMetrics() {
    const now = this._now();
    if (now - this._lastMetricsAt < 250) return;
    this._lastMetricsAt = now;
    const second = this._minuteT === null ? null : Math.floor((this._ms - this._minuteT) / 1000);
    const bits = [];
    if (this._minuteT !== null) for (let s = 0; s < Math.min(60, (second || 0) + 1); s++) bits.push(this._bits[s] ?? -1);
    if (this.onMetrics) this.onMetrics({
      station: this._station,
      depthDb: this._lo > 0 ? Math.round(20 * Math.log10(this._hi / this._lo) * 10) / 10 : 0,
      high: this._high,
      second,
      bits,
      decoded: this._decoded,
    });
  }
}

// ── RBJ biquads ─────────────────────────────────────────────────────────────
function _biq() { return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0 }; }
function _biqLowpass(f, freq, sr, Q = 0.707) {
  f.x1 = f.x2 = f.y1 = f.y2 = 0;
  const w = 2 * Math.PI * freq / sr, sn = Math.sin(w), cs = Math.cos(w), al = sn / (2 * Q), a0 = 1 + al;
  f.b0 = ((1 - cs) / 2) / a0; f.b1 = (1 - cs) / a0; f.b2 = f.b0; f.a1 = (-2 * cs) / a0; f.a2 = (1 - al) / a0;
}
function _biqBandpass(f, freq, sr, Q) {
  f.x1 = f.x2 = f.y1 = f.y2 = 0;
  const w = 2 * Math.PI * freq / sr, sn = Math.sin(w), cs = Math.cos(w), al = sn / (2 * Q), a0 = 1 + al;
  f.b0 = al / a0; f.b1 = 0; f.b2 = -al / a0; f.a1 = (-2 * cs) / a0; f.a2 = (1 - al) / a0;
}
function _biqStep(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y; return y;
}

export default TimeSignalDecoder;
