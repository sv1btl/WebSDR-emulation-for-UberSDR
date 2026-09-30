// ubersdr-compat.js — lets the RW3PS WebSDR layout run on UberSDR.
//
// The RW3PS websdr-base.js was written for PA3FWM's original sound client (with
// KA7OEI's DSP additions). UberSDR replaces that client with its own Opus player
// (websdr-sound.js, served by UberSDR and left untouched here), which only offers
// setparam / setvolume / smeter / getid / mute / destroy. This file adds the rest
// of what the RW3PS page calls, on top of UberSDR's player:
//
//   audioresume()      unlock audio after a click
//   setdelay1(n)       extra audio buffer ("Buffer" selector)
//   setstereo(v)       left / both / right output ("Out" selector)
//   sethboost(on)      +6 dB high-shelf at 1500 Hz ("Hi-Boost")
//   setnoise(level)    noise reduction, using UberSDR's websdr-nr.js engine
//   rec_start() etc.   audio recording to WAV
//   setnotch(n, on)    adaptive notch filters: 1 = "Autonotch", 2 = "Notch-2"
//   setparam2(on)      the RW3PS name for Notch-2
//   setparam('squelch=…')  squelch, done here because UberSDR's server accepts it but
//                      ignores it (Manual AGC / gain= was removed on 2026-09-30)
//
// It also replaces the single "HF" band button (UberSDR serves one 0–30 MHz band)
// with amateur-band shortcuts, and moves UberSDR's credit line to the bottom.
//
// Load order: tmp/bandinfo.js, this file, websdr-base.js, then
// ubersdr_compat_after_base() — see websdr-head.html.

