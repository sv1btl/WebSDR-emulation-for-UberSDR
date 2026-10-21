/**
 * The saved receiver list, and the address rules that go with it.
 *
 * Shared by the desktop panel (lib/DiversityPanel.svelte) and the mobile page
 * (mobile/Mobile.svelte) so the two cannot drift apart: both read and write
 * the same localStorage keys in the same shape, and a list built on a phone
 * is the same list the desktop offers.
 *
 * An entry is {name, addr}. The name is optional and only a label — "Twente"
 * reads better than "websdr.ewi.utwente.nl:8901" — while the address is the
 * identity, so naming one never creates a duplicate.
 */

export const LS_URL = 'diversityEndpoint'
export const LS_TYPE = 'diversityType'
export const LS_CAL = 'diversityCalibDb'
export const LS_HIST = 'diversityHistory'

export const TYPES = ['phantom', 'kiwi', 'uber', 'websdr']

/** Human name for a source type, for a heading or a selector. */
export function typeLabel (t) {
  return t === 'kiwi' ? 'KiwiSDR'
       : t === 'uber' ? 'UberSDR'
       : t === 'websdr' ? 'WebSDR'
       : 'PhantomSDR+'
}

/** What an address looks like for a given type — placeholder and prompt text. */
export function hintFor (t) {
  return t === 'kiwi' ? 'host:8073'
       : t === 'uber' ? 'host  (its web port)'
       : t === 'websdr' ? 'host:8901  (needs the relay)'
       : 'host:8900'
}

/**
 * Earlier builds stored plain address strings.  Accepting those here means an
 * existing list survives an update instead of quietly disappearing, and an
 * imported file written by either build works.
 */
export function toEntry (x) {
  if (typeof x === 'string') {
    const addr = x.trim()
    return addr ? { name: '', addr } : null
  }
  if (!x || typeof x !== 'object') return null
  const addr = String(x.addr || '').trim()
  return addr ? { name: String(x.name || '').trim(), addr } : null
}

/**
 * One address appears once: the first entry wins, which is what makes
 * "imported first" mean the imported name is the one kept.
 */
export function dedupe (list) {
  const out = []
  for (const e of list) if (!out.some((o) => o.addr === e.addr)) out.push(e)
  return out
}

export function toList (arr) {
  if (!Array.isArray(arr)) return []
  return dedupe(arr.map(toEntry).filter(Boolean))
}

export function emptyHistory () {
  return { phantom: [], kiwi: [], uber: [], websdr: [] }
}

/** Read every list back, tolerating anything at all in storage. */
export function loadHistory () {
  const h = emptyHistory()
  try {
    const saved = JSON.parse(localStorage.getItem(LS_HIST) || '{}')
    for (const k of Object.keys(h)) h[k] = toList(saved[k])
  } catch (_) {}
  return h
}

export function saveHistory (history) {
  try {
    localStorage.setItem(LS_HIST, JSON.stringify(history))
  } catch (_) {}
}

/**
 * Put an address at the top of its type's list, keeping any name it already
 * had — re-using a receiver must not strip its label.  Returns the new list;
 * the caller assigns it, so Svelte reactivity stays the caller's business.
 */
export function remembered (history, type, value) {
  const v = (value || '').trim()
  if (!v) return history[type] || []
  const known = (history[type] || []).find((e) => e.addr === v)
  return dedupe([
    { name: known ? known.name : '', addr: v },
    ...(history[type] || [])
  ])
}

/**
 * Turn what was typed into the URL the source adapter wants.  Each type
 * differs, and the differences are not cosmetic:
 */
