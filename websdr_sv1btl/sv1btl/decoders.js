// decoders.js — digital-mode decoders for the SV1BTL WebSDR page (desktop), 2026-10-07.
//
// FT8, FT4, FT2, JS8, WSPR, SSTV, HF FAX, NAVTEX and RTTY, decoded in the listener's
// browser by PhantomSDR-Plus's decoders (github.com/sv1btl/PhantomSDR-Plus,
// frontend/src), copied unchanged into sv1btl/psdr/ (only the paths of their .wasm and
// dictionary files changed). They run in Web Workers. This file is the glue: the
// "Decoder" buttons under the Mode buttons, one window per decoder above "Waterfall
// Settings", the slot timing of FT8/FT4/FT2/JS8/WSPR (as PhantomSDR-Plus audio.js:
// capture from a UTC slot boundary plus a time shift, decode, auto-sync the shift from
// the decoded DT), and the audio feed: ubersdr-compat.js hands every received audio
// block here (window.ubersdr_dec_tap), raw, before squelch, AGC boost, notch and NR.
// One decoder at a time. Choosing AM, FM, CW or RADE, or the lit button, stops it.
//
// Licence: GNU GPL v3, as PhantomSDR-Plus.

import { SSTVWorkerProxy } from './psdr/sstvWorkerProxy.js';
import { FAXWorkerProxy } from './psdr/faxWorkerProxy.js';
import { FSKWorkerProxy } from './psdr/fskWorkerProxy.js';
import { FLDIGI_MODEMS } from './psdr/fsk.js';
import { mt63DefaultCenter } from './psdr/mt63.js';
import { WSPR_TOTAL_SAMPLES, wspr2SlotPosition } from './psdr/modules/wspr.js';
import { decodeFrame as js8DecodeFrame, loadDictionary as js8LoadDictionary } from './psdr/modules/js8.js';
import { Js8Reassembler } from './psdr/modules/js8-reassembler.js';
import { formatJs8Message } from './psdr/modules/js8-format.js';
import { js8Period, js8CaptureSamples, js8SlotPos, js8StartWindow } from './psdr/modules/js8-slots.js';

// HF FAX stations, from PhantomSDR-Plus App.svelte (frequencies: centre of the signal, kHz)
const FAX_STATIONS = [
  // ── Europe ────────────────────────────────────────────────────────────
  {
    name: "GYA — UK Northwood",
    freqs: [2618.5, 4610, 8040, 11086.5],
    lpm: 120,
    ioc: 576,
  },
  {
    name: "DDH3/DDK6 — Germany Hamburg",
    freqs: [3855, 7880, 13882.5],
    lpm: 120,
    ioc: 576,
  },
  {
    name: "SVJ4 — Greece Athens",
    freqs: [4482.9, 8106.9],
    lpm: 120,
    ioc: 576,
  },
  // ── Russia ────────────────────────────────────────────────────────────
  {
    name: "RBW41 — Russia Murmansk",
    freqs: [5336, 6445.5, 7908.8, 8444, 10130],
    lpm: 120,
    ioc: 576,
  },
  // ── Asia ──────────────────────────────────────────────────────────────
  {
    name: "HLL2 — South Korea Seoul",
    freqs: [3585, 5857.5, 7433.5, 9165, 13570],
    lpm: 120,
    ioc: 576,
  },
  {
    name: "JMH — Japan Tokyo",
    freqs: [3622.5, 7795, 13988.5],
    lpm: 120,
    ioc: 576,
  },
  {
    name: "JFX — Japan Kagoshima",
    freqs: [4274, 8658, 13074, 16907.5, 22559.6],
    lpm: 120,
    ioc: 576,
  },
  {
    name: "XSG — China Shanghai",
    freqs: [4170, 8302, 12382, 16559],
    lpm: 120,
    ioc: 576,
  },
  {
    name: "XSQ — China Guangzhou",
    freqs: [4199.75, 8412.5, 12629.25, 16826.25],
    lpm: 120,
    ioc: 576,
  },
  // ── Pacific ───────────────────────────────────────────────────────────
  {
    name: "VMC — Australia Charleville",
    freqs: [2628, 5100, 11030, 13920, 20469],
    lpm: 120,
    ioc: 576,
  },
  {
    name: "VMW — Australia Wiluna",
    freqs: [5755, 7535, 10555, 15615, 18060],
    lpm: 120,
    ioc: 576,
  },
  // ZLM — New Zealand Wellington: ceased radiofax 1 July 2023
  // ── Americas ──────────────────────────────────────────────────────────
  {
    name: "KVM70 — USA Honolulu HI",
    freqs: [9982.5, 11090, 16135],
    lpm: 120,
    ioc: 576,
  },
  {
    name: "NMC — USA Point Reyes CA",
    freqs: [4346, 8682, 12786, 17151.2, 22527],
    lpm: 120,
    ioc: 576,
  },
  {
    name: "NMG — USA New Orleans LA",
    freqs: [4317.9, 8503.9, 12789.9, 17146.4],
    lpm: 120,
    ioc: 576,
  },
  {
    name: "NMF — USA Boston MA",
    freqs: [4235, 6340.5, 9110, 12750],
    lpm: 120,
    ioc: 576,
  },
  {
    name: "NOJ — USA Kodiak AK",
    freqs: [2054, 4298, 8459, 12412.5],
    lpm: 120,
    ioc: 576,
  },
  {
    name: "VCO — Canada Sydney NS",
    freqs: [4416, 6915.1],
    lpm: 120,
    ioc: 576,
  },
  {
    name: "CBV — Chile Valparaiso",
    freqs: [4228, 8677, 17146.4],
    lpm: 120,
    ioc: 576,
  },
  {
    name: "CBM — Chile Punta Arenas",
    freqs: [4322, 8696],
    lpm: 120,
    ioc: 576,
  },
];

// Dial frequencies (kHz, USB), from PhantomSDR-Plus modePriors.js
const FT8_DIALS  = [1840, 3573, 5357, 7074, 10136, 14074, 18100, 21074, 24915, 28074, 50313];
const FT4_DIALS  = [3575.5, 7047.5, 10140, 14080, 18104, 21140, 24919, 28180];
const JS8_DIALS  = [1842, 3578, 7078, 10130, 14078, 18104, 21078, 24922, 28078];
const WSPR_DIALS = [136, 474.2, 1836.6, 3568.6, 5287.2, 7038.6, 10138.7, 14095.6, 18104.6, 21094.6, 24924.6, 28124.6];
const NAVTEX_STATIONS = [
  ['International NAVTEX 518 kHz', 518], ['National NAVTEX 490 kHz', 490], ['Japan 424 kHz', 424],
  ['HF NAVTEX 4209.5 kHz', 4209.5], ['HF 6314 kHz', 6314], ['HF 8416.5 kHz', 8416.5],
  ['HF 12579 kHz', 12579], ['HF 16806.5 kHz', 16806.5]];
const RTTY_FREQS = {          // signal centre, kHz (PhantomSDR-Plus FSK_KNOWN_FREQUENCIES)
  ham: [['80m RTTY 3590', 3590], ['40m RTTY 7043', 7043], ['30m RTTY 10143', 10143], ['20m RTTY 14083', 14083],
        ['15m RTTY 21083', 21083], ['10m RTTY 28083', 28083]],
  weather: [['DWD DDK2 4583', 4583], ['DWD DDH7 7646', 7646], ['DWD DDK9 10100.8', 10100.8],
            ['DWD DDH9 11039', 11039], ['DWD DDH8 14467.3', 14467.3]]
};
// PSK31 and Olivia: signal frequencies, kHz (PhantomSDR-Plus FSK_KNOWN_FREQUENCIES)
const PSK31_FREQS = [['80m 3580.15', 3580.15], ['40m 7040.15', 7040.15], ['30m 10142.15', 10142.15], ['20m 14070.15', 14070.15],
                     ['17m 18100.15', 18100.15], ['15m 21080.15', 21080.15], ['12m 24920.15', 24920.15], ['10m 28120.15', 28120.15]];
const OLIVIA_FREQS = [['80m 3583.00 (8/250)', 3583], ['40m 7040.00 (8/250)', 7040], ['40m 7072.50 (8/250)', 7072.5],
                      ['30m 10143.00 (8/250)', 10143], ['20m 14072.50 (8/250)', 14072.5], ['20m 14108.50 (32/1000)', 14108.5],
                      ['17m 18099.00 (8/250)', 18099], ['15m 21072.50 (8/250)', 21072.5], ['12m 24922.50 (8/250)', 24922.5],
                      ['10m 28122.50 (8/250)', 28122.5]];
// The four Olivia set-ups that cover nearly all traffic (PhantomSDR-Plus OLIVIA_MODE_OPTIONS)
const OLIVIA_MODES = [{ t: 8, b: 250, label: '8/250' }, { t: 16, b: 500, label: '16/500' },
                      { t: 32, b: 1000, label: '32/1000' }, { t: 16, b: 1000, label: '16/1000' }];
const SSTV_FREQS = [['80m 3735 LSB', 3735], ['40m 7171 LSB', 7171], ['20m 14230 USB', 14230], ['20m 14233 USB', 14233],
                    ['15m 21340 USB', 21340], ['10m 28680 USB', 28680]];
const JS8_NAMES = ['Normal', 'Fast', 'Turbo', 'Slow', 'Ultra'];

