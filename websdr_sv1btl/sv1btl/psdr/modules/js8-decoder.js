/**
 * js8-decoder.js — browser bridge to js8.wasm.
 *
 * Same shape as modules/ft4.js: the wasm is built STANDALONE_WASM, so the
 * Emscripten runtime imports are hand-written here and bound to the memory the
 * module exports (not the one we pass in). See ft4.js for the long version of
 * why that distinction matters — getting it wrong hangs the worker in
 * Emscripten's stdio retry loop.
 *
 * This returns raw frames. Turning them into readable messages is js8.js
 * (per frame) and js8-reassembler.js (across slots).
 */

const WASM_URL = new URL('../decoders/js8.wasm', import.meta.url).href;

let _instance = null;
let _memory = null;
let _loadPromise = null;

function makeImports(memory) {
  let activeMemory = memory;
  let HEAPU8 = new Uint8Array(activeMemory.buffer);
  let HEAPU32 = new Uint32Array(activeMemory.buffer);

  function refreshViews() {
    HEAPU8 = new Uint8Array(activeMemory.buffer);
    HEAPU32 = new Uint32Array(activeMemory.buffer);
  }

  function bindMemory(mem) {
    activeMemory = mem;
    refreshViews();
  }

  const env = {
    memory,

    emscripten_memcpy_js(dest, src, num) {
      HEAPU8.copyWithin(dest, src, src + num);
    },

    emscripten_resize_heap(requestedSize) {
      const needed = requestedSize >>> 0;
      if (needed <= activeMemory.buffer.byteLength) return 1;
      const pages = Math.ceil((needed - activeMemory.buffer.byteLength) / 65536);
      try { activeMemory.grow(pages); refreshViews(); return 1; }
      catch (e) { console.error('[js8] grow failed:', e); return 0; }
    },

    fd_close() { return 0; },
    fd_seek() { return 70; },
    fd_write(fd, iov, iovcnt, pnum) {
      let written = 0;
      for (let i = 0; i < iovcnt; i++) {
        written += HEAPU32[(iov >> 2) + 1];
        iov += 8;
      }
      HEAPU32[pnum >> 2] = written;
      return 0;
    },
    exit(code) { throw new Error('WASM exit(' + code + ')'); },
    __cxa_atexit() { return 0; },
    emscripten_notify_memory_growth() {},
  };

  return {
    imports: {
      env,
      wasi_snapshot_preview1: {
        fd_close: env.fd_close,
        fd_seek: env.fd_seek,
        fd_write: env.fd_write,
        proc_exit: env.exit,
      },
    },
    bindMemory,
  };
}

async function _load() {
  if (_instance) return;
  if (_loadPromise) { await _loadPromise; return; }

  _loadPromise = (async () => {
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 2048 });
    const { imports, bindMemory } = makeImports(memory);

    const resp = await fetch(WASM_URL);
    if (!resp.ok) throw new Error('[js8] fetch ' + WASM_URL + ' → ' + resp.status);
    const bytes = await resp.arrayBuffer();

    const { instance } = await WebAssembly.instantiate(bytes, imports);

    _memory = instance.exports.memory || memory;
    _instance = instance.exports;
    bindMemory(_memory);

    if (typeof _instance._initialize === 'function') _instance._initialize();

    console.log('[js8] WASM ready,', _instance.js8_num_submodes(), 'submodes');
  })();

  await _loadPromise;
}

/** Submode metadata straight from the wasm, so nothing is hardcoded twice. */
export async function js8Submodes() {
  await _load();
  const out = [];
  const heap = new Uint8Array(_memory.buffer);
  for (let i = 0; i < _instance.js8_num_submodes(); i++) {
    let p = _instance.js8_submode_name(i);
    let end = p;
    while (heap[end] !== 0) end++;
    out.push({
      index: i,
      name: new TextDecoder().decode(heap.subarray(p, end)),
      period: _instance.js8_submode_period(i),      // T/R cycle, seconds
      txdur: _instance.js8_submode_txdur(i),        // transmission, seconds
      baud: _instance.js8_submode_baud(i),
      startDelay: _instance.js8_submode_start_delay(i),
    });
  }
  return out;
}

/**
 * Decode one JS8 slot.
 *
 * @param {Float32Array} pcm
 * @param {number} submode 0=Normal 1=Fast 2=Turbo 3=Slow 4=Ultra
 * @param {number} sampleRate
 * @returns {Promise<Array<{payload:Uint8Array,i3bit:number,freq:number,snr:number,dt:number}>>}
 */
export async function decodeJS8(pcm, submode = 0, sampleRate = 12000) {
  await _load();

  const pcmPtr = _instance.malloc(pcm.length * 4);
  if (!pcmPtr) { console.error('[js8] malloc failed'); return []; }

  new Float32Array(_memory.buffer, pcmPtr, pcm.length).set(pcm);

  let count = 0;
  try {
    count = _instance.js8_decode(pcmPtr, pcm.length, submode, sampleRate);
  } catch (e) {
    console.error('[js8] js8_decode threw:', e);
  } finally {
    _instance.free(pcmPtr);
  }

  if (count <= 0) return [];

  const results = [];
  for (let i = 0; i < count; i++) {
    // Copy out: the heap can move under us on the next call.
    const payload = new Uint8Array(_memory.buffer, _instance.js8_get_payload(i), 10).slice();
    results.push({
      payload,
      i3bit: _instance.js8_get_i3bit(i),
      freq: _instance.js8_get_freq(i),
      snr: _instance.js8_get_snr(i),
      dt: _instance.js8_get_dt(i),
    });
  }
  return results;
}
