/**
 * js8.js — JS8 message layer for PhantomSDR-Plus.
 *
 * The wasm decoder (jsdsp/js8_wasm) hands back 75 raw payload bits per frame
 * and stops there, because a JS8 frame is not a message. This module turns
 * those bits into a structured frame:
 *
 *   payload bits 0..2   frame type  (heartbeat / compound / directed / data)
 *   payload bits 3..71  type-specific fields
 *   payload bits 72..74 i3bit, a BITFIELD: first-frame / last-frame / raw-data
 *
 * Stitching consecutive frames into a whole message is Phase 3 and lives
 * elsewhere; everything here is stateless apart from the lazily-loaded
 * compression dictionary.
 *
 * Ported from JS8Call's varicode.cpp and jsc.cpp (GPL-3.0). Where the upstream
 * code has quirks they are reproduced deliberately and flagged in comments --
 * a "cleaner" version would simply decode different text.
 */

import {
  ALPHABET72, ALPHANUMERIC,
  NBASECALL, NBASEGRID, NUSERGRID, NMAXGRID,
  I3_FIRST, I3_LAST, I3_DATA,
  FRAME_HEARTBEAT, FRAME_COMPOUND, FRAME_COMPOUND_DIRECTED, FRAME_DIRECTED,
  BASECALLS, DIRECTED_CMDS, SNR_CMDS, HUFF_DECODE,
} from './js8-tables.js';

/* ── Bit helpers ─────────────────────────────────────────────────────────── */

