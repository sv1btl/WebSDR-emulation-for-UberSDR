/**
 * fsk.js — Kiwi-style FSK engine: NAVTEX / SITOR-B and RTTY / ITA2
 *
 * Extracted verbatim from audio.js (the `_nv*` / `_fsk*` methods of
 * SpectrumAudio) so it can run inside a Web Worker; see fsk.worker.js.  The
 * demodulator, CCIR-476 decoder, ITA2 async framing, auto-shift and auto-centre
 * are unchanged.
 *
 * NAVTEX and RTTY were always one engine sharing one set of state, which is why
 * they could never run at once.  They are now one CLASS with two instances,
 * selected by `role`:
 *
 *   role 'navtex' — legacy NAVTEX path: CCIR-476 + ZCZC/NNNN message framing
 *   role 'fsk'    — generic FSK with the maritime / weather / ham presets, plus
 *                   the 'psk31', 'olivia', 'packet' and 'aprs' variants, which
 *                   do not use the discriminator chain at all: they hand the
 *                   audio to psk31.js / olivia.js / mfsk.js / ax25.js and only
 *                   borrow
 *                   this class's config, worker and event plumbing. The
 *                   'olivia' variant also carries MFSK16/32/64 (encoding
 *                   'mfsk'): same panel, a different decoder.
 *
 * Each instance owns its own state, so the roles can no longer interfere.  The
 * `_navtexCb` / `_fskCb` getters below reproduce the old behaviour exactly: the
 * engine used to emit to two separate callbacks on the audio object, and only
 * the one belonging to the active decoder was ever non-null.
 *
 * Emits, via the callback:
 *   role 'navtex': { type:'char'|'status'|'navstart'|'navend', … }
 *   role 'fsk'   : { type:'char'|'line'|'status'|'metrics', variant, … }
 *                  ('line' = one whole decoded packet, from 'packet' / 'aprs')
 */

import { transformFlat } from './lib/fftRadix2.js';
import { PSK31Demodulator } from './psk31.js';
import { OliviaDecoder, OLIVIA_MODES, SYNC_THRESHOLD_DEFAULT } from './olivia.js';
import { MfskDecoder, MFSK_MODES, MFSK_SQUELCH_DEFAULT, mfskBandwidth } from './mfsk.js';
import { PacketDecoder } from './ax25.js';

const _isPacketVariant = (v) => v === 'packet' || v === 'aprs';

// The tones/bandwidth pairs the UI offers, as [tones, bandwidth] for lookup.
const OLIVIA_PAIRS = OLIVIA_MODES.map((m) => [m.tones, m.bandwidth]);

// NAVTEX: a message whose ZCZC was missed opens after this many characters in
// a row whose two FEC copies (DX and RX) agree.
const NAVTEX_HEADERLESS_RUN = 4;

// RTTY squelch, in dB SNR referred to 3 kHz (the figure the panel shows).
// FSK_SQUELCH_OFF and below disable it.
export const FSK_SQUELCH_DEFAULT = -8;
export const FSK_SQUELCH_HAM_DEFAULT = -5;
export const FSK_SQUELCH_OFF = -20;
// Hysteresis: once open, the squelch closes only this far below the setting.
const FSK_SQUELCH_HYST_DB = 2;

/** True when `b` differs from `a` in `key` alone (and in nothing else). */
function _onlyDiffersBy(a, b, key) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (!keys.has(key)) return false;
  for (const k of keys) {
    if (k === key) continue;
    if (a[k] !== b[k]) return false;
  }
  return a[key] !== b[key];
}

export class KiwiFSKDecoder {

  constructor(options = {}) {
    this._role = options.role === 'navtex' ? 'navtex' : 'fsk';
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate
      : (() => options.sampleRate || 12000);
    this._callback = typeof options.callback === 'function' ? options.callback : null;
    this._enabled  = false;

    this._variant      = String(options.variant || 'maritime').toLowerCase();
    this._customConfig = options.config ? { ...options.config } : null;

    if (this._role === 'navtex') this._navtexReset();
    else                         this._fskReset();
  }

  // Role-scoped callback views — see the class comment.
  get _navtexCb() { return this._role === 'navtex' ? this._callback : null; }
  get _fskCb()    { return this._role === 'fsk'    ? this._callback : null; }

  _isFsk() { return this._role === 'fsk' && this._enabled; }

  setEnabled(enabled) {
    this._enabled = !!enabled;
    if (this._role === 'navtex') this._navtexReset();
    else                         this._fskReset();
  }

  setCallback(fn) {
    this._callback = typeof fn === 'function' ? fn : null;
  }

  destroy() {
    this._enabled  = false;
    this._callback = null;
    this._fskRecentPCM = [];
    this._psk = null;
    this._olivia = null;
    this._mfsk = null;
    this._packet = null;
  }

  /** Raw PCM in, at the rate reported by the sampleRate function. */
  feedPCM(pcm) {
    if (!this._enabled || !pcm || !pcm.length) return;

    if (this._role === 'navtex') {
      this._nvFeedPCMCommon(pcm, 'maritime', true);
      return;
    }

    // FSK keeps ~1.2 s of recent audio for the auto-shift / auto-centre scans.
    if (!this._fskRecentPCM) this._fskRecentPCM = [];
    for (let i = 0; i < pcm.length; i++) this._fskRecentPCM.push(pcm[i]);
    const keep = Math.max(1024, Math.floor(this._sampleRateFn() * 1.2));
    if (this._fskRecentPCM.length > keep) {
      this._fskRecentPCM.splice(0, this._fskRecentPCM.length - keep);
    }

    // PSK31 and Olivia are completely different demodulators (differential BPSK
    // + varicode, and MFSK + Walsh FEC), so they bypass the discriminator chain.
    if (this._variant === 'psk31')  { this._pskFeed(pcm); return; }
    if (this._variant === 'olivia') { this._oliviaFeed(pcm); return; }
    if (_isPacketVariant(this._variant)) { this._packetFeed(pcm); return; }

    this._nvFeedPCMCommon(pcm, this._variant || 'maritime', false);
  }

  // ── PSK31 (see psk31.js) ──────────────────────────────────────────────────

  _pskFeed(pcm) {
    if (!this._psk) return;
    if (this._fskAutoCenterPending) {
      this._fskAutoCenterPending = false;
      this._pskAutoCenter();
    }
    this._psk.feed(pcm);
  }

  // ── Packet / APRS (see ax25.js) ───────────────────────────────────────────

  _packetFeed(pcm) {
    if (!this._packet) return;
    // Wait for enough audio for the scan rather than dropping the request.
    if (this._fskAutoCenterPending && this._fskRecentPCM.length >= 4096) {
      this._fskAutoCenterPending = false;
      this._packetAutoCenter();
    }
    this._packet.feed(pcm);
  }

  /**
   * One-shot "Auto-tune Center" for 300 Bd HF packet: the strongest pair of
   * lines 200 Hz apart. 1200 Bd is received in FM, where the tones are fixed
   * at 1200 / 2200 Hz whatever the dial says, so there is nothing to tune.
   */
  _packetAutoCenter() {
    const cfg = this._fskResolveConfig(this._variant);
    if (cfg.baud !== 300) {
      if (this._fskCb) this._fskCb({ type: 'status', variant: this._variant,
        text: '1200 Bd tones are fixed — tune the dial to the channel' });
      return;
    }
    const spec = this._fskSpectrum();
    if (!spec) return;
    const { mag, binHz, lo, hi, mean } = spec;
    const gap = Math.round(200 / binHz);
    // Each tone is a hump about a baud wide, so sum a few bins round each.
    const w = Math.max(1, Math.round(60 / binHz));
    const band = (k) => { let a = 0; for (let j = -w; j <= w; j++) a += mag[k + j] || 0; return a; };
    let best = 0, bestK = -1;
    for (let k = lo + w; k + gap + w <= hi; k++) {
      const p = band(k) + band(k + gap);
      if (p > best) { best = p; bestK = k; }
    }
    if (bestK < 0 || best < 4 * mean * 2 * (2 * w + 1)) {
      if (this._fskCb) this._fskCb({ type: 'status', variant: this._variant,
        text: 'Auto-tune: no signal found' });
      return;
    }
    const centerHz = Math.round((bestK + gap / 2) * binHz);
    const oldCenter = Math.round(cfg.center);
    this._customConfig = { ...(this._customConfig || {}), center: centerHz };
    this._fskReset();
    if (this._fskCb) {
      this._fskCb({ type: 'status', variant: this._variant,
        text: `Auto-tune: center ${centerHz} Hz (was ${oldCenter} Hz)` });
      this._fskCb({ type: 'metrics', variant: this._variant, centerHz,
        markHz: centerHz - 100, spaceHz: centerHz + 100, timingLocked: false });
    }
  }

  // ── Olivia (see olivia.js) ────────────────────────────────────────────────

  _oliviaFeed(pcm) {
    const dec = this._olivia || this._mfsk;
    if (!dec) return;
    if (this._fskAutoCenterPending) {
      this._fskAutoCenterPending = false;
      this._oliviaAutoCenter();
    }
    dec.feed(pcm);
  }

  /**
   * One-shot "Auto-tune Center" for Olivia. Olivia fills a whole `bandwidth`
   * wide block with tones rather than showing a peak, so this slides a window
   * of that width across the spectrum and takes the centre of the strongest
   * position. The decoder's own +/-8 bin sync search covers the remainder.
   * MFSK16/32/64 use the same scan over their own tone block; their AFC
   * pulls in the last quarter of a tone.
   */
  _oliviaAutoCenter() {
    const spec = this._fskSpectrum();
    if (!spec) return;
    const { mag, binHz, lo, hi, mean } = spec;

    const cfg = this._fskResolveConfig('olivia');
    const width = Math.max(4, Math.round(cfg.bandwidth / binHz));
    if (hi - lo <= width) return;

    let sum = 0;
    for (let k = lo; k < lo + width; k++) sum += mag[k];
    let best = sum, bestStart = lo;
    for (let k = lo + width; k <= hi; k++) {
      sum += mag[k] - mag[k - width];
      if (sum > best) { best = sum; bestStart = k - width + 1; }
    }

    if (best < 3 * mean * width) {
      if (this._fskCb) {
        this._fskCb({ type: 'status', variant: 'olivia',
          text: 'Auto-tune: no signal found' });
      }
      return;
    }

    const centerHz = Math.round((bestStart + width / 2) * binHz);
    const oldCenter = Math.round(this._nvCenterFreq || 0);
    this._customConfig = { ...(this._customConfig || {}), center: centerHz };
    this._fskReset();

    if (this._fskCb) {
      this._fskCb({ type: 'status', variant: 'olivia',
        text: `Auto-tune: center ${centerHz} Hz (was ${oldCenter} Hz)` });
      this._fskCb({
        type: 'metrics', variant: 'olivia',
        snrDb: 0, lockQuality: 0, centerHz, timingLocked: false,
      });
    }
  }

  /**
   * Magnitude spectrum of the recent-PCM ring over the voice passband, shared
   * by the PSK31 and Olivia auto-tune scans.
   */
  _fskSpectrum() {
    const buf = this._fskRecentPCM;
    if (!buf || buf.length < 4096) return null;

    const SR = this._sampleRateFn() || 12000;
    const N  = 8192;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const start = Math.max(0, buf.length - N);
    const len = Math.min(N, buf.length - start);
    for (let k = 0; k < len; k++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / len);
      re[k] = buf[start + k] * w;
    }
    transformFlat(re, im, false);

    const binHz = SR / N;
    const lo = Math.max(1, Math.floor(300 / binHz));
    const hi = Math.min(N / 2 - 2, Math.ceil(2700 / binHz));

