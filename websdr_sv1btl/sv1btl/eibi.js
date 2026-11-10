// EiBi schedule window for the SV1BTL WebSDR page (port 8901), after PhantomSDR-Plus's
// SW Schedule (frontend/src/lib/SwSchedule.svelte). The EiBi button sits next to SW in
// "Broadcast Station Information" (websdr-controls.html).
//
// Search the EiBi schedule (station, language, target area, band, UTC time, frequency,
// station country, transmitter country) and tune a row with one click: the mode of the
// row (AM, USB, LSB, CW), a decoder for FAX / NAVTEX / RTTY / RTTY-WX / HFDL (started as a
// station label does, sv1btl/decoders.js), DRM through the DRM button (ubersdr-compat.js).
// The waterfall is framed about ±50 kHz around the station, and a red label with the
// station's name marks it until the dial moves more than 200 Hz away.
// "Show on waterfall" puts the results on the scale as green labels.
// CW rows show as decoder rows (amber): tuning CW opens the CW decoder by itself.
//
// Data: sv1btl/eibi.json, written by eibi/update-eibi.sh (daily by cron, from
// http://www.eibispace.de/dx/).
(function () {
  'use strict';
  var W = window;
  var DATA_URL = 'sv1btl/eibi.json';
  var STORE_KEY = 'sv1btl.eibi';
  // The table draws PAGE rows at first and PAGE more each time it is scrolled near its
  // bottom, so every result can be reached; the waterfall labels use every result.
  var PAGE = 400;
  var PICK_HOLD_KHZ = 0.2;
  var VIEW_KHZ = 100;              // the waterfall span around a picked station

  var BANDS = [
    { key: '', label: 'Any' },
    { key: 'vlf', label: 'VLF / LF (below 148 kHz)', lo: 0, hi: 148 },
    { key: 'lw', label: 'Long Wave (148-279 kHz)', lo: 148, hi: 279 },
    { key: 'mw', label: 'Medium Wave (530-1700 kHz)', lo: 530, hi: 1700 },
    { key: 'sw', label: 'Standard Shortwave (2300-29999 kHz)', lo: 2300, hi: 29999 },
    { key: '120', label: '120 m (2300-2495 kHz)', lo: 2300, hi: 2495 },
    { key: '90', label: '90 m (3200-3400 kHz)', lo: 3200, hi: 3400 },
    { key: '75', label: '75 m (3900-4000 kHz)', lo: 3900, hi: 4000 },
    { key: '60', label: '60 m (4750-4995 kHz)', lo: 4750, hi: 4995 },
    { key: '49', label: '49 m (5900-6200 kHz)', lo: 5900, hi: 6200 },
    { key: '41', label: '41 m (7200-7450 kHz)', lo: 7200, hi: 7450 },
    { key: '31', label: '31 m (9400-9900 kHz)', lo: 9400, hi: 9900 },
    { key: '25', label: '25 m (11600-12100 kHz)', lo: 11600, hi: 12100 },
    { key: '22', label: '22 m (13570-13870 kHz)', lo: 13570, hi: 13870 },
    { key: '19', label: '19 m (15100-15800 kHz)', lo: 15100, hi: 15800 },
    { key: '16', label: '16 m (17480-17900 kHz)', lo: 17480, hi: 17900 },
    { key: '15', label: '15 m (18900-19020 kHz)', lo: 18900, hi: 19020 },
    { key: '13', label: '13 m (21450-21850 kHz)', lo: 21450, hi: 21850 },
    { key: '11', label: '11 m (25670-26100 kHz)', lo: 25670, hi: 26100 }
  ];
  var DAY_NAMES = ['', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var COLS = [['khz', 'kHz'], ['mode', 'Mode'], ['start', 'Start'], ['end', 'End'], ['station', 'Station'],
              ['site', 'Transmitter site'], ['lang', 'Language'], ['target', 'Target']];
  var PLAIN = { AM: 1, USB: 1, LSB: 1, CW: 1 };   // receiver modes (CW opens the CW decoder itself)
  function isDec(m) { return !(m === 'AM' || m === 'USB' || m === 'LSB'); }

  // ── filters (remembered per browser; "Show on waterfall" only for this page load) ──
  var DEF = { station: '', lang: '', target: '', band: '', country: '', site: '', khz: '', time: 'now',
              hh: '', mm: '', today: true, receivable: true, sort: 'khz', desc: false };
  var f = Object.assign({}, DEF);
  try {
    var saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && typeof saved === 'object') Object.keys(DEF).forEach(function (k) { if (k in saved) f[k] = saved[k]; });
  } catch (e) {}
  var onWf = false;
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(f)); } catch (e) {} }

  // ── state ──
  var data = null, rows = [], loadErr = '', loading = null;
  var results = [], shown = [], total = 0, onAir = 0, limit = PAGE, lastSig = '';
  var wfMarks = [];                 // [{ khz, mode, name, idx }] green labels
  var pick = null;                  // { khz, name, idx, shownKhz }
  var win = null, tbody = null, foot = null, clockEl = null, timer = null, tableEl = null;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (html != null) e.innerHTML = html;
    return e;
  }

  // ── data ──
  function load() {
    if (loading) return loading;
    loading = fetch(DATA_URL, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      data = d;
      var st = d.stations || [];
      rows = d.rows.map(function (r, i) {
        var site = r[8] || '';
        var o = { idx: i, khz: r[0], start: r[1], end: r[2], days: r[3] || '', itu: r[4],
          station: typeof r[5] === 'number' ? st[r[5]] || '' : r[5] || '',
          lang: r[6] || '', target: r[7] || '', site: site, host: site.split('-')[0] || r[4],
          mode: r[9] || 'AM', from: r[10] || '', to: r[11] || '', heard: r[12] || '' };
        o.langs = o.lang ? o.lang.split(',') : [];
        o.sLow = o.station.toLowerCase();
        return o;
      });
    }).catch(function (e) {
      loadErr = 'The EiBi schedule is not available on this station yet (' + (e && e.message ? e.message : e) +
        '). The sysop runs eibi/update-eibi.sh to fetch it.';
      loading = null;
    });
    return loading;
  }

  // ── helpers ──
  function countryName(c) { return data && data.country[c] ? data.country[c][0] : c; }
  function flag(c) {
    var iso = data && data.country[c] ? data.country[c][1] : '';
    if (!iso || iso.length !== 2) return '';
    return String.fromCodePoint(0x1f1e6 + iso.charCodeAt(0) - 65, 0x1f1e6 + iso.charCodeAt(1) - 65);
  }
  function hhmm(n) { return String(Math.floor(n / 100)).padStart(2, '0') + ':' + String(n % 100).padStart(2, '0'); }
  function toMin(n) { return Math.floor(n / 100) * 60 + (n % 100); }
  function langName(o) { return o.langs.map(function (l) { return data.lang[l] || l; }).join(', '); }
  function targetName(o) { return o.target ? data.target[o.target] || o.target : ''; }
  function siteName(o) {
    var name = data.site[o.site] || '', ctry = countryName(o.host);
    return name ? ctry + ', ' + name : ctry;
  }
  function daysText(d) {
    if (!d) return 'daily';
    if (/^[1-7]+$/.test(d)) return d.split('').map(function (c) { return DAY_NAMES[+c]; }).join(',');
    return d;
  }
  // The EiBi day field against a UTC weekday (1 = Monday) and date: true / false, or
  // null when it can't be told (irr, alt, 1.Sa, Ram, test…)
  function dayMatch(d, dow, date) {
    if (!d || d === 'USB' || d === 'LSB') return true;
    if (/^[1-7]+$/.test(d)) return d.indexOf(String(dow)) >= 0;
    var dm = d.match(/^(\d{1,2})([A-Z][a-z]{2})$/);
    if (dm) return +dm[1] === date.getUTCDate() && MONTHS.indexOf(dm[2]) === date.getUTCMonth();
    var any = false, toks = d.split(',');
    for (var i = 0; i < toks.length; i++) {
      var tok = toks[i];
      var range = tok.match(/^([A-Z][a-z])-([A-Z][a-z])$/);
      if (range) {
        var a = DAY_NAMES.indexOf(range[1]), b = DAY_NAMES.indexOf(range[2]);
        if (a < 1 || b < 1) return null;
        any = true;
        if (a <= b ? dow >= a && dow <= b : dow >= a || dow <= b) return true;
        continue;
      }
      if (/^([A-Z][a-z])+$/.test(tok)) {
        var names = tok.match(/[A-Z][a-z]/g);
        if (names.some(function (n) { return DAY_NAMES.indexOf(n) < 1; })) return null;
        any = true;
        if (names.some(function (n) { return DAY_NAMES.indexOf(n) === dow; })) return true;
        continue;
      }
      return null;
    }
    return any ? false : null;
  }
  // Entries valid for part of the season carry DDMM dates (no year)
  function dateOk(o, date) {
    if (!o.from && !o.to) return true;
    var y = data.season_year || date.getUTCFullYear();
    var winter = (data.season || '').charAt(0) === 'B';
    function toDate(s) {
      if (!/^\d{4}$/.test(s)) return null;
      var dd = +s.slice(0, 2), mm = +s.slice(2) - 1;
      return Date.UTC(winter && mm < 6 ? y + 1 : y, mm, dd);
    }
    var t = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    var a = toDate(o.from), b = toDate(o.to);
    if (a !== null && t < a) return false;
    if (b !== null && t > b) return false;
    return true;
  }
  // On air at UTC minute m of the date: the times, then the day the broadcast STARTED
  // (an evening broadcast running past midnight started the day before)
  function onAirAt(o, m, date) {
    var s = toMin(o.start), e = toMin(o.end), inTime, started = date;
    if (s === e) inTime = true;
    else if (s < e) inTime = m >= s && m < e;
    else {
      inTime = m >= s || m < e;
      if (m < e) started = new Date(date.getTime() - 86400000);
    }
    if (!inTime) return false;
    if (!dateOk(o, started)) return false;
    var dow = ((started.getUTCDay() + 6) % 7) + 1;
    return dayMatch(o.days, dow, started) !== false;
  }

  // This receiver's bands: [lo, hi] kHz, and the band index covering a frequency
  function bandOf(khz) {
    if (!W.bi) return -1;
    var n = W.nvbands || W.bi.length;
    for (var i = 0; i < n; i++) {
      var e = W.bi[i];
      if (e && khz > e.centerfreq - e.samplerate / 2 && khz < e.centerfreq + e.samplerate / 2) return i;
    }
    return -1;
  }
  function inRange(o) { return !W.bi || bandOf(o.khz) >= 0; }
  function dialShown() {
    try { return W.nominalfreq() + (W.decoderoffset ? W.decoderoffset() : 0); } catch (e) { return 0; }
  }

  // ── filtering ──
  function compute() {
    var now = new Date(), nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    var band = BANDS.find(function (b) { return b.key === f.band; });
    var st = String(f.station).trim().toLowerCase();
    var q = parseFloat(String(f.khz).replace(',', '.')), hasQ = isFinite(q) && q > 0;
    var atMin = null;
    if (f.time === 'now') atMin = nowMin;
    else if (f.time === 'at') {
      var h = parseInt(f.hh, 10), mi = parseInt(f.mm || '0', 10);
      if (isFinite(h) && h >= 0 && h < 24) atMin = h * 60 + (isFinite(mi) ? Math.min(59, Math.max(0, mi)) : 0);
    }
    var todayDow = ((now.getUTCDay() + 6) % 7) + 1;
    var out = [], air = 0;
    for (var i = 0; i < rows.length; i++) {
      var o = rows[i];
      if (band && band.key && !(o.khz >= band.lo && o.khz <= band.hi)) continue;
      if (hasQ && Math.abs(o.khz - q) > 2) continue;
      if (st && o.sLow.indexOf(st) < 0) continue;
      if (f.lang && o.langs.indexOf(f.lang) < 0) continue;
      if (f.target && o.target !== f.target) continue;
      if (f.country && o.itu !== f.country) continue;
      if (f.site && o.host !== f.site) continue;
      if (f.receivable && !inRange(o)) continue;
      if (f.today && (!dateOk(o, now) || dayMatch(o.days, todayDow, now) === false)) continue;
      if (atMin !== null && !onAirAt(o, atMin, now)) continue;
      o.live = onAirAt(o, nowMin, now);
      if (o.live) air++;
      out.push(o);
    }
    var dir = f.desc ? -1 : 1;
    var key = {
      khz: function (o) { return o.khz; }, mode: function (o) { return o.mode; },
      start: function (o) { return o.start; }, end: function (o) { return o.end; },
      station: function (o) { return o.sLow; }, lang: langName, target: targetName, site: siteName
    }[f.sort] || function (o) { return o.khz; };
    out.sort(function (a, b) {
      var x = key(a), y = key(b);
      if (x < y) return -dir;
      if (x > y) return dir;
      return a.khz - b.khz || a.start - b.start;
    });
    total = out.length; onAir = air;
    results = out;
  }

  // ── waterfall labels (merged into the station labels by fetchdx, ubersdr-compat.js) ──
  function labelFor(khz, mode, name, idx, cls) {
    var dec = PLAIN[mode] ? '' : mode === 'DRM' ? '' : '<span hidden data-dec="' + esc(mode) + '"></span>';
    var mo = mode === 'AM' || mode === 'DRM' ? 'am' : PLAIN[mode] ? mode.toLowerCase() : 'usb';
    return [khz, mo, '<span class="' + cls + '" data-eibi="' + idx + '" data-eibimode="' + esc(mode) + '">' +
      esc(name) + '</span>' + dec];
  }
  W.sv1btl_eibi_dx = function (min, max) {
    var out = [];
    for (var i = 0; i < wfMarks.length; i++) {
      var m = wfMarks[i];
      if (m.khz < min || m.khz > max) continue;
      if (pick && Math.abs(m.khz - pick.khz) < 0.001) continue;
      out.push(labelFor(m.khz, m.mode, m.name, m.idx, 'eibi-lab'));
    }
    if (pick && pick.khz >= min && pick.khz <= max) out.push(labelFor(pick.khz, pick.mode, pick.name, pick.idx, 'eibi-pick'));
    return out;
  };
  function refreshLabels() {
    try { if (W.waitingforwaterfalls === 0 && !W.hidedx) { W.dxs = []; W.fetchdx(W.band); } } catch (e) {}
  }
  function updateMarks() {
    var marks = [];
    if (onWf) {
      var seen = {};
      results.forEach(function (o) {
        var k = String(o.khz);
        if (!seen[k] || (o.live && !seen[k].live)) seen[k] = o;
      });
      Object.keys(seen).forEach(function (k) {
        var o = seen[k];
        marks.push({ khz: o.khz, mode: o.mode, idx: o.idx, name: o.station + (o.lang ? ' (' + o.lang + ')' : '') });
      });
    }
    var same = marks.length === wfMarks.length && marks.every(function (m, i) { return m.idx === wfMarks[i].idx; });
    wfMarks = marks;
    if (!same) refreshLabels();
  }

  // ── tuning ──
  function setPick(o, name) {
    pick = { khz: o.khz, mode: o.mode, idx: o.idx, name: name, shownKhz: null };
    // the box frequency once the tuning (and a decoder's own shift) has settled
    setTimeout(function () { if (pick && pick.idx === o.idx) pick.shownKhz = dialShown(); }, 800);
    refreshLabels();
    markRows();
  }
  function tune(o) {
    var b = bandOf(o.khz);
    if (b < 0) { status('Outside this receiver\'s range (' + o.khz + ' kHz).'); return; }
    var lab = labelFor(o.khz, o.mode, o.station, o.idx, 'eibi-tmp');
    // As a click on a station label: setfreqm (frequency, band, mode), then the label
    // listener of sv1btl/decoders.js starts the decoder its data-dec names, or stops one.
    var tmp = el('div', { 'class': 'statinfo0', style: 'display:none' }, lab[2]);
    tmp.onclick = function () { W.setfreqm(b, o.khz, lab[1]); };
    document.body.appendChild(tmp);
    try { tmp.click(); } finally { tmp.remove(); }
    // DRM: the DRM button of Mode row 2 (ubersdr-compat.js); another mode switches it off
    try {
      var xk = W.ubersdr_xmode_kind ? W.ubersdr_xmode_kind() : null;
      if (o.mode === 'DRM') { if (xk !== 'drm' && W.ubersdr_xmode) W.ubersdr_xmode('drm'); }
      else if (xk === 'drm' && W.ubersdr_xmode) W.ubersdr_xmode('drm');
    } catch (e) {}
    // frame the station: about VIEW_KHZ of waterfall around it
    try {
      var e = W.bi[b];
      var z = Math.max(0, Math.min(e.maxzoom, Math.floor(Math.log(e.samplerate / VIEW_KHZ) / Math.LN2)));
      W.wfset_freq(b, z, o.khz);
    } catch (err) {}
    setPick(o, o.station);
  }
  // A click on a green label: that station is the one being listened to
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest && ev.target.closest('.statinfo0');
    if (!t || t.classList.contains('eibi-tmp')) return;
    var s = t.querySelector('[data-eibi]');
    if (!s || s.classList.contains('eibi-tmp')) return;
    var o = rows[+s.getAttribute('data-eibi')];
    if (!o) return;
    var mode = s.getAttribute('data-eibimode');
    try {
      var xk = W.ubersdr_xmode_kind ? W.ubersdr_xmode_kind() : null;
      if (mode === 'DRM' && xk !== 'drm') W.ubersdr_xmode('drm');
      else if (mode !== 'DRM' && xk === 'drm') W.ubersdr_xmode('drm');
    } catch (e) {}
    setPick(o, o.station);
  });
  // The red label goes once the dial is more than PICK_HOLD_KHZ from the station
  setInterval(function () {
    if (!pick || pick.shownKhz == null) return;
    if (Math.abs(dialShown() - pick.shownKhz) > PICK_HOLD_KHZ) { pick = null; refreshLabels(); markRows(); }
  }, 500);

  // ── window ──
  var CSS = '' +
    '#eibiwin{position:absolute;z-index:10050;width:max-content;max-width:calc(100vw - 16px);box-sizing:border-box;' +
    'background:#f7f7f7;color:#022b08;border:1px solid #999;border-radius:6px;box-shadow:2px 4px 14px rgba(0,0,0,.35);' +
    'font:12px/1.3 Arial,Helvetica,sans-serif;text-align:left}' +
    '#eibiwin .ew-head{display:flex;align-items:center;gap:8px;padding:5px 8px;background:#dfe6e4;border-radius:6px 6px 0 0;cursor:move;user-select:none}' +
    '#eibiwin .ew-head b{font-size:13px}#eibiwin .ew-info{flex:1;color:#022b08;font-size:11px;white-space:nowrap}' +
    '#eibiwin .ew-x{border:0;background:none;font-size:16px;line-height:1;cursor:pointer;color:#022b08;padding:0 2px}#eibiwin .ew-x:hover{color:#000}' +
    '#eibiwin .ew-body{padding:6px 8px 6px}' +
    '#eibiwin .ew-filters{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px 8px;width:0;min-width:100%}' +
    '#eibiwin .ew-filters label{display:flex;flex-direction:column;gap:1px;color:#022b08;font-size:11px}' +
    '#eibiwin input,#eibiwin select{color:#022b08;font-size:11px;padding:1px 3px;min-width:0;box-sizing:border-box}' +
    '#eibiwin .ew-filters input:not([type]),#eibiwin .ew-filters select{width:100%}' +
    '#eibiwin .ew-row{display:flex;gap:3px;align-items:center}' +
    '#eibiwin .ew-hm{width:30px!important;text-align:center}' +
    '#eibiwin button.ew-b{color:#022b08;font-size:11px;padding:0 6px;height:19px;cursor:pointer;white-space:nowrap}' +
    '#eibiwin .ew-checks{display:flex;flex-wrap:wrap;align-items:center;gap:2px 14px;padding-top:5px;font-size:11px}' +
    '#eibiwin .ew-checks label{display:inline-flex;align-items:center;gap:3px;cursor:pointer}' +
    '#eibiwin .ew-checks .ew-reset{margin-left:auto}' +
    '#eibiwin .ew-table{margin-top:5px;max-height:min(52vh,520px);overflow:auto;border:1px solid #bbb;background:#fff}' +
    '#eibiwin table{border-collapse:collapse;width:100%;font-size:11px}' +
    '#eibiwin th{position:sticky;top:0;background:#e6e9ec;color:#022b08;text-align:left;padding:3px 5px;cursor:pointer;white-space:nowrap;border-bottom:1px solid #bbb}' +
    '#eibiwin th.sorted{color:#0a6fa8}' +
    '#eibiwin td{padding:2px 5px;border-top:1px solid #eee;white-space:nowrap;color:#022b08}' +
    '#eibiwin td.r{text-align:right}#eibiwin td.mono{font-family:monospace}' +
    '#eibiwin td.st,#eibiwin td.si{max-width:190px;overflow:hidden;text-overflow:ellipsis}#eibiwin td.sh{max-width:130px;overflow:hidden;text-overflow:ellipsis}' +
    '#eibiwin tbody tr{cursor:pointer}#eibiwin tbody tr:hover td{background:#cfe6f3;color:#000}' +
    '#eibiwin tr.live td{color:#044012}#eibiwin tr.live td.st{font-weight:bold}' +
    '#eibiwin tr.picked td{color:#d42020}#eibiwin tr.picked td.st{font-weight:bold}' +
    '#eibiwin tr.out td{opacity:.45}#eibiwin td.dec{color:#b07400;font-weight:bold}' +
    '#eibiwin .ew-foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px;padding-top:4px;font-size:11px;color:#022b08}' +
    '#eibiwin .ew-foot .on{color:#044012;font-weight:bold}#eibiwin .ew-msg{padding:4px 0;color:#a05a00}' +
    '@media (max-width:760px){#eibiwin .ew-filters{grid-template-columns:repeat(2,minmax(0,1fr))}}' +
    'html.ubersdr-dark #eibiwin{background:#2b3035;color:#dde2e7;border-color:#454b52}' +
    'html.ubersdr-dark #eibiwin .ew-head{background:#363c43}html.ubersdr-dark #eibiwin .ew-info{color:#aab2ba}' +
    'html.ubersdr-dark #eibiwin .ew-x{color:#aab2ba}html.ubersdr-dark #eibiwin .ew-x:hover{color:#fff}' +
    'html.ubersdr-dark #eibiwin .ew-filters label{color:#c4cbd2}html.ubersdr-dark #eibiwin :is(input,select,button.ew-b){color:revert}' +
    'html.ubersdr-dark #eibiwin .ew-table{background:#22262a;border-color:#454b52}' +
    'html.ubersdr-dark #eibiwin th{background:#31373d;color:#e4e8ec;border-bottom-color:#454b52}html.ubersdr-dark #eibiwin th.sorted{color:#00e1ff}' +
    'html.ubersdr-dark #eibiwin td{color:#a9b1b9;border-top-color:#3a4046}' +
    'html.ubersdr-dark #eibiwin tbody tr:hover td{background:#0e5a74;color:#fff}' +
    'html.ubersdr-dark #eibiwin tr.live td{color:#4ade80}html.ubersdr-dark #eibiwin tr.picked td{color:#f87171}' +
    'html.ubersdr-dark #eibiwin td.dec{color:#fbbf24}html.ubersdr-dark #eibiwin .ew-foot{color:#9aa2aa}' +
    'html.ubersdr-dark #eibiwin .ew-foot .on{color:#4ade80}html.ubersdr-dark #eibiwin .ew-msg{color:#fbbf24}' +
    // labels on the scale: green = results, red frame + yellow text = the station picked
    '.statinfo0:has(.eibi-lab){border-color:#22c55e!important;color:#4ade80!important}' +
    '.statinfo0:has(.eibi-pick){border-color:#ef4444!important;color:#facc15!important;background-color:rgba(120,20,20,.9)!important}' +
    '.statinfo2:has(.eibi-pick){z-index:5}';
  function injectCss() {
    if (document.getElementById('eibicss')) return;
    var s = el('style', { id: 'eibicss' }, CSS);
    document.head.appendChild(s);
  }

  function opts(list, cur) {
    var h = '<option value="">Any</option>';
    list.forEach(function (p) { h += '<option value="' + esc(p[0]) + '"' + (p[0] === cur ? ' selected' : '') + '>' + esc(p[1]) + '</option>'; });
    return h;
  }
  function sel(name, list) { return '<select data-f="' + name + '">' + opts(list, f[name]) + '</select>'; }

  function build() {
    injectCss();
    win = el('div', { id: 'eibiwin', role: 'dialog', 'aria-label': 'EiBi Schedule' });
    win.innerHTML = '<div class="ew-head"><b>EiBi Schedule</b><span class="ew-info">EiBi</span>' +
      '<button type="button" class="ew-x" title="Close (Esc)">✕</button></div><div class="ew-body"></div>';
    document.body.appendChild(win);
    clockEl = win.querySelector('.ew-info');
    win.querySelector('.ew-x').onclick = close;
    win.querySelector('.ew-head').addEventListener('pointerdown', dragStart);
  }

  function fill() {
    var body = win.querySelector('.ew-body');
    if (loadErr) { body.innerHTML = '<div class="ew-msg">' + esc(loadErr) + '</div>'; return; }
    if (!data) { body.innerHTML = '<div class="ew-msg">Loading the schedule…</div>'; return; }
    var by = function (a, b) { return a[1].localeCompare(b[1]); };
    var L = {}, T = {}, C = {}, S = {};
    rows.forEach(function (o) {
      o.langs.forEach(function (l) { L[l] = 1; });
      if (o.target) T[o.target] = 1;
      C[o.itu] = 1; S[o.host] = 1;
    });
    var langOpts = Object.keys(L).map(function (c) { return [c, data.lang[c] || c]; }).sort(by);
    var targetOpts = Object.keys(T).map(function (c) { return [c, data.target[c] || c]; }).sort(by);
    var countryOpts = Object.keys(C).map(function (c) { return [c, countryName(c)]; }).sort(by);
    var siteOpts = Object.keys(S).map(function (c) { return [c, countryName(c)]; }).sort(by);
    var names = Array.from(new Set(data.stations || [])).sort(function (a, b) { return a.localeCompare(b); });
    var bandOpts = BANDS.map(function (b) { return '<option value="' + b.key + '"' + (b.key === f.band ? ' selected' : '') + '>' + esc(b.label) + '</option>'; }).join('');
    var head = COLS.map(function (c) { return '<th data-sort="' + c[0] + '">' + c[1] + '</th>'; }).join('') + '<th>Days</th>';
    body.innerHTML =
      '<div class="ew-filters">' +
      '<label>Station<input data-f="station" list="eibi-stations" placeholder="Any" value="' + esc(f.station) + '">' +
      '<datalist id="eibi-stations">' + names.map(function (n) { return '<option value="' + esc(n) + '">'; }).join('') + '</datalist></label>' +
      '<label>Language' + sel('lang', langOpts) + '</label>' +
      '<label>Target area' + sel('target', targetOpts) + '</label>' +
      '<label>Band<select data-f="band">' + bandOpts + '</select></label>' +
      '<label>Station country' + sel('country', countryOpts) + '</label>' +
      '<label>Transmitter in' + sel('site', siteOpts) + '</label>' +
      '<label>Frequency (kHz, ±2)<span class="ew-row"><input data-f="khz" inputmode="decimal" placeholder="Any" value="' + esc(f.khz) + '">' +
      '<button type="button" class="ew-b" data-act="dial" title="Fill in the dial frequency">dial</button></span></label>' +
      '<label>Time (UTC)<span class="ew-row"><select data-f="time">' +
      [['any', 'Any time'], ['now', 'On air now'], ['at', 'On air at']].map(function (p) {
        return '<option value="' + p[0] + '"' + (p[0] === f.time ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('') +
      '</select><span class="ew-at"><input class="ew-hm" data-f="hh" inputmode="numeric" maxlength="2" placeholder="hh" value="' + esc(f.hh) + '">:' +
      '<input class="ew-hm" data-f="mm" inputmode="numeric" maxlength="2" placeholder="mm" value="' + esc(f.mm) + '"> ' +
      '<button type="button" class="ew-b" data-act="now" title="Current UTC time">now</button></span></span></label>' +
      '</div>' +
      '<div class="ew-checks">' +
      '<label title="Hide broadcasts not scheduled for today\'s UTC weekday or date"><input type="checkbox" data-f="today"' + (f.today ? ' checked' : '') + '> Today only</label>' +
      '<label title="Hide frequencies this receiver does not cover"><input type="checkbox" data-f="receivable"' + (f.receivable ? ' checked' : '') + '> Receivable here</label>' +
      '<label title="Show the results as green labels on the waterfall scale. They stay after the window closes; untick to remove them."><input type="checkbox" data-act="onwf"' + (onWf ? ' checked' : '') + '> Show on waterfall</label>' +
      '<button type="button" class="ew-b ew-reset" data-act="reset">Reset</button></div>' +
      '<div class="ew-table"><table><thead><tr>' + head + '</tr></thead><tbody></tbody></table></div>' +
      '<div class="ew-foot"><span class="ew-count"></span><span>Data: <a href="http://www.eibispace.de/dx/" target="_blank" rel="noopener">EiBi</a> (Eike Bierwirth)</span></div>';
    tbody = body.querySelector('tbody');
    tableEl = body.querySelector('.ew-table');
    tableEl.addEventListener('scroll', function () {
      if (limit >= results.length) return;
      if (tableEl.scrollTop + tableEl.clientHeight > tableEl.scrollHeight - 300) {
        var from = limit;
        limit += PAGE;
        shown = results.slice(0, limit);
        tbody.insertAdjacentHTML('beforeend', results.slice(from, limit).map(rowHtml).join(''));
        footText();
      }
    });
    lastSig = '';
    foot = body.querySelector('.ew-count');
    body.querySelectorAll('[data-f]').forEach(function (inp) {
      var k = inp.getAttribute('data-f');
      inp.addEventListener(inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input', function () {
        f[k] = inp.type === 'checkbox' ? inp.checked : inp.value;
        save(); render();
      });
    });
    body.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.onclick = function () {
        var k = th.getAttribute('data-sort');
        if (f.sort === k) f.desc = !f.desc; else { f.sort = k; f.desc = false; }
        save(); render();
      };
    });
    body.querySelector('[data-act="dial"]').onclick = function () {
      f.khz = String(Math.round(dialShown() * 10) / 10);
      body.querySelector('[data-f="khz"]').value = f.khz; save(); render();
    };
    body.querySelector('[data-act="now"]').onclick = function () {
      var n = new Date();
      f.hh = String(n.getUTCHours()).padStart(2, '0'); f.mm = String(n.getUTCMinutes()).padStart(2, '0'); f.time = 'at';
      body.querySelector('[data-f="hh"]').value = f.hh; body.querySelector('[data-f="mm"]').value = f.mm;
      body.querySelector('[data-f="time"]').value = 'at'; save(); render();
    };
    body.querySelector('[data-act="onwf"]').onchange = function (e) { onWf = e.target.checked; updateMarks(); };
    body.querySelector('[data-act="reset"]').onclick = function () {
      Object.assign(f, { station: '', lang: '', target: '', band: '', country: '', site: '', khz: '', time: 'now', hh: '', mm: '', today: true, receivable: true });
      save(); fill(); render();
    };
    tbody.addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-i]');
      if (tr) tune(rows[+tr.getAttribute('data-i')]);
    });
  }

  function tip(o) {
    var md = function (s) { return s.slice(0, 2) + ' ' + MONTHS[+s.slice(2) - 1]; };
    return [
      o.khz + ' kHz  ' + hhmm(o.start) + '-' + hhmm(o.end) + ' UTC  ' + daysText(o.days),
      o.station + '  (' + countryName(o.itu) + ')',
      o.lang ? 'Language: ' + langName(o) : '',
      o.target ? 'Target: ' + targetName(o) : '',
      'Transmitter: ' + siteName(o),
      o.from || o.to ? 'Valid: ' + (o.from ? md(o.from) : '…') + ' to ' + (o.to ? md(o.to) : '…') : '',
      o.heard ? 'Last logged: ' + (MONTHS[+o.heard.slice(0, 2) - 1] || '?') + ' 20' + o.heard.slice(2) : '',
      'Tunes in ' + o.mode + (o.mode === 'CW' ? ' (opens the CW decoder)' : PLAIN[o.mode] ? '' : o.mode === 'DRM' ? ' (switches DRM on)' : ' (starts the decoder)'),
      inRange(o) ? '' : 'Outside this receiver\'s range'
    ].filter(Boolean).join('\n');
  }

  function render() {
    if (!win || !data || !tbody) return;
    var at = win.querySelector('.ew-at');
    if (at) at.style.display = f.time === 'at' ? '' : 'none';
    compute();
    win.querySelectorAll('th[data-sort]').forEach(function (th) {
      var k = th.getAttribute('data-sort'), c = COLS.find(function (x) { return x[0] === k; });
      th.classList.toggle('sorted', f.sort === k);
      th.textContent = c[1] + (f.sort === k ? (f.desc ? ' ▾' : ' ▴') : '');
    });
    // New filters or sort: back to the first page. The 20 s clock re-renders too, and
    // must not undo the listener's scrolling.
    var sig = JSON.stringify(f);
    if (sig !== lastSig) { lastSig = sig; limit = PAGE; if (tableEl) tableEl.scrollTop = 0; }
    shown = results.slice(0, limit);
    var keep = tableEl ? tableEl.scrollTop : 0;
    var h = shown.map(rowHtml).join('');
    if (!shown.length) h = '<tr><td colspan="9" style="text-align:center;padding:8px">Nothing matches. Widen the filters (or untick “Today only”).</td></tr>';
    tbody.innerHTML = h;
    if (tableEl) tableEl.scrollTop = keep;
    footText();
    updateMarks();
  }
  function rowHtml(o) {
    var cls = (o.live ? 'live ' : '') + (pick && pick.idx === o.idx ? 'picked ' : '') + (inRange(o) ? '' : 'out');
    return '<tr data-i="' + o.idx + '" class="' + cls + '" title="' + esc(tip(o)) + '">' +
      '<td class="r mono">' + o.khz + '</td><td class="mono' + (isDec(o.mode) ? ' dec' : '') + '">' + esc(o.mode) + '</td>' +
      '<td class="mono">' + hhmm(o.start) + '</td><td class="mono">' + hhmm(o.end) + '</td>' +
      '<td class="st">' + esc(o.station) + '</td><td class="si">' + flag(o.host) + ' ' + esc(siteName(o)) + '</td>' +
      '<td class="sh">' + esc(langName(o)) + '</td><td class="sh">' + esc(targetName(o)) + '</td><td>' + esc(daysText(o.days)) + '</td></tr>';
  }
  function footText() {
    foot.innerHTML = total + ' result' + (total === 1 ? '' : 's') + (total > shown.length ? ' (' + shown.length + ' shown, scroll for more)' : '') +
      ' · <span class="on">' + onAir + ' on air now</span> · click a row to tune';
  }
  function markRows() {
    if (!tbody) return;
    tbody.querySelectorAll('tr[data-i]').forEach(function (tr) {
      tr.classList.toggle('picked', !!pick && pick.idx === +tr.getAttribute('data-i'));
    });
  }
  function status(msg) {
    if (!foot) return;
    foot.textContent = msg;
    setTimeout(render, 4000);
  }
  function tickClock() {
    if (!clockEl) return;
    var t = new Date().toISOString().slice(11, 16);
    clockEl.textContent = data ? 'EiBi ' + data.season + ' · ' + data.file_date + ' · ' + t + ' UTC' : 'EiBi';
  }

  // ── position & dragging (the page body is scaled with CSS zoom, ubersdr-compat.js) ──
  function pz() { var z = parseFloat(document.body.style.zoom); return z > 0 ? z : 1; }
  function setViewportPos(vx, vy) {
    var z = pz(), w = win.offsetWidth * z;
    var x = Math.max(8, Math.min(document.documentElement.clientWidth - w - 8, vx));
    win.style.left = (x + window.scrollX) / z + 'px';
    win.style.top = (Math.max(0, vy) + window.scrollY) / z + 'px';
  }
  var dragged = false;
  // Centred on the screen (the visible part of the page)
  function place() {
    var z = pz(), w = win.offsetWidth * z, h = win.offsetHeight * z;
    setViewportPos((document.documentElement.clientWidth - w) / 2, Math.max(8, (window.innerHeight - h) / 2));
  }
  var drag = null;
  function dragStart(e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    var r = win.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    window.addEventListener('pointermove', dragMove);
    window.addEventListener('pointerup', function () { drag = null; window.removeEventListener('pointermove', dragMove); }, { once: true });
    e.preventDefault();
  }
  function dragMove(e) { if (drag) { dragged = true; setViewportPos(e.clientX - drag.dx, e.clientY - drag.dy); } }

  function onKey(e) { if (e.key === 'Escape') close(); }
  function onOutside(e) {
    if (!win || drag) return;
    var t = e.target;
    if (win.contains(t)) return;
    if (t && t.closest && t.closest('[data-eibi-toggle]')) return;
    close();
  }
  function open() {
    if (!win) build();
    win.style.display = '';
    dragged = false;
    win.style.visibility = 'hidden';
    fill(); render(); tickClock(); place();
    win.style.visibility = '';
    timer = setInterval(function () { tickClock(); render(); }, 20000);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onOutside, true);
    var b = document.querySelector('[data-eibi-toggle]');
    if (b) b.setAttribute('aria-expanded', 'true');
    if (!data) { loadErr = ''; load().then(function () { if (isOpen()) { fill(); render(); tickClock(); if (!dragged) place(); } }); }
  }
  function close() {
    if (!win) return;
    win.style.display = 'none';
    clearInterval(timer); timer = null;
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('pointerdown', onOutside, true);
    var b = document.querySelector('[data-eibi-toggle]');
    if (b) b.setAttribute('aria-expanded', 'false');
  }
  function isOpen() { return !!win && win.style.display !== 'none'; }
  W.sv1btl_eibi_toggle = function () { if (isOpen()) close(); else open(); };
})();
