// Receive Diversity for the SV1BTL WebSDR pages (desktop and mobile), after PhantomSDR-Plus.
//
// A second receiver somewhere else — another UberSDR, a KiwiSDR, a PhantomSDR-Plus or a
// classic WebSDR — is tuned along with this page, and the speaker plays whichever of the two has the
// better signal at the moment (selection with a 30 ms crossfade, never a sum: two
// distant receivers' audio has unrelated phase). The combiner and the four receiver
// adapters are PhantomSDR-Plus's own files in sv1btl/psdr/ (diversity.js, uberSource.js,
// kiwiSource.js, remoteSource.js, webSdrSource.js + webSdrCodec.js, diversityList.js;
// GNU GPL v3); this module is the
// panel and the glue to this page:
//   - audio: sv1btl/ubersdr-compat.js hands every decoded block of the local stream to
//     window.ubersdr_div_process(pcm, sampleRate) before AGC, squelch, NR and the
//     speaker; the combiner returns a block of the same length. The CW and digital
//     decoders take the local audio before that, as in PhantomSDR-Plus.
//   - tuning: the page's freq / lo / hi / mode are watched, and the second receiver is
//     retuned whenever they change (CW goes out as USB or LSB with this page's
//     passband, so both sites deliver the same tone).
// A classic WebSDR refuses audio connections from other sites' pages (it checks the
// Origin header, which no script can change), so it is reached through PhantomSDR-Plus's
// relay program, websdr_relay.py, run on this server (websdr_sv1btl/relay/, a Docker
// container): on this page's host, port 8902 or station.js diversityRelayPort; station.js
// diversityRelay ('host:port') points elsewhere. Its User-Agent names this station to the WebSDR's operator.

import { LS_URL, LS_TYPE, LS_CAL, dedupe, loadHistory, saveHistory, remembered,
         hintFor, normalise, browseUrl, typeLabel, parseBlob, mergeHistories,
         FILE_TAG } from './psdr/diversityList.js'

const W = window
const TYPES_HERE = ['uber', 'kiwi', 'phantom', 'websdr']
const STN = W.STATION || {}
const RELAY_PORT = 8902
// where the WebSDR relay is, and the name the other WebSDR's user list shows for us
function relayAddr () {
  return String(STN.diversityRelay || '').trim() ||
    (location.hostname + ':' + (parseInt(STN.diversityRelayPort, 10) || RELAY_PORT))
}
const LISTED_NAME = (String(STN.callsign || '').trim() || 'SV1BTL') + ' diversity'
const TUNE_POLL_MS = 250
const MODV = '?v=20261021f'                   // version tag on the psdr modules (browser cache)
const STATUS_POLL_MS = 500

const st = {
  type: 'uber', endpoint: '', calibDb: 0,
  history: loadHistory(),
  running: false, starting: false,
  comb: null, Comb: null, src: null, srcState: 'idle', errorText: '', closeCode: null, closeReason: '',
  tuneKey: '', tuneTimer: null, statusTimer: null,
  expanded: false, showSaved: false, editIndex: -1, adding: false, notice: '', pendingImport: null,
  dragFrom: -1
}
try {
  st.endpoint = localStorage.getItem(LS_URL) || ''
  st.calibDb = Number(localStorage.getItem(LS_CAL) || 0) || 0
  const t = localStorage.getItem(LS_TYPE)
  if (TYPES_HERE.indexOf(t) >= 0) st.type = t
  st.expanded = localStorage.getItem('ubersdr_div_open') === '1'
} catch (_) {}