// Per decoder: the page's sideband and filter (kHz of audio) while it runs
const DEC = {
  ft8:    { label: 'FT8',    title: 'FT8 (15 s slots)',      kind: 'ftx', slot: 15,   dials: FT8_DIALS,  lo: 0.1, hi: 3.0 },
  ft4:    { label: 'FT4',    title: 'FT4 (7.5 s slots)',     kind: 'ftx', slot: 7.5,  dials: FT4_DIALS,  lo: 0.1, hi: 3.0 },
  ft2:    { label: 'FT2',    title: 'FT2 (3.75 s slots)',    kind: 'ftx', slot: 3.75, dials: null,       lo: 0.1, hi: 3.0 },
  js8:    { label: 'JS8',    title: 'JS8Call',               kind: 'js8',                 dials: JS8_DIALS,  lo: 0.1, hi: 3.0 },
  wspr:   { label: 'WSPR',   title: 'WSPR (2 min slots)',    kind: 'wspr',                dials: WSPR_DIALS, lo: 1.3, hi: 1.7 },
  sstv:   { label: 'SSTV',   title: 'SSTV pictures',         kind: 'sstv',                lo: 1.0, hi: 2.5 },
  fax:    { label: 'FAX',    title: 'HF weather fax',        kind: 'fax',                 lo: 1.1, hi: 2.7 },
  navtex: { label: 'NAVTEX', title: 'NAVTEX / SITOR-B',      kind: 'navtex',              lo: 0.25, hi: 0.75 },
  rtty:   { label: 'FLDIGI', title: 'FLDIGI modes: RTTY, PSK31, Olivia, MFSK, DominoEX, THOR, THROB, Hellschreiber, MT63, Packet, APRS (chosen in the window)', kind: 'rtty' },
  // No buttons of their own: chosen in the RTTY window's list (family 'rtty')
  psk31:  { label: 'PSK31',  title: 'PSK31 (BPSK, 31.25 Bd)', kind: 'psk31', centred: true, family: 'rtty' },
  olivia: { label: 'OLIVIA', title: 'Olivia (MFSK)',          kind: 'olivia', centred: true, family: 'rtty' },
  // PhantomSDR-Plus 5.1.0 fldigi modems (fsk.js FLDIGI_MODEMS) and AX.25 packet, one window each
  modem:  { label: 'MODEM',  title: 'fldigi modems',          kind: 'modem', centred: true, family: 'rtty' },
  packet: { label: 'PACKET', title: 'Packet / APRS (300 Bd)', kind: 'packet', centred: true, family: 'rtty' }
};

const W = window;
const SR = () => st.sr || 12000;
const st = { on: null, sr: 12000, el: null, row: null, win: null };
function $(sel) { return st.win ? st.win.querySelector(sel) : null; }
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function utcHM(ms) { return new Date(ms).toISOString().slice(11, 19); }

// ── Page control ───────────────────────────────────────────────────────────
function pageMode() { return String(W.mode || '').toUpperCase(); }
function dialKHz() { return Number(W.freq) || 0; }
// A filter narrower than 1.4 kHz makes the page "CW-like" (iscw): it shows and tunes the
// middle of the passband instead of the dial (WSPR on 14095.6 would read 14097.10). While
// a decoder runs the dial is what counts (WSPR 14095.6, NAVTEX 518, the RTTY lists), so
// the narrow decoder filters are not CW-like then.
const pageIscw = W.iscw;
// PSK31 and Olivia are the exception: their lists give signal frequencies, and a click on a
// trace should put it in the middle of the narrow filter, which is what CW-like does.
W.iscw = function () { return st.on && !DEC[st.on].centred ? false : pageIscw(); };
// The display follows when that changes (decoder on/off with a narrow filter)
function showDial() { try { W.setfreq(W.freq); } catch (e) {} }
// Puts the dial on f. With a filter narrower than 1.4 kHz and no decoder running the page
// counts as "CW-like" (iscw) and tunes the middle of the passband instead of the dial, so
// a plain USB filter goes in first; the caller then sets the decoder's own (applyFilter).
function tuneKHz(f) {
  try {
    listener();
    if (W.iscw()) W.set_mode('usb');
    W.setfreqif(f.toFixed(3));
  } catch (e) { console.error('decoders: tune', e); }
}
// A station or frequency picked in a decoder's list stays shown there while the dial is on
// it; tuning elsewhere puts the list back to its first line (so the same station can be
// picked again). The list goes with the window when the decoder is switched off.
let pickedDial = 0;
function picked(dial) { pickedDial = dial || 0; }
function pickedFollow() {
  const sel = $('.dw-tune');
  if (!sel || !sel.value || !pickedDial) return;
  if (Math.abs(dialKHz() - pickedDial) > 0.02) { sel.value = ''; pickedDial = 0; }
}
// The page's band-plan guard (ubersdr-compat.js) ignores mode changes by software for a
// moment after a band change; a decoder's mode and filter are the listener's own choice.
function listener() { if (W.ubersdr_listener_mode) W.ubersdr_listener_mode(); }
// Sideband and audio filter (lo..hi kHz of audio above/below the dial)
function setFilter(sb, lo, hi) {
  listener();
  if (sb === 'lsb') W.setmf('lsb', -hi, -lo); else W.setmf('usb', lo, hi);
  try { W.showhides(); } catch (e) {}
}
function nearest(list, f) {
  let best = null;
  for (const d of list) if (best === null || Math.abs(d - f) < Math.abs(best - f)) best = d;
  return best;
}
function sstvSideband(fk) { return fk > 0 && fk < 10000 ? 'lsb' : 'usb'; }

// ── Styles and elements ──────────────────────────────────────────────────────
(function style() {
  const s = document.createElement('style');
  s.textContent = `
#decrow{margin:1px 0 2px}
#decpresets .decpre{height:32px;line-height:1.15;padding:0 2px}
#decpresets .dp-n{display:block;font-weight:bold}
#decpresets .dp-v{display:block;font-size:.7rem}
#decrow b{font-size:13px}
#moderow #decrow .btnMode.decbtn{width:auto;min-width:40px;padding:0 4px;margin:2px 1px;font-size:.75rem}
.decwin{width:470px;margin:3px auto 4px;box-sizing:border-box;background:#f7f7f7;border:1px solid #bbb;border-radius:6px;
  font:11px/1.3 Arial,sans-serif;color:#222;text-align:left;box-shadow:1px 2px 5px rgba(0,0,0,.15)}
.decwin .dw-head{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;padding:3px 6px;background:#dfe6e4;border-radius:6px 6px 0 0}
.decwin .dw-title{font-weight:bold;flex:1;white-space:nowrap}
.decwin .dw-head span{color:#222}.decwin .dw-head b{color:#000}
.decwin select,.decwin button{font-size:10px;padding:0 3px;height:17px;max-width:190px}
.decwin label{white-space:nowrap}
.decwin .dw-list{height:120px;overflow-y:auto;background:#f7f7f7;color:#222;font:bold 11px/14px "Courier New",monospace}
.decwin table{border-collapse:collapse;width:100%}
.decwin th{position:sticky;top:0;background:#e4e4e4;color:#000;font:bold 11px Arial,sans-serif;text-align:left;padding:1px 3px;border-bottom:1px solid #ccc}
.decwin td{padding:0 3px;white-space:nowrap;border-bottom:1px solid #ddd;color:#222}
.decwin td.n{text-align:right;color:#06305a}
.decwin td.n.warn{color:#9a3a00}
.decwin td.m{color:#000;white-space:normal}
.decwin td.c{color:#054a1c}
.decwin tr.sep td{border-top:1px solid #aaa}
.decwin tr:hover td{background:#e3f1ee}
.decwin a{color:#04504a;font-weight:bold;text-decoration:none}
.decwin a:hover{text-decoration:underline}
.decwin .dw-text{height:120px;overflow-y:auto;padding:3px 6px;background:#f7f7f7;color:#000;
  font:12px/15px "Courier New",monospace;white-space:pre-wrap;word-break:break-word}
.decwin canvas{display:block;margin:0 auto;background:#000;image-rendering:auto}
.decwin .dw-bar{position:relative;height:15px;background:#e4e4e4;border-bottom:1px solid #ccc;overflow:hidden}
.decwin .dw-fill{position:absolute;left:0;top:0;bottom:0;width:0;background:#7cc7bd;transition:width .2s linear}
.decwin .dw-fill.wait{background:#b4b4b4}
.decwin .dw-bartxt{position:relative;display:block;text-align:center;font:bold 11px/15px Arial,sans-serif;color:#000}
.decwin .dw-sqbox input{width:70px;height:12px;vertical-align:middle;margin:0}
.decwin .dw-sqbox b{display:inline-block;min-width:34px}
.decwin .dw-status{padding:1px 6px 2px;color:#333;font-style:italic;border-top:1px solid #ddd;min-height:13px}
`;
  document.head.appendChild(s);
})();

function buildRow() {
  const moderow = document.getElementById('moderow');
  const anchor = document.getElementById('radestatus');
  if (!moderow || !anchor || st.row) return false;
  const row = document.createElement('div');
  row.id = 'decrow';
  row.innerHTML = '<b>Decoder: &nbsp;</b>' + Object.keys(DEC).filter((k) => !DEC[k].family).map((k) =>
    `<button type="button" class="btnMode decbtn" id="dec-${k}" data-dec="${k}" title="${esc(DEC[k].title)} — press again to stop">${DEC[k].label}</button>`).join('');
  moderow.insertBefore(row, anchor);
  row.addEventListener('click', (e) => {
    const b = e.target.closest('.decbtn'); if (!b) return;
    const k = b.dataset.dec;
    if (famKey(st.on) === k) stop(); else start(k === 'rtty' ? rttyKey() : k);
  });
  st.row = row;
  return true;
}
function lightButtons() {
  lightPresets();
  if (!st.row) return;
  st.row.querySelectorAll('.decbtn').forEach((b) => b.classList.toggle('btn-selected', b.dataset.dec === famKey(st.on)));
}
// The RTTY window's list: ham / DWD weather RTTY (decoder 'rtty'), PSK31, Olivia (decoders of
// their own, family 'rtty'). The choice is remembered (ubersdr_rtty) for the RTTY button.
function famKey(k) { return (k && DEC[k] && DEC[k].family) || k; }
function rttyKey() {
  const v = lsGet('ubersdr_rtty', 'ham');
  if (v === 'psk31' || v === 'olivia') return v;
  if (MODEM_UI[v]) return 'modem';
  if (v === 'packet' || v === 'aprs') return 'packet';
  return 'rtty';
}
const FAMILY_OPTS = [['ham', 'Ham RTTY 45.45 Bd / 170 Hz'], ['psk31', 'PSK31 (BPSK)'], ['olivia', 'Olivia'],
                     ['mfsk', 'MFSK16·32·64'], ['dominoex', 'DominoEX'], ['thor', 'THOR'], ['throb', 'THROB / THROBX'],
                     ['hell', 'Hellschreiber'], ['mt63', 'MT63'], ['packet', 'Packet (AX.25, 300 Bd)'], ['aprs', 'APRS (300 Bd)'],
                     ['weather', 'DWD weather RTTY 50 Bd / 450 Hz']];
