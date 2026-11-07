// dsc.js — MF/HF Digital Selective Calling decoder (receive only)
// ============================================================================
// DSC is the GMDSS calling system (ITU-R M.493). On MF/HF it is F1B: 100 baud,
// 170 Hz shift, sent on a carrier 1700 Hz above the USB dial, so the two tones
// are at 1615 Hz (Y, binary 1) and 1785 Hz (B, binary 0) in the audio.
//
// Character layer
//   10-bit characters: 7 information bits, least significant first, then 3
//   check bits giving the number of 0 (B) bits among the 7, most significant
//   first. Values 0..99 carry two decimal digits, 100..127 are symbols
//   (format, category, telecommand, end of sequence...).
//
// Time diversity
//   Every character goes out twice, in the DX and the RX position, which
//   alternate. The call opens with a dot pattern, then the phasing sequence:
//   DX positions carry 125, RX positions count down 111, 110 ... 104. The
//   message follows in both streams, and each character's RX copy comes two
//   characters later in the RX stream than in the DX one (five slots, 0.5 s):
//   character i is DX[i] when its check bits pass, else RX[i + 2]. Measured
//   on real coast-station calls received here on 6312 and 8414.5 kHz.
//
// Message layer
//   format specifier (twice), then by format: address (5 chars = 10 digits),
//   category, self-ID (5 chars), telecommands, frequency or position,
//   end of sequence (117 / 122 / 127) and an error-check character (ECC):
//   the XOR of the information bits of every character from the format
//   specifier (once) to the end of sequence.
//
// Interface, like the other engines in this tree:
//   new DscDecoder({ sampleRate, centerHz, onMessage, onStatus, onMetrics })
//   .feed(Float32Array); .setCenter(hz); .reset();
// ============================================================================

const BAUD = 100;
const SHIFT = 170;
const SPB = 16;                       // discriminator samples per bit
const BB_RATE = BAUD * SPB;           // 1600 Hz
const MAX_SLOTS = 140;                // longest call we collect, in characters

// ── Symbol tables (ITU-R M.493) ────────────────────────────────────────────
export const DSC_FORMAT = {
  102: 'Geographic area', 112: 'Distress', 114: 'Group', 116: 'All ships',
  120: 'Individual', 123: 'Automatic / semi-automatic',
};
export const DSC_CATEGORY = { 100: 'Routine', 103: 'Not used', 108: 'Safety', 110: 'Urgency', 112: 'Distress' };
export const DSC_TC1 = {
  100: 'F3E/G3E all modes TP', 101: 'F3E/G3E duplex TP', 103: 'Polling', 104: 'Unable to comply',
  105: 'End of call', 106: 'Data', 109: 'J3E TP', 110: 'Distress acknowledgement',
  112: 'Distress relay', 113: 'F1B/J2B TTY-FEC', 115: 'F1B/J2B TTY-ARQ', 118: 'Test',
  121: 'Ship position / location registration', 126: 'No information',
};
export const DSC_TC2 = {
  100: 'No reason given', 101: 'Congestion', 102: 'Busy', 103: 'Queue indication',
  104: 'Station barred', 105: 'No operator available', 106: 'Operator temporarily unavailable',
  107: 'Equipment disabled', 108: 'Unable to use proposed channel', 109: 'Unable to use proposed mode',
  110: 'Ships/aircraft of states not party to an armed conflict', 111: 'Medical transports',
  112: 'Pay-phone / public call office', 113: 'Facsimile / data', 126: 'No information',
};
export const DSC_DISTRESS = {
  100: 'Fire, explosion', 101: 'Flooding', 102: 'Collision', 103: 'Grounding',
  104: 'Listing, in danger of capsizing', 105: 'Sinking', 106: 'Disabled and adrift',
  107: 'Undesignated distress', 108: 'Abandoning ship', 109: 'Piracy / armed robbery',
  110: 'Man overboard', 112: 'EPIRB emission',
};
export const DSC_EOS = { 117: 'Acknowledgement requested', 122: 'Acknowledgement given', 127: 'End of sequence' };

