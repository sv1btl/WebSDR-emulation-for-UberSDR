// ax25.js — AFSK packet receiver: AX.25 monitor and APRS decoder (receive only)
// ============================================================================
// Two speeds, one engine:
//   • 1200 Bd Bell 202 — VHF/UHF packet and APRS, received in FM.
//                        Tones 1200 / 2200 Hz.
//   • 300 Bd           — HF packet and HF APRS, received in USB.
//                        Two tones 200 Hz apart (1600 / 1800 Hz at the
//                        conventional 1700 Hz centre).
//
// Pipeline (the shape of Dire Wolf's AFSK demodulator, written from scratch)
// --------
//   1. Band-pass prefilter (300 Bd only — on HF the passband is shared with
//        neighbours; at 1200 Bd the tones fill the whole voice channel anyway).
//   2. Non-coherent tone detection — each tone is mixed to DC and summed over
//        exactly one bit (a boxcar), so its amplitude is the matched-filter
//        output for that tone.
//   3. Multiple slicers — d = mark − g·space for five space gains g. FM
//        receivers with or without de-emphasis, and transmitters with or
//        without pre-emphasis, tilt one tone against the other by up to
//        ±6 dB; one of the slicers is always close to balanced. Each slicer
//        has its own clock and HDLC state, and a frame that two slicers both
//        decode is printed once.
//   4. Clock recovery — a 32-bit phase accumulator overflows once per bit,
//        and is pulled towards each data transition (inertia 0.5 while
//        hunting, 0.74 inside a frame).
//   5. NRZI → HDLC — a 0 is a change of tone, a 1 is no change; 0x7E flags
//        delimit frames, a 0 after five 1s is stuffing and is dropped, seven
//        1s abort.
//   6. FCS — CRC-16/X.25 over the frame. Only frames that pass it, AND whose
//        address field is a well-formed AX.25 address, are reported, so an
//        empty channel stays silent.
//
// Interface mirrors psk31.js / olivia.js:
//   new PacketDecoder({sampleRate, baud, centerHz, aprs, showRaw,
//                      onLine, onStatus, onMetrics});
//   onLine(text, pos) — pos is { call, via, lat, lon, text, symbol, killed,
//   time } when the line is an APRS position (call = the object/item name for
//   objects and items), otherwise null.
//   .feed(Float32Array); .setShowRaw(on); .reset();
// ============================================================================

// Space gains for the slicers (see 3. above): −6 … +6 dB.
const SLICER_GAINS = [0.5, 0.71, 1.0, 1.41, 2.0];

const PLL_INERTIA_HUNT = 0.50;
const PLL_INERTIA_LOCK = 0.74;

// 7 + 7 address bytes, control, FCS — the shortest legal AX.25 frame.
const MIN_FRAME = 17;
const MAX_FRAME = 1024;

const METRICS_INTERVAL_S = 0.5;
// DCD stays lit this long after the last flag, so it reads as a lamp rather
// than flickering between frames of a burst.
const DCD_HOLD_S = 0.4;

// ── CRC-16/X.25 (the AX.25 FCS) ─────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0x8408 : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc16x25(bytes, len = bytes.length) {
  let crc = 0xFFFF;
  for (let i = 0; i < len; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
  return (crc ^ 0xFFFF) & 0xFFFF;
}

// ── AX.25 frame parsing ─────────────────────────────────────────────────────

function _decodeAddress(b, off) {
  let call = '';
  for (let i = 0; i < 6; i++) {
    const v = b[off + i];
    if (v & 1) return null;                     // only the SSID byte may end the field
    const c = v >> 1;
    if (c === 0x20) continue;                   // padding
    if (!((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A))) return null;
    if (call.length !== i) return null;         // a space in the middle of a call
    call += String.fromCharCode(c);
  }
  if (!call) return null;
  const s = b[off + 6];
  return {
    call,
    ssid: (s >> 1) & 0x0F,
    hbit: !!(s & 0x80),
    last: !!(s & 1),
    get name() { return this.ssid ? `${this.call}-${this.ssid}` : this.call; },
  };
}

/**
 * Parse a CRC-checked frame (FCS removed). Returns null when the address
 * field is not well formed — which is what keeps CRC collisions on noise
 * from ever being printed.
 */
