/**
 * js8-reassembler.js — stitch JS8 frames into whole messages.
 *
 * A JS8 transmission longer than 12 characters is sent as several frames in
 * consecutive slots. Each frame carries `isFirst` / `isLast` flags (the i3bit
 * field), and frames belonging together are recognised by sitting at roughly
 * the same audio frequency. This module owns that state; js8.js stays
 * stateless.
 *
 * The policy is transcribed from JS8Call's mainwindow.cpp, which keeps the
 * equivalent state in `m_messageBuffer`:
 *
 *   - buffers are keyed by audio offset in Hz, matched within a per-submode
 *     tolerance (RX_THRESHOLD_HZ), and MIGRATE to the newest offset as the
 *     signal drifts (hasExistingMessageBuffer with drift=true)
 *   - a frame flagged first clears any buffer already open at that offset
 *   - a directed frame carrying a *buffered* command (MSG, relay, queries...)
 *     opens a buffer and waits for the data frames that carry its text
 *   - text is the concatenation of the data frames' text, right-trimmed
 *   - a buffer closes when a frame flagged last arrives
 *   - if nothing new arrives for 60 s the buffer is closed anyway; after 90 s
 *     it is discarded
 *   - after 1.5 T/R periods of silence an idle marker (MFI, "……") is appended
 *     to show the message is still hanging
 *
 * Buffered commands carry a CRC-16/KERMIT checksum at the end of the assembled
 * text; a message that fails it is dropped, exactly as JS8Call does.
 *
 * Time is passed in rather than read from the clock so the whole thing is
 * testable without waiting a minute and a half.
 */

import {
  RX_THRESHOLD_HZ, SUBMODE_PERIOD_S, BUFFERED_CMDS, CHECKSUM_CMDS,
  DIRECTED_CMDS, ALPHABET, NALPHABET, MFI,
} from './js8-tables.js';

/** Close an idle buffer after this long with no new frame. */
const CLOSE_AFTER_S = 60;
/** Discard a buffer entirely after this long. */
const DISCARD_AFTER_S = 90;
/** Append the idle marker after this many T/R periods of silence. */
const IDLE_PERIODS = 1.5;

/* ── CRC-16/KERMIT, as used by JS8Call's checksum16 ──────────────────────── */

const KERMIT_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? ((c >> 1) ^ 0x8408) : (c >> 1);
    t[i] = c;
  }
  return t;
})();

function crc16Kermit(str) {
  let crc = 0;
  for (let i = 0; i < str.length; i++) {
    crc = (crc >> 8) ^ KERMIT_TABLE[(crc ^ (str.charCodeAt(i) & 0xff)) & 0xff];
  }
  return crc & 0xffff;
}

/** Pack a 16-bit value as three base-41 characters (Varicode::pack16bits). */
export function pack16bits(value) {
  const a = Math.floor(value / (NALPHABET * NALPHABET));
  const b = Math.floor((value - a * NALPHABET * NALPHABET) / NALPHABET);
  const c = value % NALPHABET;
  return ALPHABET[a] + ALPHABET[b] + ALPHABET[c];
}

export function checksum16(text) {
  return pack16bits(crc16Kermit(text));
}

/* ── Reassembler ─────────────────────────────────────────────────────────── */

let nextId = 1;

export class Js8Reassembler {
  /**
   * @param {object}   [opts]
   * @param {function} [opts.onMessage] called with each completed message
   * @param {function} [opts.onFrame]   called with every frame, for live display
   * @param {string}   [opts.mfi]       idle marker appended to stalled messages
   */
  constructor({ onMessage = null, onFrame = null, mfi = MFI } = {}) {
    this.onMessage = onMessage;
    this.onFrame = onFrame;
    this.mfi = mfi;
    /** @type {Map<number, object>} open buffers, keyed by audio offset in Hz */
    this.buffers = new Map();
  }

  /** Tolerance, in Hz, within which two frames count as the same signal. */
  static threshold(submode) {
    return RX_THRESHOLD_HZ[submode] ?? RX_THRESHOLD_HZ[0];
  }

  /**
   * Find an open buffer near `freq`, migrating it to the new offset.
   * Mirrors hasExistingMessageBuffer(drift=true): the key follows the signal.
   */
  _find(freq, submode, drift) {
    const key = Math.round(freq);
    if (this.buffers.has(key)) return key;

    const range = Js8Reassembler.threshold(submode);
    for (let d = 1; d <= range; d++) {
      for (const k of [key - d, key + d]) {
        if (!this.buffers.has(k)) continue;
        if (drift) {
          this.buffers.set(key, this.buffers.get(k));
          this.buffers.delete(k);
          return key;
        }
        return k;
      }
    }
    return null;
  }

  _open(key, meta) {
    const buf = {
      id: nextId++,
      offset: key,
      submode: meta.submode,
      cmd: null,          // the directed frame that opened this buffer, if any
      parts: [],          // text pieces from data frames
      frames: 0,
      snrs: [],
      firstTime: meta.time,
      lastTime: meta.time,
      idleMarked: false,
    };
    this.buffers.set(key, buf);
    return buf;
  }

