/**
 * fax.worker.js — off-main-thread host for the HF FAX decoder
 *
 * Same shape as sstv.worker.js: a message pump around one KiwiFAXDecoder
 * (fax.js), which is itself unaware that it runs in a worker.
 *
 * Why FAX needs it too.  The discriminator runs per input sample — two FIR
 * convolutions (17 taps each), a hypot, an atan2 and a DC filter — and at the end
 * of every line _processLine() adds two DFTs over a quarter line (~1500 points,
 * each with a cos and a sin per point) for START/STOP tone detection, plus a
 * phasing search that sweeps the whole line.  At 120 LPM that burst lands twice a
 * second, synchronously inside playAudio(), where the AudioWorklet ring buffer
 * holds only 0.25 s.
 *
 * Protocol (main → worker), all messages carry `t`:
 *
 *   { t: 'init',      sampleRate, lpm, ioc, shift, autoAlign, enabled }
 *   { t: 'enable',    on }
 *   { t: 'params',    lpm, ioc, shift }
 *   { t: 'autoAlign', on }
 *   { t: 'reset' }
 *   { t: 'pcm',       pcm: Float32Array, sampleRate, inputSampleRate }
 *   { t: 'destroy' }
 *
 * Worker → main: the decoder's own line events, forwarded verbatim.
 *
 * NOTE: `pcm` buffers ARE transferred; the proxy (faxWorkerProxy.js) copies each
 * chunk first, so the audio pipeline's own buffers are never in the transfer list.
 */

import { KiwiFAXDecoder } from './fax.js';

let sampleRate = 12000;
let decoder    = null;

function ensure(cfg) {
  if (decoder) return decoder;
  decoder = new KiwiFAXDecoder({
    sampleRate: () => sampleRate,
    callback: (event) => { self.postMessage(event); },
    lpm:       cfg && cfg.lpm,
    ioc:       cfg && cfg.ioc,
    shift:     cfg && cfg.shift,
    autoAlign: cfg ? cfg.autoAlign : undefined,
  });
  return decoder;
}

self.onmessage = ({ data }) => {
  const d = data || {};
  try {
    switch (d.t) {
      case 'init': {
        if (d.sampleRate) sampleRate = d.sampleRate;
        // Apply the config unconditionally, not just via the constructor: 'init'
        // can arrive when a decoder already exists (a proxy re-creating its
        // worker), and silently keeping the old parameters would decode the new
        // station at the previous LPM/IOC.
        const existed = !!decoder;
        ensure(d);
        if (existed) decoder.reset();
        if (d.lpm || d.ioc || d.shift) decoder.setParams(d.lpm, d.ioc, d.shift);
        if (d.autoAlign !== undefined)  decoder.setAutoAlign(!!d.autoAlign);
        decoder.setEnabled(!!d.enabled);
        break;
      }

      case 'enable':
        ensure().setEnabled(!!d.on);
        break;

      case 'params':
        ensure().setParams(d.lpm, d.ioc, d.shift);
        break;

      case 'autoAlign':
        ensure().setAutoAlign(!!d.on);
        break;

      case 'reset':
        ensure().reset();
        break;

      case 'pcm':
        if (d.sampleRate) sampleRate = d.sampleRate;
        if (d.pcm && d.pcm.length) ensure().feedPCM(d.pcm, d.inputSampleRate || null);
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
    // A decoder throw must not kill the worker — the operator would lose FAX for
    // the rest of the session with no way back short of a reload.
    console.error('[FAX worker]', e);
  }
};