export function parseAX25(b, len = b.length) {
  const addrs = [];
  let off = 0;
  for (;;) {
    if (off + 7 > len || addrs.length >= 10) return null;
    const a = _decodeAddress(b, off);
    if (!a) return null;
    addrs.push(a);
    off += 7;
    if (a.last) break;
  }
  if (addrs.length < 2 || off >= len) return null;

  const dst = addrs[0], src = addrs[1], digis = addrs.slice(2);
  const ctl = b[off++];
  // Command/response from the C bits (AX.25 v2): dest set = command.
  const cr = dst.hbit && !src.hbit ? 'C' : !dst.hbit && src.hbit ? 'R' : '';

  let type, pid = -1, detail = '';
  const pf = (ctl >> 4) & 1;
  if ((ctl & 1) === 0) {
    type = 'I';
    detail = `R${(ctl >> 5) & 7} S${(ctl >> 1) & 7}${pf ? ' P' : ''}`;
    if (off < len) pid = b[off++];
  } else if ((ctl & 3) === 1) {
    type = ['RR', 'RNR', 'REJ', 'SREJ'][(ctl >> 2) & 3];
    detail = `R${(ctl >> 5) & 7}${pf ? (cr === 'R' ? ' F' : ' P') : ''}`;
  } else {
    const m = ctl & 0xEF;
    type = { 0x03: 'UI', 0x2F: 'SABM', 0x6F: 'SABME', 0x43: 'DISC', 0x0F: 'DM',
             0x63: 'UA', 0x87: 'FRMR', 0xAF: 'XID', 0xE3: 'TEST' }[m] || `U${m.toString(16)}`;
    detail = pf ? (cr === 'R' ? 'F' : 'P') : '';
    if (type === 'UI' && off < len) pid = b[off++];
  }

  return {
    dst, src, digis, ctl, cr, type, detail, pid,
    info: b.subarray(off, len),
  };
}

/** TNC2 monitor header: SRC>DST,DIGI1,DIGI2* — '*' after the last digi used. */
export function tnc2Header(f) {
  let lastUsed = -1;
  f.digis.forEach((d, i) => { if (d.hbit) lastUsed = i; });
  const path = f.digis.map((d, i) => d.name + (i === lastUsed ? '*' : ''));
  return `${f.src.name}>${f.dst.name}${path.length ? ',' + path.join(',') : ''}`;
}

/** Printable form of an info field: text as text, anything else as <0xNN>. */
export function infoText(info) {
  let s = '';
  // Most traffic is ASCII; try UTF-8 first for the rest (comments in Greek,
  // Cyrillic, ...), and fall back to escaping byte by byte.
  let decoded = null;
  if (info.some((v) => v >= 0x80)) {
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(info); } catch (_) { decoded = null; }
  }
  if (decoded !== null) {
    for (const ch of decoded) {
      const c = ch.codePointAt(0);
      s += (c < 0x20 || c === 0x7F) ? (c === 0x0D || c === 0x0A ? '⏎' : `<0x${c.toString(16).padStart(2, '0')}>`) : ch;
    }
    return s;
  }
  for (const v of info) {
    if (v >= 0x20 && v < 0x7F) s += String.fromCharCode(v);
    else if (v === 0x0D || v === 0x0A) s += '⏎';
    else s += `<0x${v.toString(16).padStart(2, '0')}>`;
  }
  return s;
}

// ── APRS ────────────────────────────────────────────────────────────────────

// Primary-table ('/') symbol names, and the handful of alternate-table ('\')
// ones that are common on the air.
const SYM_PRIMARY = {
  '!': 'Police', '#': 'Digipeater', '$': 'Phone', '%': 'DX cluster', '&': 'HF gateway',
  "'": 'Small aircraft', '(': 'Mobile satellite', '*': 'Snowmobile', '+': 'Red Cross',
  ',': 'Boy Scouts', '-': 'House', '.': 'X', '/': 'Dot', '0': 'Circle',
  ':': 'Fire', ';': 'Campground', '<': 'Motorcycle', '=': 'Railroad engine', '>': 'Car',
  '?': 'File server', '@': 'Hurricane', 'A': 'Aid station', 'B': 'BBS', 'C': 'Canoe',
  'E': 'Eyeball', 'F': 'Tractor', 'G': 'Grid square', 'H': 'Hotel', 'I': 'TCP/IP',
  'K': 'School', 'L': 'PC user', 'M': 'MacAPRS', 'N': 'NTS station', 'O': 'Balloon',
  'P': 'Police', 'R': 'RV', 'S': 'Space shuttle', 'T': 'SSTV', 'U': 'Bus', 'V': 'ATV',
  'W': 'Weather service', 'X': 'Helicopter', 'Y': 'Yacht', 'Z': 'WinAPRS',
  '[': 'Person', '\\': 'Triangle (DF)', ']': 'Mailbox', '^': 'Aircraft', '_': 'Weather station',
  '`': 'Dish antenna', 'a': 'Ambulance', 'b': 'Bicycle', 'c': 'Incident command',
  'd': 'Fire station', 'e': 'Horse', 'f': 'Fire truck', 'g': 'Glider', 'h': 'Hospital',
  'i': 'IOTA', 'j': 'Jeep', 'k': 'Truck', 'l': 'Laptop', 'm': 'Mic-E repeater', 'n': 'Node',
  'o': 'EOC', 'p': 'Dog', 'q': 'Grid square', 'r': 'Repeater', 's': 'Ship', 't': 'Truck stop',
  'u': 'Truck (18 wheeler)', 'v': 'Van', 'w': 'Water station', 'x': 'xAPRS', 'y': 'House (yagi)',
  'z': 'Shelter',
};
const SYM_ALTERNATE = {
  '#': 'Digipeater', '&': 'Gateway', '-': 'House (HF)', '>': 'Car', '_': 'Weather station',
  'a': 'ARES/RACES', 'k': 'SUV', 'n': 'Node', 'r': 'Restroom', 's': 'Ship', 'u': 'Truck',
  'v': 'Van', 'j': 'Jeep', 'O': 'Rocket', 'K': 'Kenwood', 'W': 'NWS site', 'y': 'Yagi',
};

