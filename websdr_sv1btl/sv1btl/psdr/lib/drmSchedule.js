// DRM broadcast schedule for the DRM panel's selector.
//
// The panel asks the DRM helper for the live schedule (GET /schedule on the
// helper, refreshed hourly; see autorun/drmschedule.js). It merges the DRM
// Reception Project's schedule (drmrx.org: times, days, target, power, site),
// KiwiSDR's listener confirmations ("verified") and the broadcasters' own HFCC
// registrations ("registered"). This snapshot, taken on 2026-10-25 (B26), is what
// the panel shows when the helper cannot be reached. Times are UTC; "days" is
// one bit per day, Sunday first (drmrx.org's Days[SMTWTFS]).

export const DRM_SCHEDULE_SNAPSHOT = [
  {"station":"Akashvani","region":"MW","url":"https://www.drmrx.org/schedules/drmbc.php?id=Akashvani","slots":[{"khz":549,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":100,"site":"Mumbai B, Maharashtra, India","language":"Asmita Channel","verified":true,"registered":false},{"khz":549,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":100,"site":"Ranchi, Jharkhand, India","language":"Hindi","verified":true,"registered":false},{"khz":558,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":300,"site":"Dibrugarh, Assam, India","language":"Hindi","verified":true,"registered":false},{"khz":585,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":1000,"site":"Chinsurah, West Bengal, India","language":"External Service","verified":false,"registered":false},{"khz":594,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":200,"site":"Ajmer, Rajasthan, India","language":"Hindi","verified":true,"registered":false},{"khz":603,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":200,"site":"Bengaluru, Karnataka, India","language":"Hindi","verified":true,"registered":false},{"khz":612,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":100,"site":"Patna, Bihar, India","language":"Hindi","verified":true,"registered":false},{"khz":648,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":200,"site":"Kolkata A, West Bengal, India","language":"Geetanjali Channel","verified":true,"registered":false},{"khz":666,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":200,"site":"Itanagar, Arunachal Pradesh, India","language":"Hindi","verified":true,"registered":false},{"khz":702,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":200,"site":"Siliguri, Bengal, India","language":"Hindi","verified":true,"registered":false},{"khz":711,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":200,"site":"Chennai A, Tamil Nadu, India","language":"Hindi","verified":true,"registered":false},{"khz":729,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":200,"site":"Hyderabad A, Telangana, India","language":"Hindi","verified":true,"registered":false},{"khz":738,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":300,"site":"Luknow, Uttar Pradesh, India","language":"Hindi","verified":true,"registered":false},{"khz":747,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":100,"site":"Jagdalpur, Chhatisgarh, India","language":"Hindi","verified":false,"registered":false},{"khz":756,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":200,"site":"Dharwad, Karnataka, India","language":"Hindi","verified":true,"registered":false},{"khz":783,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":20,"site":"Chennai C, Tamil Nadu, India","language":"Vividh Bharati","verified":true,"registered":false},{"khz":783,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":100,"site":"Pune, Maharashtra, India","language":"Hindi","verified":true,"registered":false},{"khz":792,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":200,"site":"Jabalpur, Madhya Pradesh, India","language":"Hindi","verified":true,"registered":false},{"khz":801,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":300,"site":"Rajkot, Gujarat, India","language":"Hindi","verified":true,"registered":false},{"khz":810,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":200,"site":"Delhi A, New Delhi, India","language":"Indraprastha Channel","verified":true,"registered":false},{"khz":828,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":100,"site":"Vijayawada, Andhra Pradesh, India","language":"Hindi","verified":true,"registered":false},{"khz":837,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":200,"site":"Ahmedabad, Gujarat, India","language":"Hindi","verified":true,"registered":false},{"khz":864,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":300,"site":"Jalandhar A, Punjab, India","language":"Hindi","verified":true,"registered":false},{"khz":909,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":300,"site":"Suratgarh, Rajasthan, India","language":"Hindi","verified":true,"registered":false},{"khz":918,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":100,"site":"Visakhapatnam, Andhra Pradesh, India","language":"Hindi","verified":true,"registered":false},{"khz":927,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":100,"site":"Trichirapalli, Tamil Nadu, India","language":"Hindi","verified":true,"registered":false},{"khz":981,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":300,"site":"Jammu, Jammu & Kashmir, India","language":"Hindi","verified":true,"registered":false},{"khz":999,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":100,"site":"Kolkata B, West Bengal, India","language":"Sanchayita Channel","verified":true,"registered":false},{"khz":1026,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":20,"site":"Guwahati B, Assam, India","language":"Hindi","verified":true,"registered":false},{"khz":1044,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":100,"site":"Mumbai A, Maharashtra, India","language":"Samvadita Channel","verified":true,"registered":false},{"khz":1053,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":100,"site":"Pasighat, Arunachal Pradesh, India","language":"Hindi","verified":true,"registered":false},{"khz":1125,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":1000,"site":"Chinsurah, West Bengal, India","language":"External Service","verified":false,"registered":false},{"khz":1233,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":100,"site":"Varanasi, Uttar Pradesh, India","language":"Hindi","verified":true,"registered":false},{"khz":1278,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":100,"site":"Panaji A, Goa, India","language":"Hindi","verified":true,"registered":false},{"khz":1368,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":20,"site":"New Delhi C, Delhi, India","language":"Vividh Bharati","verified":true,"registered":false},{"khz":1386,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":20,"site":"Bikaner, Rajasthan, India","language":"Hindi","verified":true,"registered":false},{"khz":1449,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":20,"site":"Barmer, Rajasthan, India","language":"Hindi","verified":true,"registered":false},{"khz":1512,"start":"00:00","end":"24:00","days":"1111111","target":"India","power":20,"site":"Tawang, Arunachal Pradesh, India","language":"Hindi","verified":true,"registered":false}]},
  {"station":"Voice of Korea","region":"MW","url":"https://www.drmrx.org/schedules/drmbc.php?id=Voice%20of%20Korea","slots":[{"khz":657,"start":"00:00","end":"24:00","days":"1111111","target":"Korea","power":1500,"site":"Kangnam, DPRK","language":"Korean","verified":false,"registered":false},{"khz":801,"start":"00:00","end":"24:00","days":"1111111","target":"Korea","power":500,"site":"Kimchaek, DPRK","language":"Korean","verified":true,"registered":false}]},
  {"station":"CNR-1 Voice of China","region":"MW","url":"https://www.drmrx.org/schedules/drmbc.php?id=CNR-1%20Voice%20of%20China","slots":[{"khz":1377,"start":"13:00","end":"18:00","days":"1111111","target":"China","power":0,"site":"Zhengzhou City, Hunan Province, China","language":"Chinese","verified":false,"registered":false}]},
  {"station":"Yunnan Broadcast","region":"MW","url":"https://www.drmrx.org/schedules/drmbc.php?id=Yunnan%20Broadcast","slots":[{"khz":1557,"start":"00:00","end":"24:00","days":"1111111","target":"China","power":0,"site":"Unknown, China","language":"Chinese","verified":true,"registered":false}]},
  {"station":"Korean Central Broadcasting Station","region":"SW","url":"https://www.drmrx.org/schedules/drmbc.php?id=Korean%20Central%20Broadcasting%20Station","slots":[{"khz":3205,"start":"20:00","end":"18:00","days":"1111111","target":"Korea","power":50,"site":"Pyongyang, DPRK","language":"Korean","verified":true,"registered":false},{"khz":6140,"start":"20:00","end":"18:00","days":"1111111","target":"Korea","power":50,"site":"Pyongyang, DPRK","language":"Korean","verified":true,"registered":false}]},
  {"station":"Radio Romania International","region":"SW","url":"https://www.drmrx.org/schedules/drmbc.php?id=Radio%20Romania%20International","slots":[{"khz":5955,"start":"19:00","end":"19:30","days":"1111111","target":"Central Europe","power":40,"site":"Tiganesti, Romania","language":"Italian","verified":true,"registered":false},{"khz":6110,"start":"19:00","end":"20:00","days":"1111111","target":"Central Europe","power":90,"site":"Tiganesti, Romania","language":"German","verified":true,"registered":false},{"khz":9470,"start":"13:30","end":"14:00","days":"1111111","target":"China","power":90,"site":"Tiganesti, Romania","language":"Chinese","verified":true,"registered":false},{"khz":9500,"start":"22:00","end":"23:00","days":"1111111","target":"South America","power":90,"site":"Tiganesti, Romania","language":"Spanish","verified":true,"registered":false},{"khz":9570,"start":"18:00","end":"19:00","days":"1111111","target":"Western Europe","power":90,"site":"Tiganesti, Romania","language":"English","verified":true,"registered":false},{"khz":9720,"start":"17:00","end":"18:00","days":"1111111","target":"Western Europe","power":90,"site":"Tiganesti, Romania","language":"French","verified":true,"registered":false},{"khz":15250,"start":"04:00","end":"05:00","days":"1111111","target":"India","power":90,"site":"Tiganesti, Romania","language":"English","verified":true,"registered":false},{"khz":21470,"start":"06:30","end":"07:00","days":"1111111","target":"India","power":90,"site":"Tiganesti, Romania","language":"English","verified":true,"registered":false}]},
  {"station":"CNR-1 Voice of China","region":"SW","url":"https://www.drmrx.org/schedules/drmbc.php?id=CNR-1%20Voice%20of%20China","slots":[{"khz":6030,"start":"20:25","end":"18:05","days":"1111111","target":"China","power":30,"site":"Beijing, China","language":"Chinese","verified":true,"registered":false},{"khz":9655,"start":"08:00","end":"12:00","days":"1111111","target":"China","power":30,"site":"Urumqi, China","language":"Chinese","verified":true,"registered":false},{"khz":9655,"start":"22:00","end":"01:00","days":"1111111","target":"China","power":30,"site":"Urumqi, China","language":"Chinese","verified":true,"registered":false},{"khz":11695,"start":"01:00","end":"09:00","days":"1111111","target":"China","power":30,"site":"Dongfang, China","language":"Chinese","verified":true,"registered":false},{"khz":13790,"start":"00:00","end":"10:00","days":"1111111","target":"China","power":30,"site":"Qiqihar, China","language":"Chinese","verified":true,"registered":false},{"khz":13825,"start":"01:00","end":"09:00","days":"1111111","target":"China","power":30,"site":"Beijing, China","language":"Chinese","verified":true,"registered":false},{"khz":13835,"start":"10:00","end":"12:00","days":"1111111","target":"China","power":30,"site":"Qiqihar, China","language":"Chinese","verified":true,"registered":false},{"khz":15290,"start":"00:00","end":"12:00","days":"1111111","target":"China","power":150,"site":"Beijing, China","language":"Chinese","verified":true,"registered":false},{"khz":17605,"start":"01:00","end":"07:00","days":"1111111","target":"China","power":30,"site":"Beijing, China","language":"Chinese","verified":true,"registered":false},{"khz":17650,"start":"01:00","end":"06:00","days":"1111111","target":"China","power":30,"site":"Kunming, China","language":"Chinese","verified":true,"registered":false},{"khz":17660,"start":"07:00","end":"12:00","days":"1111111","target":"China","power":30,"site":"Beijing, China","language":"Chinese","verified":true,"registered":false},{"khz":17700,"start":"01:00","end":"09:00","days":"1111111","target":"China","power":150,"site":"Beijing, China","language":"Chinese","verified":true,"registered":false},{"khz":17710,"start":"08:00","end":"11:00","days":"1111111","target":"China","power":30,"site":"Kunming, China","language":"Chinese","verified":true,"registered":false},{"khz":17720,"start":"07:00","end":"20:00","days":"1111111","target":"China","power":30,"site":"Beijing, China","language":"Chinese","verified":true,"registered":false},{"khz":17770,"start":"01:00","end":"09:00","days":"1111111","target":"China","power":30,"site":"Dongfang, China","language":"Chinese","verified":true,"registered":false},{"khz":17830,"start":"01:00","end":"08:00","days":"1111111","target":"China","power":30,"site":"Urumqi, China","language":"Chinese","verified":true,"registered":false},{"khz":17870,"start":"06:00","end":"08:00","days":"1111111","target":"China","power":30,"site":"Kunming, China","language":"Chinese","verified":true,"registered":false}]},
  {"station":"SE-TA 2 (Germany)","region":"SW","url":"https://www.drmrx.org/schedules/drmbc.php?id=SE-TA%202%20(Germany)","slots":[{"khz":6195,"start":"09:00","end":"14:00","days":"1111111","target":"Europe","power":2,"site":"Waldheim, Germany","language":"German","verified":false,"registered":false}]},
  {"station":"Music 4 Joy","region":"SW","url":"https://www.drmrx.org/schedules/drmbc.php?id=Music%204%20Joy","slots":[{"khz":7225,"start":"18:30","end":"19:30","days":"0010100","target":"Eastern Europe, Russia, Central & South","power":100,"site":"Nauen, Germany","language":"Music","verified":true,"registered":false},{"khz":9810,"start":"20:00","end":"21:00","days":"0010100","target":"West Africa","power":100,"site":"Nauen, Germany","language":"Music","verified":true,"registered":false},{"khz":13650,"start":"13:00","end":"14:00","days":"0010100","target":"China, Japan","power":100,"site":"Nauen, Germany","language":"Music","verified":true,"registered":false},{"khz":13730,"start":"18:00","end":"19:00","days":"0010100","target":"East Africa","power":100,"site":"Nauen, Germany","language":"Music","verified":true,"registered":false}]},
  {"station":"RNZ Pacific","region":"SW","url":"https://www.drmrx.org/schedules/drmbc.php?id=RNZ%20Pacific","slots":[{"khz":7285,"start":"16:51","end":"17:58","days":"1111110","target":"Tonga Fiji Samoa Cook Isl","power":35,"site":"Rangitaiki, New Zealand","language":"English","verified":true,"registered":false},{"khz":11690,"start":"17:59","end":"18:58","days":"1111110","target":"Tonga Fiji Samoa Cook Isl","power":35,"site":"Rangitaiki, New Zealand","language":"English","verified":true,"registered":false},{"khz":11690,"start":"18:59","end":"19:58","days":"1111110","target":"Tonga Fiji Samoa Cook Isl","power":35,"site":"Rangitaiki, New Zealand","language":"English","verified":true,"registered":false},{"khz":13840,"start":"19:59","end":"20:58","days":"1111110","target":"Tonga Fiji Samoa Cook Isl","power":35,"site":"Rangitaiki, New Zealand","language":"English","verified":true,"registered":false}]},
  {"station":"TDF DRM (France)","region":"SW","url":"https://www.drmrx.org/schedules/drmbc.php?id=TDF%20DRM%20(France)","slots":[{"khz":9565,"start":"22:00","end":"23:00","days":"1111111","target":"West Africa","power":100,"site":"Issoudun, France","language":"French","verified":false,"registered":true},{"khz":13740,"start":"22:00","end":"23:00","days":"1111111","target":"East Central Africa","power":100,"site":"Issoudun, France","language":"French","verified":false,"registered":false}]},
  {"station":"funklust","region":"SW","url":"https://www.drmrx.org/schedules/drmbc.php?id=funklust","slots":[{"khz":15785,"start":"00:00","end":"24:00","days":"1111111","target":"Europe","power":1,"site":"Erlangen, Germany","language":"German","verified":true,"registered":false}]},
  {"station":"BBC World Service","region":"SW","url":"https://www.drmrx.org/schedules/drmbc.php?id=BBC%20World%20Service","slots":[{"khz":17575,"start":"15:00","end":"16:00","days":"1111111","target":"India","power":100,"site":"Woofferton, United Kingdom","language":"English","verified":true,"registered":true}]},
];

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const runsOn = (slot, day) => !slot.days || slot.days[((day % 7) + 7) % 7] === '1';

/**
 * True when a slot is on air at the given moment (UTC). A slot that crosses
 * midnight belongs to the day it started on, as drmrx.org lists it.
 */
export function slotOnAir(slot, now = new Date()) {
  const t = now.getUTCHours() * 60 + now.getUTCMinutes();
  const day = now.getUTCDay();
  const a = toMin(slot.start), b = toMin(slot.end);
  if (a <= b) return t >= a && t < b && runsOn(slot, day);
  return (t >= a && runsOn(slot, day)) || (t < b && runsOn(slot, day - 1));
}

/** Minutes until the slot next starts (0 when on air), looking a week ahead. */
export function minutesToStart(slot, now = new Date()) {
  if (slotOnAir(slot, now)) return 0;
  const t = now.getUTCHours() * 60 + now.getUTCMinutes();
  const day = now.getUTCDay();
  const a = toMin(slot.start);
  for (let d = 0; d < 8; d++) {
    const wait = a - t + d * 1440;
    if (wait > 0 && runsOn(slot, day + d)) return wait;
  }
  return Infinity;
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "daily", "not Sat", "Tue, Thu" … for a Days[SMTWTFS] bit string. */
export function daysText(days) {
  if (!days || days === '1111111') return 'daily';
  const on = DAY.filter((_, i) => days[i] === '1');
  const off = DAY.filter((_, i) => days[i] !== '1');
  return off.length === 1 ? 'not ' + off[0] : on.join(', ');
}

// ── Ranking by the station's QTH ────────────────────────────────────────────
// Broadcasts are ranked by how close their target area comes to this
// station's grid locator ([websdr] grid_locator). When the target is unknown
// ("Various", empty), the transmitter's country is used instead: a nearby
// transmitter is usually heard whatever its beam.

/** Maidenhead locator (2–10 characters) → [lat, lon] of the square's centre. */
export function gridToLatLon(loc) {
  const l = String(loc || '').trim().toUpperCase();
  if (!/^[A-R]{2}(\d\d([A-X]{2}(\d\d)?)?)?$/.test(l)) return null;
  let lon = (l.charCodeAt(0) - 65) * 20 - 180, lat = (l.charCodeAt(1) - 65) * 10 - 90;
  let w = 20, h = 10;
  if (l.length >= 4) { w = 2; h = 1; lon += Number(l[2]) * w; lat += Number(l[3]) * h; }
  if (l.length >= 6) { w /= 24; h /= 24; lon += (l.charCodeAt(4) - 65) * w; lat += (l.charCodeAt(5) - 65) * h; }
  if (l.length >= 8) { w /= 10; h /= 10; lon += Number(l[6]) * w; lat += Number(l[7]) * h; }
  return [lat + h / 2, lon + w / 2];
}

/** Great-circle distance in km. */
export function distanceKm([la1, lo1], [la2, lo2]) {
  const r = Math.PI / 180;
  const a = Math.sin((la2 - la1) * r / 2) ** 2
          + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Target areas as drmrx.org / HFCC name them: [pattern, lat, lon, radius km].
// The radius is the area's rough size; inside it counts as "beamed here".
// More specific names come first (the first match per comma-separated part wins).
const AREAS = [
  [/west(ern)?\s*europe/i, 47, 2, 1200],
  [/cent(ral|\.)?\s*europe/i, 49, 15, 900],
  [/east(ern)?\s*europe/i, 52, 30, 1200],
  [/north(ern)?\s*europe|scandinavia/i, 61, 15, 1000],
  [/south(ern)?\s*europe|mediterranean|balkans?/i, 41, 18, 1200],
  [/europe/i, 50, 12, 2500],
  [/russia/i, 56, 45, 2500],
  [/middle\s*east|gulf|arabia/i, 27, 45, 1500],
  [/north\s*africa/i, 29, 10, 1800],
  [/west\s*africa/i, 11, -3, 1500],
  [/east\s*africa/i, 0, 37, 1500],
  [/south(ern)?\s*africa/i, -25, 25, 1500],
  [/cent(ral|\.)?\s*africa/i, 2, 20, 1500],
  [/africa/i, 5, 20, 3500],
  [/cent(ral|\.)?\s*asia|^\s*central\s*&\s*south\s*$/i, 43, 65, 1500],
  [/south\s*east\s*asia|southeast\s*asia|indonesia|philippines/i, 8, 110, 2000],
  [/south\s*asia|india|pakistan|bangladesh|sri\s*lanka/i, 22, 79, 1500],
  [/china/i, 34, 108, 2200],
  [/japan/i, 36, 138, 800],
  [/korea/i, 38, 127, 500],
  [/east\s*asia/i, 35, 120, 2000],
  [/asia/i, 30, 95, 4000],
  [/australia/i, -25, 134, 2000],
  [/new\s*zealand/i, -41, 174, 700],
  [/tonga|fiji|samoa|cook\s*isl|pacific|oceania/i, -17, -175, 2500],
  [/north\s*america|usa|canada/i, 42, -95, 2500],
  [/cent(ral|\.)?\s*america|caribbean|mexico/i, 17, -85, 1500],
  [/south\s*america|brazil|argentina/i, -15, -60, 2500],
];

// Transmitter countries (the part of drmrx.org's site after the last comma).
const COUNTRIES = {
  'germany': [51, 10], 'france': [46.5, 2.5], 'united kingdom': [53, -2], 'uk': [53, -2],
  'romania': [45.5, 25], 'austria': [47.5, 14], 'italy': [42.5, 12.5], 'vatican': [41.9, 12.5],
  'spain': [40, -4], 'portugal': [39.5, -8], 'netherlands': [52.2, 5.5], 'belgium': [50.6, 4.6],
  'luxembourg': [49.7, 6.1], 'switzerland': [46.8, 8.2], 'czech republic': [49.8, 15.5],
  'slovakia': [48.7, 19.7], 'hungary': [47.2, 19.5], 'poland': [52, 19], 'greece': [39, 22],
  'bulgaria': [42.7, 25.5], 'turkey': [39, 35], 'sweden': [62, 15], 'norway': [61, 9],
  'finland': [63, 26], 'denmark': [56, 10], 'russia': [56, 45], 'ukraine': [49, 32],
  'kuwait': [29.3, 47.7], 'saudi arabia': [24, 45], 'united arab emirates': [24, 54],
  'uae': [24, 54], 'oman': [21, 57], 'iran': [32, 53], 'egypt': [27, 30], 'nigeria': [9, 8],
  'ascension': [-7.9, -14.4], 'madagascar': [-19, 47], 'south africa': [-29, 24],
  'india': [22, 79], 'pakistan': [30, 70], 'china': [35, 105], 'japan': [36, 138],
  'korea': [36, 128], 'south korea': [36, 128], 'dprk': [40, 127], 'north korea': [40, 127],
  'taiwan': [23.7, 121], 'philippines': [13, 122], 'singapore': [1.35, 103.8],
  'thailand': [15, 101], 'indonesia': [-2, 118], 'australia': [-25, 134],
  'new zealand': [-41, 174], 'usa': [39, -98], 'united states': [39, -98],
  'canada': [56, -100], 'mexico': [23, -102], 'brazil': [-10, -52], 'argentina': [-34, -64],
};

/** The places a slot's target names, or null when the target says nothing. */
function targetAreas(target) {
  const out = [];
  for (const part of String(target || '').split(/,|\/|;|\band\b/)) {
    const hit = AREAS.find(([re]) => re.test(part));
    if (hit) out.push(hit);
  }
  return out.length ? out : null;
}

/**
 * How far (km) a broadcast's footprint is from the QTH: 0 when the QTH is
 * inside its target area, else the distance to the area's edge; with no
 * usable target, the distance to the transmitter's country. Infinity when
 * nothing is known.
 */
export function slotRemoteness(slot, qth) {
  if (!qth) return Infinity;
  const areas = targetAreas(slot.target);
  if (areas) return Math.min(...areas.map(([, la, lo, r]) => Math.max(0, distanceKm(qth, [la, lo]) - r)));
  const country = String(slot.site || '').split(',').pop().replace(/\?/g, '').trim().toLowerCase();
  const at = COUNTRIES[country];
  return at ? distanceKm(qth, at) : Infinity;
}

/** Within this many km of the QTH a broadcast counts as aimed at it. */
export const NEAR_KM = 1000;

/**
 * Flatten a schedule into selector rows, on-air first, then by start time.
 * Rows outside the receiver (minKhz..maxKhz) are left out.
 */
export function scheduleRows(list, now = new Date(), minKhz = 0, maxKhz = Infinity) {
  const rows = [];
  for (const st of list || []) {
    for (const slot of st.slots) {
      if (slot.khz < minKhz || slot.khz > maxKhz) continue;
      rows.push({ ...slot, station: st.station, region: st.region, url: st.url,
                  onAir: slotOnAir(slot, now), wait: minutesToStart(slot, now) });
    }
  }
  rows.sort((a, b) => a.wait - b.wait || a.khz - b.khz);
  return rows;
}
