// Where the page finds a side service — the RADE sidecar or the WebSDR relay.
//
// A station set up with configure-station.sh opens a single port on its router
// and proxy.py serves these under a path on it, so site_information.json names
// that path ("siteRade": "/rade", "siteRelay": "/relay"). A station set up
// before that names nothing, and the service is on its own port of the host
// the page came from, exactly as it always was. A full address ("host:port"
// or a URL) is honoured too, for a service on another machine.
export function sideServiceBase (value, defaultPort) {
  const loc = (typeof window !== 'undefined' && window.location) || null
  const secure = loc ? loc.protocol === 'https:' : false
  const v = String(value || '').trim()
  let host = `${loc ? loc.hostname : '127.0.0.1'}:${defaultPort}`
  let path = ''
  if (v.startsWith('/')) {
    host = loc ? loc.host : host
    path = v.replace(/\/+$/, '')
  } else if (v) {
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(v) ? v : 'http://' + v)
      host = u.host
      path = u.pathname.replace(/\/+$/, '')
    } catch (_) { /* keep the default */ }
  }
  return {
    http: `${secure ? 'https' : 'http'}://${host}${path}`,
    ws: `${secure ? 'wss' : 'ws'}://${host}${path}`
  }
}

// For messages to the sysop: where the page looked for the service.
export function sideServiceWhere (value, defaultPort) {
  const v = String(value || '').trim()
  return v ? `at ${v}` : `on port ${defaultPort}`
}
