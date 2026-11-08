// decoders.js — digital-mode decoders for the SV1BTL WebSDR page (desktop), 2026-10-07.
//
// FT8, FT4, FT2, JS8, WSPR, SSTV, HF FAX, NAVTEX, RTTY and HFDL, decoded in the listener's
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
// 2026-11-05 (PhantomSDR-Plus 5.5.0): FAX / NAVTEX / DWD RTTY broadcast schedules, the FT8/FT4/
// FT2/JS8/WSPR audio spectrum strip and Decoder ID.
//
// 2026-11-06 (PhantomSDR-Plus 5.5.0): SERVICES (HFDL, DSC, Time Signals, HF Selcall), ALE 2G,
// FST4W, MSK144 and the PSK Browser.
//
// 2026-11-08 (PhantomSDR-Plus 5.5.0): FLDIGI and SERVICES lists in PhantomSDR-Plus's order.
// Weather RTTY and Maritime FSK / SITOR moved from FLDIGI to SERVICES; ALE 2G is split:
// FLDIGI "ALE 2G HAM" (the amateur HFLINK net), SERVICES "ALE 2G" (every other net).
//
// Licence: GNU GPL v3, as PhantomSDR-Plus.

import { SSTVWorkerProxy } from './psdr/sstvWorkerProxy.js';
import { FAXWorkerProxy } from './psdr/faxWorkerProxy.js';
import { FSKWorkerProxy } from './psdr/fskWorkerProxy.js?v=20261106c';
import { FLDIGI_MODEMS } from './psdr/fsk.js?v=20261106c';
import { PSK_MODES, pskModeCfg } from './psdr/psk31.js?v=20261106';
import { mt63DefaultCenter } from './psdr/mt63.js';
import { WSPR_TOTAL_SAMPLES, wspr2SlotPosition } from './psdr/modules/wspr.js';
import { decodeFrame as js8DecodeFrame, loadDictionary as js8LoadDictionary } from './psdr/modules/js8.js';
import { Js8Reassembler } from './psdr/modules/js8-reassembler.js';
import { formatJs8Message } from './psdr/modules/js8-format.js';
import { js8Period, js8CaptureSamples, js8SlotPos, js8StartWindow } from './psdr/modules/js8-slots.js';
import { HFDLWorkerProxy } from './psdr/hfdlWorkerProxy.js';
import { HFDL_STATIONS } from './psdr/lib/hfdlStations.js';
import { AprsMap, locatorToLatLon } from './psdr/lib/aprsMap.js';
// PhantomSDR-Plus 5.5.0 (2026-11-06, copied unchanged): SERVICES (DSC, time signals, HF Selcall
// in services.worker.js), and ALE 2G's list of networks
import { ServicesWorkerProxy } from './psdr/servicesWorkerProxy.js?v=20261106';
import { TIME_STATIONS } from './psdr/timesig.js?v=20261106';
import { ALE_NETS } from './psdr/lib/aleNets.js?v=20261108';
// PhantomSDR-Plus 5.5.0 (copied unchanged): FAX / NAVTEX / DWD RTTY timetables, the
// Decoder ID engine with its band-plan layer, and the FFT for the FT8/WSPR spectrum strip
import { FAX_SCHEDULE, NAVTEX_DB, RTTY_SCHEDULE, RTTY_PROGRAMME_BY_KHZ, parseSlots, navtexSlots, scheduleRows } from './psdr/broadcastSchedules.js';
import { ModeIdWorkerProxy } from './psdr/modeIdWorkerProxy.js?v=20261106';
import { RELIABLE_LO_HZ, RELIABLE_HI_HZ, RECENTRE_TARGET_HZ } from './psdr/modeId.js?v=20261106';
import { applyBandPriors, signalKhz } from './psdr/modePriors.js?v=20261106';
import { transformFlat } from './psdr/lib/fftRadix2.js';

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
const FT8_DIALS  = [1840, 3573, 5357, 7074, 10136, 14074, 18100, 21074, 24915, 28074, 50313, 50323];
const FT4_DIALS  = [3575.5, 7047.5, 10140, 14080, 18104, 21140, 24919, 28180];
const JS8_DIALS  = [1842, 3578, 7078, 10130, 14078, 18104, 21078, 24922, 28078];
const WSPR_DIALS = [136, 474.2, 1836.6, 3568.6, 3592.6, 5287.2, 7038.6, 10138.7, 14095.6, 18104.6, 21094.6, 24924.6, 28124.6];
const NAVTEX_STATIONS = [
  ['International NAVTEX 518 kHz', 518], ['National NAVTEX 490 kHz', 490], ['Japan 424 kHz', 424],
  ['MF NBDP 2174.5 kHz (ITU working)', 2174.5],
  ['HF NAVTEX 4209.5 kHz', 4209.5], ['HF SITOR 4210 kHz', 4210], ['HF 6314 kHz', 6314], ['HF 8416.5 kHz', 8416.5],
  ['HF 12579 kHz', 12579], ['HF 16806.5 kHz', 16806.5], ['HF 19680.5 kHz', 19680.5], ['HF 22376 kHz', 22376],
  ['HF 26100.5 kHz', 26100.5]];   // HF: ITU Appendix 15 NBDP/SITOR-B (PhantomSDR-Plus maritime list)
// SERVICES Maritime FSK / SITOR: signal frequencies, kHz (PhantomSDR-Plus FSK_KNOWN_FREQUENCIES.maritime)
const MARITIME_FREQS = [
  ['2174.50 kHz — MF NBDP (ITU working)', 2174.5], ['518.00 kHz — International NAVTEX', 518], ['490.00 kHz — National NAVTEX', 490],
  ['4209.50 kHz — HF NAVTEX', 4209.5], ['4210.00 kHz — HF SITOR (MSI)', 4210], ['6314.00 kHz — HF SITOR (MSI)', 6314],
  ['8416.50 kHz — HF SITOR (MSI)', 8416.5], ['12579.00 kHz — HF SITOR (MSI)', 12579], ['16806.50 kHz — HF SITOR (MSI)', 16806.5],
  ['19680.50 kHz — HF SITOR (MSI)', 19680.5], ['22376.00 kHz — HF SITOR (MSI)', 22376], ['26100.50 kHz — HF SITOR (MSI)', 26100.5]];
const RTTY_FREQS = {          // signal centre, kHz (PhantomSDR-Plus FSK_KNOWN_FREQUENCIES)
  ham: [['80m RTTY 3590', 3590], ['40m RTTY 7043', 7043], ['30m RTTY 10143', 10143], ['20m RTTY 14083', 14083],
        ['15m RTTY 21083', 21083], ['10m RTTY 28083', 28083]],
  weather: [['DWD DDK2 4583', 4583], ['DWD DDH7 7646', 7646], ['DWD DDK9 10100.8', 10100.8],
            ['DWD DDH9 11039', 11039], ['DWD DDH8 14467.3', 14467.3],
            ['DWD DDH47 147.3 (LF, 85 Hz)', 147.3, 85]]   // 3rd: its own shift, Hz (DDH47 is ±42.5 Hz)
};
// Packet: the HF APRS USB dial (tones at 1600/1800 Hz); PhantomSDR-Plus's VHF entries are
// outside this receiver
const PACKET_DIALS = [['30m HF APRS 10147.6 (dial, 300 Bd)', 10147.6]];
// PSK31 and Olivia: signal frequencies, kHz (PhantomSDR-Plus FSK_KNOWN_FREQUENCIES)
const PSK31_FREQS = [['80m 3580.15', 3580.15], ['40m 7040.15', 7040.15], ['30m 10142.15', 10142.15], ['20m 14070.15', 14070.15],
                     ['17m 18100.15', 18100.15], ['15m 21080.15', 21080.15], ['12m 24920.15', 24920.15], ['10m 28120.15', 28120.15]];
const OLIVIA_FREQS = [['80m 3583.00 (8/250)', 3583], ['40m 7040.00 (8/250)', 7040], ['40m 7072.50 (8/250)', 7072.5],
                      ['30m 10143.00 (8/250)', 10143], ['20m 14072.50 (8/250)', 14072.5], ['20m 14108.50 (32/1000)', 14108.5],
                      ['17m 18099.00 (8/250)', 18099], ['15m 21072.50 (8/250)', 21072.5], ['12m 24922.50 (8/250)', 24922.5],
                      ['10m 28122.50 (8/250)', 28122.5]];
// The four Olivia set-ups that cover nearly all traffic (PhantomSDR-Plus OLIVIA_MODE_OPTIONS)
const OLIVIA_MODES = [{ t: 8, b: 250, label: '8/250' }, { t: 16, b: 500, label: '16/500' },
                      { t: 32, b: 1000, label: '32/1000' }, { t: 16, b: 1000, label: '16/1000' },
  // Contestia (PhantomSDR-Plus 5.5.0, olivia.js CONTESTIA_MODES): the same modem with a smaller
  // FEC block (6-bit characters, upper case only); 8/250 first = its default
  ...[[8, 250], [4, 125], [4, 250], [4, 500], [8, 500], [8, 1000], [16, 500], [16, 1000], [32, 1000], [64, 1000]]
    .map(([t, b]) => ({ t, b, label: `${t}/${b}`, c: true }))];
