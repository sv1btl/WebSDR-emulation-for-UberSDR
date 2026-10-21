// SV1BTL (websdr_sv1btl): Opus decoding for the diversity sources.
//
// PhantomSDR-Plus bundles @wasm-audio-decoders/opus-ml with its build tool; this
// page has no build step, but UberSDR's own websdr-sound.js already loads
// opus-decoder.min.js (the same author's plain Opus decoder) as
// window['opus-decoder']. loadOpusML() resolves to a constructor with the
// OpusMLDecoder shape the sources use: new X({ sampleRate, channels, ... }),
// .ready, .decodeFrame(Uint8Array) -> { channelData, sampleRate }, .free().

function opusLib () {
  return new Promise(function (resolve, reject) {
    var lib = window['opus-decoder']
    if (lib && lib.OpusDecoder) { resolve(lib); return }
    // not there yet (or another page): load UberSDR's copy, served at the root
    var s = document.createElement('script')
    s.src = 'opus-decoder.min.js'
    s.onload = function () {
      var l = window['opus-decoder']
      if (l && l.OpusDecoder) resolve(l)
      else reject(new Error('opus-decoder.min.js loaded but did not define OpusDecoder'))
    }
    s.onerror = function () { reject(new Error('could not load opus-decoder.min.js')) }
    document.head.appendChild(s)
  })
}

export function loadOpusML () {
  return opusLib().then(function (lib) {
    return function OpusShim (opts) {
      var o = opts || {}
      return new lib.OpusDecoder({ sampleRate: o.sampleRate || 48000, channels: o.channels || 1 })
    }
  })
}