/** Expand the wasm's 10 payload bytes into 75 individual bits, MSB first. */
export function payloadToBits(bytes) {
  const bits = new Uint8Array(75);
  for (let i = 0; i < 75; i++) {
    bits[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  }
  return bits;
}

function bitsToInt(bits, start, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 2 + bits[start + i];
  return v;
}

/* ── Grid ────────────────────────────────────────────────────────────────── */

function deg2grid(dlong, dlat) {
  if (dlong < -180) dlong += 360;
  if (dlong > 180) dlong -= 360;

  const grid = new Array(6);
  let n = Math.trunc((60.0 * (180.0 - dlong)) / 5);
  let n1 = Math.trunc(n / 240);
  let n2 = Math.trunc((n - 240 * n1) / 24);
  let n3 = n - 240 * n1 - 24 * n2;
  grid[0] = String.fromCharCode(65 + n1);
  grid[2] = String.fromCharCode(48 + n2);
  grid[4] = String.fromCharCode(97 + n3);

  n = Math.trunc((60.0 * (dlat + 90)) / 2.5);
  n1 = Math.trunc(n / 240);
  n2 = Math.trunc((n - 240 * n1) / 24);
  n3 = n - 240 * n1 - 24 * n2;
  grid[1] = String.fromCharCode(65 + n1);
  grid[3] = String.fromCharCode(48 + n2);
  grid[5] = String.fromCharCode(97 + n3);

  return grid.join('');
}

export function unpackGrid(value) {
  if (value > NBASEGRID) return '';
  const dlat = (value % 180) - 90;
  const dlong = Math.trunc(value / 180) * 2 - 180 + 2;
  return deg2grid(dlong, dlat).slice(0, 4);
}

/* ── Callsigns ───────────────────────────────────────────────────────────── */

/** 28-bit base callsign, or one of the special group values (@ALLCALL etc). */
export function unpackCallsign(value, portable) {
  const special = BASECALLS.get(value);
  if (special !== undefined) return special;

  const word = new Array(6);
  let v = value;

  for (let i = 5; i >= 3; i--) {
    word[i] = ALPHANUMERIC[(v % 27) + 10];
    v = Math.trunc(v / 27);
  }
  word[2] = ALPHANUMERIC[v % 10];
  v = Math.trunc(v / 10);
  word[1] = ALPHANUMERIC[v % 36];
  v = Math.trunc(v / 36);
  word[0] = ALPHANUMERIC[v] ?? ' ';

  let callsign = word.join('');

  // Upstream workarounds for Swaziland and Guinea, which do not fit the
  // packing pattern. These must be undone in the same order they were applied.
  if (callsign.startsWith('3D0')) callsign = '3DA0' + callsign.slice(3);
  if (callsign.startsWith('Q') && callsign[1] >= 'A' && callsign[1] <= 'Z') {
    callsign = '3X' + callsign.slice(1);
  }

  callsign = callsign.trim();
  return portable ? callsign + '/P' : callsign;
}

/** 50-bit compound callsign: up to 11 characters with two optional slashes. */
export function unpackAlphaNumeric50(packed) {
  const word = new Array(11);
  let v = packed;

  for (let i = 10; i >= 8; i--) {
    word[i] = ALPHANUMERIC[Number(v % 38n)];
    v /= 38n;
  }
  word[7] = (v % 2n) ? '/' : ' ';
  v /= 2n;
  for (let i = 6; i >= 4; i--) {
    word[i] = ALPHANUMERIC[Number(v % 38n)];
    v /= 38n;
  }
  word[3] = (v % 2n) ? '/' : ' ';
  v /= 2n;
  for (let i = 2; i >= 1; i--) {
    word[i] = ALPHANUMERIC[Number(v % 38n)];
    v /= 38n;
  }
  // NB: 39 here, not 38 -- upstream asymmetry between pack and unpack. The
  // alphabet is 39 characters long, so index 38 ('@') is only reachable in
  // this first position.
  word[0] = ALPHANUMERIC[Number(v % 39n)] ?? ' ';

  return word.join('').replace(/ /g, '');
}

/* ── Commands ────────────────────────────────────────────────────────────── */

function formatSNR(n) {
  // Mirrors Varicode::formatSNR: out-of-range yields an empty string, and the
  // zero padding is to two digits after the sign.
  if (n < -60 || n > 60) return '';
  return (n >= 0 ? '+' : '-') + String(Math.abs(n)).padStart(2, '0');
}

/** Split the 8-bit "extra" field of a compound frame into command + number. */
function unpackCmd(value) {
  if (value & (1 << 7)) {
    // Top bit set: an SNR report with the value in the low 6 bits.
    // Bit 6 selects HEARTBEAT SNR over plain SNR.
    const cmd = (value & (1 << 6)) ? 29 : 25;
    return { cmd, num: value & 0x3f };
  }
  return { cmd: value & 0x7f, num: 0 };
}

/** Raw command text, exactly as JS8Call stores it (most entries lead with a space). */
function cmdRaw(cmd) {
  return DIRECTED_CMDS.get(cmd) ?? '';
}

/* ── Huffman-coded text (plain data frames) ──────────────────────────────── */

let HUFF_MIN = Infinity;
let HUFF_MAX = 0;
for (const code of HUFF_DECODE.keys()) {
  if (code.length < HUFF_MIN) HUFF_MIN = code.length;
  if (code.length > HUFF_MAX) HUFF_MAX = code.length;
}

function huffDecode(bits) {
  let s = '';
  let text = '';
  for (let i = 0; i < bits.length; i++) s += bits[i] ? '1' : '0';

  let pos = 0;
  while (pos < s.length) {
    let matched = false;
    for (let len = HUFF_MIN; len <= HUFF_MAX && pos + len <= s.length; len++) {
      const ch = HUFF_DECODE.get(s.slice(pos, pos + len));
      if (ch !== undefined) {
        text += ch;
        pos += len;
        matched = true;
        break;
      }
    }
    if (!matched) break;   // trailing bits that do not form a codeword
  }
  return text;
}

/* ── JSC dictionary (compressed data frames) ─────────────────────────────── */

let DICT = null;          // Array-like of 262144 strings, or null until loaded
let DICT_PROMISE = null;

/**
 * Fetch and decode the JSC word dictionary.
 *
 * It is ~1.9 MB (about 1 MB over the wire once the server gzips it), so it is
 * NOT loaded up front. Heartbeats, compound frames and directed commands never
 * need it; only compressed data frames do. Call this when one first appears,
 * or eagerly if you would rather trade the bandwidth for latency.
 */
export function loadDictionary(url = new URL('../decoders/js8_dict.bin', import.meta.url).href) {
  if (DICT) return Promise.resolve(DICT);
  if (DICT_PROMISE) return DICT_PROMISE;

  DICT_PROMISE = (async () => {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`[js8] fetch ${url} -> ${resp.status}`);
    const buf = new Uint8Array(await resp.arrayBuffer());

    if (buf[0] !== 0x4a || buf[1] !== 0x53 || buf[2] !== 0x38 || buf[3] !== 0x44) {
      throw new Error('[js8] dictionary: bad magic');
    }
    const version = buf[4];
    if (version !== 1) throw new Error(`[js8] dictionary: version ${version}`);

    const view = new DataView(buf.buffer, buf.byteOffset);
    const count = view.getUint32(5, true);

    // Layout: magic(4) version(1) count(4) lengths(count) then the words,
    // concatenated. Lengths come first so the offsets can be built in one pass.
    const lengths = buf.subarray(9, 9 + count);
    let off = 9 + count;

    // The dictionary is Latin-1, not UTF-8 (JSC::decompress reads it as
    // QLatin1String), so decode it as such.
    const dec = new TextDecoder('latin1');
    const words = new Array(count);
    for (let i = 0; i < count; i++) {
      const len = lengths[i];
      words[i] = dec.decode(buf.subarray(off, off + len));
      off += len;
    }

    DICT = words;
    return DICT;
  })();

  return DICT_PROMISE;
}