function familySelect(cur) {
  return `<select class="dw-var dec-sel" title="FLDIGI mode">${FAMILY_OPTS.map(([v, n]) =>
    `<option value="${v}"${v === cur ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
}
// Another member of the family chosen in the list: that decoder takes over (true)
function familyChange(v) {
  lsSet('ubersdr_rtty', v);
  const k = rttyKey();
  if (k === st.on && k === 'rtty') return false;      // ham ↔ weather: the RTTY window handles it
  start(k); return true;
}
function openWindow(html) {
  closeWindow();
  const w = document.createElement('div');
  w.className = 'decwin'; w.id = 'decwin';
  w.innerHTML = html + '<div class="dw-status"></div>';
  document.getElementById('moderow').appendChild(w);    // under the Mode, RADE and CW windows
  st.win = w;
  return w;
}
function closeWindow() { if (st.win) st.win.remove(); st.win = null; }
function status(t) { const s = $('.dw-status'); if (s) s.textContent = t || ''; }
function scrollEnd(el) { el.scrollTop = el.scrollHeight; }
function atEnd(el) { return el.scrollTop + el.clientHeight >= el.scrollHeight - 4; }

// ── Station locator → distance ────────────────────────────────────────────────
function gridToLatLon(g) {
  const l = g.toUpperCase();
  let lon = (l.charCodeAt(0) - 65) * 20 - 180, lat = (l.charCodeAt(1) - 65) * 10 - 90;
  if (l.length >= 4) { lon += (l.charCodeAt(2) - 48) * 2; lat += l.charCodeAt(3) - 48; }
  if (l.length >= 6) { lon += (l.charCodeAt(4) - 65) * 5 / 60 + 5 / 120; lat += (l.charCodeAt(5) - 65) * 2.5 / 60 + 1.25 / 120; }
  else if (l.length === 4) { lon += 1; lat += 0.5; }
  return [lat, lon];
}
function distKm(a, b) {
  const r = (x) => x * Math.PI / 180, dLat = r(b[0] - a[0]), dLon = r(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
let homeLL;
function home() {
  if (homeLL !== undefined) return homeLL;
  homeLL = null;
  const a = document.querySelector('a[href*="qth="]');
  const m = a && /qth=([A-R]{2}\d{2}(?:[A-X]{2})?)/i.exec(a.getAttribute('href'));
  if (m && !/^AA00/i.test(m[1])) homeLL = gridToLatLon(m[1]);
  return homeLL;
}
const GRID_RE = /\b([A-R]{2}\d{2}(?:[A-X]{2})?)\b/i;
function gridCell(text) {
  const m = GRID_RE.exec(text || '');
  if (!m || /^RR73$/i.test(m[1])) return ['', ''];
  const g = m[1].toUpperCase(), h = home();
  const link = `<a href="https://www.levinecentral.com/ham/grid_square.php?&Grid=${g}&Zoom=10&sm=y" target="_blank" rel="noopener">${g}</a>`;
  return [link, h ? Math.round(distKm(h, gridToLatLon(g))) + ' km' : ''];
}

// ── FT8 / FT4 / FT2 / JS8 / WSPR: slot capture and the decode worker ───────────
let worker = null, reqId = 0;
const pending = new Map();
function decodeInWorker(type, pcm, opts) {
  if (!worker) {
    worker = new Worker(new URL('./psdr/decoder.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id); if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.results || []);
    };
    worker.onerror = (e) => { console.error('decoders: worker', e); for (const p of pending.values()) p.reject(new Error('worker failed')); pending.clear(); try { worker.terminate(); } catch (x) {} worker = null; };
  }
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage(Object.assign({ id, type, pcm, sampleRate: SR() }, opts || {}));
  });
}

const cap = { buf: null, len: 0, on: false, t0: 0, blockLen: 0, busy: 0 };
function capReset() { cap.len = 0; cap.on = false; }
function capPush(pcm) {
  const need = cap.len + pcm.length;
  if (!cap.buf || cap.buf.length < need) { const nb = new Float32Array(Math.max(need, SR() * 16)); if (cap.buf) nb.set(cap.buf.subarray(0, cap.len)); cap.buf = nb; }
  cap.buf.set(pcm, cap.len); cap.len = need;
}

// The capture starts this many seconds after the UTC slot boundary, to make up for the
// time the audio takes to arrive (PhantomSDR-Plus: 0.8 s, 0..3 s; here the audio is tapped
// on arrival, so the start is 0.3 s and it may go below zero, to -1 s). Learnt per mode from the decoded DT (auto-sync) and
// kept in this browser.
function ftxMode() { return st.on === 'js8' ? 'JS8:' + js8.sub : DEC[st.on].label; }
function shiftGet(m) { const v = parseFloat(lsGet('ubersdr_ftxshift_' + m, '')); return Number.isFinite(v) ? v : 0.3; }
function shiftSet(m, v) { lsSet('ubersdr_ftxshift_' + m, v.toFixed(3)); }
function dtTarget(m) {                                  // PhantomSDR-Plus _ftxDtTarget
  if (m.startsWith('JS8:')) {
    const i = Number(m.slice(4)), nsps = [1920, 1200, 600, 3840, 384][i];
    const tx = [15, 10, 6, 28, 4][i];
    return nsps ? Math.max(0, ((tx - 0.4) - 79 * (nsps / 12000)) / 2) : 0;
  }
  const s = { FT8: [15, 0.16, 79], FT4: [7.5, 0.048, 105], FT2: [3.75, 0.024, 105] }[m];
  if (!s) return 0;
  const centring = ((s[0] - 0.4) - s[2] * s[1]) / 2;
  return m === 'FT8' ? Math.max(0, centring) : Math.max(0, Math.min(centring, 19 * s[1] / 2));
}
const dtHist = {};
function autoSync(m, results) {                         // PhantomSDR-Plus _ftxAutoCalibrate (without the FT2 sweep)
  const h = dtHist[m] || (dtHist[m] = []);
  for (const r of results) if (Number.isFinite(r.dt)) h.push(r.dt);
  while (h.length > 12) h.shift();
  if (h.length < 3) return;
  const s = h.slice().sort((a, b) => a - b), n = s.length;
  const med = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const err = med - dtTarget(m);
  if (Math.abs(err) < 0.05) return;
  const cur = shiftGet(m);
  let next = m === 'FT2' ? ((cur + 0.5 * err) % 3.75 + 3.75) % 3.75 : Math.max(-1, Math.min(3, cur + 0.5 * err));
  if (Math.abs(next - cur) < 0.01) return;
  shiftSet(m, next); h.length = 0;
  showShift();
}
function showShift() { const e = $('.dw-shift'); if (e && st.on) e.textContent = shiftGet(ftxMode()).toFixed(2); }

function slotPos(period, shift) { const t = Date.now() / 1000 - shift, m = t % period; return m < 0 ? m + period : m; }
function startWindow(period) { const bd = cap.blockLen / SR(); return Math.min(period / 4, 0.39, Math.max(0.35, bd * 1.05)); }

function ftxFeed(pcm) {
  const d = DEC[st.on];
  cap.blockLen = pcm.length;
  let period, samples, win;
  if (d.kind === 'js8') {
    period = js8Period(js8.sub); samples = js8CaptureSamples(js8.sub, SR());
    win = js8StartWindow(js8.sub, cap.blockLen / SR());
  } else {
    period = d.slot; samples = Math.floor((d.slot - 0.4) * SR()); win = startWindow(period);
  }
  const m = ftxMode(), shift = shiftGet(m);
  if (!cap.on) {
    const pos = d.kind === 'js8' ? js8SlotPos(Date.now(), period, shift) : slotPos(period, shift);
    if (pos <= win) { cap.on = true; cap.len = 0; cap.t0 = Date.now() - pos * 1000 - shift * 1000; }
    else return;
  }
  capPush(pcm);
  if (cap.len >= samples) {
    const pcmSlot = cap.buf.slice(0, cap.len), t0 = cap.t0, key = st.on;
    cap.on = false; cap.len = 0;
    status('Decoding…'); cap.busy++;
    const job = d.kind === 'js8'
      ? decodeInWorker('js8', pcmSlot, { submode: js8.sub }).then((r) => { if (st.on === key) js8Results(r, t0); })
      : decodeInWorker(key, pcmSlot).then((r) => { if (st.on === key) ftxResults(r, t0); });
    job.catch((e) => { console.error('decoders:', e); if (st.on === key) status('Decode error: ' + e.message); })
       .finally(() => { cap.busy--; });
  }
}
// ── Slot bar (JS8 and WSPR): how far the current slot is, and the time to the
// next decode. Runs on its own clock, so it moves even between audio blocks.
const BAR_HTML = '<div class="dw-bar"><div class="dw-fill"></div><span class="dw-bartxt"></span></div>';
let barTimer = null;
function barStart() { barStop(); barTimer = setInterval(barTick, 200); barTick(); }
function barStop() { if (barTimer) clearInterval(barTimer); barTimer = null; }
function barTick() {
  const fill = $('.dw-fill'), txt = $('.dw-bartxt');
  if (!st.on || !fill || !txt) { barStop(); return; }
  const d = DEC[st.on];
  let period, capLen, pos;
  if (d.kind === 'wspr') { period = 120; capLen = 119; pos = wspr2SlotPosition() + (Date.now() % 1000) / 1000; }
  else if (d.kind === 'js8') {
    period = js8Period(js8.sub); capLen = js8CaptureSamples(js8.sub, 1000) / 1000;
    pos = js8SlotPos(Date.now(), period, shiftGet(ftxMode()));
  } else { period = d.slot; capLen = d.slot - 0.4; pos = slotPos(period, shiftGet(ftxMode())); }
  // capturing: the decode comes at the end of this capture; otherwise (joined in the
  // middle of a slot, or the gap before the next one) at the end of the next capture
  const left = cap.on ? Math.max(0, capLen - pos) : (period - pos) + capLen;
  fill.style.width = (100 * Math.min(1, pos / capLen)).toFixed(1) + '%';
  fill.classList.toggle('wait', !cap.on);
  txt.textContent = cap.busy && left > capLen - 1.5
    ? 'Decoding…'
    : (cap.on ? 'Next decode in ' : 'Waiting for the slot start — first decode in ') + fmtSec(left);
}
function fmtSec(s) {
  s = Math.ceil(s);
  return s >= 60 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + ' min' : s + ' s';
}

function ftxWindow(k) {
  const d = DEC[k];
  openWindow(`<div class="dw-head"><span class="dw-title">${d.label} decoder</span>
    <span title="Seconds after the slot start at which the capture begins; adjusted automatically from the decoded DT">Time shift <b class="dw-shift">-</b> s</span>
    <span>Decodes <b class="dw-count">0</b></span><button type="button" class="dw-clear">Clear</button></div>
    <div class="dw-list"><table><thead><tr><th>UTC</th><th>dB</th><th>DT</th><th>Hz</th><th>Message</th><th>Locator</th><th>Distance</th></tr></thead><tbody></tbody></table></div>`);
  $('.dw-clear').onclick = () => { $('tbody').innerHTML = ''; $('.dw-count').textContent = '0'; };
  showShift();
}
function addRows(rowsHtml) {
  const list = $('.dw-list'), tb = $('tbody'); if (!tb) return;
  const end = atEnd(list);
  tb.insertAdjacentHTML('beforeend', rowsHtml);
  while (tb.rows.length > 400) tb.deleteRow(0);
  if (end) scrollEnd(list);
}
function ftxResults(res, t0) {
  const m = ftxMode();
  autoSync(m, res);
  status(`${utcHM(t0)} UTC: ${res.length} decoded`);
  if (!res.length) return;
  res.sort((a, b) => (a.freq || 0) - (b.freq || 0));
  const target = dtTarget(m);
  let html = '';
  res.forEach((r, i) => {
    const dt = Number.isFinite(r.dt) ? r.dt - target : NaN, [loc, km] = gridCell(r.text);
    html += `<tr${i === 0 ? ' class="sep"' : ''}><td>${utcHM(t0)}</td><td class="n">${Number.isFinite(r.snr) ? (r.snr > 0 ? '+' : '') + r.snr.toFixed(0) : ''}</td>` +
      `<td class="n${Math.abs(dt) > 0.5 ? ' warn' : ''}">${Number.isFinite(dt) ? dt.toFixed(1) : ''}</td>` +
      `<td class="n">${Number.isFinite(r.freq) ? r.freq.toFixed(0) : ''}</td><td class="m">${esc(r.text || '')}</td><td>${loc}</td><td class="n">${km}</td></tr>`;
  });
  addRows(html);
  const c = $('.dw-count'); if (c) c.textContent = String(+c.textContent + res.length);
}

// JS8: frames → PhantomSDR-Plus's reassembler → messages
const js8 = { sub: Math.min(4, Math.max(0, parseInt(lsGet('ubersdr_js8sub', '0'), 10) || 0)), re: null };
function js8Window() {
  openWindow(`<div class="dw-head"><span class="dw-title">JS8 decoder</span>
    <label>Speed <select class="dw-sub">${JS8_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('')}</select></label>
    <span>Time shift <b class="dw-shift">-</b> s</span><button type="button" class="dw-clear">Clear</button></div>
    ${BAR_HTML}<div class="dw-list"><table><thead><tr><th>UTC</th><th>dB</th><th>Hz</th><th>Message</th></tr></thead><tbody></tbody></table></div>`);
  barStart();
  const sel = $('.dw-sub'); sel.value = String(js8.sub);
  sel.onchange = () => { js8.sub = +sel.value; lsSet('ubersdr_js8sub', sel.value); js8.re.reset(); capReset(); showShift(); };
  $('.dw-clear').onclick = () => { $('tbody').innerHTML = ''; };
  js8.re = new Js8Reassembler({ onMessage: (msg) => {
    if (st.on !== 'js8') return;
    addRows(`<tr><td>${utcHM(msg.time || Date.now())}</td><td class="n">${Number.isFinite(msg.snr) ? Math.round(msg.snr) : ''}</td>` +
      `<td class="n">${Number.isFinite(msg.offset) ? Math.round(msg.offset) : (Number.isFinite(msg.freq) ? Math.round(msg.freq) : '')}</td><td class="m">${esc(formatJs8Message(msg))}</td></tr>`);
  } });
  js8LoadDictionary().catch((e) => console.error('decoders: JS8 dictionary', e));
  showShift();
}
function js8Results(raw, t0) {
  const now = Date.now(), frames = [];
  for (const r of raw) {
    let f; try { f = js8DecodeFrame(r.payload, r.i3bit); } catch (e) { continue; }
    if (f.needsDictionary) js8LoadDictionary().catch(() => {});
    frames.push({ f, meta: { freq: r.freq, submode: js8.sub, snr: r.snr, dt: r.dt, time: now } });
  }
  frames.sort((a, b) => a.meta.freq - b.meta.freq);
  for (const { f, meta } of frames) { try { js8.re.addFrame(f, meta); } catch (e) { console.error('decoders: JS8', e); } }
  try { js8.re.tick(now); } catch (e) {}
  autoSync(ftxMode(), raw);
  status(`${utcHM(t0)} UTC: ${frames.length} frame(s)`);
}

// WSPR: 2-minute slots on even UTC minutes
function wsprWindow() {
  openWindow(`<div class="dw-head"><span class="dw-title">WSPR decoder</span><span>Spots <b class="dw-count">0</b></span>
    <button type="button" class="dw-clear">Clear</button></div>
    ${BAR_HTML}<div class="dw-list"><table><thead><tr><th>UTC</th><th>Call</th><th>Locator</th><th>dBm</th><th>kHz</th><th>SNR</th><th>Distance</th></tr></thead><tbody></tbody></table></div>`);
  barStart();
  $('.dw-clear').onclick = () => { $('tbody').innerHTML = ''; $('.dw-count').textContent = '0'; };
}
function wsprFeed(pcm) {
  const pos = wspr2SlotPosition();
  if (!cap.on && pos < 2) { cap.on = true; cap.len = 0; cap.t0 = Date.now() - pos * 1000; }
  if (!cap.on) return;
  capPush(pcm);
  if (pos >= 119 && pos < 120) {
    cap.on = false;
    if (cap.len < WSPR_TOTAL_SAMPLES) { status(`Slot incomplete (joined late) — next one in ${Math.ceil(120 - pos)} s`); cap.len = 0; return; }
    const pcmSlot = cap.buf.slice(0, cap.len), t0 = cap.t0, dial = dialKHz() * 1000;
    cap.len = 0; cap.busy++; status('Decoding…');
    decodeInWorker('wspr', pcmSlot, { dialFreqHz: dial }).then((res) => {
      if (st.on !== 'wspr') return;
      status(`${utcHM(t0).slice(0, 5)} UTC: ${res.length} spot(s)`);
      let html = '';
      for (const r of res) {
        const [loc, km] = gridCell(r.grid || '');
        html += `<tr><td>${utcHM(t0).slice(0, 5)}</td><td class="c">${esc(r.callsign || '')}</td><td>${loc || esc(r.grid || '')}</td>` +
          `<td class="n">${r.dbm ?? ''}</td><td class="n">${dial ? (r.freq / 1000).toFixed(4) : '+' + Number(r.freq).toFixed(0) + ' Hz'}</td>` +
          `<td class="n">${Number.isFinite(r.snr) ? r.snr.toFixed(0) : ''}</td><td class="n">${km}</td></tr>`;
      }
      if (html) addRows(html);
      const c = $('.dw-count'); if (c) c.textContent = String(+c.textContent + res.length);
    }).catch((e) => { if (st.on === 'wspr') status('Decode error: ' + e.message); }).finally(() => { cap.busy--; });
  }
}

// ── SSTV ────────────────────────────────────────────────────────────────────────
let sstv = null, sstvCtx = null, sstvH = 256;
function sstvWindow() {
  openWindow(`<div class="dw-head"><span class="dw-title">SSTV decoder</span>
    <label>Mode <select class="dw-mode"><option value="auto">Auto (VIS)</option><option value="martin1">Martin M1</option><option value="martin2">Martin M2</option>
      <option value="scottie1">Scottie S1</option><option value="scottie2">Scottie S2</option><option value="scottieDX">Scottie DX</option>
      <option value="robot36">Robot 36</option><option value="robot72">Robot 72</option></select></label>
    <select class="dw-tune dec-sel"><option value="">Tune to…</option>${SSTV_FREQS.map(([n, f]) => `<option value="${f}">${n}</option>`).join('')}</select>
    <span>Lines <b class="dw-lines">0</b></span>
    <button type="button" class="dw-reset">Reset</button><button type="button" class="dw-save">Save</button></div>
    <canvas width="320" height="256" style="width:320px;height:256px"></canvas>`);
  const cv = $('canvas'); sstvCtx = cv.getContext('2d', { willReadFrequently: true }); sstvBlank(256);
  const msel = $('.dw-mode'); msel.value = lsGet('ubersdr_sstvmode', 'auto');
  sstv = new SSTVWorkerProxy({ sampleRate: SR, callback: sstvEvent, defaultMode: msel.value });
  sstv.setMode(msel.value); sstv.reset({ mode: msel.value }); sstv.setEnabled(true);
  msel.onchange = () => { lsSet('ubersdr_sstvmode', msel.value); sstv.setMode(msel.value); sstv.reset({ mode: msel.value }); sstvBlank(sstvH); };
  $('.dw-reset').onclick = () => { sstv.reset({ mode: msel.value }); sstvBlank(sstvH); status('Waiting for a picture (VIS header)…'); };
  $('.dw-save').onclick = () => savePng(cv, 'sstv');
  $('.dw-tune').onchange = (e) => { const f = +e.target.value; if (f) { tuneKHz(f); applyFilter('sstv'); picked(f); } };
  status('Waiting for a picture (VIS header)…');
}
function sstvBlank(h) {
  const cv = $('canvas'); if (!cv) return;
  if (cv.height !== h) { cv.height = h; cv.style.height = h + 'px'; sstvCtx = cv.getContext('2d', { willReadFrequently: true }); }
  sstvH = h; sstvCtx.fillStyle = '#000'; sstvCtx.fillRect(0, 0, 320, h);
  const l = $('.dw-lines'); if (l) l.textContent = '0';
}
function sstvEvent(ev) {
  if (!ev || st.on !== 'sstv') return;
  if (ev.type === 'status') status(ev.text || '');
  else if (ev.type === 'mode') status('Receiving ' + (ev.mode || ''));
  else if (ev.type === 'line' && ev.pixels) {
    const h = ev.height || 256;
    if (h !== sstvH) sstvBlank(h);
    const y = Math.max(0, Math.min(sstvH - 1, ev.lineNum || 0));
    sstvCtx.putImageData(new ImageData(ev.pixels, ev.width || 320, 1), 0, y);
    const l = $('.dw-lines'); if (l) l.textContent = String((ev.lineNum || 0) + 1);
  }
}

// ── HF FAX (drawn bottom-up, scaled as PhantomSDR-Plus App.svelte does) ─────────
const FAX_W = 910, FAX_H = 540;
let fax = null, faxCtx = null, faxInv = false;
const faxAcc = new Float32Array(FAX_W), faxPix = new Uint8Array(FAX_W);
let faxLines = 0, faxBudget = 0;
function faxWindow() {
  const lpm = lsGet('ubersdr_faxlpm', '120'), ioc = lsGet('ubersdr_faxioc', '576');
  openWindow(`<div class="dw-head"><span class="dw-title">HF FAX decoder</span>
    <select class="dw-tune dec-sel"><option value="">Station…</option>${FAX_STATIONS.map((s, i) => s.freqs.map((f, j) =>
      `<option value="${i}:${j}">${esc(s.name)} ${f}</option>`).join('')).join('')}</select>
    <label>LPM <select class="dw-lpm"><option>60</option><option>90</option><option>100</option><option>120</option><option>240</option></select></label>
    <label>IOC <select class="dw-ioc"><option>576</option><option>288</option></select></label>
    <label><input type="checkbox" class="dw-inv"> Invert</label>
    <span>Lines <b class="dw-lines">0</b></span>
    <button type="button" class="dw-clear">Clear</button><button type="button" class="dw-save">Save</button></div>
    <canvas width="${FAX_W}" height="${FAX_H}" style="width:464px;height:${Math.round(FAX_H * 464 / FAX_W)}px"></canvas>`);
  const cv = $('canvas'); faxCtx = cv.getContext('2d', { willReadFrequently: true }); faxClear();
  const ls = $('.dw-lpm'), is = $('.dw-ioc'); ls.value = lpm; is.value = ioc;
  fax = new FAXWorkerProxy({ sampleRate: SR, callback: faxEvent });
  const params = () => { fax.setParams(+ls.value, +is.value, 800); lsSet('ubersdr_faxlpm', ls.value); lsSet('ubersdr_faxioc', is.value); };
  fax.reset(); params(); fax.setAutoAlign(true); fax.setEnabled(true);
  ls.onchange = params; is.onchange = params;
  $('.dw-inv').onchange = (e) => { faxInv = e.target.checked; };
  $('.dw-clear').onclick = () => { faxClear(); fax.reset(); params(); };
  $('.dw-save').onclick = () => savePng(cv, 'hffax');
  $('.dw-tune').onchange = (e) => {
    if (!e.target.value) return;
    const [i, j] = e.target.value.split(':').map(Number), s = FAX_STATIONS[i];
    ls.value = String(s.lpm); is.value = String(s.ioc); params();
    tuneKHz(s.freqs[j] - 1.9);                      // centre 1900 Hz above the USB dial
    applyFilter('fax'); picked(s.freqs[j] - 1.9);
  };
  status('Receiving — a picture starts with the start tone and phasing lines');
}
function faxClear() { if (!faxCtx) return; faxCtx.fillStyle = '#000'; faxCtx.fillRect(0, 0, FAX_W, FAX_H); faxAcc.fill(0); faxLines = 0; faxBudget = 0; const l = $('.dw-lines'); if (l) l.textContent = '0'; }
function faxEvent(ev) {
  if (!ev || ev.type !== 'line' || st.on !== 'fax' || !faxCtx) return;
  const p = ev.pixels, PPL = p.length; if (!PPL) return;
  for (let x = 0; x < FAX_W; x++) {
    const a = Math.floor(x * PPL / FAX_W), b = Math.max(a, Math.min(PPL - 1, Math.floor((x + 1) * PPL / FAX_W) - 1));
    let s = 0; for (let i = a; i <= b; i++) s += p[i];
    faxAcc[x] += s / (b - a + 1);
  }
  faxLines++; faxBudget += FAX_W / PPL;
  const l = $('.dw-lines'); if (l) l.textContent = String(ev.lineNum || 0);
  status(ev.phasing ? 'Phasing…' : ev.stopTone ? 'Stop tone — picture complete' : 'Receiving picture');
  if (faxBudget < 1) return;
  for (let x = 0; x < FAX_W; x++) { let g = Math.round(faxAcc[x] / faxLines); if (faxInv) g = 255 - g; faxPix[x] = g < 0 ? 0 : g > 255 ? 255 : g; }
  faxAcc.fill(0); faxLines = 0;
  const img = faxCtx.getImageData(0, 0, FAX_W, FAX_H), d = img.data, row = (FAX_H - 1) * FAX_W * 4;
  while (faxBudget >= 1) {
    faxBudget -= 1;
    d.copyWithin(0, FAX_W * 4, FAX_H * FAX_W * 4);
    for (let x = 0; x < FAX_W; x++) { const i = row + x * 4, g = faxPix[x]; d[i] = d[i + 1] = d[i + 2] = g; d[i + 3] = 255; }
  }
  faxCtx.putImageData(img, 0, 0);
}
function savePng(cv, name) {
  const a = document.createElement('a');
  a.download = `${name}_${new Date().toISOString().slice(0, 16).replace(':', '-')}.png`;
  a.href = cv.toDataURL('image/png'); a.click();
}

// ── NAVTEX and RTTY (PhantomSDR-Plus fsk.js) ────────────────────────────────────
let fsk = null, line = '';
function textWindow(title, extra) {
  openWindow(`<div class="dw-head"><span class="dw-title">${title}</span>${extra}<button type="button" class="dw-clear">Clear</button></div><div class="dw-text"></div>`);
  $('.dw-clear').onclick = () => { $('.dw-text').textContent = ''; };
}
function textOut(t) {
  const box = $('.dw-text'); if (!box) return;
  const end = atEnd(box), last = box.lastChild;
  if (last && last.nodeType === 3 && last.data.length < 2000) last.appendData(t); else box.appendChild(document.createTextNode(t));
  while (box.textContent.length > 12000 && box.firstChild) box.removeChild(box.firstChild);
  if (end) scrollEnd(box);
}
function navtexWindow() {
  textWindow('NAVTEX decoder', `<select class="dw-tune dec-sel"><option value="">Station…</option>${NAVTEX_STATIONS.map(([n, f]) => `<option value="${f}">${n}</option>`).join('')}</select>`);
  fsk = new FSKWorkerProxy({ role: 'navtex', sampleRate: SR, callback: (ev) => {
    if (!ev || st.on !== 'navtex') return;
    if (ev.type === 'char') { if (ev.char !== '\r') textOut(ev.char); }
    else if (ev.type === 'navstart') textOut(ev.headerless ? '\n━━ (header missed) ━━\n' : `\n━━ ZCZC ${ev.station}${ev.subject}${ev.seq} ━━\n`);
    else if (ev.type === 'navend') { if (ev.reason === 'lost') textOut('\n━━ (signal lost) ━━\n\n'); else if (ev.reason !== 'next') textOut('\n━━ NNNN ━━\n\n'); }
    else if (ev.type === 'status') status(ev.text);
  } });
  fsk.setEnabled(true);
  $('.dw-tune').onchange = (e) => { const f = +e.target.value; if (f) { tuneKHz(f - 0.5); applyFilter('navtex'); picked(f - 0.5); } };
  status('Listening (100 Bd, 170 Hz shift, centre 500 Hz)…');
}
const RTTY = { ham: { center: 1000, shift: 170, baud: 45.45 }, weather: { center: 1000, shift: 450, baud: 50 } };
function rttyVariant() { return lsGet('ubersdr_rtty', 'ham') === 'weather' ? 'weather' : 'ham'; }
function rttyFreqOptions(v) { return `<option value="">Frequency…</option>` + RTTY_FREQS[v].map(([n, f]) => `<option value="${f}">${n}</option>`).join(''); }
// RTTY squelch as PhantomSDR-Plus: dB SNR (3 kHz reference), FSK_SQ_OFF and below = off;
// ham −5 dB, DWD weather −8 dB to start. Sent with the variant's settings, the way
// PhantomSDR-Plus's panel sends them (fsk.js gates the printing, not the demodulator).
const FSK_SQ_OFF = -20, RTTY_SQ = { ham: -5, weather: -8 };
function rttySquelch() {
  const v = parseFloat(lsGet('ubersdr_rttysq_' + rttyVariant(), ''));
  return Number.isFinite(v) ? v : RTTY_SQ[rttyVariant()];
}
function rttySquelchShow() {
  const sq = rttySquelch(), r = $('.dw-sq'), t = $('.dw-sqv');
  if (r) r.value = String(sq);
  if (t) t.textContent = sq <= FSK_SQ_OFF ? 'off' : sq + ' dB';
}
function rttySend() {
  if (!fsk) return;
  const v = rttyVariant(), r = RTTY[v];
  fsk.setConfig({ center: r.center, shift: r.shift, baud: r.baud, framing: '5N1.5', encoding: 'ita2',
                  inverted: v === 'weather', squelch: rttySquelch() });
}
function rttyWindow() {
  const v = rttyVariant();
  textWindow('RTTY decoder', `${familySelect(v)}
    <select class="dw-tune dec-sel">${rttyFreqOptions(v)}</select>
    <label class="dw-sqbox" title="Squelch (SNR): print only while the signal is at least this far above the noise. Noise reads −12 to −15 dB; RTTY stays readable down to about −4 dB. Far left turns it off.">Squelch
      <input type="range" class="dw-sq" min="${FSK_SQ_OFF}" max="10" step="1"> <b class="dw-sqv"></b></label><span class="dw-met"></span>`);
  const vs = $('.dw-var'); vs.value = v;
  fsk = new FSKWorkerProxy({ role: 'fsk', variant: v, sampleRate: SR, callback: (ev) => {
    if (!ev || st.on !== 'rtty') return;
    if (ev.type === 'char') { if (ev.char && ev.char !== '\r') textOut(ev.char); }
    else if (ev.type === 'status') status(ev.text || '');
    else if (ev.type === 'metrics') { const m = $('.dw-met'); if (m) m.textContent = Number.isFinite(ev.snrDb) ? `SNR ${ev.snrDb.toFixed(0)} dB` : ''; }
  } });
  fsk.setVariant(v); rttySquelchShow(); rttySend(); fsk.setEnabled(true);
  vs.onchange = () => {
    if (familyChange(vs.value)) return;
    fsk.setVariant(vs.value); rttySquelchShow(); rttySend();
    $('.dw-tune').innerHTML = rttyFreqOptions(vs.value); picked(0); applyFilter('rtty');
  };
  $('.dw-sq').oninput = () => { lsSet('ubersdr_rttysq_' + rttyVariant(), $('.dw-sq').value); rttySquelchShow(); rttySend(); };
  $('.dw-tune').onchange = (e) => { const f = +e.target.value; if (f) { const d = f - RTTY[rttyVariant()].center / 1000; tuneKHz(d); applyFilter('rtty'); picked(d); } };
  status(`Listening (tones centred on ${RTTY[v].center} Hz)…`);
}

// PSK31 and Olivia (PhantomSDR-Plus fsk.js 'psk31' / 'olivia'): the signal is decoded at
// 1000 Hz of audio. A click on a trace puts it there (narrow filter, see iscw above); the
// lists tune to the calling frequencies.
function oliviaMode() {
  let i = parseInt(lsGet('ubersdr_olivia', '0'), 10) || 0;
  if (i < 0 || i >= OLIVIA_MODES.length) i = 0;
  return OLIVIA_MODES[i];
}
function digiMetrics(ev) {
  const m = $('.dw-met'); if (!m) return;
  const parts = [];
  if (Number.isFinite(ev.snrDb)) parts.push(`SNR ${ev.snrDb.toFixed(0)} dB`);
  if (st.on === 'psk31' && Number.isFinite(ev.imdDb) && ev.imdDb) parts.push(`IMD ${ev.imdDb.toFixed(0)} dB`);
  if (Number.isFinite(ev.centerHz) && ev.centerHz) parts.push(`${Math.round(ev.centerHz)} Hz`);
  m.textContent = parts.join(' · ');
}
function digiWindow(k, title, list, extra) {
  textWindow(title, `${familySelect(k)}<select class="dw-tune dec-sel"><option value="">Frequency…</option>${list.map(([n, f]) => `<option value="${f}">${n}</option>`).join('')}</select>${extra}<span class="dw-met"></span>`);
  fsk = new FSKWorkerProxy({ role: 'fsk', variant: k, sampleRate: SR, callback: (ev) => {
    if (!ev || st.on !== k) return;
    if (ev.type === 'char') { if (ev.char && ev.char !== '\r') textOut(ev.char); }
    else if (ev.type === 'status') { status(ev.text || ''); if (k === 'psk31') pskAutoResult(ev.text || ''); }
    else if (ev.type === 'metrics') digiMetrics(ev);
  } });
  $('.dw-var').onchange = (e) => familyChange(e.target.value);
  $('.dw-tune').onchange = (e) => {
    const f = +e.target.value; if (!f) return;
    if (k === 'olivia') {                          // the list names the set-up: use it
      const m = /\((\d+)\/(\d+)\)/.exec(e.target.selectedOptions[0].text), i = m ? OLIVIA_MODES.findIndex((o) => o.t === +m[1] && o.b === +m[2]) : -1;
      if (i >= 0) { $('.dw-omode').value = String(i); $('.dw-omode').onchange(); }
    }
    tuneKHz(f - 1); applyFilter(k); picked(f - 1);
  };
}
function psk31Window() {
  digiWindow('psk31', 'PSK31 decoder', PSK31_FREQS, `<button type="button" class="dw-auto" title="Find the strongest PSK31 carrier in the filter and lock on it">Auto-tune</button>`);
  fsk.setVariant('psk31'); fsk.setConfig({ center: 1000, encoding: 'varicode' }); fsk.setEnabled(true);
  $('.dw-auto').onclick = pskAutoTune;
  status('Click a PSK31 trace on the waterfall, or pick a frequency; the decoder locks within ±25 Hz.');
}
// Auto-tune: fsk.js looks for the strongest carrier between 300 and 2700 Hz, so the filter
// opens to that for a moment; the dial then moves so the carrier sits at 1000 Hz, in the
// narrow filter again, and the decoder's centre goes back to 1000 Hz.
let pskAuto = null;
function pskAutoTune() {
  if (!fsk || (st.on !== 'psk31' && st.on !== 'modem') || pskAuto) return;
  status('Auto-tune: looking for the strongest carrier (0.3–2.7 kHz)…');
  setFilter('usb', 0.3, 2.7);
  pskAuto = { timer: setTimeout(() => {           // ~1.5 s of wide audio first (the scan uses the last 0.7 s)
    if (!pskAuto || !fsk) return;
    fsk.setAutoCenter(true);
    pskAuto.timer = setTimeout(() => pskAutoDone(null), 4000);
  }, 1500) };
}
function pskAutoResult(text) {
  if (!pskAuto) return;
  const m = /Auto-tune: center (\d+) Hz/.exec(text);
  if (m) pskAutoDone(+m[1]); else if (/no signal/i.test(text)) pskAutoDone(null);
}
function pskAutoDone(hz) {
  if (!pskAuto) return;
  clearTimeout(pskAuto.timer); pskAuto = null;
  if ((st.on !== 'psk31' && st.on !== 'modem') || !fsk) return;
  const k = st.on, target = k === 'psk31' ? 1000 : modemCenter(modemVariant());
  if (hz) {
    tuneKHz(dialKHz() + (hz - target) / 1000);
    if (k === 'psk31') fsk.setConfig({ center: 1000, encoding: 'varicode' }); else modemSend();
  }
  applyFilter(k);
  status(hz ? `Auto-tune: signal found ${hz - target >= 0 ? '+' : ''}${hz - target} Hz away, now at ${target} Hz` : 'Auto-tune: no signal found');
}
function oliviaWindow() {
  const sq = parseFloat(lsGet('ubersdr_oliviasq', '4')) || 4;
  digiWindow('olivia', 'Olivia decoder', OLIVIA_FREQS,
    `<label title="Tones / bandwidth: must match the transmission">Mode <select class="dw-omode dec-sel">${OLIVIA_MODES.map((o, i) => `<option value="${i}">${o.label}</option>`).join('')}</select></label>` +
    `<label class="dw-sqbox" title="Squelch (FEC S/N): print only blocks that reach this. Below 3.5 noise starts printing; a good signal reads 8–9.">Squelch <input type="range" class="dw-osq" min="3" max="15" step="0.5" value="${sq}"> <b class="dw-sqv">${sq.toFixed(1)}</b></label>`);
  const ms = $('.dw-omode'), qs = $('.dw-osq');
  ms.value = String(OLIVIA_MODES.indexOf(oliviaMode()));
  const send = () => {
    const o = oliviaMode();
    fsk.setConfig({ center: 1000, encoding: 'olivia', tones: o.t, bandwidth: o.b, syncThreshold: +qs.value || 4 });
    status(`Looking for Olivia ${o.label} (no preamble: allow a few seconds for sync)…`);
  };
  ms.onchange = () => { lsSet('ubersdr_olivia', ms.value); send(); applyFilter('olivia'); lightPresets(); };
  qs.oninput = () => { lsSet('ubersdr_oliviasq', qs.value); $('.dw-sqv').textContent = (+qs.value).toFixed(1); send(); };
  fsk.setVariant('olivia'); send(); fsk.setEnabled(true);
}

// ── fldigi modems (PhantomSDR-Plus 5.1.0): MFSK16/32/64, DominoEX, THOR, THROB/THROBX,
// Hellschreiber, MT63. One window; the variant is the FLDIGI list's choice. Each has its
// mode list and its own squelch scale (MODEM_UI = PhantomSDR-Plus App.svelte); the signal is
// decoded around modemCenter() (1500 Hz as fldigi, MT63 its lowest carrier at 500 Hz).
const MODEM_UI = {
  mfsk:     { name: 'MFSK',          sq: { min: 0, max: 60, step: 1,   fmt: (v) => v <= 0 ? 'off' : String(Math.round(v)),
              note: 'Squelch (FEC metric): noise alone reaches about 20; clean copy reads above 23.' } },
  dominoex: { name: 'DominoEX',      sq: { min: 0, max: 80, step: 1,   fmt: (v) => v <= 0 ? 'off' : String(Math.round(v)),
              note: 'Squelch (tone / noise): noise alone stays under 20; readable copy reads 35 and up.' } },
  thor:     { name: 'THOR',          sq: { min: 0, max: 80, step: 1,   fmt: (v) => v <= 0 ? 'off' : String(Math.round(v)),
              note: 'Squelch (tone / noise): noise alone stays under 20; readable copy reads 35 and up.' } },
  throb:    { name: 'THROB',         sq: { min: 0, max: 20, step: 0.5, fmt: (v) => v <= 0 ? 'off' : Number(v).toFixed(1) + ' dB',
              note: 'Squelch (S/N): noise alone stays under 1 dB; a copyable signal reads 10 dB and up. THROB must be tuned within ±3 Hz: use Auto-tune.' } },
  hell:     { name: 'Hellschreiber', sq: null },
  mt63:     { name: 'MT63',          sq: { min: 0, max: 15, step: 0.5, fmt: (v) => v <= 0 ? 'off' : Number(v).toFixed(1),
              note: 'Squelch (FEC S/N): noise alone reads about 3; a locked signal 4.5 and up. Text arrives seconds after the signal.' } },
};
function modemVariant() { const v = lsGet('ubersdr_rtty', 'mfsk'); return MODEM_UI[v] ? v : 'mfsk'; }
function modemKey(v) {
  const k = lsGet('ubersdr_modem_' + v, ''), m = FLDIGI_MODEMS[v];
  return m.modes.some((x) => x.key === k) ? k : m.def;
}
function modemBw(v) { return FLDIGI_MODEMS[v].bw(modemKey(v)); }
function modemCenter(v) { return v === 'mt63' ? mt63DefaultCenter(modemKey(v)) : 1500; }
function modemSquelch(v) {
  const x = parseFloat(lsGet('ubersdr_modemsq_' + v, ''));
  return Number.isFinite(x) ? x : FLDIGI_MODEMS[v].squelch;
}
let hellRev = false;
function modemSend() {
  const v = modemVariant();
  if (!fsk || st.on !== 'modem') return;
  fsk.setConfig({ center: modemCenter(v), encoding: v, modemMode: modemKey(v), bandwidth: modemBw(v),
                  modemSquelch: modemSquelch(v), reverse: v === 'hell' ? hellRev : false });
}
// Hellschreiber: hell.js sends columns of 2 x 20 pixels (ink 0..255, pixel 0 at the bottom);
// drawn left to right, 2 px wide, in rows that scroll up (as PhantomSDR-Plus App.svelte)
const HELL_COL_W = 2, HELL_ROW_H = 44, HELL_ROWS = 6, HELL_W = 460;
const HELL_BG = [247, 247, 247], HELL_INK = [0, 0, 0];
let hellCtx = null, hellX = 0, hellRow = 0;
function hellClear() {
  hellX = 0; hellRow = 0;
  if (!hellCtx) return;
  hellCtx.fillStyle = `rgb(${HELL_BG})`; hellCtx.fillRect(0, 0, HELL_W, HELL_ROW_H * HELL_ROWS);
}
function hellPaint(col) {
  if (!hellCtx || !col) return;
  const W = HELL_W, H2 = HELL_ROW_H * HELL_ROWS;
  if (hellX + HELL_COL_W > W) {
    hellX = 0; hellRow++;
    if (hellRow >= HELL_ROWS) {
      hellCtx.drawImage(hellCtx.canvas, 0, HELL_ROW_H, W, H2 - HELL_ROW_H, 0, 0, W, H2 - HELL_ROW_H);
      hellCtx.fillStyle = `rgb(${HELL_BG})`; hellCtx.fillRect(0, H2 - HELL_ROW_H, W, HELL_ROW_H);
      hellRow = HELL_ROWS - 1;
    }
  }
  const H = col.length, img = hellCtx.createImageData(HELL_COL_W, H);
  for (let y = 0; y < H; y++) {
    const a = col[H - 1 - y] / 255;
    for (let k = 0; k < HELL_COL_W; k++) {
      const o = (y * HELL_COL_W + k) * 4;
      for (let c = 0; c < 3; c++) img.data[o + c] = HELL_BG[c] + (HELL_INK[c] - HELL_BG[c]) * a;
      img.data[o + 3] = 255;
    }
  }
  hellCtx.putImageData(img, hellX, hellRow * HELL_ROW_H + 2);
  hellX += HELL_COL_W;
}
function modemMetrics(ev) {
  const m = $('.dw-met'); if (!m) return;
  const parts = [];
  if (Number.isFinite(ev.snrDb)) parts.push(`SNR ${ev.snrDb.toFixed(0)} dB`);
  if (Number.isFinite(ev.metric)) parts.push(`metric ${Math.round(ev.metric)}`);
  if (Number.isFinite(ev.fecSnr)) parts.push(`FEC ${ev.fecSnr.toFixed(1)}`);
  if (Number.isFinite(ev.centerHz) && ev.centerHz) parts.push(`${Math.round(ev.centerHz)} Hz`);
  m.textContent = parts.join(' · ');
}
function modemWindow() {
  const v = modemVariant(), ui = MODEM_UI[v], modes = FLDIGI_MODEMS[v].modes, hell = v === 'hell';
  const head = `${familySelect(v)}<label title="Must match the transmission">Mode <select class="dw-mmode dec-sel">${modes.map((x) =>
      `<option value="${x.key}">${esc(x.label)}</option>`).join('')}</select></label>` +
    (ui.sq ? `<label class="dw-sqbox" title="${esc(ui.sq.note)}">Squelch <input type="range" class="dw-msq" min="${ui.sq.min}" max="${ui.sq.max}" step="${ui.sq.step}"> <b class="dw-sqv"></b></label>` : '') +
    (hell ? `<label title="FSK Hell / Hell 80: paint the other tone as ink"><input type="checkbox" class="dw-hrev"> Reverse</label><button type="button" class="dw-hsave">Save</button>` : '') +
    `<button type="button" class="dw-auto" title="Find the strongest signal within 0.3–2.7 kHz and put it in the filter">Auto-tune</button><span class="dw-met"></span>`;
  if (hell) {
    openWindow(`<div class="dw-head"><span class="dw-title">Hellschreiber decoder</span>${head}<button type="button" class="dw-clear">Clear</button></div>` +
      `<canvas width="${HELL_W}" height="${HELL_ROW_H * HELL_ROWS}" style="width:${HELL_W}px;height:${HELL_ROW_H * HELL_ROWS}px;background:#f7f7f7"></canvas>`);
    hellCtx = $('canvas').getContext('2d', { willReadFrequently: true }); hellClear();
    $('.dw-clear').onclick = hellClear;
    $('.dw-hsave').onclick = () => savePng($('canvas'), 'hell-' + modemKey(v));
    hellRev = false; $('.dw-hrev').onchange = (e) => { hellRev = e.target.checked; modemSend(); };
  } else {
    textWindow(ui.name + ' decoder', head);
  }
  $('.dw-var').onchange = (e) => familyChange(e.target.value);
  const ms = $('.dw-mmode'); ms.value = modemKey(v);
  const sqShow = () => {
    const r = $('.dw-msq'); if (!r) return;
    r.value = String(modemSquelch(v)); $('.dw-sqv').textContent = ui.sq.fmt(+r.value);
  };
  ms.onchange = () => { lsSet('ubersdr_modem_' + v, ms.value); modemSend(); applyFilter('modem'); lightPresets(); modemStatus(); };
  if ($('.dw-msq')) $('.dw-msq').oninput = (e) => { lsSet('ubersdr_modemsq_' + v, e.target.value); sqShow(); modemSend(); };
  $('.dw-auto').onclick = pskAutoTune;
  fsk = new FSKWorkerProxy({ role: 'fsk', variant: v, sampleRate: SR, callback: (ev) => {
    if (!ev || st.on !== 'modem') return;
    if (ev.type === 'char') { if (ev.char && ev.char !== '\r') textOut(ev.char); }
    else if (ev.type === 'hell') hellPaint(ev.column);
    else if (ev.type === 'status') { status(ev.text || ''); pskAutoResult(ev.text || ''); }
    else if (ev.type === 'metrics') modemMetrics(ev);
  } });
  sqShow();
  fsk.setVariant(v); modemSend(); fsk.setEnabled(true);
  modemStatus();
}
function modemStatus() {
  const v = modemVariant(), m = FLDIGI_MODEMS[v].modes.find((x) => x.key === modemKey(v));
  status(`Listening for ${m ? m.label : v} around ${modemCenter(v)} Hz: click its trace on the waterfall, or use Auto-tune.`);
}

// ── Packet (AX.25) and APRS (PhantomSDR-Plus ax25.js), 300 Bd HF only: 1200 Bd needs FM on
// VHF, which this receiver does not cover. Tones 1600/1800 Hz (centre 1700), USB.
function packetWindow() {
  const v = lsGet('ubersdr_rtty', 'packet') === 'aprs' ? 'aprs' : 'packet';
  textWindow(v === 'aprs' ? 'APRS decoder' : 'Packet (AX.25) decoder', `${familySelect(v)}<span class="dw-met"></span>`);
  $('.dw-var').onchange = (e) => familyChange(e.target.value);
  fsk = new FSKWorkerProxy({ role: 'fsk', variant: v, sampleRate: SR, callback: (ev) => {
    if (!ev || st.on !== 'packet') return;
    if (ev.type === 'line') textOut((ev.text || '') + '\n');
    else if (ev.type === 'status') status(ev.text || '');
    else if (ev.type === 'metrics') { const m = $('.dw-met'); if (m && Number.isFinite(ev.framesOk)) m.textContent = `${ev.framesOk} frame(s)` + (Number.isFinite(ev.stations) ? ` · ${ev.stations} station(s)` : ''); }
  } });
  fsk.setVariant(v); fsk.setConfig({ encoding: 'ax25', baud: 300, center: 1700, showRaw: true }); fsk.setEnabled(true);
  status('300 Bd HF packet, tones 1600/1800 Hz: click the signal on the waterfall to centre it. Only frames with a correct checksum are printed.');
}

// ── Start / stop / follow ───────────────────────────────────────────────────────
// A decoder's sideband and filter: [sb, lo, hi], kHz of audio
function decFilter(k) {
  const d = DEC[k];
  if (k === 'rtty' && rttyKey() !== 'rtty') return decFilter(rttyKey());
  if (k === 'rtty') { const r = RTTY[rttyVariant()], hw = r.shift / 2 + 1.43 * r.baud; return ['usb', (r.center - hw) / 1000, (r.center + hw) / 1000]; }
  if (k === 'sstv') return [sstvSideband(dialKHz()), d.lo, d.hi];
  if (k === 'psk31') return ['usb', 0.9, 1.1];                           // 1000 Hz ± 100 Hz
  if (k === 'olivia') { const hw = (oliviaMode().b / 2 + 150) / 1000; return ['usb', 1 - hw, 1 + hw]; }
  if (k === 'modem') {                        // PhantomSDR-Plus fskApplyBandpass: bw/2 + max(60, 15 %)
    const v = modemVariant(), bw = modemBw(v), c = modemCenter(v), hw = bw / 2 + Math.max(60, 0.15 * bw);
    return ['usb', Math.max(0.05, (c - hw) / 1000), (c + hw) / 1000];
  }
  if (k === 'packet') return ['usb', 1.3, 2.1];                          // 1700 Hz ± 400 Hz
  return ['usb', d.lo, d.hi];
}
function applyFilter(k) { const [sb, lo, hi] = decFilter(k); setFilter(sb, lo, hi); }

// ── Decoder filter presets (#decpresets, below the Mode filter presets) ──────────
// Shown only while a decoder runs, in place of the Mode presets. One button per decoder: it
// sets that decoder's sideband and filter, without starting that decoder (and without
// changing the sideband's usual filter, as rememberpreset would). The button of the filter
// in use is lit: the running decoder's, else the last one pressed.
// websdr-base.js pushButton() clears every .btnBandW and then calls ubersdr_decpresets_light.
let presetPicked = null;
function filterInUse(k) {
  const [sb, l, h] = decFilter(k);
  const lo = Number(W.lo), hi = Number(W.hi), near = (a, b) => Math.abs(a - b) < 0.005;
  if (pageMode() !== sb.toUpperCase()) return false;
  return sb === 'lsb' ? near(lo, -h) && near(hi, -l) : near(lo, l) && near(hi, h);
}
// While a decoder runs its presets take the place of the Mode presets (caption and buttons)
function showPresets() {
  const on = !!st.on, show = (id, v) => { const e = document.getElementById(id); if (e) e.style.display = v ? '' : 'none'; };
  show('modepresetscap', !on); show('modepresets', !on);
  show('decpresetscap', on); show('decpresets', on);
}
function lightPresets() {
  const box = document.getElementById('decpresets');
  if (!box) return;
  showPresets();
  const lit = [famKey(st.on), presetPicked].find((k) => k && filterInUse(k)) || null;
  box.querySelectorAll('.decpre').forEach((b) => {
    b.classList.toggle('btn-selected', b.dataset.dec === lit);
    const v = b.querySelector('.dp-v'), t = presetValue(b.dataset.dec);    // RTTY: follows its variant
    if (v && v.textContent !== t) v.textContent = t;
  });
}
// The filter's width, as shown under the decoder's name
function presetValue(k) {
  const [, lo, hi] = decFilter(k), bw = Math.round((hi - lo) * 1000);
  return bw >= 1000 ? (bw / 1000).toFixed(2) + ' kHz' : bw + ' Hz';
}
function presetTitle(k) {
  if (k === 'rtty') return 'Filter preset (FLDIGI window): USB, around the mode\'s audio centre; the width follows the mode chosen in the FLDIGI window (RTTY 300 Hz, DWD 593 Hz, PSK31 200 Hz, Olivia and the fldigi modems their bandwidth plus a margin, Packet 800 Hz)';
  if (k === 'psk31') return 'Filter preset (PSK31): 0.90–1.10 kHz, 200 Hz, USB (the signal at 1000 Hz)';
  if (k === 'olivia') return 'Filter preset (Olivia / MFSK): USB, centred on 1000 Hz, the signal bandwidth + 150 Hz each side (the mode chosen in the window)';
  const d = DEC[k], bw = Math.round((d.hi - d.lo) * 1000);
  const sb = k === 'sstv' ? 'LSB below 10 MHz, USB above' : 'USB';
  return `Filter preset (${d.title}): ${d.lo.toFixed(2)}–${d.hi.toFixed(2)} kHz, ${bw >= 1000 ? (bw / 1000).toFixed(2) + ' kHz' : bw + ' Hz'}, ${sb}`;
}
function buildPresets() {
  const box = document.getElementById('decpresets');
  if (!box || box.dataset.built) return;
  const keys = Object.keys(DEC).filter((k) => !DEC[k].family);
  let html = '<table align=center><tbody>';
  for (let i = 0; i < keys.length; i += 3) {
    html += '<tr>' + keys.slice(i, i + 3).map((k) =>
      `<td><button type="button" class="btnBandW decpre" data-dec="${k}" title="${esc(presetTitle(k))}"><span class="dp-n">${DEC[k].label}</span><span class="dp-v">${presetValue(k)}</span></button></td>`).join('') + '</tr>';
  }
  box.innerHTML = html + '</tbody></table>';
  box.dataset.built = '1';
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.decpre'); if (!b) return;
    presetPicked = b.dataset.dec;
    applyFilter(presetPicked);
    lightPresets();
  });
  lightPresets();
}
W.ubersdr_decpresets_light = lightPresets;
function start(k, opts) {
  stop(true);
  if (W.ubersdr_rade_active && W.ubersdr_rade_active() && W.ubersdr_rade_stop) W.ubersdr_rade_stop();
  const d = DEC[k];
  if (k === 'psk31' || k === 'olivia') lsSet('ubersdr_rtty', k);
  else if (k === 'rtty' && rttyKey() !== 'rtty') lsSet('ubersdr_rtty', 'ham');
  st.on = k; capReset(); lightButtons();
  lastBand = ''; pickedDial = 0;
  // Off the mode's usual frequencies: go to the nearest one (same as PhantomSDR-Plus's band plan)
  if (d.dials && !(opts && opts.keepDial)) {
    const f = dialKHz(), near = nearest(d.dials, f);
    if (near !== null && !(f >= near - 0.01 && f <= near + 3)) tuneKHz(near);
  }
  applyFilter(k);
  if (d.kind === 'ftx') ftxWindow(k);
  else if (k === 'js8') js8Window();
  else if (k === 'wspr') wsprWindow();
  else if (k === 'sstv') sstvWindow();
  else if (k === 'fax') faxWindow();
  else if (k === 'navtex') navtexWindow();
  else if (k === 'rtty') rttyWindow();
  else if (k === 'psk31') psk31Window();
  else if (k === 'olivia') oliviaWindow();
  else if (k === 'modem') modemWindow();
  else if (k === 'packet') packetWindow();
}
function stop(quiet) {
  if (!st.on) return;
  st.on = null; capReset(); showDial();
  if (pskAuto) { clearTimeout(pskAuto.timer); pskAuto = null; }
  for (const p of pending.values()) p.reject(new Error('stopped')); pending.clear();
  if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
  for (const x of [sstv, fax, fsk]) if (x) { try { x.destroy(); } catch (e) {} }
  sstv = fax = fsk = null; js8.re = null; hellCtx = null;
  barStop(); closeWindow(); lightButtons(); pickedDial = 0;
  // As PhantomSDR-Plus: back to the band's usual mode (LSB on 40 m, CW on 30 m…, from the
  // page's band table), with that mode's usual filter (the page's default, or the preset
  // the listener chose for it). Outside the amateur bands the sideband in use stays and
  // only its filter comes back. Not when another decoder takes over (quiet), and not after
  // AM/FM/CW/RADE, which the listener chose and which set their own filter.
  const m = pageMode();
  if (!quiet && (m === 'USB' || m === 'LSB') && !(W.ubersdr_rade_active && W.ubersdr_rade_active())) {
    try {
      const bm = W.ubersdr_bandmode ? W.ubersdr_bandmode(dialKHz()) : null;
      listener();
      W.set_mode((bm || m).toLowerCase());      // the dial stays where it is
    } catch (e) { console.error('decoders: restore mode', e); }
  }
}

