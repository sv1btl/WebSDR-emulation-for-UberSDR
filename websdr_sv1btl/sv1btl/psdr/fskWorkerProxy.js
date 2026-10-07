/**
 * fskWorkerProxy.js — stand-in for KiwiFSKDecoder that runs the real engine
 * inside fsk.worker.js.  Mirrors sstvWorkerProxy.js / faxWorkerProxy.js; see
 * those for the rationale behind lazy creation, the in-thread fallback and the
 * PCM copy.
 *
 * One proxy = one role = one worker.  audio.js builds two: 'navtex' and 'fsk'.
 */

import { KiwiFSKDecoder } from './fsk.js';

export class FSKWorkerProxy {

  constructor(options = {}) {
    this._role = options.role === 'navtex' ? 'navtex' : 'fsk';
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate
      : (() => options.sampleRate || 12000);
    this._callback = typeof options.callback === 'function' ? options.callback : null;

    this._cfg = {
      variant: String(options.variant || 'maritime').toLowerCase(),
      config:  options.config ? { ...options.config } : null,
      enabled: false
    };

    this._worker = null;
    this._local  = null;
  }

  // ── Worker lifecycle ───────────────────────────────────────────────────────

  _ensureWorker() {
    if (this._worker || this._local) return;

    try {
      this._worker = new Worker(
        new URL('./fsk.worker.js', import.meta.url),
        { type: 'module' }
      );
    } catch (e) {
      console.warn(`[${this._role.toUpperCase()}] Worker unavailable, decoding in-thread:`, e);
      this._startLocal();
      return;
    }

    this._worker.onmessage = ({ data }) => {
      if (typeof this._callback === 'function') this._callback(data);
    };
    this._worker.onerror = (e) => {
      console.error(`[${this._role.toUpperCase()}] Worker error, falling back to in-thread decoding:`, e);
      try { this._worker.terminate(); } catch (_) {}
      this._worker = null;
      this._startLocal();
    };

    this._post({
      t:          'init',
      role:       this._role,
      sampleRate: this._sampleRateFn() || 12000,
      variant:    this._cfg.variant,
      config:     this._cfg.config,
      enabled:    this._cfg.enabled
    });
  }

  _startLocal() {
    if (this._local) return;
    this._local = new KiwiFSKDecoder({
      role:       this._role,
      sampleRate: this._sampleRateFn,
      callback:   (event) => { if (this._callback) this._callback(event); },
      variant:    this._cfg.variant,
      config:     this._cfg.config,
    });
    this._local.setEnabled(this._cfg.enabled);
  }

  _post(msg, transfer) {
    if (!this._worker) return;
    try { this._worker.postMessage(msg, transfer || []); }
    catch (e) { console.error(`[${this._role.toUpperCase()}] postMessage failed:`, e); }
  }

  // ── KiwiFSKDecoder-compatible surface ─────────────────────────────────────

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

  setVariant(variant = 'maritime') {
    this._cfg.variant = String(variant || 'maritime').toLowerCase();
    if (this._local) { this._local.setVariant(this._cfg.variant); return; }
    this._post({ t: 'variant', variant: this._cfg.variant });
  }

  setConfig(cfg = null) {
    this._cfg.config = (cfg && typeof cfg === 'object') ? { ...cfg } : null;
    if (this._local) { this._local.setConfig(this._cfg.config); return; }
    this._post({ t: 'config', config: this._cfg.config });
  }

  /**
   * Best-effort view of the configuration, from the proxy's own mirror.  The
   * live preset lives in the worker; auto-shift / auto-centre changes are
   * reported through 'status' and 'metrics' events rather than read back here.
   */
  getConfig() {
    return { variant: this._cfg.variant, ...(this._cfg.config || {}) };
  }

  setAutoShift(enabled) {
    if (this._local) { this._local.setAutoShift(enabled); return; }
    this._post({ t: 'autoShift', on: !!enabled });
  }

  setAutoCenter(enabled) {
    if (this._local) { this._local.setAutoCenter(enabled); return; }
    this._post({ t: 'autoCenter', on: !!enabled });
  }

  /** The chunk is COPIED before posting — see sstvWorkerProxy.feedPCM. */
  feedPCM(pcm) {
    if (!pcm || pcm.length === 0) return;
    if (this._local) { this._local.feedPCM(pcm); return; }
    this._ensureWorker();
    if (this._local) { this._local.feedPCM(pcm); return; }
    const copy = new Float32Array(pcm);
    this._post({ t: 'pcm', pcm: copy, sampleRate: this._sampleRateFn() || 12000 },
               [copy.buffer]);
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
