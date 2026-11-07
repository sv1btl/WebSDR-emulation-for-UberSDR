/**
 * servicesWorkerProxy.js — front for services.worker.js (DSC, and later time
 * signals, ALE 2G, HF Selcall). Same idea as hfdlWorkerProxy.js: the worker
 * is only created on first activation, and every PCM block is copied before
 * it is transferred.
 */

export class ServicesWorkerProxy {
  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate
      : (() => options.sampleRate || 12000);
    this._callback = typeof options.callback === 'function' ? options.callback : null;
    this._enabled = false;
    this._service = '';
    this._opts = {};
    this._worker = null;
  }

  _ensureWorker() {
    if (this._worker) return;
    try {
      this._worker = new Worker(new URL('./services.worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      console.error('[SERVICES] Worker unavailable:', e);
      if (this._callback) this._callback({ type: 'error', message: String(e && e.message || e) });
      return;
    }
    this._worker.onmessage = ({ data }) => {
      if (typeof this._callback === 'function') this._callback(data);
    };
    this._worker.onerror = (e) => {
      console.error('[SERVICES] Worker error:', e);
      if (this._callback) this._callback({ type: 'error', message: e.message || 'worker error' });
    };
    this._post({
      t: 'init',
      sampleRate: this._sampleRateFn() || 12000,
      service: this._service,
      opts: this._opts,
      enabled: this._enabled,
    });
  }

  _post(msg, transfer) {
    if (!this._worker) return;
    try { this._worker.postMessage(msg, transfer || []); }
    catch (e) { console.error('[SERVICES] postMessage failed:', e); }
  }

  setCallback(fn) { this._callback = typeof fn === 'function' ? fn : null; }

  /** Choose the engine ('dsc', ...) and its options; resets it. */
  setService(name, opts = {}) {
    this._service = String(name || '');
    this._opts = { ...opts };
    this._post({ t: 'service', service: this._service, opts: this._opts });
  }

  setOptions(opts = {}) {
    this._opts = { ...this._opts, ...opts };
    this._post({ t: 'opts', opts });
  }

  setEnabled(enabled) {
    this._enabled = !!enabled;
    if (this._enabled) this._ensureWorker();
    this._post({ t: 'enable', on: this._enabled });
  }

  reset() { this._post({ t: 'reset' }); }

  feedPCM(pcm) {
    if (!this._enabled || !pcm || pcm.length === 0) return;
    this._ensureWorker();
    const copy = new Float32Array(pcm);
    this._post({ t: 'pcm', pcm: copy, sampleRate: this._sampleRateFn() || 12000 }, [copy.buffer]);
  }

  destroy() {
    if (this._worker) {
      try { this._worker.terminate(); } catch (_) {}
      this._worker = null;
    }
    this._callback = null;
    this._enabled = false;
  }
}
