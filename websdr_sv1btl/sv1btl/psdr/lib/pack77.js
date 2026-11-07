// pack77.js — WSJT-X 77-bit message unpacking (and a little packing for tests)
// ============================================================================
// A port of unpack77 and its helpers from WSJT-X lib/77bit/packjt77.f90
// (GPL-3), used by the MSK144 and FST4W decoders. Every message type WSJT-X
// defines is handled: free text (0.0), DXpedition (0.1), Field Day (0.3/0.4),
// telemetry (0.5), WSPR-style (0.6, FST4W), standard and /R /P (1, 2),
// RTTY Roundup (3), non-standard calls (4) and EU VHF contest (5).
//
// Calls heard in full are remembered in a hash table so later messages that
// carry only a 10/12/22-bit hash of them can print the call (in <>), as
// WSJT-X does; unknown hashes print as <...>.
//
//   new HashTable()
//   unpack77(bits, hash)      bits: 77 values 0/1 → { msg, ok, i3, n3 }
//   pack77std(call1, call2, extra) → 77 bits (types 1/2 only; test encoder)
// ============================================================================

export const NTOKENS = 2063592, MAX22 = 4194304, MAXGRID4 = 32400;
const NZZZ = 46656;
const C1 = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const C2 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const C4 = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const HASHC = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/';
const TEXTC = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?';

const CSEC = ['AB', 'AK', 'AL', 'AR', 'AZ', 'BC', 'CO', 'CT', 'DE', 'EB', 'EMA', 'ENY', 'EPA', 'EWA', 'GA', 'GH', 'IA', 'ID', 'IL', 'IN',
  'KS', 'KY', 'LA', 'LAX', 'NS', 'MB', 'MDC', 'ME', 'MI', 'MN', 'MO', 'MS', 'MT', 'NC', 'ND', 'NE', 'NFL', 'NH', 'NL', 'NLI',
  'NM', 'NNJ', 'NNY', 'TER', 'NTX', 'NV', 'OH', 'OK', 'ONE', 'ONN', 'ONS', 'OR', 'ORG', 'PAC', 'PR', 'QC', 'RI', 'SB', 'SC', 'SCV',
  'SD', 'SDG', 'SF', 'SFL', 'SJV', 'SK', 'SNJ', 'STX', 'SV', 'TN', 'UT', 'VA', 'VI', 'VT', 'WCF', 'WI', 'WMA', 'WNY', 'WPA', 'WTX',
  'WV', 'WWA', 'WY', 'DX', 'PE', 'NB'];
const CMULT = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'NB', 'NS', 'QC', 'ON', 'MB', 'SK', 'AB', 'BC', 'NWT', 'NF',
  'LB', 'NU', 'YT', 'PEI', 'DC', 'DR', 'FR', 'GD', 'GR', 'OV', 'ZH', 'ZL',
  ...Array.from({ length: 99 }, (_, i) => 'X' + String(i + 1).padStart(2, '0'))];

/** ihashcall: the top m bits of 47055833459 × (base-38 value of 11 chars). */
export function ihashcall(call, m) {
  const c = (call.toUpperCase() + '             ').slice(0, 11);
  let n8 = 0n;
  for (let i = 0; i < 11; i++) n8 = 38n * n8 + BigInt(Math.max(0, HASHC.indexOf(c[i])));
  const p = (47055833459n * n8) & 0xffffffffffffffffn;
  return Number(p >> BigInt(64 - m));
}

/** Calls heard in full, by their 10, 12 and 22-bit hashes (save_hash_call). */
export class HashTable {
  constructor(max = 1000) { this.max = max; this.h10 = new Map(); this.h12 = new Map(); this.h22 = new Map(); }
  save(call) {
    let cw = String(call || '').trim();
    if (!cw || cw.startsWith('<...>')) return;
    if (cw[0] === '<') cw = cw.slice(1);
    const i = cw.indexOf('>');
    if (i >= 0) cw = cw.slice(0, i);
    if (cw.length < 3) return;
    for (const [m, map] of [[10, this.h10], [12, this.h12], [22, this.h22]]) {
      const h = ihashcall(cw, m);
      map.delete(h); map.set(h, cw);
      if (map.size > this.max) map.delete(map.keys().next().value);
    }
  }
  lookup(m, n) {
    const c = (m === 10 ? this.h10 : m === 12 ? this.h12 : this.h22).get(n);
    return c ? `<${c}>` : '<...>';
  }
}

