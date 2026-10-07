// ════════════════════════════════════════════════════════════════════════════
//  station.js — YOUR station's settings for the SV1BTL WebSDR layout
//
//  This is the only file most stations need to edit. After saving it, reload the
//  page in the browser (Ctrl+F5); no UberSDR restart is needed.
//  Keep the punctuation: text in 'quotes', a comma after each line.
// ════════════════════════════════════════════════════════════════════════════
window.STATION = {

  // ── Shown in the page header ──────────────────────────────────────────────
  callsign: 'N0CALL',                    // "It is operated by N0CALL"
  location: 'Your City, Country',        // "This is a WebSDR receiver, located in …"
  locator:  'AA00aa',                    // Maidenhead locator (links to a map)
  email:    'you@example.com',           // contact address shown on the page

  // Title of the mobile page (browser tab). The desktop page title comes from
  // UberSDR's own settings (admin page → instance name / location).
  mobileTitle: 'N0CALL WebSDR Mobile version',

  // ── Where a first-time visitor starts ─────────────────────────────────────
  // Returning visitors start where they left off.
  startKHz:  7120,                       // kHz
  startMode: 'LSB',                      // 'LSB', 'USB', 'AM', 'CW' or 'FM'

  // ── Must match UberSDR's config.yaml ──────────────────────────────────────
  // server.websdr_waterfall_calibration in /app/config/config.yaml (the install
  // script copies it here). Used for the dB scale of the spectrum.
  waterfallCalibration: 12,

  // ── RADE (buttons RADEL / RADEU) and the CW decoder window ───────────────────
  // Both are decoded by UberSDR's main web server (its "freedv" and "morse" extensions), which the
  // listener's browser contacts directly. Its address as your visitors reach it, e.g.
  // 'https://yourcall.tunnel.ubersdr.org' or 'http://your.host:8080'. Leave '' for
  // this same host on port 8080 (the install script fills in your UberSDR's public
  // address when it has one). UberSDR needs server.enable_cors: true for this.
  mainServer: '',

  // ── Users list ────────────────────────────────────────────────────────────
  // Each listener's country is added to their name ("SV1ABC GR,Athens"); set to
  // false to show the country only, without the city.
  showListenerCity: true,

  // ── Tuning ────────────────────────────────────────────────────────────────
  // Medium-wave channel step for the >>> / <<< buttons in AM: 9 kHz in Europe, Africa
  // and Asia (ITU Regions 1 and 3), 10 kHz in the Americas (Region 2).
  mwStepKHz: 9,

  // ── "Switch to another WebSDR" buttons (up to 6 per row) ──────────────────
  // [ 'button text', 'address' ],
  otherWebSDRs: [
    [ 'Twente',   'http://websdr.ewi.utwente.nl:8901/' ],
    [ 'Maasbree', 'http://sdr.websdrmaasbree.nl:8902/' ],
    [ 'Heppen',   'http://websdr.heppen.be:8901/' ],
    [ 'Utah1',    'http://websdr1.sdrutah.org:8901/' ],
    [ 'QO100',    'http://eshail.batc.org.uk:8901/' ],
    [ 'NA5B',     'http://na5b.com:8901/' ]
  ],

  // ── Band buttons (optional) ───────────────────────────────────────────────
  // Leave hamBands out (or empty) to use the built-in table (MW, 160m … 10m, IARU
  // Region 1). To change it, remove the // in front of the lines below and edit:
  //   [ 'button', lowest kHz, highest kHz, kHz the button tunes to, 'mode' ],
  // hamBands: [
  //   [ 'MW',   531,    1602,   729,   'AM'  ],
  //   [ '160m', 1810,   2000,   1910,  'LSB' ],
  //   [ '80m',  3500,   3800,   3685,  'LSB' ],
  //   [ '60m',  5351.5, 5366.5, 5357,  'USB' ],
  //   [ '40m',  7000,   7200,   7120,  'LSB' ],
  //   [ '30m',  10100,  10150,  10120, 'CW'  ],
  //   [ '20m',  14000,  14350,  14280, 'USB' ],
  //   [ '17m',  18068,  18168,  18130, 'USB' ],
  //   [ '15m',  21000,  21450,  21350, 'USB' ],
  //   [ '12m',  24890,  24990,  24940, 'USB' ],
  //   [ '10m',  28000,  29700,  28585, 'USB' ]
  // ],

  _end: true                             // (keep this last line)
};
