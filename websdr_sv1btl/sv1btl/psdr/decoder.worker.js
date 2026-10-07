/**
 * decoder.worker.js — Off-main-thread decoder worker for PhantomSDR-Plus
 *
 * Runs FT8, FT4, FT2, and WSPR decoding in a dedicated Web Worker so the
 * main thread (audio playback, UI, waterfall) is never blocked.
 *
 * Protocol (postMessage both ways):
 *
 *   Main → Worker:
 *     { id, type: 'ft8',  pcm: Float32Array, sampleRate }
 *     { id, type: 'ft4',  pcm: Float32Array, sampleRate }
 *     { id, type: 'ft2',  pcm: Float32Array, sampleRate }
 *     { id, type: 'js8',  pcm: Float32Array, sampleRate, submode }
 *     { id, type: 'wspr', pcm: Float32Array, sampleRate, dialFreqHz }
 *
 * FT8/FT4/FT2 all go through the one ft8_lib build (modules/ft4.js), the same
 * way KiwiSDR drives a single ft8_lib for both protocols. The older standalone
 * modules/ft8.js decoder is no longer used: it is hardcoded to 12 kHz and
 * decodes nothing at any other sample rate.
 *
 *   Worker → Main:
 *     { id, type, results, error? }
 *
 * The `id` is echoed back so the caller can match responses to requests
 * (important if multiple decode jobs are queued).
 *
 * NOTE: Do NOT transfer the PCM ArrayBuffer when posting to this worker.
 * The buffer is a slice of the pre-allocated accumulator in audio.js; transferring
 * it would detach the accumulator and break ongoing audio collection.
 * Use structured clone (the default) instead:
 *   worker.postMessage(msg)            ✅ correct — structured clone
 *   worker.postMessage(msg, [msg.pcm.buffer])  ❌ wrong — detaches the accumulator
 */

import { decodeFT8viaLib, decodeFT4, decodeFT2 } from './modules/ft4.js';
import { decodeWSPR }                            from './modules/wspr.js';
import { decodeJS8 }                             from './modules/js8-decoder.js';

self.onmessage = async (event) => {
  const { id, type, pcm, sampleRate, dialFreqHz, submode } = event.data;

  try {
    let results;

    if (type === 'ft8') {
      results = await decodeFT8viaLib(pcm, sampleRate);

    } else if (type === 'ft4') {
      results = await decodeFT4(pcm, sampleRate);

    } else if (type === 'ft2') {
      results = await decodeFT2(pcm, sampleRate);

    } else if (type === 'js8') {
      // Returns raw frames; js8.js and js8-reassembler.js turn them into text
      // on the main thread, where the cross-slot state lives.
      results = await decodeJS8(pcm, submode, sampleRate);

    } else if (type === 'wspr') {
      results = await decodeWSPR(pcm, sampleRate, dialFreqHz);

    } else {
      throw new Error(`Unknown decoder type: ${type}`);
    }

    self.postMessage({ id, type, results });

  } catch (err) {
    self.postMessage({ id, type, results: [], error: err.message });
  }
};