export function normalise (u, type) {
  let v = (u || '').trim()
  if (!v) return ''
  // Accept a bare host, a http(s) URL or a full ws URL.
  if (/^https?:\/\//i.test(v)) v = v.replace(/^http/i, 'ws')
  if (!/^wss?:\/\//i.test(v)) v = 'ws://' + v
  v = v.replace(/\/+$/, '')
  // A Kiwi wants the bare origin: kiwiSource.js appends /kiwi/<ts>/SND itself,
  // because that timestamp has to be fresh on every connection.
  if (type === 'kiwi') return v.replace(/\/kiwi\/.*$/i, '')
  // UberSDR native: the bare origin; uberSource.js appends /ws itself. Any
  // path goes — its API is at the root, and /v2/ is only its web interface.
  if (type === 'uber') return v.replace(/^(wss?:\/\/[^/?#]+).*$/i, '$1')
  // WebSDR: hand the address over as typed.  webSdrSource.js reduces it to
  // host:port itself and gives that to the relay, which makes the actual
  // connection — the browser is not allowed to make it directly.
  if (type === 'websdr') return v
  return /\/audio$/.test(v) ? v : v + '/audio'
}

/**
 * The address as a person would type it into a browser.
 *
 * The stored address is what the ADAPTER dials, so it has to be walked back:
 * ws:// is the same host over http, and the endpoint paths each adapter
 * appends are not part of the site's own page, which lives at the root.
 */
export function browseUrl (addr) {
  let v = String(addr || '').trim()
  if (!v) return ''
  v = v.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:')
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v
  return v
    .replace(/\/(audio|ws)(\?.*)?$/i, '/')
    .replace(/\/kiwi\/.*$/i, '/')
}

// ── Transfer between browsers ──────────────────────────────────────────────
//
// The list lives in one browser's localStorage, so a phone starts empty even
// though the same receivers are saved on the desktop. These carry it across:
// the desktop draws a QR code, the phone scans it and pastes the text.

export const FILE_TAG = 'phantomsdr-diversity-addresses'

/**
 * Serialise every list for copy-paste.  Compact, not pretty-printed: this is
 * what has to fit in a QR code.  Entries with no name are written as bare
 * strings, which is both valid input for toEntry() and noticeably shorter.
 */
export function exportBlob (history) {
  const out = {}
  for (const k of TYPES) {
    const list = history[k] || []
    if (list.length) out[k] = list.map((e) => (e.name ? { n: e.name, a: e.addr } : e.addr))
  }
  return JSON.stringify({ format: FILE_TAG, version: 2, history: out })
}

/**
 * Parse pasted text.  Accepts the compact blob above, the pretty file the
 * desktop panel exports, and a bare {phantom: [...]} map — so a list copied
 * by hand out of localStorage works too.
 *
 * Returns { ok, history, count, error }.
 */
export function parseBlob (text) {
  let parsed
  try {
    parsed = JSON.parse(String(text).trim())
  } catch (e) {
    return { ok: false, error: 'That is not valid JSON.' }
  }
  const incoming = parsed && typeof parsed === 'object' && parsed.history
    ? parsed.history
    : parsed
  if (!incoming || typeof incoming !== 'object') {
    return { ok: false, error: 'No saved receivers found in that text.' }
  }
  const history = emptyHistory()
  let count = 0
  for (const k of TYPES) {
    const raw = Array.isArray(incoming[k]) ? incoming[k] : []
    // {n, a} is the compact form written by exportBlob; toEntry handles the
    // rest, including the plain strings older builds stored.
    history[k] = toList(raw.map((x) =>
      x && typeof x === 'object' && !Array.isArray(x) && (x.a || x.n)
        ? { name: x.n || x.name || '', addr: x.a || x.addr || '' }
        : x
    ))
    count += history[k].length
  }
  if (!count) return { ok: false, error: 'No saved receivers found in that text.' }
  return { ok: true, history, count }
}

/** Combine an imported set with what is already saved, or replace it. */
export function mergeHistories (current, incoming, merge) {
  const out = emptyHistory()
  for (const k of TYPES) {
    out[k] = dedupe(merge
      ? (incoming[k] || []).concat(current[k] || [])
      : (incoming[k] || []))
  }
  return out
}

// A QR code tops out near 2.9 kB at the lowest error correction, and long
// before that the modules are too dense to scan off a screen.  Past this we do
// not try — the text is the reliable path and the UI falls back to it.
export const QR_MAX_BYTES = 1200

export function qrTooLarge (blob) {
  return new TextEncoder().encode(blob).length > QR_MAX_BYTES
}

/**
 * Render a blob as a QR data URL.  The library is imported dynamically so its
 * ~50 kB never lands in either page's initial bundle — this is only reached
 * when someone actually opens the transfer sheet.
 */
export async function qrDataUrl (blob) {
  const QRCode = (await import('qrcode')).default
  return QRCode.toDataURL(blob, {
    errorCorrectionLevel: 'L',
    margin: 2,
    width: 512
  })
}
