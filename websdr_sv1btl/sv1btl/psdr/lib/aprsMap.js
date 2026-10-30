// aprsMap.js — live map of the APRS stations heard by the APRS decoder.
//
// Keeps the station list itself (so nothing is lost while the map window is
// closed) and draws it with Leaflet, which is imported only the first time the
// window opens — listeners who never open the map never download it.
//
// Everything drawn is vector (circle markers, polylines) so no marker image
// assets are needed. Text from the air (comments, object names) is untrusted:
// popups are built from DOM nodes with textContent and labels are escaped.
//
//   const m = new AprsMap(siteGridSquare);
//   m.add(pos);                  // pos from ax25.js: { call, via, lat, lon, text, symbol, killed, time }
//   await m.open(element);       // create the map in a sized element
//   m.focus(call); m.fitAll(); m.clear(); m.close();
//   m.setAutoFit(on)             // re-fit on every new station / move; a pan or
//                                // zoom by hand turns it off (onAutoFitChange)

const TRACK_MIN_M = 20;       // ignore position jitter below this
const TRACK_MAX_POINTS = 500;
// Auto fit re-frames the map at most this often, so a burst of packets does
// not make it jump on every one.
const AUTOFIT_MIN_MS = 1500;

// SV1BTL WebSDR: no bundler here — Leaflet 1.9.4 (the same version, from UberSDR's
// static files) is loaded from ./leaflet/ with a script and a stylesheet tag.
let leafletLoading = null;
function loadLeaflet() {
  if (window.L && window.L.map) return Promise.resolve(window.L);
  if (leafletLoading) return leafletLoading;
  leafletLoading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = new URL('./leaflet/leaflet.css', import.meta.url).href;
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = new URL('./leaflet/leaflet.js', import.meta.url).href;
    js.onload = () => resolve(window.L);
    js.onerror = () => { leafletLoading = null; reject(new Error('could not load Leaflet')); };
    document.head.appendChild(js);
  });
  return leafletLoading;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Centre of a Maidenhead locator of 2–10 characters, or null. */
export function locatorToLatLon(loc) {
  const s = String(loc || '').trim().toUpperCase();
  if (!/^[A-R]{2}(\d\d([A-X]{2}(\d\d([A-X]{2})?)?)?)?$/.test(s)) return null;
  let lon = -180, lat = -90;
  let w = 20, h = 10;
  lon += (s.charCodeAt(0) - 65) * w; lat += (s.charCodeAt(1) - 65) * h;
  const steps = [[10, 10, 48], [24, 24, 65], [10, 10, 48], [24, 24, 65]];
  for (let i = 2, k = 0; i < s.length; i += 2, k++) {
    const [dx, dy, base] = steps[k];
    w /= dx; h /= dy;
    lon += (s.charCodeAt(i) - base) * w;
    lat += (s.charCodeAt(i + 1) - base) * h;
  }
  return { lat: lat + h / 2, lon: lon + w / 2 };
}

function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