// ── Styles (the panel is a .decwin, so it gets the decoder windows' light and dark look) ──
const css = `
#divpanel{width:470px;margin:4px auto 6px;font:11px Arial,sans-serif;text-align:left}
#divpanel .dw-head{cursor:pointer;user-select:none}
#divpanel .dv-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#9a9a9a;margin-right:5px;vertical-align:middle}
#divpanel .dv-dot.local{background:#1fae5c}#divpanel .dv-dot.remote{background:#13a6c4}#divpanel .dv-dot.wait{background:#e0a020}
#divpanel .dv-dot.blink{animation:dvblink 1.6s ease-in-out infinite}
@keyframes dvblink{50%{opacity:.35}}
#divpanel .dv-sum{max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:bold;color:#777}
#divpanel .dv-sum.ok{color:#127a3a}#divpanel .dv-sum.wait{color:#a66a00}#divpanel .dv-sum.err{color:#b00000}
#divpanel .dv-body{padding:5px 7px 6px}
#divpanel .dv-row{display:flex;align-items:center;gap:5px;margin:2px 0}
#divpanel .dv-row input[type=text]{flex:1;min-width:0;font-size:11px;height:17px;padding:0 3px;box-sizing:border-box}
#divpanel .dv-row input[type=range]{flex:1}
#divpanel button.dv-go{min-width:46px;font-weight:bold}
#divpanel button.dv-go.on{color:#b00000}
#divpanel button.dv-ico{min-width:20px;padding:0 2px}
#divpanel .dv-saved{margin:4px 0;padding:3px 4px;border:1px solid #ccc;border-radius:4px;background:#fff}
#divpanel .dv-saved .dv-sh{display:flex;justify-content:space-between;align-items:center;color:#444;margin-bottom:2px}
#divpanel .dv-ent{display:flex;align-items:center;gap:3px;padding:1px 2px;border-bottom:1px solid #eee}
#divpanel .dv-ent:last-child{border-bottom:0}
#divpanel .dv-ent.dv-drag{opacity:.45}
#divpanel .dv-ent.dv-over-up{box-shadow:inset 0 2px 0 #0b7a72}
#divpanel .dv-ent.dv-over-down{box-shadow:inset 0 -2px 0 #0b7a72}
html.ubersdr-dark #mainpanel #divpanel .dv-ent.dv-over-up{box-shadow:inset 0 2px 0 #5aa0ff}
html.ubersdr-dark #mainpanel #divpanel .dv-ent.dv-over-down{box-shadow:inset 0 -2px 0 #5aa0ff}
#divpanel .dv-ent .dv-who{flex:1;min-width:0;cursor:grab;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#divpanel .dv-ent .dv-name{color:#0a6b2a;font-weight:bold;margin-right:5px}
#divpanel .dv-ent .dv-addr{color:#333}
#divpanel .dv-ent.live .dv-name,#divpanel .dv-ent.live .dv-addr{font-weight:bold;animation:dvblink 1.6s ease-in-out infinite}
#divpanel .dv-ent input{font-size:11px;height:16px;padding:0 2px;box-sizing:border-box}
#divpanel .dv-ent a{text-decoration:none}
#divpanel .dv-ent button,#divpanel .dv-saved button{height:16px;font-size:10px;padding:0 3px}
#divpanel .dv-note{color:#9a3a00;margin:2px 0}
#divpanel table.dv-stat{width:100%;border-collapse:collapse;margin-top:3px}
#divpanel table.dv-stat td{padding:0 3px;border-bottom:1px solid #e4e4e4;white-space:normal}
#divpanel table.dv-stat td:first-child{color:#555;width:95px;white-space:nowrap}
#divpanel table.dv-stat td.amber{color:#a66a00}
#divpanel .dv-help{color:#555;margin:4px 0 0;line-height:13px}
html.ubersdr-dark #mainpanel #divpanel .dv-sum{color:#9aa1a8}
html.ubersdr-dark #mainpanel #divpanel .dv-sum.ok{color:#7fe0a0}html.ubersdr-dark #mainpanel #divpanel .dv-sum.wait{color:#ffc46b}html.ubersdr-dark #mainpanel #divpanel .dv-sum.err{color:#ff7a7a}
html.ubersdr-dark #mainpanel #divpanel .dv-saved{background:#22262a;border-color:#454b52}
html.ubersdr-dark #mainpanel #divpanel .dv-saved .dv-sh{color:#cfd5db}
html.ubersdr-dark #mainpanel #divpanel .dv-ent{border-bottom-color:#3a4046}
html.ubersdr-dark #mainpanel #divpanel .dv-ent .dv-name{color:#7fe0a0}
html.ubersdr-dark #mainpanel #divpanel .dv-ent .dv-addr{color:#dde2e7}
html.ubersdr-dark #mainpanel #divpanel table.dv-stat td{border-bottom-color:#3a4046}
html.ubersdr-dark #mainpanel #divpanel table.dv-stat td:first-child{color:#9aa1a8}
html.ubersdr-dark #mainpanel #divpanel table.dv-stat td.amber{color:#ffc46b}
html.ubersdr-dark #mainpanel #divpanel .dv-help{color:#9aa1a8}
html.ubersdr-dark #mainpanel #divpanel .dv-note{color:#ffb070}
html.ubersdr-dark #mainpanel #divpanel button.dv-go.on{color:#ff7a7a}
#divpanel.dv-mobile{width:auto;margin:0;font:15px Arial,sans-serif;background:none;border:0}
#divpanel.dv-mobile .dw-head{display:flex;align-items:center;gap:6px;padding:4px 0;background:none}
#divpanel.dv-mobile .dw-title{flex:1;font-weight:bold;font-size:16px}
#divpanel.dv-mobile .dv-sum{max-width:55vw;font-size:14px}
#divpanel.dv-mobile .dv-dot{width:11px;height:11px}
#divpanel.dv-mobile .dv-body{padding:2px 0 4px}
#divpanel.dv-mobile .dv-row{flex-wrap:wrap;gap:6px;margin:4px 0}
#divpanel.dv-mobile .dv-row select,#divpanel.dv-mobile .dv-row input[type=text]{height:34px;font-size:16px;box-sizing:border-box}
#divpanel.dv-mobile .dv-row input[type=text]{flex:1 1 55%}
#divpanel.dv-mobile .dv-row input[type=range]{flex:1 1 40%;height:30px}
#divpanel.dv-mobile button.myButton{height:34px;min-width:64px;font-size:15px}
#divpanel.dv-mobile button.dv-ico{min-width:44px}
#divpanel.dv-mobile .dv-saved{background:rgba(255,255,255,.75);padding:4px 6px}
#divpanel.dv-mobile .dv-ent{padding:5px 2px;gap:8px}
#divpanel.dv-mobile .dv-ent .dv-who{cursor:pointer;font-size:15px}
#divpanel.dv-mobile .dv-ent a{font-size:20px}
#divpanel.dv-mobile .dv-ent button,#divpanel.dv-mobile .dv-saved button{height:30px;min-width:36px;font-size:14px}
#divpanel.dv-mobile table.dv-stat{font-size:13px}
#divpanel.dv-mobile table.dv-stat td:first-child{width:110px}
#divpanel.dv-mobile .dv-help{font-size:13px;color:#333}
`