function symbolName(table, code) {
  if (table === '/') return SYM_PRIMARY[code] || '';
  return SYM_ALTERNATE[code] || '';
}

/** 6-character Maidenhead locator. */
export function maidenhead(lat, lon) {
  let x = lon + 180, y = lat + 90;
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let s = A[Math.floor(x / 20)] + A[Math.floor(y / 10)];
  x %= 20; y %= 10;
  s += Math.floor(x / 2) + '' + Math.floor(y);
  x %= 2; y %= 1;
  s += A[Math.floor(x * 12)].toLowerCase() + A[Math.floor(y * 24)].toLowerCase();
  return s;
}

function fmtPos(lat, lon) {
  return `${Math.abs(lat).toFixed(4)}°${lat < 0 ? 'S' : 'N'} ` +
         `${Math.abs(lon).toFixed(4)}°${lon < 0 ? 'W' : 'E'} (${maidenhead(lat, lon)})`;
}

const KNOT_KMH = 1.852;
const MPH_KMH = 1.609344;
const FT_M = 0.3048;

function b91(s) {
  let v = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) - 33;
    if (c < 0 || c > 90) return NaN;
    v = v * 91 + c;
  }
  return v;
}

/** APRS timestamp (7 chars) to display text, or null. */
function parseTimestamp(t) {
  let m = /^(\d{2})(\d{2})(\d{2})([zh/])$/.exec(t);
  if (!m) return null;
  if (m[4] === 'h') return `${m[1]}:${m[2]}:${m[3]}z`;
  return `day ${m[1]} ${m[2]}:${m[3]}${m[4] === 'z' ? 'z' : ' local'}`;
}

/**
 * Position at the start of `s` (uncompressed or compressed). Returns
 * { lat, lon, table, code, rest, course?, speedKmh?, altM?, rangeKm? } or null.
 */
function parsePosition(s) {
  // Uncompressed: DDMM.hhN/DDDMM.hhW$ — spaces are position ambiguity.
  const u = /^(\d{2})([\d ]{2})\.([\d ]{2})([NnSs])(.)(\d{3})([\d ]{2})\.([\d ]{2})([EeWw])(.)/.exec(s);
  if (u) {
    const z = (x) => Number(x.replace(/ /g, '0'));
    let lat = z(u[1]) + (z(u[2]) + z(u[3]) / 100) / 60;
    let lon = z(u[6]) + (z(u[7]) + z(u[8]) / 100) / 60;
    if (/[Ss]/.test(u[4])) lat = -lat;
    if (/[Ww]/.test(u[9])) lon = -lon;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon, table: u[5], code: u[10], rest: s.slice(19) };
  }
  // Compressed: /YYYYXXXX$csT — table, 4+4 base-91, symbol, course/speed, type.
  if (s.length >= 13 && /^[\/\\A-Za-j]/.test(s)) {
    const y = b91(s.slice(1, 5)), x = b91(s.slice(5, 9));
    if (!Number.isFinite(y) || !Number.isFinite(x)) return null;
    const out = {
      lat: 90 - y / 380926, lon: -180 + x / 190463,
      table: s[0], code: s[9], rest: s.slice(13),
    };
    const c = s.charCodeAt(10) - 33, sp = s.charCodeAt(11) - 33, T = s.charCodeAt(12) - 33;
    if (s[10] !== ' ') {
      if (((T >> 3) & 3) === 2) {
        out.altM = Math.pow(1.002, c * 91 + sp) * FT_M;
      } else if (c >= 0 && c <= 89) {
        out.course = c * 4;
        out.speedKmh = (Math.pow(1.08, sp) - 1) * KNOT_KMH;
      } else if (s[10] === '{') {
        out.rangeKm = 2 * Math.pow(1.08, sp) * MPH_KMH;
      }
    }
    return out;
  }
  return null;
}

