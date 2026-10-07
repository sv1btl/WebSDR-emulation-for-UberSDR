/**
 * fsk.worker.js — off-main-thread host for the NAVTEX / FSK engine (fsk.js)
 *
 * One worker hosts ONE KiwiFSKDecoder, whose role ('navtex' | 'fsk') is fixed by
 * the 'init' message.  audio.js creates two proxies, so NAVTEX and RTTY get a
 * worker each; they are mutually exclusive in the UI, and a worker is only
 * spawned on first enable, so at most one is ever running.
 *
 * Why it belongs off-thread: the demodulator runs a quadrature mixer, three
 * biquads and a discriminator per input sample, and the FSK role additionally
 * runs auto-shift (six Goertzel probes over 2048 samples) and auto-centre (a
 * two-pass sweep: 20 Hz steps across 300–2700 Hz, then 5 Hz steps over ±120 Hz,
 * two Goertzels per step) — all synchronous inside playAudio(), where the
 * AudioWorklet ring buffer holds 0.25 s.
 *
 * Protocol (main → worker), all messages carry `t`:
 *
 *   { t: 'init',       role, sampleRate, variant, config, enabled }
 *   { t: 'enable',     on }
 *   { t: 'variant',    variant }
 *   { t: 'config',     config }         // null clears the custom config
 *   { t: 'autoShift',  on }
 *   { t: 'autoCenter', on }
 *   { t: 'pcm',        pcm: Float32Array, sampleRate }
 *   { t: 'destroy' }
 *
 * Worker → main: the decoder's own events, forwarded verbatim.  Note that
 * auto-shift and auto-centre rewrite the engine's own custom config inside the
 * worker; they report the new values through 'status' / 'metrics' events, which
 * is what the UI displays, so nothing needs to be read back synchronously.
 *
 * NOTE: `pcm` buffers ARE transferred; the proxy copies each chunk first.
 */

import { KiwiFSKDecoder } from './fsk.js';

let sampleRate = 12000;
let decoder    = null;
let role       = 'fsk';

function ensure(cfg) {
  if (decoder) return decoder;
  decoder = new KiwiFSKDecoder({
    role,
    sampleRate: () => sampleRate,
    callback: (event) => { self.postMessage(event); },
    variant: cfg && cfg.variant,
    config:  cfg && cfg.config,
  });
  return decoder;
}

self.onmessage = ({ data }) => {
  const d = data || {};
  try {
    switch (d.t) {
      case 'init': {
        if (d.sampleRate) sampleRate = d.sampleRate;
        if (d.role) role = d.role === 'navtex' ? 'navtex' : 'fsk';
        // Apply config unconditionally: 'init' can arrive when a decoder already
        // exists (a proxy re-creating its worker), and the constructor would
        // then be skipped, silently keeping the previous variant.
        const existed = !!decoder;
        ensure(d);
        if (existed) {
          if (d.variant) decoder.setVariant(d.variant);
          decoder.setConfig(d.config || null);
        }
        decoder.setEnabled(!!d.enabled);
        break;
      }

      case 'enable':
        ensure().setEnabled(!!d.on);
        break;

      case 'variant':
        ensure().setVariant(d.variant || 'maritime');
        break;

      case 'config':
        ensure().setConfig(d.config || null);
        break;

      case 'autoShift':
        ensure().setAutoShift(!!d.on);
        break;

      case 'autoCenter':
        ensure().setAutoCenter(!!d.on);
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
    console.error(`[${role.toUpperCase()} worker]`, e);
  }
};