function bearingDeg(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
    Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${(s / 3600).toFixed(1)} h ago`;
}

export class AprsMap {
  constructor(homeLocator) {
    this.home = locatorToLatLon(homeLocator);
    this.homeLocator = homeLocator || '';
    this.stations = new Map();      // call → { pos, track: [[lat, lon]], marker, line }
    this.L = null;
    this.map = null;
    this.onChange = null;           // called after add/clear, for counters
    this.autoFit = true;
    this.onAutoFitChange = null;    // called when a hand pan/zoom turns it off
    this._selfMove = false;         // true only inside _move()
    this._fitTimer = null;
    this._lastFit = 0;
    // HFDL map: small aircraft pointing along their track instead of the APRS dot.
    this.planeIcons = false;
  }

  setAutoFit(on) {
    this.autoFit = !!on;
    if (this.autoFit) this.fitAll();
  }

  get count() { return this.stations.size; }

  add(pos) {
    if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lon)) return;
    if (pos.killed) { this._remove(pos.call); this._changed(); return; }
    let st = this.stations.get(pos.call);
    if (!st) {
      st = { pos, track: [[pos.lat, pos.lon]], marker: null, line: null };
      this.stations.set(pos.call, st);
    } else {
      const last = st.track[st.track.length - 1];
      if (distanceKm({ lat: last[0], lon: last[1] }, pos) * 1000 >= TRACK_MIN_M) {
        st.track.push([pos.lat, pos.lon]);
        if (st.track.length > TRACK_MAX_POINTS) st.track.shift();
      }
      st.pos = pos;
    }
    if (this.map) {
      this._draw(pos.call, st);
      if (this.autoFit) this._scheduleFit();
    }
    this._changed();
  }

  clear() {
    for (const call of [...this.stations.keys()]) this._remove(call);
    this._changed();
  }

  async open(el) {
    if (this.map) return;
    if (!this.L) {
      this.L = await loadLeaflet();
    }
    const L = this.L;
    this.map = L.map(el, { worldCopyJump: true, attributionControl: true });
    // A move we did not start is the operator panning or zooming: stop
    // re-framing under their hands.
    this.map.on('movestart', () => {
      if (this._selfMove || !this.autoFit) return;
      this.autoFit = false;
      if (typeof this.onAutoFitChange === 'function') this.onAutoFitChange(false);
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(this.map);

    if (this.home) {
      L.circleMarker([this.home.lat, this.home.lon], {
        radius: 7, color: '#f59e0b', weight: 2, fillColor: '#fbbf24', fillOpacity: 0.9,
      }).addTo(this.map)
        .bindTooltip('⌂ ' + esc(this.homeLocator), { permanent: true, direction: 'right', className: 'aprs-label aprs-home' });
    }
    for (const [call, st] of this.stations) this._draw(call, st);
    this.fitAll();
  }

  close() {
    if (this._fitTimer) { clearTimeout(this._fitTimer); this._fitTimer = null; }
    if (!this.map) return;
    this.map.remove();
    this.map = null;
    for (const st of this.stations.values()) { st.marker = null; st.line = null; }
  }

  /** Size changed (window opened / resized): Leaflet must re-measure. */
  invalidate() {
    if (!this.map) return;
    this._move(() => this.map.invalidateSize({ animate: false }));
    if (this.autoFit) this.fitAll();
  }

  fitAll() {
    if (!this.map) return;
    this._lastFit = Date.now();
    const pts = [...this.stations.values()].map((s) => [s.pos.lat, s.pos.lon]);
    if (this.home) pts.push([this.home.lat, this.home.lon]);
    this._move(() => {
      if (pts.length === 0) this.map.setView([20, 0], 2, { animate: false });
      else if (pts.length === 1) this.map.setView(pts[0], 10, { animate: false });
      else this.map.fitBounds(pts, { padding: [30, 30], maxZoom: 13, animate: false });
    });
  }

  /**
   * Run one of our own view changes. Un-animated, Leaflet fires 'movestart'
   * synchronously inside the call, so the flag brackets exactly our move and
   * the next one is correctly read as the operator's.
   */
  _move(fn) {
    this._selfMove = true;
    try { fn(); } finally { this._selfMove = false; }
  }

  focus(call) {
    const st = this.stations.get(call);
    if (!this.map || !st) return;
    // Asking for one station is a decision about the view: auto fit stops.
    if (this.autoFit) {
      this.autoFit = false;
      if (typeof this.onAutoFitChange === 'function') this.onAutoFitChange(false);
    }
    this._move(() => this.map.setView([st.pos.lat, st.pos.lon],
      Math.max(this.map.getZoom(), 12), { animate: false }));
    if (st.marker) st.marker.openPopup();
  }

  // ── internals ────────────────────────────────────────────────────────────

  _scheduleFit() {
    if (this._fitTimer) return;
    const wait = Math.max(0, AUTOFIT_MIN_MS - (Date.now() - this._lastFit));
    this._fitTimer = setTimeout(() => {
      this._fitTimer = null;
      if (this.autoFit) this.fitAll();
    }, wait);
  }

  _changed() { if (typeof this.onChange === 'function') this.onChange(this.count); }

  _remove(call) {
    const st = this.stations.get(call);
    if (!st) return;
    if (this.map) {
      if (st.marker) this.map.removeLayer(st.marker);
      if (st.line) this.map.removeLayer(st.line);
    }
    this.stations.delete(call);
  }

  /** Small aircraft rotated to its heading (bearing of the last two track points). */
  _planeIcon(st) {
    let hdg = 0;
    if (st.track.length > 1) {
      const a = st.track[st.track.length - 2], b = st.track[st.track.length - 1];
      hdg = bearingDeg({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
    }
    const svg = `<svg viewBox="0 0 24 24" width="24" height="24" style="transform:rotate(${Math.round(hdg)}deg);display:block;filter:drop-shadow(0 0 2px #000)">` +
      `<path d="M12 2c.8 0 1.3.9 1.3 2v5.2l7.7 4.6v2l-7.7-2.4v4.7l2.2 1.7V21L12 20l-3.5 1v-1.2l2.2-1.7v-4.7L3 15.8v-2l7.7-4.6V4c0-1.1.5-2 1.3-2z" ` +
      `fill="#fbbf24" stroke="#3b2f05" stroke-width="0.8"/></svg>`;
    return this.L.divIcon({ html: svg, className: 'hfdl-plane', iconSize: [24, 24], iconAnchor: [12, 12] });
  }

  _draw(call, st) {
    const L = this.L;
    const ll = [st.pos.lat, st.pos.lon];
    if (this.planeIcons) {
      if (!st.marker) {
        st.marker = L.marker(ll, { icon: this._planeIcon(st), keyboard: false }).addTo(this.map);
        st.marker.bindTooltip(esc(call), { permanent: true, direction: 'right', offset: [10, 0], className: 'aprs-label' });
        st.marker.bindPopup(() => this._popup(call), { maxWidth: 320 });
      } else {
        st.marker.setLatLng(ll);
        st.marker.setIcon(this._planeIcon(st));
        if (st.marker.isPopupOpen()) st.marker.setPopupContent(this._popup(call));
      }
    } else if (!st.marker) {
      st.marker = L.circleMarker(ll, {
        radius: 6, color: '#065f46', weight: 2, fillColor: '#34d399', fillOpacity: 0.9,
      }).addTo(this.map);
      st.marker.bindTooltip(esc(call), { permanent: true, direction: 'right', className: 'aprs-label' });
      st.marker.bindPopup(() => this._popup(call), { maxWidth: 320 });
    } else {
      st.marker.setLatLng(ll);
      if (st.marker.isPopupOpen()) st.marker.setPopupContent(this._popup(call));
    }
    if (st.track.length > 1) {
      if (!st.line) {
        st.line = L.polyline(st.track, this.planeIcons
          ? { color: '#ff2a2a', weight: 3, opacity: 0.95 }
          : { color: '#10b981', weight: 2, opacity: 0.7 }).addTo(this.map);
      } else {
        st.line.setLatLngs(st.track);
      }
    }
  }

  _popup(call) {
    const st = this.stations.get(call);
    const box = document.createElement('div');
    box.className = 'aprs-popup';
    if (!st) return box;
    const p = st.pos;
    const title = document.createElement('div');
    title.className = 'aprs-popup-call';
    title.textContent = call + (p.via && p.via !== call ? `  (via ${p.via})` : '');
    box.appendChild(title);
    const body = document.createElement('div');
    body.textContent = p.text;
    box.appendChild(body);
    const meta = document.createElement('div');
    meta.className = 'aprs-popup-meta';
    const bits = [`heard ${ago(p.time)}`];
    if (this.home) {
      const d = distanceKm(this.home, p);
      bits.push(`${d < 10 ? d.toFixed(1) : Math.round(d)} km at ${Math.round(bearingDeg(this.home, p))}° from here`);
    }
    if (st.track.length > 1) bits.push(`${st.track.length} track points`);
    meta.textContent = bits.join(' · ');
    box.appendChild(meta);
    if (p.link) {
      const a = document.createElement('a');
      a.href = p.link; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.className = 'aprs-popup-link';
      a.textContent = (p.linkText || 'Details') + ' ↗';
      box.appendChild(a);
    }
    return box;
  }
}