// Maritime Identification Digits → flag (the common ones; unknown → '').
const MID = {
  201: 'Albania', 202: 'Andorra', 203: 'Austria', 204: 'Azores', 205: 'Belgium', 206: 'Belarus',
  207: 'Bulgaria', 208: 'Vatican', 209: 'Cyprus', 210: 'Cyprus', 211: 'Germany', 212: 'Cyprus',
  213: 'Georgia', 214: 'Moldova', 215: 'Malta', 216: 'Armenia', 218: 'Germany', 219: 'Denmark',
  220: 'Denmark', 224: 'Spain', 225: 'Spain', 226: 'France', 227: 'France', 228: 'France',
  229: 'Malta', 230: 'Finland', 231: 'Faroe Islands', 232: 'United Kingdom', 233: 'United Kingdom',
  234: 'United Kingdom', 235: 'United Kingdom', 236: 'Gibraltar', 237: 'Greece', 238: 'Croatia',
  239: 'Greece', 240: 'Greece', 241: 'Greece', 242: 'Morocco', 243: 'Hungary', 244: 'Netherlands',
  245: 'Netherlands', 246: 'Netherlands', 247: 'Italy', 248: 'Malta', 249: 'Malta', 250: 'Ireland',
  251: 'Iceland', 252: 'Liechtenstein', 253: 'Luxembourg', 254: 'Monaco', 255: 'Madeira',
  256: 'Malta', 257: 'Norway', 258: 'Norway', 259: 'Norway', 261: 'Poland', 262: 'Montenegro',
  263: 'Portugal', 264: 'Romania', 265: 'Sweden', 266: 'Sweden', 267: 'Slovakia', 268: 'San Marino',
  269: 'Switzerland', 270: 'Czechia', 271: 'Türkiye', 272: 'Ukraine', 273: 'Russia',
  274: 'North Macedonia', 275: 'Latvia', 276: 'Estonia', 277: 'Lithuania', 278: 'Slovenia',
  279: 'Serbia', 303: 'USA (Alaska)', 304: 'Antigua and Barbuda', 305: 'Antigua and Barbuda',
  308: 'Bahamas', 309: 'Bahamas', 310: 'Bermuda', 311: 'Bahamas', 312: 'Belize', 314: 'Barbados',
  316: 'Canada', 319: 'Cayman Islands', 338: 'USA', 341: 'St Kitts and Nevis', 351: 'Panama',
  352: 'Panama', 353: 'Panama', 354: 'Panama', 355: 'Panama', 356: 'Panama', 357: 'Panama',
  366: 'USA', 367: 'USA', 368: 'USA', 369: 'USA', 370: 'Panama', 371: 'Panama', 372: 'Panama',
  373: 'Panama', 374: 'Panama', 375: 'St Vincent and Grenadines', 376: 'St Vincent and Grenadines',
  377: 'St Vincent and Grenadines', 412: 'China', 413: 'China', 414: 'China', 416: 'Taiwan',
  419: 'India', 422: 'Iran', 428: 'Israel', 431: 'Japan', 432: 'Japan', 440: 'Korea', 441: 'Korea',
  447: 'Kuwait', 450: 'Lebanon', 455: 'Maldives', 461: 'Oman', 463: 'Pakistan', 466: 'Qatar',
  470: 'UAE', 471: 'UAE', 477: 'Hong Kong', 503: 'Australia', 512: 'New Zealand', 518: 'Cook Islands',
  525: 'Indonesia', 533: 'Malaysia', 538: 'Marshall Islands', 548: 'Philippines', 563: 'Singapore',
  564: 'Singapore', 565: 'Singapore', 566: 'Singapore', 567: 'Thailand', 572: 'Tuvalu',
  574: 'Vietnam', 577: 'Vanuatu', 601: 'South Africa', 605: 'Algeria', 620: 'Comoros',
  622: 'Egypt', 636: 'Liberia', 637: 'Liberia', 642: 'Libya', 657: 'Nigeria', 667: 'Sierra Leone',
  672: 'Tunisia', 677: 'Tanzania', 710: 'Brazil', 725: 'Chile', 730: 'Colombia', 735: 'Ecuador',
  775: 'Venezuela',
};

// ── Character coding ───────────────────────────────────────────────────────