/** True once the dictionary is in memory; compressed frames need it. */
export function dictionaryReady() {
  return DICT !== null;
}

/**
 * (s, c)-dense partial-word decoding against the JSC dictionary.
 * Faithful port of JSC::decompress().
 */
function jscDecompress(bits) {
  if (!DICT) return null;

  const s = 7;
  const c = 16 - s;      // 2^b - s, with b = 4
  const size = DICT.length;

  const base = [0, s];
  for (let k = 2; k < 8; k++) base[k] = base[k - 1] + s * Math.pow(c, k - 1);

  const bytes = [];
  const separators = [];

  let i = 0;
  while (i < bits.length) {
    if (i + 4 > bits.length) break;
    const byte = bitsToInt(bits, i, 4);
    bytes.push(byte);
    i += 4;

    if (byte < s) {
      // A low nibble is followed by one separator bit saying whether a space
      // follows the word that ends here.
      if (bits.length - i > 0 && bits[i]) separators.push(bytes.length - 1);
      i += 1;
    }
  }

  const out = [];
  let start = 0;
  let sepIdx = 0;

  while (start < bytes.length) {
    let k = 0;
    let j = 0;
    while (start + k < bytes.length && bytes[start + k] >= s) {
      j = j * c + (bytes[start + k] - s);
      k++;
    }
    if (j >= size) break;
    if (start + k >= bytes.length) break;

    j = j * s + bytes[start + k] + base[k];
    if (j >= size) break;

    out.push(DICT[j]);
    if (sepIdx < separators.length && separators[sepIdx] === start + k) {
      out.push(' ');
      sepIdx++;
    }
    start += k + 1;
  }

  return out.join('');
}

/* ── Frame decoding ──────────────────────────────────────────────────────── */

/** Strip the pad: a single 0 bit followed by all 1s. Returns the payload bits. */
function unpad(bits, from) {
  let last0 = -1;
  for (let i = bits.length - 1; i >= 0; i--) {
    if (!bits[i]) { last0 = i; break; }
  }
  if (last0 < from) return bits.slice(from, from);   // empty
  return bits.slice(from, last0);
}

function decodeData(bits, i3bit) {
  // A frame flagged JS8CallData in i3bit has no frame-type header at all: all
  // 72 bits are payload, and it is always dictionary-compressed. Otherwise the
  // header is [1][compressed][70 bits of payload], where the leading 1 doubles
  // as the top bit of the frame type ([10X] plain, [11X] compressed).
  const flagged = (i3bit & I3_DATA) !== 0;
  const compressed = flagged ? true : bits[1] === 1;
  const body = flagged ? unpad(bits, 0) : unpad(bits, 2);

  let text = null;
  let needsDictionary = false;

  if (compressed) {
    text = jscDecompress(body);
    if (text === null) needsDictionary = true;
  } else {
    text = huffDecode(body);
  }

  return { compressed, text, needsDictionary };
}