  /**
   * Feed one decoded frame.
   *
   * @param {object} frame from js8.js decodeFrame()
   * @param {object} meta  { freq, submode, snr, dt, time } -- time in ms
   * @returns {object[]}   messages completed by this frame (usually empty)
   */
  addFrame(frame, meta) {
    const out = [];
    const key = Math.round(meta.freq);

    if (this.onFrame) this.onFrame(frame, meta);

    // A frame flagged first abandons whatever was already open here: the
    // sender has started something new.
    if (frame.isFirst) {
      const existing = this._find(meta.freq, meta.submode, true);
      if (existing !== null) this.buffers.delete(existing);
    }

    if (frame.kind === 'data') {
      const found = this._find(meta.freq, meta.submode, true);
      const buf = found !== null ? this.buffers.get(found) : this._open(key, meta);

      buf.parts.push(frame.text ?? '');
      buf.frames++;
      buf.lastTime = meta.time;
      buf.idleMarked = false;
      if (Number.isFinite(meta.snr)) buf.snrs.push(meta.snr);

      if (frame.isLast) {
        const msg = this._close(buf, 'last');
        if (msg) out.push(msg);
      }
      return this._emit(out);
    }

    // Heartbeat, compound and directed frames.
    const cmdNum = frame.cmdRaw === null
      ? null
      : [...DIRECTED_CMDS].find(([, name]) => name === frame.cmdRaw)?.[0] ?? null;

    const buffered = cmdNum !== null && BUFFERED_CMDS.has(cmdNum);

    if (!buffered) {
      // Self-contained: a heartbeat, a grid, a plain directed command.
      const msg = {
        id: nextId++,
        kind: frame.kind,
        from: frame.from,
        to: frame.to,
        grid: frame.grid,
        cmd: frame.cmd,
        cmdNum,
        num: frame.num,
        text: frame.text ?? '',
        complete: true,
        reason: 'single',
        freq: meta.freq,
        submode: meta.submode,
        // Two decimals, as the multi-frame path does. The raw value is a
        // float straight from the decoder and renders as
        // "-8.734283447265625" otherwise.
        snr: Number.isFinite(meta.snr) ? Math.round(meta.snr * 100) / 100 : null,
        time: meta.time,
        frames: 1,
      };
      out.push(msg);
      return this._emit(out);
    }

    // A buffered command: open a buffer and wait for the data frames.
    const found = this._find(meta.freq, meta.submode, true);
    if (found !== null) this.buffers.delete(found);
    const buf = this._open(key, meta);
    buf.cmd = { ...frame, cmdNum };
    buf.frames = 1;
    if (Number.isFinite(meta.snr)) buf.snrs.push(meta.snr);

    if (frame.isLast) {
      const msg = this._close(buf, 'last');
      if (msg) out.push(msg);
    }
    return this._emit(out);
  }

  /**
   * Apply the time-based rules. Call this once per slot.
   * @param {number} now milliseconds
   * @returns {object[]} messages closed by a timeout
   */
  tick(now) {
    const out = [];

    for (const [key, buf] of [...this.buffers]) {
      const idleS = (now - buf.lastTime) / 1000;
      const period = SUBMODE_PERIOD_S[buf.submode] ?? SUBMODE_PERIOD_S[0];

      if (idleS > DISCARD_AFTER_S) {
        this.buffers.delete(key);
        continue;
      }
      if (idleS > CLOSE_AFTER_S) {
        const msg = this._close(buf, 'timeout');
        if (msg) out.push(msg);
        continue;
      }
      // Still waiting, but visibly stalled: show the reader it is unfinished.
      if (!buf.idleMarked && idleS > IDLE_PERIODS * period) {
        buf.idleMarked = true;
      }
    }

    return this._emit(out);
  }

  /** Assemble and remove a buffer. Returns the message, or null if rejected. */
  _close(buf, reason) {
    this.buffers.delete(buf.offset);

    let text = buf.parts.join('').replace(/\s+$/, '');
    let checksumValid = null;

    const cmdNum = buf.cmd?.cmdNum ?? null;
    if (cmdNum !== null && BUFFERED_CMDS.has(cmdNum)) {
      const size = CHECKSUM_CMDS.get(cmdNum);
      if (size === 16) {
        // JS8Call: strip leading space, take the last 3 characters as the
        // checksum and the separating space before them.
        const body = text.replace(/^\s+/, '');
        const checksum = body.slice(-3);
        const payload = body.slice(0, body.length - 4);
        checksumValid = checksum16(payload) === checksum;
        if (!checksumValid) return null;   // JS8Call discards these outright
        text = payload;
      } else if (size === 0) {
        checksumValid = true;
      }
    }

    if (buf.idleMarked) text += this.mfi;

    const snrs = buf.snrs;
    return {
      id: buf.id,
      kind: buf.cmd ? buf.cmd.kind : 'data',
      from: buf.cmd?.from ?? null,
      to: buf.cmd?.to ?? null,
      grid: buf.cmd?.grid ?? null,
      cmd: buf.cmd?.cmd ?? null,
      cmdNum,
      num: buf.cmd?.num ?? null,
      text,
      complete: reason === 'last',
      reason,
      checksumValid,
      freq: buf.offset,
      submode: buf.submode,
      snr: snrs.length
        ? Math.round((snrs.reduce((a, b) => a + b, 0) / snrs.length) * 100) / 100
        : null,
      time: buf.firstTime,
      frames: buf.frames,
    };
  }

  _emit(list) {
    if (this.onMessage) for (const m of list) this.onMessage(m);
    return list;
  }

  /** Snapshot of everything still being assembled, for a live UI. */
  pending() {
    return [...this.buffers.values()].map((b) => ({
      id: b.id,
      freq: b.offset,
      submode: b.submode,
      from: b.cmd?.from ?? null,
      to: b.cmd?.to ?? null,
      cmd: b.cmd?.cmd ?? null,
      text: b.parts.join('') + (b.idleMarked ? this.mfi : ''),
      frames: b.frames,
      time: b.firstTime,
    }));
  }

  /** Drop all state (band change, decoder restart). */
  reset() {
    this.buffers.clear();
  }
}