function el (tag, attrs, kids) {
  const e = document.createElement(tag)
  if (attrs) for (const k in attrs) {
    if (attrs[k] === null || attrs[k] === undefined) continue
    if (k === 'text') e.textContent = attrs[k]
    else if (k === 'cls') e.className = attrs[k]
    else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k])
    else e.setAttribute(k, attrs[k])
  }
  if (kids) for (const c of kids) if (c) e.appendChild(c)
  return e
}

// ── Saved receivers ──────────────────────────────────────────────────────────
function list () { return st.history[st.type] || [] }
function save () { saveHistory(st.history) }
function moveEntry (from, to) {
  const l2 = list().slice()
  if (from < 0 || from >= l2.length || to < 0 || to >= l2.length || from === to) { render(); return }
  const [x] = l2.splice(from, 1)
  l2.splice(to, 0, x)
  st.history[st.type] = l2
  save(); render()
}
function rememberAddr (v) {
  if (!(v || '').trim()) return
  st.history[st.type] = remembered(st.history, st.type, v)
  save()
}

// ── The second receiver ──────────────────────────────────────────────────────
async function sourceClass (type) {
  if (type === 'kiwi') return (await import('./psdr/kiwiSource.js' + MODV)).KiwiSource
  if (type === 'phantom') return (await import('./psdr/remoteSource.js' + MODV)).RemoteSource
  if (type === 'websdr') return (await import('./psdr/webSdrSource.js' + MODV)).WebSdrSource
  return (await import('./psdr/uberSource.js' + MODV)).UberSource
}

// The page's tuning as the sources take it: absolute passband edges and carrier in Hz
function pageTuning () {
  const f = Number(W.freq), l = Number(W.lo), h = Number(W.hi)
  if (!(f > 0) || !isFinite(l) || !isFinite(h)) return null
  let m = String(W.mode || 'USB').toUpperCase()
  if (m === 'CW') m = h <= 0 ? 'LSB' : 'USB'      // the page's CW passband sits below the carrier
  else if (m === 'AMSYNC') m = 'SAM'
  else if (m !== 'AM' && m !== 'FM' && m !== 'USB' && m !== 'LSB') m = h <= 0 ? 'LSB' : 'USB'
  return { l: (f + l) * 1000, m: f * 1000, r: (f + h) * 1000, demod: m }
}

function retune (force) {
  if (!st.src) return
  const t = pageTuning()
  if (!t) return
  const key = [t.l, t.m, t.r, t.demod].join('|')
  if (!force && key === st.tuneKey) return
  st.tuneKey = key
  try { st.src.tune(t.l, t.m, t.r, t.demod) } catch (e) { console.warn('[Diversity] tune failed', e) }
}

