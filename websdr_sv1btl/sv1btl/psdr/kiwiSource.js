/**
 * kiwiSource.js — KiwiSDR second-receiver adapter for the diversity combiner
 *
 * Implements the same contract as remoteSource.js:
 *
 *   new KiwiSource(url, { onPcm, onState })
 *     onPcm(Float32Array mono, sampleRate)
 *     onState('connecting' | 'ready' | 'closed' | 'error', detail)
 *   .connect() .close() .tune(lHz, mHz, rHz, demod) .canReceive(hz)
 *
 * so diversity.js never learns what is on the other end.
 *
 * PROTOCOL
 * --------
 * Frames are binary and tagged by their first three bytes:
 *
 *   "MSG " + ASCII "key=value key=value ..."   — parameters
 *   "SND"  + flags(1) + seq(4, LE) + smeter(2, BE)
 *          + [10-byte GPS timestamp, only when the stereo flag is set]
 *          + int16 PCM
 *
 * PCM is BIG-endian unless bit 0x80 of the flags byte is set.  All of this
 * is taken from src/kiwi_bridge.h in this repo, which emits exactly these
 * frames and was validated byte by byte against a real KiwiSDR and against
 * a third-party client (AetherSDR) — see the comments there.
 *
 * Two things a real Kiwi needs that the bridge does not:
 *   - "SET compression=0", or audio arrives as IMA ADPCM, which this
 *     adapter does not decode.
 *   - a periodic keepalive, or the server drops the session.
 *
 * LEVELS: samples are normalised to +/-1 here.  Matching them to the local
 * receiver's very different working level is the combiner's job (see
 * levelGain in diversity.js) — a fixed constant could not cover both a
 * PhantomSDR peer and a Kiwi.
 */

import { viaRelayIfBlocked } from './lib/mixedContent.js'

const KEEPALIVE_MS       = 5000
const CONNECT_TIMEOUT_MS = 10000
// A socket still CONNECTING has not reached the server yet: Firefox holds a
// new WebSocket back after earlier ones to the same host:port failed (RFC 6455
// 7.2.3), up to 60 s. Closing it at CONNECT_TIMEOUT_MS counts as another
// failure and lengthens the hold, so past ~12 s no attempt can ever get
// through and one success is what would reset it. Wait out the hold instead.
const CONNECTING_MAX_MS = 75000
const RECONNECT_BASE_MS  = 2000
const RECONNECT_MAX_MS   = 30000

const MODE_MAP = {
  USB: 'usb', LSB: 'lsb', AM: 'am', SAM: 'sam',
  FM: 'nbfm', NFM: 'nbfm', CW: 'cw', CWU: 'cw', CWL: 'cwn'
}

export class KiwiSource {
  /**
   * @param {string} url  ws://host:8073 — the /kiwi/<ts>/SND path is added
   *   here, since it carries a timestamp that must be fresh per connection.
   */
  constructor (url, { onPcm, onState, password = '' } = {}) {
    this.base = String(url || '').replace(/\/+$/, '')
    this.password = password
    this.onPcm = onPcm || (() => {})
    this.onState = onState || (() => {})

    this.socket = null
    this.state = 'idle'
    this.sampleRate = null
    this.centerFreq = null
    this.bandwidth = null
    this.params = {}

    this._wantOpen = false
    this._retries = 0
    this._timer = null
    this._keepalive = null
    this._connectTimer = null
    this._pending = null
    this._authSent = false
    this._triedSecure = false
  }

  connect () {
    this._wantOpen = true
    this._open()
  }

  _open () {
    this._teardownSocket()
    this._setState('connecting')
    this._reconnectArmed = false

    // A real Kiwi wants a fresh timestamp in the path on every connection.
    const url = `${this.base}/kiwi/${Date.now()}/SND`
    let sock
    try {
      sock = new WebSocket(viaRelayIfBlocked(url))
    } catch (e) {
      this._setState('error', e)
      this._scheduleReconnect()
      return
    }
    sock.binaryType = 'arraybuffer'
    this.socket = sock

    sock.onopen = () => {
      this._authSent = true
      // Order matters: auth first, then rates, then codec.  A Kiwi ignores
      // everything before it has accepted the auth line.
      this._send(`SET auth t=kiwi p=${this.password}`)
      this._send('SET AR OK in=12000 out=48000')
      this._send('SET compression=0')
      this._send('SET squelch=0 max=0')
      this._send('SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50')
      this._keepalive = setInterval(() => this._send('SET keepalive'), KEEPALIVE_MS)
    }
    sock.onmessage = (ev) => this._onFrame(ev)
    sock.onerror = (ev) => this._failed('error', ev)
    sock.onclose = (ev) => this._failed('closed', ev)

    clearTimeout(this._connectTimer)
    const armedAt = Date.now()
    const check = () => {
      if (this.state === 'ready' || this.socket !== sock) return
      if (sock.readyState === WebSocket.CONNECTING &&
          Date.now() - armedAt < CONNECTING_MAX_MS) {
        this._connectTimer = setTimeout(check, CONNECT_TIMEOUT_MS)
        return
      }
      console.warn('[Diversity/Kiwi] no audio parameters within timeout:', url)
      try { sock.close() } catch (_) {}
    }
    this._connectTimer = setTimeout(check, CONNECT_TIMEOUT_MS)
  }

