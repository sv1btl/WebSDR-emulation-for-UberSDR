/**
 * modeId.worker.js — off-main-thread host for the mode identifier (modeId.js).
 *
 * Why it belongs off-thread: per input sample the identifier runs a complex
 * mixer, a 24-tap anti-alias window every 12th sample and three ring-buffer
 * accumulators, plus a 4096-point FFT three times a second — all of which would
 * otherwise run synchronously inside playAudio(), where the AudioWorklet ring
 * buffer holds only 0.25 s.
 *
 * Protocol (main -> worker), all messages carry `t`:
 *
 *   { t: 'init',    sampleRate, enabled }
 *   { t: 'enable',  on }
 *   { t: 'reset' }                  discard all history (the dial moved)
 *   { t: 'pcm',     pcm: Float32Array, sampleRate }
 *   { t: 'destroy' }
 *
 * Worker -> main: the identifier's own 'result' events, forwarded verbatim.
 *
 * NOTE: `pcm` buffers ARE transferred; the proxy copies each chunk first.
 */

// SV1BTL (websdr_sv1btl): ?v= tags on the imports below so browsers fetch the updated files
// (UberSDR serves them without cache headers); otherwise unchanged from PhantomSDR-Plus.
import { ModeIdentifier } from './modeId.js?v=20261106';

let sampleRate = 12000;
let engine = null;

function ensure() {
  if (engine) return engine;
  engine = new ModeIdentifier({
    sampleRate: () => sampleRate,
    callback: (event) => { self.postMessage(event); },
  });
  return engine;
}

self.onmessage = ({ data }) => {
  const d = data || {};
  try {
    switch (d.t) {
      case 'init':
        if (d.sampleRate) sampleRate = d.sampleRate;
        ensure().setEnabled(!!d.enabled);
        break;

      case 'enable':
        ensure().setEnabled(!!d.on);
        break;

      case 'reset':
        if (engine) engine.reset();
        break;

      case 'pcm':
        if (d.sampleRate) sampleRate = d.sampleRate;
        if (d.pcm && d.pcm.length) ensure().feedPCM(d.pcm);
        break;

      case 'destroy':
        if (engine) engine.destroy();
        engine = null;
        self.close();
        break;

      default:
        break;
    }
  } catch (e) {
    console.error('[ModeID worker]', e);
  }
};