function onSrcState (state, detail) {
  st.srcState = state
  if (detail && typeof detail.code === 'number') { st.closeCode = detail.code; st.closeReason = detail.reason || '' }
  if (state === 'error' && detail) {
    st.errorText = typeof detail === 'string' ? detail
      : String(detail.error || detail.reason || detail.message || '') || ''
  } else if (state === 'ready') {
    st.errorText = ''; st.closeCode = null; st.closeReason = ''
  }
  if (state === 'ready') retune(true)               // a (re)connected receiver starts untuned
  if ((state === 'closed' || state === 'error') && st.comb) st.comb.reset()   // the alignment is lost
  refresh()
}

// Called by ubersdr-compat.js for every decoded block of the local stream
function processBlock (pcm, sr) {
  if (!st.running || !st.Comb || !pcm || !pcm.length || !(sr > 0)) return pcm
  if (!st.comb || st.comb.sr !== sr) {               // first block, or the stream's rate changed
    st.comb = new st.Comb({ sampleRate: sr, remoteCalibDb: st.calibDb })
    st.comb.active = true
  }
  try {
    const out = st.comb.pushLocal(pcm, 1)
    return out && out.length === pcm.length ? out : pcm
  } catch (e) {
    console.error('[Diversity] combiner threw, local audio kept:', e)
    return pcm
  }
}

async function start () {
  if (st.running || st.starting) return
  const url = normalise(st.endpoint, st.type)
  if (!url) { st.notice = 'Type the address of the second receiver first.'; render(); return }
  st.starting = true; st.notice = ''; render()
  try {
    localStorage.setItem(LS_URL, st.endpoint)
    localStorage.setItem(LS_CAL, String(st.calibDb))
    localStorage.setItem(LS_TYPE, st.type)
  } catch (_) {}
  let Source
  try {
    st.Comb = st.Comb || (await import('./psdr/diversity.js' + MODV)).DiversityCombiner
    Source = await sourceClass(st.type)
  } catch (e) {
    st.starting = false
    st.notice = 'Could not load the diversity code: ' + (e && e.message ? e.message : e)
    console.error('[Diversity] load failed', e)
    render(); return
  }
  st.starting = false
  st.comb = null                                    // built on the first local block, at its rate
  st.errorText = ''; st.closeCode = null; st.closeReason = ''; st.tuneKey = ''
  st.src = new Source(url, {
    onPcm: (pcm, sr) => { if (st.comb) st.comb.pushRemote(pcm, sr) },
    onState: onSrcState,
    relay: st.type === 'websdr' ? relayAddr() : null,     // (only the WebSDR source reads these)
    name: LISTED_NAME
  })
  st.running = true
  W.ubersdr_div_process = processBlock
  rememberAddr(st.endpoint)
  retune(true)                    // before connecting: UberSDR carries the tuning in its connect URL
  st.src.connect()
  st.tuneTimer = setInterval(() => retune(false), TUNE_POLL_MS)
  st.statusTimer = setInterval(refresh, STATUS_POLL_MS)
  render()
}

function stop () {
  clearInterval(st.tuneTimer); clearInterval(st.statusTimer)
  st.tuneTimer = st.statusTimer = null
  W.ubersdr_div_process = null
  if (st.src) { try { st.src.close() } catch (_) {} }
  st.src = null
  if (st.comb) { st.comb.active = false; st.comb.reset() }
  st.comb = null
  st.running = false; st.srcState = 'idle'; st.errorText = ''; st.closeCode = null; st.closeReason = ''
  render()
}

function status () {
  const base = { state: st.srcState, errorText: st.errorText, closeCode: st.closeCode, closeReason: st.closeReason, inRange: null }
  if (!st.comb) return Object.assign(base, { active: st.running, locked: false, unaligned: false, live: 'local', remoteSamples: 0 })
  if (st.src && typeof st.src.canReceive === 'function' && W.freq) {
    try { base.inRange = st.src.canReceive(Number(W.freq) * 1000) } catch (_) {}
  }
  return Object.assign(base, st.comb.getStatus())
}
W.ubersdr_div_status = status                   // for diagnosis in the browser console

// ── Panel ───────────────────────────────────────────────────────────────────
let panel = null, headDot, headSum, body
let MOBILE = false                            // the mobile page (m.html): no editing, larger buttons

function dB (v) { return v === undefined || v === null || !isFinite(v) ? '—' : Number(v).toFixed(1) }