// ── Station labels on the frequency scale ─────────────────────────────────────────
// A label (sv1btl/stationinfo.txt, or a memory) whose text names a digital mode starts
// that decoder, with its own sideband and filter, after the label's own click (setfreqm)
// has tuned the dial there. With several modes in one label ("JT65<br>WSPR") the first
// one the page can decode wins. A label within 2 kHz of the mode's usual dial frequency
// goes to that frequency (as the Decoder button does); one further away keeps its own.
// The decoder already running is kept (its window and decodes stay), with its filter.
// A label without a digital mode stops a running decoder; the label's own mode and its
// usual filter (set by setfreqm) stay.
const LABEL_MODES = [[/\bFT8\b/i, 'ft8'], [/\bFT4\b/i, 'ft4'], [/\bFT2\b/i, 'ft2'], [/\bJS8(?:CALL)?\b/i, 'js8'],
  [/\bWSPR\b/i, 'wspr'], [/\bSSTV\b/i, 'sstv'], [/\b(?:HF ?|WE)?FAX\b/i, 'fax'], [/\bNAVTEX\b/i, 'navtex'], [/\bRTTY\b/i, 'rtty'],
  [/\bPSK-?31\b/i, 'psk31'], [/\bOLIVIA\b/i, 'olivia'], [/\bMFSK ?-?(?:16|32|64)?\b/i, 'modem', 'mfsk'],
  [/\bDOMINO ?EX\b/i, 'modem', 'dominoex'], [/\bTHOR\b/i, 'modem', 'thor'], [/\bTHROB ?X?\b/i, 'modem', 'throb'],
  [/\b(?:FELD ?)?HELL(?:SCHREIBER)?\b/i, 'modem', 'hell'], [/\bMT-?63\b/i, 'modem', 'mt63'],
  [/\bPACKET\b/i, 'packet', 'packet'], [/\bAPRS\b/i, 'packet', 'aprs']];let labelVariant = null;              // the FLDIGI list entry a label names (modems, packet)
