// SV1BTL (websdr_sv1btl): FLAC (and Opus) audio decoding for a PhantomSDR-Plus
// second receiver, with PhantomSDR-Plus's own DSP module (modules/phantomsdrdsp_bg.*,
// built from its Rust code with wasm-bindgen; copied unchanged). Stands in for
// its lib/wrappers.js createDecoder(), which its build tool wires up at start-up;
// here the wasm is instantiated when this module is first imported, i.e. only
// when a PhantomSDR+ receiver is chosen for diversity.
import * as bg from '../modules/phantomsdrdsp_bg.js'

const wasmUrl = new URL('../modules/phantomsdrdsp_bg.wasm', import.meta.url)
const imports = { './phantomsdrdsp_bg.js': bg }
let inst
try {
  inst = (await WebAssembly.instantiateStreaming(fetch(wasmUrl), imports)).instance
} catch (e) {
  // a server that does not send application/wasm: instantiate from the bytes
  const buf = await (await fetch(wasmUrl)).arrayBuffer()
  inst = (await WebAssembly.instantiate(buf, imports)).instance
}
bg.__wbg_set_wasm(inst.exports)
if (typeof inst.exports.__wbindgen_start === 'function') inst.exports.__wbindgen_start()

export function createDecoder (audioCodec, codecRate, inputRate, outputRate) {
  switch (audioCodec) {
    case 'flac':
      return new bg.Audio(bg.AudioCodec.Flac, codecRate, inputRate, outputRate)
    case 'opus':
      return new bg.Audio(bg.AudioCodec.Opus, codecRate, inputRate, outputRate)
  }
}
