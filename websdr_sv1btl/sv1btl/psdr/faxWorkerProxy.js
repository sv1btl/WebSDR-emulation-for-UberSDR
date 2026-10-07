/**
 * faxWorkerProxy.js — stand-in for KiwiFAXDecoder that runs the real decoder
 * inside fax.worker.js.  Mirrors sstvWorkerProxy.js; see that file for the
 * rationale behind lazy creation, the in-thread fallback and the PCM copy.
 */

import { KiwiFAXDecoder } from './fax.js';

export class FAXWorkerProxy {

  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate
      : (() => options.sampleRate || 12000);
    this._callback = typeof options.callback === 'function' ? options.callback : null;

    this._cfg = {
      lpm:       options.lpm   || 120,
      ioc:       options.ioc   || 576,
      shift:     options.shift || 800,
      autoAlign: options.autoAlign !== undefined ? !!options.autoAlign : true,
      enabled:   false
    };

    this._worker = null;
    this._local  = null;
  }

  // ── Worker lifecycle ───────────────────────────────────────────────────────

  _ensureWorker() {
    if (this._worker || this._local) return;

    try {
      this._worker = new Worker(
        new URL('./fax.worker.js', import.meta.url),
        { type: 'module' }
      );
    } catch (e) {
      console.warn('[FAX] Worker unavailable, decoding in-thread:', e);
      this._startLocal();
      return;
    }

    this._worker.onmessage = ({ data }) => {
      if (typeof this._callback === 'function') this._callback(data);
    };
    this._worker.onerror = (e) => {
      console.error('[FAX] Worker error, falling back to in-thread decoding:', e);
      try { this._worker.terminate(); } catch (_) {}
      this._worker = null;
      this._startLocal();
    };

    this._post({
      t:          'init',
      sampleRate: this._sampleRateFn() || 12000,
      lpm:        this._cfg.lpm,
      ioc:        this._cfg.ioc,
      shift:      this._cfg.shift,
      autoAlign:  this._cfg.autoAlign,
      enabled:    this._cfg.enabled
    });
  }

  _startLocal() {
    if (this._local) return;
    this._local = new KiwiFAXDecoder({
      sampleRate: this._sampleRateFn,
      callback:   (event) => { if (this._callback) this._callback(event); },
      lpm:        this._cfg.lpm,
      ioc:        this._cfg.ioc,
      shift:      this._cfg.shift,
      autoAlign:  this._cfg.autoAlign,
    });
    this._local.setEnabled(this._cfg.enabled);
  }

  _post(msg, transfer) {
    if (!this._worker) return;
    try { this._worker.postMessage(msg, transfer || []); }
    catch (e) { console.error('[FAX] postMessage failed:', e); }
  }

  // ── KiwiFAXDecoder-compatible surface ─────────────────────────────────────

  setEnabled(enabled) {
    this._cfg.enabled = !!enabled;
    if (enabled) this._ensureWorker();
    if (this._local) { this._local.setEnabled(this._cfg.enabled); return; }
    this._post({ t: 'enable', on: this._cfg.enabled });
  }

  setCallback(fn) {
    this._callback = typeof fn === 'function' ? fn : null;
    if (this._local) this._local.setCallback(this._callback);
  }

  setParams(lpm, ioc, shift) {
    this._cfg.lpm   = lpm   || 120;
    this._cfg.ioc   = ioc   || 576;
    this._cfg.shift = shift || 800;
    if (this._local) { this._local.setParams(this._cfg.lpm, this._cfg.ioc, this._cfg.shift); return; }
    this._post({ t: 'params', lpm: this._cfg.lpm, ioc: this._cfg.ioc, shift: this._cfg.shift });
  }

  setAutoAlign(enabled) {
    this._cfg.autoAlign = !!enabled;
    if (this._local) { this._local.setAutoAlign(this._cfg.autoAlign); return; }
    this._post({ t: 'autoAlign', on: this._cfg.autoAlign });
  }

  reset() {
    if (this._local) { this._local.reset(); return; }
    this._post({ t: 'reset' });
  }

  /** The chunk is COPIED before posting — see sstvWorkerProxy.feedPCM. */
  feedPCM(pcm, inputSampleRate = null) {
    if (!pcm || pcm.length === 0) return;
    if (this._local) { this._local.feedPCM(pcm, inputSampleRate); return; }
    this._ensureWorker();
    if (this._local) { this._local.feedPCM(pcm, inputSampleRate); return; }
    const copy = new Float32Array(pcm);
    this._post({
      t: 'pcm',
      pcm: copy,
      sampleRate: this._sampleRateFn() || 12000,
      inputSampleRate: inputSampleRate || null
    }, [copy.buffer]);
  }

  destroy() {
    if (this._local) { try { this._local.destroy(); } catch (_) {} this._local = null; }
    if (this._worker) {
      this._post({ t: 'destroy' });
      try { this._worker.terminate(); } catch (_) {}
      this._worker = null;
    }
    this._callback = null;
    this._cfg.enabled = false;
  }
}
