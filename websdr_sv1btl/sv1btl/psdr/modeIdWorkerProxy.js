/**
 * modeIdWorkerProxy.js — stand-in for ModeIdentifier that runs the real engine
 * inside modeId.worker.js.  Mirrors fskWorkerProxy.js; see that file for the
 * rationale behind lazy creation, the in-thread fallback and the PCM copy.
 */

// SV1BTL (websdr_sv1btl): ?v= tags on the imports below so browsers fetch the updated files
// (UberSDR serves them without cache headers); otherwise unchanged from PhantomSDR-Plus.
import { ModeIdentifier } from './modeId.js?v=20261106';

export class ModeIdWorkerProxy {

  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate
      : (() => options.sampleRate || 12000);
    this._callback = typeof options.callback === 'function' ? options.callback : null;
    this._enabled = false;
    this._worker = null;
    this._local = null;
  }

  _ensureWorker() {
    if (this._worker || this._local) return;
    try {
      this._worker = new Worker(
        new URL('./modeId.worker.js?v=20261106', import.meta.url),
        { type: 'module' }
      );
    } catch (e) {
      console.warn('[ModeID] Worker unavailable, identifying in-thread:', e);
      this._startLocal();
      return;
    }
    this._worker.onmessage = ({ data }) => {
      if (typeof this._callback === 'function') this._callback(data);
    };
    this._worker.onerror = (e) => {
      console.error('[ModeID] Worker error, falling back to in-thread:', e);
      try { this._worker.terminate(); } catch (_) {}
      this._worker = null;
      this._startLocal();
    };
    this._post({ t: 'init', sampleRate: this._sampleRateFn() || 12000, enabled: this._enabled });
  }

  _startLocal() {
    if (this._local) return;
    this._local = new ModeIdentifier({
      sampleRate: this._sampleRateFn,
      callback: (event) => { if (this._callback) this._callback(event); },
    });
    this._local.setEnabled(this._enabled);
  }

  _post(msg, transfer) {
    if (!this._worker) return;
    try { this._worker.postMessage(msg, transfer || []); }
    catch (e) { console.error('[ModeID] postMessage failed:', e); }
  }

  setEnabled(enabled) {
    this._enabled = !!enabled;
    if (enabled) this._ensureWorker();
    if (this._local) { this._local.setEnabled(this._enabled); return; }
    this._post({ t: 'enable', on: this._enabled });
  }

  /** Discard all measurements — call after retuning. */
  reset() {
    if (this._local) { this._local.reset(); return; }
    this._post({ t: 'reset' });
  }

  setCallback(fn) {
    this._callback = typeof fn === 'function' ? fn : null;
    if (this._local) this._local.setCallback(this._callback);
  }

  /** The chunk is COPIED before posting — see fskWorkerProxy.feedPCM. */
  feedPCM(pcm) {
    if (!this._enabled || !pcm || pcm.length === 0) return;
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
    this._enabled = false;
  }
}