(function () {
  'use strict';

  // ── Where a visitor starts ──────────────────────────────────────────────────
  // A returning visitor starts where they left off: the last frequency, mode and filter
  // are kept in this browser (localStorage 'ubersdr_last', shared by the desktop and the
  // mobile page). A first visit starts on startKHz/startMode from sv1btl/station.js
  // (7120 kHz LSB if not set). A ?tune=… link always wins.
  var STN = window.STATION || {};   // sv1btl/station.js (loaded just before this file)
  var START_KHZ = Number(STN.startKHz) || 7120, START_MODE = String(STN.startMode || 'lsb').toLowerCase();
  var POS_KEY = 'ubersdr_last';

  // Saved position, or null: { nom: kHz as displayed, mode: 'LSB'…, lo, hi }
  window.ubersdr_lastpos = function () {
    try {
      var p = JSON.parse(localStorage.getItem(POS_KEY));
      if (p && p.nom > 0 && p.nom < 30000 && /^(AM|FM|USB|LSB|CW)$/.test(p.mode) &&
          typeof p.lo === 'number' && typeof p.hi === 'number' && p.hi > p.lo) return p;
    } catch (e) {}
    return null;
  };
  var posTimer = null;
  window.ubersdr_savepos = function (nom, mode, lo, hi) {
    clearTimeout(posTimer);                // tuning by drag/wheel changes fast; save when it settles
    posTimer = setTimeout(function () {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({ nom: Math.round(nom * 100) / 100,
          mode: String(mode).toUpperCase(), lo: lo, hi: hi }));
      } catch (e) {}
    }, 500);
  };

  // Desktop page: tmp/bandinfo.js (loaded just before this file) comes from UberSDR with
  // no initial frequency (ini_freq=-1), so websdr-base.js would start on 15010 kHz.
  var tuneLink = /[?&]tune=/.test(window.location.search);
  var lastPos = tuneLink ? null : window.ubersdr_lastpos();
  if (window.bandinfo && bandinfo[0] && !tuneLink) {
    if (lastPos) {
      window.ini_freq = null;              // restored after start-up, see bodyonload below
      bandinfo[0].vfo = lastPos.nom;
    } else {
      window.ini_freq = START_KHZ;
      window.ini_mode = START_MODE;
      bandinfo[0].vfo = START_KHZ;         // so the first tune is not to 15010 kHz
    }
  }

  // ── Station details from sv1btl/station.js ──────────────────────────────────
  // Fills the page header (location, locator, callsign, e-mail), the "Switch to another
  // WebSDR" buttons and the mobile page title. Runs when the page has been read.
  window.ubersdr_station_fill = function () {
    function each(sel, fn) { var l = document.querySelectorAll(sel); for (var i = 0; i < l.length; i++) fn(l[i]); }
    if (!window.STATION) {       // station.js missing or not valid JavaScript (a typo): say so
      console.error('sv1btl/station.js is missing or has an error; using placeholders');
      each('[data-station="location"]', function (e) {
        var w = document.createElement('div');
        w.style.cssText = 'color:#c00;font-size:13px;font-weight:bold;';
        w.textContent = 'Station settings not loaded: sv1btl/station.js is missing or has a typo ' +
                        '(check quotes and commas; the browser console, F12, shows the line).';
        e.parentNode.parentNode.insertBefore(w, e.parentNode.nextSibling);
      });
    }
    function txt(v) { return v === undefined || v === null ? '' : String(v); }
    if (STN.location) each('[data-station="location"]', function (e) { e.textContent = txt(STN.location); });
    if (STN.callsign) each('[data-station="callsign"]', function (e) { e.textContent = txt(STN.callsign); });
    if (STN.locator) each('[data-station="locator"]', function (e) {
      e.textContent = txt(STN.locator);
      e.href = 'http://k7fry.com/grid/?qth=' + encodeURIComponent(txt(STN.locator));
    });
    if (STN.email) each('[data-station="email"]', function (e) {
      e.textContent = txt(STN.email);
      e.href = 'mailto:' + txt(STN.email) + '?subject=' + encodeURIComponent(txt(STN.callsign || '') + ' WebSDR');
    });
    var t = document.getElementById('otherwebsdrs');
    if (t) {
      var list = STN.otherWebSDRs || [], labels = ['Switch to', 'another', 'WebSDR'], per = 6;
      t.innerHTML = '';
      for (var r = 0; r * per < list.length; r++) {
        var tr = document.createElement('tr');
        tr.style.fontSize = '13px';
        var th = document.createElement('td');
        th.innerHTML = labels[r] ? '<b><em>' + labels[r] + '</em></b>' : '';
        tr.appendChild(th);
        for (var k = r * per; k < Math.min(list.length, (r + 1) * per); k++) {
          var td = document.createElement('td'), a = document.createElement('a');
          a.href = txt(list[k][1]); a.target = '_blank'; a.className = 'btnNorm';
          a.textContent = ' ' + txt(list[k][0]) + ' ';
          td.appendChild(a); tr.appendChild(td);
        }
        t.appendChild(tr);
      }
    }
    if (!document.getElementById('wfmode') && STN.mobileTitle) document.title = txt(STN.mobileTitle);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.ubersdr_station_fill);
  else window.ubersdr_station_fill();

  // ── Listener location in the users list (as on the RW3PS WebSDR) ─────────────
  // Each visitor's browser looks up its own country and city once a day and adds them
  // to the name it sends, so the users list reads e.g. "SV1ABC GR,Athens 7100.00", or
  // "GR,Athens 7100.00" for someone who has not typed a name. The name field and its
  // cookie are left alone. UberSDR's own GeoIP database is internal-only (no lookup the
  // page can call), so this uses a public HTTPS service; if both fail, no location is
  // shown — nothing else changes. Set GEO_SHOW_CITY = false to show the country only.
  var GEO_SHOW_CITY = STN.showListenerCity !== false, GEO_KEY = 'ubersdr_geo', GEO_MAX_AGE_MS = 24 * 3600 * 1000;
  var GEO_SERVICES = ['https://get.geojs.io/v1/ip/geo.json', 'https://ipwho.is/'];
  var geoTag = null;
  function geoMake(cc, city) {
    if (!/^[A-Z]{2}$/.test(cc || '')) return null;
    city = String(city || '').replace(/[^\w .\-\u00c0-\u024f\u0370-\u03ff]/g, '').trim().slice(0, 12);
    return GEO_SHOW_CITY && city ? cc + ',' + city : cc;
  }
  function geoResend() {
    // send the name again so the users list shows the location without waiting for a retune
    try { if (window.soundapplet && typeof window.send_soundsettings_to_server === 'function') send_soundsettings_to_server(); } catch (e) {}
  }
  (function geoLookup() {
    try {
      var c = JSON.parse(localStorage.getItem(GEO_KEY));
      if (c && Date.now() - c.t < GEO_MAX_AGE_MS) { geoTag = geoMake(c.cc, c.city); return; }
    } catch (e) {}
    function tryService(i) {
      if (i >= GEO_SERVICES.length) return;
      var xhr = new XMLHttpRequest();
      xhr.timeout = 5000;
      xhr.onload = function () {
        var d = null;
        try { d = JSON.parse(xhr.responseText); } catch (e) {}
        var tag = d && geoMake(d.country_code, d.city);
        if (!tag) { tryService(i + 1); return; }
        geoTag = tag;
        try { localStorage.setItem(GEO_KEY, JSON.stringify({ cc: d.country_code, city: d.city || '', t: Date.now() })); } catch (e) {}
        geoResend();
      };
      xhr.onerror = xhr.ontimeout = function () { tryService(i + 1); };
      xhr.open('GET', GEO_SERVICES[i], true);
      xhr.send(null);
    }
    tryService(0);
  })();
  // "SV1ABC 7100.00" → "SV1ABC GR,Athens 7100.00 LSB"; " 7100.00" → "GR,Athens 7100.00 LSB";
  // "mobile/Android" → "mobile/Android GR,Athens LSB". The mode at the end lets other
  // listeners' pages switch to it when they click this name (ubersdr_gotouser); the
  // server itself sends only the name and the position. UberSDR keeps 31 characters:
  // the city goes first, then the country, when the name is too long.
  var NAME_MODES = /\s(CW|LSB|USB|AM|FM)$/;
  function nameWithGeo(qs) {
    return qs.replace(/((?:^|&)name=)([^&]*)/, function (all, key, val) {
      var v; try { v = decodeURIComponent(val); } catch (e) { return all; }
      v = v.replace(NAME_MODES, '');
      var m = /^(.*?)(\s+\d+\.\d{2})?$/.exec(v), base = m[1].trim(), f = m[2] || '';
      if (geoTag) base = base.replace(geoTag, '').trim();
      var md = /^(CW|LSB|USB|AM|FM)$/.test(window.mode) ? ' ' + window.mode : '';
      function build(tag) { return [base, tag].filter(Boolean).join(' ') + f + md; }
      var out = build(geoTag || '');
      if (out.length > 31 && geoTag) out = build(geoTag.split(',')[0]);   // drop the city
      if (out.length > 31) out = build('');                               // drop the country
      if (out.length > 31) out = out.slice(0, 31);
      return key + encodeURIComponent(out);
    });
  }

  // ── Optional on-page error display: add ?ubersdr_debug to the URL ───────────
  if (/[?&]ubersdr_debug/.test(window.location.search)) {
    window.addEventListener('error', function (e) {
      var d = document.getElementById('ubersdr-debug');
      if (!d) {
        d = document.createElement('div');
        d.id = 'ubersdr-debug';
        d.style.cssText = 'position:fixed;bottom:0;left:0;right:0;max-height:40%;overflow:auto;' +
          'background:#300;color:#fff;font:12px monospace;padding:6px;z-index:100000;white-space:pre-wrap';
        (document.body || document.documentElement).appendChild(d);
      }
      d.textContent += (e.filename || '').replace(/^.*\//, '') + ':' + e.lineno + '  ' + e.message + '\n';
    });
  }

  // Buffer selector values from websdr-controls.html → scheduling lead in seconds.
  // UberSDR's player drops packets queued more than 1.5 s ahead, so 1.25 s is the top.
  var LEAD_FOR_DELAY = { 1000: 0.125, 2000: 0.25, 4000: 0.5, 8000: 1.0, 16000: 1.25 };

  // NR levels from the "DSP Noise Reduction" selector → websdr-nr peak-detection strength
  var NR_MULT = { 1: 0.1, 2: 0.3, 3: 0.5, 4: 0.8 };
  // …and how far noise is turned down (residual floor; the engine used to set it to
  // exact zero, which chopped weak speech and pauses into silence): -9/-14/-18/-23 dB
  var NR_FLOOR = { 1: 0.35, 2: 0.2, 3: 0.12, 4: 0.07 };

  // Settings survive a sound restart (the player is recreated on reconnect)
  var state = { lead: 0.125, stereo: -1, hboost: false, nr: 0, notch1: false, notch2: false,
                squelch: false, agcBoost: true };
  try { if (localStorage.getItem('ubersdr_agcboost') === '0') state.agcBoost = false; } catch (e) {}

  // ── Squelch ─────────────────────────────────────────────────────────────────
  // UberSDR's server stores squelch= but never applies it: its audio always comes
  // through radiod's AGC. Each audio packet does carry radiod's measurements from before
  // the AGC — the power in the passband (dB) and the noise density (dB/Hz) — and those
  // are enough to do it here:
  //  • Squelch: open while the (smoothed) passband power is SQL_OPEN_DB above the noise
  //    in the same bandwidth (radiod's noise density × filter width); stay open
  //    SQL_HANG_S after the signal drops.
  // Calibrated on this receiver (29 Sep 2026): ERT 729 kHz read +30…37 dB SNR; empty or
  // quiet bands mostly below +6 dB.
  var SQL_OPEN_DB = 8, SQL_CLOSE_DB = 4, SQL_HANG_S = 0.6;   // band noise reached +6 dB on 40m
  // Soft limiter on the output: peaks held to about -3 dBFS, 20 dB/s recovery, soft clip
  // above 80 % of full scale.
  var LIM_CEIL = 0.7, LIM_RELEASE_DBS = 20, LIM_KNEE = 0.8;

  // chans = decoded.channelData. UberSDR's decoder delivers two identical channels; the
  // level is measured on the first and the same gain is applied to every channel (only
  // the first used to be changed, so squelch left the right channel playing).
  // Weak-signal AGC (2026-09-30; on by default, off with its switch). UberSDR's own AGC keeps the band noise at about -35 dBFS and lets signals come
  // out in proportion to their strength (a strong SSB station ~ -20 dBFS), so a weak
  // station stays quiet. This raises a weak signal towards WAGC_TARGET_DB:
  //   - the level follows the audio at once when it rises, holds WAGC_HANG_S, then
  //     falls at WAGC_RELEASE_DBS, so the gain does not pump between words or sentences;
  //   - up to WAGC_MAX_DB while a signal stands WAGC_SNR_HI dB over the noise (held 2 s),
  //     at most WAGC_NOISE_MAX_DB on an empty channel (band hiss stays about where it was);
  //   - it only adds gain: strong signals are left alone (the limiter guards the peaks).
  var WAGC_TARGET_DB = -20, WAGC_MAX_DB = 15, WAGC_NOISE_MAX_DB = 3;
  var WAGC_HANG_S = 2, WAGC_RELEASE_DBS = 4, WAGC_SNR_LO = 3, WAGC_SNR_HI = 9;   // hang 2 s: SSB pauses do not raise the hiss
  function weakAgcGain(st, rms, snr, dt) {
    var now = Date.now(), lv = 20 * Math.log(rms + 1e-12) / Math.LN10;
    if (st.envDb === undefined || lv >= st.envDb) { st.envDb = lv; st.envT = now; }
    else if (now - st.envT > WAGC_HANG_S * 1000) st.envDb = Math.max(lv, st.envDb - WAGC_RELEASE_DBS * dt);
    if (st.sigDb === undefined || snr >= st.sigDb) { st.sigDb = snr; st.sigT = now; }
    else if (now - st.sigT > 2000) st.sigDb = Math.max(snr, st.sigDb - 15 * dt);   // falls before the gain can climb
    var k = Math.max(0, Math.min(1, (st.sigDb - WAGC_SNR_LO) / (WAGC_SNR_HI - WAGC_SNR_LO)));
    var maxDb = WAGC_NOISE_MAX_DB + (WAGC_MAX_DB - WAGC_NOISE_MAX_DB) * k;
    var gDb = Math.max(0, Math.min(maxDb, WAGC_TARGET_DB - st.envDb));
    st.boostDb = gDb;
    return Math.pow(10, gDb / 20);
  }

  function levelProcess(sa, chans) {
    var x = chans[0];
    var st = sa._lvl || (sa._lvl = { rms: 0, g: 1, lim: 1, sqlOpen: false, sqlUntil: 0, sqlGain: 1, bbS: null, f: null });
    var n = x.length, sum = 0, i;
    for (i = 0; i < n; i++) sum += x[i] * x[i];
    var rms = Math.sqrt(sum / Math.max(1, n));
    st.rms = st.rms ? 0.8 * st.rms + 0.2 * rms : rms;           // ~100 ms average
    var bb = sa._basebandPower, nd = sa._noiseDensity;
    var bwHz = Math.max(100, Math.abs((window.hi || 1) - (window.lo || 0)) * 1000);
    var noiseDb = nd + 10 * Math.log(bwHz) / Math.LN10;
    // Squelch: passband power smoothed over ~60 ms (restarts on retune) against the noise
    if (st.f !== window.freq || st.bbS === null) { st.f = window.freq; st.bbS = bb; }
    st.bbS = 0.7 * st.bbS + 0.3 * bb;
    var snr = st.bbS - noiseDb;
    window.ubersdr_level = { bb: bb, noiseDb: noiseDb, snr: snr, rmsDb: 20 * Math.log(st.rms + 1e-12) / Math.LN10 };

    // Weak-signal AGC
    var g = 1;
    if (state.agcBoost && bb > -998 && nd > -998) {
      g = weakAgcGain(st, rms, snr, n / (sa._decoderSR || 12000));
    } else st.boostDb = 0;
    // Squelch
    var sq = 1;
    if (state.squelch && bb > -998 && nd > -998) {
      var now = Date.now();
      if (snr >= SQL_OPEN_DB) { st.sqlOpen = true; st.sqlUntil = now + SQL_HANG_S * 1000; }
      else if (snr < SQL_CLOSE_DB && now > st.sqlUntil) st.sqlOpen = false;
      sq = st.sqlOpen ? 1 : 0;
    }
    // Soft limiter. With AGC off a strong station can come out far above full scale.
    // 1) Gain reduction: if this packet's peak would exceed LIM_CEIL, reduce at once;
    //    recover at LIM_RELEASE_DBS. 2) Soft clip: anything still above LIM_KNEE (fast
    //    peaks inside a packet) is bent smoothly towards full scale instead of cut off.
    var peak = 0;
    for (i = 0; i < n; i++) { var a = x[i] < 0 ? -x[i] : x[i]; if (a > peak) peak = a; }
    var want = peak * g * sq > LIM_CEIL ? LIM_CEIL / (peak * g * sq) : 1;
    var rel = Math.pow(10, LIM_RELEASE_DBS * (n / (sa._decoderSR || 12000)) / 20);
    st.lim = want < st.lim ? want : Math.min(want, st.lim * rel);
    // Ramp gain changes across the packet so there are no clicks; every channel alike
    var g0 = st.g * st.sqlGain * st.limPrev, g1 = g * sq * st.lim, osum = 0, opeak = 0;
    if (!(g0 === g0)) g0 = g1;                                // first packet
    // limiter attack: when the limiter turns the gain down, do it at once (a ramp from the
    // previous, higher gain let the start of loud packets overshoot); ramp only upwards
    if (st.lim < st.limPrev && g1 < g0) g0 = g1;
    for (var ch = 0; ch < chans.length; ch++) {
      var y = chans[ch], m = y.length;
      for (i = 0; i < m; i++) {
        var v = y[i] * (g0 + (g1 - g0) * (i + 1) / m), av = v < 0 ? -v : v;
        if (av > LIM_KNEE) {
          av = LIM_KNEE + (1 - LIM_KNEE) * Math.tanh((av - LIM_KNEE) / (1 - LIM_KNEE));
          v = v < 0 ? -av : av;
        }
        y[i] = v;
        if (ch === 0) { osum += v * v; if (av > opeak) opeak = av; }
      }
    }
    st.g = g; st.sqlGain = sq; st.limPrev = st.lim;
    window.ubersdr_level.outDb = 10 * Math.log(osum / Math.max(1, n) + 1e-24) / Math.LN10;
    window.ubersdr_level.sqlOpen = st.sqlOpen;
    window.ubersdr_level.outPeakDb = 20 * Math.log(opeak + 1e-12) / Math.LN10;
    window.ubersdr_level.limDb = 20 * Math.log(st.lim) / Math.LN10;
    window.ubersdr_level.boostDb = st.boostDb || 0;
  }


  // Switch for the weak-signal AGC (both pages); the choice is kept in this browser
  window.ubersdr_agcboost = function (on) {
    state.agcBoost = !!on;
    try { localStorage.setItem('ubersdr_agcboost', on ? '1' : '0'); } catch (e) {}
  };
  window.addEventListener('DOMContentLoaded', function () {
    var cb = document.getElementById('agcboostcheckbox');
    if (cb) cb.checked = state.agcBoost;
  });

  // ── Adaptive notch (normalised LMS) ─────────────────────────────────────────
  // UberSDR's server has no autonotch, so it runs here, in the browser, as it did in
  // KA7OEI's sound client for the original WebSDR. The filter predicts the input from
  // samples `delay` steps back: a steady tone (carrier, whistle) is predictable and
  // gets cancelled, while speech and noise are not and pass through.
  //   Autonotch: 64 taps, 16-sample delay, fast adaptation — catches a whistle in ~0.1 s
  //   Notch-2:  121 taps, 48-sample delay, slower and deeper (KA7OEI's settings)
  // Measured on noise + two tones: -32/-22 dB and -38/-29 dB on the tones; noise
  // level unchanged (±0.1 dB). Note it also removes a CW tone you are listening to.
  var NOTCH_SETTINGS = {
    1: { taps: 64, delay: 16, mu: 0.05, leak: 0.9999 },
    2: { taps: 121, delay: 48, mu: 0.01, leak: 0.99999 }
  };

  function LmsNotch(o) {
    this.taps = o.taps; this.delay = o.delay; this.mu = o.mu; this.leak = o.leak;
    this.n = o.taps + o.delay + 1;
    this.buf = new Float32Array(this.n);     // past input samples, ring buffer
    this.w = new Float32Array(o.taps);       // filter weights
    this.pos = 0;
    this.pow = 0;                            // sum of squares over the filter's input window
  }
  LmsNotch.prototype.process = function (x, out) {
    var n = this.n, taps = this.taps, d = this.delay, buf = this.buf, w = this.w;
    var mu = this.mu, leak = this.leak, pos = this.pos, pw = this.pow;
    for (var i = 0; i < x.length; i++) {
      var s = x[i], y = 0, k, j;
      j = pos - d; if (j < 0) j += n;
      for (k = 0; k < taps; k++) { y += w[k] * buf[j]; if (--j < 0) j = n - 1; }
      var e = s - y;                         // input minus its predictable (tonal) part
      var g = mu * e / (pw + 1e-6);
      j = pos - d; if (j < 0) j += n;
      for (k = 0; k < taps; k++) { w[k] = leak * w[k] + g * buf[j]; if (--j < 0) j = n - 1; }
      if (++pos >= n) pos = 0;
      buf[pos] = s;
      var jin = pos - d; if (jin < 0) jin += n;
      var jout = jin - taps; if (jout < 0) jout += n;
      pw += buf[jin] * buf[jin] - buf[jout] * buf[jout];
      if (pw < 0) pw = 0;
      out[i] = (e === e) ? e : 0;            // NaN guard
    }
    this.pos = pos; this.pow = pw;
  };


  // ── Audio graph ─────────────────────────────────────────────────────────────
  // UberSDR:  sources → gain → destination
  // here:     sources → gain → [NR] → high-shelf → L/R gains → merger → destination

  function buildChain(sa) {
    var ctx = sa._audioCtx;
    var c = {
      ctx: ctx,
      shelf: ctx.createBiquadFilter(),
      splitter: ctx.createChannelSplitter(2),
      gainL: ctx.createGain(),
      gainR: ctx.createGain(),
      merger: ctx.createChannelMerger(2),
      nr: null
    };
    c.shelf.type = 'highshelf';
    c.shelf.frequency.value = 1500;
    c.shelf.connect(c.splitter);
    c.splitter.connect(c.gainL, 0);
    c.splitter.connect(c.gainR, 1);
    c.gainL.connect(c.merger, 0, 0);
    c.gainR.connect(c.merger, 0, 1);
    c.merger.connect(ctx.destination);
    sa._compat = c;
    applySettings(sa);
  }

  function applySettings(sa) {
    var c = sa._compat;
    if (!c || !sa._gainNode) return;
    c.shelf.gain.value = state.hboost ? 6 : 0;
    c.gainL.gain.value = (state.stereo == 1) ? 0 : 1;              // 1 = right only
    c.gainR.gain.value = (state.stereo == -1 || state.stereo == 1) ? 1 : 0;  // -1 = both, 0 = left only

    var wantNR = state.nr > 0 && window.websdrNR;
    try { sa._gainNode.disconnect(); } catch (e) {}
    if (c.nr) { try { c.nr.disconnect(); } catch (e) {} c.nr = null; }
    if (c.anf) { try { c.anf.disconnect(); } catch (e) {} c.anf = null; }

    // gain → [notch] → [NR] → high-shelf …
    var head = sa._gainNode;
    if (state.notch1 || state.notch2) {
      // The filters keep their state (weights) while the page runs, so switching one
      // back on does not have to adapt from scratch.
      if (!c.notch1) c.notch1 = new LmsNotch(NOTCH_SETTINGS[1]);
      if (!c.notch2) c.notch2 = new LmsNotch(NOTCH_SETTINGS[2]);
      var tmp = new Float32Array(512);
      c.anf = c.ctx.createScriptProcessor(512, 1, 2);    // 512 samples: ~43 ms at 12 kHz
      c.anf.onaudioprocess = function (e) {
        var x = e.inputBuffer.getChannelData(0), out = e.outputBuffer.getChannelData(0);
        if (tmp.length !== x.length) tmp = new Float32Array(x.length);
        var src = x;
        if (state.notch1) { c.notch1.process(src, tmp); src = tmp; }
        if (state.notch2) { c.notch2.process(src, out); src = out; }
        if (src !== out) out.set(src);
        e.outputBuffer.getChannelData(1).set(out);
      };
      head.connect(c.anf);
      head = c.anf;
    }
    if (wantNR) {
      window.websdrNR.reset();
      window.websdrNR.setEnabled(true);
      window.websdrNR.setSquelch(false);
      window.websdrNR.setMult(NR_MULT[state.nr] || 0.3);
      if (window.websdrNR.setFloor) window.websdrNR.setFloor(NR_FLOOR[state.nr] || 0.2);
      syncNRBins(sa, true);
      // 4096-sample blocks are what the NR engine is built for (see websdr-nr.js)
      c.nr = c.ctx.createScriptProcessor(4096, 1, 2);
      c.nr.onaudioprocess = function (e) {
        var input = e.inputBuffer.getChannelData(0);
        var out = window.websdrNR.process(input);
        if (out === null) out = input;
        e.outputBuffer.getChannelData(0).set(out);
        e.outputBuffer.getChannelData(1).set(out);
      };
      head.connect(c.nr);
      c.nr.connect(c.shelf);
    } else {
      if (window.websdrNR) window.websdrNR.setEnabled(false);
      head.connect(c.shelf);
    }
  }

  var nrBW = 0;
  function syncNRBins(sa, force) {
    if (!window.websdrNR || !sa._audioCtx || typeof window.lo !== 'number') return;
    var bw = Math.abs(window.hi - window.lo) * 1000;
    if (!force && bw === nrBW) return;
    nrBW = bw;
    window.websdrNR.syncBins(bw, sa._audioCtx.sampleRate);
  }

  var nrLoading = false;
  function loadNR(cb) {
    if (window.websdrNR) { cb(); return; }
    if (nrLoading) return;
    nrLoading = true;
    var s = document.createElement('script');
    s.src = 'sv1btl/websdr-nr.js?v=20260930a';   // our copy, with the residual floor
    s.onload = cb;
    s.onerror = function () { console.error('ubersdr-compat: could not load sv1btl/websdr-nr.js'); };
    document.head.appendChild(s);
  }

  // ── Recording (mono 16-bit, at the stream's sample rate) ────────────────────
  function recPush(sa, decoded) {
    var r = sa._rec;
    var f = decoded.channelData[0];
    var pcm = new Int16Array(f.length);
    for (var i = 0; i < f.length; i++) {
      var v = f[i] * 32767;
      pcm[i] = v > 32767 ? 32767 : (v < -32768 ? -32768 : v);
    }
    r.chunks.push(pcm.buffer);
    r.bytes += pcm.byteLength;
    if (!r.sr) r.sr = sa._decoderSR;
  }

  // ── Methods added to UberSDR's player ───────────────────────────────────────
  // The hooks below rely on internal functions of UberSDR's websdr-sound.js. After an
  // UberSDR update one of them could be renamed: then that hook is skipped (and named in
  // window.ubersdr_compat_missing and the browser console) while the page itself, and
  // plain listening, keep working. sv1btl/../check-after-update.sh tests for them too.
  function patch(proto) {
    if (proto._ubersdrCompat) return;
    proto._ubersdrCompat = true;
    var missing = [];
    function has(name) { if (typeof proto[name] === 'function') return true; missing.push(name); return false; }

    if (has('_onMessage')) {
    var origOnMessage = proto._onMessage;
    proto._onMessage = function (buf) {
      if (buf.byteLength >= 21) this._noiseDensity = new DataView(buf).getFloat32(17, true);
      origOnMessage.call(this, buf);
    };
    }

    if (has('_ensureAudio')) {
    var origEnsureAudio = proto._ensureAudio;
    proto._ensureAudio = function (sampleRate) {
      origEnsureAudio.call(this, sampleRate);
      // UberSDR makes a new AudioContext whenever the stream's sample rate changes
      if (this._audioCtx && (!this._compat || this._compat.ctx !== this._audioCtx)) buildChain(this);
    };
    }

    if (has('_playDecoded')) {
    var origPlay = proto._playDecoded;
    proto._playDecoded = function (decoded) {
      var ctx = this._audioCtx;
      if (ctx && ctx.state === 'running' && this._nextPlayTime < ctx.currentTime) {
        this._nextPlayTime = ctx.currentTime + state.lead;   // refill to the chosen buffer depth
      }
      if (state.squelch || state.agcBoost || this._lvl) {
        if (decoded.channelData.length) levelProcess(this, decoded.channelData);
        if (!(state.squelch || state.agcBoost)) this._lvl = null;   // all off again
      }
      if (this._rec) recPush(this, decoded);
      if (state.nr > 0) syncNRBins(this, false);
      origPlay.call(this, decoded);
    };
    }

    proto.audioresume = function () {
      if (this._audioCtx) this._audioCtx.resume().catch(function () {});
      var b = document.getElementById('audiostartbutton');
      if (b) b.style.display = 'none';
    };

    proto.setdelay1 = function (n) {
      state.lead = LEAD_FOR_DELAY[n] || 0.125;
      // Take effect now rather than at the next underrun
      var ctx = this._audioCtx;
      if (ctx && this._nextPlayTime < ctx.currentTime + state.lead) this._nextPlayTime = ctx.currentTime + state.lead;
    };
    proto.setdelay = proto.setdelay1;

    proto.setstereo = function (v) { state.stereo = Number(v); applySettings(this); };
    proto.sethboost = function (on) { state.hboost = !!Number(on); applySettings(this); };

    proto.setnoise = function (level) {
      var self = this;
      state.nr = Number(level) || 0;
      if (state.nr > 0) loadNR(function () { applySettings(window.soundapplet || self); });
      else applySettings(this);
    };

    // squelch= still goes to the server (harmless) but is acted on here
    var origSetparam = has('setparam') ? proto.setparam : function () {};
    proto.setparam = function (qs) {
      var m;
      if ((m = /(?:^|&)squelch=([0-9]+)/.exec(qs))) state.squelch = m[1] !== '0';
      origSetparam.call(this, nameWithGeo(qs));
    };

    proto.setnotch = function (which, on) {
      state['notch' + which] = !!Number(on);
      applySettings(this);
    };
    proto.setparam2 = function (on) { this.setnotch(2, on); };   // RW3PS: Notch-2

    proto.rec_start = function () { this._rec = { chunks: [], bytes: 0, sr: 0 }; };
    proto.rec_length_kB = function () { return this._rec ? this._rec.bytes / 1024 : 0; };
    proto.rec_finish = function () {
      var r = this._rec || { chunks: [], bytes: 0, sr: 0 };
      this._rec = null;
      return { sr: r.sr || this._decoderSR || 12000, len: r.bytes, wavdata: r.chunks };
    };

    window.ubersdr_compat_missing = missing;
    if (missing.length) console.warn('ubersdr-compat: UberSDR sound player lacks ' + missing.join(', ') +
      ' — the related extras (notch, NR, Hi-Boost, L/R, squelch, weak-signal AGC, recording) may not work');
  }

  // websdr-base.js declares `var soundapplet`, and UberSDR's websdr-sound.js assigns
  // window.soundapplet. Catching the assignment lets the player be patched before the
  // page calls any of the methods above.
  var current = null;
  Object.defineProperty(window, 'soundapplet', {
    configurable: true,
    get: function () { return current; },
    set: function (v) {
      current = v;
      if (v && typeof v === 'object' && typeof v.getid === 'function') patch(Object.getPrototypeOf(v));
    }
  });

  // ── Amateur-band buttons ────────────────────────────────────────────────────
  // [label, lowest kHz, highest kHz, tune kHz, mode]
  var HAM_BANDS = (STN.hamBands && STN.hamBands.length) ? STN.hamBands : [
    ['MW',   531,   1602,   729,    'AM'],
    ['160m', 1810,  2000,   1910,   'LSB'],
    ['80m',  3500,  3800,   3685,   'LSB'],
    ['60m',  5351.5, 5366.5, 5357,  'USB'],
    ['40m',  7000,  7200,   7120,   'LSB'],
    ['30m',  10100, 10150,  10120,  'CW'],
    ['20m',  14000, 14350,  14280,  'USB'],
    ['17m',  18068, 18168,  18130,  'USB'],
    ['15m',  21000, 21450,  21350,  'USB'],
    ['12m',  24890, 24990,  24940,  'USB'],
    ['10m',  28000, 29700,  28585,  'USB']
  ];

  window.ubersdr_gotoband = function (i) {
    var hb = HAM_BANDS[i];
    var e = bi[band];
    if (hb[3] < e.centerfreq - e.samplerate / 2 || hb[3] > e.centerfreq + e.samplerate / 2) return;
    set_mode(hb[4]);
    setfreq(hb[3]);
    // Zoom the waterfall to show the whole band (same arithmetic as wfset(3))
    var width = hb[2] - hb[1], z = 0;
    while (2 * width < e.samplerate && z < e.maxzoom) { z++; width *= 2; }
    wfset_freq(band, z, (hb[1] + hb[2]) / 2);
    var btns = document.getElementsByClassName('btnBand');
    for (var k = 0; k < btns.length; k++) btns[k].classList.toggle('btn-selected', btns[k].id === 'btnHam-' + i);
  };

  // QSY: the button of the band the frequency is in stays selected (none outside the
  // bands). Only the highlight changes: no zoom, no mode change.
  function bandLight() {
    if (typeof nominalfreq !== 'function') return;
    var f = nominalfreq(), idx = -1;
    for (var i = 0; i < HAM_BANDS.length; i++) if (f >= HAM_BANDS[i][1] && f <= HAM_BANDS[i][2]) { idx = i; break; }
    var btns = document.getElementsByClassName('btnBand');
    for (var k = 0; k < btns.length; k++) btns[k].classList.toggle('btn-selected', btns[k].id === 'btnHam-' + idx);
  }

  // ── Chatbox ─────────────────────────────────────────────────────────────────
  // UberSDR's WebSDR server takes a new message as a POST to /~~chat (fields name and
  // text) and gives the messages back from GET /~~chat?chseq=N as
  //   chat_chseq=…; chat_msgs=["…", …];
  // The page script still sends a GET with ?name=&msg= (which the server reads as "list
  // the messages", so the message was lost) and waits for chatnewline() calls in the
  // users-list reply, which UberSDR never sends. Both are done the UberSDR way here; the
  // lines still go through the page's chatnewline(), so its spam filter keeps working.
  // At page load the server's last 20 messages are shown.
  var CHAT_POLL_MS = 3000;
  window.addEventListener('load', function () {
    if (!document.getElementById('chatboxnew') || !document.chatform) return;   // desktop page only
    var chseq = 0, busy = false;
    function poll() {
      if (busy) return;
      busy = true;
      var x = new XMLHttpRequest();
      x.open('GET', '/~~chat?chseq=' + chseq, true);
      x.onloadend = function () {
        busy = false;
        if (x.status !== 200 || !x.responseText) return;
        var r;
        try { r = new Function(x.responseText + '\nreturn [chat_chseq, chat_msgs];')(); } catch (e) { return; }
        if (typeof r[0] === 'number') chseq = r[0];
        var msgs = r[1] || [];
        for (var i = 0; i < msgs.length; i++) {
          var line = String(msgs[i]).replace(/\n+$/, '');
          if (line && typeof window.chatnewline === 'function') window.chatnewline(line);
        }
      };
      x.send(null);
    }
    window.sendchat = function () {
      if (typeof window.timeout_idle_restart === 'function') try { timeout_idle_restart(); } catch (e) {}
      var text = document.chatform.chat.value;
      if (!text.trim()) return false;
      var name = (document.usernameform && document.usernameform.username.value) || '';
      var x = new XMLHttpRequest();
      x.open('POST', '/~~chat', true);
      x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      x.onloadend = function () { setTimeout(poll, 200); };   // show it at once
      x.send('name=' + encodeURIComponent(name) + '&text=' + encodeURIComponent(text));
      document.chatform.chat.value = '';
      return false;
    };
    poll();
    setInterval(poll, CHAT_POLL_MS);
  });

  window.ubersdr_compat_after_base = function () {
    var origBandButtons = window.document_bandbuttons;
    window.document_bandbuttons = function () {
      if (nbands > 1) { origBandButtons(); return; }
      var s = '';
      for (var i = 0; i < HAM_BANDS.length; i++) {
        s += '<button type="button" class="btnBand" name="group1" id="btnHam-' + i +
             '" onclick="ubersdr_gotoband(' + i + ')">' + HAM_BANDS[i][0] + '</button>';
      }
      s += '<button type="button" class="btnBand" name="group1" onclick="wfset(4)" title="whole receiver range">All</button>';
      document.write(s);
    };
    // Returning visitor: restore mode, filter and frequency. The carrier is set directly:
    // tuning through setfreqif/setfreqb would apply RW3PS's automatic mode-per-frequency
    // table (7030 kHz → LSB) and the standard filter. It is applied at start-up and again
    // once the audio has connected, because soundappletstarted2 then re-tunes the page
    // (and passes the carrier where a displayed frequency is expected, which would move a
    // CW signal by (hi+lo)/2). From then on every retune and mode/filter change is saved.
    var origBodyonload = window.bodyonload, posReady = false;
    function applyPos(p) {
      set_mode(p.mode);
      setmf(p.mode.toLowerCase(), p.lo, p.hi);
      var carrier = p.nom - (iscw() ? (hi + lo) / 2 : 0);
      setwaterfall(band, carrier);
      setfreq(carrier);
    }
    window.bodyonload = function () {
      origBodyonload.apply(this, arguments);
      if (lastPos) applyPos(lastPos);
      posReady = true;
      bandLight();
    };
    var origSound2 = window.soundappletstarted2, soundRestored = false;
    window.soundappletstarted2 = function () {
      origSound2.apply(this, arguments);
      if (lastPos && !soundRestored) { soundRestored = true; applyPos(lastPos); }
    };
    function savePos() { if (posReady) window.ubersdr_savepos(nominalfreq(), mode, lo, hi); }
    var origSetfreq = window.setfreq;
    window.setfreq = function (f) { origSetfreq.apply(this, arguments); savePos(); bandLight(); };
    var origSetmf = window.setmf;
    window.setmf = function () { origSetmf.apply(this, arguments); savePos(); bandLight(); };
    // Clicking a listener in the users strip: tune to the exact frequency they are on
    // (the RW3PS click also shifted it by this page's own passband offset) and switch to
    // their mode — sent at the end of their name by these pages; for other clients the
    // amateur band's usual mode, else the current one.
    window.ubersdr_gotouser = function (i) {
      var b = uu_bands[i], e = bi[b];
      if (!e) return;
      var f = uu_freqs[i] * e.samplerate + e.centerfreq - e.samplerate / 2;
      // the position is sent with ~30 Hz steps; these pages also put the exact frequency
      // in the name ("… 7120.00 LSB"), so use that when it matches
      var nf = /\s(\d+\.\d{2})(?:\s(?:CW|LSB|USB|AM|FM))?$/.exec(uu_names[i] || '');
      f = (nf && Math.abs(nf[1] - f) < 1) ? Number(nf[1]) : Math.round(f * 100) / 100;
      var mm = NAME_MODES.exec(uu_names[i] || ''), mo = mm ? mm[1] : null;
      if (!mo) for (var k = 0; k < HAM_BANDS.length; k++) if (f >= HAM_BANDS[k][1] && f <= HAM_BANDS[k][2]) { mo = HAM_BANDS[k][4]; break; }
      if (b !== band) setband(b);
      if (mo && mo !== mode) set_mode(mo);
      setwaterfall(band, f);
      setfreq(f);
    };
    var origDouu = window.douu;
    window.douu = function () {
      origDouu.apply(this, arguments);
      for (var i = 0; i < uu_names.length; i++) {
        var d = document.getElementById('user' + i), btn = d && d.querySelector('button');
        if (btn) btn.onclick = (function (n) { return function () { ubersdr_gotouser(n); }; })(i);
      }
    };
    var origUpdbw = window.updbw;
    window.updbw = function () { origUpdbw.apply(this, arguments); savePos(); };

    // Station labels on the waterfall scale. UberSDR's /~~fetchdx answers in a format
    // (stationinfo=[...]) that websdr-base.js does not read, so the labels come from
    // sv1btl/stationinfo.txt instead, in the original WebSDR format, one per line:
    //   <freq kHz><mode> <text>      e.g.  1188am R. Nikolas (GR)   or   28074usb FT8<br>JT65
    // mode is am/fm/usb/lsb/cw (any case); lines starting with # are comments. The file
    // is re-read on each band/zoom change, so edits show after a page reload.
    window.fetchdx = function (b) {
      var e = bi[b];
      var min = e.effcenterfreq - e.effsamplerate / 2, max = e.effcenterfreq + e.effsamplerate / 2;
      var xhr = new XMLHttpRequest();
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        dxs = [];
        if (xhr.status === 200) {
          var list = [];
          var lines = xhr.responseText.split(/\r?\n/);
          for (var i = 0; i < lines.length; i++) {
            var m = /^\s*([0-9]+(?:\.[0-9]*)?)\s*([a-zA-Z]*)\s+(.+?)\s*$/.exec(lines[i]);
            if (!m || lines[i].charAt(0) === '#') continue;
            var f = parseFloat(m[1]);
            if (f < min || f > max) continue;
            var mo = m[2].toLowerCase();
            if (!/^(am|fm|usb|lsb|cw)$/.test(mo)) mo = f < 10000 ? 'lsb' : 'usb';
            list.push([f, mo, m[3]]);
          }
          list.sort(function (p, q) { return p[0] - q[0]; });   // showdx expects ascending order
          for (var j = 0; j < list.length; j++) dx(list[j][0], list[j][1], list[j][2]);
        }
        showdx(b);
      };
      xhr.open('GET', 'sv1btl/stationinfo.txt', true);
      xhr.setRequestHeader('Cache-Control', 'no-cache');
      xhr.send(null);
    };

    // Squelch: keep only the on/off. RW3PS's setsquelch also widened the SSB filter
    // (a workaround for the original server's squelch) and did not restore it.
    window.setsquelch = function (a) { if (soundapplet) soundapplet.setparam('squelch=' + Number(a)); };

    // Autonotch: RW3PS asks the server (autonotch=), which UberSDR ignores; run the
    // browser notch instead
    window.setautonotch = function (a) { if (soundapplet && soundapplet.setnotch) soundapplet.setnotch(1, a); };

    // RW3PS looks up the visitor's location on ip-api.com and redirects to a page
    // this site does not have; not wanted here.
    window.ip2geo = function () {};

    // Mouse positions for a horizontally stretched waterfall (see matchWidths below).
    // Everything that tunes or drags — websdr-base.js and UberSDR's websdr-waterfall.js —
    // works in the waterfall's own 1024-pixel space and reads the pointer through
    // getMouseXY, so dividing x by the stretch factor keeps every drag in step with the
    // pointer. Click-to-tune also subtracts the waterfall's on-screen left edge, which
    // has to be divided the same way.
    var origGetMouseXY = window.getMouseXY;
    window.getMouseXY = function (e) {
      var p = origGetMouseXY(e);
      return { x: p.x / wfScale, y: p.y };
    };
    window.useMouseXY = function (e) {
      var pos = getMouseXY(e);
      var coords = scaleobj.offsetParent.getBoundingClientRect();
      setfreq_lim((pos.x - coords.left / wfScale - 512) * khzperpixel + centerfreq - (hi + lo) / 2);
      if (initmodeflag == 1) modeperfreq(freq);
      return cancelEvent(e);
    };
    // Type selector: "spectrum" is drawn in the PhantomSDR-Plus style (see specSetType)
    var origWaterfallmode = window.waterfallmode;
    window.waterfallmode = function (m) { specSetType(m, origWaterfallmode); };

    // RW3PS left a resize handler pointing at a function it had commented out
    window.stretch_waterfalls = function () {};
  };

  // ── One width for waterfall, users strip and chat: the controls panel's ─────
  // The waterfall is 1024 pixels of data from the server; it is stretched to fit
  // with a CSS transform. The users strip is redrawn at the full width by douu()
  // in websdr-base.js (window.ubersdr_width), so its labels are not stretched.
  var wfScale = 1;

  function matchWidths() {
    var panel = document.querySelector('.mb[style*="min-width: 1160px"]');
    if (!panel) return true;          // not the desktop page (m.html): nothing to match
    var w = Math.round(panel.getBoundingClientRect().width);
    if (w <= 1024) return false;
    wfScale = w / 1024;
    window.ubersdr_width = w;
    var frames = document.getElementsByClassName('users-bg');   // waterfall frame and users list
    for (var i = 0; i < frames.length; i++) frames[i].style.width = w + 'px';
    var wfc = document.getElementById('wfcontainer');
    if (wfc) {
      wfc.style.transformOrigin = '0 0';
      wfc.style.transform = 'scaleX(' + wfScale + ')';
    }
    var chat = document.getElementById('chatboxnew');
    if (chat) { chat.style.width = w + 'px'; chat.style.boxSizing = 'border-box'; }
    if (typeof douu === 'function' && window.usersobj) douu();
    return true;
  }
  // The page stays hidden (display:none) until its LESS stylesheet is compiled, so
  // there is nothing to measure at load time; retry until the panel has a width.
  var matchTries = 0;
  function matchWhenVisible() {
    if (!matchWidths() && ++matchTries < 100) setTimeout(matchWhenVisible, 200);
  }
  window.addEventListener('load', matchWhenVisible);

  // ── Waterfall brightness / contrast, manual and automatic brightness ─────────
  // The RW3PS colours come from a CSS filter on the waterfall:
  //   brightness(b) contrast(c) url(#svgGradientMap)
  // #svgGradientMap turns each pixel into its luminance and looks that up in a colour
  // table (dark blue → cyan → yellow → red). Auto brightness measures the newest
  // waterfall lines and sets b so that the noise floor sits on dark blue; signals keep
  // their natural range above it (set by the Contrast slider), so a quiet band stays
  // quiet instead of having its noise stretched up to red.
  // (On 2026-09-29 the waterfall briefly used the spectrum's colours with a colour table
  // rebuilt while listening; that was reverted to this, at the user's request.)

  var WF_NOISE_PCT = 0.50, WF_NOISE_T = 0.10;   // median pixel (the noise floor) → dark blue (was 0.20 until 2026-09-29)
  // Auto contrast (2026-09-29): brightness and contrast are fitted together so that
  //   - the noise floor (median pixel) sits on WF_NOISE_T,
  //   - the noise grain (WF_GRAIN_PCT pixel) stays below WF_GRAIN_MAX, so a quiet band
  //     is not stretched into bright speckle,
  //   - strong signals (WF_SIG_PCT pixel) come close to WF_SIG_T (yellow → orange,
  //     short of the saturated red end).
  var WF_GRAIN_PCT = 0.85, WF_GRAIN_MAX = 0.22;
  var WF_SIG_PCT = 0.997, WF_SIG_T = 0.70;
  var WF_C_MIN = 0.8, WF_C_MAX = 3;
  // Wide views (all 0–30 MHz, more than WF_WIDE_KHZ across): each pixel covers many kHz,
  // so most pixels hold signals and the 85 % pixel is a signal, not noise grain. There the
  // grain limit is left out (it dimmed the whole picture) and the floor sits a bit higher.
  var WF_WIDE_KHZ = 2000, WF_NOISE_T_WIDE = 0.15;
  function wfWide() { var e = window.bi && bi[window.band]; return !!(e && e.effsamplerate > WF_WIDE_KHZ); }
  var WF_AUTO_INTERVAL = 2000;                  // ms between measurements

  var wfB = 1, wfC = 1, wfAutoTimer = null;

  function wfFilter() {
    return 'brightness(' + Math.round(wfB * 100) + '%) contrast(' + Math.round(wfC * 100) + '%) url("#svgGradientMap")';
  }
  function wfApply() {
    var f = wfFilter(), divs = document.querySelectorAll('[id^="wfcdiv"]');
    for (var i = 0; i < divs.length; i++) divs[i].style.filter = f;
  }

  function wfShowSliders() {
    var b = document.getElementById('wf-brightness2'), c = document.getElementById('wf-contrast2');
    if (b) b.value = Math.round(wfB * 100);
    if (c) c.value = Math.round(wfC * 100);
  }

  // One colour channel (0..1) through the filter chain up to the colour table lookup.
  function srgbToLinear(x) { return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
  function linearToSrgb(y) { return y <= 0.0031308 ? 12.92 * y : 1.055 * Math.pow(y, 1 / 2.4) - 0.055; }
  function bc(x, b, c) {
    x = Math.min(1, x * b);                       // brightness()
    x = (x - 0.5) * c + 0.5;                      // contrast()
    return x < 0 ? 0 : (x > 1 ? 1 : x);
  }
  // Position in the colour table: CSS filter functions work in sRGB; the feColorMatrix
  // (saturate 0) in #svgGradientMap works in linear RGB; the table lookup in sRGB again.
  function tablePos(r, g, b, B, C) {
    var y = 0.213 * srgbToLinear(bc(r, B, C)) + 0.715 * srgbToLinear(bc(g, B, C)) + 0.072 * srgbToLinear(bc(b, B, C));
    return linearToSrgb(y);
  }

  // Colour histogram of the newest waterfall lines (the palette has at most 256 colours).
  // UberSDR's websdr-waterfall.js scrolls the picture up and draws each new line at the
  // bottom, so the bottom rows are the last few seconds; rows above may still show the
  // picture from before a zoom or retune.
  var WF_ROWS = 40;
  function wfHistogram() {
    var hist = {}, total = 0;
    var canvases = document.querySelectorAll('#wfcdiv0 canvas');   // desktop and mobile page alike
    for (var k = 0; k < canvases.length; k++) {
      var cv = canvases[k];
      if (!cv.width || !cv.height) continue;
      var d;
      var rows = Math.min(WF_ROWS, cv.height);
      try { d = cv.getContext('2d').getImageData(0, cv.height - rows, cv.width, rows).data; } catch (e) { continue; }
      for (var i = 0; i < d.length; i += 4 * 2) {          // every 2nd pixel is plenty
        var key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        if (key === 0) continue;                            // not yet drawn
        hist[key] = (hist[key] || 0) + 1;
        total++;
      }
    }
    var list = [];
    for (var h in hist) list.push([((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255, hist[h]]);
    return { list: list, total: total };
  }

  // Colour-table positions at brightness B, contrast C of the noise floor (median pixel),
  // the noise grain and the strong signals
  function wfLevels(list, total, B, C) {
    var pts = [];
    for (var i = 0; i < list.length; i++) pts.push([tablePos(list[i][0], list[i][1], list[i][2], B, C), list[i][3]]);
    pts.sort(function (a, b) { return a[0] - b[0]; });
    var want = [WF_NOISE_PCT * total, WF_GRAIN_PCT * total, WF_SIG_PCT * total], out = [], acc = 0, w = 0;
    for (var j = 0; j < pts.length && w < 3; j++) {
      acc += pts[j][1];
      while (w < 3 && acc >= want[w]) { out.push(pts[j][0]); w++; }
    }
    while (out.length < 3) out.push(pts[pts.length - 1][0]);
    return { noise: out[0], grain: out[1], sig: out[2] };
  }
  // How far a setting is from the goals; the dark noise floor matters most. A small
  // preference for normal contrast decides between settings that look about the same
  // (a quiet band has only a few waterfall levels, so many settings score alike).
  function wfCost(L, C) {
    var wide = wfWide();
    return 4 * Math.abs(L.noise - (wide ? WF_NOISE_T_WIDE : WF_NOISE_T)) +
           (wide ? 0 : 6 * Math.max(0, L.grain - WF_GRAIN_MAX)) +
           Math.abs(L.sig - WF_SIG_T) +
           0.05 * Math.abs(Math.log(C));
  }
  var WF_HYST = 0.04;   // a new setting must beat the current one by this much

  // Best brightness 10–500 % and contrast 80–300 % (a zoomed-in waterfall arrives from
  // UberSDR much darker than the full-band view): coarse grid, then a finer one around it
  var WF_B_MIN = 0.1, WF_B_MAX = 5;   // min was 0.3; lowered with WF_NOISE_T (2026-09-29)
  function wfBestFit(h) {
    var best = null;
    function tryBC(B, C) {
      if (B < WF_B_MIN || B > WF_B_MAX || C < WF_C_MIN || C > WF_C_MAX) return;
      var L = wfLevels(h.list, h.total, B, C), cost = wfCost(L, C);
      if (!best || cost < best.cost) best = { B: B, C: C, cost: cost, noise: L.noise, grain: L.grain, sig: L.sig };
    }
    var i, j, lb = Math.log(WF_B_MIN), rb = Math.log(WF_B_MAX / WF_B_MIN), lc = Math.log(WF_C_MIN), rc = Math.log(WF_C_MAX / WF_C_MIN);
    for (i = 0; i <= 30; i++) for (j = 0; j <= 8; j++) tryBC(Math.exp(lb + rb * i / 30), Math.exp(lc + rc * j / 8));
    var B0 = best.B, C0 = best.C, sb = Math.exp(rb / 30), sc = Math.exp(rc / 8);
    for (i = -4; i <= 4; i++) for (j = -4; j <= 4; j++) tryBC(B0 * Math.pow(sb, i / 4), C0 * Math.pow(sc, j / 4));
    return best;
  }

  // After a zoom, pan or mode change the bottom rows still hold the old picture until
  // WF_ROWS new lines have arrived: about 10 lines/s at "fast", slower in proportion to
  // waterslowness (1 fast, 2 medium, 4 slow).
  var wfViewKey = '', wfHoldUntil = 0;
  function wfViewChanged() {
    var e = window.bi && window.bi[window.band];
    var key = e ? e.effcenterfreq + '/' + e.effsamplerate + '/' + window.watermode : '';
    if (key === wfViewKey) return false;
    wfViewKey = key;
    wfHoldUntil = Date.now() + (WF_ROWS / 10) * 1000 * (window.waterslowness || 1) + 500;
    return true;
  }

  function wfAutoStep() {
    if (window.view === 3) return;                              // waterfall off
    if (wfViewChanged() || Date.now() < wfHoldUntil) return;
    var h = wfHistogram();
    if (h.total < 5000 || h.list.length < 4) return;           // waterfall still filling
    var fit = wfBestFit(h);
    // Small corrections are eased in so the picture does not flicker, tiny ones are
    // ignored; after a retune or zoom, when the current setting is clearly off, jump
    // straight to the new one.
    var now = wfLevels(h.list, h.total, wfB, wfC), nowCost = wfCost(now, wfC);
    window.ubersdr_wfauto_last = { fit: fit, now: now, nowCost: nowCost, colours: h.list.length, pixels: h.total };
    if (fit.cost > nowCost - WF_HYST) return;                  // current setting is good enough
    var off = Math.max(Math.abs(now.noise - fit.noise), Math.abs(now.sig - fit.sig) / 3);
    var k = off > 0.08 ? 1 : 0.4;
    wfB = Math.exp((1 - k) * Math.log(wfB) + k * Math.log(fit.B));
    wfC = Math.exp((1 - k) * Math.log(wfC) + k * Math.log(fit.C));
    wfApply();
    wfShowSliders();
  }

  window.ubersdr_wfprobe = { hist: wfHistogram, levels: wfLevels };   // for testing

  function wfSetAuto(on, remember) {
    var cb = document.getElementById('wfautocheckbox');
    if (cb) cb.checked = on;
    if (wfAutoTimer) { clearInterval(wfAutoTimer); wfAutoTimer = null; }
    if (on) {
      wfViewChanged(); wfHoldUntil = 0;           // measure straight away when switched on
      wfAutoStep();
      wfAutoTimer = setInterval(wfAutoStep, WF_AUTO_INTERVAL);
    }
    if (remember) try { localStorage.setItem('ubersdr_wfauto', on ? '1' : '0'); } catch (e) {}
  }
  window.ubersdr_wfauto = function (on) { wfSetAuto(!!on, true); };

  // The RW3PS slider handlers each replaced the whole filter, so moving one slider
  // undid the other; these apply both. Auto sets both sliders, so moving either one
  // switches auto off and leaves the picture where the visitor put it.
  function wfManual(which) {
    wfC = (Number(document.getElementById('wf-contrast2').value) || 100) / 100;
    wfB = (Number(document.getElementById('wf-brightness2').value) || 100) / 100;
    if (wfAutoTimer) wfSetAuto(false, true);
    wfApply();
  }
  window.addEventListener('load', function () {
    window.wfbright = function () { wfManual('b'); };
    window.wfcontrast = function () { wfManual('c'); };
    var saved = null;
    try { saved = localStorage.getItem('ubersdr_wfauto'); } catch (e) {}
    if (saved !== '0') wfSetAuto(true, false);   // on by default; off only if this visitor switched it off
  });

  // ── Spectrum in the PhantomSDR-Plus style (Type = spectrum) ─────────────────
  // Drawn the way sv1btl/PhantomSDR-Plus draws it (frontend/src/waterfall.js,
  // drawSpectrum): black background, fill coloured by HEIGHT with its rainbow map,
  // white trace, a faint grid every 10 dB with labels on the right, 50/50 smoothing
  // between lines, and a dashed crosshair with the frequency on mouse hover.
  // The data is the newest waterfall line: with "spectrum" chosen the waterfall script
  // keeps running (hidden under this canvas), and each new line's colours are turned
  // back into levels with the waterfall's own colour table. So the spectrum always
  // matches what the waterfall would show (zoom, weak/strong signals).
  // UberSDR maps dBFS to levels as (dBFS + calibration + 120) × 255 / 100; the grid is
  // labelled in dBFS with WF_CAL_DB = server.websdr_waterfall_calibration in UberSDR's
  // config.yaml (12 on this receiver).
  // The vertical scale follows the noise floor, as PhantomSDR-Plus's follows its
  // waterfall window: bottom = floor - SPEC_BELOW_DB, top = bottom + SPEC_RANGE_DB.
  var WF_CAL_DB = (typeof STN.waterfallCalibration === 'number') ? STN.waterfallCalibration : 12, SPEC_ALPHA = 0.5, SPEC_BELOW_DB = 10, SPEC_RANGE_DB = 70;
  var SPLIT_H = 100;   // spectrum height (px) in Type = spectrum + waterfall
  var spec = { on: false, split: false, canvas: null, ctx: null, row: null, lvl: null, filt: null,
               view: '', hoverX: null, grad: null, gradH: 0, dirty: true, minDb: null };
  function lvlToDb(l) { return l * 100 / 255 - 120 - WF_CAL_DB; }

  // Waterfall colour → level (the standard WebSDR table, as in websdr-waterfall.js)
  var palIndex = (function () {
    var E = new Uint8Array(256), F = new Uint8Array(256), G = new Uint8Array(256), e, m = {};
    for (e = 0; e < 64; e++) { E[e] = 0; F[e] = 0; G[e] = 2 * e; }
    for (; e < 128; e++) { E[e] = 3 * e - 192; F[e] = 0; G[e] = 2 * e; }
    for (; e < 192; e++) { E[e] = e + 64; F[e] = 256 * Math.sqrt((e - 128) / 64); G[e] = 511 - 2 * e; }
    for (; e < 256; e++) { E[e] = 255; F[e] = 255; G[e] = 512 + 2 * e; }
    for (e = 255; e >= 0; e--) m[(E[e] << 16) | (F[e] << 8) | G[e]] = e;
    return m;
  })();

  // PhantomSDR-Plus spectrum colour map (its scStops): 0 = noise floor … 255 = strongest
  var specColormap = (function () {
    var st = [[0, [0, 0, 51]], [1, [0, 0, 77]], [14, [0, 45, 183]], [30, [0, 158, 255]],
              [46, [0, 255, 255]], [92, [255, 255, 0]], [124, [255, 128, 0]],
              [156, [255, 0, 0]], [255, [179, 0, 0]]];
    var out = [];
    for (var i = 0; i < 256; i++) {
      var a = st[0], b = st[st.length - 1];
      for (var k = 0; k < st.length - 1; k++) if (i >= st[k][0] && i <= st[k + 1][0]) { a = st[k]; b = st[k + 1]; break; }
      var f = b[0] > a[0] ? (i - a[0]) / (b[0] - a[0]) : 0;
      out.push([Math.round(a[1][0] + (b[1][0] - a[1][0]) * f), Math.round(a[1][1] + (b[1][1] - a[1][1]) * f),
                Math.round(a[1][2] + (b[1][2] - a[1][2]) * f)]);
    }
    return out;
  })();

  function specBuildGrad(h) {                 // one colour per canvas row, bottom = 0
    var g = new Uint8ClampedArray(h * 4), d = h - 1;
    for (var row = 0; row < h; row++) {
      var t = d > 0 ? (h - 1 - row) / d : 0, x = 255 * t;
      var i0 = Math.max(0, Math.min(255, Math.floor(x))), i1 = Math.min(255, i0 + 1), fr = x - i0;
      var c0 = specColormap[i0], c1 = specColormap[i1];
      g[row * 4] = c0[0] + (c1[0] - c0[0]) * fr;
      g[row * 4 + 1] = c0[1] + (c1[1] - c0[1]) * fr;
      g[row * 4 + 2] = c0[2] + (c1[2] - c0[2]) * fr;
      g[row * 4 + 3] = 255;
    }
    spec.grad = g; spec.gradH = h;
  }

  // Text on this canvas is stretched with the waterfall (see matchWidths); undo that
  function specText(ctx, text, x, y, align) {
    ctx.save(); ctx.translate(x, y); ctx.scale(1 / wfScale, 1);
    ctx.textAlign = align; ctx.fillText(text, 0, 0); ctx.restore();
  }

  function specCanvas() {
    var wfdiv = document.getElementById('wfdiv0'), wfc = document.getElementById('wfcdiv0');
    if (!wfdiv || !wfc) return null;
    if (!spec.canvas || spec.canvas.parentNode !== wfdiv) {
      // outside #wfcdiv0, so the waterfall's colour filter does not recolour it; the
      // mouse passes through to the waterfall (tuning, dragging, wheel zoom)
      var c = document.createElement('canvas');
      c.id = 'ubersdr-spectrum';
      c.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:3;display:none;';
      wfdiv.style.position = 'relative';
      wfdiv.appendChild(c);
      spec.canvas = c; spec.ctx = c.getContext('2d'); spec.dirty = true;
    }
    if (!wfc._ubersdrHover) {                   // crosshair follows the mouse
      wfc._ubersdrHover = true;
      wfc.addEventListener('mousemove', function (ev) {
        var r = wfc.getBoundingClientRect();
        spec.hoverX = (ev.clientX - r.left) / wfScale; spec.dirty = true;
      });
      wfc.addEventListener('mouseleave', function () { spec.hoverX = null; spec.dirty = true; });
    }
    if (!spec.canvas._ubersdrHover) {           // the panel of spectrum + waterfall
      var sc = spec.canvas;
      sc._ubersdrHover = true;
      sc.addEventListener('mousemove', function (ev) {
        var r = sc.getBoundingClientRect();
        spec.hoverX = (ev.clientX - r.left) / wfScale; spec.dirty = true;
      });
      sc.addEventListener('mouseleave', function () { spec.hoverX = null; spec.dirty = true; });
      sc.addEventListener('click', function (ev) {   // click on the spectrum tunes there
        if (spec.split) tuneAtClientX(sc, ev.clientX);
      });
    }
    specLayout(wfdiv, wfc);
    var w = 1024, h = spec.split ? SPLIT_H : (wfc.clientHeight || 100);
    if (spec.canvas.width !== w || spec.canvas.height !== h) {
      spec.canvas.width = w; spec.canvas.height = h; spec.dirty = true;
    }
    return spec.canvas;
  }

  // Frequency under the mouse: x across element el, which must span exactly the view
  // (the spectrum canvas or the waterfall canvas — not #wfcdiv0, which is wider than the
  // picture and the frequency scale)
  function freqAtClientX(el, clientX) {
    var e = window.bi && bi[window.band];
    if (!e) return null;
    var r = el.getBoundingClientRect();
    if (!r.width) return null;
    return e.effcenterfreq - e.effsamplerate / 2 + (clientX - r.left) / r.width * e.effsamplerate;
  }
  // A click tunes to the nearest whole or half kHz, by the hundredths of the displayed
  // frequency: .00–.40 → .00, .41–.60 → .50, .61–.99 → the next whole kHz
  // (7100.40 → 7100.00, 7100.41 → 7100.50, 7100.61 → 7101.00).
  function snapKHz(f) {
    var h = Math.round(f * 100), k = Math.floor(h / 100), c = h - k * 100;
    return c <= 40 ? k : (c <= 60 ? k + 0.5 : k + 1);
  }
  function tuneTo(f) {
    if (f === null) return;
    f = snapKHz(f);                           // the displayed frequency
    if (iscw()) f -= (hi + lo) / 2;           // CW: the carrier sits beside it
    setfreq(Math.round(f * 1000) / 1000);
  }
  function tuneAtClientX(el, clientX) { tuneTo(freqAtClientX(el, clientX)); }

  // Desktop page: a click on the waterfall tunes there, like a click on the spectrum.
  // The waterfall script uses a mouse press to start dragging the view, so only a press
  // released without moving (under 4 px) counts as a click; dragging and wheel zoom stay.
  // (On the mobile page tuning is done by dragging the waterfall, so it is left alone.)
  window.addEventListener('load', function () {
    if (!document.getElementById('wfmode')) return;           // not the desktop page
    var down = null;
    document.addEventListener('mousedown', function (ev) {
      var wfc = document.getElementById('wfcdiv0'), cv = wfc && wfc.querySelector('canvas');
      if (ev.button !== 0 || !cv || !wfc.contains(ev.target)) { down = null; return; }
      // the frequency is taken now, before the waterfall script starts moving the view
      down = { x: ev.clientX, y: ev.clientY, f: freqAtClientX(cv, ev.clientX) };
    }, true);
    document.addEventListener('mouseup', function (ev) {
      var d = down; down = null;
      if (!d || ev.button !== 0) return;
      if (Math.abs(ev.clientX - d.x) > 4 || Math.abs(ev.clientY - d.y) > 4) return;   // a drag
      tuneTo(d.f);
    }, true);
  });

  // ── Frequency display: tune digit by digit (desktop page) ────────────────────
  // Over a digit of the big frequency display: the mouse wheel steps the frequency by
  // that digit's place (7120.00: the "1" = 100 kHz, the last "0" = 0.01 kHz), a left
  // click steps it up and a right click down. The digit under the mouse is underlined.
  // A click on the free space beside the digits still lets you type a frequency; while
  // typing, the digits do not step.
  window.addEventListener('load', function () {
    if (!document.getElementById('wfmode')) return;           // not the desktop page
    var inp = document.freqform && document.freqform.frequency;
    if (!inp || !inp.parentNode) return;
    var box = inp.parentNode;
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    var bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;height:3px;background:#98ffee;border-radius:2px;' +
      'box-shadow:0 0 6px #98ffee;pointer-events:none;display:none;z-index:2;';
    box.appendChild(bar);
    inp.title = 'Mouse wheel or click on a digit: left click = up, right click = down.\n' +
                'Click beside the digits to type a frequency.';
    var mctx = document.createElement('canvas').getContext('2d');

    // the digit under the mouse: its place value (kHz) and its left/right edge in px
    function digitAt(clientX) {
      var v = inp.value, dot = v.indexOf('.');
      if (!/^\d+(\.\d+)?$/.test(v)) return null;
      if (dot < 0) dot = v.length;
      var cs = getComputedStyle(inp);
      mctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
      var r = inp.getBoundingClientRect();
      var padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
      var bl = parseFloat(cs.borderLeftWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0;
      var inner = r.width - padL - padR - bl - br, tw = mctx.measureText(v).width;
      var x0 = r.left + bl + padL + Math.max(0, (inner - tw) / 2);   // text-align: center
      for (var i = 0, x = x0; i < v.length; i++) {
        var w = mctx.measureText(v[i]).width;
        if (clientX >= x && clientX < x + w) {
          if (i === dot) return null;
          var place = i < dot ? Math.pow(10, dot - 1 - i) : Math.pow(10, dot - i);
          return { step: place, left: x - r.left, width: w };
        }
        x += w;
      }
      return null;
    }
    function typing() { return document.activeElement === inp; }
    function show(d) {
      if (!d || typing()) { bar.style.display = 'none'; return; }
      var ir = inp.getBoundingClientRect(), br = box.getBoundingClientRect();
      bar.style.left = (ir.left - br.left + d.left + 1) + 'px';
      bar.style.width = Math.max(4, d.width - 2) + 'px';
      bar.style.top = (ir.bottom - br.top - 12) + 'px';
      bar.style.display = 'block';
    }
    function step(kHz) {
      var e = bi[band], f = Math.round((nominalfreq() + kHz) * 100) / 100;
      var fmin = e.centerfreq - e.samplerate / 2, fmax = e.centerfreq + e.samplerate / 2;
      if (f < fmin || f > fmax) return;
      var carrier = f - (iscw() ? (hi + lo) / 2 : 0);
      setwaterfall(band, carrier);            // follow with the view only if it goes off-screen
      setfreq(Math.round(carrier * 1000) / 1000);
    }
    inp.addEventListener('mousemove', function (ev) {
      var d = typing() ? null : digitAt(ev.clientX);
      inp.style.cursor = d ? 'pointer' : '';
      show(d);
    });
    inp.addEventListener('mouseleave', function () { bar.style.display = 'none'; inp.style.cursor = ''; });
    inp.addEventListener('wheel', function (ev) {
      if (typing()) return;
      var d = digitAt(ev.clientX);
      if (!d || !ev.deltaY) return;
      ev.preventDefault();                     // do not scroll the page
      step(ev.deltaY < 0 ? d.step : -d.step);
      show(digitAt(ev.clientX));               // the text may have changed length
    }, { passive: false });
    inp.addEventListener('mousedown', function (ev) {
      if (typing() || (ev.button !== 0 && ev.button !== 2)) return;
      var d = digitAt(ev.clientX);
      if (!d) return;                          // beside the digits: normal typing
      ev.preventDefault();                     // no text cursor, no focus
      step(ev.button === 0 ? d.step : -d.step);
      show(digitAt(ev.clientX));
    });
    inp.addEventListener('contextmenu', function (ev) {
      if (!typing() && digitAt(ev.clientX)) ev.preventDefault();   // right click steps down
    });
    inp.addEventListener('focus', function () { bar.style.display = 'none'; });
  });

  // Spectrum over the waterfall (Type = spectrum), or a panel above a waterfall flipped
  // to run from the top down (Type = spectrum + waterfall: newest line under the
  // spectrum). The flip is only CSS: the waterfall script still draws as usual.
  function specLayout(wfdiv, wfc) {
    var c = spec.canvas, want = spec.split ? 'split' : 'over';
    if (c._layout === want) return;
    c._layout = want;
    if (spec.split) {
      c.style.position = 'relative'; c.style.pointerEvents = 'auto'; c.style.cursor = 'crosshair';
      c.style.height = SPLIT_H + 'px';
      wfdiv.insertBefore(c, wfc);
      wfc.style.transform = 'scaleY(-1)';
    } else {
      c.style.position = 'absolute'; c.style.pointerEvents = 'none'; c.style.cursor = '';
      c.style.height = '';
      wfc.style.transform = '';
    }
    spec.dirty = true;
  }
  function specHide() {
    if (!spec.canvas) return;
    spec.canvas.style.display = 'none';
    var wfc = document.getElementById('wfcdiv0');
    if (wfc && spec.canvas._layout === 'split') wfc.style.transform = '';
    spec.canvas._layout = null;
  }

  // Newest waterfall line → levels; true when it is a new line
  function specReadLine() {
    var cv = document.querySelector('#wfcdiv0 canvas');
    if (!cv || !cv.height) return false;
    var d;
    try { d = cv.getContext('2d').getImageData(0, cv.height - 1, cv.width, 1).data; } catch (e) { return false; }
    var n = cv.width, i, same = spec.row && spec.row.length === d.length;
    if (same) for (i = 0; i < d.length; i += 16) if (d[i] !== spec.row[i] || d[i + 2] !== spec.row[i + 2]) { same = false; break; }
    if (same) return false;
    spec.row = new Uint8ClampedArray(d);
    if (!spec.lvl || spec.lvl.length !== n) { spec.lvl = new Float32Array(n); spec.filt = null; }
    for (i = 0; i < n; i++) {
      var v = palIndex[(d[4 * i] << 16) | (d[4 * i + 1] << 8) | d[4 * i + 2]];
      if (v !== undefined) spec.lvl[i] = v;          // a blended pixel (zoom in progress): keep the last level
    }
    var e = window.bi && bi[window.band], view = e ? e.effcenterfreq + '/' + e.effsamplerate : '';
    var fresh = !spec.filt || view !== spec.view;
    if (fresh) { spec.filt = new Float32Array(spec.lvl); spec.view = view; }
    else for (i = 0; i < n; i++) spec.filt[i] = SPEC_ALPHA * spec.lvl[i] + (1 - SPEC_ALPHA) * spec.filt[i];
    // noise floor = median level; ease the scale towards it (jump after a retune/zoom)
    var sorted = Array.prototype.slice.call(spec.filt).sort(function (a, b) { return a - b; });
    var want = lvlToDb(sorted[sorted.length >> 1]) - SPEC_BELOW_DB;
    spec.minDb = (fresh || spec.minDb === null || Math.abs(want - spec.minDb) > 15) ? want : 0.9 * spec.minDb + 0.1 * want;
    return true;
  }

  function specDraw() {
    var c = spec.canvas, ctx = spec.ctx, w = c.width, h = c.height, arr = spec.filt, x, row;
    var minDb = spec.minDb !== null ? spec.minDb : -130, span = SPEC_RANGE_DB;
    function yOf(l) { return h - ((lvlToDb(l) - minDb) / span) * h; }
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    if (arr) {
      if (!spec.grad || spec.gradH !== h) specBuildGrad(h);
      var img = ctx.createImageData(w, h), px = img.data, g = spec.grad, n = arr.length;
      new Uint32Array(px.buffer).fill(0xff000000);     // opaque black above the curve
      for (x = 0; x < w; x++) {
        var top = Math.max(0, Math.floor(yOf(arr[Math.min(n - 1, Math.floor(x * n / w))])));
        for (row = top; row < h; row++) {
          var o = (row * w + x) * 4, q = row * 4;
          px[o] = g[q]; px[o + 1] = g[q + 1]; px[o + 2] = g[q + 2]; px[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    }
    // dB grid (dBFS), labels on the right
    ctx.font = '9px monospace';
    for (var dB = Math.ceil(minDb / 10) * 10; dB <= minDb + span; dB += 10) {
      var y = Math.round(h - ((dB - minDb) / span) * h) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      var label = String(dB), tw = ctx.measureText(label).width / wfScale;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(w - 4 - tw - 2, Math.max(y - 10, 0), tw + 4, 11);
      ctx.fillStyle = 'rgba(210,210,210,0.9)';
      specText(ctx, label, w - 4, Math.max(y - 2, 9), 'right');
    }
    // trace
    if (arr) {
      ctx.beginPath();
      for (x = 0; x < arr.length; x++) {
        var yy = yOf(arr[x]), xx = x * w / arr.length;
        if (x) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1; ctx.stroke();
    }
    // hover crosshair and frequency
    if (spec.hoverX !== null && window.bi && bi[window.band]) {
      var e = bi[band], f = e.effcenterfreq - e.effsamplerate / 2 + spec.hoverX / 1024 * e.effsamplerate;
      ctx.strokeStyle = 'rgba(255,240,80,0.6)'; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(spec.hoverX, 0); ctx.lineTo(spec.hoverX, h); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = '11px monospace'; ctx.fillStyle = 'rgba(255,255,180,0.95)';
      specText(ctx, (f / 1000).toFixed(6) + ' MHz', 10, 15, 'left');
    }
  }

  function specLoop() {
    requestAnimationFrame(specLoop);
    if (!spec.on) { specHide(); return; }
    if (!specCanvas()) return;
    spec.canvas.style.display = 'block';
    if (specReadLine()) spec.dirty = true;
    if (spec.dirty) { spec.dirty = false; specDraw(); }
  }
  window.addEventListener('load', function () { requestAnimationFrame(specLoop); });

  // Type = spectrum (0) or spectrum + waterfall (2): keep the waterfall script in
  // waterfall mode (it is the data source) and show this spectrum over it or above it;
  // waterfall (1) hides it again. (2 was "weak sigs" and 3 "strong sigs", both removed.)
  // The Type selector is the source of truth: the page also re-applies the mode itself
  // (e.g. when the waterfall restarts) from a variable that is 1 while this is shown.
  function specSetType(m, orig) {
    var sel = document.getElementById('wfmode');
    m = sel ? Number(sel.value) : Number(m);
    spec.on = (m === 0 || m === 2);
    spec.split = (m === 2);
    spec.dirty = true;
    orig(1);
  }

  // First visit: Type = spectrum + waterfall. The visitor's own choice is kept in this
  // browser (localStorage 'ubersdr_wftype') for the next visits. Desktop page only.
  var WFTYPE_KEY = 'ubersdr_wftype', WFTYPE_DEFAULT = '2';
  window.addEventListener('load', function () {
    var sel = document.getElementById('wfmode');
    if (!sel) return;
    var v = null;
    try { v = localStorage.getItem(WFTYPE_KEY); } catch (e) {}
    if (!/^[012]$/.test(v || '')) v = WFTYPE_DEFAULT;
    sel.value = v;
    sel.addEventListener('change', function () { try { localStorage.setItem(WFTYPE_KEY, sel.value); } catch (e) {} });
    window.waterfallmode(Number(v));
  });

  // ── Move UberSDR's credit line (written before the RW3PS layout) to the bottom
  document.addEventListener('DOMContentLoaded', function () {
    var overlay = document.getElementById('audiostartbutton');
    if (!overlay || overlay.parentNode !== document.body) return;
    var credit = document.createElement('div');
    credit.id = 'ubersdr-credit';
    while (document.body.firstChild && document.body.firstChild !== overlay) {
      var n = document.body.firstChild;
      if (n.nodeName === 'P' || n.nodeName === 'HR') document.body.removeChild(n);
      else credit.appendChild(n);
    }
    document.body.appendChild(credit);
  });
}());