export function callok(w) {
  const n = w.length;
  if (n < 3 || w[0] === 'Q') return false;
  const isdig = (c) => c >= '0' && c <= '9';
  const islet = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
  let i0 = 0;
  for (let i = n; i >= 1; i--) { if (isdig(w[i - 1])) { i0 = i; break; } }
  if (i0 !== 2 && i0 !== 3) return false;
  const pfx = w.slice(0, i0 - 1), sfx = w.slice(i0);
  if (![...pfx].some(islet)) return false;
  return [...sfx].every(islet);
}

/** unpack28 → call text, or null when it is not a valid call. */
export function unpack28(n28, hash) {
  if (n28 < NTOKENS) {
    if (n28 === 0) return 'DE';
    if (n28 === 1) return 'QRZ';
    if (n28 === 2) return 'CQ';
    if (n28 <= 1002) return 'CQ_' + String(n28 - 3).padStart(3, '0');
    if (n28 <= 532443) {
      let n = n28 - 1003;
      const i1 = Math.floor(n / 19683); n -= 19683 * i1;
      const i2 = Math.floor(n / 729); n -= 729 * i2;
      const i3 = Math.floor(n / 27), i4 = n - 27 * i3;
      return 'CQ_' + (C4[i1] + C4[i2] + C4[i3] + C4[i4]).trim();
    }
  }
  let n = n28 - NTOKENS;
  if (n < 0) return null;
  if (n < MAX22) return hash.lookup(22, n);
  n -= MAX22;
  const i1 = Math.floor(n / (36 * 10 * 27 * 27 * 27)); n -= 36 * 10 * 27 * 27 * 27 * i1;
  const i2 = Math.floor(n / (10 * 27 * 27 * 27)); n -= 10 * 27 * 27 * 27 * i2;
  const i3 = Math.floor(n / (27 * 27 * 27)); n -= 27 * 27 * 27 * i3;
  const i4 = Math.floor(n / 729); n -= 729 * i4;
  const i5 = Math.floor(n / 27), i6 = n - 27 * i5;
  if (i1 > 36 || i2 > 35) return null;
  const c = (C1[i1] + C2[i2] + '0123456789'[i3] + C4[i4] + C4[i5] + C4[i6]).trim();
  if (c.includes(' ') || !callok(c)) return null;
  return c;
}

export function toGrid4(n) {
  const j1 = Math.floor(n / 1800); n -= j1 * 1800;
  const j2 = Math.floor(n / 100); n -= j2 * 100;
  const j3 = Math.floor(n / 10), j4 = n - j3 * 10;
  if (j1 > 17 || j2 > 17) return null;
  return String.fromCharCode(65 + j1, 65 + j2, 48 + j3, 48 + j4);
}
export function toGrid6(n) {
  const j1 = Math.floor(n / 1036800); n -= j1 * 1036800;
  const j2 = Math.floor(n / 57600); n -= j2 * 57600;
  const j3 = Math.floor(n / 5760); n -= j3 * 5760;
  const j4 = Math.floor(n / 576); n -= j4 * 576;
  const j5 = Math.floor(n / 24), j6 = n - j5 * 24;
  if (j1 > 17 || j2 > 17 || j5 > 23 || j6 > 23) return null;
  return String.fromCharCode(65 + j1, 65 + j2, 48 + j3, 48 + j4, 65 + j5, 65 + j6);
}
/** 4- or 6-character locator (to_grid, FST4W type 3). */
export function toGrid(n) {
  const j1 = Math.floor(n / 1125000); n -= j1 * 1125000;
  const j2 = Math.floor(n / 62500); n -= j2 * 62500;
  const j3 = Math.floor(n / 6250); n -= j3 * 6250;
  const j4 = Math.floor(n / 625); n -= j4 * 625;
  const j5 = Math.floor(n / 25), j6 = n - j5 * 25;
  if (j1 > 17 || j2 > 17 || j5 > 24 || j6 > 24) return null;
  let g = String.fromCharCode(65 + j1, 65 + j2, 48 + j3, 48 + j4);
  if (j5 !== 24 || j6 !== 24) g += String.fromCharCode(65 + j5, 65 + j6);
  return g;
}

