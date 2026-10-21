/**
 * webSdrSource.js — WebSDR second-receiver adapter for the diversity combiner
 *
 * Implements the same contract as remoteSource.js / kiwiSource.js:
 *
 *   new WebSdrSource(url, { onPcm, onState })
 *     onPcm(Float32Array mono, sampleRate)
 *     onState('connecting' | 'ready' | 'closed' | 'error', detail)
 *   .connect() .close() .tune(lHz, mHz, rHz, demod) .canReceive(hz)
 *
 * THE RELAY
 * ---------
 * This is the one source that cannot talk to its receiver directly. WebSDR
 * answers the /~~stream WebSocket with 403 unless the Origin header is its
 * own site, and Origin is a forbidden header name — the browser sets it and
 * no script may change it. So the connection goes through websdr_relay.py on
 * this server, which connects onward with the Origin WebSDR expects, caps
 * concurrent sessions per site, and names this station in its User-Agent.
 *
 * If the relay is not running, this source fails with a message saying so
 * rather than looking like a broken receiver.
 *
 * PROTOCOL
 * --------
 * Audio is binary, decoded by webSdrCodec.js. Tuning goes the other way as a
 * text frame on the same socket:
 *
 *   GET /~~param?f=<kHz.3>&band=<n>&lo=<kHz>&hi=<kHz>&mode=<m>&name=<who>
 *   mode: 0 = SSB/CW (lo/hi choose the sideband)  1 = AM  2 = AMSYNC  4 = FM
 *
 * lo/hi are passband edges as offsets from the dial frequency, in kHz, as the
 * WebSDR client itself sends them (lo=-2.76&hi=-0.15). SV1BTL (websdr_sv1btl,
 * 2026-10-21): PhantomSDR-Plus sent Hz here (lo=-2760), which the WebSDR read as
 * kHz and clamped to its widest filter, so the audio was wide and noisy.
 *
 * The band index matters on multi-band sites, and coverage is needed before
 * we can say whether a frequency is reachable at all. Neither is in the
 * stream, so both come from the relay's /bandinfo, which fetches the site's
 * tmp/bandinfo.js server-side (the page cannot: no CORS headers on it).
 */

import { WebSdrCodec } from './webSdrCodec.js'
import { siteSysop, siteRelay } from './siteInfo.js'
import { sideServiceBase } from './lib/sideService.js'

const CONNECT_TIMEOUT_MS = 12000
// A socket still CONNECTING has not reached the server yet: Firefox holds a
// new WebSocket back after earlier ones to the same host:port failed (RFC 6455
// 7.2.3), up to 60 s. Closing it at CONNECT_TIMEOUT_MS counts as another
// failure and lengthens the hold, so past ~12 s no attempt can ever get
// through and one success is what would reset it. Wait out the hold instead.
const CONNECTING_MAX_MS = 75000
const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 30000
const DEFAULT_RELAY_PORT = 8898

// What the WebSDR's user list shows next to our connection, where a normal
// visitor's chat name would be. Naming the station rather than the software
// is the point: an operator glancing at that list should see a real callsign
// they could write to, matching the relay's User-Agent.
const LISTED_NAME = [String(siteSysop || '').trim(), 'PhantomSDR+ diversity']
  .filter(Boolean).join(' ')

// WebSDR has one SSB/CW mode and lets the passband decide the sideband.
const MODE_MAP = {
  USB: 0, LSB: 0, CW: 0, CWU: 0, CWL: 0,
  AM: 1, SAM: 2, AMSYNC: 2,
  FM: 4, NFM: 4, WFM: 4
}

/** Reduce anything the user typed to 'host:port'. */
export function webSdrHost (input) {
  let raw = String(input || '').trim()
  if (!raw) return ''
  if (!/^[a-z]+:\/\//i.test(raw)) raw = 'http://' + raw
  try {
    const u = new URL(raw)
    const port = u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : '80')
    return `${u.hostname}:${port}`
  } catch (_) {
    return ''
  }
}

