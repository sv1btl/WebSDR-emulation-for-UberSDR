/**
 * uberSource.js — UberSDR native /ws adapter for the diversity combiner
 *
 * Implements the same contract as remoteSource.js and kiwiSource.js:
 *
 *   new UberSource(url, { onPcm, onState })
 *     onPcm(Float32Array mono, sampleRate)
 *     onState('connecting' | 'ready' | 'closed' | 'error', detail)
 *   .connect() .close() .tune(lHz, mHz, rHz, demod) .canReceive(hz)
 *
 * so diversity.js never learns what is on the other end.
 *
 * WHY THIS EXISTS ALONGSIDE kiwiSource.js
 * ---------------------------------------
 * UberSDR also speaks the KiwiSDR protocol, and that adapter works against
 * it — but only where the operator has switched it on: `enable_kiwisdr`
 * defaults to false and, when enabled, listens on its own port 8073.  This
 * native path is always present, is the protocol the server's own web UI
 * uses, and retunes over the open socket rather than reconnecting.
 *
 * PROTOCOL (from the server's own client, static/v2/src/radio/audio-connection.js)
 * -----------------------------------------------------------------------------
 *   POST /connection  {"user_session_id":"<uuid>"}   <-- REQUIRED FIRST
 *        -> {"allowed":true,"session_timeout":3600,"max_session_time":3600,...}
 *
 *   GET /ws?frequency=<hz>&mode=<preset>&bandwidthLow=<hz>&bandwidthHigh=<hz>
 *           &user_session_id=<id>&format=opus&version=3[&password=<pw>]
 *
 * The POST is not optional and is easy to miss: the socket upgrades happily
 * without it and then answers every request with
 * {"type":"error","error":"Invalid session. Please refresh the page..."}.
 * The id is minted here; the server only has to have seen it. The endpoint
 * sends permissive CORS headers, so the browser fetch works cross-origin.
 *
 *   binary frame:
 *     [timestamp u64][sampleRate u32][channels u8]
 *     [basebandPower f32][noisePower f32][opus payload...]
 *     little-endian, 21-byte header, payload is raw Opus packets
 *
 *   text frame:  JSON control messages (status / error / pong / ...)
 *   client->server: {"type":"ping"} keepalive, and
 *                   {"type":"tune", frequency, mode, bandwidthLow, bandwidthHigh}
 *
 * Version 3 is requested deliberately.  Version 4 replaces the header with a
 * different layout (their OpusV4HeaderDecoder) and swaps the lossless path
 * for a predictive codec; v3 is the last version whose framing is a fixed,
 * trivially parsed header.  On v3, basebandPower - noisePower is an SNR in
 * dB — see below for why we do not use it.
 */

// SV1BTL (websdr_sv1btl): Opus through UberSDR's opus-decoder, see lib/opusShim.js
import { loadOpusML } from './lib/opusShim.js'

const HEADER_BYTES = 21
const PROTOCOL_VERSION = 3

const KEEPALIVE_MS       = 25000
const CONNECT_TIMEOUT_MS = 12000
// A socket still CONNECTING has not reached the server yet: Firefox holds a
// new WebSocket back after earlier ones to the same host:port failed (RFC 6455
// 7.2.3), up to 60 s. Closing it at CONNECT_TIMEOUT_MS counts as another
// failure and lengthens the hold, so past ~12 s no attempt can ever get
// through and one success is what would reset it. Wait out the hold instead.
const CONNECTING_MAX_MS = 75000
const RECONNECT_BASE_MS  = 2000
const RECONNECT_MAX_MS   = 30000

// radiod preset names, as the server's own Kiwi shim maps them.
const MODE_MAP = {
  USB: 'usb', LSB: 'lsb', AM: 'am', SAM: 'sam',
  CW: 'cwu', CWU: 'cwu', CWL: 'cwl',
  FM: 'nfm', NFM: 'nfm'
}

// The Opus decoder is shared with audio.js's own Opus path — same package,
// loaded once for the page.
let _opusPromise = null
function loadOpusDecoder () {
  if (!_opusPromise) {
    _opusPromise = loadOpusML()
      .catch((e) => {
        _opusPromise = null
        throw e
      })
  }
  return _opusPromise
}