/** Weather fields (cXXXsXXXgXXXtXXX rXXX pXXX PXXX hXX bXXXXX) → text. */
function parseWeather(s, haveWind) {
  const parts = [];
  let m;
  const num = (re) => ((m = re.exec(s)) ? Number(m[1]) : null);
  if (!haveWind) {
    const dir = num(/c(\d{3})/), spd = num(/s(\d{3})/);
    if (dir != null && spd != null) parts.push(`wind ${dir}° ${Math.round(spd * MPH_KMH)} km/h`);
  }
  const g = num(/g(\d{3})/);
  if (g != null) parts.push(`gust ${Math.round(g * MPH_KMH)} km/h`);
  const t = num(/t(-?\d{2,3})/);
  if (t != null) parts.push(`${((t - 32) * 5 / 9).toFixed(1)} °C`);
  const h = num(/h(\d{2})/);
  if (h != null) parts.push(`humidity ${h === 0 ? 100 : h}%`);
  const b = num(/b(\d{5})/);
  if (b != null) parts.push(`${(b / 10).toFixed(1)} hPa`);
  const r = num(/r(\d{3})/);
  if (r != null) parts.push(`rain 1h ${(r * 0.254).toFixed(1)} mm`);
  const p = num(/p(\d{3})/);
  if (p != null) parts.push(`24h ${(p * 0.254).toFixed(1)} mm`);
  return parts.join(' · ');
}

/** Course/speed, PHG, RNG and /A= altitude out of a position's trailing text. */
function describeExtras(pos, isWeather) {
  const parts = [];
  let rest = pos.rest || '';
  let m;
  if ((m = /^(\d{3})\/(\d{3})/.exec(rest))) {
    const dir = Number(m[1]), spd = Number(m[2]);
    if (isWeather) parts.push(`wind ${dir}° ${Math.round(spd * MPH_KMH)} km/h`);
    else if (dir || spd) parts.push(`${Math.round(spd * KNOT_KMH)} km/h ${dir}°`);
    rest = rest.slice(7);
  } else if ((m = /^PHG(\d)(\d)(\d)(\d)/.exec(rest))) {
    const pw = Number(m[1]) ** 2, ht = 10 * 2 ** Number(m[2]);
    parts.push(`PHG ${pw} W, ${Math.round(ht * FT_M)} m HAAT, ${m[3]} dBi`);
    rest = rest.slice(7);
  } else if ((m = /^RNG(\d{4})/.exec(rest))) {
    parts.push(`range ${Math.round(Number(m[1]) * MPH_KMH)} km`);
    rest = rest.slice(7);
  }
  if (pos.course != null && !isWeather) {
    parts.push(`${Math.round(pos.speedKmh)} km/h ${pos.course}°`);
  }
  if (pos.rangeKm != null) parts.push(`range ${Math.round(pos.rangeKm)} km`);
  let altM = pos.altM;
  if ((m = /\/A=(-?\d{6})/.exec(rest))) {
    altM = Number(m[1]) * FT_M;
    rest = rest.replace(m[0], '');
  }
  if (altM != null) parts.push(`alt ${Math.round(altM)} m`);
  if (isWeather) {
    const wx = parseWeather(rest, parts.length > 0);
    if (wx) parts.push(wx);
    rest = '';
  }
  return { parts, comment: rest.trim() };
}

function describePosition(pos, kind) {
  const sym = symbolName(pos.table, pos.code);
  const isWx = pos.code === '_';
  const { parts, comment } = describeExtras(pos, isWx);
  const out = [kind];
  if (sym) out.push(sym);
  out.push(fmtPos(pos.lat, pos.lon));
  out.push(...parts);
  if (comment) out.push(`“${comment}”`);
  return { text: out.join(' · '), lat: pos.lat, lon: pos.lon, symbol: pos.table + pos.code };
}

// Mic-E destination characters → [digit, message bit (0 / 1 std / 2 custom), flag]
// where `flag` is the N / +100 / W indicator for positions 4–6.
function _micEChar(c) {
  if (c >= '0' && c <= '9') return [c.charCodeAt(0) - 48, 0, false];
  if (c >= 'A' && c <= 'J') return [c.charCodeAt(0) - 65, 2, false];
  if (c === 'K') return [0, 2, false];
  if (c === 'L') return [0, 0, false];
  if (c >= 'P' && c <= 'Y') return [c.charCodeAt(0) - 80, 1, true];
  if (c === 'Z') return [0, 1, true];
  return null;
}

const MICE_STD = ['Emergency', 'Priority', 'Special', 'Committed', 'Returning', 'In service', 'En route', 'Off duty'];