export class WebSdrSource {
  /**
   * @param {string} url    the WebSDR's own address, e.g. http://websdr.example:8901
   * @param {object} opts   onPcm, onState, and optionally relay ('host:port' or a
   *                        full URL); default siteRelay from site_information.json,
   *                        else this host's port 8898
   */
  constructor (url, { onPcm, onState, relay = null, name = LISTED_NAME } = {}) {
    this.host = webSdrHost(url)
    this.name = name
    this.onPcm = onPcm || (() => {})
    this.onState = onState || (() => {})

    this.socket = null
    this.state = 'idle'
    this.sampleRate = null
    this.bands = null
    this.smeter = 0

    this.codec = new WebSdrCodec()
    this._relay = this._relayBase(relay)
    this._wantOpen = false
    this._retries = 0
    this._timer = null
    this._connectTimer = null
    this._pending = null
    this._reconnectArmed = false
  }

  /** Where the relay lives: siteRelay, else this host's port 8898. */
  _relayBase (relay) {
    const loc = (typeof window !== 'undefined' && window.location) || null
    const secure = loc ? loc.protocol === 'https:' : false
    if (relay) {
      let raw = String(relay).trim()
      if (!/^[a-z]+:\/\//i.test(raw)) raw = (secure ? 'https://' : 'http://') + raw
      try {
        const u = new URL(raw)
        return { http: `${u.protocol.replace('ws', 'http')}//${u.host}`, ws: `${secure ? 'wss' : 'ws'}://${u.host}` }
      } catch (_) { /* fall through */ }
    }
    return sideServiceBase(siteRelay, DEFAULT_RELAY_PORT)
  }

  connect () {
    this._wantOpen = true
    this._open()
  }

  close () {
    this._wantOpen = false
    clearTimeout(this._timer)
    clearTimeout(this._connectTimer)
    this._teardownSocket()
    this._setState('idle')
  }

  async _open () {
    this._teardownSocket()
    this._setState('connecting')
    this._reconnectArmed = false
    this.codec = new WebSdrCodec()

    if (!this.host) {
      this._setState('error', 'not a usable WebSDR address')
      return
    }

    // Coverage first: without it we cannot pick a band to tune, and a site
    // that does not answer here is not a WebSDR we can drive.
    if (!this.bands) {
      try {
        await this._loadBands()
      } catch (e) {
        this._setState('error', String(e && e.message ? e.message : e))
        this._scheduleReconnect()
        return
      }
      if (!this._wantOpen) return
    }

    const url = `${this._relay.ws}/websdr?host=${encodeURIComponent(this.host)}`
    let sock
    try {
      sock = new WebSocket(url)
    } catch (e) {
      this._setState('error', e)
      this._scheduleReconnect()
      return
    }
    sock.binaryType = 'arraybuffer'
    this.socket = sock

    sock.onopen = () => {
      // Frequency is not in the connect URL; the server keeps sending its
      // last setting until told otherwise, so tune immediately.
      if (this._pending) {
        const p = this._pending
        this._pending = null
        this.tune(p.lHz, p.mHz, p.rHz, p.demod)
      }
    }
    sock.onmessage = (ev) => this._onFrame(ev)
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
      console.warn('[Diversity/WebSDR] no audio within timeout:', this.host)
      try { sock.close() } catch (_) {}
    }
    this._connectTimer = setTimeout(check, CONNECT_TIMEOUT_MS)
  }

  async _loadBands () {
    const url = `${this._relay.http}/bandinfo?host=${encodeURIComponent(this.host)}`
    let r
    try {
      r = await fetch(url)
    } catch (e) {
      throw new Error('the WebSDR relay is not reachable — is websdr_relay.py running?')
    }
    if (!r.ok) throw new Error((await r.text().catch(() => '')) || `relay returned HTTP ${r.status}`)
    const data = await r.json()
    if (!data || !Array.isArray(data.bands) || !data.bands.length) {
      throw new Error('the relay returned no bands for this site')
    }
    this.bands = data.bands
  }

