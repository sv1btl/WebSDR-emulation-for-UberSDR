/**
 * hfdlWorkerProxy.js — front for the HFDL decoder running in hfdl.worker.js.
 * Same idea as fskWorkerProxy.js: the worker is only created on first
 * activation, and every PCM block is copied before it is transferred.
 */

export class HFDLWorkerProxy {
  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate
      : (() => options.sampleRate || 12000);
    this._callback = typeof options.callback === 'function' ? options.callback : null;
    this._enabled = false;
    this._dialHz = 0;
    this._worker = null;
  }

  _ensureWorker() {
    if (this._worker) return;
    try {
      this._worker = new Worker(new URL('./hfdl.worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      console.error('[HFDL] Worker unavailable:', e);
      if (this._callback) this._callback({ type: 'error', message: String(e && e.message || e) });
      return;
    }
    this._worker.onmessage = ({ data }) => {
      if (typeof this._callback === 'function') this._callback(data);
    };
    this._worker.onerror = (e) => {
      console.error('[HFDL] Worker error:', e);
      if (this._callback) this._callback({ type: 'error', message: e.message || 'worker error' });
    };
    this._post({
      t: 'init',
      sampleRate: this._sampleRateFn() || 12000,
      dialHz: this._dialHz,
      enabled: this._enabled,
    });
  }

  _post(msg, transfer) {
    if (!this._worker) return;
    try { this._worker.postMessage(msg, transfer || []); }
    catch (e) { console.error('[HFDL] postMessage failed:', e); }
  }

  setEnabled(enabled) {
    this._enabled = !!enabled;
    if (this._enabled) this._ensureWorker();
    this._post({ t: 'enable', on: this._enabled });
  }

  setCallback(fn) {
    this._callback = typeof fn === 'function' ? fn : null;
  }

  /** USB dial frequency in Hz: the label the decoded frames carry. */
  setDial(hz) {
    this._dialHz = Math.round(Number(hz) || 0);
    this._post({ t: 'dial', hz: this._dialHz });
  }

  reset() {
    this._post({ t: 'reset' });
  }

  feedPCM(pcm) {
    if (!this._enabled || !pcm || pcm.length === 0) return;
    this._ensureWorker();
    const copy = new Float32Array(pcm);
    this._post({ t: 'pcm', pcm: copy, sampleRate: this._sampleRateFn() || 12000 }, [copy.buffer]);
  }

  destroy() {
    if (this._worker) {
      this._post({ t: 'destroy' });
      try { this._worker.terminate(); } catch (_) {}
      this._worker = null;
    }
    this._callback = null;
    this._enabled = false;
  }
}