function parseMicE(dstCall, info) {
  if (dstCall.length !== 6 || info.length < 9) return null;
  const d = [];
  for (const ch of dstCall) {
    const v = _micEChar(ch);
    if (!v) return null;
    d.push(v);
  }
  let lat = d[0][0] * 10 + d[1][0] + (d[2][0] * 10 + d[3][0] + (d[4][0] * 10 + d[5][0]) / 100) / 60;
  if (!d[3][2]) lat = -lat;

  const c = (i) => info.charCodeAt(i) - 28;
  let deg = c(1);
  if (d[4][2]) deg += 100;
  if (deg >= 180 && deg <= 189) deg -= 80;
  else if (deg >= 190 && deg <= 199) deg -= 190;
  let min = c(2);
  if (min >= 60) min -= 60;
  let lon = deg + (min + c(3) / 100) / 60;
  if (d[5][2]) lon = -lon;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  let speed = c(4) * 10 + Math.floor(c(5) / 10);
  let course = (c(5) % 10) * 100 + c(6);
  if (speed >= 800) speed -= 800;
  if (course >= 400) course -= 400;

  // Message bits A/B/C. A mix of standard and custom 1s is undefined.
  const bits = [d[0][1], d[1][1], d[2][1]];
  const val = (bits[0] ? 4 : 0) + (bits[1] ? 2 : 0) + (bits[2] ? 1 : 0);
  const custom = bits.includes(2), std = bits.includes(1);
  const status = custom && std ? 'Unknown'
    : custom ? `Custom-${7 - val}` : MICE_STD[val];

  let rest = info.slice(9);
  const parts = [];
  // Radio type prefix (Kenwood '>' / ']'), and altitude "xxx}".
  let m;
  if ((m = /^([>\]`'])/.exec(rest))) rest = rest.slice(1);
  if ((m = /^(.{3})\}/.exec(rest))) {
    const a = b91(m[1]);
    if (Number.isFinite(a)) parts.push(`alt ${a - 10000} m`);
    rest = rest.slice(4);
  }
  // Yaesu/Kenwood suffixes: "_x" at the end, or "=" for the D7x/D710.
  rest = rest.replace(/_[ "#$%()0-9]$/, '').replace(/=$/, '').trim();

  const pos = { lat, lon, table: info[8], code: info[7] };
  const sym = symbolName(pos.table, pos.code);
  const out = ['Mic-E'];
  if (sym) out.push(sym);
  out.push(fmtPos(lat, lon));
  if (speed || course) out.push(`${Math.round(speed * KNOT_KMH)} km/h ${course}°`);
  out.push(...parts);
  if (status !== 'Off duty') out.push(status);
  if (rest) out.push(`“${rest}”`);
  return { text: out.join(' · '), lat, lon, symbol: pos.table + pos.code };
}

function parseNmea(s) {
  const f = s.split(',');
  let latS, ns, lonS, ew;
  if (/^\$G[PNL]RMC/.test(f[0])) [latS, ns, lonS, ew] = [f[3], f[4], f[5], f[6]];
  else if (/^\$G[PNL]GGA/.test(f[0])) [latS, ns, lonS, ew] = [f[2], f[3], f[4], f[5]];
  else return { text: `Raw NMEA ${f[0]}` };
  const lat = Number(latS.slice(0, 2)) + Number(latS.slice(2)) / 60;
  const lon = Number(lonS.slice(0, 3)) + Number(lonS.slice(3)) / 60;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { text: `Raw NMEA ${f[0]}` };
  const la = ns === 'S' ? -lat : lat, lo = ew === 'W' ? -lon : lon;
  return { text: `NMEA position · ${fmtPos(la, lo)}`, lat: la, lon: lo };
}

/**
 * Describe an APRS information field. `dstCall` is the destination callsign
 * (without SSID) — Mic-E carries the latitude in it. Returns { text, lat?, lon? }.
 */
export function parseAPRS(dstCall, info, depth = 0) {
  if (!info.length) return { text: 'Empty' };
  const t = info[0];
  let m;
  switch (t) {
    case '!': case '=': {
      const p = parsePosition(info.slice(1));
      if (p) return describePosition(p, t === '=' ? 'Position (messaging)' : 'Position');
      break;
    }
    case '/': case '@': {
      const ts = parseTimestamp(info.slice(1, 8));
      const p = parsePosition(info.slice(8));
      if (p) {
        const r = describePosition(p, t === '@' ? 'Position (messaging)' : 'Position');
        if (ts) r.text += ` · ${ts}`;
        return r;
      }
      break;
    }
    case '`': case "'": case '\x1c': case '\x1d': {
      const r = parseMicE(dstCall, info);
      if (r) return r;
      break;
    }
    case ':': {
      if ((m = /^:(.{9}):(.*)$/s.exec(info))) {
        const to = m[1].trim();
        let text = m[2];
        if ((m = /^ack([A-Za-z0-9}]{1,5})/.exec(text))) return { text: `Ack to ${to} · msg ${m[1]}` };
        if ((m = /^rej([A-Za-z0-9}]{1,5})/.exec(text))) return { text: `Reject to ${to} · msg ${m[1]}` };
        let id = '';
        if ((m = /\{([A-Za-z0-9}]{1,5})$/.exec(text))) { id = ` · #${m[1]}`; text = text.slice(0, m.index); }
        const kind = /^BLN/.test(to) ? 'Bulletin' : /^NWS/.test(to) ? 'Weather alert' : 'Message';
        return { text: `${kind} to ${to}: “${text}”${id}` };
      }
      break;
    }
    case ';': {
      if ((m = /^;(.{9})([*_])(.{7})/.exec(info))) {
        const name = m[1].trim(), live = m[2] === '*';
        const p = parsePosition(info.slice(18));
        if (p) {
          const r = describePosition(p, `Object “${name}”${live ? '' : ' (killed)'}`);
          const ts = parseTimestamp(m[3]);
          if (ts) r.text += ` · ${ts}`;
          // The position is the object's, not the sender's.
          r.name = name;
          r.killed = !live;
          return r;
        }
      }
      break;
    }
    case ')': {
      if ((m = /^\)([^!_]{3,9})([!_])/.exec(info))) {
        const p = parsePosition(info.slice(m[0].length));
        if (p) {
          const r = describePosition(p, `Item “${m[1]}”${m[2] === '_' ? ' (killed)' : ''}`);
          r.name = m[1].trim();
          r.killed = m[2] === '_';
          return r;
        }
      }
      break;
    }
    case '>': {
      let s = info.slice(1);
      const ts = /^\d{6}z/.test(s) ? parseTimestamp(s.slice(0, 7)) : null;
      if (ts) s = s.slice(7);
      return { text: `Status: “${s.trim()}”${ts ? ` · ${ts}` : ''}` };
    }
    case '_': {
      const wx = parseWeather(info.slice(9), false);
      return { text: `Weather${wx ? ' · ' + wx : ''}` };
    }
    case 'T': {
      if ((m = /^T#([^,]*),(.*)$/.exec(info))) {
        return { text: `Telemetry #${m[1]}: ${m[2].split(',').join(' ')}` };
      }
      break;
    }
    case '<': return { text: `Capabilities: ${info.slice(1)}` };
    case '?': return { text: `Query: ${info.slice(1)}` };
    case '$': return parseNmea(info);
    case '{': return { text: 'User-defined data' };
    case '}': {
      // Third-party: an inner TNC2 packet, usually gated from the Internet.
      if (depth < 2 && (m = /^\}([A-Z0-9-]+)>([A-Z0-9-]+)[^:]*:(.*)$/s.exec(info))) {
        const inner = parseAPRS(m[2].replace(/-\d+$/, ''), m[3], depth + 1);
        return { ...inner, name: inner.name || m[1], text: `Third-party from ${m[1]} · ${inner.text}` };
      }
      return { text: 'Third-party traffic' };
    }
    default:
      break;
  }
  // APRS allows a position anywhere in the first 40 chars after a '!'.
  const bang = info.indexOf('!');
  if (bang > 0 && bang < 40) {
    const p = parsePosition(info.slice(bang + 1));
    if (p) return describePosition(p, 'Position');
  }
  return { text: `Unparsed APRS (type '${t}')` };
}

