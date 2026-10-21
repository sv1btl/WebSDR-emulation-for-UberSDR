// SV1BTL (websdr_sv1btl): stand-in for PhantomSDR-Plus's siteInfo.js (its
// site_information.json), with only what webSdrSource.js reads. The WebSDR relay
// and the name shown in the other WebSDR's user list are passed by
// sv1btl/diversity-ui.js instead (station.js diversityRelay / callsign).
const STN = (typeof window !== 'undefined' && window.STATION) || {}
export const siteSysop = String(STN.callsign || '')
export const siteRelay = ''
export default { siteSysop, siteRelay }