/** 10 bits (first transmitted first) → value 0..127, or -1 if the check fails. */
export function dscSymbol(bits) {
  let v = 0, zeros = 0;
  for (let i = 0; i < 7; i++) { if (bits[i]) v |= 1 << i; else zeros++; }
  const chk = (bits[7] << 2) | (bits[8] << 1) | bits[9];
  return chk === zeros ? v : -1;
}

/** value 0..127 → its 10 transmitted bits (test helper, and documentation). */
export function dscBits(v) {
  const b = [];
  let zeros = 0;
  for (let i = 0; i < 7; i++) { const x = (v >> i) & 1; b.push(x); if (!x) zeros++; }
  b.push((zeros >> 2) & 1, (zeros >> 1) & 1, zeros & 1);
  return b;
}

const two = (v) => (v >= 0 && v <= 99 ? String(v).padStart(2, '0') : null);

function digits(chars) {
  let s = '';
  for (const c of chars) { const d = two(c); if (d === null) return null; s += d; }
  return s;
}

/** 5 characters → { mmsi, kind, country } (kind: ship, coast, group). */
export function dscMmsi(chars) {
  const d = digits(chars);
  if (!d) return null;
  const mmsi = d.slice(0, 9);
  let kind = 'ship', mid = mmsi.slice(0, 3);
  if (mmsi.startsWith('00')) { kind = 'coast'; mid = mmsi.slice(2, 5); }
  else if (mmsi.startsWith('0')) { kind = 'group'; mid = mmsi.slice(1, 4); }
  return { mmsi, kind, country: MID[Number(mid)] || '' };
}

/** 3 (or 4) characters → frequency text. */
function dscFreq(chars) {
  if (chars.every((c) => c === 126)) return 'no information';
  const d = digits(chars);
  if (!d) return null;
  const h = d[0];
  if (h === '9') return `VHF channel ${Number(d.slice(2))}`;
  if (h === '3') return `MF/HF channel ${Number(d.slice(1))}`;
  if (h === '4' && d.length === 8) return `${(Number(d.slice(1)) / 100).toFixed(2)} kHz`;
  return `${(Number(d) / 10).toFixed(1)} kHz`;
}

/** 5 characters → position text (quadrant digit, lat dd mm, lon ddd mm). */
function dscPosition(chars) {
  const d = digits(chars);
  if (!d) return null;
  if (/^9{10}$/.test(d)) return 'position not given';
  const q = Number(d[0]);
  const lat = `${d.slice(1, 3)}°${d.slice(3, 5)}'${q === 2 || q === 3 ? 'S' : 'N'}`;
  const lon = `${d.slice(5, 8)}°${d.slice(8, 10)}'${q === 1 || q === 3 ? 'W' : 'E'}`;
  const latDeg = (Number(d.slice(1, 3)) + Number(d.slice(3, 5)) / 60) * (q === 2 || q === 3 ? -1 : 1);
  const lonDeg = (Number(d.slice(5, 8)) + Number(d.slice(8, 10)) / 60) * (q === 1 || q === 3 ? -1 : 1);
  return { text: `${lat} ${lon}`, lat: latDeg, lon: lonDeg };
}

function dscTime(chars) {
  const d = digits(chars);
  if (!d) return null;
  if (d === '8888') return 'time not given';
  return `${d.slice(0, 2)}:${d.slice(2)} UTC`;
}

/**
 * Parse a merged character sequence (format specifier first, twice) into a
 * message object. Characters that failed both copies are -1.
 */
