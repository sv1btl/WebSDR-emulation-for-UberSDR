/**
 * hfdl.worker.js — HFDL (HF Data Link) decoder off the main thread.
 *
 * The engine is dumphfdl (Tomasz Lemiech, GPL-3.0-or-later) with libacars,
 * compiled to WebAssembly (see jsdsp/hfdl_wasm; ported from PhantomSDR-ORSAT).
 * It gets the USB audio as the server demodulates it, taken before the
 * listening aids (NR/NB/NS/AN) like the other decoders, and looks for the
 * HFDL subcarrier at 1440 Hz.
 *
 * Main → worker (champ `t`) :
 *   { t: 'init',   sampleRate, dialHz, enabled }
 *   { t: 'enable', on }
 *   { t: 'dial',   hz }          USB dial frequency (HFDL kHz × 1000)
 *   { t: 'pcm',    pcm: Float32Array, sampleRate }   (buffer transferred)
 *   { t: 'reset' }
 *   { t: 'destroy' }
 *
 * Worker → main (champ `type`) :
 *   { type: 'ready', systable }      engine loaded (systable: station names)
 *   { type: 'msg', msg, text }       one decoded frame (msg = dumphfdl JSON)
 *   { type: 'stats', noiseDb, state, frames, locked, ratePpm, freqOffset }   about once a second
 *   { type: 'error', message }
 */

import createHfdlModule from './modules/hfdl.mjs';

const WASM_URL = new URL('./decoders/hfdl.wasm', import.meta.url).href;
const SYSTABLE_URL = new URL('./decoders/hfdl_systable.conf', import.meta.url).href;
const CHUNK = 4096;

let M = null;
let loading = null;
let enabled = false;
let sampleRate = 12000;
let dialHz = 0;
let lastStats = 0;

async function load() {
  if (M) return M;
  if (loading) return loading;
  loading = (async () => {
    const [wasm, systable] = await Promise.all([
      fetch(WASM_URL).then((r) => {
        if (!r.ok) throw new Error(`${WASM_URL} : HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
      fetch(SYSTABLE_URL)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null),
    ]);
    const mod = await createHfdlModule({
      wasmBinary: new Uint8Array(wasm),
      print: () => {},
      printErr: () => {},
    });
    mod._hfdl_init(sampleRate, dialHz);
    let systableOk = false;
    if (systable) {
      const bytes = new Uint8Array(systable);
      const p = mod._malloc(bytes.length);
      mod.HEAPU8.set(bytes, p);
      systableOk = mod._hfdl_load_systable(p, bytes.length) === 1;
      mod._free(p);
    }
    M = mod;
    self.postMessage({ type: 'ready', systable: systableOk });
    return M;
  })().catch((e) => {
    loading = null;
    self.postMessage({ type: 'error', message: String((e && e.message) || e) });
    throw e;
  });
  return loading;
}

function drainOutput() {
  const len = M._hfdl_output_len();
  if (len <= 0) return;
  const text = M.UTF8ToString(M._hfdl_output_ptr(), len);
  M._hfdl_output_clear();
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      self.postMessage({ type: 'msg', msg: o.json, text: o.text });
    } catch (e) {
      // One unreadable line must not block the ones after it.
    }
  }
}

function process(pcm) {
  for (let i = 0; i < pcm.length; i += CHUNK) {
    const n = Math.min(CHUNK, pcm.length - i);
    const ptr = M._hfdl_input_ptr(n);
    // HEAPF32 is re-read every time: memory growth replaces the view.
    M.HEAPF32.set(pcm.subarray(i, i + n), ptr >> 2);
    M._hfdl_process(n);
  }
  drainOutput();
  const now = Date.now();
  if (now - lastStats > 1000) {
    lastStats = now;
    self.postMessage({
      type: 'stats',
      noiseDb: M._hfdl_noise_floor_db(),
      state: M._hfdl_state(),
      frames: M._hfdl_frames(),
      locked: M._hfdl_locked() === 1,
      ratePpm: M._hfdl_rate_ppm(),
      freqOffset: M._hfdl_freq_offset ? M._hfdl_freq_offset() : 0,
    });
  }
}

self.onmessage = async ({ data }) => {
  const d = data || {};
  try {
    switch (d.t) {
      case 'init':
        if (d.sampleRate) sampleRate = d.sampleRate;
        if (typeof d.dialHz === 'number') dialHz = Math.round(d.dialHz);
        enabled = !!d.enabled;
        if (enabled) await load();
        break;
      case 'enable':
        enabled = !!d.on;
        if (enabled) {
          await load();
          M._hfdl_reset();
        }
        break;
      case 'dial':
        dialHz = Math.round(d.hz || 0);
        if (M) M._hfdl_set_dial(dialHz);
        break;
      case 'reset':
        if (M) M._hfdl_reset();
        break;
      case 'pcm': {
        if (!enabled) break;
        if (!M) { await load(); }
        // Only a real change re-creates the demodulators: they search a ±1 %
        // window around this rate themselves.
        if (d.sampleRate && Math.abs(d.sampleRate - sampleRate) > 1) {
          sampleRate = d.sampleRate;
          M._hfdl_init(sampleRate, dialHz);
        }
        if (d.pcm && d.pcm.length) process(d.pcm);
        break;
      }
      case 'destroy':
        enabled = false;
        self.close();
        break;
    }
  } catch (e) {
    self.postMessage({ type: 'error', message: String((e && e.message) || e) });
  }
};