const val = (bits, from, len) => { let v = 0; for (let i = 0; i < len; i++) v = v * 2 + bits[from + i]; return v; };
const valBig = (bits, from, len) => { let v = 0n; for (let i = 0; i < len; i++) v = v * 2n + BigInt(bits[from + i]); return v; };
const sgn2 = (n) => (n >= 0 ? '+' : '-') + String(Math.abs(n)).padStart(2, '0');

/** The type 0.6 part (FST4W / WSPR-style 50 bits) → { msg, call, grid, dbm } or null. */
export function unpackWspr50(bits, hash) {
  const j48 = bits[47], j49 = bits[48], j50 = bits[49];
  const itype = j50 === 1 ? 2 : j49 === 0 ? 1 : j48 === 0 ? 3 : -1;
  if (itype === 1) {
    const dbm = Math.round(val(bits, 43, 5) * 10 / 3);
    const call = unpack28(val(bits, 0, 28), hash), grid = toGrid4(val(bits, 28, 15));
    if (!call || !grid || dbm < 0 || dbm > 60) return null;
    hash.save(call);
    return { msg: `${call} ${grid} ${dbm}`, call, grid, dbm };
  }
  if (itype === 2) {
    let npfx = val(bits, 28, 16);
    const dbm = Math.round(val(bits, 44, 5) * 10 / 3);
    const call = unpack28(val(bits, 0, 28), hash);
    if (!call || dbm < 0 || dbm > 60) return null;
    let full;
    if (npfx < NZZZ) {
      let p = '';
      for (let i = 0; i < 3; i++) { p = C2[npfx % 36] + p; npfx = Math.floor(npfx / 36); if (!npfx) break; }
      full = `${p}/${call}`;
    } else {
      npfx -= NZZZ;
      let s;
      if (npfx <= 35) s = C2[npfx];
      else if (npfx <= 1295) s = C2[Math.floor(npfx / 36)] + C2[npfx % 36];
      else if (npfx <= 12959) s = C2[Math.floor(npfx / 360)] + C2[Math.floor(npfx / 10) % 36] + C2[npfx % 10];
      else return null;
      full = `${call}/${s}`;
    }
    hash.save(full);
    return { msg: `${full} ${dbm}`, call: full, grid: '', dbm };
  }
  if (itype === 3) {
    const call = unpack28(val(bits, 0, 22) + NTOKENS, hash), grid = toGrid(val(bits, 22, 25));
    if (!call || !grid) return null;
    return { msg: `${call} ${grid}`, call, grid, dbm: null };
  }
  return null;
}

