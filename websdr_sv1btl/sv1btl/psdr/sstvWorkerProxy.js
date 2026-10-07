/**
 * sstvWorkerProxy.js — drop-in stand-in for KiwiSSTVDecoder that runs the real
 * decoder inside sstv.worker.js.
 *
 * It exposes exactly the methods audio.js calls (setEnabled, setCallback,
 * setMode, setGamma, setSharpen, reset, feedPCM, destroy) so nothing above it
 * knows or cares which thread the decoding happens on.
 *
 * Two behaviours worth knowing:
 *
 *   • The worker is created LAZILY, on the first enable or the first PCM chunk.
 *     Most sessions never open SSTV, and a module-scope worker would cost every
 *     one of them a thread plus a second copy of the decoder module.  Config set
 *     before creation (mode, gamma, sharpen, enabled) is remembered and replayed
 *     in the 'init' message, so call order never matters.
 *
 *   • If Worker construction fails for any reason, it silently falls back to an
 *     in-thread KiwiSSTVDecoder.  Behaviour is then identical to before this
 *     change — main-thread stalls and all — but SSTV still works.
 */

import { KiwiSSTVDecoder } from './sstv.js';

export class SSTVWorkerProxy {

  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate
      : (() => options.sampleRate || 12000);
    this._callback = typeof options.callback === 'function' ? options.callback : null;

    // Mirror of the decoder's configuration, replayed into the worker on
    // creation and re-applied if the worker is ever recreated.
    this._cfg = {
      mode:    options.defaultMode || 'auto',
      gamma:   typeof options.gamma   === 'number' ? options.gamma   : undefined,
      sharpen: typeof options.sharpen === 'number' ? options.sharpen : undefined,
      enabled: false
    };

    this._worker = null;
    this._local  = null;    // in-thread fallback, only if the worker cannot start
  }

  // ── Worker lifecycle ──────────────────────────────────────────────────────

  _ensureWorker() {
    if (this._worker || this._local) return;

    try {
      this._worker = new Worker(
        new URL('./sstv.worker.js', import.meta.url),
        { type: 'module' }
      );
    } catch (e) {
      console.warn('[SSTV] Worker unavailable, decoding in-thread:', e);
      this._startLocal();
      return;
    }

    this._worker.onmessage = ({ data }) => {
      if (typeof this._callback === 'function') this._callback(data);
    };
    this._worker.onerror = (e) => {
      console.error('[SSTV] Worker error, falling back to in-thread decoding:', e);
      try { this._worker.terminate(); } catch (_) {}
      this._worker = null;
      this._startLocal();
    };

    this._post({
      t:          'init',
      sampleRate: this._sampleRateFn() || 12000,
      mode:       this._cfg.mode,
      gamma:      this._cfg.gamma,
      sharpen:    this._cfg.sharpen,
      enabled:    this._cfg.enabled
    });
  }

  _startLocal() {
    if (this._local) return;
    this._local = new KiwiSSTVDecoder({
      sampleRate:  this._sampleRateFn,
      callback:    (event) => { if (this._callback) this._callback(event); },
      defaultMode: this._cfg.mode
    });
    if (typeof this._cfg.gamma   === 'number') this._local.setGamma(this._cfg.gamma);
    if (typeof this._cfg.sharpen === 'number') this._local.setSharpen(this._cfg.sharpen);
    this._local.setEnabled(this._cfg.enabled);
  }

  _post(msg, transfer) {
    if (!this._worker) return;
    try { this._worker.postMessage(msg, transfer || []); }
    catch (e) { console.error('[SSTV] postMessage failed:', e); }
  }

  // ── KiwiSSTVDecoder-compatible surface ────────────────────────────────────

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

  setMode(mode) {
    this._cfg.mode = mode || 'auto';
    if (this._local) { this._local.setMode(this._cfg.mode); return; }
    this._post({ t: 'mode', mode: this._cfg.mode });
  }

  setGamma(g) {
    this._cfg.gamma = g;
    if (this._local) { this._local.setGamma(g); return; }
    this._post({ t: 'gamma', value: g });
  }

  setSharpen(a) {
    this._cfg.sharpen = a;
    if (this._local) { this._local.setSharpen(a); return; }
    this._post({ t: 'sharpen', value: a });
  }

  /** Operator override -- see KiwiSSTVDecoder.forceStartNow(). */
  forceStartNow(mode) {
    const key = mode || this._cfg.mode;
    if (!key || key === 'auto') return;
    this._ensureWorker();
    if (this._local) { this._local.forceStartNow(key); return; }
    this._post({ t: 'force', mode: key });
  }

  reset(opts = {}) {
    if (opts.mode) this._cfg.mode = opts.mode;
    if (this._local) { this._local.reset({ mode: this._cfg.mode }); return; }
    this._post({ t: 'reset', mode: this._cfg.mode });
  }

  /**
   * The chunk is COPIED before being handed to the worker.  `pcm` is a view into
   * the audio pipeline's buffers, and transferring it would detach them and kill
   * playback (the same trap documented in decoder.worker.js); copying ~1–4 k
   * floats per chunk is far cheaper than the structured clone of the alternative.
   */
  feedPCM(pcm) {
    if (!pcm || pcm.length === 0) return;
    if (this._local) { this._local.feedPCM(pcm); return; }
    this._ensureWorker();
    if (this._local) { this._local.feedPCM(pcm); return; }   // fallback kicked in
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