    const mag = new Float64Array(N / 2);
    let total = 0;
    for (let k = lo; k <= hi; k++) {
      mag[k] = re[k] * re[k] + im[k] * im[k];
      total += mag[k];
    }
    const mean = total / Math.max(1, hi - lo + 1);
    return { mag, binHz, lo, hi, mean };
  }

  /**
   * One-shot "Auto-tune Center" for PSK31. The FSK version sweeps Goertzels
   * looking for a balanced tone PAIR, which a single-carrier mode never has, so
   * this looks for the strongest peak in the voice passband instead. The
   * demodulator's own +/-25 Hz acquisition then takes it from there.
   */
  _pskAutoCenter() {
    const spec = this._fskSpectrum();
    if (!spec) return;
    const { mag, binHz, lo, hi, mean } = spec;

    let bestK = -1, bestP = 0;
    for (let k = lo; k <= hi; k++) {
      if (mag[k] > bestP) { bestP = mag[k]; bestK = k; }
    }
    if (bestK < 0) return;

    if (bestP < 8 * mean) {
      if (this._fskCb) {
        this._fskCb({ type: 'status', variant: 'psk31',
          text: 'Auto-tune: no signal found' });
      }
      return;
    }

    // The peak bin is NOT the carrier: an idle PSK31 signal is two lines at
    // +/-15.625 Hz and a loaded one is a hump a full baud wide, so the peak sits
    // on a sideband. Both shapes are symmetric about the carrier, so take the
    // power-weighted centroid over the signal's own width instead.
    const span = Math.ceil(40 / binHz);
    let num = 0, den = 0;
    for (let k = Math.max(lo, bestK - span); k <= Math.min(hi, bestK + span); k++) {
      const pw = mag[k] - mean;
      if (pw <= 0) continue;
      num += k * pw;
      den += pw;
    }
    const centerHz = Math.round((den > 0 ? num / den : bestK) * binHz);

    const oldCenter = Math.round(this._nvCenterFreq || 0);
    this._customConfig = { ...(this._customConfig || {}), center: centerHz };
    this._fskReset();

    if (this._fskCb) {
      this._fskCb({ type: 'status', variant: 'psk31',
        text: `Auto-tune: center ${centerHz} Hz (was ${oldCenter} Hz)` });
      this._fskCb({
        type: 'metrics', variant: 'psk31',
        // Nothing measured yet after the retune: the floor of the 3 kHz scale,
        // not 0 dB, which on that scale is a solid signal.
        snrDb: -25, lockQuality: 0, centerHz, imdDb: 0, timingLocked: false,
      });
    }
  }
  //  NAVTEX / SITOR-B DECODER (Kiwi-style JNX + CCIR476 port)
  //
  //  Also expanded into a generic Kiwi-style FSK decoder with presets for:
  //    • maritime: NAVTEX / SITOR-B, 100 baud, 170 Hz, CCIR-476
  //    • weather : RTTY/ITA2 weather circuits, 50 baud, 450 Hz
  //    • ham     : amateur RTTY/ITA2, 45.45 baud, 170 Hz
  //
  //  All variants share the same Kiwi-style mark/space band-pass detector,
  //  abs-difference logic path, low-pass slicing and edge-timing discipline.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── CCIR-476 character tables (matched to Kiwi CCIR476.js) ──────────────

  static _NAVTEX_LTRS = (() => {
    const t = new Uint8Array(128);
    const m = [
      [0x17,'J'],[0x1B,'F'],[0x1D,'C'],[0x1E,'K'],
      [0x27,'W'],[0x2B,'Y'],[0x2D,'P'],[0x2E,'Q'],
      [0x35,'G'],[0x39,'M'],[0x3A,'X'],[0x3C,'V'],
      [0x47,'A'],[0x4B,'S'],[0x4D,'I'],[0x4E,'U'],
      [0x53,'D'],[0x55,'R'],[0x56,'E'],[0x59,'N'],[0x5A,'_'],[0x5C,' '],
      [0x63,'Z'],[0x65,'L'],[0x66,'_'],[0x69,'H'],[0x6A,'_'],[0x6C,'\n'],
      [0x71,'O'],[0x72,'B'],[0x74,'T'],[0x78,'\r'],
    ];
    for (const [c, ch] of m) t[c] = ch.charCodeAt(0);
    return t;
  })();

  static _NAVTEX_FIGS = (() => {
    const t = new Uint8Array(128);
    const m = [
      [0x17,39 ],[0x1B,33 ],[0x1D,58 ],[0x1E,40 ],
      [0x27,50 ],[0x2B,54 ],[0x2D,48 ],[0x2E,49 ],
      [0x35,38 ],[0x39,46 ],[0x3A,47 ],[0x3C,59 ],
      [0x47,45 ],[0x4B,7  ],[0x4D,56 ],[0x4E,55 ],
      [0x53,36 ],[0x55,52 ],[0x56,51 ],[0x59,44 ],[0x5A,'_'.charCodeAt(0)],[0x5C,32 ],
      [0x63,34 ],[0x65,41 ],[0x66,'_'.charCodeAt(0)],[0x69,35 ],[0x6A,'_'.charCodeAt(0)],[0x6C,10 ],
      [0x71,57 ],[0x72,63 ],[0x74,53 ],[0x78,13 ],
    ];
    for (const [c, cc] of m) t[c] = cc;
    return t;
  })();

  // ── ITA2 / Baudot tables for weather + ham RTTY ────────────────────────

  static _FSK_ITA2_LTRS = (() => {
    const t = new Array(32).fill('');
    const m = {
      0x00: '', 0x01:'E', 0x02:'\n', 0x03:'A', 0x04:' ', 0x05:'S', 0x06:'I', 0x07:'U',
      0x08:'\r', 0x09:'D', 0x0A:'R', 0x0B:'J', 0x0C:'N', 0x0D:'F', 0x0E:'C', 0x0F:'K',
      0x10:'T', 0x11:'Z', 0x12:'L', 0x13:'W', 0x14:'H', 0x15:'Y', 0x16:'P', 0x17:'Q',
      0x18:'O', 0x19:'B', 0x1A:'G', 0x1B:'FIGS', 0x1C:'M', 0x1D:'X', 0x1E:'V', 0x1F:'LTRS'
    };
    for (const [k,v] of Object.entries(m)) t[Number(k)] = v;
    return t;
  })();

  static _FSK_ITA2_FIGS = (() => {
    const t = new Array(32).fill('');
    const m = {
      0x00: '', 0x01:'3', 0x02:'\n', 0x03:'-', 0x04:' ', 0x05:"'", 0x06:'8', 0x07:'7',
      0x08:'\r', 0x09:'$', 0x0A:'4', 0x0B:"'", 0x0C:',', 0x0D:'!', 0x0E:':', 0x0F:'(',
      0x10:'5', 0x11:'"', 0x12:')', 0x13:'2', 0x14:'#', 0x15:'6', 0x16:'0', 0x17:'1',
      0x18:'9', 0x19:'?', 0x1A:'&', 0x1B:'FIGS', 0x1C:'.', 0x1D:'/', 0x1E:';', 0x1F:'LTRS'
    };
    for (const [k,v] of Object.entries(m)) t[Number(k)] = v;
    return t;
  })();

  static _NV_STATE_NOSIGNAL  = 0;
  static _NV_STATE_SYNC1     = 1;
  static _NV_STATE_SYNC2     = 2;
  static _NV_STATE_READ_DATA = 3;

  static _NV_ALPHA  = 0x0F;
  static _NV_BETA   = 0x33;
  static _NV_FIGS   = 0x36;
  static _NV_LTRS   = 0x5A;
  static _NV_REP    = 0x66;
  static _NV_CHAR32 = 0x6A;

  // ── Public API: legacy NAVTEX compatibility ─────────────────────────────



  // ── Public API: generic Kiwi-style FSK presets ──────────────────────────

  setVariant(variant = 'maritime') {
    const v = String(variant || 'maritime').toLowerCase();
    if (v !== 'weather' && v !== 'maritime' && v !== 'ham' &&
        v !== 'psk31' && v !== 'olivia' && !_isPacketVariant(v)) {
      console.warn('[FSK] unknown variant:', variant, '— using maritime');
      this._variant = 'maritime';
    } else {
      this._variant = v;
    }
    this._fskReset();
    console.log('[FSK] variant =', this._variant);
  }

  setConfig(cfg = null) {
    if (!cfg || typeof cfg !== 'object') {
      this._customConfig = null;
      this._fskReset();
      return;
    }

    // The Olivia squelch is a live control: rebuilding the decoder for it would
    // throw away a sync that took seconds to acquire, every time the operator
    // nudges the slider. If nothing else changed, just retune it in place.
    if (this._variant === 'olivia' && this._olivia && this._customConfig &&
        _onlyDiffersBy(this._customConfig, cfg, 'syncThreshold')) {
      this._customConfig = { ...cfg };
      this._olivia.setSyncThreshold(cfg.syncThreshold);
      return;
    }
    // Same for the MFSK squelch (the interleaver and timing loop take a few
    // seconds to fill).
    if (this._variant === 'olivia' && this._mfsk && this._customConfig &&
        _onlyDiffersBy(this._customConfig, cfg, 'mfskSquelch')) {
      this._customConfig = { ...cfg };
      this._mfsk.setSquelch(cfg.mfskSquelch);
      return;
    }

    // Packet's "show raw" only changes how frames are printed.
    if (_isPacketVariant(this._variant) && this._packet && this._customConfig &&
        _onlyDiffersBy(this._customConfig, cfg, 'showRaw')) {
      this._customConfig = { ...cfg };
      this._packet.setShowRaw(cfg.showRaw !== false);
      return;
    }

    // Same for the RTTY squelch: it gates printing, not the demodulator.
    if (this._variant !== 'olivia' && this._variant !== 'psk31' && this._customConfig &&
        _onlyDiffersBy(this._customConfig, cfg, 'squelch')) {
      this._customConfig = { ...cfg };
      if (this._nvPreset) this._nvPreset.squelch = Number(cfg.squelch);
      this._fskSquelchDb = Number.isFinite(Number(cfg.squelch)) ? Number(cfg.squelch) : FSK_SQUELCH_DEFAULT;
      return;
    }

    this._customConfig = { ...cfg };
    this._fskReset();
    console.log('[FSK] custom config =', this._customConfig);
  }

  getConfig() {
    return { ...(this._nvPreset || this._fskResolveConfig(this._variant || 'maritime')) };
  }




  setAutoShift(enabled) {
    this._fskAutoShift = !!enabled;
    if (!this._fskAutoShift) this._fskLastAutoShiftAt = 0;
  }

  // Trigger a one-shot auto-center scan on the next available PCM buffer.
  // Called from the UI "Auto-tune" button.
  setAutoCenter(enabled) {
    this._fskAutoCenterPending = !!enabled;
    this._fskLastAutoCenterAt  = 0;
  }

  // ── Small internal biquad helper (ported from Kiwi BiQuadraticFilter.js) ─

  _nvBiquadCreate() {
    return {
      b0: 0, b1: 0, b2: 0, a0: 1, a1: 0, a2: 0,
      x1: 0, x2: 0, y1: 0, y2: 0,
    };
  }

  _nvBiquadReset(f) {
    f.x1 = f.x2 = f.y1 = f.y2 = 0;
  }

  _nvBiquadConfigure(f, type, centerFreq, sampleRate, Q, gainDB = 0) {
    this._nvBiquadReset(f);
    Q = (Q === 0) ? 1e-9 : Q;
    const gainAbs = Math.pow(10, gainDB / 40);
    const omega = 2 * Math.PI * centerFreq / sampleRate;
    const sn = Math.sin(omega);
    const cs = Math.cos(omega);
    const alpha = sn / (2 * Q);
    let a0, a1, a2, b0, b1, b2;

    switch (type) {
      case 'bandpass':
        b0 = alpha; b1 = 0; b2 = -alpha;
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
        break;
      case 'lowpass':
      default:
        b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2;
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
        break;
    }

    f.a0 = a0;
    f.b0 = b0 / a0;
    f.b1 = b1 / a0;
    f.b2 = b2 / a0;
    f.a1 = a1 / a0;
    f.a2 = a2 / a0;
  }

  _nvBiquadFilter(f, x) {
    const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
    f.x2 = f.x1; f.x1 = x;
    f.y2 = f.y1; f.y1 = y;
    return y;
  }

  _fskGetPreset(variant = this._variant || 'maritime') {
    switch (String(variant || 'maritime').toLowerCase()) {
      case 'psk31':
        // PSK31 has no mark/space pair and no UART framing — the shift, parity
        // and stop-bit fields exist only so the shared config plumbing has
        // something to carry. psk31.js ignores all of them.
        return {
          name: 'psk31', center: 1000.0, shift: 0, baud: 31.25,
          lowpass: 100.0, audioMinimum: 0, protocol: 'varicode', encoding: 'varicode',
          framing: '—', dataBits: 0, parity: 'N', stopBits: 0, inverted: 0,
        };

      case 'olivia':
        // MFSK with its own FEC; tones/bandwidth are the only real parameters.
        return {
          name: 'olivia', center: 1000.0,
          tones: OLIVIA_MODES[0].tones, bandwidth: OLIVIA_MODES[0].bandwidth,
          syncThreshold: SYNC_THRESHOLD_DEFAULT,
          shift: 0, baud: 31.25, lowpass: 100.0, audioMinimum: 0,
          protocol: 'olivia', encoding: 'olivia',
          framing: '—', dataBits: 0, parity: 'N', stopBits: 0, inverted: 0,
        };

      case 'packet':
      case 'aprs':
        // AFSK + HDLC; the FSK shift/framing fields are carried, not used.
        return {
          name: String(variant).toLowerCase(), center: 1700.0, shift: 1000, baud: 1200,
          lowpass: 100.0, audioMinimum: 0, protocol: 'ax25', encoding: 'ax25',
          framing: '—', dataBits: 0, parity: 'N', stopBits: 0, inverted: 0, showRaw: true,
        };

      case 'weather':
        return {
          name: 'weather', center: 1000.0, shift: 450.0, baud: 50.0,
          lowpass: 65.0, audioMinimum: 96.0, protocol: 'ita2', encoding: 'ita2', framing: '5N1.5',
          dataBits: 5, parity: 'N', stopBits: 1.5, squelch: FSK_SQUELCH_DEFAULT,
          // The DWD circuits arrive with mark (idle/1) on the LOWER audio tone
          // in USB. The discriminator reads positive for the HIGHER frequency,
          // so without inversion markState=1 would map to space and every bit
          // would come out flipped; inverted:1 corrects it. This is an observed
          // property of these particular broadcasts, NOT a rule about USB —
          // see 'ham' below, which is the other way round. Matches the UI
          // default (FSK_VARIANT_PRESETS.weather.invert = true).
          inverted: 1,
        };
      case 'ham':
        return {
          name: 'ham', center: 1000.0, shift: 170.0, baud: 45.45,
          lowpass: 55.0, audioMinimum: 72.0, protocol: 'ita2', encoding: 'ita2', framing: '5N1.5',
          dataBits: 5, parity: 'N', stopBits: 1.5, squelch: FSK_SQUELCH_HAM_DEFAULT,
          // Amateur RTTY is mark = the HIGHER RF frequency, and USB preserves
          // the spectrum, so mark arrives as the HIGHER audio tone and no
          // inversion is wanted. (The familiar 2125 mark / 2295 space pair has
          // mark lower because that pair is for LSB, which inverts.) Verified
          // by decoding synthesised mark-high RTTY: inverted:0 reads correctly,
          // inverted:1 returns garbage. Matches the UI default
          // (FSK_VARIANT_PRESETS.ham.invert = false).
          inverted: 0,
        };
      case 'maritime':
      default:
        return {
          name: 'maritime', center: 500.0, shift: 170.0, baud: 100.0,
          lowpass: 140.0, audioMinimum: 256.0, protocol: 'ccir476', encoding: 'ccir476', framing: '7N1',
          dataBits: 7, parity: 'N', stopBits: 1.0, inverted: 0,
        };
    }
  }

  _fskResolveConfig(variant = this._variant || 'maritime') {
    const preset = { ...this._fskGetPreset(variant) };
    const cfg = this._customConfig || {};
    const out = { ...preset };

    if (cfg.variant) out.name = String(cfg.variant).toLowerCase();

    const num = (v, fb) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fb;
    };

    // PSK31 and Olivia carry only a centre frequency (plus tones/bandwidth for
    // Olivia); running them through the shift / framing / parity clamps below
    // would invent values they have no use for.
    const wantedEnc = String(cfg.encoding || out.encoding || '').toLowerCase();
    if (wantedEnc === 'ax25') {
      out.encoding = out.protocol = 'ax25';
      out.baud = num(cfg.baud, out.baud) === 300 ? 300 : 1200;
      out.shift = out.baud === 300 ? 200 : 1000;
      out.center = out.baud === 300 ? Math.max(300, Math.min(2700, num(cfg.center, 1700))) : 1700;
      out.showRaw = cfg.showRaw !== false;
      return out;
    }
    if (wantedEnc === 'mfsk') {
      // MFSK16/32/64 inside the Olivia panel: a sub-mode and a squelch.
      out.encoding = out.protocol = 'mfsk';
      out.center = Math.max(100, num(cfg.center, out.center));
      out.mfskMode = MFSK_MODES.some((m) => m.key === cfg.mfskMode) ? cfg.mfskMode : MFSK_MODES[0].key;
      out.bandwidth = mfskBandwidth(out.mfskMode);
      out.mfskSquelch = num(cfg.mfskSquelch, MFSK_SQUELCH_DEFAULT);
      return out;
    }
    if (wantedEnc === 'varicode' || wantedEnc === 'olivia') {
      out.encoding = out.protocol = wantedEnc;
      out.center = Math.max(100, num(cfg.center, out.center));
      if (wantedEnc === 'olivia') {
        // Clamp to the pairs the decoder is built for; anything else silently
        // decodes nothing, which is far harder to diagnose than a clamp.
        const t = Math.round(num(cfg.tones, out.tones || 32));
        const b = Math.round(num(cfg.bandwidth, out.bandwidth || 1000));
        const ok = OLIVIA_PAIRS.some((p) => p[0] === t && p[1] === b);
        out.tones     = ok ? t : OLIVIA_MODES[0].tones;
        out.bandwidth = ok ? b : OLIVIA_MODES[0].bandwidth;
        out.syncThreshold = num(cfg.syncThreshold, out.syncThreshold);
      }
      return out;
    }

    out.center = Math.max(100, num(cfg.center, out.center));
    out.shift = Math.max(20, num(cfg.shift, out.shift));
    out.baud = Math.max(10, num(cfg.baud, out.baud));
    out.lowpass = Math.max(20, num(cfg.lowpass, Math.max(60, out.baud * 2.2)));
    out.audioMinimum = Math.max(32, num(cfg.audioMinimum, out.audioMinimum));
    // Fall back to the preset when the caller does not state a polarity.
    // `cfg.inverted ? 1 : 0` forced 0 on every config that omitted the field,
    // which silently discarded the per-variant default (weather needs 1) and
    // made those preset values dead. The UI always sends an explicit boolean,
    // so this only affects callers that set a variant with no config.
    out.inverted = (cfg.inverted != null ? cfg.inverted : out.inverted) ? 1 : 0;
    // Squelch in dB SNR (3 kHz reference); at or below FSK_SQUELCH_OFF it is off.
    out.squelch = num(cfg.squelch, out.squelch);

    const enc = String(cfg.encoding || cfg.encode || out.encoding || out.protocol || 'ita2').toLowerCase();
    out.encoding = enc;
    out.protocol = enc;

    let framing = String(cfg.framing || out.framing || '5N1.5').toUpperCase().replace(/\s+/g, '');
    const m = framing.match(/^(\d)([NEO])([12](?:\.5)?|1\.5)$/);
    if (m) {
      out.dataBits = parseInt(m[1], 10);
      out.parity = m[2];
      out.stopBits = parseFloat(m[3]);
      out.framing = framing;
    } else {
      out.dataBits = out.dataBits || 5;
      out.parity = out.parity || 'N';
      out.stopBits = out.stopBits || 1.5;
      out.framing = `${out.dataBits}${out.parity}${out.stopBits}`;
    }

    if (cfg.dataBits != null) out.dataBits = Math.max(5, Math.min(8, Math.round(num(cfg.dataBits, out.dataBits))));
    if (cfg.parity) out.parity = String(cfg.parity).toUpperCase().slice(0,1);
    if (cfg.stopBits != null) out.stopBits = num(cfg.stopBits, out.stopBits);

    if (enc === 'ccir476') {
      out.dataBits = 7;
      out.parity = 'N';
      out.stopBits = 1.0;
      out.framing = '7N1';
    }

    if (enc === 'ita2' && out.dataBits < 5) out.dataBits = 5;
    out.framing = `${out.dataBits}${out.parity}${out.stopBits}`;
    return out;
  }

  // ── State reset / setup ───────────────────────────────────────────────────

  _navtexReset() {
    this._nvApplyPreset(this._fskGetPreset('maritime'));
    this._nvResetMessageFraming();
  }

  _fskReset() {
    const preset = this._fskResolveConfig(this._variant || 'maritime');
    this._nvApplyPreset(preset);

    if (this._variant === 'psk31') {
      // The engine reports through the same event shapes as the FSK path, so
      // audio.js, the proxy and the UI need no knowledge of PSK31 at all.
      this._psk = new PSK31Demodulator({
        sampleRate: this._sampleRateFn,
        centerHz:   preset.center,
        onChar:   (ch) => { if (this._fskCb) this._fskCb({ type: 'char', variant: 'psk31', char: ch }); },
        onStatus: (text) => { if (this._fskCb) this._fskCb({ type: 'status', variant: 'psk31', text }); },
        onMetrics: (m) => {
          if (this._fskCb) this._fskCb({ type: 'metrics', variant: 'psk31', ...m });
        },
      });
    } else {
      this._psk = null;
    }

    if (_isPacketVariant(this._variant)) {
      const v = this._variant;
      this._packet = new PacketDecoder({
        sampleRate: this._sampleRateFn,
        baud:       preset.baud,
        centerHz:   preset.center,
        aprs:       v === 'aprs',
        showRaw:    preset.showRaw,
        onLine:   (text, pos) => { if (this._fskCb) this._fskCb({ type: 'line', variant: v, text, pos: pos || null }); },
        onStatus: (text) => { if (this._fskCb) this._fskCb({ type: 'status', variant: v, text }); },
        onMetrics: (m) => { if (this._fskCb) this._fskCb({ type: 'metrics', variant: v, ...m }); },
      });
    } else {
      this._packet = null;
    }

    if (this._variant === 'olivia' && preset.encoding === 'mfsk') {
      this._mfsk = new MfskDecoder({
        sampleRate: this._sampleRateFn,
        centerHz:   preset.center,
        mode:       preset.mfskMode,
        squelch:    preset.mfskSquelch,
        onChar:   (ch) => { if (this._fskCb) this._fskCb({ type: 'char', variant: 'olivia', char: ch }); },
        onStatus: (text) => { if (this._fskCb) this._fskCb({ type: 'status', variant: 'olivia', text }); },
        onMetrics: (m) => {
          if (this._fskCb) this._fskCb({ type: 'metrics', variant: 'olivia', ...m });
        },
      });
    } else {
      this._mfsk = null;
    }

    if (this._variant === 'olivia' && preset.encoding !== 'mfsk') {
      this._olivia = new OliviaDecoder({
        sampleRate: this._sampleRateFn,
        centerHz:   preset.center,
        tones:      preset.tones,
        bandwidth:  preset.bandwidth,
        syncThreshold: preset.syncThreshold,
        onChar:   (ch) => { if (this._fskCb) this._fskCb({ type: 'char', variant: 'olivia', char: ch }); },
        onStatus: (text) => { if (this._fskCb) this._fskCb({ type: 'status', variant: 'olivia', text }); },
        onMetrics: (m) => {
          if (this._fskCb) this._fskCb({ type: 'metrics', variant: 'olivia', ...m });
        },
      });
    } else {
      this._olivia = null;
    }

    this._fskShift = false;
    this._fskFigsRunLen = 0;
    this._fskAsyncState = 'hunt';
    this._fskAsyncBits = 0;
    this._fskAsyncBitIndex = 0;
    this._fskAsyncCenter = 0;
    this._fskPrevBit = 1;
    this._fskHuntPrev = 1;
    this._fskLastFallAt = -1;
    this._fskAutoShift = this._fskAutoShift !== false;
    this._fskLastAutoShiftAt = 0;
    this._fskLastMetricsAt = 0;
    this._fskTimingLock = false;
    this._fskTimingAnnounced = false;
    this._fskCharsDecoded = 0;
    this._fskInvalidFrames = 0;
    this._fskSignalEMA = 0;
    this._fskNoiseEMA = 0;
    this._fskRecentPCM = [];
    this._fskSnrReset();
    this._fskSquelchDb = Number.isFinite(Number(preset.squelch)) ? Number(preset.squelch) : FSK_SQUELCH_DEFAULT;
    this._fskSquelchOpen = false;
  }

  // ── Tone-correlator SNR (async FSK) ─────────────────────────────────────
  //
  // Each bit window correlates the complex baseband against both tones. The
  // tone that is ON holds signal + noise, the OFF tone holds noise alone, so
  // (on − off) / off is Eb/N0 for that bit, and
  //     SNR(3 kHz) = Eb/N0 · baud / 3000
  // is the familiar RTTY/FT8-style figure. The tones follow the adaptive
  // threshold, which sits at the frequency offset of a mistuned signal.
  _fskSnrReset() {
    this._snrPh = 0;
    this._snrOffPh = 0;
    this._snrHiRe = this._snrHiIm = this._snrLoRe = this._snrLoIm = 0;
    this._snrN = 0; this._snrW = 0; this._snrW2 = 0;
    this._snrOnFast = this._snrOffFast = 0;   // squelch gate, ~5 bits
    this._snrOnSlow = this._snrOffSlow = 0;   // display, ~20 bits
    this._snrPrimed = false;
    this._fskSnrFastDb = -99;
    this._fskSnrDb = -99;
    // Group delay of the post-discriminator low-pass (2nd-order Butterworth at
    // 0.75 × baud): √2 / (2π · 0.75 · baud) = 0.30 bit at any baud rate.
    const delayBits = Math.SQRT2 / (2.0 * Math.PI * 0.75);
    const D = Math.max(0, Math.round((this._nvSampleRate || 12000) * delayBits / (this._nvBaudRate || 45.45)));
    this._snrDelayBuf = new Float64Array(2 * D);
    this._snrDelayIdx = 0;
  }

  _fskSnrSample(iLP, qLP) {
    const SR = this._nvSampleRate || 12000;
    const offHz = (this._fskThresh || 0) * this._nvDeviation;
    this._snrPh += 2.0 * Math.PI * this._nvDeviation / SR;
    if (this._snrPh > Math.PI) this._snrPh -= 2.0 * Math.PI;
    this._snrOffPh += 2.0 * Math.PI * offHz / SR;
    if (this._snrOffPh > Math.PI) this._snrOffPh -= 2.0 * Math.PI;
    else if (this._snrOffPh < -Math.PI) this._snrOffPh += 2.0 * Math.PI;
    // High tone: rotate by −(dev + off); low tone: rotate by −(−dev + off).
    const aH = this._snrPh + this._snrOffPh, aL = this._snrOffPh - this._snrPh;
    // Delay the baseband to line up with the bit clock, which runs behind it
    // by the post-discriminator low-pass group delay.
    const buf = this._snrDelayBuf, D = buf.length / 2;
    if (D > 0) {
      const k = this._snrDelayIdx;
      const iNow = iLP, qNow = qLP;
      iLP = buf[2 * k]; qLP = buf[2 * k + 1];
      buf[2 * k] = iNow; buf[2 * k + 1] = qNow;
      this._snrDelayIdx = (k + 1) % D;
    }
    // Hann-weighted: the tones are not orthogonal over one bit (170 Hz ×
    // 22 ms = 3.74 cycles), and a square window leaks the ON tone into the
    // OFF correlator at −24 dB, which capped the reading near +3 dB.
    const w = 0.5 - 0.5 * Math.cos(2.0 * Math.PI * (this._snrN + 0.5) / this._nvBitPeriodTrue);
    const wi = w * iLP, wq = w * qLP;
    const cH = Math.cos(aH), sH = Math.sin(aH), cL = Math.cos(aL), sL = Math.sin(aL);
    this._snrHiRe += wi * cH + wq * sH;  this._snrHiIm += wq * cH - wi * sH;
    this._snrLoRe += wi * cL + wq * sL;  this._snrLoIm += wq * cL - wi * sL;
    this._snrW += w; this._snrW2 += w * w;
    this._snrN++;
  }

  /** Close one bit window. Short windows (cut by a start-bit re-anchor) are dropped. */
  _fskSnrBit() {
    const n = this._snrN;
    if (n >= 0.9 * this._nvBitPeriodTrue) {
      const w2 = this._snrW2 || 1;
      const eH = (this._snrHiRe * this._snrHiRe + this._snrHiIm * this._snrHiIm) / w2;
      const eL = (this._snrLoRe * this._snrLoRe + this._snrLoIm * this._snrLoIm) / w2;
      // Window gain: for a square window this is 1/N and SNR = Eb/N0·baud/3000;
      // Hann's Σw²/(Σw)² is 1.5/N, and the same expression covers both.
      this._snrGain = (this._snrW2 / Math.max(1e-9, this._snrW * this._snrW)) *
        (this._nvSampleRate || 12000) / 3000;
      const on = Math.max(eH, eL), off = Math.min(eH, eL);
      if (!this._snrPrimed) {
        this._snrOnFast = this._snrOnSlow = on;
        this._snrOffFast = this._snrOffSlow = off;
        this._snrPrimed = true;
      } else {
        this._snrOnFast  += (on  - this._snrOnFast)  * 0.2;
        this._snrOffFast += (off - this._snrOffFast) * 0.2;
        this._snrOnSlow  += (on  - this._snrOnSlow)  * 0.05;
        this._snrOffSlow += (off - this._snrOffSlow) * 0.05;
      }
      const k = this._snrGain;
      const db = (on_, off_) => {
        const r = (on_ - off_) / (off_ + 1e-12);
        return r > 0 ? Math.max(-30, 10 * Math.log10(r * k)) : -30;
      };
      this._fskSnrFastDb = db(this._snrOnFast, this._snrOffFast);
      this._fskSnrDb     = db(this._snrOnSlow, this._snrOffSlow);
      this._fskSquelchUpdate();
    }
    this._snrHiRe = this._snrHiIm = this._snrLoRe = this._snrLoIm = 0;
    this._snrN = 0; this._snrW = 0; this._snrW2 = 0;
  }

  _fskSquelchUpdate() {
    const sq = this._fskSquelchDb;
    if (!(sq > FSK_SQUELCH_OFF)) { this._fskSquelchOpen = true; return; }
    const snr = this._fskSnrFastDb;
    if (!this._fskSquelchOpen && snr >= sq) {
      this._fskSquelchOpen = true;
      // Whatever shift noise left behind is meaningless; senders start in LTRS.
      this._fskShift = false;
      this._fskFigsRunLen = 0;
    } else if (this._fskSquelchOpen && snr < sq - FSK_SQUELCH_HYST_DB) {
      this._fskSquelchOpen = false;
    }
  }

  _nvApplyPreset(preset) {
    const SR = this._sampleRateFn();

    this._nvPreset = { ...preset };
    this._nvSampleRate = SR;
    this._nvCenterFreq = preset.center;
    this._nvShiftHz = preset.shift;
    this._nvDeviation = this._nvShiftHz / 2.0;
    this._nvBaudRate = preset.baud;
    this._nvLowpassFreq = preset.lowpass;
    this._fskEncoding = String(preset.encoding || preset.protocol || 'ita2').toLowerCase();
    this._fskDataBits = Math.max(5, Math.min(8, preset.dataBits || 5));
    this._fskParity = String(preset.parity || 'N').toUpperCase();
    this._fskStopBits = Number.isFinite(Number(preset.stopBits)) ? Number(preset.stopBits) : 1.5;
    this._nvInvSqrt2 = 1.0 / Math.sqrt(2.0);
    this._nvMsb = 0x40;
    this._nvNbits = 7;

    this._nvAudioAverage = 0.0;
    this._nvAudioAverageTc = 1000.0 / SR;
    this._nvAudioMinimum = preset.audioMinimum;

    this._nvBitSampleCount  = Math.max(1, Math.round(SR / this._nvBaudRate));
    this._nvBitPeriodTrue   = SR / this._nvBaudRate;   // exact float — used by frac accumulator
    this._nvBitPeriodFrac   = 0.0;                     // sub-sample remainder carried between bits
    this._nvHalfBitSampleCount = this._nvBitSampleCount / 2.0;

    this._nvBitCount = 0;
    this._nvCodeBits = 0;
    this._nvErrorCount = 0;
    this._nvValidCount = 0;
    this._nvSyncChars = [];
    this._nvWaiting = false;

    this._nvSignalAccumulator = 0;
    this._nvBitDuration = 0;
    this._nvSampleCount = 0;
    this._nvNextEventCount = 0;
    this._nvAveragedMarkState = 0;
    this._nvOldMarkState = false;
    this._nvPulseEdgeEvent = false;
    this._nvSyncDelta = 0;
    this._nvBaudError = 0;
    this._nvInverted = preset.inverted ? 1 : 0;

    // Async mode flag: ITA2 / ASCII (ham/weather RTTY) re-anchors the bit clock on
    // every start-bit edge, which gives better synchronisation than the
    // zero-crossing sync designed for continuous synchronous CCIR-476 data.
    // When async, _nvSyncDelta is never applied so stale or noise-derived
    // corrections can't corrupt the clean start-bit re-anchor.
    this._nvAsyncMode = (preset.protocol !== 'ccir476');

    this._nvZeroCrossingSamples = 16;
    this._nvZeroCrossingsDivisor = 4;
    this._nvZeroCrossingCount = 0;
    this._nvZeroCrossings = new Array(Math.max(1, Math.ceil(this._nvBitSampleCount / this._nvZeroCrossingsDivisor))).fill(0);

    // Q is chosen so each bandpass filter's 3 dB bandwidth is ~40% of the
    // tone shift, keeping the mark and space filters well-separated while
    // still having a wide enough pass-band to track the signal.
    // Old formula (q = 6 * center / 1000) gave Q≈6 for all 1000 Hz center
    // cases, producing ~167 Hz bandwidth that heavily overlapped with a
    // 170 Hz shift — the main cause of ham/weather RTTY decoding errors.
    const q = Math.max(3, this._nvCenterFreq / (this._nvShiftHz * 0.4));
    // Mark is the higher tone; space is the lower tone.
    const markFreq  = this._nvCenterFreq + this._nvDeviation;
    const spaceFreq = this._nvCenterFreq - this._nvDeviation;

    this._nvMarkFilter = this._nvBiquadCreate();
    this._nvSpaceFilter = this._nvBiquadCreate();
    this._nvLowFilter = this._nvBiquadCreate();
    this._nvBiquadConfigure(this._nvMarkFilter, 'bandpass', markFreq, SR, q);
    this._nvBiquadConfigure(this._nvSpaceFilter, 'bandpass', spaceFreq, SR, q);
    this._nvBiquadConfigure(this._nvLowFilter, 'lowpass', this._nvLowpassFreq, SR, this._nvInvSqrt2);

    this._nvState = KiwiFSKDecoder._NV_STATE_NOSIGNAL;
    this._nvSyncSetup = 1;

    this._nvShift = false;
    this._nvAlphaPhase = false;
    this._nvC1 = 0;
    this._nvC2 = 0;
    this._nvC3 = 0;
    this._nvStrictMode = false;
    this._nvSucceedTally = 0;
    this._nvFailTally = 0;

    // ── FM phase discriminator state (ITA2/RTTY paths only) ──────────────────
    // CCIR-476 (NAVTEX/maritime) keeps the dual-BPF envelope detector which
    // works well because SITOR-B FEC corrects residual errors.  ITA2 variants
    // (ham, weather) have no FEC so every bit error shows as a garbled character;
    // a proper FM discriminator is far more robust than dual-BPF on these modes.
    this._fmPhase   = 0.0;
    this._fmPrevI   = 0.0;
    this._fmPrevQ   = 0.0;
    this._fmILPF    = this._nvBiquadCreate();
    this._fmQLPF    = this._nvBiquadCreate();
    this._fmDiscLPF = this._nvBiquadCreate();
    // Every async framing (ITA2 or ASCII) runs through the discriminator, so
    // configure it for all of them — gating on 'ita2' left ASCII on all-zero
    // filters, which decoded nothing.
    if (this._nvAsyncMode) {
      // I/Q arm lowpass: passes ±shift/2 from baseband while removing the
      // 2×centre image produced by the complex mixer.
      // shift×0.7 comfortably covers both tones without wasting noise bandwidth.
      const iqLP = Math.max(this._nvShiftHz * 0.7, this._nvBaudRate * 2.0);
      this._nvBiquadConfigure(this._fmILPF,    'lowpass', iqLP, SR, this._nvInvSqrt2);
      this._nvBiquadConfigure(this._fmQLPF,    'lowpass', iqLP, SR, this._nvInvSqrt2);
      // Post-discriminator LPF: 0.75× baud — rejects inter-bit noise while
      // tracking the fastest transitions without introducing ISI distortion.
      this._nvBiquadConfigure(this._fmDiscLPF, 'lowpass', this._nvBaudRate * 0.75, SR, this._nvInvSqrt2);
      // Adaptive threshold — EMA of mark-side and space-side disc outputs.
      // Seeded with small non-zero values so the midpoint starts at 0.
      this._fskMarkEMA  =  0.1;
      this._fskSpaceEMA = -0.1;
      this._fskThresh   =  0.0;
      // Discriminator gain: 1 / sin(2π·deviation/SR) puts the tones at ±1.
      this._fmDiscGain  = 1.0 / Math.sin(2.0 * Math.PI * this._nvDeviation / SR);
      // Threshold EMA: the 0.005-per-sample rate tuned at 12 kHz (≈17 ms),
      // held constant in time so other audio rates behave the same.
      this._fskThreshAlpha = 1.0 - Math.exp(-1.0 / (0.0167 * SR));
    }
  }

  _nvResetMessageFraming() {
    this._nvInMsg = false;
    this._nvRawWin = '';
    this._nvMsgTail = '';
    this._nvStation = '';
    this._nvSubject = '';
    this._nvSerial = '';
    this._nvHeader = '';
    this._nvHeaderDone = false;
    this._nvNRun = '';
    this._nvHeaderless = false;   // inside a message that began without ZCZC
    this._nvPreBuf = '';          // agreeing chars that may open one
    this._nvZHold = '';           // a possible "ZCZC" held back from the text
    this._nvAgreeRun = 0;
  }

  _nvSetState(s) {
    this._nvState = s;
  }

  _nvCheckBits(v) {
    v &= 0x7F;
    let bc = 0;
    while (v !== 0) {
      bc++;
      v &= v - 1;
    }
    return bc === 4;
  }

  _nvCodeToChar(code, shift) {
    const tbl = shift ? KiwiFSKDecoder._NAVTEX_FIGS : KiwiFSKDecoder._NAVTEX_LTRS;
    const cc = tbl[code & 0x7F];
    return cc ? String.fromCharCode(cc) : null;
  }

  _nvDecoderReset() {
    this._nvBitCount = 0;
    this._nvCodeBits = 0;
    this._nvErrorCount = 0;
    this._nvValidCount = 0;
    this._nvWaiting = false;
    this._nvShift = false;
    this._nvAlphaPhase = false;
    this._nvC1 = 0;
    this._nvC2 = 0;
    this._nvC3 = 0;
    this._nvSyncChars = [];
    this._nvSlotHist = [];
    this._nvAgreeRx = 0;          // agreement rate in the slots read as RX
    this._nvAgreeDx = 0;          // … and in the others (high = phase swapped)
  }

  // ── PCM ingestion / Kiwi JNX-style demodulation ──────────────────────────



  _nvFeedPCMCommon(pcm, variant, legacyNavtexMode = false) {
    const preset = this._fskGetPreset(variant);
    if (!this._nvPreset || this._nvPreset.name !== preset.name || this._nvSampleRate !== (this._sampleRateFn())) {
      this._nvApplyPreset(preset);
      if (preset.protocol === 'ita2') this._fskReset();
      if (legacyNavtexMode) this._nvResetMessageFraming();
    }

    for (let i = 0; i < pcm.length; i++) {
      const dv = pcm[i] * 32768.0;

      let logicLevel, markState;

      if (preset.protocol === 'ita2') {
        // ── FM phase discriminator (ham / weather RTTY) ─────────────────────
        // Step 1: mix signal down to complex baseband at the centre frequency.
        const twoPiFs = 2.0 * Math.PI * this._nvCenterFreq / (this._nvSampleRate || 12000);
        this._fmPhase += twoPiFs;
        if (this._fmPhase > Math.PI) this._fmPhase -= 2.0 * Math.PI;
        const iRaw =  dv * Math.cos(this._fmPhase);
        const qRaw = -dv * Math.sin(this._fmPhase);

        // Step 2: lowpass I and Q — removes 2×fc image, passes both tones.
        const iLP = this._nvBiquadFilter(this._fmILPF, iRaw);
        const qLP = this._nvBiquadFilter(this._fmQLPF, qRaw);

        // Step 3: phase discriminator.
        //   disc = sin(Δφ) = I[n-1]·Q[n] − Q[n-1]·I[n]
        //   Positive when instantaneous frequency > centre  →  mark tone.
        //   Negative when instantaneous frequency < centre  →  space tone.
        const disc = this._fmPrevI * qLP - this._fmPrevQ * iLP;
        this._fmPrevI = iLP;
        this._fmPrevQ = qLP;
        if (!legacyNavtexMode) this._fskSnrSample(iLP, qLP);

        // Step 4: normalise by signal power for amplitude-independent output.
        const power = iLP * iLP + qLP * qLP + 1e-10;

        // Step 5: post-discriminator LPF — bit-rate matched noise rejection.
        // Scaled so mark reads ≈ +1 and space ≈ −1 at ANY sample rate: the raw
        // sin(Δφ) shrinks as 1/SR, and at 24 kHz and up it fell below the
        // fixed ±0.1 threshold seeds, pinning every bit to space.
        logicLevel = this._nvBiquadFilter(this._fmDiscLPF, disc / power) * this._fmDiscGain;

        // Step 6: adaptive midpoint threshold.
        //   Track separate EMAs for samples landing on the mark side vs the
        //   space side of the current threshold, then use their midpoint as
        //   the new threshold.  This continuously cancels the DC bias that
        //   accumulates whenever the centre frequency is even slightly off,
        //   without needing periodic auto-tune scans.
        //   The EMA input is clamped to ±2 (tones sit at ±1). An FM click when
        //   the signal dips is a huge spike; unclamped it dragged one EMA past
        //   the other tone, and since that side then never crossed the
        //   threshold again its EMA could not recover — decoding stopped dead.
        const lvEma = logicLevel > 2 ? 2 : (logicLevel < -2 ? -2 : logicLevel);
        if (logicLevel > this._fskThresh) {
          this._fskMarkEMA  += (lvEma - this._fskMarkEMA)  * this._fskThreshAlpha;
        } else {
          this._fskSpaceEMA += (lvEma - this._fskSpaceEMA) * this._fskThreshAlpha;
        }
        this._fskThresh = (this._fskMarkEMA + this._fskSpaceEMA) * 0.5;
        markState = (logicLevel > this._fskThresh);

        // Signal level tracking via IQ envelope (same scale as dual-BPF path).
        const envelope = Math.sqrt(power);
        this._nvAudioAverage += (envelope - this._nvAudioAverage) * this._nvAudioAverageTc;
        this._nvAudioAverage = Math.max(0.1, this._nvAudioAverage);

      } else {
        // ── Dual-BPF envelope detector (CCIR-476 / NAVTEX / maritime) ───────
        const markLevel  = this._nvBiquadFilter(this._nvMarkFilter, dv);
        const spaceLevel = this._nvBiquadFilter(this._nvSpaceFilter, dv);
        const markAbs    = Math.abs(markLevel);
        const spaceAbs   = Math.abs(spaceLevel);

        this._nvAudioAverage += (Math.max(markAbs, spaceAbs) - this._nvAudioAverage) * this._nvAudioAverageTc;
        this._nvAudioAverage = Math.max(0.1, this._nvAudioAverage);

        const diffAbs = (markAbs - spaceAbs) / this._nvAudioAverage;
        logicLevel = this._nvBiquadFilter(this._nvLowFilter, diffAbs);
        markState  = (logicLevel > 0);

        if (!legacyNavtexMode) {
          const signalNow = Math.max(markAbs, spaceAbs);
          const noiseNow  = Math.min(markAbs, spaceAbs) + 1e-9;
          this._fskSignalEMA += (signalNow - this._fskSignalEMA) * 0.01;
          this._fskNoiseEMA  += (noiseNow  - this._fskNoiseEMA)  * 0.01;
        }
      }

      this._nvSignalAccumulator += markState ? 1 : -1;
      this._nvBitDuration++;

      // Async (ITA2/ASCII) start-bit hunt at SAMPLE resolution. Waiting for the
      // bit-period majority vote to read 0 found the start bit anywhere from
      // ½ to 1½ bits after its edge, so every data window of the character sat
      // up to ½ bit off — on a clean signal that misframed whole lines, and a
      // misframe on back-to-back RTTY tends to lock itself in.
      if (this._nvAsyncMode) {
        const m = (markState ? 1 : 0) ^ this._nvInverted;
        if (this._fskHuntPrev === 1 && m === 0) this._fskLastFallAt = this._nvSampleCount;
        this._fskHuntPrev = m;
        if (this._fskAsyncState === 'hunt' && this._fskLastFallAt >= 0 &&
            this._nvSampleCount - this._fskLastFallAt < this._nvHalfBitSampleCount) {
          this._fskAsyncStartAt(this._fskLastFallAt);
        }
      }

      if (markState !== this._nvOldMarkState) {
        if ((this._nvBitDuration % this._nvBitSampleCount) > this._nvHalfBitSampleCount) {
          let index = Math.floor((this._nvSampleCount - this._nvNextEventCount + this._nvBitSampleCount * 8) % this._nvBitSampleCount);
          index = Math.floor(index / this._nvZeroCrossingsDivisor);
          if (index >= 0 && index < this._nvZeroCrossings.length) this._nvZeroCrossings[index]++;
        }
        this._nvBitDuration = 0;
      }
      this._nvOldMarkState = markState;

      if ((this._nvSampleCount % this._nvBitSampleCount) === 0) {
        this._nvZeroCrossingCount++;
        if (this._nvZeroCrossingCount >= this._nvZeroCrossingSamples) {
          let best = 0;
          let bestIndex = 0;
          for (let j = 0; j < this._nvZeroCrossings.length; j++) {
            const q = this._nvZeroCrossings[j];
            this._nvZeroCrossings[j] = 0;
            if (q > best) {
              best = q;
              bestIndex = j;
            }
          }
          if (best > 0) {
            let index = bestIndex * this._nvZeroCrossingsDivisor;
            index = ((index + this._nvHalfBitSampleCount) % this._nvBitSampleCount) - this._nvHalfBitSampleCount;
            index /= 8.0;
            this._nvSyncDelta = index;
            this._nvBaudError = index;
          }
          this._nvZeroCrossingCount = 0;
        }
      }

      this._nvPulseEdgeEvent = (this._nvSampleCount >= this._nvNextEventCount);
      if (this._nvPulseEdgeEvent) {
        this._nvAveragedMarkState = ((this._nvSignalAccumulator > 0) ? 1 : 0) ^ this._nvInverted;
        this._nvSignalAccumulator = 0;
        // Fractional bit-period accumulator: compensates for the rounding
        // error in _nvBitSampleCount (e.g. ham RTTY 45.45 Bd @ 12 kHz =
        // 263.956 samples/bit — rounded to 264, error −0.044/bit).
        // Every ~23 bits the accumulator crosses ±0.5 and fires a ±1-sample
        // correction, keeping the long-run average period exact.
        // For maritime (120.0) and weather (240.0) the error is 0 — no-op.
        this._nvBitPeriodFrac += this._nvBitPeriodTrue - this._nvBitSampleCount;
        const _bpCorr = Math.round(this._nvBitPeriodFrac);
        this._nvBitPeriodFrac -= _bpCorr;
        // For async ITA2: do NOT apply _nvSyncDelta — the zero-crossing sync
        // fires on absolute sample count (not relative to the bit clock anchor)
        // so after a start-bit re-anchor its corrections are phase-noise.
        // Start-bit re-anchoring already gives exact alignment; _nvSyncDelta
        // would only corrupt it.  CCIR-476 (synchronous, no re-anchor) still
        // benefits from the sync correction, so we keep it there.
        const _syncCorr = this._nvAsyncMode ? 0 : Math.floor(this._nvSyncDelta + 0.5);
        this._nvNextEventCount = this._nvSampleCount + this._nvBitSampleCount + _bpCorr + _syncCorr;
        this._nvSyncDelta = 0;
      }

      if (this._nvAudioAverage < this._nvAudioMinimum) {
        if (this._nvState !== KiwiFSKDecoder._NV_STATE_NOSIGNAL) {
          this._nvSetState(KiwiFSKDecoder._NV_STATE_NOSIGNAL);
          if (legacyNavtexMode) this._nvCloseHeaderless('lost');
          if (!legacyNavtexMode && this._fskCb) {
            this._fskCb({ type: 'status', variant: preset.name, text: 'No signal' });
          }
        }
      } else if (this._nvState === KiwiFSKDecoder._NV_STATE_NOSIGNAL) {
        this._nvSyncSetup = 1;
      }

      if (this._nvPulseEdgeEvent) {
        if (this._nvAsyncMode && !legacyNavtexMode) this._fskSnrBit();
        if (preset.protocol === 'ccir476') {
          this._nvHandleBit(this._nvAveragedMarkState ? 1 : 0);
        } else {
          this._fskHandleAsyncBit(this._nvAveragedMarkState ? 1 : 0, preset);
        }
      }

      this._nvSampleCount++;

      if (!legacyNavtexMode && this._fskCb) {
        const nowMs = (this._nvSampleCount / (this._nvSampleRate || 12000)) * 1000;
        if ((nowMs - (this._fskLastMetricsAt || 0)) >= 250) {
          this._fskLastMetricsAt = nowMs;
          // Async FSK reports the tone-correlator SNR (3 kHz reference); the
          // CCIR-476 path keeps its mark/space filter ratio.
          const snrDb = this._nvAsyncMode
            ? this._fskSnrDb
            : 20 * Math.log10(((this._fskSignalEMA || 1e-6) + 1e-6) / ((this._fskNoiseEMA || 1e-6) + 1e-6));
          const succ = this._nvSucceedTally || this._fskCharsDecoded || 0;
          const fail = this._nvFailTally || this._fskInvalidFrames || 0;
          const lockQuality = Math.max(0, Math.min(100, Math.round(100 * succ / Math.max(1, succ + fail))));
          this._fskCb({
            type: 'metrics',
            variant: preset.name,
            snrDb,
            lockQuality,
            centerHz: this._nvCenterFreq,
            shiftHz: this._nvShiftHz,
            // USB RTTY: mark = lower tone, space = higher tone.
            // _nvInverted=1 means the preset uses standard USB polarity.
            markHz:  this._nvInverted
              ? this._nvCenterFreq - this._nvShiftHz / 2
              : this._nvCenterFreq + this._nvShiftHz / 2,
            spaceHz: this._nvInverted
              ? this._nvCenterFreq + this._nvShiftHz / 2
              : this._nvCenterFreq - this._nvShiftHz / 2,
            baud: this._nvBaudRate,
            timingLocked: !!this._fskTimingLock,
            inverted: !!this._nvInverted,
            squelchOpen: this._nvAsyncMode ? !!this._fskSquelchOpen : true,
          });
        }
        if (this._fskAutoShift && preset.protocol !== 'ccir476' && (nowMs - (this._fskLastAutoShiftAt || 0)) >= 1500 && this._fskCharsDecoded < 2) {
          this._fskLastAutoShiftAt = nowMs;
          this._fskTryAutoShift(preset);
        }
        // Auto-center: run when manually requested OR when decoding is failing badly.
        // Throttled to once every 4 s to avoid spinning the CPU.
        const autoCenterDue = this._fskAutoCenterPending ||
          ((this._fskInvalidFrames || 0) > 30 && (this._fskCharsDecoded || 0) < 3);
        if (preset.protocol !== 'ccir476' && autoCenterDue &&
            (nowMs - (this._fskLastAutoCenterAt || 0)) >= 4000) {
          this._fskLastAutoCenterAt = nowMs;
          this._fskAutoCenterPending = false;
          this._fskTryAutoCenter(preset);
        }
      }
    }
  }

  // ── Kiwi JNX-style sync/read state machine for CCIR-476 ─────────────────

  _nvHandleBit(bit) {
    const NV = KiwiFSKDecoder;

    if (this._nvSyncSetup) {
      this._nvDecoderReset();
      this._nvSetState(NV._NV_STATE_SYNC1);
      this._nvSyncSetup = 0;
    }

    switch (this._nvState) {
      case NV._NV_STATE_NOSIGNAL:
        break;

      case NV._NV_STATE_SYNC1:
        this._nvCodeBits = (this._nvCodeBits >> 1) | (bit ? this._nvMsb : 0);
        if (this._nvCheckBits(this._nvCodeBits)) {
          this._nvSyncChars.push(this._nvCodeBits);
          this._nvValidCount++;
          this._nvBitCount = 0;
          this._nvCodeBits = 0;
          this._nvSetState(NV._NV_STATE_SYNC2);
          this._nvWaiting = true;
        }
        break;

      case NV._NV_STATE_SYNC2:
        this._nvWaiting = false;
        this._nvCodeBits = (this._nvCodeBits >> 1) | (bit ? this._nvMsb : 0);
        this._nvBitCount++;
        if (this._nvBitCount === this._nvNbits) {
          if (this._nvCheckBits(this._nvCodeBits)) {
            this._nvSyncChars.push(this._nvCodeBits);
            this._nvCodeBits = 0;
            this._nvBitCount = 0;
            this._nvValidCount++;

            if (this._nvValidCount === 4) {
              for (let k = 0; k < this._nvSyncChars.length; k++) {
                const rv = this._nvProcessCode(this._nvSyncChars[k]);
                if (rv.tally === 1) this._nvSucceedTally++;
                else if (rv.tally === -1) this._nvFailTally++;
              }
              this._nvSetState(NV._NV_STATE_READ_DATA);
              if (this._navtexCb) this._navtexCb({ type: 'status', text: 'Phasing — sync acquired' });
              if (this._isFsk() && this._variant === 'maritime' && this._fskCb) {
                this._fskCb({ type: 'status', variant: 'maritime', text: 'Phasing — sync acquired' });
              }
            }
          } else {
            this._nvCodeBits = 0;
            this._nvBitCount = 0;
            this._nvSyncSetup = 1;
          }
          this._nvWaiting = true;
        }
        break;

      case NV._NV_STATE_READ_DATA:
        this._nvWaiting = false;
        this._nvCodeBits = (this._nvCodeBits >> 1) | (bit ? this._nvMsb : 0);
        this._nvBitCount++;
        if (this._nvBitCount === this._nvNbits) {
          const rv = this._nvProcessCode(this._nvCodeBits);
          if (rv.tally === 1) this._nvSucceedTally++;
          else if (rv.tally === -1) this._nvFailTally++;

          if (rv.success) {
            if (this._nvErrorCount > 0) this._nvErrorCount--;
          } else {
            this._nvErrorCount++;
            if (this._nvErrorCount > 2) {
              this._nvSyncSetup = 1;
              this._nvCloseHeaderless('lost');
              if (this._navtexCb) this._navtexCb({ type: 'status', text: 'Sync lost — scanning…' });
              if (this._isFsk() && this._variant === 'maritime' && this._fskCb) {
                this._fskCb({ type: 'status', variant: 'maritime', text: 'Sync lost — scanning…' });
              }
            }
          }
          this._nvBitCount = 0;
          this._nvCodeBits = 0;
          this._nvWaiting = true;
        }
        break;
    }
  }

  // ── Kiwi CCIR-476 decoder ────────────────────────────────────────────────

  _nvProcessCode(code) {
    const NV = KiwiFSKDecoder;
    const success = this._nvCheckBits(code);
    let tally = 0;
    let chr = -1;

    if (code === NV._NV_REP) {
      this._nvAlphaPhase = false;
    } else if (code === NV._NV_ALPHA) {
      this._nvAlphaPhase = true;
    }

    // FEC agreement, independent of which slot the decoder thinks is which:
    // every RX copy equals the code sent five slots earlier. The phasing
    // signals above are the only other way to learn the slot phase, and
    // someone who tunes in mid-message never hears them — half the time the
    // decoder then read the DX copies as if they were RX, printed them
    // unprotected, and never saw a copy agree. Agreements that keep landing
    // in the non-RX slots mean the phase is the wrong way round: swap it.
    const hist = this._nvSlotHist || (this._nvSlotHist = []);
    const agreeHere = success && hist.length >= 5 && hist[hist.length - 5] === code;
    hist.push(code);
    if (hist.length > 5) hist.shift();
    // Decide on agreement RATES, not a streak: ordinary text repeats a letter
    // five slots apart now and then, which fakes a wrong-slot agreement, and
    // at −6 dB a streak of three of those flipped a correct phase. Each slot
    // type keeps an average over ~8 of its slots; swap only when the wrong
    // ones clearly agree and the right ones clearly do not.
    const a = agreeHere ? 1 : 0;
    if (this._nvAlphaPhase) this._nvAgreeRx += (a - (this._nvAgreeRx || 0)) / 8;
    else                    this._nvAgreeDx += (a - (this._nvAgreeDx || 0)) / 8;
    if (!this._nvAlphaPhase && this._nvAgreeDx > 0.5 && this._nvAgreeRx < 0.2) {
      this._nvAlphaPhase = true;
      [this._nvAgreeRx, this._nvAgreeDx] = [this._nvAgreeDx, this._nvAgreeRx];
    }

    if (!this._nvAlphaPhase) {
      this._nvC1 = this._nvC2;
      this._nvC2 = this._nvC3;
      this._nvC3 = code;
    } else {
      if (this._nvStrictMode) {
        if (success && this._nvC1 === code) chr = code;
      } else {
        if (success) chr = code;
        else if (this._nvCheckBits(this._nvC1)) chr = this._nvC1;
      }

      // A run of RX copies agreeing with their DX copies (agreeHere, above).
      // Noise almost never produces one and a real signal almost always does;
      // idle phasing never counts, since five slots back from a phasing signal
      // is the other one. This run is what opens a headerless message.
      this._nvAgreeRun = agreeHere ? (this._nvAgreeRun || 0) + 1 : 0;

      if (chr === -1) {
        tally = -1;
      } else {
        tally = 1;
        switch (chr) {
          case NV._NV_REP:
          case NV._NV_ALPHA:
          case NV._NV_BETA:
          case NV._NV_CHAR32:
            break;
          case NV._NV_LTRS:
            this._nvShift = false;
            break;
          case NV._NV_FIGS:
            this._nvShift = true;
            break;
          default: {
            const ch = this._nvCodeToChar(chr, this._nvShift);
            if (ch) this._nvEmitCCIRChar(ch);
            break;
          }
        }
      }
    }

    this._nvAlphaPhase = !this._nvAlphaPhase;
    return { success, tally };
  }

  // ── Async FSK decoder for weather / ham and custom RTTY/ASCII ───────────

  _fskHandleAsyncBit(bit, preset) {
    // Async ham/weather FSK must not depend on NAVTEX/SITOR sync state.
    // Keep timing lock advisory-only and driven by async start-edge activity.
    const dataBits = this._fskDataBits || 5;
    const parityMode = this._fskParity || 'N';
    const needParity = parityMode !== 'N';
    // One recovered decision arrives per bit period. The receiver only needs to
    // confirm *one* stop-bit sample before resynchronising on the next start bit.
    // Using Math.ceil(stopBits) for 1.5/2-stop-bit RTTY would demand two full
    // bit-period samples, and the second sample routinely lands on the next start
    // bit (a 0), causing a cascade of framing errors. Always require just 1.
    const stopNeeded = 1;

    switch (this._fskAsyncState) {
      case 'hunt':
      default:
        // The start edge is found per sample in _nvFeedPCMCommon, which moves
        // the state to 'start'; a bit-period decision here carries no edge.
        break;

      case 'start':
        // The window just closed covers the start bit exactly. A majority of
        // mark means the edge was a noise glitch — go back to hunting.
        if (bit !== 0) { this._fskAsyncState = 'hunt'; break; }
        this._fskAsyncState = 'data';
        if (!this._fskTimingLock) this._fskTimingLock = true;
        if (!this._fskTimingAnnounced && this._fskCb) {
          this._fskCb({ type: 'status', variant: preset.name, text: 'Timing lock acquired' });
          this._fskTimingAnnounced = true;
        }
        break;

      case 'data':
        this._fskAsyncBits |= (bit ? 1 : 0) << this._fskAsyncBitIndex;
        this._fskAsyncBitIndex++;
        if (this._fskAsyncBitIndex >= dataBits) this._fskAsyncState = needParity ? 'parity' : 'stop';
        break;

      case 'parity':
        this._fskAsyncParityBit = bit ? 1 : 0;
        this._fskAsyncState = 'stop';
        break;

      case 'stop':
        if (bit === 1) {
          this._fskAsyncStopSeen++;
          if (this._fskAsyncStopSeen >= stopNeeded) {
            const code = this._fskAsyncBits;
            let parityOk = true;
            if (needParity) {
              const ones = this._fskPopcount(code & ((1 << dataBits) - 1));
              const expected = parityMode === 'E' ? (ones & 1) : ((ones + 1) & 1);
              parityOk = expected === this._fskAsyncParityBit;
            }
            if (parityOk) {
              this._fskEmitAsyncChar(code, preset);
              this._fskInvalidFrames = Math.max(0, (this._fskInvalidFrames || 0) - 1);
            } else if (this._fskCb && this._fskSquelchOpen) {
              this._fskInvalidFrames = (this._fskInvalidFrames || 0) + 1;
              this._fskCb({ type: 'parity-error', variant: preset.name });
            }
            this._fskAsyncState = 'hunt';
            this._fskAsyncBits = 0;
            this._fskAsyncBitIndex = 0;
            this._fskAsyncStopSeen = 0;
          }
        } else {
          // Space in the stop position: framing error. Do not take this 0 as
          // the next start bit — that re-anchors on an arbitrary mid-character
          // edge and keeps the misframe going. Hunt for the next mark→space
          // edge instead; only an edge after this moment counts.
          if (this._fskSquelchOpen) {
            this._fskInvalidFrames = (this._fskInvalidFrames || 0) + 1;
            if (this._fskCb) this._fskCb({ type: 'framing-error', variant: preset.name });
          }
          if ((this._fskInvalidFrames || 0) > 24 && (this._fskCharsDecoded || 0) < 2) {
            this._fskTimingLock = false;
            this._fskTimingAnnounced = false;
          }
          this._fskLastFallAt = -1;
          this._fskAsyncState = 'hunt';
          this._fskAsyncBits = 0;
          this._fskAsyncBitIndex = 0;
          this._fskAsyncStopSeen = 0;
        }
        break;
    }

    this._fskPrevBit = bit;
  }

  /** Start a character whose start-bit edge fell at sample index `edgeAt`. */
  _fskAsyncStartAt(edgeAt) {
    // The next bit window runs from the edge to one bit later, so the start
    // bit itself is integrated and checked before any data bit is taken.
    this._nvNextEventCount = edgeAt + Math.round(this._nvBitPeriodTrue);
    this._nvBitPeriodFrac  = this._nvBitPeriodTrue - Math.round(this._nvBitPeriodTrue);
    // Samples since the edge are all start bit; count them as space. The
    // accumulator holds the raw discriminator sign, before inversion.
    const n = this._nvSampleCount - edgeAt + 1;
    this._nvSignalAccumulator = this._nvInverted ? n : -n;
    this._nvSyncDelta = 0;
    // The SNR window restarts with the bit clock; the part before the edge
    // belonged to a window that no longer closes.
    this._snrHiRe = this._snrHiIm = this._snrLoRe = this._snrLoIm = 0;
    this._snrN = 0; this._snrW = 0; this._snrW2 = 0;
    this._fskLastFallAt = -1;
    this._fskAsyncState = 'start';
    this._fskAsyncBits = 0;
    this._fskAsyncBitIndex = 0;
    this._fskAsyncParityBit = 0;
    this._fskAsyncStopSeen = 0;
  }

  _fskPopcount(v) {
    v >>>= 0;
    let c = 0;
    while (v) { c += v & 1; v >>>= 1; }
    return c;
  }

  _fskEmitAsyncChar(code, preset) {
    // Squelched: noise frames are neither printed nor allowed to flip the
    // LTRS/FIGS state or feed the auto-tune counters.
    if (!this._fskSquelchOpen) return;
    const enc = this._fskEncoding || 'ita2';
    if (enc === 'ita2') return this._fskEmitITA2Char(code, preset);
    if (enc === 'ascii') return this._fskEmitASCIIChar(code, preset);
    return this._fskEmitITA2Char(code, preset);
  }

  _fskEmitASCIIChar(code, preset) {
    code &= (1 << (this._fskDataBits || 7)) - 1;
    let ch = '';
    if (code === 13) ch = '\n';
    else if (code === 10) ch = '\n';
    else if (code === 9) ch = '\t';
    else if (code >= 32 && code <= 126) ch = String.fromCharCode(code);
    else return;

    const cb = this._fskCb;
    if (!cb) return;
    this._fskCharsDecoded = (this._fskCharsDecoded || 0) + 1;
    cb({ type: 'char', variant: preset.name, char: ch });
  }

  _fskEmitITA2Char(code, preset) {
    code &= 0x1F;
    const tbl = this._fskShift ? KiwiFSKDecoder._FSK_ITA2_FIGS : KiwiFSKDecoder._FSK_ITA2_LTRS;
    let sym = tbl[code] || '';

    if (!sym) return;
    if (sym === 'LTRS') { this._fskShift = false; this._fskFigsRunLen = 0; return; }
    if (sym === 'FIGS') { this._fskShift = true;  this._fskFigsRunLen = 0; return; }

    // Auto-LTRS recovery: real ham RTTY text rarely stays in FIGS mode for more
    // than a handful of characters before the transmitter sends LTRS again.
    // If FIGS runs for >15 chars without a LTRS command, the shift state was
    // almost certainly flipped by a single bit error.  Force back to LTRS.
    if (this._fskShift) {
      this._fskFigsRunLen = (this._fskFigsRunLen || 0) + 1;
      if (this._fskFigsRunLen > 15) {
        this._fskShift = false;
        this._fskFigsRunLen = 0;
        if (this._fskCb) {
          this._fskCb({ type: 'status', variant: preset.name, text: 'Auto-LTRS: shift reset' });
        }
        // Re-read THIS character from the letters table rather than dropping
        // it. The shift state has just been corrected, so the code now has a
        // valid LTRS meaning — and it is the first character of the word where
        // reading resumes, which is the worst one to lose.
        sym = KiwiFSKDecoder._FSK_ITA2_LTRS[code] || '';
        if (!sym || sym === 'LTRS' || sym === 'FIGS') return;
      }
    } else {
      this._fskFigsRunLen = 0;
    }

    // Unshift-on-space: a space is a safe place to re-synchronise the shift
    // state, because the character after one is almost always a letter. This is
    // the main defence against a corrupted FIGS, which otherwise garbles every
    // character until the sender happens to transmit LTRS again — the auto-LTRS
    // rule above only steps in after 15 of them.
    //
    // Space is code 0x04 in BOTH tables, so it still reads as a space while the
    // decoder is wrongly in FIGS, which is exactly what makes this work.
    //
    // Trade-off: groups of digits separated by spaces (e.g. a contest exchange
    // "599 001") unshift after each space and print the later groups as
    // letters unless the sender repeats FIGS. Senders normally do, and this is
    // the standard behaviour of RTTY decoders.
    if (sym === ' ') { this._fskShift = false; this._fskFigsRunLen = 0; }

    const cb = this._fskCb;
    if (!cb) return;
    this._fskCharsDecoded = (this._fskCharsDecoded || 0) + 1;
    cb({ type: 'char', variant: preset.name, char: sym });
  }


  _fskTryAutoShift(preset) {
    if (!this._fskRecentPCM || this._fskRecentPCM.length < 512) return;
    const SR = this._nvSampleRate || this._sampleRateFn();
    const center = this._nvCenterFreq || preset.center || 1000;
    const candidates = preset.name === 'weather' ? [85, 170, 340, 425, 450, 850] : [85, 170, 200, 340, 425, 450];
    const samples = this._fskRecentPCM.slice(-Math.min(this._fskRecentPCM.length, 2048));
    const energyAt = (freq) => {
      const w = 2 * Math.PI * freq / SR;
      let re = 0, im = 0;
      for (let i = 0; i < samples.length; i++) {
        const a = w * i;
        const s = samples[i];
        re += s * Math.cos(a);
        im -= s * Math.sin(a);
      }
      return re * re + im * im;
    };
    // Noise reference: median energy of probes spread across the band the
    // candidates span. On noise the old arg-max picked a random shift every
    // 1.5 s (17 jumps in 30 s once the squelch stopped noise from printing).
    const span = Math.max(...candidates) / 2 + 60;
    const probes = [];
    for (let k = 0; k < 24; k++) probes.push(energyAt(center - span + (2 * span * (k + 0.5)) / 24));
    probes.sort((a, b) => a - b);
    const noiseRef = (probes[11] + probes[12]) / 2 + 1e-20;
    const curShift = this._nvShiftHz || preset.shift;
    const pairAt = (shift) => {
      const lo = energyAt(center - shift / 2), hi = energyAt(center + shift / 2);
      return { score: lo + hi, weak: Math.min(lo, hi) };
    };
    let bestShift = curShift;
    let best = pairAt(curShift);
    const curScore = best.score;
    for (const shift of candidates) {
      const p = pairAt(shift);
      if (p.score > best.score) { best = p; bestShift = shift; }
    }
    // Retune only on a real two-tone signal: both tones 8× (9 dB) over the
    // median noise probe — noise alone clears that about once an hour — and
    // twice the energy of the shift in use.
    const isSignal = best.weak > 8 * noiseRef && best.score > 2 * curScore;
    if (isSignal && Math.abs(bestShift - curShift) >= 20) {
      this._customConfig = { ...(this._customConfig || {}), shift: bestShift };
      this._fskReset();
      if (this._fskCb) {
        this._fskCb({ type: 'status', variant: preset.name, text: `Auto shift ${bestShift.toFixed(0)} Hz` });
      }
    }
    if ((this._fskInvalidFrames || 0) > 20 && (this._fskCharsDecoded || 0) === 0) {
      this._nvInverted = this._nvInverted ? 0 : 1;
      this._fskInvalidFrames = 0;
      this._fskAsyncState = 'hunt';
      if (this._fskCb) this._fskCb({ type: 'status', variant: preset.name, text: 'Auto invert' });
    }
  }

  // ── Auto-center: scan the spectrum to find where the two FSK tones actually are
  //
  // Algorithm (two-pass Goertzel sweep):
  //   Pass 1 — coarse: 20 Hz steps across 300–2700 Hz
  //             score(c) = energy(c - shift/2) + energy(c + shift/2)
  //             constrained so both tones land inside 200–2800 Hz
  //   Pass 2 — fine:   5 Hz steps ±120 Hz around the coarse best
  //   Accept only if:
  //     • both tone energies > 10 % of the combined peak   (signal present)
  //     • tone balance ratio < 4:1                         (not just one tone)
  //     • new center differs from current by ≥ 10 Hz       (worth changing)
  //   On success: update _nvCenterFreq, re-init discriminator, notify UI.

  _fskTryAutoCenter(preset) {
    if (!this._fskRecentPCM || this._fskRecentPCM.length < 1024) return;
    const SR     = this._nvSampleRate || this._sampleRateFn();
    const shift  = this._nvShiftHz || preset.shift;
    const half   = shift / 2.0;
    // Use up to 4096 samples (~340 ms at 12 kHz) for good frequency resolution.
    const buf    = this._fskRecentPCM.slice(-Math.min(this._fskRecentPCM.length, 4096));
    const N      = buf.length;

    // Goertzel single-frequency energy — O(N) per frequency.
    const energy = (freq) => {
      const w  = 2.0 * Math.PI * freq / SR;
      const c2 = 2.0 * Math.cos(w);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < N; i++) {
        const sNew = buf[i] + c2 * s1 - s2;
        s2 = s1; s1 = sNew;
      }
      return s1 * s1 + s2 * s2 - c2 * s1 * s2;
    };

    // Score a candidate center: sum of both tone energies, penalised if unbalanced.
    const score = (c) => {
      const lo = c - half;
      const hi = c + half;
      if (lo < 150 || hi > SR / 2 - 100) return -1;
      const eLo = energy(lo);
      const eHi = energy(hi);
      const sum = eLo + eHi;
      if (sum < 1e-6) return -1;
      // Balance penalty: ratio of larger to smaller must be < 4:1
      const ratio = Math.max(eLo, eHi) / (Math.min(eLo, eHi) + 1e-12);
      if (ratio > 4.0) return sum * (4.0 / ratio);  // soft penalty
      return sum;
    };

    // Pass 1 — coarse scan 300 Hz to 2700 Hz in 20 Hz steps.
    let bestCenter = this._nvCenterFreq;
    let bestScore  = -Infinity;
    for (let c = 300; c <= 2700; c += 20) {
      const s = score(c);
      if (s > bestScore) { bestScore = s; bestCenter = c; }
    }

    // Pass 2 — fine scan ±120 Hz around coarse best in 5 Hz steps.
    const coarse = bestCenter;
    for (let c = coarse - 120; c <= coarse + 120; c += 5) {
      const s = score(c);
      if (s > bestScore) { bestScore = s; bestCenter = c; }
    }

    // Validate: require both tones to have meaningful energy.
    const eLo  = energy(bestCenter - half);
    const eHi  = energy(bestCenter + half);
    const eSum = eLo + eHi;
    const ePeak = Math.max(eLo, eHi);
    if (Math.min(eLo, eHi) < ePeak * 0.08) {
      // Only one tone visible — probably just noise or a carrier. Don't retune.
      if (this._fskCb) {
        this._fskCb({ type: 'status', variant: preset.name,
          text: 'Auto-tune: no dual-tone signal found' });
      }
      return;
    }

    const delta = Math.abs(bestCenter - this._nvCenterFreq);
    if (delta < 10) {
      // Already well-centered.
      if (this._fskCb) {
        this._fskCb({ type: 'status', variant: preset.name,
          text: `Auto-tune: already centered at ${Math.round(this._nvCenterFreq)} Hz` });
      }
      return;
    }

    // Capture old center before _fskReset() overwrites _nvCenterFreq.
    const oldCenter = Math.round(this._nvCenterFreq);

    // Apply new center — update custom config so it survives _fskReset().
    this._customConfig = { ...(this._customConfig || {}), center: Math.round(bestCenter) };
    this._fskReset();

    if (this._fskCb) {
      this._fskCb({ type: 'status', variant: preset.name,
        text: 'Auto-tune: center ' + Math.round(bestCenter) + ' Hz (was ' + oldCenter + ' Hz)' });
      // Also fire a metrics update so the UI center field updates immediately.
      // Respect _nvInverted so mark/space labels match the regular metrics callback.
      const inv = !!this._nvInverted;
      this._fskCb({
        type: 'metrics', variant: preset.name,
        snrDb: 0, lockQuality: 0,
        centerHz: Math.round(bestCenter),
        shiftHz: this._nvShiftHz,
        markHz:  inv ? Math.round(bestCenter) - this._nvShiftHz / 2
                     : Math.round(bestCenter) + this._nvShiftHz / 2,
        spaceHz: inv ? Math.round(bestCenter) + this._nvShiftHz / 2
                     : Math.round(bestCenter) - this._nvShiftHz / 2,
        baud: this._nvBaudRate, timingLocked: false, inverted: !!this._nvInverted
      });
    }
  }

  // ── Shared emitters ──────────────────────────────────────────────────────

  _nvEmitCCIRChar(ch) {
    this._nvEmitNavtexChar(ch);
    if (this._isFsk() && this._variant === 'maritime' && this._fskCb && ch !== '\r') {
      this._fskCharsDecoded = (this._fskCharsDecoded || 0) + 1;
      this._fskCb({ type: 'char', variant: 'maritime', char: ch });
    }
  }

  // ── NAVTEX message framing layer ─────────────────────────────────────────

  _nvEmitNavtexChar(ch) {
    const cb = this._navtexCb;
    if (!cb) return;
    if (ch === '\r') return;

    if (!this._nvInMsg) {
      this._nvRawWin = (this._nvRawWin + ch).slice(-32);
      if (this._nvRawWin.includes('ZCZC')) { this._nvStartFramed(); return; }

      // No ZCZC seen: someone tuned in mid-message, or the header was lost to
      // noise. Open a headerless message once NAVTEX_HEADERLESS_RUN characters
      // in a row arrived with both FEC copies agreeing, and include them.
      // Only real text counts: the line ends and spaces after an NNNN agree
      // too, and would otherwise open one just before the next ZCZC. For the
      // same reason, never open while the tail could still become "ZCZC".
      if ((this._nvAgreeRun || 0) === 0) { this._nvPreBuf = ''; return; }
      this._nvPreBuf = (this._nvPreBuf + ch).slice(-16);
      if (this._nvAgreeRun < NAVTEX_HEADERLESS_RUN) return;
      if (this._nvPreBuf.replace(/\s/g, '').length < NAVTEX_HEADERLESS_RUN) return;
      if (/(^|[^Z])(Z|ZC|ZCZ)$/.test(this._nvPreBuf)) return;
      this._nvInMsg = true;
      this._nvHeaderless = true;
      this._nvHeaderDone = true;
      this._nvStation = '?'; this._nvSubject = '?'; this._nvSerial = '??';
      this._nvNRun = ''; this._nvZHold = '';
      cb({ type: 'navstart', station: '?', subject: '?', seq: '??', headerless: true });
      const pre = this._nvPreBuf.replace(/^\s+/, '');
      this._nvPreBuf = '';
      for (const c of pre) this._nvEmitHeaderlessChar(c);
      return;
    }

    if (this._nvHeaderless) { this._nvEmitHeaderlessChar(ch); return; }

    if (!this._nvHeaderDone) {
      this._nvHeader += ch;
      const m = this._nvHeader.match(/^\s*([A-Z])([A-Z])(\d{2})/);
      // Give up on a corrupted header at the end of its line or after a
      // dozen characters; what arrived is then shown rather than lost.
      if (!m && ch !== '\n' && this._nvHeader.length < 12) return;
      this._nvHeaderDone = true;
      this._nvStation = m ? m[1] : '?';
      this._nvSubject = m ? m[2] : '?';
      this._nvSerial  = m ? m[3] : '??';
      cb({ type: 'navstart', station: this._nvStation, subject: this._nvSubject, seq: this._nvSerial });
      const rest = m ? this._nvHeader.slice(m[0].length) : this._nvHeader.replace(/^\s+/, '');
      for (const c of rest) this._nvEmitBodyChar(c);
      return;
    }

    this._nvEmitBodyChar(ch);
  }

  /** A ZCZC arrived: begin a normal message (closing a headerless one first). */
  _nvStartFramed() {
    if (this._nvHeaderless) this._nvCloseHeaderless('next');
    // The header (station, subject, serial — "ZCZC JA01") is still on its way
    // when ZCZC itself completes. Parsing at that moment always failed and put
    // "????" in the banner with the header in the message text, so the
    // characters after ZCZC are held until the header is complete.
    this._nvInMsg = true;
    this._nvHeaderless = false;
    this._nvHeader = '';
    this._nvHeaderDone = false;
    this._nvMsgTail = '';
    this._nvNRun = '';
    this._nvZHold = '';
    this._nvPreBuf = '';
  }

  /** Headerless text: like a normal body, but a ZCZC here starts a real message. */
  _nvEmitHeaderlessChar(ch) {
    const cand = this._nvZHold + ch;
    if ('ZCZC'.startsWith(cand)) {
      if (cand === 'ZCZC') { this._nvZHold = ''; this._nvStartFramed(); return; }
      this._nvZHold = cand;
      return;
    }
    const held = this._nvZHold;
    this._nvZHold = '';
    for (const c of held) { this._nvEmitBodyChar(c); if (!this._nvInMsg) return; }
    if (ch === 'Z') { this._nvZHold = 'Z'; return; }
    this._nvEmitBodyChar(ch);
  }

  /** End a headerless message: 'lost' (sync or signal gone) or 'next' (a ZCZC). */
  _nvCloseHeaderless(reason) {
    if (!this._nvInMsg || !this._nvHeaderless) return;
    const cb = this._navtexCb;
    // Held N's and Z's were text after all.
    for (const c of this._nvNRun + this._nvZHold) if (cb) cb({ type: 'char', char: c });
    this._nvInMsg = false;
    this._nvHeaderless = false;
    this._nvNRun = ''; this._nvZHold = ''; this._nvPreBuf = ''; this._nvRawWin = '';
    this._nvAgreeRun = 0;
    if (cb) cb({ type: 'navend', station: '?', subject: '?', seq: '??', headerless: true, reason });
  }

  /** Message text, with NNNN held back so its first three N's never print. */
  _nvEmitBodyChar(ch) {
    const cb = this._navtexCb;
    if (ch === 'N') {
      this._nvNRun += 'N';
      if (this._nvNRun.length < 4) return;
      cb({ type: 'navend', station: this._nvStation, subject: this._nvSubject, seq: this._nvSerial,
           headerless: !!this._nvHeaderless, reason: 'nnnn' });
      this._nvInMsg = false;
      this._nvHeaderless = false;
      this._nvAgreeRun = 0;
      this._nvRawWin = '';
      this._nvMsgTail = '';
      this._nvNRun = '';
      return;
    }
    // Not the end marker after all ("NNW 6", "INNER"): release the held N's.
    for (const n of this._nvNRun) cb({ type: 'char', char: n });
    this._nvNRun = '';
    cb({ type: 'char', char: ch });
  }
}