// ── Demodulator ─────────────────────────────────────────────────────────────

export class PacketDecoder {
  constructor(opts = {}) {
    this._srFn = typeof opts.sampleRate === 'function' ? opts.sampleRate : () => opts.sampleRate || 12000;
    this._baud = Number(opts.baud) === 300 ? 300 : 1200;
    // Centre and shift: 1200 Bd is fixed at 1200/2200; 300 Bd follows the dial.
    if (this._baud === 1200) {
      this._mark = 1200; this._space = 2200;
    } else {
      const c = Number(opts.centerHz) || 1700;
      this._mark = c - 100; this._space = c + 100;
    }
    this._aprs = !!opts.aprs;
    this._showRaw = opts.showRaw !== false;
    this._onLine = opts.onLine || (() => {});
    this._onStatus = opts.onStatus || (() => {});
    this._onMetrics = opts.onMetrics || (() => {});

    this._framesOk = 0;
    this._stations = new Set();
    this.reset();
  }

  setShowRaw(on) { this._showRaw = !!on; }

  reset() {
    const SR = this._srFn() || 12000;
    this._sr = SR;
    this._n = Math.max(4, Math.round(SR / this._baud));     // one bit, in samples

    this._phM = 0; this._phS = 0;
    this._dM = 2 * Math.PI * this._mark / SR;
    this._dS = 2 * Math.PI * this._space / SR;
    this._ring = new Float64Array(this._n * 4);             // mI mQ sI sQ per slot
    this._pos = 0;
    this._sum = new Float64Array(4);
    this._since = 0;

    // Prefilter for HF: band-pass on the tone pair (RBJ biquad, 0 dB peak).
    this._bp = null;
    if (this._baud <= 600) {
      const f0 = (this._mark + this._space) / 2;
      const Q = f0 / ((this._space - this._mark) + 2 * this._baud);
      const w = 2 * Math.PI * f0 / SR, al = Math.sin(w) / (2 * Q), a0 = 1 + al;
      this._bp = { b0: al / a0, b2: -al / a0, a1: -2 * Math.cos(w) / a0, a2: (1 - al) / a0,
                   x1: 0, x2: 0, y1: 0, y2: 0 };
    }

    const step = Math.round(4294967296 * this._baud / SR);
    this._pllStep = step | 0;
    this._slicers = SLICER_GAINS.map((g) => ({
      g, pll: 0, prevD: 0, lastBit: 0,
      pat: 0, acc: 0, olen: 0, inFrame: false, flagRun: 0,
      buf: new Uint8Array(MAX_FRAME), len: 0,
    }));

    this._t = 0;                       // samples since reset
    this._recent = new Map();          // de-duplication across slicers
    this._lastFlagAt = -1e9;
    this._levelAcc = 0; this._levelN = 0;
    this._nextMetrics = Math.round(SR * METRICS_INTERVAL_S);
    this._onStatus(`${this._baud} Bd · ${this._mark}/${this._space} Hz`);
  }

