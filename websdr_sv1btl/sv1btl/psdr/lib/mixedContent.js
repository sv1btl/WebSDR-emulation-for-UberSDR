// SV1BTL (websdr_sv1btl): PhantomSDR-Plus sends ws:// sockets from an https page
// through its own relay (websdr_relay.py). This page has no relay and is served
// over plain http, where the browser opens ws:// directly, so the address is
// used as it is. (From an https copy of the page a ws:// receiver is blocked by
// the browser; choose a receiver that offers wss://.)
export function viaRelayIfBlocked (url) {
  return url
}