function summary (s) {
  if (!st.running) return st.starting ? ['Loading…', 'wait'] : ['off', '']
  if (s.state === 'error' || s.state === 'closed') return [s.state + (s.errorText ? ' — ' + s.errorText : ''), 'err']
  const waiting = s.state !== 'ready' || !(s.locked || s.unaligned)
  if (waiting) return ['Please wait…', 'wait']
  return [s.locked ? 'Ready' : 'Ready (unaligned)', 'ok']
}

function renderHead (s) {
  const [txt, cls] = summary(s)
  headSum.textContent = txt
  headSum.title = txt
  headSum.className = 'dv-sum' + (cls ? ' ' + cls : '')
  let d = 'dv-dot'
  if (st.running) d += (s.locked || s.unaligned) ? (s.live === 'remote' ? ' remote blink' : ' local blink') : ' wait blink'
  headDot.className = d
  headDot.title = !st.running ? 'off' : (s.locked || s.unaligned) ? (s.live === 'remote' ? 'hearing the second receiver' : 'hearing this receiver') : 'not combining yet'
}

function savedBox () {
  const box = el('div', { cls: 'dv-saved' })
  const L = list()
  const add = el('button', { type: 'button', text: 'add', title: 'Enter a receiver by hand, without connecting to it', onclick: () => { st.adding = true; st.editIndex = -1; render() } })
  const clr = L.length ? el('button', { type: 'button', text: 'clear all', title: 'Empty the list for ' + typeLabel(st.type), onclick: () => {
    if (!confirm('Remove all ' + L.length + ' saved ' + typeLabel(st.type) + ' receivers?')) return
    st.history[st.type] = []; save(); render()
  } }) : null
  box.appendChild(el('div', { cls: 'dv-sh' }, [el('span', { text: 'Saved for ' + typeLabel(st.type) + ' — ' + L.length }), MOBILE ? null : el('span', null, [add, clr])]))

  function editor (entry, onOk) {
    const n = el('input', { type: 'text', placeholder: 'name (optional)', value: entry ? entry.name : '', style: 'width:110px' })
    const a = el('input', { type: 'text', placeholder: hintFor(st.type), value: entry ? entry.addr : '', style: 'flex:1;min-width:0' })
    const ok = () => { const v = { name: n.value.trim(), addr: a.value.trim() }; if (v.addr) onOk(v) }
    const cancel = () => { st.adding = false; st.editIndex = -1; render() }
    const key = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ok() } else if (ev.key === 'Escape') { ev.preventDefault(); cancel() } }
    n.addEventListener('keydown', key); a.addEventListener('keydown', key)
    setTimeout(() => (entry ? n : a).focus(), 0)
    return el('div', { cls: 'dv-ent' }, [n, a,
      el('button', { type: 'button', text: '✓', title: 'Save (Enter)', onclick: ok }),
      el('button', { type: 'button', text: '✕', title: 'Cancel (Escape)', onclick: cancel })])
  }

  if (st.adding) {
    box.appendChild(editor(null, (v) => {
      st.history[st.type] = dedupe([v].concat(list()))
      if (!st.endpoint.trim()) st.endpoint = v.addr
      st.adding = false; save(); render()
    }))
  }
  const live = st.running ? st.endpoint.trim() : ''
  L.forEach((e, i) => {
    if (i === st.editIndex) {
      box.appendChild(editor(e, (v) => {
        const l2 = list().slice()
        const clash = l2.findIndex((x) => x.addr === v.addr)
        if (clash >= 0 && clash !== i) l2.splice(clash, 1)
        const at = l2.findIndex((x) => x.addr === e.addr)
        if (at >= 0) l2[at] = v
        st.history[st.type] = dedupe(l2)
        if (st.endpoint.trim() === e.addr) st.endpoint = v.addr
        st.editIndex = -1; save(); render()
      }))
      return
    }
    const who = el('span', { cls: 'dv-who', title: st.running ? e.addr : (MOBILE ? 'Tap: use ' + e.addr : 'Click: use ' + e.addr + ' — drag up or down to change the order'), onclick: () => { if (!st.running) { st.endpoint = e.addr; if (MOBILE) st.showSaved = false; render() } } },
      [e.name ? el('span', { cls: 'dv-name', text: e.name }) : null, el('span', { cls: 'dv-addr', text: e.addr })])
    const remove = () => {
      st.history[st.type] = list().filter((x) => x.addr !== e.addr)
      if (st.endpoint.trim() === e.addr && !st.running) st.endpoint = ''
      save(); render()
    }
    if (MOBILE) {        // the phone: pick, open its page, remove; naming and order on the desktop page
      box.appendChild(el('div', { cls: 'dv-ent' + (live && e.addr === live ? ' live' : '') }, [who,
        el('a', { href: browseUrl(normalise(e.addr, st.type)), target: '_blank', rel: 'noopener', title: 'Open this receiver\'s own page', text: '🌍' }),
        el('button', { type: 'button', cls: 'myButton', text: '✕', title: 'Remove', onclick: remove })]))
      return
    }
    const move = (to) => moveEntry(i, to)
    const row = el('div', { cls: 'dv-ent' + (live && e.addr === live ? ' live' : ''), draggable: 'true' }, [who,
      el('a', { href: browseUrl(normalise(e.addr, st.type)), target: '_blank', rel: 'noopener', title: 'Open this receiver\'s own page', text: '🌍' }),
      el('button', { type: 'button', text: '▲', title: 'Move up', disabled: i === 0 ? '' : null, onclick: () => move(i - 1) }),
      el('button', { type: 'button', text: '▼', title: 'Move down', disabled: i === L.length - 1 ? '' : null, onclick: () => move(i + 1) }),
      el('button', { type: 'button', text: '✎', title: 'Edit name and address', onclick: () => { st.editIndex = i; st.adding = false; render() } }),
      el('button', { type: 'button', text: '✕', title: 'Remove', onclick: remove })])
    // drag a row up or down and drop it where it belongs (as in PhantomSDR-Plus)
    row.addEventListener('dragstart', (ev) => {
      if (ev.target !== row) return
      st.dragFrom = i
      row.classList.add('dv-drag')
      try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(i)) } catch (_) {}
    })
    row.addEventListener('dragover', (ev) => {
      if (st.dragFrom < 0) return
      ev.preventDefault()
      try { ev.dataTransfer.dropEffect = 'move' } catch (_) {}
      for (const r of box.querySelectorAll('.dv-over-up, .dv-over-down')) if (r !== row) r.classList.remove('dv-over-up', 'dv-over-down')
      if (i !== st.dragFrom) row.classList.add(i < st.dragFrom ? 'dv-over-up' : 'dv-over-down')
    })
    row.addEventListener('dragleave', (ev) => {
      if (!row.contains(ev.relatedTarget)) row.classList.remove('dv-over-up', 'dv-over-down')
    })
    row.addEventListener('drop', (ev) => {
      ev.preventDefault()
      const from = st.dragFrom
      st.dragFrom = -1
      if (from >= 0 && from !== i) moveEntry(from, i)
      else render()
    })
    row.addEventListener('dragend', () => { if (st.dragFrom >= 0) { st.dragFrom = -1; render() } })
    box.appendChild(row)
  })
  for (const b of box.querySelectorAll('button[disabled=""]')) b.disabled = true

  // backup / restore of all the lists (JSON file, the same format as PhantomSDR-Plus)
  const fileIn = el('input', { type: 'file', accept: 'application/json,.json', style: 'display:none' })
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files && fileIn.files[0]; fileIn.value = ''
    if (!f) return
    const r = parseBlob(await f.text())
    if (!r.ok) { st.notice = r.error; render(); return }
    st.pendingImport = r; render()
  })
  const any = Object.keys(st.history).some((k) => (st.history[k] || []).length)
  const tools = el('div', { cls: 'dv-sh', style: 'margin-top:3px' }, [
    el('span', { text: any ? 'Backup of all receiver types' : 'Nothing saved yet' }),
    el('span', null, [
      any ? el('button', { type: 'button', text: '⭳ export', title: 'Save every list to a file', onclick: () => {
        const doc = { format: FILE_TAG, version: 2, saved: new Date().toISOString(), from: location.host, history: st.history }
        const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }))
        const a = el('a', { href: url, download: FILE_TAG + '.json' }); document.body.appendChild(a); a.click(); a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 10000)
      } }) : null,
      el('button', { type: 'button', text: '⭱ import', title: 'Read the lists back from a file', onclick: () => fileIn.click() }),
      fileIn])])
  box.appendChild(tools)
  if (st.pendingImport) {
    const p = st.pendingImport
    const done = (merge) => {
      st.history = mergeHistories(st.history, p.history, merge); st.pendingImport = null; save()
      if (!st.endpoint.trim()) { const f0 = list()[0]; st.endpoint = f0 ? f0.addr : '' }
      render()
    }
    box.appendChild(el('div', { cls: 'dv-sh' }, [el('span', { text: p.count + ' receivers in the file:' }), el('span', null, [
      el('button', { type: 'button', text: 'merge', onclick: () => done(true) }),
      el('button', { type: 'button', text: 'replace', onclick: () => done(false) }),
      el('button', { type: 'button', text: 'cancel', onclick: () => { st.pendingImport = null; render() } })])]))
  }
  return box
}

