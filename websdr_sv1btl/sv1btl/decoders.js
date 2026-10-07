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
  rtty:   { label: 'RTTY',   title: 'RTTY (ham 45.45 Bd / DWD weather 50 Bd)', kind: 'rtty' }
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
// Puts the dial on f. With a filter narrower than 1.4 kHz the page counts as "CW-like"
// (iscw) and tunes the middle of the passband instead of the dial, so a plain USB filter
// goes in first; the caller then sets the decoder's own (applyFilter).
function tuneKHz(f) {
  try {
    listener();
    if (W.iscw()) W.set_mode('usb');
    W.setfreqif(f.toFixed(3));
  } catch (e) { console.error('decoders: tune', e); }
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
#decrow b{font-size:13px}
#moderow #decrow .btnMode.decbtn{width:auto;min-width:40px;padding:0 4px;margin:2px 1px;font-size:.75rem}
.decwin{width:470px;margin:3px auto 4px;box-sizing:border-box;background:#f7f7f7;border:1px solid #bbb;border-radius:6px;
  font:11px/1.3 Arial,sans-serif;color:#222;text-align:left;box-shadow:1px 2px 5px rgba(0,0,0,.15)}
.decwin .dw-head{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;padding:3px 6px;background:#dfe6e4;border-radius:6px 6px 0 0}
.decwin .dw-title{font-weight:bold;flex:1;white-space:nowrap}
.decwin .dw-head span{color:#555}.decwin .dw-head b{color:#111}
.decwin select,.decwin button{font-size:10px;padding:0 3px;height:17px;max-width:190px}
.decwin label{white-space:nowrap}
.decwin .dw-list{height:120px;overflow-y:auto;background:#f7f7f7;color:#222;font:11px/14px "Courier New",monospace}
.decwin table{border-collapse:collapse;width:100%}
.decwin th{position:sticky;top:0;background:#eee;color:#444;font:bold 11px Arial,sans-serif;text-align:left;padding:1px 3px;border-bottom:1px solid #ccc}
.decwin td{padding:0 3px;white-space:nowrap;border-bottom:1px solid #e4e4e4;color:#555}
.decwin td.n{text-align:right;color:#0b4f8a}
.decwin td.n.warn{color:#c25400;font-weight:bold}
.decwin td.m{color:#111;white-space:normal}
.decwin td.c{color:#0a6b2a;font-weight:bold}
.decwin tr.sep td{border-top:1px solid #aaa}
.decwin tr:hover td{background:#e3f1ee}
.decwin a{color:#0b7a72;font-weight:bold;text-decoration:none}
.decwin a:hover{text-decoration:underline}
.decwin .dw-text{height:120px;overflow-y:auto;padding:3px 6px;background:#f7f7f7;color:#1a1a1a;
  font:12px/15px "Courier New",monospace;white-space:pre-wrap;word-break:break-word}
.decwin canvas{display:block;margin:0 auto;background:#000;image-rendering:auto}
.decwin .dw-status{padding:1px 6px 2px;color:#777;font-style:italic;border-top:1px solid #ddd;min-height:13px}
`;
  document.head.appendChild(s);
})();

function buildRow() {
  const moderow = document.getElementById('moderow');
  const anchor = document.getElementById('radestatus');
  if (!moderow || !anchor || st.row) return false;
  const row = document.createElement('div');
  row.id = 'decrow';
  row.innerHTML = '<b>Decoder: &nbsp;</b>' + Object.keys(DEC).map((k) =>
    `<button type="button" class="btnMode decbtn" id="dec-${k}" data-dec="${k}" title="${esc(DEC[k].title)} — press again to stop">${DEC[k].label}</button>`).join('');
  moderow.insertBefore(row, anchor);
  row.addEventListener('click', (e) => {
    const b = e.target.closest('.decbtn'); if (!b) return;
    const k = b.dataset.dec;
    if (st.on === k) stop(); else start(k);
  });
  st.row = row;
  return true;
}
function lightButtons() {
  if (!st.row) return;
  st.row.querySelectorAll('.decbtn').forEach((b) => b.classList.toggle('btn-selected', b.dataset.dec === st.on));
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
    else { countdown(period - pos); return; }
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
let lastCd = 0;
function countdown(s) {
  const now = Date.now(); if (now - lastCd < 500) return; lastCd = now;
  if (!cap.busy) status(`Next slot in ${Math.ceil(s)} s`);
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
    <div class="dw-list"><table><thead><tr><th>UTC</th><th>dB</th><th>Hz</th><th>Message</th></tr></thead><tbody></tbody></table></div>`);
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
    <div class="dw-list"><table><thead><tr><th>UTC</th><th>Call</th><th>Locator</th><th>dBm</th><th>kHz</th><th>SNR</th><th>Distance</th></tr></thead><tbody></tbody></table></div>`);
  $('.dw-clear').onclick = () => { $('tbody').innerHTML = ''; $('.dw-count').textContent = '0'; };
}
function wsprFeed(pcm) {
  const pos = wspr2SlotPosition();
  if (!cap.on && pos < 2) { cap.on = true; cap.len = 0; cap.t0 = Date.now() - pos * 1000; }
  if (!cap.on) { if (!cap.busy) countdown(120 - pos); return; }
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
  $('.dw-tune').onchange = (e) => { const f = +e.target.value; if (f) { tuneKHz(f); applyFilter('sstv'); } e.target.value = ''; };
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
    applyFilter('fax'); e.target.value = '';
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
  $('.dw-tune').onchange = (e) => { const f = +e.target.value; if (f) { tuneKHz(f - 0.5); applyFilter('navtex'); } e.target.value = ''; };
  status('Listening (100 Bd, 170 Hz shift, centre 500 Hz)…');
}
const RTTY = { ham: { center: 1000, shift: 170, baud: 45.45 }, weather: { center: 1000, shift: 450, baud: 50 } };
function rttyVariant() { return lsGet('ubersdr_rtty', 'ham') === 'weather' ? 'weather' : 'ham'; }
function rttyFreqOptions(v) { return `<option value="">Frequency…</option>` + RTTY_FREQS[v].map(([n, f]) => `<option value="${f}">${n}</option>`).join(''); }
function rttyWindow() {
  const v = rttyVariant();
  textWindow('RTTY decoder', `<select class="dw-var dec-sel"><option value="ham">Ham 45.45 Bd / 170 Hz</option><option value="weather">DWD weather 50 Bd / 450 Hz</option></select>
    <select class="dw-tune dec-sel">${rttyFreqOptions(v)}</select><span class="dw-met"></span>`);
  const vs = $('.dw-var'); vs.value = v;
  fsk = new FSKWorkerProxy({ role: 'fsk', variant: v, sampleRate: SR, callback: (ev) => {
    if (!ev || st.on !== 'rtty') return;
    if (ev.type === 'char') { if (ev.char && ev.char !== '\r') textOut(ev.char); }
    else if (ev.type === 'status') status(ev.text || '');
    else if (ev.type === 'metrics') { const m = $('.dw-met'); if (m) m.textContent = Number.isFinite(ev.snrDb) ? `SNR ${ev.snrDb.toFixed(0)} dB` : ''; }
  } });
  fsk.setVariant(v); fsk.setConfig(null); fsk.setEnabled(true);
  vs.onchange = () => {
    lsSet('ubersdr_rtty', vs.value); fsk.setVariant(vs.value); fsk.setConfig(null);
    $('.dw-tune').innerHTML = rttyFreqOptions(vs.value); applyFilter('rtty');
  };
  $('.dw-tune').onchange = (e) => { const f = +e.target.value; if (f) { tuneKHz(f - RTTY[rttyVariant()].center / 1000); applyFilter('rtty'); } e.target.value = ''; };
  status(`Listening (tones centred on ${RTTY[v].center} Hz)…`);
}

// ── Start / stop / follow ───────────────────────────────────────────────────────
function applyFilter(k) {
  const d = DEC[k];
  if (k === 'rtty') { const r = RTTY[rttyVariant()], hw = r.shift / 2 + 1.43 * r.baud; setFilter('usb', (r.center - hw) / 1000, (r.center + hw) / 1000); return; }
  if (k === 'sstv') { setFilter(sstvSideband(dialKHz()), d.lo, d.hi); return; }
  setFilter('usb', d.lo, d.hi);
}
function start(k) {
  stop(true);
  if (W.ubersdr_rade_active && W.ubersdr_rade_active() && W.ubersdr_rade_stop) W.ubersdr_rade_stop();
  const d = DEC[k];
  st.on = k; capReset(); lightButtons();
  lastBand = '';
  // Off the mode's usual frequencies: go to the nearest one (same as PhantomSDR-Plus's band plan)
  if (d.dials) {
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
}
function stop(quiet) {
  if (!st.on) return;
  st.on = null; capReset();
  for (const p of pending.values()) p.reject(new Error('stopped')); pending.clear();
  if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
  for (const x of [sstv, fax, fsk]) if (x) { try { x.destroy(); } catch (e) {} }
  sstv = fax = fsk = null; js8.re = null;
  closeWindow(); lightButtons();
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
}, 500);
buildRow();
W.ubersdr_decoders = { start, stop, state: () => ({ on: st.on, sr: st.sr, cap: { on: cap.on, len: cap.len, busy: cap.busy } }) };