function labelMode(html) {
  labelVariant = null;
  const text = String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ');
  let best = null, at = Infinity;
  for (const [re, k, v] of LABEL_MODES) { const m = re.exec(text); if (m && m.index < at) { best = k; at = m.index; labelVariant = v || null; } }
  return best;
}
document.addEventListener('click', (e) => {
  const lab = e.target.closest && e.target.closest('.statinfo0, .statinfo0l');
  if (!lab) return;
  const k = labelMode(lab.innerHTML);
  if (!k) { if (st.on) stop(true); return; }
  if (labelVariant) {                           // a modem / packet label: that entry of the FLDIGI list
    lsSet('ubersdr_rtty', labelVariant);
    const mf = /\bMFSK ?-?(16|32|64)\b/i.exec(lab.textContent || '');
    if (labelVariant === 'mfsk' && mf) lsSet('ubersdr_modem_mfsk', 'mfsk' + mf[1]);
    if (st.on === k) { start(k); return; }
  }
  setTimeout(() => {                               // after setfreqm's tuning has settled
    try {
      const d = DEC[k], f = dialKHz(), near = d.dials ? nearest(d.dials, f) : null;
      const keepDial = near === null || Math.abs(near - f) > 2;
      if (st.on !== k) { start(k, { keepDial }); return; }
      if (!keepDial && Math.abs(near - f) > 0.01) tuneKHz(near);
      applyFilter(k); lightPresets();
    } catch (err) { console.error('decoders: label', err); }
  }, 0);
});

