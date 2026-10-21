/**
 * remoteSource.js — second-receiver audio client for the diversity combiner
 *
 * Opens a /audio WebSocket to ANOTHER PhantomSDR-Plus instance and emits
 * decoded mono PCM blocks.  Deliberately minimal: no AudioContext, no DSP
 * chain, no decoders, no UI callbacks.  It is the local SpectrumAudio's
 * socket handling (audio.js socketMessageInitial/socketMessage/decode) and
 * nothing else.
 *
 * Why not just instantiate a second SpectrumAudio: that class binds one
 * socket to one AudioContext, one worklet and every digital decoder in the
 * project.  A second copy would create a second audio graph, duplicate FT8
 * accumulators and fire every UI callback twice.
 *
 * CONTRACT
 *   new RemoteSource(url, { onPcm, onState })
 *     onPcm(Float32Array mono, sampleRate)   — decoded audio
 *     onState(state, detail)                 — 'connecting' | 'ready' |
 *                                              'closed' | 'error'
 *
 * That contract is the whole point of this file: an adapter for a KiwiSDR,
 * an OpenWebRX or a classic WebSDR implements the same two callbacks and
 * diversity.js never learns what is on the other end.
 *
 * PREREQUISITE: initWrappers() must have resolved before constructing this
 * (lib/backend.js:32 already awaits it during startup) — createDecoder()
 * needs the DSP wasm module to be set.
 */

// SV1BTL (websdr_sv1btl): browser-loadable stand-ins for the bundled packages —
// FLAC via PhantomSDR-Plus's own DSP wasm (lib/dspFlac.js), a small CBOR reader
// (lib/cbor.js) and Opus through UberSDR's opus-decoder (lib/opusShim.js).
import { createDecoder } from './lib/dspFlac.js'
import { decode as cbor_decode } from './lib/cbor.js'
import { CLIENT_VERSION } from './clientVersion.js'
import { loadOpusML } from './lib/opusShim.js'
import { viaRelayIfBlocked } from './lib/mixedContent.js'

// Opus is decoded the way audio.js decodes it — with the ML decoder, not
// with createDecoder('opus'). Not every receiver honours codec_caps, so a
// server can and does send Opus after being asked for FLAC.
let _opusPromise = null
function loadOpusDecoder () {
  if (!_opusPromise) {
    _opusPromise = loadOpusML()
      .catch((e) => { _opusPromise = null; throw e })
  }
  return _opusPromise
}

// Matches the local pipeline's FLAC gain (audio.js, "FLAC 16-bit gain
// boost").  The rest of the project is calibrated for ~8-bit amplitude;
// the 16-bit FLAC decoder outputs ~1.0.  The remote stream MUST get the
// identical boost or its level — and therefore its SNR estimate — is not
// comparable with the local one, and the selector makes bad choices.
const FLAC_GAIN = 175.0

// audio.js applies this to Opus as well as FLAC, so both streams land on the
// same scale as the local one.
const OPUS_GAIN = 175.0

const CONNECT_TIMEOUT_MS = 8000
// A socket still CONNECTING has not reached the server yet: Firefox holds a
// new WebSocket back after earlier ones to the same host:port failed (RFC 6455
// 7.2.3), up to 60 s. Closing it at CONNECT_TIMEOUT_MS counts as another
// failure and lengthens the hold, so past ~12 s no attempt can ever get
// through and one success is what would reset it. Wait out the hold instead.
const CONNECTING_MAX_MS = 75000
const RECONNECT_BASE_MS  = 2000
const RECONNECT_MAX_MS   = 30000