  feed(pcm) {
    const SR = this._srFn() || 12000;
    if (SR !== this._sr) this.reset();
    const n = this._n, ring = this._ring, sum = this._sum, bp = this._bp;

    for (let i = 0; i < pcm.length; i++) {
      let x = pcm[i];
      if (bp) {
        const y = bp.b0 * x + bp.b2 * bp.x2 - bp.a1 * bp.y1 - bp.a2 * bp.y2;
        bp.x2 = bp.x1; bp.x1 = x; bp.y2 = bp.y1; bp.y1 = y;
        x = y;
      }
      this._levelAcc += x * x; this._levelN++;

      // Mix both tones to DC and run the one-bit boxcars.
      const k = this._pos * 4;
      const mI = x * Math.cos(this._phM), mQ = x * Math.sin(this._phM);
      const sI = x * Math.cos(this._phS), sQ = x * Math.sin(this._phS);
      sum[0] += mI - ring[k];     ring[k]     = mI;
      sum[1] += mQ - ring[k + 1]; ring[k + 1] = mQ;
      sum[2] += sI - ring[k + 2]; ring[k + 2] = sI;
      sum[3] += sQ - ring[k + 3]; ring[k + 3] = sQ;
      if (++this._pos === n) this._pos = 0;
      this._phM += this._dM; if (this._phM > 2 * Math.PI) this._phM -= 2 * Math.PI;
      this._phS += this._dS; if (this._phS > 2 * Math.PI) this._phS -= 2 * Math.PI;
      // Re-sum from the ring now and then so rounding cannot accumulate.
      if (++this._since >= 8192) {
        this._since = 0;
        sum.fill(0);
        for (let j = 0; j < ring.length; j += 4) {
          sum[0] += ring[j]; sum[1] += ring[j + 1]; sum[2] += ring[j + 2]; sum[3] += ring[j + 3];
        }
      }

      const m = Math.hypot(sum[0], sum[1]);
      const s = Math.hypot(sum[2], sum[3]);
      for (let j = 0; j < this._slicers.length; j++) this._slice(this._slicers[j], m - s * this._slicers[j].g);

      this._t++;
      if (this._t >= this._nextMetrics) {
        this._nextMetrics = this._t + Math.round(SR * METRICS_INTERVAL_S);
        this._emitMetrics();
      }
    }
  }

  _slice(sl, d) {
    // Clock: pull the phase towards zero at each transition, sample on wrap.
    if ((d > 0) !== (sl.prevD > 0)) {
      sl.pll = (sl.pll * (sl.inFrame ? PLL_INERTIA_LOCK : PLL_INERTIA_HUNT)) | 0;
    }
    sl.prevD = d;
    const prev = sl.pll;
    sl.pll = (sl.pll + this._pllStep) | 0;
    if (!(prev > 0 && sl.pll < 0)) return;

    const raw = d > 0 ? 1 : 0;
    const bit = raw === sl.lastBit ? 1 : 0;   // NRZI
    sl.lastBit = raw;
    this._hdlc(sl, bit);
  }