export function dscParse(chars) {
  const c = chars.slice();
  if (c[0] < 0 && c[1] >= 0) c[0] = c[1];
  if (c[1] < 0 && c[0] >= 0) c[1] = c[0];
  // One character lost in both copies can be rebuilt from the error-check
  // character: ECC is the XOR of every character from the format specifier
  // (once) to EOS, so the missing one is ECC XOR all the others.
  const eos0 = c.findIndex((v, k) => k >= 2 && (v === 117 || v === 122 || v === 127));
  let recovered = false;
  if (eos0 > 0 && eos0 + 1 < c.length && c[eos0 + 1] >= 0 && c[0] >= 0) {
    const miss = [];
    for (let k = 2; k <= eos0; k++) if (c[k] < 0) miss.push(k);
    if (miss.length === 1) {
      let x = c[eos0 + 1] ^ c[0];
      for (let k = 2; k <= eos0; k++) if (k !== miss[0]) x ^= c[k];
      c[miss[0]] = x & 0x7f;
      recovered = true;
    }
  }
  const fmt = c[0];
  const m = { format: fmt, formatText: DSC_FORMAT[fmt] || `Format ${fmt}`, fields: [], errors: 0 };
  let i = 2;
  const take = (n) => { const s = c.slice(i, i + n); i += n; return s; };
  const add = (label, value) => { if (value !== null && value !== undefined && value !== '') m.fields.push([label, value]); };
  const idText = (x) => (x ? `${x.mmsi}${x.kind !== 'ship' ? ` (${x.kind})` : ''}${x.country ? ` · ${x.country}` : ''}` : '?');

  const eosAt = c.findIndex((v, k) => k >= 2 && (v === 117 || v === 122 || v === 127));
  const end = eosAt > 0 ? eosAt : c.length;

  if (fmt === 112) {
    m.category = 112;
    m.self = dscMmsi(take(5));
    add('From', idText(m.self));
    const nat = take(1)[0];
    add('Nature', DSC_DISTRESS[nat] || `code ${nat}`);
    const pos = dscPosition(take(5));
    if (pos && typeof pos === 'object') { m.pos = pos; add('Position', pos.text); } else add('Position', pos);
    add('Time', dscTime(take(2)));
    const sub = take(1)[0];
    add('Follow-up', DSC_TC1[sub] || `code ${sub}`);
  } else {
    if (fmt === 102) {
      const area = dscPosition(take(5));
      add('Area', area && typeof area === 'object' ? area.text : area);
    } else if (fmt === 114 || fmt === 120 || fmt === 123) {
      m.to = dscMmsi(take(5));
      add('To', idText(m.to));
    }
    m.category = take(1)[0];
    add('Category', DSC_CATEGORY[m.category] || `code ${m.category}`);
    m.self = dscMmsi(take(5));
    add('From', idText(m.self));
    const tc1 = take(1)[0], tc2 = take(1)[0];
    m.tc1 = tc1;
    add('Telecommand', DSC_TC1[tc1] || `code ${tc1}`);
    if (tc2 !== 126) add('Telecommand 2', DSC_TC2[tc2] || `code ${tc2}`);
    const rest = c.slice(i, end);
    if (tc1 === 110 || tc1 === 112) {
      // Distress acknowledgement / relay: the distressed ship's details.
      let k = 0;
      const sub = (n) => { const s = rest.slice(k, k + n); k += n; return s; };
      add('Distressed', idText(dscMmsi(sub(5))));
      const nat = sub(1)[0];
      add('Nature', DSC_DISTRESS[nat] || `code ${nat}`);
      const pos = dscPosition(sub(5));
      if (pos && typeof pos === 'object') { m.pos = pos; add('Position', pos.text); } else add('Position', pos);
      add('Time', dscTime(sub(2)));
    } else if (tc1 === 121 && rest.length >= 5) {
      const pos = dscPosition(rest.slice(0, 5));
      if (pos && typeof pos === 'object') { m.pos = pos; add('Position', pos.text); } else add('Position', pos);
      if (rest.length >= 7) add('Time', dscTime(rest.slice(5, 7)));
    } else if (rest.length >= 3) {
      const n1 = rest[0] >= 40 && rest[0] <= 49 ? 4 : 3;
      const f1 = dscFreq(rest.slice(0, n1));
      const r2 = rest.slice(n1);
      const f2 = r2.length >= 3 ? dscFreq(r2.slice(0, r2[0] >= 40 && r2[0] <= 49 ? 4 : 3)) : null;
      // "RX / TX" when both are given and differ; nothing when neither is.
      if (f1 && f1 !== 'no information') add(f2 && f2 !== 'no information' && f2 !== f1 ? 'Frequency (RX)' : 'Frequency', f1);
      if (f2 && f2 !== 'no information' && f2 !== f1) add('Frequency (TX)', f2);
    }
  }

  m.eos = eosAt > 0 ? c[eosAt] : -1;
  add('End', DSC_EOS[m.eos] || 'not received');
  // ECC: XOR of the information bits from the format specifier (once) to EOS.
  // Only a call with every character present can be confirmed; one rebuilt
  // from the ECC is confirmed by construction and marked as such.
  m.errors = c.slice(0, end + 1).filter((v) => v < 0).length;
  m.recovered = recovered;
  if (eosAt > 0 && eosAt + 1 < c.length && c[eosAt + 1] >= 0 && m.errors === 0) {
    let x = fmt;
    for (let k = 2; k <= eosAt; k++) x ^= c[k];
    m.eccOk = recovered ? null : x === c[eosAt + 1];
  } else {
    m.eccOk = null;
  }
  return m;
}