function statTable (s) {
  const t = el('table', { cls: 'dv-stat' })
  function row (k, v, cls) { t.appendChild(el('tr', null, [el('td', { text: k }), el('td', { text: v, cls: cls || '' })])) }
  row('link', s.state + (s.errorText ? ' — ' + s.errorText : '') +
      (s.closeCode ? ' (' + s.closeCode + (s.closeReason ? ' ' + s.closeReason : '') + ')' : ''))
  row('aligned', s.locked ? (s.delayMs / 1000).toFixed(2) + ' s' : s.unaligned ? 'by arrival, searching' : 'searching')
  row('corr', s.locked ? dB(s.corrPeak * 100) + ' %' : '—')
  row('remote audio', s.remoteSamples ? (s.remoteSamples / 1000).toFixed(0) + 'k @ ' + s.remoteRateIn + ' Hz' : 'none', s.remoteSamples ? '' : 'amber')
  row('SNR local', dB(s.snrLocalDb) + ' dB')
  row('SNR remote', dB(s.snrRemoteDb) + ' dB')
  row('switches', String(s.switches || 0))
  if (s.inRange === false && s.state === 'ready') row('', 'the second receiver does not cover this frequency', 'amber')
  return t
}

// The live figures only: the title line and the status table. Rebuilding the whole
// panel twice a second replaced the Start/Stop button under the pointer, so a press
// that spanned a rebuild was lost (Stop seemed not to stop).
function refresh () {
  if (!panel) return
  const s = status()
  renderHead(s)
  if (!st.expanded || st.dragFrom >= 0) return
  const tbl = body.querySelector('table.dv-stat')
  if (tbl) tbl.replaceWith(statTable(s))
}