/** unpack77: 77 bits → { msg, ok, i3, n3 }. */
export function unpack77(bits, hash = new HashTable()) {
  const n3 = val(bits, 71, 3), i3 = val(bits, 74, 3);
  const res = (msg, ok = true) => ({ msg: msg || '', ok: !!ok && !!msg && !msg.startsWith('CQ <'), i3, n3 });
  if (i3 === 0 && n3 === 0) {
    // free text: 71 bits = a base-42 number of 13 characters
    let v = valBig(bits, 0, 71), s = '';
    for (let i = 0; i < 13; i++) { s = TEXTC[Number(v % 42n)] + s; v = v / 42n; }
    s = s.trim();
    return res(s, s.length > 0);
  }
  if (i3 === 0 && n3 === 1) {
    const n28a = val(bits, 0, 28), n28b = val(bits, 28, 28), n10 = val(bits, 56, 10), n5 = val(bits, 66, 5);
    const c1 = unpack28(n28a, hash), c2 = unpack28(n28b, hash);
    const ok = c1 && c2 && n28a > 2 && n28b > 2;
    return res(`${c1} RR73; ${c2} ${hash.lookup(10, n10)} ${sgn2(2 * n5 - 30)}`, ok);
  }
  if (i3 === 0 && (n3 === 3 || n3 === 4)) {
    const n28a = val(bits, 0, 28), n28b = val(bits, 28, 28), ir = bits[56], intx = val(bits, 57, 4), ncl = val(bits, 61, 3), isec = val(bits, 64, 7);
    const c1 = unpack28(n28a, hash), c2 = unpack28(n28b, hash);
    const ok = c1 && c2 && n28a > 2 && n28b > 2 && isec >= 1 && isec <= CSEC.length;
    const ntx = intx + 1 + (n3 === 4 ? 16 : 0);
    const cntx = `${ntx}${String.fromCharCode(65 + ncl)}`;
    return res(`${c1} ${c2} ${ir ? 'R ' : ''}${cntx} ${CSEC[(isec || 1) - 1]}`, ok);
  }
  if (i3 === 0 && n3 === 5) {
    const h = val(bits, 0, 23).toString(16).padStart(6, '0') + valBig(bits, 23, 24).toString(16).padStart(6, '0') + valBig(bits, 47, 24).toString(16).padStart(6, '0');
    const t = h.toUpperCase().replace(/^0+/, '');
    return res(t || '0');
  }
  if (i3 === 0 && n3 === 6) {
    const u = unpackWspr50(bits, hash);
    return u ? res(u.msg) : res('', false);
  }
  if (i3 === 0) return res('', false);
  if (i3 === 1 || i3 === 2) {
    const n28a = val(bits, 0, 28), ipa = bits[28], n28b = val(bits, 29, 28), ipb = bits[57], ir = bits[58], igrid4 = val(bits, 59, 15);
    let c1 = unpack28(n28a, hash), c2 = unpack28(n28b, hash);
    let ok = !!(c1 && c2);
    if (!ok) return res('', false);
    if (c1.startsWith('CQ_')) c1 = 'CQ ' + c1.slice(3);
    const suffix = i3 === 1 ? '/R' : '/P';
    if (!c1.includes('<') && c1.length >= 3 && !c1.startsWith('CQ') && c1 !== 'DE' && c1 !== 'QRZ') { if (ipa) c1 += suffix; hash.save(c1); }
    if (!c2.includes('<') && c2.length >= 3) { if (ipb) c2 += suffix; hash.save(c2); }
    let msg;
    if (igrid4 <= MAXGRID4) {
      const g = toGrid4(igrid4);
      if (!g) ok = false;
      msg = `${c1} ${c2} ${ir ? 'R ' : ''}${g}`;
      if (msg.startsWith('CQ ') && ir) ok = false;
    } else {
      const irpt = igrid4 - MAXGRID4;
      if (irpt === 1) msg = `${c1} ${c2}`;
      else if (irpt === 2) msg = `${c1} ${c2} RRR`;
      else if (irpt === 3) msg = `${c1} ${c2} RR73`;
      else if (irpt === 4) msg = `${c1} ${c2} 73`;
      else if (irpt >= 5) {
        let isnr = irpt - 35;
        if (isnr > 50) isnr -= 101;
        msg = `${c1} ${c2} ${ir ? 'R' : ''}${sgn2(isnr)}`;
      } else { msg = `${c1} ${c2}`; ok = false; }
      if (msg.startsWith('CQ ') && irpt >= 2) ok = false;
    }
    return res(msg, ok);
  }
  if (i3 === 3) {
    const itu = bits[0], n28a = val(bits, 1, 28), n28b = val(bits, 29, 28), ir = bits[57], irpt = val(bits, 58, 3), nexch = val(bits, 61, 13);
    const c1 = unpack28(n28a, hash), c2 = unpack28(n28b, hash);
    if (!c1 || !c2) return res('', false);
    const crpt = `5${irpt + 2}9`;
    let ex;
    if (nexch > 8000 && nexch - 8000 <= CMULT.length) ex = CMULT[nexch - 8000 - 1];
    else if (nexch >= 1 && nexch <= 7999) ex = String(nexch).padStart(4, '0');
    else return res('', false);
    return res(`${itu ? 'TU; ' : ''}${c1} ${c2} ${ir ? 'R ' : ''}${crpt} ${ex}`);
  }
  if (i3 === 4) {
    const n12 = val(bits, 0, 12);
    let n58 = valBig(bits, 12, 58);
    const iflip = bits[70], nrpt = val(bits, 71, 2), icq = bits[73];
    let c11 = '';
    for (let i = 0; i < 11; i++) { c11 = HASHC[Number(n58 % 38n)] + c11; n58 = n58 / 38n; }
    c11 = c11.trim();
    const c3 = hash.lookup(12, n12);
    let c1, c2;
    if (iflip === 0) { c1 = c3; c2 = c11; hash.save(c2); } else { c1 = c11; c2 = c3; hash.save(c1); }
    if (icq) return res(`CQ ${c2}`);
    return res(`${c1} ${c2}${['', ' RRR', ' RR73', ' 73'][nrpt]}`);
  }
  if (i3 === 5) {
    const n12 = val(bits, 0, 12), n22 = val(bits, 12, 22), ir = bits[34], irpt = val(bits, 35, 3), iserial = val(bits, 38, 11), igrid6 = val(bits, 49, 25);
    if (igrid6 > 18662399) return res('', false);
    const g = toGrid6(igrid6);
    if (!g) return res('', false);
    const exch = `${52 + irpt}${String(iserial).padStart(4, '0')}`;
    return res(`${hash.lookup(12, n12)} ${hash.lookup(22, n22)} ${ir ? 'R ' : ''}${exch} ${g}`);
  }
  return res('', false);
}