// ── HF Selcall (CCIR 493-4 / Codan) ─────────────────────────────────────────
// The same physical layer, characters, phasing (RX from 109) and DX/RX
// repetition as DSC; the message is shorter and has no ECC character:
//   format, called address, category, caller address, [command(s)],
//   [data digits], end of sequence.
// Unlike DSC the format specifier is sent ONCE in the DX stream (the RX
// positions around it carry extra copies), measured on the Signal
// Identification Wiki recordings.
// Addresses are 4 digits (2 characters) or 6 digits (3); which one is read
// from where the category character (≥ 100) falls. Message layout and the
// Codan position command (121) follow KiwiSDR's Selcall decoder
// (John Seamons) and the Signal Identification Wiki.
export const SELCALL_FORMAT = { 102: 'Geographic', 112: 'Emergency', 114: 'Group call', 116: 'All stations', 120: 'Selective call', 123: 'Selective call (semi-auto / phone)' };
export const SELCALL_CATEGORY = { 100: 'Routine', 106: 'Business', 108: 'Safety', 110: 'Urgency', 112: 'Emergency' };
export const SELCALL_CMD = {
  100: 'Voice call (all modes)', 101: 'Voice, duplex', 102: 'Message / data', 103: 'Polling', 104: 'Unable to comply',
  105: 'End of call', 106: 'Data', 109: 'Voice (J3E)', 110: 'Acknowledgement', 112: 'Relay', 113: 'TTY-FEC', 115: 'TTY-ARQ',
  118: 'Test', 121: 'Position (GPS) report', 126: 'No information',
};

export function selcallParse(chars) {
  const c = chars.slice();
  const fmt = c[0];
  const m = { format: fmt, formatText: SELCALL_FORMAT[fmt] || `Format ${fmt}`, fields: [], selcall: true };
  const add = (k, v) => { if (v !== null && v !== undefined && v !== '') m.fields.push([k, v]); };
  let i = c[1] === fmt ? 2 : 1;          // a doubled format specifier is skipped
  // called address: digit characters up to the category
  let k = i;
  while (k < c.length && k < i + 4 && c[k] >= 0 && c[k] <= 99) k++;
  const nAddr = k - i;
  if ((nAddr !== 2 && nAddr !== 3) || !(c[k] >= 100 && c[k] <= 112)) return null;
  const digitsOf = (arr) => arr.map((v) => String(v).padStart(2, '0')).join('');
  m.to = digitsOf(c.slice(i, k)).replace(/^00(?=\d{4}$)/, '');
  m.category = c[k];
  i = k + 1;
  const self = c.slice(i, i + nAddr);
  if (self.length < nAddr || self.some((v) => v < 0 || v > 99)) return null;
  m.self = digitsOf(self).replace(/^00(?=\d{4}$)/, '');
  i += nAddr;
  add('Call', `${m.self} calling ${m.to}`);
  add('Category', SELCALL_CATEGORY[m.category] || `code ${m.category}`);
  // commands (≥ 100, not end of sequence), then data digits, until EOS
  const cmds = [], data = [];
  let eos = -1, errors = 0;
  for (; i < c.length; i++) {
    const v = c[i];
    if (v === 117 || v === 122 || v === 127) { eos = v; break; }
    if (v < 0) { errors++; data.push(-1); continue; }
    if (v >= 100 && !data.length) cmds.push(v); else data.push(v);
  }
  if (cmds.length) add('Command', cmds.map((x) => SELCALL_CMD[x] || `code ${x}`).join(' · '));
  if (data.length) {
    const d = data.map((v) => (v < 0 ? '??' : v > 99 ? `[${v}]` : String(v).padStart(2, '0'))).join(' ');
    add(cmds[0] === 121 ? 'Position data (raw)' : 'Data', d);
  }
  m.eos = eos;
  add('End', DSC_EOS[eos] || 'not received');
  m.errors = errors + c.slice(0, Math.max(0, i)).filter((v) => v < 0).length;
  m.eccOk = null;
  return m;
}

