/**
 * sstv.worker.js — off-main-thread host for the SSTV decoder
 *
 * The decoder itself (sstv.js / KiwiSSTVDecoder) is unchanged and unaware of the
 * worker: this file is only a message pump around one instance of it.
 *
 * Why it exists.  The decoder is the heaviest thing in the browser client:
 * feedPCM() resamples 12 kHz → 48 kHz, the detectors run Goertzel scans over the
 * whole buffer, and _decodeLine() runs a zero-filled 1024-point FFT per pixel per
 * channel — 960 FFTs per line, measured at ~20 ms per line on a fast desktop and
 * several times that on a modest client.  All of that used to run synchronously
 * inside playAudio() on the main thread, where the AudioWorklet ring buffer holds
 * only 0.25 s (see maxBufferedSeconds in audio.js): any stall longer than the
 * currently buffered audio underruns, and after an underrun the worklet re-gates
 * on minStartFrames, so one stall costs silence plus a re-prebuffer.
 *
 * Protocol (main → worker), all messages carry `t`:
 *
 *   { t: 'init',    sampleRate, mode, gamma?, sharpen?, enabled }
 *   { t: 'enable',  on }
 *   { t: 'mode',    mode }          // forced mode, or 'auto'
 *   { t: 'reset',   mode }
 *   { t: 'force',   mode }          // operator override: draw now, no detection
 *   { t: 'gamma',   value }
 *   { t: 'sharpen', value }
 *   { t: 'pcm',     pcm: Float32Array, sampleRate }
 *   { t: 'destroy' }
 *
 * Worker → main: the decoder's own event objects, forwarded verbatim
 * ({ type: 'line' | 'mode' | 'status', … }), so the UI callback in App.svelte is
 * identical whether the decoder runs here or in-thread.
 *
 * NOTE: `pcm` buffers ARE transferred, unlike decoder.worker.js.  That is safe
 * only because the proxy (sstvWorkerProxy.js) copies each chunk into a fresh
 * Float32Array before posting — never post a view into the audio accumulators.
 */

import { KiwiSSTVDecoder } from './sstv.js';

let sampleRate = 12000;
let decoder    = null;

function ensure(mode) {
  if (decoder) return decoder;
  decoder = new KiwiSSTVDecoder({
    sampleRate: () => sampleRate,
    // Events are structured-cloned rather than transferred: a decoded row is
    // only ~1.3 kB and arrives at most a few times a second, so the copy is
    // irrelevant, while transferring would detach the array if any future decode
    // path ever emitted the same buffer twice.
    callback: (event) => { self.postMessage(event); },
    defaultMode: mode || 'auto'
  });
  return decoder;
}

self.onmessage = ({ data }) => {
  const d = data || {};
  try {
    switch (d.t) {
      case 'init':
        if (d.sampleRate) sampleRate = d.sampleRate;
        // setMode() unconditionally, not just via the constructor: 'init' can
        // arrive when a decoder already exists (a proxy re-creating its worker),
        // and ensure() would then keep the previous forced mode.
        ensure(d.mode);
        decoder.setMode(d.mode || 'auto');
        if (typeof d.gamma   === 'number') decoder.setGamma(d.gamma);
        if (typeof d.sharpen === 'number') decoder.setSharpen(d.sharpen);
        decoder.setEnabled(!!d.enabled);
        break;

      case 'enable':
        ensure().setEnabled(!!d.on);
        break;

      case 'mode':
        ensure().setMode(d.mode || 'auto');
        break;

      case 'reset':
        ensure().reset({ mode: d.mode || 'auto' });
        break;

      case 'force':
        ensure().forceStartNow(d.mode);
        break;

      case 'gamma':
        ensure().setGamma(d.value);
        break;

      case 'sharpen':
        ensure().setSharpen(d.value);
        break;

      case 'pcm':
        if (d.sampleRate) sampleRate = d.sampleRate;
        if (d.pcm && d.pcm.length) ensure().feedPCM(d.pcm);
        break;

      case 'destroy':
        if (decoder) decoder.destroy();
        decoder = null;
        self.close();
        break;

      default:
        break;
    }
  } catch (e) {
    // Never let a decoder throw kill the worker — the operator would lose SSTV
    // for the rest of the session with no way back short of a reload.
    self.postMessage({ type: 'status', text: `SSTV worker error: ${e && e.message}` });
    console.error('[SSTV worker]', e);
  }
};