  _teardownSocket () {
    const s = this.socket
    this.socket = null
    if (!s) return
    s.onopen = s.onmessage = s.onerror = s.onclose = null
    try { s.close() } catch (_) {}
  }

  // The relay closes with a code carrying the reason: 4403 is the WebSDR's
  // own refusal, 4502 is a site we could not reach. Both are worth showing
  // as-is rather than as another anonymous 1006.
  _onClose (ev) {
    const code = ev && ev.code
    const why = (ev && ev.reason) || ''
    if (code === 4403) {
      this._setState('error', why || 'this WebSDR refused the connection')
      this._scheduleReconnect()
      return
    }
    if (code === 4502) {
      this._setState('error', why || 'the WebSDR could not be reached')
      this._scheduleReconnect()
      return
    }
    this._failed('closed', ev)
  }

  _failed (kind, ev) {
    this._setState(kind, ev)
    if (this._reconnectArmed) return
    this._reconnectArmed = true
    this._scheduleReconnect()
  }

  _scheduleReconnect () {
    if (!this._wantOpen) return
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
    if (!(ev.data instanceof ArrayBuffer)) return
    let pcm
    try {
      pcm = this.codec.decode(new Uint8Array(ev.data))
    } catch (e) {
      console.error('[Diversity/WebSDR] decode failed:', e)
      return
    }
    this.smeter = this.codec.smeter

    const rate = this.codec.sampleRate
    if (rate > 0 && rate !== this.sampleRate) {
      // WebSDR changes rate with the filter width, mid-stream and without
      // warning. The combiner re-measures the ratio when the rate moves, so
      // just report it rather than trying to hold one rate.
      this.sampleRate = rate
      if (this.state === 'ready') {
        this._setState('ready', { sampleRate: rate, coverage: this._coverage() })
      }
    }

    if (this.state !== 'ready' && this.sampleRate && pcm.length) {
      clearTimeout(this._connectTimer)
      this._retries = 0
      this._setState('ready', { sampleRate: this.sampleRate, coverage: this._coverage() })
    }

    if (!pcm.length || !this.sampleRate) return

    const out = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768
    try {
      this.onPcm(out, this.sampleRate)
    } catch (e) {
      console.error('[Diversity/WebSDR] onPcm handler threw:', e)
    }
  }

  // ── tuning ────────────────────────────────────────────────────────────

  _coverage () {
    if (!this.bands) return null
    let lo = Infinity, hi = -Infinity
    for (const b of this.bands) {
      lo = Math.min(lo, b.centerfreq - b.samplerate / 2)
      hi = Math.max(hi, b.centerfreq + b.samplerate / 2)
    }
    return Number.isFinite(lo) ? { lowHz: lo, highHz: hi } : null
  }

  _bandFor (hz) {
    if (!this.bands) return -1
    for (let i = 0; i < this.bands.length; i++) {
      const b = this.bands[i]
      const half = b.samplerate / 2
      if (hz >= b.centerfreq - half && hz <= b.centerfreq + half) return i
    }
    return -1
  }

  canReceive (hz) {
    if (!this.bands) return this.state === 'ready'
    return this._bandFor(hz) >= 0
  }

  tune (lHz, mHz, rHz, demod) {
    if (this.state !== 'ready' && !(this.socket && this.socket.readyState === WebSocket.OPEN)) {
      this._pending = { lHz, mHz, rHz, demod }
      return false
    }
    const band = this._bandFor(mHz)
    if (band < 0) return false

    const mode = MODE_MAP[String(demod || 'USB').toUpperCase()] ?? 0
    const lo = ((lHz - mHz) / 1000).toFixed(3)     // kHz, like the WebSDR client
    const hi = ((rHz - mHz) / 1000).toFixed(3)
    const khz = (mHz / 1000).toFixed(3)
    return this._send(
      `GET /~~param?f=${khz}&band=${band}&lo=${lo}&hi=${hi}&mode=${mode}` +
      `&name=${encodeURIComponent(this.name)}`
    )
  }
}

export default WebSdrSource