  _hdlc(sl, bit) {
    sl.pat = ((sl.pat >> 1) | (bit << 7)) & 0xFF;
    if (sl.pat === 0x7E) {
      if (sl.inFrame && sl.olen === 7 && sl.len >= MIN_FRAME) this._frameEnd(sl);
      // DCD: a run of back-to-back flags is a preamble. A single 0x7E turns
      // up in noise every few hundred bits, three in a row almost never.
      sl.flagRun = sl.inFrame && sl.olen === 7 && sl.len === 0 ? sl.flagRun + 1 : 1;
      if (sl.flagRun >= 3) this._lastFlagAt = this._t;
      sl.inFrame = true;
      sl.len = 0; sl.olen = 0; sl.acc = 0;
      return;
    }
    if (sl.pat === 0xFE) { sl.inFrame = false; sl.len = 0; sl.olen = 0; return; }   // abort
    if ((sl.pat & 0xFC) === 0x7C) return;                                            // stuffed 0
    if (!sl.inFrame) return;
    sl.acc = (sl.acc >> 1) | (bit << 7);
    if (++sl.olen === 8) {
      sl.olen = 0;
      if (sl.len >= MAX_FRAME) { sl.inFrame = false; sl.len = 0; return; }
      sl.buf[sl.len++] = sl.acc;
    }
  }

  _frameEnd(sl) {
    const len = sl.len;
    const fcs = sl.buf[len - 2] | (sl.buf[len - 1] << 8);
    if (crc16x25(sl.buf, len - 2) !== fcs) return;

    // Several slicers decode the same frame within a bit or two of each other.
    const key = `${fcs}:${len}`;
    const seen = this._recent.get(key);
    const window = (len * 8 / this._baud) * 0.5 * this._sr;
    if (seen != null && this._t - seen < window) return;
    this._recent.set(key, this._t);
    if (this._recent.size > 64) {
      for (const [k, v] of this._recent) if (this._t - v > this._sr * 10) this._recent.delete(k);
    }

    const frame = parseAX25(sl.buf.slice(0, len - 2));
    if (!frame) return;
    this._framesOk++;
    this._lastFlagAt = this._t;
    this._stations.add(frame.src.name);
    this._report(frame);
  }

  _report(f) {
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    const ss = String(now.getUTCSeconds()).padStart(2, '0');
    const stamp = `${hh}:${mm}:${ss}`;
    const head = tnc2Header(f);
    const text = infoText(f.info);

    if (!this._aprs) {
      const kind = [f.type, f.detail, f.cr, f.pid >= 0 ? `pid=${f.pid.toString(16).toUpperCase().padStart(2, '0')}` : '']
        .filter(Boolean).join(' ');
      this._onLine(`${stamp} ${head} <${kind}>${text ? ': ' + text : ''}`, null);
      return;
    }

    // APRS view: UI frames only (APRS is connectionless by definition).
    if (f.type !== 'UI') return;
    // UTF-8 when it is valid (comments in Greek, Cyrillic, ...), else bytes.
    let info;
    try { info = new TextDecoder('utf-8', { fatal: true }).decode(f.info); }
    catch (_) { info = String.fromCharCode(...f.info); }
    const r = parseAPRS(f.dst.call, info);
    // Plain data only: this crosses the worker boundary.
    const pos = Number.isFinite(r.lat) && Number.isFinite(r.lon)
      ? { call: r.name || f.src.name, via: f.src.name, lat: r.lat, lon: r.lon,
          text: r.text, symbol: r.symbol || '', killed: !!r.killed, time: now.getTime() }
      : null;
    if (this._showRaw) {
      this._onLine(`${stamp} ${head}:${text}`, null);
      this._onLine(`         ↳ ${f.src.name} · ${r.text}`, pos);
    } else {
      this._onLine(`${stamp} ${f.src.name} · ${r.text}`, pos);
    }
  }

  _emitMetrics() {
    const rms = this._levelN ? Math.sqrt(this._levelAcc / this._levelN) : 0;
    this._levelAcc = 0; this._levelN = 0;
    const dcd = this._t - this._lastFlagAt < this._sr * DCD_HOLD_S;
    this._onMetrics({
      dcd,
      timingLocked: dcd,
      framesOk: this._framesOk,
      stations: this._stations.size,
      levelDb: rms > 0 ? 20 * Math.log10(rms) : -120,
      markHz: this._mark,
      spaceHz: this._space,
    });
  }
}