export class RemoteSource {
  constructor (endpoint, { onPcm, onState } = {}) {
    this.endpoint = endpoint
    this.onPcm = onPcm || (() => {})
    this.onState = onState || (() => {})

    this.socket = null
    this.settings = null
    this.decoder = null
    this.codec = 'flac'
    this.channels = 1
    this.audioOutputSps = null
    this.state = 'idle'

    this._wantOpen = false
    this._retries = 0
    this._timer = null
    this._connectTimer = null
    this._pending = null       // tune() called before settings arrived
    this._triedSecure = false
    this._plainEndpoint = null // set while a wss:// upgrade is unproven
    this._withVersion = false  // set once the remote refuses a bare /audio
    this._opusReady = false
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  connect () {
    this._wantOpen = true
    this._open()
  }

  _open () {
    this._teardownSocket()
    this._setState('connecting')
    this._reconnectArmed = false

    let sock
    try {
      // A bare /audio first: servers from before July 2026 route on the whole
      // resource, so "/audio?v=2" is an unknown path to them and never
      // answers.  ?v= is added only once a station with min_client_version
      // set has said so — see _onClose.
      const url = !this._withVersion || /[?&]v=/.test(this.endpoint)
        ? this.endpoint
        : this.endpoint + (this.endpoint.includes('?') ? '&' : '?') + 'v=' + CLIENT_VERSION
      sock = new WebSocket(viaRelayIfBlocked(url))
    } catch (e) {
      this._setState('error', e)
      this._scheduleReconnect()
      return
    }
    sock.binaryType = 'arraybuffer'
    this.socket = sock

    sock.onopen = () => {
      // Ask for FLAC by declining Opus.  Not for the delay estimator —
      // the envelope survives a perceptual codec perfectly well — but for
      // the SNR comparison: Opus reshapes the noise floor with noise fill
      // and VBR gating, which biases this stream against the local one.
      this._send({ cmd: 'codec_caps', opus: false })
    }
    sock.onmessage = (ev) => this._onInitial(ev)
    sock.onerror = (ev) => this._failed('error', ev)
    sock.onclose = (ev) => this._onClose(ev)

    clearTimeout(this._connectTimer)
    const armedAt = Date.now()
    const check = () => {
      if (this.state === 'ready' || this.socket !== sock) return
      if (sock.readyState === WebSocket.CONNECTING &&
          Date.now() - armedAt < CONNECTING_MAX_MS) {
        this._connectTimer = setTimeout(check, CONNECT_TIMEOUT_MS)
        return
      }
      console.warn('[Diversity] remote handshake timed out:', this.endpoint)
      try { sock.close() } catch (_) {}
    }
    this._connectTimer = setTimeout(check, CONNECT_TIMEOUT_MS)
  }

  close () {
    this._wantOpen = false
    clearTimeout(this._timer)
    clearTimeout(this._connectTimer)
    this._teardownSocket()
    this._freeDecoder()
    this._setState('idle')
  }

  _teardownSocket () {
    const s = this.socket
    this.socket = null
    if (!s) return
    s.onopen = s.onmessage = s.onerror = s.onclose = null
    try { s.close() } catch (_) {}
  }

  // The version gate closes with 4003 and "out of date" in the reason; the
  // per-IP limit uses the same code with a different reason and must still
  // go through the ordinary backoff.  Retried once, on the same scheme —
  // this is not the HTTPS case, so it must not burn the wss:// upgrade.
  // A station behind an older proxy.py gets the code but the reason
  // replaced by "upstream closed" (9a7aof, Oct 2026), so that reason counts
  // too: a per-IP refusal costs one extra attempt, then backs off as usual.
  _onClose (ev) {
    if (!this._withVersion && this._wantOpen && this.state !== 'ready' &&
        ev && ev.code === 4003 &&
        /out of date|upstream closed/i.test(ev.reason || '')) {
      this._withVersion = true
      console.warn('[Diversity] remote wants a client version; retrying with ?v=' + CLIENT_VERSION)
      this._teardownSocket()
      clearTimeout(this._connectTimer)
      clearTimeout(this._timer)
      this._timer = setTimeout(() => this._open(), 250)
      return
    }
    this._failed('closed', ev)
  }

  // Both failure events land here. A handshake that dies can report either
  // one, or both, or only the timeout below — recovery must not depend on
  // which.
  _failed (kind, ev) {
    this._setState(kind, ev)
    if (this._reconnectArmed) return
    this._reconnectArmed = true
    this._scheduleReconnect()
  }

  _scheduleReconnect () {
    if (!this._wantOpen) return
    // A receiver behind HTTPS answers ws:// with a 301 to https, which the
    // browser surfaces as a bare 1006 with nothing to explain it. Upgrade
    // once rather than making the user work that out from a close code.
    if (!this._triedSecure && /^ws:/i.test(this.endpoint) && this.state !== 'ready') {
      this._triedSecure = true
      this._plainEndpoint = this.endpoint
      this.endpoint = this.endpoint.replace(/^ws:/i, 'wss:')
      console.warn('[Diversity] ws:// refused; retrying as wss://', this.endpoint)
      this._retries = 0
      setTimeout(() => this._open(), 250)
      return
    }
    // The upgrade was a guess.  If wss:// never came up either, the station
    // is plain http after all and the first failure was something else (an
    // older proxy hiding the version gate's reason did exactly this), so go
    // back to ws:// rather than retrying a scheme that cannot work forever.
    if (this._plainEndpoint) {
      console.warn('[Diversity] wss:// failed too; back to', this._plainEndpoint)
      this.endpoint = this._plainEndpoint
      this._plainEndpoint = null
    }
    clearTimeout(this._timer)
    const delay = Math.min(
      RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, this._retries++)
    )
    this._timer = setTimeout(() => this._open(), delay)
  }