// ── packing, types 1/2 (test encoders) ─────────────────────────────────────
export function pack28(call) {
  const up = call.toUpperCase();
  if (up === 'DE') return 0;
  if (up === 'QRZ') return 1;
  if (up === 'CQ') return 2;
  let c = up;
  if (c.length >= 2 && c[1] >= '0' && c[1] <= '9') c = ' ' + c;
  c = (c + '      ').slice(0, 6);
  const i1 = C1.indexOf(c[0]), i2 = C2.indexOf(c[1]), i3 = '0123456789'.indexOf(c[2]);
  const i4 = C4.indexOf(c[3]), i5 = C4.indexOf(c[4]), i6 = C4.indexOf(c[5]);
  if (i1 < 0 || i2 < 0 || i3 < 0 || i4 < 0 || i5 < 0 || i6 < 0) throw new Error('not a standard call: ' + call);
  return NTOKENS + MAX22 + ((((i1 * 36 + i2) * 10 + i3) * 27 + i4) * 27 + i5) * 27 + i6;
}

/** "CALL1 CALL2 EXTRA" (EXTRA: grid4, R grid4, ±NN, R±NN, RRR, RR73, 73 or empty) → 77 bits, type 1. */
export function pack77std(call1, call2, extra = '') {
  const bits = new Uint8Array(77);
  const put = (v, from, len) => { for (let i = 0; i < len; i++) bits[from + i] = Math.floor(v / 2 ** (len - 1 - i)) % 2; };
  let ir = 0, ig;
  let e = extra.trim().toUpperCase();
  if (e.startsWith('R ') ) { ir = 1; e = e.slice(2); }
  if (/^[A-R]{2}[0-9]{2}$/.test(e)) ig = (((e.charCodeAt(0) - 65) * 18 + (e.charCodeAt(1) - 65)) * 10 + (e.charCodeAt(2) - 48)) * 10 + (e.charCodeAt(3) - 48);
  else if (e === '') ig = MAXGRID4 + 1;
  else if (e === 'RRR') ig = MAXGRID4 + 2;
  else if (e === 'RR73') ig = MAXGRID4 + 3;
  else if (e === '73') ig = MAXGRID4 + 4;
  else if (/^R?[+-][0-9]{2}$/.test(e)) {
    if (e[0] === 'R') { ir = 1; e = e.slice(1); }
    let isnr = Number(e);
    let irpt = isnr + 35;
    if (irpt < 5) irpt += 101;
    ig = MAXGRID4 + irpt;
  } else throw new Error('pack77std: unsupported extra ' + extra);
  put(pack28(call1), 0, 28); bits[28] = 0;
  put(pack28(call2), 29, 28); bits[57] = 0;
  bits[58] = ir; put(ig, 59, 15); put(1, 74, 3);
  return bits;
}
