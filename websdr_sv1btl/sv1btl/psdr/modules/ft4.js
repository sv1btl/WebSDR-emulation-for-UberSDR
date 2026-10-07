/**
 * ft4.js  —  FT8 / FT4 / FT2 decode module for PhantomSDR-Plus
 * Place at: ~/PhantomSDR-Plus/frontend/src/modules/ft4.js
 *
 * FT2 note (IU8LMC ERRATA_FT2_MODULATION.md, 2026-02-27):
 *   FT2 is FT4 with doubled symbol rate.  The WASM handles FT2 internally
 *   by upsampling 2× and decoding as FT4.  From the JS side, just pass
 *   protocol=2 and a PCM window of ~2.52 s (T/R period 3.75 s).
 *
 * Audio window sizes at 12000 Hz sample rate:
 *   FT8:  ~15 s → 180000 samples  (use ~13 s TX window → 156000)
 *   FT4:  ~7.5 s →  90000 samples  (use ~5 s TX window →  60480)
 *   FT2:  ~3.75 s → 45000 samples  (use ~2.52 s TX window → 30240)
 */

const WASM_URL = new URL('../decoders/ft8_lib.wasm', import.meta.url).href;

let _instance    = null;
let _memory      = null;
let _loadPromise = null;

// ── Minimal Emscripten runtime stubs ────────────────────────────────────────
//
// NB: the module is built with STANDALONE_WASM, so it *exports* its own memory
// rather than using the one we pass in. The stubs below must therefore read and
// write through the exported memory, not `memory` — otherwise fd_write stores
// the byte count into the wrong buffer and Emscripten's stdio retries forever
// (a hard hang). `bindMemory()` is called with the real memory right after
// instantiation.
function makeImports(memory) {
    let activeMemory = memory;
    let HEAPU8  = new Uint8Array(activeMemory.buffer);
    let HEAPU32 = new Uint32Array(activeMemory.buffer);

    function refreshViews() {
        HEAPU8  = new Uint8Array(activeMemory.buffer);
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
            catch (e) { console.error('[ft4] grow failed:', e); return 0; }
        },

        fd_close() { return 0; },
        fd_seek()  { return 70; },
        fd_write(fd, iov, iovcnt, pnum) {
            let written = 0;
            for (let i = 0; i < iovcnt; i++) {
                const ptr = HEAPU32[iov >> 2];
                const len = HEAPU32[(iov >> 2) + 1];
                iov += 8;
                written += len;
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
                fd_close:  env.fd_close,
                fd_seek:   env.fd_seek,
                fd_write:  env.fd_write,
                proc_exit: env.exit,
            },
        },
        bindMemory,
    };
}

// ── Load WASM once ───────────────────────────────────────────────────────────
async function _load() {
    if (_instance) return;
    if (_loadPromise) { await _loadPromise; return; }

    _loadPromise = (async () => {
        const memory = new WebAssembly.Memory({ initial: 256, maximum: 2048 });
        const { imports, bindMemory } = makeImports(memory);

        const resp  = await fetch(WASM_URL);
        if (!resp.ok) throw new Error('[ft4] fetch ' + WASM_URL + ' → ' + resp.status);
        const bytes = await resp.arrayBuffer();

        const { instance } = await WebAssembly.instantiate(bytes, imports);

        _memory   = instance.exports.memory || memory;
        _instance = instance.exports;

        // Point the runtime stubs at the memory the module actually uses.
        bindMemory(_memory);

        // STANDALONE_WASM reactor module: run static init before any call.
        if (typeof _instance._initialize === 'function') _instance._initialize();

        console.log('[ft4] WASM ready, exports:', Object.keys(_instance)
            .filter(k => /^(ftx_|get_|malloc|free)/.test(k)));
    })();

    await _loadPromise;
}

// ── Core decode ──────────────────────────────────────────────────────────────
async function _decode(pcm, protocol, sampleRate = 12000) {
    await _load();

    const { ftx_decode: _ftx_decode, get_message_text: _get_message_text,
            get_freq: _get_freq, get_snr: _get_snr, get_dt: _get_dt,
            malloc: _malloc, free: _free } = _instance;

    if (!_ftx_decode || !_malloc) {
        console.error('[ft4] required exports missing from WASM');
        return [];
    }

    const pcmPtr = _malloc(pcm.length * 4);
    if (!pcmPtr) { console.error('[ft4] malloc failed'); return []; }

    new Float32Array(_memory.buffer, pcmPtr, pcm.length).set(pcm);

    let count = 0;
    try {
        count = _ftx_decode(pcmPtr, pcm.length, protocol, sampleRate);
    } catch (e) {
        console.error('[ft4] _ftx_decode threw:', e);
    } finally {
        _free(pcmPtr);
    }

    console.log('[ft4] protocol=' + protocol + ' count=' + count +
                ' samples=' + pcm.length + ' sr=' + sampleRate);

    if (count <= 0) return [];

    const heap8   = new Uint8Array(_memory.buffer);
    const results = [];

    for (let i = 0; i < count; i++) {
        const textPtr = _get_message_text(i);
        const freq    = _get_freq(i);
        const snr     = _get_snr(i);
        // dt = where the signal sat in the analysis window; drives auto-sync.
        const dt      = _get_dt ? _get_dt(i) : NaN;

        let end = textPtr;
        while (heap8[end] !== 0) end++;
        const text = new TextDecoder().decode(heap8.subarray(textPtr, end)).trim();
        if (text) results.push({ text, freq, snr, dt });
    }

    return results;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function decodeFT8viaLib(pcm, sampleRate = 12000) {
    return _decode(pcm, 0, sampleRate);
}

export async function decodeFT4(pcm, sampleRate = 12000) {
    return _decode(pcm, 1, sampleRate);
}

/**
 * decodeFT2 — decode one FT2 audio window (T/R = 3.75 s).
 *
 * Trigger: every 3.75 s aligned to UTC second 0 of each minute:
 *   offsets 0.0, 3.75, 7.5, 11.25, 15.0, … s within each minute.
 *
 * PCM window: capture ~2.52 s starting ~0.5 s after T/R boundary
 *   (same lead-in timing as FT4).
 *   At 12000 Hz: 2.52 × 12000 = 30240 samples.
 *
 * The WASM upsamples this 2× internally before decoding as FT4.
 */
export async function decodeFT2(pcm, sampleRate = 12000) {
    return _decode(pcm, 2, sampleRate);
}