  _setState (state, detail) {
    this.state = state
    try { this.onState(state, detail) } catch (_) {}
  }

  _send (obj) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    try {
      this.socket.send(JSON.stringify(obj))
      return true
    } catch (_) {
      return false
    }
  }

  // ── handshake ─────────────────────────────────────────────────────────

  _onInitial (event) {
    // The server's first frame on /audio is the JSON settings block.  A
    // binary frame arriving first is undecodable anyway — skip it and keep
    // waiting rather than tearing the socket down.
    if (typeof event.data !== 'string') return

    let settings
    try {
      settings = JSON.parse(event.data)
    } catch (e) {
      console.error('[Diversity] remote sent non-JSON settings:', e)
      try { this.socket.close() } catch (_) {}
      return
    }

    this.settings = settings

    // Same derivation as audio.js socketMessageInitial — the decoder has
    // to be built with the remote's own rates, which differ from ours.
    const targetFFTBins = Math.ceil(
      settings.audio_max_sps * settings.fft_result_size / settings.sps / 4
    ) * 4
    this.trueAudioSps = targetFFTBins / settings.fft_result_size * settings.sps
    this.audioOutputSps = Math.min(settings.audio_max_sps, 96000)
    this.audioMaxSps = settings.audio_max_sps

    this._buildDecoder(settings.audio_compression || 'flac')

    this.socket.onmessage = (ev) => this._onAudio(ev)
    this._plainEndpoint = null  // the wss:// upgrade, if any, was right
    clearTimeout(this._connectTimer)
    this._retries = 0
    this._setState('ready', {
      sampleRate: this.audioOutputSps,
      basefreq: settings.basefreq,
      bandwidth: settings.total_bandwidth
    })

    if (this._pending) {
      const p = this._pending
      this._pending = null
      this.tune(p.lHz, p.mHz, p.rHz, p.demodulation)
    }
  }

  _buildDecoder (codec) {
    this._freeDecoder()
    this.codec = codec
    this._opusReady = false

    if (codec === 'opus') {
      // Loaded asynchronously; packets arriving meanwhile are dropped rather
      // than queued, since stale audio is worse than none.
      loadOpusDecoder()
        .then(async (OpusMLDecoder) => {
          const d = new OpusMLDecoder({
            sampleRate: 48000, channels: 1, frameDuration: 20,
            forwardErrorCorrection: false, lowLatency: true
          })
          if (d.ready && typeof d.ready.then === 'function') await d.ready
          if (this.codec !== 'opus') { try { d.free() } catch (_) {} ; return }
          this.decoder = d
          this._opusReady = true
        })
        .catch((e) => console.error('[Diversity] Opus decoder failed to load:', e))
      return
    }

    this.decoder = createDecoder(
      codec, this.audioMaxSps, this.trueAudioSps, this.audioOutputSps
    )
  }

  _freeDecoder () {
    if (this.decoder && typeof this.decoder.free === 'function') {
      try { this.decoder.free() } catch (_) {}
    }
    this.decoder = null
  }

  // ── audio ─────────────────────────────────────────────────────────────

  _onAudio (event) {
    if (!(event.data instanceof ArrayBuffer) || !this.decoder) return

    let packet
    try {
      packet = cbor_decode(new Uint8Array(event.data))
    } catch (e) {
      return
    }

    this.channels = packet.channels || 1
    if (packet.codec && packet.codec !== this.codec) {
      // Should not happen — we declined Opus — but an older server may
      // switch anyway, and decoding new frames with the old decoder is
      // pure noise.  Rebuild before touching this packet.
      this._buildDecoder(packet.codec)
    }

    let pcm
    if (this.codec === 'opus') {
      if (!this._opusReady) return
      let res
      try {
        res = this.decoder.decodeFrame(new Uint8Array(packet.data))
      } catch (e) {
        return
      }
      if (!res || !res.channelData || !res.channelData.length) return
      const src = res.channelData[0]
      pcm = new Float32Array(src.length)
      for (let i = 0; i < src.length; i++) pcm[i] = src[i] * OPUS_GAIN
    } else {
      try {
        pcm = this.decoder.decode(packet.data)
      } catch (e) {
        return
      }
    }
    if (!pcm || pcm.length === 0) return

    // A stereo remote (C-QUAM) is not useful to a mono combiner; fold it
    // down rather than dropping the stream entirely.
    if (pcm.channelData && this.channels === 2) {
      const L = pcm.channelData[0] || new Float32Array(0)
      const R = pcm.channelData[1] || new Float32Array(0)
      const n = Math.min(L.length, R.length)
      const mono = new Float32Array(n)
      for (let i = 0; i < n; i++) mono[i] = 0.5 * (L[i] + R[i])
      pcm = mono
    } else if (this.channels === 2) {
      const n = pcm.length >> 1
      const mono = new Float32Array(n)
      for (let i = 0; i < n; i++) mono[i] = 0.5 * (pcm[i * 2] + pcm[i * 2 + 1])
      pcm = mono
    }

    if (this.codec === 'flac') {
      const boosted = new Float32Array(pcm.length)
      for (let i = 0; i < pcm.length; i++) boosted[i] = pcm[i] * FLAC_GAIN
      pcm = boosted
    }

    try {
      this.onPcm(pcm, this.codec === 'opus' ? 48000 : this.audioOutputSps)
    } catch (e) {
      console.error('[Diversity] onPcm handler threw:', e)
    }
  }

  // ── tuning ────────────────────────────────────────────────────────────

  /** Remote's own frequency → FFT bin mapping; its basefreq is not ours. */
  frequencyToFFTOffset (frequency) {
    const s = this.settings
    if (!s) return 0
    return (frequency - s.basefreq) / s.total_bandwidth * s.fft_result_size
  }

  /** True when the remote's coverage actually includes this frequency. */
  canReceive (freqHz) {
    const s = this.settings
    if (!s) return false
    return freqHz >= s.basefreq && freqHz <= s.basefreq + s.total_bandwidth
  }

  /**
   * Point the remote at the same signal as the local receiver.
   * Takes absolute edge/centre frequencies in Hz, exactly like the local
   * setAudioRange() call site in App.svelte.
   */
  tune (lHz, mHz, rHz, demodulation) {
    if (!this.settings) {
      this._pending = { lHz, mHz, rHz, demodulation }
      return false
    }
    if (!this.canReceive(mHz)) return false

    // CW/CW-L are client-side treatments of USB/LSB on this backend
    // (audio.js setAudioDemodulation), so the wire value must be USB/LSB.
    let demod = String(demodulation || 'USB').toUpperCase()
    if (demod === 'CW') demod = 'USB'
    else if (demod === 'CWL' || demod === 'CW-L') demod = 'LSB'

    this._send({ cmd: 'demodulation', demodulation: demod })
    this._send({
      cmd: 'window',
      l: Math.floor(this.frequencyToFFTOffset(lHz)),
      m: this.frequencyToFFTOffset(mHz),
      r: Math.ceil(this.frequencyToFFTOffset(rHz))
    })
    return true
  }
}

export default RemoteSource