// ── The decoder ─────────────────────────────────────────────────────────────

export class DscDecoder {
  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate : (() => Number(options.sampleRate) || 12000);
    this._centerHz = Number(options.centerHz) || 1700;
    this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : null;
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
    this.onMetrics = typeof options.onMetrics === 'function' ? options.onMetrics : null;
    this._selcall = !!options.selcall;
    this.reset();
  }

  setCenter(hz) {
    const f = Number(hz);
    if (Number.isFinite(f) && f > 0) { this._centerHz = f; this._configure(); }
  }

  reset() {
    this._oscC = 1; this._oscS = 0; this._oscN = 0;
    this._lp = [_biq(), _biq(), _biq(), _biq()];
    this._dec = 0;
    this._prevI = 0; this._prevQ = 0;
    this._phase = 0;             // position within the current bit, 0..SPB-1
    this._acc = 0;               // discriminator sum over the bit
    this._last = 0;              // previous discriminator sample (for crossings)
    this._timingErr = 0;
    this._hiAvg = SHIFT / 2; this._loAvg = -SHIFT / 2;   // tone centres (Hz), tracked
    this._sigPow = 0; this._noisePow = 0;
    this._bits = [];             // recent hard bits
    this._sync = null;           // collecting a call: { slots: [], rxPhase }
    this._calls = 0;
    this._lastMetricsAt = 0;
    this._statusText = '';
    this._configure();
  }

  _configure() {
    this._sr = this._sampleRateFn() || 12000;
    const w = 2 * Math.PI * this._centerHz / this._sr;
    this._stepC = Math.cos(w); this._stepS = Math.sin(w);
    // ~1.3 x baud + half the shift: passes both tones' main lobes.
    for (const f of this._lp) _biqLowpass(f, 220, this._sr);
  }

  feed(pcm) {
    if (!pcm || !pcm.length) return;
    const sr = this._sampleRateFn() || 12000;
    if (sr !== this._sr) this._configure();
    const step = BB_RATE / this._sr;
    for (let n = 0; n < pcm.length; n++) {
      const x = pcm[n];
      const c = this._oscC, s = this._oscS;
      let i = x * c, q = -x * s;
      this._oscC = c * this._stepC - s * this._stepS;
      this._oscS = s * this._stepC + c * this._stepS;
      if (++this._oscN >= 1024) {
        const m = Math.hypot(this._oscC, this._oscS) || 1;
        this._oscC /= m; this._oscS /= m; this._oscN = 0;
      }
      i = _biqStep(this._lp[1], _biqStep(this._lp[0], i));
      q = _biqStep(this._lp[3], _biqStep(this._lp[2], q));
      this._dec += step;
      if (this._dec >= 1) { this._dec -= 1; this._bb(i, q); }
    }
    this._maybeMetrics();
  }

  /** One baseband sample at 1600 Hz: discriminator, bit timing, bit decision. */
  _bb(i, q) {
    // FM discriminator: instantaneous frequency in Hz.
    const re = i * this._prevI + q * this._prevQ;
    const im = q * this._prevI - i * this._prevQ;
    this._prevI = i; this._prevQ = q;
    const f = Math.atan2(im, re) * BB_RATE / (2 * Math.PI);
    const mid = (this._hiAvg + this._loAvg) / 2;
    const v = f - mid;

    // Bit timing: a tone change should fall on a bit boundary (phase 0). The
    // phase at which crossings actually happen (-8..+8 samples) is averaged,
    // and the next bit is started that much later (positive) or earlier.
    if ((v > 0) !== (this._last > 0)) {
      let e = this._phase; if (e > SPB / 2) e -= SPB;
      this._timingErr += 0.1 * (e - this._timingErr);
    }
    this._last = v;
    // Integrate the middle of the bit only, away from the transitions.
    if (this._phase >= 3 && this._phase < SPB - 3) { this._acc += v; this._nAcc = (this._nAcc || 0) + 1; }
    this._phase++;
    if (this._phase >= SPB) {
      this._bit(this._nAcc ? this._acc / this._nAcc : 0);
      this._acc = 0; this._nAcc = 0;
      const adj = Math.max(-2, Math.min(2, Math.round(this._timingErr * 0.5)));
      this._phase = -adj;
      this._timingErr -= adj;
    }
  }

  _bit(soft) {
    const mid = (this._hiAvg + this._loAvg) / 2;
    const val = soft + mid;
    // B (higher tone, binary 0) is positive here; Y (lower, binary 1) negative.
    const bit = soft >= 0 ? 0 : 1;
    if (bit === 0) this._hiAvg += 0.02 * (val - this._hiAvg); else this._loAvg += 0.02 * (val - this._loAvg);
    // keep the two centres plausible (shift 120..220 Hz)
    const sep = this._hiAvg - this._loAvg;
    if (sep < 120 || sep > 220) { const c = (this._hiAvg + this._loAvg) / 2; this._hiAvg = c + SHIFT / 2; this._loAvg = c - SHIFT / 2; }
    // quality: how far each bit sits from its tone centre
    const ref = bit === 0 ? this._hiAvg : this._loAvg;
    this._sigPow += 0.02 * ((sep / 2) ** 2 - this._sigPow);
    this._noisePow += 0.02 * ((val - ref) ** 2 - this._noisePow);

    this._bits.push(bit);
    if (this._bits.length > 400) this._bits.splice(0, this._bits.length - 400);

    if (this._sync) {
      // Until a format specifier has been read, a better phasing (a real call
      // starting while a false one is being collected) takes over.
      const s0 = this._sync;
      if (!s0.hasFmt) {
        this._sync = null;
        this._hunt();
        if (!this._sync) this._sync = s0;
        else return;
      }
      this._collect();
    } else this._hunt();
  }

  _symAt(back) {
    // the 10 bits ending `back` bits before the newest one
    const b = this._bits, end = b.length - back;
    if (end < 10) return -1;
    return dscSymbol(b.slice(end - 10, end));
  }

  /**
   * Look for the phasing sequence: RX 111..104 with DX 125 between them, in
   * either tone polarity. A character with every bit inverted still passes
   * its check bits (zeros and their count flip together), so an inverted
   * signal (the other sideband, or a station keyed the other way round, as
   * on the Selcall recordings) reads as valid but wrong values; the phasing
   * tells which polarity this call has, and the whole call is read in it.
   */
  _hunt() {
    for (const inv of [0, 127]) {
      const sym = (back) => { const v = this._symAt(back); return v < 0 ? v : v ^ inv; };
      const cur = sym(0);
      if (cur < 104 || cur > 111) continue;
      let rx = 1, dx = 0;
      for (let k = 1; k <= 7; k++) {
        const want = cur + k;                      // earlier RX positions count up
        if (want <= 111 && sym(20 * k) === want) rx++;
        if (sym(20 * k - 10) === 125) dx++;
      }
      // Two RX phasing characters, or one plus two DX ones (M.493 accepts both).
      if (rx >= 2 || (rx >= 1 && dx >= 2)) {
        // The 16 slots up to and including this RX one, rebuilt from the bit
        // history: a call synced late in its phasing has already sent its
        // first DX format character. Slot -16 is a DX position, as every even one.
        const pre = [];
        for (let j = 15; j >= 0; j--) pre.push(sym(10 * j));
        this._sync = { slots: pre, bitCount: 0, inv };
        this._status('Phasing found — receiving call');
        return;
      }
    }
  }

  /** After phasing: take one character every 10 bits. */
  _collect() {
    const s = this._sync;
    if (++s.bitCount < 10) return;
    s.bitCount = 0;
    const v = this._symAt(0);
    s.slots.push(v < 0 ? v : v ^ s.inv);
    const n = s.slots.length;
    // a format specifier seen twice in DX positions (every other slot)
    if (!s.hasFmt && n >= 3 && n % 2 === 1 && DSC_FORMAT[s.slots[n - 1]] &&
        (s.slots[n - 1] === s.slots[n - 3] || (this._selcall && s.slots[n - 3] === 125))) s.hasFmt = true;
    if (this._callComplete(s) || s.slots.length >= MAX_SLOTS) this._finish();
  }

  _callComplete(s) {
    // An end-of-sequence character seen in both streams, plus a few slots for
    // the ECC and the RX copy, or three EOS in a row in either stream.
    const sl = s.slots;
    let eos = 0;
    for (const v of sl) if (v === 117 || v === 122 || v === 127) eos++;
    return eos >= 4 && sl.length > 32;
  }

  _finish() {
    const s = this._sync;
    this._sync = null;
    const msg = this._assemble(s);
    this._status('Waiting for a call…');
    if (!msg) return;
    this._calls++;
    if (this.onMessage) this.onMessage(msg);
  }

  /**
   * Split the slots into the DX (even) and RX (odd) streams, merge them —
   * character i is DX[i], or RX[i + 2] when DX[i] failed its check bits —
   * and start at the format specifier, which is always sent twice in a row.
   */
  _assemble(s) {
    const sl = s.slots;
    const dx = [], rx = [];
    for (let k = 0; k < sl.length; k++) (k % 2 === 0 ? dx : rx).push(sl[k]);
    const merged = [];
    for (let i = 0; i < dx.length; i++) {
      const y = i + 2 < rx.length ? rx[i + 2] : -1;
      merged.push(dx[i] >= 0 ? dx[i] : y);
    }
    let k0 = -1;
    if (this._selcall) {
      // Selcall: the first format character after the DX phasing (125s).
      for (let k = 0; k + 1 < Math.min(merged.length, 18); k++) {
        if (SELCALL_FORMAT[merged[k]] && (k === 0 || merged[k - 1] === 125 || merged[k - 1] < 0)) { k0 = k; break; }
      }
    } else {
      for (let k = 0; k + 1 < Math.min(merged.length, 16); k++) {
        if (DSC_FORMAT[merged[k]] && merged[k] === merged[k + 1]) { k0 = k; break; }
      }
    }
    if (k0 < 0) return null;
    const c = merged.slice(k0);
    if (this._selcall) {
      const sm = selcallParse(c);
      if (!sm || sm.errors > 2) return null;
      sm.chars = c;
      sm.time = new Date().toISOString().slice(11, 19);
      return sm;
    }
    const m = dscParse(c);
    // A call is shown when its error check agrees, or when only a few
    // characters were lost in both copies; anything worse is noise that
    // happened to contain a phasing pattern.
    if (m.eccOk !== true && !m.recovered && m.errors > 3) return null;
    if (!m.self && m.format !== 102) return null;
    m.chars = c;
    m.time = new Date().toISOString().slice(11, 19);
    return m;
  }

  get snrDb() {
    if (!(this._noisePow > 0)) return 0;
    return Math.max(-10, Math.min(40, 10 * Math.log10(this._sigPow / this._noisePow)));
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
    if (this.onMetrics) this.onMetrics({
      snrDb: this.snrDb,
      offsetHz: Math.round((this._hiAvg + this._loAvg) / 2),
      receiving: !!this._sync,
      calls: this._calls,
    });
  }
}

// ── RBJ biquad low-pass ─────────────────────────────────────────────────────
function _biq() { return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0 }; }
function _biqLowpass(f, freq, sr, Q = 0.707) {
  f.x1 = f.x2 = f.y1 = f.y2 = 0;
  const w = 2 * Math.PI * freq / sr, sn = Math.sin(w), cs = Math.cos(w), al = sn / (2 * Q), a0 = 1 + al;
  f.b0 = ((1 - cs) / 2) / a0; f.b1 = (1 - cs) / a0; f.b2 = f.b0; f.a1 = (-2 * cs) / a0; f.a2 = (1 - al) / a0;
}
function _biqStep(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y; return y;
}

export default DscDecoder;