const CONTESTIA_DEFAULT = OLIVIA_MODES.findIndex((o) => o.c);
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
  rtty:   { label: 'FLDIGI', title: 'FLDIGI modes: Amateur RTTY, PSK31·63·125 (BPSK/QPSK), Olivia / Contestia, FST4W, MFSK, MSK144, DominoEX, THOR, THROB, Hellschreiber, MT63, ALE 2G HAM, Packet, APRS (chosen in the window)', kind: 'rtty' },
  // SERVICES (PhantomSDR-Plus 5.5.0, ex-HFDL button): HFDL, Maritime FSK / SITOR, Weather
  // RTTY, DSC, Time Signals, HF Selcall, ALE 2G, chosen in the window's Service list
  services: { label: 'SERVICES', title: 'SERVICES — HFDL (aircraft), Maritime FSK / SITOR, Weather RTTY, DSC (maritime calls), Time Signals, HF Selcall, ALE 2G (chosen in the window)', kind: 'services' },
  // PhantomSDR-Plus's HFDL: USB, the dial on the listed frequency, subcarrier at 1440 Hz
  hfdl:   { label: 'HFDL',   title: 'HFDL — HF Data Link: aircraft ACARS messages on shortwave', kind: 'hfdl', lo: 0.15, hi: 2.75, family: 'services' },
  // Maritime FSK / SITOR (fsk.js 'maritime': 100 Bd, 170 Hz, centre 500 Hz above the dial) and
  // DWD Weather RTTY (the RTTY window, 50 Bd, 450 Hz): in FLDIGI until 2026-11-08
  maritime: { label: 'SITOR',   title: 'Maritime FSK / SITOR — SITOR-B / NBDP maritime safety broadcasts (100 Bd, 170 Hz)', kind: 'maritime', lo: 0.25, hi: 0.75, family: 'services' },
  weather:  { label: 'RTTY-WX', title: 'Weather RTTY — DWD Pinneberg and similar (50 Bd, 450 Hz)', kind: 'rtty', family: 'services' },
  // DSC and Selcall: FSK centre 1700 Hz above the USB dial; time signals: carrier at 1000 Hz
  dsc:     { label: 'DSC',     title: 'DSC — Digital Selective Calling: MF/HF maritime calls (GMDSS)', kind: 'svc', lo: 1.4, hi: 2.0, family: 'services' },
  time:    { label: 'TIME',    title: 'Time Signals — DCF77, MSF, RWM, WWV/WWVH: decoded date and time', kind: 'svc', lo: 0.7, hi: 1.3, family: 'services' },
  selcall: { label: 'SELCALL', title: 'HF Selcall — CCIR 493-4 (Codan, Barrett …): who calls whom', kind: 'svc', lo: 1.4, hi: 2.0, family: 'services' },
  // ALE 2G of every net but the amateur one (that is FLDIGI's ALE 2G HAM)
  aleu:    { label: 'ALE',     title: 'ALE 2G (MIL-STD-188-141): government, military, MARS and utility networks', kind: 'ale', family: 'services' },
  // No buttons of their own: chosen in the RTTY window's list (family 'rtty')
  psk31:  { label: 'PSK',    title: 'PSK31·63·125 (BPSK / QPSK)', kind: 'psk31', centred: true, family: 'rtty' },
  olivia: { label: 'OLIVIA', title: 'Olivia / Contestia (MFSK)', kind: 'olivia', centred: true, family: 'rtty' },
  // PhantomSDR-Plus 5.1.0 fldigi modems (fsk.js FLDIGI_MODEMS) and AX.25 packet, one window each
  modem:  { label: 'MODEM',  title: 'fldigi modems',          kind: 'modem', centred: true, family: 'rtty' },
  packet: { label: 'PACKET', title: 'Packet / APRS (300 Bd)', kind: 'packet', centred: true, family: 'rtty' },
  // PhantomSDR-Plus 5.5.0 (2026-11-06): ALE 2G HAM (amateur nets only), FST4W and MSK144 in the FLDIGI list
  ale:    { label: 'ALE',    title: 'ALE 2G HAM (MIL-STD-188-141): the amateur (HFLINK) channels', kind: 'ale', family: 'rtty' },
  fst4w:  { label: 'FST4W',  title: 'FST4W (WSJT-X)',         kind: 'fst4w', family: 'rtty' },
  msk144: { label: 'MSK144', title: 'MSK144 (WSJT-X meteor scatter)', kind: 'msk144', family: 'rtty' }
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
// kHz between the dial and the signal a decoder reads (the audio centre it decodes at): the
// page's frequency box adds it, so NAVTEX shows 518.00 on a 517.50 dial (PhantomSDR-Plus
// decoderDisplayOffsetHz). PSK31 / Olivia / fldigi modems with a CW-like (narrow) filter
// already show the passband middle, which is their centre. Packet shows as before.
W.ubersdr_dec_offset = function () {
  if (st.on === 'fax') return 1.9;
  if (st.on === 'navtex' || st.on === 'maritime') return 0.5;
  if (st.on === 'rtty' || st.on === 'weather') return RTTY[rttyVariant()].center / 1000;
  if (pageIscw()) return 0;
  if (st.on === 'dsc' || st.on === 'selcall') return 1.7;         // the DSC / Selcall frequency
  if (st.on === 'time') return 1;                                   // the time-signal carrier
  if (browsing()) return 0;                                         // PSK / Olivia Browser: the dial
  if (st.on === 'psk31' || st.on === 'olivia') return 1;
  if (st.on === 'modem') return modemCenter(modemVariant()) / 1000;
  return 0;
};
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
#decrow .decline{display:flex;align-items:center;gap:2px}
#decrow .decline>b{flex:none;margin-right:2px}
#moderow #decrow .btnMode.decbtn{flex:1 1 auto;width:auto;min-width:0;padding:0 2px;margin:2px 0;font-size:.7rem;white-space:nowrap}
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
.aprs-map{min-height:200px;background:#0b1220}
.aprs-map img{max-width:none!important;max-height:none!important}
.decwin .hf-map{height:320px;margin:4px 6px 0;border:1px solid #888;border-radius:4px;overflow:hidden}
.decwin .hf-mapnote{margin:2px 6px 0;font-style:italic;color:#555}
.decwin .hf-mapnote.err{color:#c00;font-style:normal}
.decwin .dw-head button.on{background:#7cc7bd}
.leaflet-tooltip.aprs-label{background:rgba(15,23,42,.85);color:#a7f3d0;border:none;box-shadow:none;padding:0 4px;font:600 11px/1.4 ui-monospace,Menlo,monospace}
.leaflet-tooltip.aprs-label::before{display:none}
.leaflet-tooltip.aprs-home{color:#fcd34d}
.aprs-popup{font-size:12px;line-height:1.4}
.aprs-popup-call{font-weight:700;font-family:ui-monospace,Menlo,monospace;margin-bottom:2px}
.aprs-popup-meta{margin-top:4px;color:#6b7280;font-size:11px}
.aprs-popup-link{display:inline-block;margin-top:4px;font-weight:600;color:#0e7490;text-decoration:underline}
.hfdl-big{position:fixed;z-index:1000;width:min(1100px,calc(100vw - 16px));height:min(72vh,760px);min-width:420px;min-height:280px;
  max-width:calc(100vw - 8px);max-height:calc(100vh - 8px);resize:both;overflow:hidden;display:flex;flex-direction:column;
  border-radius:8px;background:rgba(17,24,39,.97);box-shadow:0 10px 40px rgba(0,0,0,.6),0 0 0 1px rgba(56,189,248,.45);font:13px Arial,sans-serif}
.hfdl-big-head{display:flex;align-items:center;gap:10px;padding:6px 10px;border-bottom:1px solid #374151;background:rgba(56,189,248,.10);cursor:grab;user-select:none;touch-action:none}
.hfdl-big-head.dragging{cursor:grabbing}
.hfdl-grip{color:rgb(56,189,248);font-size:15px;line-height:1}
.hfdl-big-title{color:#e0f2fe;font-weight:600;font-size:13px}
.hfdl-big-btn{padding:2px 8px;border-radius:5px;font-size:12px;font-weight:600;color:rgb(56,189,248);background:rgba(0,0,0,.35);border:1px solid rgba(56,189,248,.55);cursor:pointer}
.hfdl-big-btn:hover{background:rgba(56,189,248,.18)}
.hfdl-big-map{flex:1;min-height:0}
.hfdl-big-note{font-size:11px;color:#9ca3af;font-style:italic;padding:4px 10px}
.hfdl-big-note.err{color:#f87171;font-style:normal}
.decwin .dw-sched{margin:3px 6px 0;border:1px solid #c4c4c4;border-radius:4px;background:#fff;font:11px/15px Arial,sans-serif;overflow:hidden}
.decwin .dw-sched-h{padding:0 5px;background:#e4e4e4;font-weight:bold;color:#0a5a52;border-bottom:1px solid #ccc}
.decwin .dw-sched-b{max-height:75px;overflow-y:auto}
.decwin .dw-srow{display:flex;align-items:center;gap:6px;padding:0 5px;border-bottom:1px solid #eee;white-space:nowrap}
.decwin .dw-srow:last-child{border-bottom:0}
.decwin .dw-srow .t{font:bold 11px "Courier New",monospace;flex:none}
.decwin .dw-srow .l{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:#333}
.decwin .dw-srow .c{font:bold 11px "Courier New",monospace;color:#666;flex:none;min-width:62px;text-align:right}
.decwin .dw-srow .id{flex:none;width:13px;text-align:center;border-radius:2px;background:#888;color:#fff;font-weight:bold;font-size:10px;line-height:13px}
.decwin .dw-srow .d{flex:none;width:9px;font-size:10px}
.decwin .dw-srow.first{background:#eef4f3}.decwin .dw-srow.first .c{color:#0a5a52}
.decwin .dw-srow.air{background:#d3f0da}.decwin .dw-srow.air .c,.decwin .dw-srow.air .d{color:#0a7a2a}.decwin .dw-srow.air .id{background:#1a9b3c}
.decwin .dw-srow.urg .c,.decwin .dw-srow.urg .d{color:#b06a00}.decwin .dw-srow.urg .id{background:#d08a00}
.decwin .dw-srow.imm .c,.decwin .dw-srow.imm .d{color:#c00}.decwin .dw-srow.imm .id{background:#c00}
.decwin .dw-spec{position:relative;margin:3px 6px 0;border:1px solid #888;border-radius:4px;background:#0b1220;overflow:hidden}
.decwin .dw-spec canvas{width:100%;height:56px;background:transparent}
.decwin .dw-spec span{position:absolute;top:1px;right:5px;font:9px Arial,sans-serif;color:rgba(255,255,255,.45);pointer-events:none}
.decwin .dw-list.ftx td.m{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:0;width:100%;cursor:pointer}
.decwin .dw-list.ftx tr.open td.m{white-space:normal;overflow-wrap:anywhere}
.decwin .sv-row{padding:1px 4px 2px;border-bottom:1px solid #ddd;font:11px/14px Arial,sans-serif;white-space:normal}
.decwin .sv-row .t{font:bold 11px "Courier New",monospace;color:#555}
.decwin .sv-row .k{font-weight:bold}.decwin .sv-row .k.dis{color:#c00}.decwin .sv-row .k.urg{color:#b34700}.decwin .sv-row .k.saf{color:#8a6d00}.decwin .sv-row .k.rou{color:#06305a}
.decwin .sv-row .fmt{color:#0a5a52}.decwin .sv-row .ok{color:#0a7a2a}.decwin .sv-row .bad{color:#b06a00}
.decwin .sv-row .fl{color:#222}.decwin .sv-row .fl i{font-style:normal;color:#666}
.decwin .dw-info{display:flex;flex-wrap:wrap;gap:2px 12px;padding:1px 6px;border-bottom:1px solid #ddd;color:#444}
.decwin .dw-info b{font-family:"Courier New",monospace;color:#000}.decwin .dw-info .warn{color:#b06a00}
.decwin .ts-big{padding:3px 6px;border-bottom:1px solid #ddd;min-height:22px}
.decwin .ts-big .utc{font:bold 22px/26px "Courier New",monospace;color:#0a6b2a}
.decwin .ts-bits{display:flex;gap:1px;padding:2px 6px}.decwin .ts-bits span{flex:1;height:8px;border-radius:1px;background:#ccc}
.decwin .ts-bits .b0{background:#2f5f3a}.decwin .ts-bits .b1{background:#3fc060}.decwin .ts-bits .b2{background:#e0a020}.decwin .ts-bits .now{background:#2a8ad0}
.decwin .pb-row{display:flex;align-items:flex-start;gap:6px;padding:1px 4px;border-bottom:1px solid #ddd;cursor:pointer}
.decwin .pb-row:hover{background:#e3f1ee}.decwin .pb-row .f{color:#06305a;flex:none}.decwin .pb-row .q{flex:none;width:34px;color:#888}.decwin .pb-row .q.on{color:#0a7a2a}
.decwin .pb-row .x{flex:1 1 0;min-width:0;max-height:84px;overflow-y:auto;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;color:#000}
.decwin .pb-row .ud{flex:none;display:flex;flex-direction:column;line-height:1}
.decwin .pb-row .ud button{height:12px;padding:0 2px;font-size:9px;border:0;background:none;color:#777;cursor:pointer}
.decwin .pb-row .ud button:hover{color:#000}
html.ubersdr-dark #mainpanel .decwin .sv-row,html.ubersdr-dark #mainpanel .decwin .dw-info,html.ubersdr-dark #mainpanel .decwin .ts-big{border-color:#3a4046;color:#dde2e7}
html.ubersdr-dark #mainpanel .decwin .sv-row .fl,html.ubersdr-dark #mainpanel .decwin .dw-info b,html.ubersdr-dark #mainpanel .decwin .pb-row .x{color:#fff}
html.ubersdr-dark #mainpanel .decwin .sv-row .t,html.ubersdr-dark #mainpanel .decwin .sv-row .fl i,html.ubersdr-dark #mainpanel .decwin .dw-info{color:#9aa1a8}
html.ubersdr-dark #mainpanel .decwin .sv-row .k.rou,html.ubersdr-dark #mainpanel .decwin .pb-row .f{color:#8cc4ff}html.ubersdr-dark #mainpanel .decwin .sv-row .fmt{color:#7fd3c6}
html.ubersdr-dark #mainpanel .decwin .ts-big .utc{color:#7fe0a0}html.ubersdr-dark #mainpanel .decwin .pb-row:hover{background:#2f3d52}
#decid{display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px;margin:1px 0 2px;font:11px/17px Arial,sans-serif;color:#222}
#decid>b{font-size:13px}
#decid button{font-size:10px;height:17px;padding:0 5px;cursor:pointer}
#decid button.on{background:#7cc7bd}
#decid .di-bar{display:inline-block;width:90px;height:6px;background:#ccc;border-radius:3px;overflow:hidden;vertical-align:middle}
#decid .di-bar i{display:block;height:100%;background:#3a6db5}
#decid .di-best{font-weight:bold}
#decid .di-g{color:#0a7a2a}#decid .di-y{color:#9a7a00}#decid .di-o{color:#b05a00}
#decid .di-feat{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#555}
#decid .di-alt{border:0;background:none;color:#04504a;text-decoration:underline}
#decid .di-alt[disabled]{color:#888;text-decoration:none;cursor:default}
#decid .di-use{background:#1a9b3c;color:#fff;border:1px solid #127a2e;border-radius:3px;font-weight:bold}
#decid .di-rec{background:#d08a00;color:#fff;border:1px solid #a86e00;border-radius:3px}
html.ubersdr-dark #mainpanel .decwin .dw-sched{background:#22262a;border-color:#454b52}
html.ubersdr-dark #mainpanel .decwin .dw-sched-h{background:#31373d;color:#7fd3c6;border-bottom-color:#454b52}
html.ubersdr-dark #mainpanel .decwin .dw-srow{border-bottom-color:#33393f}
html.ubersdr-dark #mainpanel .decwin .dw-srow .l{color:#cfd5db}
html.ubersdr-dark #mainpanel .decwin .dw-srow .c{color:#9aa1a8}
html.ubersdr-dark #mainpanel .decwin .dw-srow.first{background:#2b3238}html.ubersdr-dark #mainpanel .decwin .dw-srow.first .c{color:#7fd3c6}
html.ubersdr-dark #mainpanel .decwin .dw-srow.air{background:#1f3a2a}html.ubersdr-dark #mainpanel .decwin .dw-srow.air .c{color:#7fe0a0}
html.ubersdr-dark #mainpanel .decwin .dw-srow.urg .c{color:#ffb070}html.ubersdr-dark #mainpanel .decwin .dw-srow.imm .c{color:#ff7070}
html.ubersdr-dark #decid{color:#dde2e7}html.ubersdr-dark #decid .di-feat{color:#9aa1a8}html.ubersdr-dark #decid .di-alt{color:#8fb8ff}
html.ubersdr-dark #decid .di-g{color:#7fe0a0}html.ubersdr-dark #decid .di-y{color:#f0d060}html.ubersdr-dark #decid .di-o{color:#ffb070}
`;
  document.head.appendChild(s);
})();

const DEC_ROWS = [['ft8', 'ft4', 'ft2', 'js8', 'wspr', 'sstv', 'fax', 'navtex', 'rtty', 'services']];
function buildRow() {
  const moderow = document.getElementById('moderow');
  const anchor = document.getElementById('radestatus');
  if (!moderow || !anchor || st.row) return false;
  const row = document.createElement('div');
  row.id = 'decrow';
  // One line, the buttons stretched over its width
  const btn = (k) => `<button type="button" class="btnMode decbtn" id="dec-${k}" data-dec="${k}" title="${esc(DEC[k].title)} — press again to stop">${DEC[k].label}</button>`;
  row.innerHTML = DEC_ROWS.map((keys, i) => `<span class="decline"><b>Decoder: &nbsp;</b>${keys.map(btn).join('')}</span>`).join('') +
    '<div id="decid"></div>';
  moderow.insertBefore(row, anchor);
  row.addEventListener('click', (e) => {
    if (e.target.closest('#decid')) { idClick(e); return; }
    const b = e.target.closest('.decbtn'); if (!b) return;
    const k = b.dataset.dec;
    if (famKey(st.on) === k) stop(); else start(k === 'rtty' ? rttyKey() : k === 'services' ? svcKey() : k);
  });
  st.row = row;
  idDraw();
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
  if (v === 'ale' || v === 'fst4w' || v === 'msk144') return v;
  return 'rtty';
}
// In PhantomSDR-Plus's order (App.svelte FLDIGI list); DWD weather RTTY is in SERVICES now
const FAMILY_OPTS = [['ham', 'Amateur RTTY'], ['psk31', 'PSK31·63·125 (BPSK/QPSK)'], ['olivia', 'Olivia / Contestia'],
                     ['fst4w', 'FST4W (WSJT-X)'], ['mfsk', 'MFSK16·32·64'], ['msk144', 'MSK144 (WSJT-X)'],
                     ['dominoex', 'DominoEX'], ['thor', 'THOR'], ['throb', 'THROB / THROBX'], ['hell', 'Hellschreiber'],
                     ['mt63', 'MT63'], ['ale', 'ALE 2G HAM'], ['packet', 'Packet (AX.25)'], ['aprs', 'APRS']];
function familySelect(cur) {
  return `<select class="dw-var dec-sel" title="FLDIGI mode">${FAMILY_OPTS.map(([v, n]) =>
    `<option value="${v}"${v === cur ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
}
// Another member of the family chosen in the list: that decoder takes over (true)
function familyChange(v) {
  lsSet('ubersdr_rtty', v);
  const k = rttyKey();
  if (k === st.on && k === 'rtty') return false;      // Amateur RTTY already running
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
function closeWindow() { schedStop(); specStop(); if (st.win) st.win.remove(); st.win = null; }
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
    if (pos <= win) { cap.on = true; cap.len = 0; cap.t0 = Date.now() - pos * 1000 - shift * 1000; specReset(); }
    else { specFeed(pcm); return; }
  }
  specFeed(pcm);
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
    ${SPEC_HTML}<div class="dw-list ftx"><table><thead><tr><th>UTC</th><th>dB</th><th>DT</th><th>Hz</th><th>Message</th><th>Locator</th><th>Distance</th></tr></thead><tbody></tbody></table></div>`);
  $('.dw-clear').onclick = () => { $('tbody').innerHTML = ''; $('.dw-count').textContent = '0'; };
  // One line per message, a long one cut with "…" (as PhantomSDR-Plus); a click on it shows
  // the whole message, another click folds it again (links in the row still open)
  $('tbody').onclick = (e) => { if (e.target.closest('a')) return; const r = e.target.closest('tr'); if (r) r.classList.toggle('open'); };
  showShift(); specStart('ftx');
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
  specMarks(res.map((r) => r.freq));
  const target = dtTarget(m);
  let html = '';
  res.forEach((r, i) => {
    const dt = Number.isFinite(r.dt) ? r.dt - target : NaN, [loc, km] = gridCell(r.text);
    html += `<tr${i === 0 ? ' class="sep"' : ''}><td>${utcHM(t0)}</td><td class="n">${Number.isFinite(r.snr) ? (r.snr > 0 ? '+' : '') + r.snr.toFixed(0) : ''}</td>` +
      `<td class="n${Math.abs(dt) > 0.5 ? ' warn' : ''}">${Number.isFinite(dt) ? dt.toFixed(1) : ''}</td>` +
      `<td class="n">${Number.isFinite(r.freq) ? r.freq.toFixed(0) : ''}</td><td class="m" title="${esc(r.text || '')} — click to show it all">${esc(r.text || '')}</td><td>${loc}</td><td class="n">${km}</td></tr>`;
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
    ${BAR_HTML}${SPEC_HTML}<div class="dw-list"><table><thead><tr><th>UTC</th><th>dB</th><th>Hz</th><th>Message</th></tr></thead><tbody></tbody></table></div>`);
  barStart(); specStart('ftx');
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
  specMarks(raw.map((r) => r.freq));
  for (const { f, meta } of frames) { try { js8.re.addFrame(f, meta); } catch (e) { console.error('decoders: JS8', e); } }
  try { js8.re.tick(now); } catch (e) {}
  autoSync(ftxMode(), raw);
  status(`${utcHM(t0)} UTC: ${frames.length} frame(s)`);
}

// WSPR: 2-minute slots on even UTC minutes
function wsprWindow() {
  openWindow(`<div class="dw-head"><span class="dw-title">WSPR decoder</span><span>Spots <b class="dw-count">0</b></span>
    <button type="button" class="dw-clear">Clear</button></div>
    ${BAR_HTML}${SPEC_HTML}<div class="dw-list"><table><thead><tr><th>UTC</th><th>Call</th><th>Locator</th><th>dBm</th><th>kHz</th><th>SNR</th><th>Distance</th></tr></thead><tbody></tbody></table></div>`);
  barStart(); specStart('wspr');
  $('.dw-clear').onclick = () => { $('tbody').innerHTML = ''; $('.dw-count').textContent = '0'; };
}
function wsprFeed(pcm) {
  const pos = wspr2SlotPosition();
  if (!cap.on && pos < 2) { cap.on = true; cap.len = 0; cap.t0 = Date.now() - pos * 1000; specReset(); }
  if (!cap.on) return;
  specFeed(pcm);
  capPush(pcm);
  if (pos >= 119 && pos < 120) {
    cap.on = false;
    if (cap.len < WSPR_TOTAL_SAMPLES) { status(`Slot incomplete (joined late) — next one in ${Math.ceil(120 - pos)} s`); cap.len = 0; return; }
    const pcmSlot = cap.buf.slice(0, cap.len), t0 = cap.t0, dial = dialKHz() * 1000;
    cap.len = 0; cap.busy++; status('Decoding…');
    decodeInWorker('wspr', pcmSlot, { dialFreqHz: dial }).then((res) => {
      if (st.on !== 'wspr') return;
      status(`${utcHM(t0).slice(0, 5)} UTC: ${res.length} spot(s)`);
      specMarks(res.map((r) => Number.isFinite(r.audioHz) ? r.audioHz : (dial ? r.freq - dial : r.freq)));
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
    ${SCHED_HTML}<canvas width="${FAX_W}" height="${FAX_H}" style="width:464px;height:${Math.round(FAX_H * 464 / FAX_W)}px"></canvas>`);
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
    schedName = s.name; schedTick();
  };
  schedStart('fax');
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
function textWindow(title, extra, below) {
  openWindow(`<div class="dw-head"><span class="dw-title">${title}</span>${extra}<button type="button" class="dw-clear">Clear</button></div>${below || ''}<div class="dw-text"></div><div class="dw-list dw-pb" hidden></div>`);
  $('.dw-clear').onclick = () => {
    $('.dw-text').textContent = ''; browserArchive = []; browserCh = []; browserRows = new Map();
    const pb = $('.dw-pb'); if (pb) { pb.innerHTML = ''; pskBrowserShow(); }
  };
  browserArchive = []; browserCh = []; browserRows = new Map();
}
function textOut(t) {
  const box = $('.dw-text'); if (!box) return;
  const end = atEnd(box), last = box.lastChild;
  if (last && last.nodeType === 3 && last.data.length < 2000) last.appendData(t); else box.appendChild(document.createTextNode(t));
  while (box.textContent.length > 12000 && box.firstChild) box.removeChild(box.firstChild);
  if (end) scrollEnd(box);
}
function navtexWindow() {
  textWindow('NAVTEX decoder', `<select class="dw-tune dec-sel"><option value="">Station…</option>${NAVTEX_STATIONS.map(([n, f]) => `<option value="${f}">${n}</option>`).join('')}</select>`, SCHED_HTML);
  fsk = new FSKWorkerProxy({ role: 'navtex', sampleRate: SR, callback: (ev) => {
    if (!ev || st.on !== 'navtex') return;
    if (ev.type === 'char') { if (ev.char !== '\r') textOut(ev.char); }
    else if (ev.type === 'navstart') textOut(ev.headerless ? '\n━━ (header missed) ━━\n' : `\n━━ ZCZC ${ev.station}${ev.subject}${ev.seq} ━━\n`);
    else if (ev.type === 'navend') { if (ev.reason === 'lost') textOut('\n━━ (signal lost) ━━\n\n'); else if (ev.reason !== 'next') textOut('\n━━ NNNN ━━\n\n'); }
    else if (ev.type === 'status') status(ev.text);
  } });
  fsk.setEnabled(true);
  $('.dw-tune').onchange = (e) => { const f = +e.target.value; if (f) { tuneKHz(f - 0.5); applyFilter('navtex'); picked(f - 0.5); schedTick(); } };
  schedStart('navtex');
  status('Listening (100 Bd, 170 Hz shift, centre 500 Hz)…');
}
// SERVICES Maritime FSK / SITOR (PhantomSDR-Plus FSK_VARIANT_PRESETS.maritime): the raw
// SITOR-B text, no NAVTEX framing; the NAVTEX timetable of the channel when there is one
function maritimeWindow() {
  textWindow('Maritime FSK / SITOR', `${serviceSelect('maritime')}<select class="dw-tune dec-sel"><option value="">Frequency…</option>${MARITIME_FREQS.map(([n, f]) => `<option value="${f}">${n}</option>`).join('')}</select>`, SCHED_HTML);
  fsk = new FSKWorkerProxy({ role: 'fsk', variant: 'maritime', sampleRate: SR, callback: (ev) => {
    if (!ev || st.on !== 'maritime') return;
    if (ev.type === 'char') { if (ev.char && ev.char !== '\r') textOut(ev.char); }
    else if (ev.type === 'status') status(ev.text || '');
  } });
  fsk.setVariant('maritime');
  fsk.setConfig({ center: 500, shift: 170, baud: 100, framing: '7N1', encoding: 'ccir476', inverted: false });
  fsk.setEnabled(true);
  svcWire();
  $('.dw-tune').onchange = (e) => { const f = +e.target.value; if (f) { tuneKHz(f - 0.5); applyFilter('maritime'); picked(f - 0.5); schedTick(); } };
  schedStart('navtex');
  status('Listening (100 Bd, 170 Hz shift, centre 500 Hz)…');
}
const RTTY = { ham: { center: 1000, shift: 170, baud: 45.45 }, weather: { center: 1000, shift: 450, baud: 50 } };
let rttyShift = 0;            // a listed frequency's own shift, Hz (DDH47); 0 = the mode's
// Amateur RTTY is FLDIGI's 'rtty', DWD Weather RTTY SERVICES' 'weather' (same window)
function rttyVariant() { return st.on === 'weather' ? 'weather' : 'ham'; }
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
  fsk.setConfig({ center: r.center, shift: rttyShift || r.shift, baud: r.baud, framing: '5N1.5', encoding: 'ita2',
                  inverted: v === 'weather', squelch: rttySquelch() });
}
function rttyWindow(k) {
  const v = k === 'weather' ? 'weather' : 'ham';
  rttyShift = 0;
  textWindow(v === 'weather' ? 'Weather RTTY decoder' : 'RTTY decoder', `${v === 'weather' ? serviceSelect('weather') : familySelect(v)}
    <select class="dw-tune dec-sel">${rttyFreqOptions(v)}</select>
    <label class="dw-sqbox" title="Squelch (SNR): print only while the signal is at least this far above the noise. Noise reads −12 to −15 dB; RTTY stays readable down to about −4 dB. Far left turns it off.">Squelch
      <input type="range" class="dw-sq" min="${FSK_SQ_OFF}" max="10" step="1"> <b class="dw-sqv"></b></label><span class="dw-met"></span>`, SCHED_HTML);
  fsk = new FSKWorkerProxy({ role: 'fsk', variant: v, sampleRate: SR, callback: (ev) => {
    if (!ev || st.on !== k) return;
    if (ev.type === 'char') { if (ev.char && ev.char !== '\r') textOut(ev.char); }
    else if (ev.type === 'status') status(ev.text || '');
    else if (ev.type === 'metrics') { const m = $('.dw-met'); if (m) m.textContent = Number.isFinite(ev.snrDb) ? `SNR ${ev.snrDb.toFixed(0)} dB` : ''; }
  } });
  fsk.setVariant(v); rttySquelchShow(); rttySend(); fsk.setEnabled(true);
  if (v === 'weather') svcWire();
  else { const vs = $('.dw-var'); vs.onchange = () => familyChange(vs.value); }
  $('.dw-sq').oninput = () => { lsSet('ubersdr_rttysq_' + rttyVariant(), $('.dw-sq').value); rttySquelchShow(); rttySend(); };
  $('.dw-tune').onchange = (e) => {
    const f = +e.target.value; if (!f) return;
    const it = RTTY_FREQS[rttyVariant()].find((x) => x[1] === f);
    rttyShift = (it && it[2]) || 0; rttySend();
    const d = f - RTTY[rttyVariant()].center / 1000; tuneKHz(d); applyFilter(k); picked(d);
    schedTick();
  };
  schedStart('rtty');
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
  textWindow(title, `${familySelect(k)}<select class="dw-tune dec-sel"><option value="">Frequency…</option>${list.map(([n, f]) => `<option value="${f}">${n}</option>`).join('')}</select>${extra}<span class="dw-met"></span>` +
    `<button type="button" class="dw-save" title="Save the decoded text (in a browser: one line per signal)">Save</button>`);
  $('.dw-save').onclick = () => browsing() || browserArchive.length
    ? saveText(k === 'olivia' ? (oliviaMode().c ? 'contestia-browser' : 'olivia-browser') : 'psk-browser', browserSaveLines())
    : saveText(k === 'olivia' ? (oliviaMode().c ? 'contestia' : 'olivia') : pskMode().key, [$('.dw-text').textContent]);
  fsk = new FSKWorkerProxy({ role: 'fsk', variant: k, sampleRate: SR, callback: (ev) => {
    if (!ev || st.on !== k) return;
    if (ev.type === 'char') { if (ev.char && ev.char !== '\r') textOut(ev.char); }
    else if (ev.type === 'status') { status(ev.text || ''); if (k === 'psk31') pskAutoResult(ev.text || ''); }
    else if (ev.type === 'browser') pskBrowserRows(ev.channels || []);
    else if (ev.type === 'metrics') digiMetrics(ev);
  } });
  $('.dw-var').onchange = (e) => familyChange(e.target.value);
  $('.dw-tune').onchange = (e) => {
    const f = +e.target.value; if (!f) return;
    if (k === 'olivia') {                          // the list names the set-up: use it
      const m = /\((\d+)\/(\d+)\)/.exec(e.target.selectedOptions[0].text), i = m ? OLIVIA_MODES.findIndex((o) => !o.c && o.t === +m[1] && o.b === +m[2]) : -1;
      if (i >= 0) { $('.dw-omode').value = String(i); $('.dw-omode').onchange(); }
    }
    tuneKHz(f - 1); applyFilter(k); picked(f - 1);
  };
}
// PSK sub-mode (PhantomSDR-Plus 5.5.0 psk31.js PSK_MODES): BPSK or QPSK at 31.25, 62.5 or 125 Bd
function pskMode() { return pskModeCfg(lsGet('ubersdr_pskmode', 'bpsk31')); }
function pskSend() { if (fsk) fsk.setConfig({ center: 1000, encoding: 'varicode', pskMode: pskMode().key }); }
function psk31Window() {
  const pm = pskMode();
  digiWindow('psk31', pm.label + (pm.browser ? '' : ' decoder'),
    PSK31_FREQS, `<label title="PSK speed and type: must match the signal (QPSK uses fldigi's FEC)">Mode <select class="dw-pmode dec-sel">${PSK_MODES.map((m) =>
      `<option value="${m.key}"${m.key === pm.key ? ' selected' : ''}>${m.label}</option>`).join('')}</select></label>` +
    `<button type="button" class="dw-auto" title="Find the strongest PSK carrier in the filter and lock on it">Auto-tune</button>`);
  fsk.setVariant('psk31'); pskSend(); fsk.setEnabled(true);
  $('.dw-pmode').onchange = (e) => {
    if (pskMode().browser && e.target.value !== 'browser') browserArchiveAll();
    lsSet('ubersdr_pskmode', e.target.value); pskSend(); applyFilter('psk31'); lightPresets(); showDial();
    const t = $('.dw-title'); if (t) t.textContent = pskMode().label + (pskMode().browser ? '' : ' decoder');
    pskBrowserShow();
  };
  pskBrowserShow();
  $('.dw-auto').onclick = pskAutoTune;
  status(`Click a ${pm.label} trace on the waterfall, or pick a frequency; the decoder locks within ±${Math.round(0.8 * pm.baud)} Hz.`);
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
    if (k === 'psk31') pskSend(); else modemSend();
  }
  applyFilter(k);
  status(hz ? `Auto-tune: signal found ${hz - target >= 0 ? '+' : ''}${hz - target} Hz away, now at ${target} Hz` : 'Auto-tune: no signal found');
}
// Olivia Browser (PhantomSDR-Plus oliviaBrowser.js): every signal of the chosen set-up between
// 300 and 2700 Hz, one line each (shown like the PSK Browser); off whenever the window opens
let oliviaBrowse = false, oliviaSend = null;
function oliviaWindow() {
  const sq = parseFloat(lsGet('ubersdr_oliviasq', '4')) || 4;
  digiWindow('olivia', 'Olivia decoder', OLIVIA_FREQS,
    `<label title="Olivia or Contestia, tones / bandwidth: must match the transmission">Mode <select class="dw-omode dec-sel">` +
    ['Olivia', 'Contestia'].map((g, gi) => `<optgroup label="${g}">${OLIVIA_MODES.map((o, i) => !!o.c === !!gi ? `<option value="${i}">${gi ? 'Contestia ' : ''}${o.label}</option>` : '').join('')}</optgroup>`).join('') +
    `</select></label>` +
    `<label title="Decode every signal of this Mode between 300 and 2700 Hz at once, one line each"><input type="checkbox" class="dw-obr"> Browser</label>` +
    `<label class="dw-sqbox" title="Squelch (FEC S/N): print only blocks that reach this. Below 3.5 noise starts printing; a good signal reads 8–9.">Squelch <input type="range" class="dw-osq" min="3" max="15" step="0.5" value="${sq}"> <b class="dw-sqv">${sq.toFixed(1)}</b></label>`);
  oliviaBrowse = false;
  const ms = $('.dw-omode'), qs = $('.dw-osq'), br = $('.dw-obr');
  ms.value = String(OLIVIA_MODES.indexOf(oliviaMode()));
  const send = () => {
    const o = oliviaMode();
    br.checked = oliviaBrowse;
    fsk.setConfig({ center: oliviaBrowse ? 1500 : 1000, encoding: 'olivia', tones: o.t, bandwidth: o.b, contestia: !!o.c, syncThreshold: +qs.value || 4, browse: oliviaBrowse });
    const t = $('.dw-title'); if (t) t.textContent = `${o.c ? 'Contestia' : 'Olivia'} ${oliviaBrowse ? `Browser (${o.label})` : 'decoder'}`;
    status(oliviaBrowse ? `Listening for ${o.c ? 'Contestia' : 'Olivia'} ${o.label} signals between 300 and 2700 Hz…`
                        : `Looking for ${o.c ? 'Contestia' : 'Olivia'} ${o.label} (no preamble: allow a few seconds for sync)…`);
    pskBrowserShow();
  };
  oliviaSend = send;
  br.onchange = () => { if (!br.checked) browserArchiveAll(); oliviaBrowse = br.checked; browserCh = []; browserRows = new Map(); const pb = $('.dw-pb'); if (pb) pb.innerHTML = ''; send(); applyFilter('olivia'); lightPresets(); showDial(); };
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
  textWindow(v === 'aprs' ? 'APRS decoder' : 'Packet (AX.25) decoder', `${familySelect(v)}<select class="dw-tune dec-sel"><option value="">Frequency…</option>${PACKET_DIALS.map(([n, f]) => `<option value="${f}">${n}</option>`).join('')}</select><span class="dw-met"></span>`);
  $('.dw-var').onchange = (e) => familyChange(e.target.value);
  $('.dw-tune').onchange = (e) => { const f = +e.target.value; if (f) { tuneKHz(f); applyFilter('packet'); picked(f); } };
  fsk = new FSKWorkerProxy({ role: 'fsk', variant: v, sampleRate: SR, callback: (ev) => {
    if (!ev || st.on !== 'packet') return;
    if (ev.type === 'line') textOut((ev.text || '') + '\n');
    else if (ev.type === 'status') status(ev.text || '');
    else if (ev.type === 'metrics') { const m = $('.dw-met'); if (m && Number.isFinite(ev.framesOk)) m.textContent = `${ev.framesOk} frame(s)` + (Number.isFinite(ev.stations) ? ` · ${ev.stations} station(s)` : ''); }
  } });
  fsk.setVariant(v); fsk.setConfig({ encoding: 'ax25', baud: 300, center: 1700, showRaw: true }); fsk.setEnabled(true);
  status('300 Bd HF packet, tones 1600/1800 Hz: click the signal on the waterfall to centre it. Only frames with a correct checksum are printed.');
}

// ── HFDL (PhantomSDR-Plus hfdl.worker.js: dumphfdl in WebAssembly) ─────────────────
// The listed frequency is the USB dial; dumphfdl finds the 1440 Hz subcarrier itself.
// Rows as PhantomSDR-Plus's HfdlPanel (summarize): time, kHz, SNR, ground station,
// aircraft, kind and the ACARS text; squitters (ground-station beacons) hidden unless asked.
let hfdl = null, hfdlDial = 0, hfdlSq = 0, hfdlMap = null, hfdlSmallOn = false, hfdlBigEl = null;
const NO_POS = 'No position received yet: only some messages (position reports, performance data) carry one.';
function hfdlMapCount(n) {
  const b = $('.dw-map'); if (b) b.textContent = `🗺 Map (${n})`;
  if (hfdlBigEl) {
    hfdlBigEl.querySelector('.hfdl-big-title').textContent = `HFDL — aircraft map (${n})`;
    const note = hfdlBigEl.querySelector('.hfdl-big-note');
    if (!note.classList.contains('err')) note.textContent = n ? '' : NO_POS;
  }
  const sn = $('.hf-mapnote'); if (sn && !sn.classList.contains('err')) sn.textContent = n ? '' : NO_POS;
}
function hfdlSmall(on) {
  const box = $('.hf-mapbox'), btn = $('.dw-map');
  if (!box || !hfdlMap) return;
  hfdlSmallOn = on; box.style.display = on ? '' : 'none'; if (btn) btn.classList.toggle('on', on);
  if (!on) { hfdlMap.close(); return; }
  const note = $('.hf-mapnote'); note.classList.remove('err');
  hfdlMap.open($('.hf-map')).then(() => { hfdlMap.fitAll(); hfdlMapCount(hfdlMap.count); },
    (e) => { note.classList.add('err'); note.textContent = 'Map unavailable: ' + (e && e.message ? e.message : e); });
}
// Large map: a floating window on <body>, dragged by its title bar, resized at its corner
function hfdlBigOpen() {
  if (hfdlBigEl || !hfdlMap) return;
  const w = hfdlBigEl = document.createElement('div');
  w.className = 'hfdl-big'; w.setAttribute('role', 'dialog'); w.setAttribute('aria-label', 'HFDL map');
  w.style.visibility = 'hidden';
  w.innerHTML = '<div class="hfdl-big-head" title="Drag to move the window"><span class="hfdl-grip" aria-hidden="true">⠿</span>' +
    '<span class="hfdl-big-title">HFDL — aircraft map (0)</span><span style="flex:1"></span>' +
    '<button type="button" class="hfdl-big-btn hb-fit" title="Fit all aircraft">⌖ Fit all</button>' +
    '<button type="button" class="hfdl-big-btn hb-x" title="Close" aria-label="Close">✕</button></div>' +
    '<div class="hfdl-big-map aprs-map"></div><div class="hfdl-big-note"></div>';
  document.body.appendChild(w);
  const bx = Math.max(8, (window.innerWidth - w.offsetWidth) / 2), by = Math.max(8, (window.innerHeight - w.offsetHeight) / 2);
  w.style.left = bx + 'px'; w.style.top = by + 'px'; w.style.visibility = '';
  const head = w.querySelector('.hfdl-big-head');
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    drag = { x: e.clientX - w.offsetLeft, y: e.clientY - w.offsetTop };
    head.setPointerCapture(e.pointerId); head.classList.add('dragging');
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    w.style.left = Math.min(Math.max(e.clientX - drag.x, 40 - w.offsetWidth), window.innerWidth - 40) + 'px';
    w.style.top = Math.min(Math.max(e.clientY - drag.y, 0), window.innerHeight - 36) + 'px';
  });
  const up = () => { drag = null; head.classList.remove('dragging'); };
  head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
  w.querySelector('.hb-fit').onclick = () => hfdlMap.fitAll();
  w.querySelector('.hb-x').onclick = hfdlBigClose;
  const note = w.querySelector('.hfdl-big-note');
  hfdlMap.open(w.querySelector('.hfdl-big-map')).then(() => { hfdlMap.fitAll(); hfdlMapCount(hfdlMap.count); },
    (e) => { note.classList.add('err'); note.textContent = 'Map unavailable: ' + (e && e.message ? e.message : e); });
  w._ro = new ResizeObserver(() => hfdlMap && hfdlMap.invalidate());
  w._ro.observe(w.querySelector('.hfdl-big-map'));
  const b = $('.dw-big'); if (b) b.classList.add('on');
}
function hfdlBigClose() {
  if (!hfdlBigEl) return;
  try { hfdlBigEl._ro.disconnect(); } catch (e) {}
  if (hfdlMap) hfdlMap.close();
  hfdlBigEl.remove(); hfdlBigEl = null;
  const b = $('.dw-big'); if (b) b.classList.remove('on');
}
document.addEventListener('keydown', (e) => { if (hfdlBigEl && e.key === 'Escape') hfdlBigClose(); });
const HFDL_BY_ID = new Map(HFDL_STATIONS.map((s) => [s.id, s]));
const HFDL_SORTED = [...HFDL_STATIONS].sort((a, b) => a.name.localeCompare(b.name));
function hfdlFind(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) { const r = hfdlFind(v, key, depth + 1); if (r !== undefined) return r; }
  return undefined;
}
function hfdlEntity(e) {
  if (!e) return '';
  if (e.type === 'Ground station') { const s = HFDL_BY_ID.get(e.id); return e.name || (s ? s.name : `GS ${e.id}`); }
  if (e.type === 'Aircraft') return `AC ${e.id}`;
  return e.name || `${e.type || '?'} ${e.id ?? ''}`.trim();
}
function hfdlRow(msg) {
  const h = (msg && msg.hfdl) || {}, pdu = h.lpdu || h.spdu || {}, squitter = !!h.spdu && !h.lpdu;
  const t = h.t && h.t.sec ? h.t.sec * 1000 : Date.now();
  const src = pdu.src, dst = pdu.dst, uplink = src && src.type === 'Ground station';
  const gs = uplink ? src : dst && dst.type === 'Ground station' ? dst : src;
  const acars = hfdlFind(pdu, 'acars'), icao = hfdlFind(pdu, 'icao'), flightId = hfdlFind(pdu, 'flight_id');
  const hfnpdu = pdu.hfnpdu;
  const kind = squitter ? 'Squitter' : (acars && 'ACARS') || (hfnpdu && hfnpdu.type && hfnpdu.type.name) || (pdu.type && pdu.type.name) || 'LPDU';
  const reg = acars && acars.reg ? String(acars.reg).replace(/^\.+/, '').trim() : '';
  const flt = String((acars && acars.flight) || (flightId ? String(flightId) : '')).trim();
  const ac = [reg, flt, icao ? String(icao).toUpperCase() : ''].filter(Boolean).join(' · ') || (uplink ? hfdlEntity(dst) : hfdlEntity(src));
  const snr = Number.isFinite(h.sig_level) && Number.isFinite(h.noise_level) ? (h.sig_level - h.noise_level).toFixed(0) : '';
  const fa = flt ? `https://www.flightaware.com/live/flight/${encodeURIComponent(flt.replace(/[^A-Za-z0-9]/g, '').replace(/^([A-Za-z]{2,3})0+(\d)/, '$1$2'))}` : '';
  const text = [acars && acars.label ? `[${acars.label}]` : '', acars && acars.msg_text ? String(acars.msg_text).trim() : ''].filter(Boolean).join(' ');
  const p = hfdlFind(pdu, 'pos');
  const pos = p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 &&
    !(p.lat === 0 && p.lon === 0) ? { lat: p.lat, lon: p.lon } : null;
  const acName = uplink ? hfdlEntity(dst) : hfdlEntity(src);
  const posLink = pos ? ` <a href="https://www.openstreetmap.org/?mlat=${pos.lat.toFixed(4)}&mlon=${pos.lon.toFixed(4)}#map=6/${pos.lat.toFixed(3)}/${pos.lon.toFixed(3)}" target="_blank" rel="noopener" title="Show the aircraft position on a map">📍 ${pos.lat.toFixed(2)}, ${pos.lon.toFixed(2)}</a>` : '';
  const plane = pos ? { call: [reg, flt, icao ? String(icao).toUpperCase() : ''].filter(Boolean)[0] || acName || 'Aircraft',
    lat: pos.lat, lon: pos.lon, time: Date.now(), link: fa, linkText: 'FlightAware',
    text: [utcHM(t) + ' UTC', hfdlEntity(gs), kind, acars && acars.msg_text ? String(acars.msg_text).trim() : ''].filter(Boolean).join(' · ') } : null;
  return { squitter, plane, html: `<tr class="${squitter ? 'hf-sq' : ''}"${squitter && !hfdlSq ? ' style="display:none"' : ''}><td>${utcHM(t)}</td><td class="n">${h.freq ? (h.freq / 1000).toFixed(1) : ''}</td>` +
    `<td class="n">${snr}</td><td>${esc((uplink ? '↓ ' : '↑ ') + hfdlEntity(gs))}</td><td class="c">${fa ? `<a href="${fa}" target="_blank" rel="noopener" title="This flight on FlightAware">${esc(ac)}</a>` : esc(ac)}</td>` +
    `<td>${esc(kind)}</td><td class="m">${esc(text)}${posLink}</td></tr>` };
}
function hfdlFreqOptions(id) {
  const s = HFDL_BY_ID.get(+id); if (!s) return '<option value="">Frequency…</option>';
  const f = dialKHz(), best = [...s.freqs].sort((a, b) => Math.abs(a - f) - Math.abs(b - f))[0];
  return [...s.freqs].sort((a, b) => b - a).map((x) => `<option value="${x}"${x === best ? ' selected' : ''}>${x.toFixed(1)} kHz</option>`).join('');
}
function hfdlWindow() {
  const f = dialKHz(), here = HFDL_STATIONS.find((s) => s.freqs.some((x) => Math.abs(x - f) < 0.05));
  const cur = here ? here.id : +lsGet('ubersdr_hfdl_gs', HFDL_SORTED[0].id) || HFDL_SORTED[0].id;
  hfdlSq = +lsGet('ubersdr_hfdl_sq', '0') ? 1 : 0;
  openWindow(`<div class="dw-head">${serviceSelect('hfdl')}<span class="dw-title">HFDL decoder</span>` +
    `<select class="dw-gs dec-sel" title="HFDL ground station">${HFDL_SORTED.map((s) => `<option value="${s.id}"${s.id === cur ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>` +
    `<select class="dw-fq dec-sel" title="Its frequencies (the USB dial)">${hfdlFreqOptions(cur)}</select><button type="button" class="dw-go" title="Tune to this frequency (USB)">Tune</button>` +
    `<label title="Also show the ground stations' squitters (beacons)"><input type="checkbox" class="dw-sq"${hfdlSq ? ' checked' : ''}> Squitters</label>` +
    `<button type="button" class="dw-map" title="Show the map of aircraft that reported a position">🗺 Map (0)</button>` +
    `<button type="button" class="dw-big" title="Open the aircraft map in a large draggable, resizable window">⤢ Large map</button>` +
    `<button type="button" class="dw-save" title="Save the decoded messages (text)">Save</button><button type="button" class="dw-clear">Clear</button></div>` +
    `<div class="hf-mapbox" style="display:none"><div class="hf-map aprs-map"></div><div class="hf-mapnote"></div></div>` +
    `<div class="dw-list"><table><thead><tr><th>UTC</th><th>kHz</th><th>SNR</th><th>Ground station</th><th>Aircraft</th><th>Type</th><th>Message</th></tr></thead><tbody></tbody></table></div>`);
  const texts = [];
  svcWire();
  $('.dw-gs').onchange = (e) => { lsSet('ubersdr_hfdl_gs', e.target.value); $('.dw-fq').innerHTML = hfdlFreqOptions(e.target.value); };
  $('.dw-go').onclick = () => { const k = +$('.dw-fq').value; if (k) { tuneKHz(k); applyFilter('hfdl'); if (hfdl) { hfdl.setDial(k * 1000); hfdl.reset(); } } };
  $('.dw-sq').onchange = (e) => {
    hfdlSq = e.target.checked ? 1 : 0; lsSet('ubersdr_hfdl_sq', String(hfdlSq));
    st.win.querySelectorAll('tr.hf-sq').forEach((r) => { r.style.display = hfdlSq ? '' : 'none'; });
  };
  $('.dw-clear').onclick = () => { $('.dw-list tbody').innerHTML = ''; texts.length = 0; hfdlMap.clear(); };
  // Aircraft map (PhantomSDR-Plus lib/aprsMap.js with plane icons): positions are kept
  // even while the map is closed; small map in the window or a large floating one
  hfdlMap = new AprsMap(W.STATION && W.STATION.locator || '');
  hfdlMap.planeIcons = true;
  hfdlMap.onChange = hfdlMapCount;
  $('.dw-map').onclick = () => { hfdlBigClose(); hfdlSmall(!hfdlSmallOn); };
  $('.dw-big').onclick = () => { if (hfdlBigEl) hfdlBigClose(); else { hfdlSmall(false); hfdlBigOpen(); } };
  $('.dw-save').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([texts.join('\n')], { type: 'text/plain;charset=utf-8' }));
    a.download = `hfdl_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}Z.txt`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  hfdlDial = Math.round(dialKHz() * 1000);
  hfdl = new HFDLWorkerProxy({ sampleRate: SR, callback: (ev) => {
    if (!ev || st.on !== 'hfdl') return;
    if (ev.type === 'ready') status('Waiting for a frame… (USB, subcarrier at 1440 Hz)');
    else if (ev.type === 'error') status('HFDL decoder unavailable: ' + (ev.message || 'error'));
    else if (ev.type === 'stats') status(`${ev.state > 1 ? 'Frame in progress' : 'Waiting for a frame'} · noise ${Number.isFinite(ev.noiseDb) ? ev.noiseDb.toFixed(1) + ' dB' : '–'} · ${ev.frames || 0} frame(s)` +
      (HFDL_STATIONS.some((s) => s.freqs.some((x) => Math.abs(x - dialKHz()) < 0.05)) ? '' : ' · not on an HFDL frequency'));
    else if (ev.type === 'msg') {
      const box = $('.dw-list'), body = $('.dw-list tbody'); if (!body) return;
      const end = atEnd(box), r = hfdlRow(ev.msg);
      body.insertAdjacentHTML('beforeend', r.html);
      while (body.rows.length > 300) body.deleteRow(0);
      texts.push(ev.text || ''); if (texts.length > 300) texts.shift();
      if (r.plane && hfdlMap) hfdlMap.add(r.plane);
      if (end) scrollEnd(box);
    }
  } });
  hfdl.setDial(hfdlDial);
  hfdl.setEnabled(true);
  status('Loading the HFDL decoder…');
}

// ── Start / stop / follow ───────────────────────────────────────────────────────
// A decoder's sideband and filter: [sb, lo, hi], kHz of audio
function decFilter(k) {
  const d = DEC[k];
  if (k === 'rtty' && rttyKey() !== 'rtty') return decFilter(rttyKey());
  if (k === 'rtty' || k === 'weather') {
    const r = RTTY[k === 'weather' ? 'weather' : 'ham'], hw = ((st.on === k && rttyShift) || r.shift) / 2 + 1.43 * r.baud;
    return ['usb', (r.center - hw) / 1000, (r.center + hw) / 1000];
  }
  if (k === 'sstv') return [sstvSideband(dialKHz()), d.lo, d.hi];
  if (k === 'services') return decFilter(svcKey());
  if (k === 'ale' || k === 'aleu') return [aleLsb ? 'lsb' : 'usb', 0.5, 2.75];       // as PhantomSDR-Plus, mirrored on LSB nets
  if (k === 'fst4w') { const hw = (fst4w.tol + 150) / 1000; return ['usb', +(1.5 - hw).toFixed(3), +(1.5 + hw).toFixed(3)]; }
  if (k === 'msk144') { const hw = (1100 + msk.tol) / 1000; return ['usb', Math.max(0.05, +(1.5 - hw).toFixed(3)), +(1.5 + hw).toFixed(3)]; }
  if (k === 'psk31' && pskMode().browser) return ['usb', 0.3, 2.7];
  if (k === 'psk31') { const hw = Math.round(3.2 * pskMode().baud) / 1000; return ['usb', 1 - hw, 1 + hw]; }   // ±3.2 baud: BPSK31 ±100 Hz
  if (k === 'olivia' && oliviaBrowse) return ['usb', 0.2, 2.8];      // 1500 Hz ± 1300 Hz, as PhantomSDR-Plus
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
  if (k === 'rtty') return 'Filter preset (FLDIGI window): USB, around the mode\'s audio centre; the width follows the mode chosen in the FLDIGI window (RTTY 300 Hz, PSK31 200 Hz, Olivia and the fldigi modems their bandwidth plus a margin, Packet 800 Hz)';
  if (k === 'psk31') { const [, lo, hi] = decFilter('psk31'); return `Filter preset (${pskMode().label}): ${lo.toFixed(2)}–${hi.toFixed(2)} kHz, ${Math.round((hi - lo) * 1000)} Hz, USB (the signal at 1000 Hz)`; }
  if (k === 'services') {                       // the service last chosen in the SERVICES window
    const v = svcKey(), [, lo, hi] = decFilter(v), bw = Math.round((hi - lo) * 1000);
    return `Filter preset (SERVICES — ${DEC[v].label}): ${lo.toFixed(2)}–${hi.toFixed(2)} kHz, ${bw >= 1000 ? (bw / 1000).toFixed(2) + ' kHz' : bw + ' Hz'}, USB`;
  }
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
// Name of the running decoder for the frame under the S-meter (compat digiLabel); FLDIGI
// shows the mode picked in its list. '' when none runs.
const FLDIGI_SHORT = { ham: 'RTTY', weather: 'RTTY', psk31: 'PSK31', olivia: 'OLIVIA', mfsk: 'MFSK',
  dominoex: 'DOMINOEX', thor: 'THOR', throb: 'THROB', hell: 'HELL', mt63: 'MT63', packet: 'PACKET', aprs: 'APRS',
  ale: 'ALE', fst4w: 'FST4W', msk144: 'MSK144' };
W.ubersdr_dec_label = () => {
  if (!st.on) return '';
  const d = DEC[st.on];
  if (st.on === 'psk31') return pskMode().browser ? 'PSK BROWSER' : pskMode().label;
  if (st.on === 'olivia') return oliviaMode().c ? 'CONTESTIA' : 'OLIVIA';
  if (st.on === 'rtty' || (d && d.family === 'rtty')) return FLDIGI_SHORT[lsGet('ubersdr_rtty', 'ham')] || 'FLDIGI';
  return d ? d.label : '';
};
function start(k, opts) {
  stop(true);
  if (W.ubersdr_rade_active && W.ubersdr_rade_active() && W.ubersdr_rade_stop) W.ubersdr_rade_stop();
  const d = DEC[k];
  if (k === 'psk31' || k === 'olivia' || k === 'ale' || k === 'fst4w' || k === 'msk144') lsSet('ubersdr_rtty', k);
  if (d.family === 'services') lsSet('ubersdr_service', k);
  else if (k === 'rtty' && rttyKey() !== 'rtty') lsSet('ubersdr_rtty', 'ham');
  st.on = k; capReset(); lightButtons();
  lastBand = ''; pickedDial = 0; schedName = '';
  idOff();
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
  else if (k === 'rtty' || k === 'weather') rttyWindow(k);
  else if (k === 'maritime') maritimeWindow();
  else if (k === 'psk31') psk31Window();
  else if (k === 'olivia') oliviaWindow();
  else if (k === 'modem') modemWindow();
  else if (k === 'packet') packetWindow();
  else if (k === 'hfdl') hfdlWindow();
  else if (k === 'dsc' || k === 'selcall') dscWindow(k);
  else if (k === 'time') timeWindow();
  else if (k === 'ale' || k === 'aleu') aleWindow(k);
  else if (k === 'fst4w') wsjtWindow('fst4w');
  else if (k === 'msk144') wsjtWindow('msk144');
}
function stop(quiet) {
  if (!st.on) return;
  st.on = null; capReset(); showDial();
  if (pskAuto) { clearTimeout(pskAuto.timer); pskAuto = null; }
  for (const p of pending.values()) p.reject(new Error('stopped')); pending.clear();
  if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
  hfdlBigClose(); if (hfdlMap) { hfdlMap.close(); hfdlMap = null; } hfdlSmallOn = false;
  for (const x of [sstv, fax, fsk, hfdl, svc]) if (x) { try { x.destroy(); } catch (e) {} }
  sstv = fax = fsk = hfdl = svc = null; js8.re = null; hellCtx = null;
  barStop(); closeWindow(); lightButtons(); pickedDial = 0; svcInfo = null;
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

// ── Broadcast schedules (PhantomSDR-Plus 5.5.0, psdr/broadcastSchedules.js) ──────────
// FAX: the timetable of the station picked in the list (else of a listed station the dial
// is on); NAVTEX: every station on the channel, its 10-minute slots; DWD weather RTTY: the
// programme of the picked frequency (Programme 1 when none). "ON AIR" stays at the top
// while a slot runs; amber = within 3 minutes, red = within 30 s. Updated every second.
const SCHED_HTML = '<div class="dw-sched" hidden><div class="dw-sched-h"></div><div class="dw-sched-b"></div></div>';
let schedKind = '', schedName = '', schedTimer = null;
function schedStart(kind) { schedStop(); schedKind = kind; schedTick(); schedTimer = setInterval(schedTick, 1000); }
function schedStop() { if (schedTimer) clearInterval(schedTimer); schedTimer = null; schedKind = ''; }
function nowSecUTC() { const d = new Date(); return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(); }
function schedFaxName() {
  if (schedName) return schedName;
  const sig = dialKHz() + 1.9;                       // FAX: the station's frequency = dial + 1.9 kHz
  const s = FAX_STATIONS.find((x) => x.freqs.some((f) => Math.abs(f - sig) < 0.05));
  return s ? s.name : '';
}
function schedNavtexKhz() {
  const sig = dialKHz() + 0.5;                       // NAVTEX: dial + 0.5 kHz
  const f = [...new Set(NAVTEX_DB.map((x) => x.freq))].find((k) => Math.abs(k - sig) < 0.05);
  return f || 0;
}
function schedTick() {
  const box = $('.dw-sched'); if (!box || !schedKind) return;
  const now = nowSecUTC();
  let title = '', rows = [], navtex = false;
  if (schedKind === 'fax') {
    const n = schedFaxName(), sch = n && FAX_SCHEDULE[n];
    if (sch && sch.length) { title = 'Next transmissions · UTC · ' + n; rows = scheduleRows(parseSlots(sch), now, { maxDur: 12 * 60, limit: 4 }); }
  } else if (schedKind === 'navtex') {
    const khz = schedNavtexKhz(), stats = khz ? NAVTEX_DB.filter((x) => x.freq === khz) : [];
    if (stats.length) {
      const slots = [];
      for (const x of stats) for (const sec of navtexSlots(x)) slots.push({ sec, id: x.id, flag: x.flag, name: x.name, area: x.area });
      title = `Next broadcasts · UTC · ${khz} kHz`; navtex = true;
      rows = scheduleRows(slots, now, { maxDur: 10 * 60, limit: 48 });   // the next 48 (518 kHz has ~860 a day)
    }
  } else if (schedKind === 'rtty' && rttyVariant() === 'weather') {
    const khz = pickedDial ? +(pickedDial + RTTY.weather.center / 1000).toFixed(1) : 0;
    const prog = RTTY_PROGRAMME_BY_KHZ[String(khz)] || 'DWD Programme 1';
    title = 'Next transmissions · UTC · ' + prog;
    rows = scheduleRows(parseSlots(RTTY_SCHEDULE[prog]), now, { maxDur: 8 * 60, limit: 4 });
  }
  box.hidden = !rows.length;
  if (!rows.length) return;
  box.querySelector('.dw-sched-h').textContent = title;
  const dot = (r) => r.onAir ? '●' : r.imminent ? '●' : r.urgent ? '⚡' : '';
  const cls = (r, i) => 'dw-srow' + (r.onAir ? ' air' : r.imminent ? ' imm' : r.urgent ? ' urg' : i === 0 ? ' first' : '');
  const body = box.querySelector('.dw-sched-b');
  const keep = body.scrollTop;
  body.innerHTML = rows.map((r, i) => navtex
    ? `<div class="${cls(r, i)}" title="NAVAREA ${esc(r.area)}"><span>${r.flag || ''}</span><span class="id">${esc(r.id)}</span>` +
      `<span class="l">${esc(r.name)} <small>(${esc(r.area)})</small></span><span class="t">${r.nextUTC}</span><span class="c">${r.countdown}</span><span class="d">${dot(r)}</span></div>`
    : `<div class="${cls(r, i)}"><span class="t">${r.utc}</span><span class="l" title="${esc(r.label)}">${esc(r.label)}</span>` +
      `<span class="c">${r.countdown}</span><span class="d">${dot(r)}</span></div>`).join('');
  body.scrollTop = keep;
}

// ── FT8 / FT4 / FT2 / JS8 / WSPR audio spectrum (PhantomSDR-Plus 5.5.0 FtxSpectrum) ────
// Max-hold over the slot being captured (an FT signal hops, so the peak per bin draws each
// station as a steady trace), with yellow marks at the audio Hz of the spots decoded from
// the previous slot, so the Hz column can be read off the strip. FT modes 100–3100 Hz
// (4096-point FFT, 2.9 Hz bins); WSPR zoomed to 1390–1610 Hz (16384 points, 0.73 Hz).
const SPEC_HTML = '<div class="dw-spec"><canvas></canvas><span>audio Hz — yellow marks = decoded spots</span></div>';
const spec = { N: 0, re: null, im: null, fill: null, pos: 0, max: null, marks: [], seq: 0, src: '', raf: 0, lastSeq: -1, lastW: 0, floor: null };
function specStart(src) {
  specStop();
  const N = src === 'wspr' ? 16384 : 4096;
  Object.assign(spec, { N, src, re: new Float64Array(N), im: new Float64Array(N), fill: new Float32Array(N), pos: 0,
                        max: new Float32Array((N >> 1) + 1).fill(-140), marks: [], seq: 1, lastSeq: -1, lastW: 0, floor: null });
  spec.raf = requestAnimationFrame(specDraw);
}
function specStop() { if (spec.raf) cancelAnimationFrame(spec.raf); spec.raf = 0; spec.src = ''; }
function specReset() { if (!spec.max) return; spec.max.fill(-140); spec.pos = 0; spec.seq++; }
function specMarks(hzList) { spec.marks = (hzList || []).filter((h) => Number.isFinite(h)); spec.seq++; }
function specFeed(pcm) {
  if (!spec.src) return;
  const N = spec.N;
  let i = 0;
  while (i < pcm.length) {
    const take = Math.min(N - spec.pos, pcm.length - i);
    spec.fill.set(pcm.subarray(i, i + take), spec.pos);
    spec.pos += take; i += take;
    if (spec.pos < N) return;
    const re = spec.re, im = spec.im;
    for (let k = 0; k < N; k++) { re[k] = spec.fill[k] * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / N)); im[k] = 0; }
    try { transformFlat(re, im, false); } catch (e) { spec.pos = 0; return; }
    const half = N >> 1, max = spec.max;
    for (let k = 0; k <= half; k++) { const db = 10 * Math.log10((re[k] * re[k] + im[k] * im[k]) / (N * N) + 1e-14); if (db > max[k]) max[k] = db; }
    spec.seq++; spec.pos = 0;
  }
}
function specDraw() {
  spec.raf = requestAnimationFrame(specDraw);
  const cv = $('.dw-spec canvas'); if (!cv || !spec.max) return;
  const dpr = W.devicePixelRatio || 1, cssW = cv.clientWidth; if (!cssW) return;
  const w = Math.round(cssW * dpr), h = Math.round(56 * dpr);
  const resized = w !== spec.lastW;
  if (resized) { cv.width = w; cv.height = h; spec.lastW = w; }
  if (!resized && spec.seq === spec.lastSeq) return;
  spec.lastSeq = spec.seq;
  const wspr = spec.src === 'wspr', mags = spec.max, binHz = SR() / spec.N;
  const loHz = wspr ? 1390 : 100, hiHz = wspr ? 1610 : Math.min(3100, SR() / 2), gridHz = wspr ? 50 : 500, span = hiHz - loHz;
  const loBin = Math.max(1, Math.floor(loHz / binHz)), hiBin = Math.min(mags.length - 1, Math.ceil(hiHz / binHz));
  const xOf = (hz) => ((hz - loHz) / span) * w;
  const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, w, h);
  let med = -100;
  if (hiBin > loBin) { const t = Float32Array.from(mags.subarray(loBin, hiBin)).sort(); med = t[t.length >> 1]; }
  spec.floor = spec.floor === null ? med - 6 : spec.floor + 0.2 * (med - 6 - spec.floor);
  const usable = h * 0.8, yOf = (db) => h - Math.max(0, Math.min(1, (db - spec.floor) / 50)) * usable;
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.fillStyle = 'rgba(255,255,255,0.38)'; ctx.lineWidth = dpr;
  ctx.font = `${9 * dpr}px monospace`; ctx.textAlign = 'center';
  for (let f = Math.ceil(loHz / gridHz) * gridHz; f <= hiHz; f += gridHz) {
    const x = xOf(f); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); ctx.fillText(String(f), x, h - 2 * dpr);
  }
  ctx.beginPath(); ctx.moveTo(0, h);
  for (let px = 0; px < w; px++) {
    const f0 = loHz + (px / w) * span, f1 = loHz + ((px + 1) / w) * span;
    const b0 = Math.max(loBin, Math.floor(f0 / binHz)), b1 = Math.min(hiBin, Math.max(b0, Math.ceil(f1 / binHz)));
    let pk = -140; for (let b = b0; b <= b1; b++) if (mags[b] > pk) pk = mags[b];
    ctx.lineTo(px, yOf(pk));
  }
  ctx.lineTo(w, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(34,211,238,0.55)'); g.addColorStop(1, 'rgba(34,211,238,0.06)');
  ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = 'rgba(34,211,238,0.85)'; ctx.stroke();
  for (const hz of spec.marks) {
    if (hz < loHz || hz > hiHz) continue;
    const x = xOf(hz);
    ctx.strokeStyle = 'rgba(250,204,21,0.9)'; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.fillStyle = 'rgba(250,204,21,0.95)'; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x - 3 * dpr, 6 * dpr); ctx.lineTo(x + 3 * dpr, 6 * dpr); ctx.closePath(); ctx.fill();
  }
}

// ── Decoder ID (PhantomSDR-Plus 5.5.0: modeId.js + modePriors.js, ModeIdChip) ──────────
// "What am I listening to?": measures the signal in the passband (bandwidth, shift, baud,
// slot timing, keying) in a Web Worker and ranks the modes it could be, then the band plan
// (calling frequencies) re-ranks them and tells FT8 from JS8. It only suggests: "Use …"
// starts that decoder (with its sideband and filter), the runners-up are links too.
// "Recentre & retry" moves the dial so a signal near the passband edge sits at 1500 Hz.
// Off by default (it costs CPU only while on); starting a decoder switches it off; a
// retune or mode change starts the measurement again. Desktop page only.
let idEng = null, idRes = null, idKey = '';
function idOn() {
  if (idEng) return;
  idRes = null;
  idEng = new ModeIdWorkerProxy({ sampleRate: () => st.sr || 12000, callback: (ev) => { if (ev && ev.t === 'result') { idRes = ev; idDraw(); } } });
  idEng.setEnabled(true);
  idKey = dialKHz() + '|' + pageMode();
  idDraw();
}
function idOff() {
  if (!idEng) return;
  try { idEng.destroy(); } catch (e) {}
  idEng = null; idRes = null; idDraw();
}
function idFollow() {
  if (!idEng) return;
  const k = dialKHz() + '|' + pageMode();
  if (k !== idKey) { idKey = k; try { idEng.reset(); } catch (e) {} idRes = null; idDraw(); }
}
function idRanked() {
  if (!idRes || !idRes.candidates) return [];
  const f = idRes.features, m = pageMode();
  const khz = f ? signalKhz(dialKHz(), f.centerHz, m === 'LSB' ? 'LSB' : m) : 0;
  return applyBandPriors(idRes.candidates, khz);
}
function idOffCentre() {
  const f = idRes && idRes.features;
  return !!(idEng && f && f.centerHz && f.snrDb && /^(USB|LSB)$/.test(pageMode()) && (f.centerHz < RELIABLE_LO_HZ || f.centerHz > RELIABLE_HI_HZ));
}
function idMeasured(f) {
  if (!f) return '';
  return [f.bwHz ? `${f.bwHz.toFixed(0)} Hz wide` : null, f.toneSpacingHz ? `${f.toneSpacingHz.toFixed(0)} Hz shift` : null,
    f.baud ? `${f.baud.toFixed(2)} Bd` : null, f.envRate ? `${f.envRate.toFixed(1)} Bd env` : null,
    f.gridSec ? `${f.gridSec} s grid` : f.slowGridSec ? `${f.slowGridSec} s grid (through fading)` : null,
    f.burstSec ? `${f.burstSec.toFixed(1)} s burst` : f.runSec ? `${f.runSec.toFixed(0)} s on air` : null,
    f.keyRate ? `${(f.keyRate * 1.2).toFixed(0)} WPM` : null, f.snrDb ? `${f.snrDb.toFixed(0)} dB S/N` : null].filter(Boolean).join(' · ');
}
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
let idCands = [];
function idDraw() {
  const el = document.getElementById('decid'); if (!el) return;
  const btn = `<b>Decoder ID:</b><button type="button" class="di-tog${idEng ? ' on' : ''}" title="Identify the digital mode in the passband. Off by default — it only uses CPU while it is on.">${idEng ? 'On' : 'Off'}</button>`;
  if (!idEng) { el.innerHTML = btn; return; }
  const rec = idOffCentre() ? '<button type="button" class="di-rec" title="The signal is near the edge of the passband, where the measurement is unreliable. Move the dial so it sits at 1500 Hz, then measure again.">Recentre &amp; retry</button>' : '';
  if (!idRes || !idRes.ready) {
    const fill = idRes && idRes.fill ? idRes.fill : 0;
    el.innerHTML = btn + `<span>Listening…</span><span class="di-bar"><i style="width:${pct(fill)}"></i></span><span>${pct(fill)}</span>`;
    return;
  }
  idCands = idRanked();
  const best = idCands[0], meas = esc(idMeasured(idRes.features));
  if (!best) {
    el.innerHTML = btn + `<span>${idRes.quiet ? 'Nothing above the noise' : 'Not recognised'}</span><span class="di-feat" title="${meas}">${meas}</span>${rec}`;
    return;
  }
  const tone = best.score >= 0.75 ? 'di-g' : best.score >= 0.5 ? 'di-y' : 'di-o';
  const name = (c) => esc(c.label.split(' (')[0]);
  const alts = idCands.slice(1).map((c, i) => `<button type="button" class="di-alt" data-i="${i + 1}"${c.key ? '' : ' disabled'} title="${esc(c.why || '')}${c.key ? '' : ' — no decoder for this mode'}">${name(c)} ${pct(c.score)}</button>`).join('');
  el.innerHTML = btn + `<span class="di-best ${tone}" title="${esc(best.why || '')}">${esc(best.label)}</span>` +
    (best.onPlan ? '<span title="A known calling frequency for that mode, which is part of why it ranks first">📻</span>' : '') +
    `<span>${pct(best.score)}</span><span class="di-feat" title="Measured from the signal: ${meas}">${meas}</span>` +
    (alts ? `<span>or</span>${alts}` : '') + rec +
    (best.key ? `<button type="button" class="di-use" data-i="0" title="Switch to the decoder for this mode">Use ${name(best)}</button>` : '<span title="Identified, but there is no decoder for it here">no decoder</span>');
}
// A candidate → this page's decoder (PhantomSDR-Plus keys: ft8 ft4 ft2 js8 wspr navtex
// hffax sstv cw, fsk + variant ham / weather / psk31 / olivia)
function idUse(c) {
  if (!c || !c.key) return;
  const k = c.key;
  if (k === 'cw') { idOff(); listener(); try { W.set_mode('cw'); } catch (e) {} return; }
  if (k === 'services') {                       // DSC: SERVICES, the carrier put on its 1700 Hz
    const f = idRes && idRes.features, v = DEC[c.variant] ? c.variant : 'dsc';
    const dial = f && f.centerHz ? dialKHz() + (pageMode() === 'LSB' ? -1 : 1) * (f.centerHz - 1700) / 1000 : 0;
    start(v, { keepDial: true });
    if (dial > 0) { tuneKHz(+dial.toFixed(3)); applyFilter(v); }
    return;
  }
  if (k === 'fsk') {
    const v = c.variant || 'ham';
    if (v === 'psk31' || v === 'olivia' || v === 'weather') { start(v, { keepDial: true }); return; }   // weather: SERVICES
    lsSet('ubersdr_rtty', 'ham');
    start('rtty', { keepDial: true }); return;
  }
  const map = { hffax: 'fax' }, d = map[k] || k;
  if (DEC[d]) start(d, { keepDial: true });
}
function idRecentre() {
  const f = idRes && idRes.features; if (!f || !f.centerHz) return;
  const delta = (f.centerHz - RECENTRE_TARGET_HZ) / 1000, inv = pageMode() === 'LSB';
  const target = dialKHz() + (inv ? -delta : delta);
  if (target <= 0) return;
  tuneKHz(+target.toFixed(3));
  idKey = dialKHz() + '|' + pageMode(); try { idEng.reset(); } catch (e) {} idRes = null; idDraw();
}
function idClick(e) {
  const b = e.target.closest('button'); if (!b) return;
  if (b.classList.contains('di-tog')) { if (idEng) idOff(); else idOn(); return; }
  if (b.classList.contains('di-rec')) { idRecentre(); return; }
  if (b.dataset.i !== undefined) idUse(idCands[+b.dataset.i]);
}

// ── SERVICES (PhantomSDR-Plus 5.5.0) ────────────────────────────────────────────────
// The ex-HFDL button: a Service list in the window head picks HFDL (its own worker, as
// before), Maritime FSK / SITOR, Weather RTTY and ALE 2G (fsk.js, as FLDIGI), DSC, Time
// Signals or HF Selcall (PhantomSDR-Plus's services.worker.js: dsc.js, timesig.js), one at
// a time. In PhantomSDR-Plus's order.
const SERVICES = [['hfdl', 'HFDL'], ['maritime', 'Maritime FSK / SITOR'], ['weather', 'Weather RTTY'], ['dsc', 'DSC'],
                  ['time', 'Time Signals'], ['selcall', 'HF Selcall'], ['aleu', 'ALE 2G (MIL-STD-188-141)']];
function svcKey() { const v = lsGet('ubersdr_service', 'hfdl'); return SERVICES.some((x) => x[0] === v) ? v : 'hfdl'; }
function serviceSelect(cur) {
  return `<select class="dw-svc dec-sel" title="SERVICE: HFDL (aircraft), Maritime FSK / SITOR, Weather RTTY, DSC (maritime calls), Time Signals, HF Selcall, ALE 2G">${SERVICES.map(([v, n]) =>
    `<option value="${v}"${v === cur ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
}
function svcWire() { const e = $('.dw-svc'); if (e) e.onchange = () => { lsSet('ubersdr_service', e.value); start(e.value); }; }
let svc = null;                                  // ServicesWorkerProxy
function svcStart(name, opts, cb) {
  svc = new ServicesWorkerProxy({ sampleRate: SR, callback: (ev) => { if (ev && (!ev.service || ev.service === name) && st.on === name) cb(ev); } });
  svc.setService(name, opts || {}); svc.setEnabled(true);
}
function saveText(name, lines) {
  if (!lines.length) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/plain' }));
  a.download = `${name}-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '')}.txt`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function mapLink(p) {
  return `<a href="https://www.openstreetmap.org/?mlat=${p.lat.toFixed(4)}&mlon=${p.lon.toFixed(4)}#map=6/${p.lat.toFixed(3)}/${p.lon.toFixed(3)}" target="_blank" rel="noopener" title="Show the position on a map">📍 ${esc(p.text || '')}</a>`;
}
// DSC (GMDSS) and HF Selcall (CCIR 493-4): the same FSK (100 Bd, 170 Hz) 1.7 kHz above the USB dial
const DSC_FREQS = [
  ['Distress & safety (watched by every coast station)', [2187.5, 4207.5, 6312.0, 8414.5, 12577.0, 16804.5]],
  ['Coast → ship calling', [2177.0, 4219.5, 6331.0, 8436.5, 12657.0, 16903.0, 19703.5, 22444.0, 26121.0]],
  ['Ship → coast calling', [2189.5, 4208.0, 6312.5, 8415.0, 12577.5, 16805.0, 18898.5, 22374.5, 25208.5]]];
const selCentre = (f) => Math.round((f + 0.5) * 100) / 100;    // KiwiSDR lists the dial with the tones 500 Hz above
const SELCALL_FREQS = [
  ['7 MHz channels', [7104.78, 7107.78, 7110.78, 7116.78, 7122.78, 7131.78, 7134.78, 7137.78, 7140.78, 7143.78, 7149.78, 7152.78, 7158.78, 7161.78, 7173.78].map(selCentre)],
  ['8 MHz channels', [7910.78, 7919.78, 7922.78, 7934.78, 8004.78, 8007.78, 8010.78, 8013.78, 8016.78, 8019.78, 8022.78, 8025.78, 8028.78, 8031.78, 8034.78, 8067.78, 8070.78, 8073.78, 8076.78, 8079.78, 8085.78, 8091.78].map(selCentre)]];
function dscWindow(k) {
  const sel = k === 'selcall', groups = sel ? SELCALL_FREQS : DSC_FREQS, all = groups.flatMap((g) => g[1]);
  const carrier = () => dialKHz() + 1.7, here = all.find((f) => Math.abs(f - carrier()) < 0.05);
  const cur = here || (sel ? groups[0][1][0] : 8414.5);
  const calls = [];
  openWindow(`<div class="dw-head">${serviceSelect(k)}<span class="dw-title">${sel ? 'HF Selcall' : 'DSC'} receiver</span>` +
    `<select class="dw-fq dec-sel" title="${sel ? 'Selcall channel (FSK centre)' : 'DSC frequency'}, kHz; the dial goes 1.7 kHz below it, USB">${groups.map(([g, l]) =>
      `<optgroup label="${esc(g)}">${l.map((f) => `<option value="${f}"${f === cur ? ' selected' : ''}>${f.toFixed(sel ? 2 : 1)} kHz</option>`).join('')}</optgroup>`).join('')}</select>` +
    `<button type="button" class="dw-go" title="Tune: dial 1.7 kHz below this frequency, USB, and the filter">Tune</button>` +
    `<button type="button" class="dw-save" title="Save the decoded calls (text)">Save</button><button type="button" class="dw-clear">Clear</button></div>` +
    `<div class="dw-info"></div><div class="dw-list"></div>`);
  svcWire();
  let met = {};
  const info = () => {
    const c = carrier(), on = all.some((f) => Math.abs(f - c) < 0.05);
    $('.dw-info').innerHTML = `<span>${sel ? 'Channel' : 'DSC'}: <b>${c.toFixed(sel ? 2 : 1)} kHz</b>${on ? '' : ` <span class="warn" title="Pick a frequency and Tune">⚠ off ${sel ? 'Selcall channel' : 'DSC frequency'}</span>`}</span>` +
      (met.snrDb != null ? `<span title="Signal-to-noise of the FSK, measured on the bits">S/N: <b>${(+met.snrDb).toFixed(1)} dB</b></span>` : '') +
      `<span title="How far the two tones sit from where they should be (tuning error)">Offset: <b>${met.offsetHz > 0 ? '+' : ''}${met.offsetHz || 0} Hz</b></span>` +
      `<span>Calls: <b>${calls.length}</b></span>${met.receiving ? '<span class="ok"><b>[call in progress]</b></span>' : ''}`;
  };
  const cat = (m) => m.format === 112 || m.category === 112 ? ['dis', sel ? 'EMERGENCY' : 'DISTRESS'] : m.category === 110 ? ['urg', 'URGENCY'] : m.category === 108 ? ['saf', 'SAFETY'] : ['rou', 'ROUTINE'];
  const list = $('.dw-list');
  list.innerHTML = `<div class="sv-row"><i>Pick a frequency, Tune and wait. ${sel ? 'Selcall is heard mostly on the 7 and 8 MHz channels of outback and expedition networks.' : 'Coast stations answer and test on the distress & safety channels many times an hour; 8414.5 and 12577 kHz are usually the busiest.'}</i></div>`;
  svcStart(k, { centerHz: 1700 }, (e) => {
    if (e.type === 'status') status(e.text);
    else if (e.type === 'metrics') { met = e; info(); }
    else if (e.type === 'error') status('Decoder error: ' + e.message);
    else if (e.type === 'message' && e.msg) {
      const m = e.msg, [cc, ct] = cat(m), fq = carrier().toFixed(sel ? 2 : 1);
      calls.push({ ...m, fq }); if (calls.length > 300) calls.shift();
      if (calls.length === 1) list.innerHTML = '';
      const end = atEnd(list);
      const ecc = m.eccOk === true ? '<span class="ok" title="Error-check character agrees">✓</span>'
        : m.recovered ? '<span class="ok" title="One character was lost in both copies and rebuilt from the error-check character">✓ (1 rebuilt)</span>'
        : m.eccOk === false ? '<span class="bad" title="Error-check character disagrees: some characters may be wrong">ECC ✗</span>'
        : m.errors ? `<span class="bad" title="Characters lost in both copies">${m.errors} unread</span>` : '';
      list.insertAdjacentHTML('beforeend', `<div class="sv-row"><span class="t">${esc(m.time || '')}</span> ${fq} <span class="k ${cc}">${ct}</span> ` +
        `<span class="fmt">${esc(m.formatText || '')}</span> ${ecc} ${m.pos ? mapLink(m.pos) : ''}` +
        `<div class="fl">${(m.fields || []).map((f) => `<i>${esc(f[0])}:</i> ${esc(f[1])}`).join(' · ')}</div></div>`);
      while (list.children.length > 300) list.removeChild(list.firstChild);
      if (end) scrollEnd(list);
      info();
    }
  });
  $('.dw-go').onclick = () => { const f = +$('.dw-fq').value; if (f) { tuneKHz(+(f - 1.7).toFixed(3)); applyFilter(k); picked(f - 1.7); if (svc) svc.reset(); setTimeout(info, 400); } };
  $('.dw-clear').onclick = () => { calls.length = 0; list.innerHTML = ''; info(); };
  $('.dw-save').onclick = () => saveText(k, calls.map((m) => [m.time + ' UTC', m.fq + ' kHz', m.formatText, cat(m)[1],
    ...(m.fields || []).map((f) => f.join(': ')), m.eccOk === true ? 'ECC ok' : m.recovered ? '1 character rebuilt from ECC' : m.eccOk === false ? 'ECC error' : ''].filter(Boolean).join(' | ')));
  info(); status('Waiting for a call…');
  svcInfo = info;
}
let svcInfo = null;                              // refreshes the window's info line on retune
// Time signals: DCF77, MSF, RWM, WWV/WWVH; the carrier 1 kHz above the USB dial
function timeStation() { const v = lsGet('ubersdr_timestation', 'dcf77'); return TIME_STATIONS.some((s) => s.key === v) ? v : 'dcf77'; }
let tsFmt = null, tsZone = '';                   // the decoded time in this station's own zone (its locator)
async function tsZoneLoad() {
  const loc = (W.STATION && W.STATION.locator) || '', p = locatorToLatLon(loc);
  if (!p || tsZone) return;
  try {
    const { default: tzlookup } = await import(new URL('./psdr/lib/tzLookup.js?v=20261106', import.meta.url).href);
    tsZone = tzlookup(p.lat, p.lon) || '';
    if (tsZone) tsFmt = [new Intl.DateTimeFormat('en-GB', { timeZone: tsZone, hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }),
                         new Intl.DateTimeFormat('en-GB', { timeZone: tsZone, weekday: 'short', day: '2-digit', month: 'short' })];
  } catch (e) { console.warn('decoders: time zone', e); }
}
function timeWindow() {
  let stn = timeStation(), last = null, met = null;
  const rows = [];
  const S = () => TIME_STATIONS.find((s) => s.key === stn) || TIME_STATIONS[0];
  const carrier = () => dialKHz() + 1.0;
  const fqLabel = (f) => f >= 1000 ? `${(f / 1000).toFixed(3).replace(/\.?0+$/, '')} MHz` : `${f} kHz`;
  const fqOpts = () => { const c = carrier(), b = [...S().khz].sort((x, y) => Math.abs(x - c) - Math.abs(y - c))[0];
    return S().khz.map((f) => `<option value="${f}"${f === b ? ' selected' : ''}>${fqLabel(f)}</option>`).join(''); };
  openWindow(`<div class="dw-head">${serviceSelect('time')}<span class="dw-title">Time Signals</span>` +
    `<select class="dw-st dec-sel" title="Time-signal station">${TIME_STATIONS.map((s) => `<option value="${s.key}"${s.key === stn ? ' selected' : ''} title="${esc(s.note)}">${esc(s.label)}</option>`).join('')}</select>` +
    `<select class="dw-fq dec-sel" title="Carrier frequency (the dial goes 1 kHz below it, USB)">${fqOpts()}</select>` +
    `<button type="button" class="dw-go" title="Tune 1 kHz below this carrier, USB, and the filter">Tune</button>` +
    `<button type="button" class="dw-save" title="Save the decoded minutes (text)">Save</button><button type="button" class="dw-clear">Clear</button></div>` +
    `<div class="dw-info ts-note"></div><div class="ts-big"></div><div class="ts-bits"></div><div class="dw-info ts-met"></div><div class="dw-list" style="height:70px"></div>`);
  svcWire();
  const offs = (ms) => `${ms >= 0 ? '+' : '−'}${(Math.abs(ms) / 1000).toFixed(2)} s`;
  const stTime = (ms) => tsFmt && Number.isFinite(ms) ? tsFmt[0].format(new Date(ms)) : '';
  const draw = () => {
    const s = S(), c = carrier(), on = s.khz.some((f) => Math.abs(f - c) < 0.05);
    $('.ts-note').textContent = s.note;
    $('.ts-big').innerHTML = !last ? '<i>Pick a station, Tune and wait: a full minute has to come in clean before the time can be shown (one to two minutes on a good signal).</i>'
      : `<span class="utc">${esc(last.utc)}</span> UTC ${last.timingOnly ? ' minute pulse (RWM sends no date)' : esc((last.weekday || '') + ' ' + (last.date || ''))}` +
        (last.local ? ` <span title="The time as the transmitting station sends it">· sent as ${esc(last.local)}</span>` : '') +
        (tsFmt && last.utcMs ? `<br><span title="The decoded time in this receiver's time zone (${esc(tsZone)}), from its locator">Station time: <b>${stTime(last.utcMs)}</b> ${tsFmt[1].format(new Date(last.utcMs))}</span>` : '') +
        `<br><span title="When the minute mark reached this page, against your computer's clock (includes the WebSDR's own delay)">Arrived ${offs(last.offsetMs)} vs your clock</span>` +
        (last.dut1 != null ? ` · DUT1 ${last.dut1 >= 0 ? '+' : ''}${last.dut1} s` : '') + (last.details ? ' · ' + esc(last.details) : '') +
        (last.flags || []).map((f) => ` <span class="bad">⚠ ${esc(f)}</span>`).join('');
    const bits = $('.ts-bits');
    bits.style.display = met && met.bits && s.key !== 'rwm' ? '' : 'none';
    if (met && met.bits) bits.innerHTML = Array.from({ length: 60 }, (_, i) => `<span class="${i === met.second ? 'now' : met.bits[i] === 1 ? 'b1' : met.bits[i] === 0 ? 'b0' : met.bits[i] === 2 ? 'b2' : ''}"></span>`).join('');
    $('.ts-met').innerHTML = `<span>Carrier: <b>${c >= 1000 ? (c / 1000).toFixed(4) + ' MHz' : c.toFixed(1) + ' kHz'}</b>${on ? '' : ` <span class="warn">⚠ not on ${esc(s.label.split(' ·')[0])}</span>`}</span>` +
      (met ? `<span title="How deep the keying is: carrier on vs off (DCF77 about 16 dB)">Keying depth: <b>${met.depthDb} dB</b></span><span>Second: <b>${met.second ?? '—'}</b></span><span>Minutes decoded: <b>${met.decoded}</b></span>` : '');
  };
  const list = $('.dw-list');
  svcStart('time', { station: stn }, (e) => {
    if (e.type === 'status') status(e.text);
    else if (e.type === 'metrics') { met = e; draw(); }
    else if (e.type === 'error') status('Decoder error: ' + e.message);
    else if (e.type === 'message' && e.msg) {
      last = e.msg; rows.push({ ...last, fq: carrier().toFixed(1) }); if (rows.length > 120) rows.shift();
      list.insertAdjacentHTML('afterbegin', `<div class="sv-row"><span class="t">${esc(last.received || '')}</span> <span class="fmt">${esc(String(last.station || '').toUpperCase())}</span> ` +
        `${last.timingOnly ? esc(last.text || '') : esc(last.utc + ' UTC ' + (last.date || ''))}${tsFmt && last.utcMs ? ' · ' + stTime(last.utcMs) : ''} <i>arrived ${offs(last.offsetMs)}</i></div>`);
      while (list.children.length > 120) list.removeChild(list.lastChild);
      draw();
    }
  });
  $('.dw-st').onchange = (e) => { stn = e.target.value; lsSet('ubersdr_timestation', stn); last = met = null; if (svc) svc.setOptions({ station: stn }); $('.dw-fq').innerHTML = fqOpts(); draw(); };
  $('.dw-go').onclick = () => { const f = +$('.dw-fq').value; if (f) { tuneKHz(+(f - 1).toFixed(3)); applyFilter('time'); picked(f - 1); if (svc) svc.reset(); last = met = null; setTimeout(draw, 400); } };
  $('.dw-clear').onclick = () => { rows.length = 0; list.innerHTML = ''; last = null; draw(); };
  $('.dw-save').onclick = () => saveText('timesignals', rows.map((r) => [r.received + ' (page clock)', String(r.station).toUpperCase(), r.fq + ' kHz',
    r.timingOnly ? r.text : `${r.utc} UTC${r.date ? ' ' + r.date : ''}${r.local ? ' (' + r.local + ')' : ''}`, r.dut1 != null ? `DUT1 ${r.dut1 >= 0 ? '+' : ''}${r.dut1} s` : '',
    tsFmt && r.utcMs ? `station time ${stTime(r.utcMs)}` : '', `arrived ${offs(r.offsetMs)}`, ...(r.flags || [])].filter(Boolean).join(' | ')));
  draw(); status('Waiting for the signal…');
  svcInfo = draw;
  tsZoneLoad().then(draw);
}

// ── ALE 2G, FST4W, MSK144 in the FLDIGI list (PhantomSDR-Plus 5.5.0, fsk.js) ────────────
// ALE 2G (MIL-STD-188-141): the dial is the channel, a few networks work in LSB; 500–2750 Hz.
// As PhantomSDR-Plus (AlePanel scope): FLDIGI "ALE 2G HAM" ('ale') lists the amateur (HFLINK)
// net only, SERVICES "ALE 2G" ('aleu') every other net.
let aleLsb = false;
const aleNets = (k) => ALE_NETS.filter((n) => (n.cat === 'Amateur') === (k === 'ale'));
// An ALE label or marker: an amateur channel opens FLDIGI's ALE 2G HAM, any other SERVICES' ALE 2G
function aleTarget(khz) {
  return ALE_NETS.some((n) => n.cat === 'Amateur' && n.khz.some((f) => Math.abs(f - khz) < 0.05)) ? 'ale' : 'aleu';
}
function aleWindow(k) {
  const ham = k === 'ale', NETS = aleNets(k), lsKey = ham ? 'ubersdr_alenet' : 'ubersdr_alenet_u';
  const cats = [...new Set(NETS.map((n) => n.cat))], f0 = dialKHz();
  let ni = NETS.findIndex((n) => n.khz.some((f) => Math.abs(f - f0) < 0.05));
  if (ni < 0) ni = Math.min(NETS.length - 1, +lsGet(lsKey, '0') || 0);
  aleLsb = !!NETS[ni].lsb && pageMode() === 'LSB';
  const fqOpts = (i) => { const n = NETS[i], b = [...n.khz].sort((x, y) => Math.abs(x - dialKHz()) - Math.abs(y - dialKHz()))[0];
    return n.khz.map((f) => `<option value="${f}"${f === b ? ' selected' : ''}>${f} kHz${n.lsb ? ' LSB' : ''}</option>`).join(''); };
  const rows = [];
  openWindow(`<div class="dw-head">${ham ? familySelect('ale') : serviceSelect('aleu')}<span class="dw-title">${ham ? 'ALE 2G HAM' : 'ALE 2G'}</span>` +
    `<select class="dw-net dec-sel" title="${ham ? 'ALE network: the amateur (HFLINK) channels; government, military and utility networks are in SERVICES → ALE 2G' : 'ALE network (KiwiSDR\'s list); the amateur (HFLINK) channels are in FLDIGI → ALE 2G HAM'}">${cats.map((c) => `<optgroup label="${esc(c)}">${NETS.map((n, i) => n.cat === c ? `<option value="${i}"${i === ni ? ' selected' : ''}>${esc(n.net)}</option>` : '').join('')}</optgroup>`).join('')}</select>` +
    `<select class="dw-fq dec-sel" title="Its channels (the dial)">${fqOpts(ni)}</select><button type="button" class="dw-go" title="Tune to this channel and set the filter">Tune</button>` +
    `<button type="button" class="dw-save" title="Save (text)">Save</button><button type="button" class="dw-clear">Clear</button></div><div class="dw-info"></div><div class="dw-list"></div>`);
  const list = $('.dw-list');
  list.innerHTML = '<div class="sv-row"><i>Pick a network and channel, Tune and wait: ALE stations sound (identify themselves) every hour or so and call each other at any time; the decoder searches ±1 kHz by itself.</i></div>';
  let words = 0, synced = 0, first = true;
  const info = () => { $('.dw-info').innerHTML = `<span>Words: <b>${words}</b></span><span>Synced: <b>${synced}</b></span><span>Events: <b>${rows.length}</b></span>`; };
  fsk = new FSKWorkerProxy({ role: 'fsk', variant: 'ale', sampleRate: SR, callback: (ev) => {
    if (!ev || st.on !== k) return;
    if (ev.type === 'status') status(ev.text || '');
    else if (ev.type === 'alemetrics') { words = ev.words; synced = ev.synced; info(); }
    else if (ev.type === 'ale' && ev.msg) {
      const m = { ...ev.msg, freq: dialKHz().toFixed(1) }, lr = rows[rows.length - 1];
      const same = lr && lr.kind === m.kind && lr.from === m.from && lr.to === m.to && !lr.cmds.length && !m.cmds.length && lr.freq === m.freq;
      if (first) { list.innerHTML = ''; first = false; }
      const end = atEnd(list);
      if (same) { lr.count++; lr.time = m.time; list.lastChild.querySelector('.k').textContent = `${m.kind} ×${lr.count}`; list.lastChild.querySelector('.t').textContent = m.time; }
      else {
        rows.push({ ...m, count: 1 }); if (rows.length > 300) rows.shift();
        const cls = m.kind.startsWith('Link') ? 'saf' : m.kind.startsWith('Call') ? 'urg' : 'rou';
        list.insertAdjacentHTML('beforeend', `<div class="sv-row"><span class="t">${esc(m.time)}</span> ${m.freq} <span class="k ${cls}">${esc(m.kind)}</span>` +
          (m.from ? ` from <b>${esc(m.from)}</b>` : '') + (m.to ? ` to <b>${esc(m.to)}</b>` : '') + ` <i title="Bit errors corrected in the last word">BER ${m.ber}</i>` +
          (m.cmds || []).map((c) => `<div class="fl"><span class="fmt">${esc(c.type)}</span> ${esc(c.text || '')}</div>`).join('') + '</div>');
        while (list.children.length > 300) list.removeChild(list.firstChild);
      }
      if (end) scrollEnd(list);
      info();
    }
  } });
  fsk.setVariant('ale'); fsk.setConfig({ center: 1625, encoding: 'ale' }); fsk.setEnabled(true);
  if (ham) $('.dw-var').onchange = (e) => familyChange(e.target.value); else svcWire();
  $('.dw-net').onchange = (e) => { lsSet(lsKey, e.target.value); $('.dw-fq').innerHTML = fqOpts(+e.target.value); };
  $('.dw-go').onclick = () => {
    const f = +$('.dw-fq').value, n = NETS[+$('.dw-net').value]; if (!f) return;
    aleLsb = !!n.lsb; tuneKHz(f); applyFilter(k); picked(f);
  };
  $('.dw-clear').onclick = () => { rows.length = 0; list.innerHTML = ''; info(); };
  $('.dw-save').onclick = () => saveText('ale', rows.map((r) => [r.time + ' UTC', r.freq + ' kHz', r.kind + (r.count > 1 ? ` ×${r.count}` : ''),
    r.from ? 'from ' + r.from : '', r.to ? 'to ' + r.to : '', `BER ${r.ber}`, ...(r.cmds || []).map((c) => `[${c.type}${c.text ? ': ' + c.text : ''}]`)].filter(Boolean).join(' | ')));
  info(); status('Listening (8 tones 750–2500 Hz, 125 Bd)…');
}
// FST4W (LF/MF beacons, one decode per T/R period) and MSK144 (meteor scatter): WSJT-X's
// decoders, the dial as in WSJT-X, signals around 1500 Hz; one row per decode
const fst4w = { period: +lsGet('ubersdr_fst4w_period', '120') || 120, tol: +lsGet('ubersdr_fst4w_tol', '100') || 100 };
const msk = { tol: +lsGet('ubersdr_msk_tol', '100') || 100, period: +lsGet('ubersdr_msk_period', '15') === 30 ? 30 : 15, depth: +lsGet('ubersdr_msk_depth', '3') || 3 };
const FST4W_DIALS = [['136.000 kHz — 2200 m FST4W', 136], ['474.200 kHz — 630 m FST4W', 474.2], ['1836.600 kHz — 160 m (WSPR sub-band)', 1836.6]];
// PhantomSDR-Plus also lists 2 m, 4 m and 6 m; this receiver ends at 30 MHz
const MSK144_DIALS = [['28.145 MHz — 10 m', 28145]];
function wsjtWindow(k) {
  const isF = k === 'fst4w', dials = isF ? FST4W_DIALS : MSK144_DIALS, rows = [];
  const sel = (cls, title, opts, cur) => `<select class="${cls} dec-sel" title="${title}">${opts.map(([v, n]) => `<option value="${v}"${+v === +cur ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
  const settings = isF
    ? sel('dw-per', 'T/R period: FST4W-120 is the common one; 300, 900 and 1800 s reach further on LF/MF. Changing it starts a new recording.', [120, 300, 900, 1800].map((t) => [t, `FST4W-${t}`]), fst4w.period) +
      sel('dw-tol', 'F Tol: how far either side of 1500 Hz the decoder searches', [50, 100, 150].map((t) => [t, `± ${t} Hz`]), fst4w.tol)
    : sel('dw-tol', 'F Tol: how far either side of 1500 Hz the decoder searches', [50, 100, 200, 300].map((t) => [t, `± ${t} Hz`]), msk.tol) +
      sel('dw-per', 'T/R period: a message repeated within one period is listed once', [[15, '15 s'], [30, '30 s']], msk.period) +
      sel('dw-dep', 'Decode: Deep also averages up to 7 frames of a long ping; Fast reads single pings only', [[1, 'Fast'], [2, 'Normal'], [3, 'Deep']], msk.depth);
  openWindow(`<div class="dw-head">${familySelect(k)}<span class="dw-title">${isF ? 'FST4W' : 'MSK144'}</span>` +
    `<select class="dw-tune dec-sel"><option value="">Frequency…</option>${dials.map(([n, f]) => `<option value="${f}">${n}</option>`).join('')}</select>${settings}` +
    `<button type="button" class="dw-save" title="Save the decodes as WSJT-X lists them (text)">Save</button><button type="button" class="dw-clear">Clear</button></div>` +
    (isF ? BAR_HTML : '') +
    `<div class="dw-list"><table><thead><tr><th>UTC</th><th>dB</th><th>${isF ? 'DT' : 'T'}</th><th>MHz</th><th>Message</th></tr></thead><tbody></tbody></table></div>`);
  const send = () => fsk.setConfig(isF ? { center: 1500, encoding: 'fst4w', period: fst4w.period, tol: fst4w.tol }
                                       : { center: 1500, encoding: 'msk144', tol: msk.tol, period: msk.period, depth: msk.depth });
  fsk = new FSKWorkerProxy({ role: 'fsk', variant: k, sampleRate: SR, callback: (ev) => {
    if (!ev || st.on !== k) return;
    if (ev.type === 'status') {
      status(ev.text || '');
      const p = ev.progress, fill = $('.dw-fill'), txt = $('.dw-bartxt');
      if (isF && p && p.period && fill) {
        fill.style.width = Math.min(100, 100 * (p.recorded || 0) / p.period) + '%';
        txt.textContent = `${Math.floor((p.recorded || 0) / 60)}:${String(Math.floor((p.recorded || 0) % 60)).padStart(2, '0')} / ${p.period / 60}:00 recorded`;
      }
    } else if (ev.type === k && ev.decode) {
      const d = ev.decode, hz = isF ? d.audioHz : d.freq, mhz = (dialKHz() * 1000 + (hz || 0)) / 1e6;
      rows.push({ ...d, mhz }); if (rows.length > 500) rows.shift();
      addRows(`<tr title="${isF ? `FST4W-${d.period}, audio ${d.audioHz} Hz` : `Audio ${d.freq} Hz · ${d.navg > 1 ? `average of ${d.navg} frames` : 'single frame'}`}">` +
        `<td>${esc(d.utc || '')}</td><td class="n">${d.snr}</td><td class="n">${Number(isF ? d.dt : d.t).toFixed(1)}</td><td class="n">${mhz.toFixed(6)}</td><td class="m">${esc(d.msg || '')}</td></tr>`);
    }
  } });
  fsk.setVariant(k); send(); fsk.setEnabled(true);
  $('.dw-var').onchange = (e) => familyChange(e.target.value);
  $('.dw-tune').onchange = (e) => { const f = +e.target.value; if (f) { tuneKHz(f); applyFilter(k); picked(f); } };
  const per = $('.dw-per'), tol = $('.dw-tol'), dep = $('.dw-dep');
  per.onchange = () => { if (isF) { fst4w.period = +per.value; lsSet('ubersdr_fst4w_period', per.value); } else { msk.period = +per.value; lsSet('ubersdr_msk_period', per.value); } send(); };
  tol.onchange = () => { if (isF) { fst4w.tol = +tol.value; lsSet('ubersdr_fst4w_tol', tol.value); } else { msk.tol = +tol.value; lsSet('ubersdr_msk_tol', tol.value); } send(); applyFilter(k); lightPresets(); };
  if (dep) dep.onchange = () => { msk.depth = +dep.value; lsSet('ubersdr_msk_depth', dep.value); send(); };
  $('.dw-clear').onclick = () => { rows.length = 0; $('tbody').innerHTML = ''; };
  $('.dw-save').onclick = () => saveText(k, rows.map((d) => isF
    ? `${String(d.utc).replace(':', '')}  ${String(d.snr).padStart(4)} ${Number(d.dt).toFixed(1).padStart(5)} ${d.mhz.toFixed(6)}  ${d.msg}   FST4W-${d.period}`
    : `${String(d.utc).replaceAll(':', '')} ${String(d.snr).padStart(3)} ${Number(d.t).toFixed(1).padStart(5)} ${String(d.freq).padStart(5)} &  ${d.msg}`));
  status(isF ? `FST4W decodes once per T/R period, after it ends (FST4W-${fst4w.period}: every ${fst4w.period / 60} min, on the UTC clock); a period joined part-way is skipped.`
             : `Listening for meteor pings (tones 1000 / 2000 Hz). MSK144 lives on 6 m and 2 m; on HF only 10 m (28.145 MHz) is used.`);
}
// PSK Browser (PhantomSDR-Plus pskBrowser.js): every BPSK31 signal in the passband, one line
// each; a click on a line decodes that one signal as BPSK31 (at 1000 Hz)
function browsing() { return (st.on === 'psk31' && pskMode().browser) || (st.on === 'olivia' && oliviaBrowse); }
let browserCh = [];
function browserWhat() { const o = oliviaMode(); return st.on === 'olivia' ? `${o.c ? 'Contestia' : 'Olivia'} ${o.label}` : 'PSK31'; }
function pskBrowserShow() {
  const on = browsing(), pb = $('.dw-pb'), tx = $('.dw-text'), au = $('.dw-auto');
  if (pb) {
    pb.hidden = !on;
    if (on && !pb.childElementCount) pb.innerHTML = `<div class="sv-row"><i>${st.on === 'olivia'
      ? `Listening for ${esc(browserWhat())} signals between 300 and 2700 Hz… A station appears once its first characters are decoded, a few seconds after it starts.`
      : 'Looking for PSK31 signals between 300 and 2700 Hz… (a few seconds)'}</i></div>`;
  }
  if (tx) tx.hidden = on;
  if (au && st.on === 'psk31') au.hidden = on;
}
// One line per signal: frequency, lock and its text in a box of about 6 lines that follows new
// text (its own scrollbar scrolls back; PhantomSDR-Plus keeps up to 4000 characters a line). The lines are
// kept, not rebuilt, so each box keeps its scroll position. A click on a line decodes only that
// signal: BPSK31, or Olivia in the same set-up, at 1000 Hz. Lines that went quiet are kept for
// Save (Clear empties them).
let browserRows = new Map(), browserArchive = [];
function browserEntry(c, at) { return { at, khz: dialKHz() + c.hz / 1000, text: String(c.text || '').trim() }; }
function browserArchiveAll() {
  const at = utcHM(Date.now());
  for (const c of browserCh) if (c.text && c.text.trim()) browserArchive.push(browserEntry(c, at));
  browserArchive = browserArchive.slice(-500); browserCh = []; browserRows = new Map();
}
function browserSaveLines() {
  const at = utcHM(Date.now());
  return [...browserArchive, ...(browsing() ? browserCh.filter((c) => c.text && c.text.trim()).map((c) => browserEntry(c, at)) : [])]
    .map((e) => `${e.at} UTC  ${e.khz.toFixed(3)} kHz  ${e.text}`);
}
function pskBrowserRows(ch) {
  const pb = $('.dw-pb'); if (!pb || !browsing()) return;
  const keep = new Set(ch.map((c) => c.id)), at = utcHM(Date.now());
  for (const c of browserCh) {
    if (keep.has(c.id)) continue;
    if (c.text && c.text.trim()) browserArchive.push(browserEntry(c, at));
    const r = browserRows.get(c.id); if (r) { r.remove(); browserRows.delete(c.id); }
  }
  browserArchive = browserArchive.slice(-500);
  if (!browserCh.length && ch.length) pb.innerHTML = '';
  browserCh = ch;
  const what = st.on === 'olivia' ? esc(oliviaMode().label) : 'BPSK31';
  for (const c of ch) {
    let r = browserRows.get(c.id);
    if (!r) {
      r = document.createElement('div'); r.className = 'pb-row';
      r.innerHTML = '<span class="f"></span><span class="q" title="Lock quality"></span><div class="x"></div>';
      browserRows.set(c.id, r);
    }
    pb.appendChild(r);                               // in the browser's order
    r.dataset.hz = c.hz;
    r.title = `Click: decode only this signal (${what} at ${Math.round(c.hz)} Hz)`;
    r.querySelector('.f').textContent = (dialKHz() + c.hz / 1000).toFixed(3);
    const q = r.querySelector('.q'); q.textContent = c.lock + '%'; q.className = 'q' + (c.lock >= 45 ? ' on' : '');
    const x = r.querySelector('.x'), t = String(c.text || '').trimStart();
    if (x.textContent !== t) {
      const end = x.scrollTop + x.clientHeight >= x.scrollHeight - 4;
      x.textContent = t;
      if (end) x.scrollTop = x.scrollHeight;
    }
  }
  if (!ch.length) pb.innerHTML = `<div class="sv-row"><i>No ${esc(browserWhat())} signal decoded yet between 300 and 2700 Hz…</i></div>`;
  const m = $('.dw-met'); if (m) m.textContent = `Signals: ${ch.length}`;
  // A line's own scrollbar: a click or drag on it scrolls, it does not pick the line
  pb.onmousedown = (e) => { const x = e.target.closest && e.target.closest('.x'); pb._onBar = !!(x && e.offsetX >= x.clientWidth); };
  pb.onclick = (e) => {
    if (pb._onBar) { pb._onBar = false; return; }
    const r = e.target.closest('.pb-row'); if (!r) return;
    const hz = +r.dataset.hz;
    browserArchiveAll();
    tuneKHz(+(dialKHz() + (hz - 1000) / 1000).toFixed(3));
    if (st.on === 'olivia') { oliviaBrowse = false; if (oliviaSend) oliviaSend(); applyFilter('olivia'); }
    else {
      lsSet('ubersdr_pskmode', 'bpsk31');
      const ms = $('.dw-pmode'); if (ms) ms.value = 'bpsk31';
      pskSend(); applyFilter('psk31');
      const t = $('.dw-title'); if (t) t.textContent = pskMode().label + ' decoder';
    }
    lightPresets(); showDial(); pskBrowserShow();
  };
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
  [/\bSITOR(?:-?B)?\b/i, 'maritime'], [/\b([BQ])?PSK-?(31|63|125)\b/i, 'psk31', null, (m) => ((m[1] || 'B').toUpperCase() === 'Q' ? 'qpsk' : 'bpsk') + m[2]],
  [/\bOLIVIA\b/i, 'olivia', null, 'olivia'], [/\bCONTESTIA\b/i, 'olivia', null, 'contestia'], [/\bMFSK ?-?(?:16|32|64)?\b/i, 'modem', 'mfsk'],
  [/\bDOMINO ?EX\b/i, 'modem', 'dominoex'], [/\bTHOR\b/i, 'modem', 'thor'], [/\bTHROB ?X?\b/i, 'modem', 'throb'],
  [/\b(?:FELD ?)?HELL(?:SCHREIBER)?\b/i, 'modem', 'hell'], [/\bMT-?63\b/i, 'modem', 'mt63'],
  [/\bPACKET\b/i, 'packet', 'packet'], [/\bAPRS\b/i, 'packet', 'aprs'], [/\bHFDL\b/i, 'hfdl'],
  [/\bDSC\b/i, 'dsc'], [/\bSELCALL\b/i, 'selcall'], [/\bFST4W\b/i, 'fst4w'], [/\bMSK144\b/i, 'msk144'], [/\bALE(?: ?2G)?\b/i, 'ale']];
// A label from a markers.json mode (data-dec, set by ubersdr-compat.js fetchdx) names its
// decoder outright, as PhantomSDR-Plus's MARKER_DECODERS: [decoder, FLDIGI list entry,
// MFSK sub-mode]. 'rade' = UberSDR's RADE V1 (RADEL lower, the rest upper sideband).
// MORSE has none here: its label sets CW, which opens the CW decoder by itself.
const MARKER_MODES = { FT8: ['ft8'], FT4: ['ft4'], FT2: ['ft2'], JS8: ['js8'], WSPR: ['wspr'], SSTV: ['sstv'],
  FAX: ['fax'], WEFAX: ['fax'], NAVTEX: ['navtex'], SITOR: ['maritime'], RTTY: ['rtty', 'ham'],
  'RTTY-WX': ['weather'], PSK31: ['psk31', null, 'bpsk31'], BPSK31: ['psk31', null, 'bpsk31'],
  PSK63: ['psk31', null, 'bpsk63'], BPSK63: ['psk31', null, 'bpsk63'], PSK125: ['psk31', null, 'bpsk125'],
  BPSK125: ['psk31', null, 'bpsk125'], QPSK31: ['psk31', null, 'qpsk31'], QPSK63: ['psk31', null, 'qpsk63'],
  QPSK125: ['psk31', null, 'qpsk125'], OLIVIA: ['olivia', null, 'olivia'], CONTESTIA: ['olivia', null, 'contestia'], MFSK: ['modem', 'mfsk'],
  MFSK16: ['modem', 'mfsk', 'mfsk16'], MFSK32: ['modem', 'mfsk', 'mfsk32'], MFSK64: ['modem', 'mfsk', 'mfsk64'],
  DOMINOEX: ['modem', 'dominoex'], THOR: ['modem', 'thor'], THROB: ['modem', 'throb'], HELL: ['modem', 'hell'],
  FELDHELL: ['modem', 'hell'], MT63: ['modem', 'mt63'], PACKET: ['packet', 'packet'], APRS: ['packet', 'aprs'],
  HFDL: ['hfdl'], DSC: ['dsc'], SELCALL: ['selcall'], TIME: ['time'], DCF77: ['time', null, 'dcf77'], MSF: ['time', null, 'msf'],
  RWM: ['time', null, 'rwm'], WWV: ['time', null, 'wwv'], WWVH: ['time', null, 'wwv'], FST4W: ['fst4w'], MSK144: ['msk144'], ALE: ['ale'],
  RADEL: ['rade', 'lsb'], RADEU: ['rade', 'usb'], RADE: ['rade', 'usb'], FREEDV: ['rade', 'usb'] };
let labelVariant = null;              // the FLDIGI list entry a label names (modems, packet, Amateur RTTY)
let labelSub = null;                  // its MFSK sub-mode, from a marker mode (MFSK32…)
function labelMode(html) {
  labelVariant = labelSub = null;
  const tag = /data-dec="([^"]*)"/.exec(String(html));
  if (tag) {
    const m = MARKER_MODES[tag[1].toUpperCase()];
    if (!m) return null;
    labelVariant = m[1] || null; labelSub = m[2] || null;
    return m[0];
  }
  const text = String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ');
  let best = null, at = Infinity;
  for (const [re, k, v, sub] of LABEL_MODES) {
    const m = re.exec(text);
    if (m && m.index < at) { best = k; at = m.index; labelVariant = v || null; labelSub = typeof sub === 'function' ? sub(m) : sub || null; }
  }
  return best;
}
// A decoder that decodes above the dial (FAX 1.9, NAVTEX 0.5, RTTY 1.0 kHz; PSK31, Olivia,
// the fldigi modems and Packet at their audio centre): the label is the signal's frequency,
// so the dial goes that far below it and the box shows the label's (518usb NAVTEX: dial
// 517.50, shown 518.00), as for a typed frequency. The shift is the box's own: the decoder
// offset, or the passband middle with a CW-like (narrow) filter.
// A PSK label sets its speed/type (PSK63, QPSK31…); an Olivia or Contestia label keeps the
// listener's last set-up of that family, else takes the family's default (as PhantomSDR-Plus).
// True when it changed something.
function labelSubApply(k, sub) {
  if (k === 'time') { if (timeStation() === sub) return false; lsSet('ubersdr_timestation', sub); return true; }
  if (k === 'psk31') { if (pskMode().key === sub) return false; lsSet('ubersdr_pskmode', sub); return true; }
  const wantC = sub === 'contestia';
  if (!!oliviaMode().c === wantC) return false;
  lsSet('ubersdr_olivia', String(wantC ? CONTESTIA_DEFAULT : 0)); return true;
}
function labelSignal(k) {
  const lf = Number(W.ubersdr_label_khz);
  if (st.on !== k || !(lf > 0)) return;
  const shift = (W.iscw() ? (Number(W.hi) + Number(W.lo)) / 2 : 0) + (W.ubersdr_dec_offset() || 0);
  if (shift > 0.0005 && Math.abs(dialKHz() - (lf - shift)) > 0.0005) { tuneKHz(lf - shift); applyFilter(k); }
}
// An RTTY label on a listed station with a shift of its own (DWD DDH47, 85 Hz) uses it, as
// a pick from the RTTY window's list does
function labelRttyShift(k) {
  const lf = Number(W.ubersdr_label_khz);
  if ((k !== 'rtty' && k !== 'weather') || st.on !== k || !(lf > 0)) return;
  const it = RTTY_FREQS[rttyVariant()].find((x) => Math.abs(x[1] - lf) < 0.01);
  rttyShift = (it && it[2]) || 0; rttySend(); applyFilter(k);
}
document.addEventListener('click', (e) => {
  const lab = e.target.closest && e.target.closest('.statinfo0, .statinfo0l');
  if (!lab) return;
  let k = labelMode(lab.innerHTML);
  if (!k) { if (st.on) stop(true); return; }
  if (k === 'ale') k = aleTarget(Number(W.ubersdr_label_khz) || dialKHz());   // HAM (FLDIGI) or SERVICES
  if (k === 'rade') {                           // RADE V1: on the label's sideband (setfreqm has set it)
    if (st.on) stop(true);
    const side = labelVariant;
    setTimeout(() => {
      try { if (W.ubersdr_rade && (!W.ubersdr_rade_side || W.ubersdr_rade_side() !== side)) W.ubersdr_rade(side); }
      catch (err) { console.error('decoders: label RADE', err); }
    }, 0);
    return;
  }
  if ((k === 'psk31' || k === 'olivia' || k === 'time') && labelSub && labelSubApply(k, labelSub) && st.on === k) {
    start(k); labelSignal(k); return;           // running in another sub-mode: restart in the label's
  }
  if (labelVariant) {                           // a modem / packet / RTTY label: that entry of the FLDIGI list
    const same = st.on === k && lsGet('ubersdr_rtty', 'ham') === labelVariant && !labelSub;   // kept as it is
    lsSet('ubersdr_rtty', labelVariant);
    const mf = /\bMFSK ?-?(16|32|64)\b/i.exec(lab.textContent || '');
    if (labelSub) lsSet('ubersdr_modem_mfsk', labelSub);
    else if (labelVariant === 'mfsk' && mf) lsSet('ubersdr_modem_mfsk', 'mfsk' + mf[1]);
    if (st.on === k && !same) { start(k); labelSignal(k); labelRttyShift(k); return; }
  }
  setTimeout(() => {                               // after setfreqm's tuning has settled
    try {
      const d = DEC[k], f = dialKHz(), near = d.dials ? nearest(d.dials, f) : null;
      const keepDial = near === null || Math.abs(near - f) > 2;
      if (st.on !== k) start(k, { keepDial });
      else {
        if (!keepDial && Math.abs(near - f) > 0.01) tuneKHz(near);
        applyFilter(k); lightPresets();
      }
      labelSignal(k); labelRttyShift(k);
    } catch (err) { console.error('decoders: label', err); }
  }, 0);
});

// Every received audio block (raw), from ubersdr-compat.js
W.ubersdr_dec_tap = function (pcm, sr) {
  if (!pcm || !pcm.length) return;
  if (sr && sr !== st.sr) { st.sr = sr; capReset(); }
  if (idEng) { try { idEng.feedPCM(pcm); } catch (e) {} }
  if (!st.on) return;
  try {
    const kind = DEC[st.on].kind;
    if (kind === 'ftx' || kind === 'js8') ftxFeed(pcm);
    else if (kind === 'wspr') wsprFeed(pcm);
    else if (kind === 'sstv' && sstv) sstv.feedPCM(pcm);
    else if (kind === 'fax' && fax) fax.feedPCM(pcm, st.sr);
    else if (kind === 'hfdl' && hfdl) hfdl.feedPCM(pcm);
    else if (kind === 'svc') { if (svc) svc.feedPCM(pcm); }
    else if (fsk) fsk.feedPCM(pcm);
  } catch (e) { console.error('decoders: feed', e); }
};

// AM, FM, CW or RADE chosen: the decoder stops (it needs USB, or LSB for SSTV)
let lastF = 0, lastBand = '', lastInfoF = 0;
setInterval(() => {
  if (!st.row) buildRow();
  buildPresets();
  idFollow();
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
  if (svcInfo && DEC[st.on] && DEC[st.on].kind === 'svc' && Math.abs(f - lastInfoF) > 0.0005) { lastInfoF = f; svcInfo(); }
  if (st.on === 'hfdl' && hfdl && Math.round(f * 1000) !== hfdlDial) { hfdlDial = Math.round(f * 1000); hfdl.setDial(hfdlDial); }
}, 500);
buildRow();
buildPresets();
W.ubersdr_decoders = { start, stop, state: () => ({ on: st.on, sr: st.sr, cap: { on: cap.on, len: cap.len, busy: cap.busy } }) };