/**
 * Decode one JS8 frame.
 *
 * @param {Uint8Array} payload 10 bytes from js8_get_payload()
 * @param {number} i3bit       from js8_get_i3bit()
 * @returns {object} structured frame; `kind` says which fields are meaningful
 */
export function decodeFrame(payload, i3bit) {
  // Only the first 72 bits are the frame; bits 72..74 are i3bit and must not
  // take part in anything below -- in particular the data-frame pad scan,
  // which searches backwards for the last zero bit.
  const bits = payloadToBits(payload).subarray(0, 72);

  const frame = {
    i3bit,
    isFirst: (i3bit & I3_FIRST) !== 0,
    isLast: (i3bit & I3_LAST) !== 0,
    isDataFlagged: (i3bit & I3_DATA) !== 0,
    frameType: bitsToInt(bits, 0, 3),
    kind: null,
    from: null,
    to: null,
    grid: null,
    cmd: null,      // trimmed, for display
    cmdRaw: null,   // exactly as JS8Call stores it (usually leading-space)
    num: null,
    text: null,
    compressed: false,
    needsDictionary: false,
  };

  if (frame.isDataFlagged) {
    frame.kind = 'data';
    Object.assign(frame, decodeData(bits, i3bit));
    return frame;
  }

  const type = frame.frameType;

  // [1][1][70]: any type with the top bit set is a data frame.
  if (type >= 4) {
    frame.kind = 'data';
    Object.assign(frame, decodeData(bits, i3bit));
    return frame;
  }

  if (type === FRAME_DIRECTED) {
    // [3][28 from][28 to][5 cmd][1 portable_from][1 portable_to][6 extra] = 72
    const packedFrom = bitsToInt(bits, 3, 28);
    const packedTo = bitsToInt(bits, 31, 28);
    const packedCmd = bitsToInt(bits, 59, 5);
    const extraByte = bitsToInt(bits, 64, 8);

    const portableFrom = (extraByte >> 7) & 1;
    const portableTo = (extraByte >> 6) & 1;
    const extra = extraByte % 64;

    frame.kind = 'directed';
    frame.from = unpackCallsign(packedFrom, !!portableFrom);
    frame.to = unpackCallsign(packedTo, !!portableTo);
    frame.cmdRaw = cmdRaw(packedCmd % 32);
    frame.cmd = frame.cmdRaw.trim();

    if (extra !== 0) {
      frame.num = SNR_CMDS.has(packedCmd % 32) ? formatSNR(extra - 31) : String(extra - 31);
    }
    return frame;
  }

  // Heartbeat, compound and compound-directed share one layout:
  // [3][50 callsign][11 num_hi][5 num_lo][3 unused] = 72
  const packedCallsign = BigInt(bitsToInt(bits, 3, 26)) * 16777216n +
                         BigInt(bitsToInt(bits, 29, 24));
  const packed11 = bitsToInt(bits, 53, 11);
  const packed8 = bitsToInt(bits, 64, 8);
  const packed5 = packed8 >> 3;
  const num = (packed11 << 5) | packed5;

  frame.from = unpackAlphaNumeric50(packedCallsign);

  if (type === FRAME_HEARTBEAT) {
    frame.kind = 'heartbeat';
    frame.grid = unpackGrid(num & 0x7fff);
    frame.isAlt = (num & 0x8000) !== 0;
    return frame;
  }

  frame.kind = type === FRAME_COMPOUND ? 'compound' : 'compound_directed';

  if (num <= NBASEGRID) {
    frame.grid = unpackGrid(num);
  } else if (num >= NUSERGRID && num < NMAXGRID) {
    // Grids above the user-grid reference are re-used to carry a command.
    const { cmd, num: n } = unpackCmd(num - NUSERGRID);
    frame.cmdRaw = cmdRaw(cmd);
    frame.cmd = frame.cmdRaw.trim();
    if (SNR_CMDS.has(cmd)) frame.num = formatSNR(n - 31);
  }
  return frame;
}