export class UberSource {
  constructor (url, { onPcm, onState, password = '' } = {}) {
    // UberSDR serves /connection and /ws from the root of its host only; a
    // path in the address is its web interface (the new one lives at /v2/,
    // and the root redirects there), so an address copied from the browser
    // would otherwise send both requests to a 404 and loop for ever.
    this.base = String(url || '').trim().replace(/^(wss?:\/\/[^/?#]+).*$/i, '$1')
    this.password = password
    this.onPcm = onPcm || (() => {})
    this.onState = onState || (() => {})

    this.socket = null
    this.state = 'idle'
    this.sampleRate = null
    this.channels = 1
    // Reported by the server on every frame.  Not fed to the combiner: it
    // measures the signal in the demodulator passband, which is a different
    // quantity from the audio-domain estimate the combiner computes for the
    // local receiver, and comparing the two would be meaningless.  Exposed
    // for display and for setting the SNR trim by eye.
    this.serverSnrDb = null

    this.decoder = null
    this._decoderReady = false
    this._sessionId = this._makeSessionId()

    this._wantOpen = false
    this._retries = 0
    this._timer = null
    this._keepalive = null
    this._connectTimer = null
    // The connect URL carries the tuning, so we cannot open the socket until
    // we know where to point it.
    this._tuning = null
    this.session = null            // last /connection reply
    this._triedSecure = false
  }

  // http(s) origin for the REST call, from the ws(s) one we were given.
  get httpBase () {
    return this.base.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:')
  }

  // Register the session id before opening the socket. Returns true when the
  // server will accept it. A network failure is treated as permission — the
  // socket will say otherwise soon enough, and refusing here would strand a
  // receiver behind a proxy that blocks the REST path but not the socket.
  async _register () {
    const body = { user_session_id: this._sessionId }
    if (this.password) body.password = this.password
    try {
      const res = await fetch(this.httpBase + '/connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      const data = await res.json()
      this.session = data
      if (data && data.allowed === false) {
        console.warn('[Diversity/UberSDR] server refused the session:',
                     data.reason || '(no reason given)')
        this._setState('error', data)
        return false
      }
      return true
    } catch (e) {
      // The normal cross-origin POST can be blocked outright by the browser
      // ("NetworkError when attempting to fetch resource"), and when it is,
      // no amount of server-side CORS helps because the request never
      // arrives.  Retry it as a `no-cors` request: that sends
      // Content-Type: text/plain, which is a "simple" request and so skips
      // the preflight entirely.  The reply is opaque — we cannot read
      // `allowed` — but we do not need to.  All that matters is the side
      // effect: the server now knows this session id.  Verified against a
      // live receiver: a text/plain POST registers, and the socket then
      // streams normally.
      const msg = String(e && e.message ? e.message : e)
      try {
        await fetch(this.httpBase + '/connection', {
          method: 'POST',
          mode: 'no-cors',
          body: JSON.stringify(body)
        })
        this.session = { opaque: true }
        console.warn('[Diversity/UberSDR] /connection blocked by the browser (' +
                     msg + '); registered via an opaque no-cors POST instead')
        return true
      } catch (e2) {
        // Still worth trying the socket — a proxy can block the REST path and
        // pass the upgrade — but say so, rather than looping silently.
        console.warn('[Diversity/UberSDR] POST ' + this.httpBase +
                     '/connection failed (' + msg + '); trying the socket anyway')
        this._setState('error', { reason: 'session registration failed: ' + msg })
        return true
      }
    }
  }

  // The server validates this as a UUID: anything else is rejected with
  // HTTP 400 from /connection and {"error":"Invalid or missing
  // user_session_id"} on the socket, which then closes — a connect/close
  // loop with nothing obviously wrong.
  //
  // crypto.randomUUID() cannot be used on its own here.  It is restricted to
  // SECURE CONTEXTS, and a receiver served over plain http on a LAN address
  // (http://192.168.x.x:8900 — the normal way this project is deployed) is
  // not one, so it is simply undefined there.  crypto.getRandomValues() has
  // no such restriction, so build the v4 UUID from it.
  _makeSessionId () {
    const b = new Uint8Array(16)
    let filled = false
    try {
      if (globalThis.crypto && crypto.getRandomValues) {
        crypto.getRandomValues(b)
        filled = true
      }
    } catch (_) {}
    if (!filled) {
      for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0
    }
    b[6] = (b[6] & 0x0f) | 0x40      // version 4
    b[8] = (b[8] & 0x3f) | 0x80      // variant 1
    const h = []
    for (let i = 0; i < 16; i++) h.push(b[i].toString(16).padStart(2, '0'))
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' +
           h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' +
           h.slice(10, 16).join('')
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  connect () {
    this._wantOpen = true
    this._ensureDecoder()
    this._open()
  }

  _ensureDecoder () {
    if (this.decoder || this._decoderLoading) return
    this._decoderLoading = true
    loadOpusDecoder()
      .then(async (OpusMLDecoder) => {
        const dec = new OpusMLDecoder({
          sampleRate: 48000,       // Opus decodes at 48k; the combiner resamples
          channels: 1,
          frameDuration: 20,
          forwardErrorCorrection: false,
          lowLatency: true
        })
        if (dec.ready && typeof dec.ready.then === 'function') await dec.ready
        this.decoder = dec
        this._decoderReady = true
      })
      .catch((e) => {
        // NOT a link error: the socket may be perfectly healthy. Reporting it
        // as one made a decoder problem indistinguishable from a refused
        // connection, which is the opposite of helpful.
        console.error('[Diversity/UberSDR] Opus decoder failed to load:', e)
        this.decoderError = String(e && e.message ? e.message : e)
      })
      .finally(() => { this._decoderLoading = false })
  }

  async _open () {
    this._teardownSocket()
    if (!this._tuning) {
      // Nothing to ask for yet; tune() will open the socket.
      this._setState('idle')
      return
    }
    this._setState('connecting')

    // Re-registered on every open, not once: the session carries a timeout
    // (an hour on the receivers seen so far) and a reconnect after that would
    // otherwise be rejected for a reason the log would not explain.
    if (!(await this._register())) {
      this._scheduleReconnect()
      return
    }
    if (!this._wantOpen) return

    const t = this._tuning
    const q = new URLSearchParams({
      frequency: String(Math.round(t.freq)),
      mode: t.mode,
      bandwidthLow: String(Math.round(t.low)),
      bandwidthHigh: String(Math.round(t.high)),
      user_session_id: this._sessionId,
      format: 'opus',
      version: String(PROTOCOL_VERSION)
    })
    if (this.password) q.set('password', this.password)

    let sock
    try {
      sock = new WebSocket(`${this.base}/ws?${q}`)
    } catch (e) {
      this._setState('error', e)
      this._scheduleReconnect()
      return
    }
    sock.binaryType = 'arraybuffer'
    this.socket = sock

    sock.onopen = () => {
      this._keepalive = setInterval(() => this._send({ type: 'ping' }), KEEPALIVE_MS)
    }
    sock.onmessage = (ev) => this._onMessage(ev)
    sock.onerror = (ev) => this._setState('error', ev)
    sock.onclose = (ev) => {
      this._setState('closed', ev)
      this._scheduleReconnect()
    }

    clearTimeout(this._connectTimer)
    const armedAt = Date.now()
    const check = () => {
      if (this.state === 'ready' || this.socket !== sock) return
      if (sock.readyState === WebSocket.CONNECTING &&
          Date.now() - armedAt < CONNECTING_MAX_MS) {
        this._connectTimer = setTimeout(check, CONNECT_TIMEOUT_MS)
        return
      }
      console.warn('[Diversity/UberSDR] no audio within timeout:', this.base)
      try { sock.close() } catch (_) {}
    }
    this._connectTimer = setTimeout(check, CONNECT_TIMEOUT_MS)
  }

  close () {
    this._wantOpen = false
    clearTimeout(this._timer)
    clearTimeout(this._connectTimer)
    this._teardownSocket()
    if (this.decoder && typeof this.decoder.free === 'function') {
      try { this.decoder.free() } catch (_) {}
    }
    this.decoder = null
    this._decoderReady = false
    this._setState('idle')
  }

  _teardownSocket () {
    clearInterval(this._keepalive)
    this._keepalive = null
    const s = this.socket
    this.socket = null
    if (!s) return
    s.onopen = s.onmessage = s.onerror = s.onclose = null
    try { s.close() } catch (_) {}
  }

  _scheduleReconnect () {
    if (!this._wantOpen || !this._tuning) return
    // Most public receivers are https-only, and a bare hostname normalises
    // to ws://, which such a server refuses with nothing legible attached.
    // Upgrade once rather than making the user work that out.
    if (!this._triedSecure && /^ws:/i.test(this.base) && this.state !== 'ready') {
      this._triedSecure = true
      this.base = this.base.replace(/^ws:/i, 'wss:')
      console.warn('[Diversity/UberSDR] ws:// failed; retrying as wss://', this.base)
      this._retries = 0
      setTimeout(() => this._open(), 250)
      return
    }
    clearTimeout(this._timer)
    const d = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, this._retries++))
    this._timer = setTimeout(() => this._open(), d)
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

  // ── messages ──────────────────────────────────────────────────────────

  _onMessage (ev) {
    if (typeof ev.data === 'string') { this._onText(ev.data); return }
    if (ev.data instanceof ArrayBuffer) this._onBinary(ev.data)
  }

  _onText (text) {
    let msg
    try { msg = JSON.parse(text) } catch (_) { return }
    if (msg.type === 'error') {
      const what = String(msg.error || msg.message || text)
      console.warn('[Diversity/UberSDR] server error:', what)
      // A session the server has forgotten cannot be revived by retrying it;
      // mint a new id so the reconnect registers cleanly.
      if (/invalid session|please refresh/i.test(what)) {
        this._sessionId = this._makeSessionId()
      }
      this._setState('error', msg)
      return
    }
    // The server falls back to JSON `audio` messages carrying base64 PCM when
    // Opus is unavailable.  Not decoded here: it is a rare fallback, and the
    // combiner is better served by no remote than by a half-supported one.
    if (msg.type === 'audio' && !this._loggedJsonAudio) {
      this._loggedJsonAudio = true
      console.warn('[Diversity/UberSDR] server sent JSON PCM audio (no Opus); ' +
                   'this adapter needs the Opus path')
    }
  }

  _onBinary (buffer) {
    if (buffer.byteLength <= HEADER_BYTES) return

    // A well-formed frame means the link is up, whatever the decoder makes
    // of it.  Waiting for a successful decode instead let the connect
    // timeout kill a perfectly good socket whenever the wasm decoder was
    // still loading — audio was arriving the whole time.
    if (this.state !== 'ready') {
      clearTimeout(this._connectTimer)
      this._retries = 0
      this.sampleRate = 48000
      this._setState('ready', { sampleRate: 48000 })
    }

    const view = new DataView(buffer)
    const sampleRate = view.getUint32(8, true)
    const channels = view.getUint8(12) || 1
    let baseband = view.getFloat32(13, true)
    let noise = view.getFloat32(17, true)
    // -999 is the server's "no channel status" sentinel.
    if (!(baseband > -998)) baseband = null
    if (!(noise > -998)) noise = null
    this.serverSnrDb = (baseband !== null && noise !== null) ? baseband - noise : null
    this.channels = channels

    if (!this._decoderReady) return          // still loading; drop, do not queue

    let result
    try {
      result = this.decoder.decodeFrame(new Uint8Array(buffer, HEADER_BYTES))
    } catch (e) {
      return
    }
    if (!result || !result.channelData || !result.channelData.length) return

    // The decoder is built mono, but fold defensively rather than trust it.
    let pcm = result.channelData[0]
    if (result.channelData.length > 1) {
      const L = result.channelData[0], R = result.channelData[1]
      const n = Math.min(L.length, R.length)
      const mono = new Float32Array(n)
      for (let i = 0; i < n; i++) mono[i] = 0.5 * (L[i] + R[i])
      pcm = mono
    }
    if (!pcm || !pcm.length) return

    // No level scaling here.  Opus decodes to +/-1 while the local pipeline
    // works at a few tenths; the combiner's noise-floor level matching is
    // what reconciles the two, and a fixed constant here would fight it.
    try {
      // The decoder was constructed for 48 kHz output regardless of the rate
      // the header reports for the encoded stream.
      this.onPcm(pcm, 48000)
    } catch (e) {
      console.error('[Diversity/UberSDR] onPcm handler threw:', e)
    }
  }

  // ── tuning ────────────────────────────────────────────────────────────

  // The server never announces its coverage on this socket.  Say yes and let
  // the correlation decide: if the receiver cannot hear it, the combiner
  // simply never locks.
  canReceive () { return true }

  /**
   * Point the receiver at a signal.  The tuning lives in the connect URL, so
   * the first call opens the socket; later calls retune over the open one,
   * which is why this protocol was worth adapting natively.
   */
  tune (lHz, mHz, rHz, demod) {
    const mode = MODE_MAP[String(demod || 'USB').toUpperCase()] || 'usb'
    const next = {
      freq: mHz,
      mode,
      low: Math.round(lHz - mHz),
      high: Math.round(rHz - mHz)
    }
    const first = !this._tuning
    this._tuning = next

    if (first) {
      if (this._wantOpen) this._open()
      return true
    }
    return this._send({
      type: 'tune',
      frequency: Math.round(next.freq),
      mode: next.mode,
      bandwidthLow: next.low,
      bandwidthHigh: next.high
    })
  }
}

export default UberSource