function render () {
  if (!panel) return
  const s = status()
  renderHead(s)
  body.style.display = st.expanded ? '' : 'none'
  if (!st.expanded) return
  if (st.dragFrom >= 0) return                     // a row is being dragged: leave the list alone
  // keep typing undisturbed: rebuild only the parts that change while running
  const active = document.activeElement
  if (st.running && body.contains(active) && active.tagName === 'INPUT' && active.type === 'range') {
    const tbl = body.querySelector('table.dv-stat')
    if (tbl) tbl.replaceWith(statTable(s))
    return
  }
  if (!st.running && body.contains(active) && active.tagName === 'INPUT' && active.type === 'text' && !st.adding && st.editIndex < 0 && active.id === 'div-endpoint') return
  body.textContent = ''

  const sel = el('select', { id: 'div-type', title: 'What the second receiver is' })
  for (const t of TYPES_HERE) {
    const o = el('option', { value: t, text: typeLabel(t) })
    if (t === st.type) o.selected = true
    sel.appendChild(o)
  }
  sel.disabled = st.running
  sel.addEventListener('change', () => {
    const leaving = list(), cur = st.endpoint.trim()
    st.type = sel.value
    if (!cur || leaving.some((e) => e.addr === cur)) { const f0 = list()[0]; st.endpoint = f0 ? f0.addr : '' }
    st.editIndex = -1; st.adding = false
    render()
  })
  const inp = el('input', { type: 'text', id: 'div-endpoint', placeholder: hintFor(st.type), list: 'div-endpoint-history', autocomplete: 'off', value: st.endpoint })
  inp.disabled = st.running
  inp.addEventListener('input', () => { st.endpoint = inp.value })
  inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); start() } })
  const dl = el('datalist', { id: 'div-endpoint-history' })
  for (const e of list()) dl.appendChild(el('option', { value: e.addr, text: e.name }))
  const n = list().length
  const menu = el('button', { type: 'button', cls: 'dv-ico' + (MOBILE ? ' myButton' : ''), text: '☰',
    title: n ? n + (n === 1 ? ' saved receiver' : ' saved receivers') + ' for ' + typeLabel(st.type) + ': click to name, edit, back up or restore' : 'Saved receivers: add, back up or restore',
    onclick: () => { st.showSaved = !st.showSaved; render() } })
  if (st.showSaved) menu.style.fontWeight = 'bold'
  const go = el('button', { type: 'button', cls: 'dv-go' + (st.running ? ' on' : '') + (MOBILE ? ' myButton' : ''), text: st.running ? 'Stop' : (st.starting ? '…' : 'Start'),
    onclick: () => (st.running ? stop() : start()) })
  if (MOBILE) {
    body.appendChild(el('div', { cls: 'dv-row' }, [sel, inp, dl]))
    body.appendChild(el('div', { cls: 'dv-row' }, [menu, go]))
  } else body.appendChild(el('div', { cls: 'dv-row' }, [el('label', { for: 'div-type', text: 'Second RX' }), sel, inp, dl, menu, go]))

  if (st.notice) body.appendChild(el('div', { cls: 'dv-note', text: st.notice }))
  if (st.showSaved) body.appendChild(savedBox())

  const rng = el('input', { type: 'range', min: '-15', max: '15', step: '0.5', value: String(st.calibDb), id: 'div-calib' })
  const val = el('span', { text: st.calibDb.toFixed(1) + ' dB', style: 'width:44px;text-align:right' })
  rng.addEventListener('input', () => {
    st.calibDb = Number(rng.value) || 0
    val.textContent = st.calibDb.toFixed(1) + ' dB'
    if (st.comb) st.comb.remoteCalibDb = st.calibDb
    try { localStorage.setItem(LS_CAL, String(st.calibDb)) } catch (_) {}
  })
  body.appendChild(el('div', { cls: 'dv-row', title: 'Added to the second receiver\'s SNR before the two are compared: + favours the second receiver, − this one. +15 / −15 force one site, to listen to it alone. 0 for an UberSDR or PhantomSDR-Plus, a few dB + for a KiwiSDR.' },
    [el('label', { for: 'div-calib', text: 'Remote SNR trim' }), rng, val]))

  if (st.running) {
    body.appendChild(statTable(s))
    body.appendChild(el('p', { cls: 'dv-help', text: 'The speaker follows whichever receiver hears the signal better, 1–3 s behind real time; the second receiver follows this page\'s tuning by itself.' + (MOBILE ? '' : ' The decoders keep using this receiver.') }))
  } else {
    body.appendChild(el('p', { cls: 'dv-help', text: 'Combine this receiver with a second one somewhere else (a few hundred km away is best) to ride through fading and local noise: ' +
      'UberSDR = its web address (e.g. sdr.example.org), KiwiSDR = host:8073, PhantomSDR+ = host:8900, WebSDR = host:8901 (through this station\'s relay). Both receivers must hear the station.' }))
  }
}