// Every received audio block (raw), from ubersdr-compat.js
W.ubersdr_dec_tap = function (pcm, sr) {
  if (!st.on || !pcm || !pcm.length) return;
  if (sr && sr !== st.sr) { st.sr = sr; capReset(); }
  try {
    const kind = DEC[st.on].kind;
    if (kind === 'ftx' || kind === 'js8') ftxFeed(pcm);
    else if (kind === 'wspr') wsprFeed(pcm);
    else if (kind === 'sstv' && sstv) sstv.feedPCM(pcm);
    else if (kind === 'fax' && fax) fax.feedPCM(pcm, st.sr);
    else if (fsk) fsk.feedPCM(pcm);
  } catch (e) { console.error('decoders: feed', e); }
};

// AM, FM, CW or RADE chosen: the decoder stops (it needs USB, or LSB for SSTV)
let lastF = 0, lastBand = '';
setInterval(() => {
  if (!st.row) buildRow();
  buildPresets();
  if (!st.on) return;
  const m = pageMode();
  if ((m !== 'USB' && m !== 'LSB') || (W.ubersdr_rade_active && W.ubersdr_rade_active())) { stop(); return; }
  const f = dialKHz();
  if (st.on === 'js8' && js8.re && lastF && Math.abs(f - lastF) > 1) js8.re.reset();
  // Tuned into another band while decoding: the page's band plan has just set that band's
  // mode (LSB on 40 m…); the decoder's own mode and filter go back in.
  const bk = W.ubersdr_bandkey ? W.ubersdr_bandkey(f) : '';
  if (lastBand && bk !== lastBand) applyFilter(st.on);
  lastF = f; lastBand = bk;
  pickedFollow();
}, 500);
buildRow();
buildPresets();
W.ubersdr_decoders = { start, stop, state: () => ({ on: st.on, sr: st.sr, cap: { on: cap.on, len: cap.len, busy: cap.busy } }) };