  close () {
    this._wantOpen = false
    clearTimeout(this._timer)
    clearTimeout(this._connectTimer)
    this._teardownSocket()
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
    // Same trap as the other sources: a receiver behind HTTPS answers ws://
    // with a redirect the browser reports only as a bare 1006.
    if (!this._triedSecure && /^ws:/i.test(this.base) && this.state !== 'ready') {
      this._triedSecure = true
      this.base = this.base.replace(/^ws:/i, 'wss:')
      console.warn('[Diversity/Kiwi] ws:// refused; retrying as wss://', this.base)
      this._retries = 0
      setTimeout(() => this._open(), 250)
      return
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

  _send (text) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    try {
      this.socket.send(text)
      return true
    } catch (_) {
      return false
    }
  }

  // ── frames ────────────────────────────────────────────────────────────

  _onFrame (ev) {
    // A Kiwi sends everything as binary, including its text parameters.
    let buf
    if (ev.data instanceof ArrayBuffer) buf = new Uint8Array(ev.data)
    else if (typeof ev.data === 'string') { this._onText(ev.data); return }
    else return
    if (buf.length < 3) return

    const tag = String.fromCharCode(buf[0], buf[1], buf[2])
    if (tag === 'MSG') {
      this._onText(new TextDecoder('latin1').decode(buf.subarray(3)))
    } else if (tag === 'SND') {
      this._onSnd(buf)
    }
    // W/F, EXT and the rest are not our business.
  }

  _onText (text) {
    const body = text.replace(/^MSG\s*/, '').trim()
    let changed = false
    for (const kv of body.split(/\s+/)) {
      const i = kv.indexOf('=')
      if (i <= 0) continue
      const k = kv.slice(0, i)
      const v = kv.slice(i + 1)
      this.params[k] = v
      if (k === 'audio_rate' || k === 'sample_rate' ||
          k === 'center_freq' || k === 'bandwidth') changed = true
    }
    if (!changed) return

    // audio_rate is the integer rate the PCM actually carries; sample_rate
    // is the same number with the Kiwi's measured clock drift on it.  We
    // resample by ratio downstream, so either is fine — prefer the precise
    // one when it is present.
    const sr = Number(this.params.sample_rate) || Number(this.params.audio_rate)
    if (sr > 0) this.sampleRate = sr
    if (this.params.center_freq) this.centerFreq = Number(this.params.center_freq)
    if (this.params.bandwidth) this.bandwidth = Number(this.params.bandwidth)

    if (this.sampleRate && this.state !== 'ready') {
      clearTimeout(this._connectTimer)
      this._retries = 0
      this._setState('ready', {
        sampleRate: this.sampleRate,
        centerFreq: this.centerFreq,
        bandwidth: this.bandwidth
      })
      if (this._pending) {
        const p = this._pending
        this._pending = null
        this.tune(p.lHz, p.mHz, p.rHz, p.demod)
      }
    }
  }

  _onSnd (buf) {
    // 'S','N','D', flags, seq(4 LE), smeter(2 BE), then int16 PCM — except
    // that a stereo packet carries a 10-byte GPS timestamp first, putting
    // the audio at byte 20 rather than byte 10.  Getting this wrong is
    // silent: the timestamp simply decodes as a burst of noise at the head
    // of every packet.  Applies to any Kiwi in a stereo mode (SAS and the
    // IQ modes), not just to UberSDR, where this was found.
    if (buf.length <= 10) return
    const flags = buf[3]
    const little = (flags & 0x80) !== 0
    const stereo = (flags & 0x08) !== 0
    this.smeter = (buf[8] << 8) | buf[9]

    // 0x10 marks an IMA ADPCM payload, which this adapter cannot decode.
    // We ask for compression=0 at connect, so seeing it means the server
    // ignored that — say so once rather than emitting noise for hours.
    if ((flags & 0x10) !== 0) {
      if (!this._loggedAdpcm) {
        this._loggedAdpcm = true
        console.warn('[Diversity/Kiwi] server is sending ADPCM despite ' +
                     'compression=0; audio cannot be decoded')
      }
      return
    }

    const payload = buf.subarray(stereo ? 20 : 10)
    const n = payload.length >> 1
    if (n <= 0) return

    const raw = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const a = payload[i * 2], b = payload[i * 2 + 1]
      let s = little ? (b << 8) | a : (a << 8) | b
      if (s & 0x8000) s -= 0x10000
      raw[i] = s / 32768
    }

    // A stereo payload is interleaved L/R; fold it down rather than handing
    // the combiner a stream at twice the sample rate.
    let out = raw
    if (stereo && n >= 2) {
      const half = n >> 1
      out = new Float32Array(half)
      for (let i = 0; i < half; i++) out[i] = 0.5 * (raw[i * 2] + raw[i * 2 + 1])
    }

    try {
      this.onPcm(out, this.sampleRate || 12000)
    } catch (e) {
      console.error('[Diversity/Kiwi] onPcm handler threw:', e)
    }
  }

  // ── tuning ────────────────────────────────────────────────────────────

  canReceive (hz) {
    if (this.centerFreq === null || this.bandwidth === null) {
      return this.state === 'ready' ? true : false   // unknown coverage: try it
    }
    const half = this.bandwidth / 2
    return hz >= this.centerFreq - half && hz <= this.centerFreq + half
  }

  tune (lHz, mHz, rHz, demod) {
    if (this.state !== 'ready') {
      this._pending = { lHz, mHz, rHz, demod }
      return false
    }
    const mode = MODE_MAP[String(demod || 'USB').toUpperCase()] || 'usb'
    // Kiwi takes the dial frequency in kHz and the passband edges as offsets
    // from it in Hz, which is exactly what l/m/r give us.
    const low = Math.round(lHz - mHz)
    const high = Math.round(rHz - mHz)
    const khz = (mHz / 1000).toFixed(3)
    return this._send(
      `SET mod=${mode} low_cut=${low} high_cut=${high} freq=${khz}`
    )
  }
}

export default KiwiSource