function build () {
  if (panel) return
  const desktop = !!document.getElementById('wfmode')
  const rs = document.getElementById('radestatus')
  MOBILE = !desktop && !!document.getElementById('memories') && !!rs
  if (!desktop && !MOBILE) return
  const style = document.createElement('style')
  style.id = 'divpanel-style'; style.textContent = css
  document.head.appendChild(style)

  headDot = el('span', { cls: 'dv-dot' })
  headSum = el('span', { cls: 'dv-sum', text: 'off' })
  const arrow = el('span', { text: st.expanded ? '▾' : '▸' })
  const head = el('div', { cls: 'dw-head', title: 'Combine this receiver with a second one to ride through fades' },
    [el('span', { cls: 'dw-title' }, [headDot, document.createTextNode(MOBILE ? 'Receive Diversity:' : 'Receive Diversity')]), headSum, arrow])
  head.addEventListener('click', () => {
    st.expanded = !st.expanded
    arrow.textContent = st.expanded ? '▾' : '▸'
    try { localStorage.setItem('ubersdr_div_open', st.expanded ? '1' : '0') } catch (_) {}
    render()
  })
  body = el('div', { cls: 'dv-body' })
  panel = el('div', { cls: MOBILE ? 'dv-mobile' : 'decwin', id: 'divpanel' }, [head, body])

  if (MOBILE) {          // a section of its own under the RADE status line, like Memories and Settings
    rs.parentNode.insertBefore(panel, rs.nextSibling)
    rs.parentNode.insertBefore(document.createElement('hr'), panel)
    render()
    return
  }
  // just before the "Switch to another WebSDR" links (desktop page)
  let anchor = document.getElementById('otherwebsdrs')
  if (!anchor) {
    for (const em of document.querySelectorAll('td b em')) {
      if (/switch to/i.test(em.textContent)) { anchor = em.closest('table'); break }
    }
  }
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(panel, anchor)
  else {
    const mr = document.getElementById('moderow')
    if (!mr) return
    mr.parentNode.insertBefore(panel, mr.nextSibling)
  }
  render()
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build)
else build()
W.addEventListener('beforeunload', () => { if (st.running) stop() })
