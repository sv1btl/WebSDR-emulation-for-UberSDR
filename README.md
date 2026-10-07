# SV1BTL WebSDR layout for UberSDR — installation and user guide

Version 2026-09-30 · by SV1BTL · based on RW3PS's WebSDR template

- **Repository:** https://github.com/sv1btl/WebSDR-emulation-for-UberSDR
- **Live example:** http://sv1btlham.no-ip.org:8901/ (SV1BTL's WebSDR, Athens)
- **Questions and problem reports:** https://github.com/sv1btl/WebSDR-emulation-for-UberSDR/issues

This package replaces the page that UberSDR shows on its **WebSDR port (8901)** with the
layout used at SV1BTL's WebSDR (Athens, KM17vx). It is the classic Twente WebSDR interface
restyled by RW3PS, adapted to UberSDR's Opus sound engine, with extras such as:

- a **waterfall** with colours and automatic brightness and contrast;
- a **spectrum** in the PhantomSDR style, either over the waterfall or above it
  ("spectrum + waterfall", the default for first-time visitors);
- **click-to-tune** on the waterfall and the spectrum, rounded to 0.5 kHz;
- **digit tuning** on the frequency display: mouse wheel over a digit, left click up,
  right click down;
- **band buttons** that zoom to the band and follow the frequency;
- **RADE V1** (FreeDV digital voice) with the **RADEL** and **RADEU** mode buttons,
  decoded by UberSDR's own FreeDV extension;
- a **CW decoder** window that opens under the Mode buttons while the mode is CW, using
  UberSDR's own CW decoder;
- **audio tools** that run in the listener's browser: Weak-signal AGC, noise reduction,
  two autonotch filters, squelch, a soft limiter, Hi-Boost, L/R output and WAV recording;
- the **listener's country and city** in the users list, and clicking a listener tunes
  to their frequency and mode;
- works with **DJ0MY's CATSync** (Windows): your own transceiver and the WebSDR follow each
  other's frequency and mode, both ways;
- a **mobile page** (phones are sent there automatically) with the same audio tools and
  S-meter;
- **station labels** on the frequency scale, taken from a simple text file.
- a **chatbox** that works with UberSDR's WebSDR chat. The server keeps the last 20
  messages in memory until it restarts.

UberSDR itself is not modified: the files are mounted into the container, UberSDR
updates do not touch them, and uninstalling brings back UberSDR's own page.

---

## Contents

1. [Requirements](#1-requirements)
2. [Quick install](#2-quick-install)
3. [Your station settings (station.js)](#3-your-station-settings-stationjs)
4. [Station labels (stationinfo.txt)](#4-station-labels-stationinfotxt)
5. [Other things you may want to change](#5-other-things-you-may-want-to-change)
6. [How it works](#6-how-it-works)
7. [After an UberSDR update](#7-after-an-ubersdr-update)
8. [Upgrading to a newer package](#8-upgrading-to-a-newer-package)
9. [Uninstalling](#9-uninstalling)
10. [Manual installation (without install.sh)](#10-manual-installation-without-installsh)
11. [Troubleshooting](#11-troubleshooting)
12. [Settings for advanced users](#12-settings-for-advanced-users)
13. [Credits and licences](#13-credits-and-licences)

---

## 1. Requirements

- A working **UberSDR** installation made with its standard installer (Docker Compose).
  The package expects the usual layout:
  - `~/ubersdr/docker-compose.yml`
  - a service called `ubersdr`
  - a container called `ka9q_ubersdr`

  Other folders and names work too (see below).
- UberSDR's **WebSDR server switched on**. In the admin page, or in `config.yaml`:

  ```yaml
  server:
    enable_websdr: true
    websdr_tcp_port: 8901
  ```

  To check it, open `http://<your-address>:8901/`. You should see UberSDR's own WebSDR
  page before installing.
- `python3` and `docker` on the host. Both are already there on a normal UberSDR machine.
- For the **RADE** buttons (optional): UberSDR's FreeDV extension (standard in current
  UberSDR) and `server.enable_cors: true` in its `config.yaml`. See section 6.
- For the **CW decoder** window (optional): UberSDR's CW decoder extension (`morse`,
  standard in current UberSDR) and the same `enable_cors` setting.

## 2. Quick install

1. **Get the package on the UberSDR machine**, anywhere, for example in your home folder.

   With git:

   ```bash
   git clone https://github.com/sv1btl/WebSDR-emulation-for-UberSDR.git
   cd WebSDR-emulation-for-UberSDR
   ```

   Or without git, download the repository as a ZIP file:

   ```bash
   wget https://github.com/sv1btl/WebSDR-emulation-for-UberSDR/archive/refs/heads/main.zip
   unzip main.zip
   cd WebSDR-emulation-for-UberSDR-main
   ```

   Or download `websdr_sv1btl_package_<date>.tar.gz` from the repository's
   [Releases](https://github.com/sv1btl/WebSDR-emulation-for-UberSDR/releases) page and unpack it with
   `tar xzf websdr_sv1btl_package_*.tar.gz && cd websdr_sv1btl_package`. Check it first
   with `sha256sum -c websdr_sv1btl_package_*.tar.gz.sha256`, using the `.sha256` file
   from the same page.

2. **Run the installer:**

   ```bash
   bash install.sh                  # if UberSDR is in ~/ubersdr
   bash install.sh /path/to/ubersdr # if it is somewhere else
   ```

   The installer does this, and deletes nothing:

   - copies `websdr_sv1btl/` next to UberSDR's `docker-compose.yml`;
   - adds 6 mount lines to the `ubersdr` service in `docker-compose.yml`, after saving a
     backup as `docker-compose.yml.bak.<date>`;
   - reads `websdr_waterfall_calibration` from UberSDR's `config.yaml` and writes it into
     `station.js`;
   - asks before recreating the container. This happens only once, the first time. It
     stops the audio of anyone listening for about 15 seconds, so you can answer **N**
     and run it later with `cd ~/ubersdr && docker compose up -d ubersdr`;
   - runs a check. Every line should say **OK**.

3. **Edit your station settings** in `~/ubersdr/websdr_sv1btl/sv1btl/station.js` (see
   section 3). This needs no restart.

4. **Open `http://<your-address>:8901/`** and press **Ctrl+F5**. Also try the mobile page
   at `/m.html`.

## 3. Your station settings (station.js)

Everything that belongs to your station is in one file:
**`websdr_sv1btl/sv1btl/station.js`**. Open it with any text editor (see
[the note about editors](#editing-files-safely)). Change the values, keeping the quotes
and the comma at the end of each line.

| Setting | Example | What it does |
|---|---|---|
| `callsign` | `'SV1ABC'` | "It is operated by …" in the page header |
| `location` | `'Athens, GR'` | "This is a WebSDR receiver, located in …" |
| `locator` | `'KM17vx'` | Maidenhead locator, shown with a link to a map |
| `email` | `'sv1abc@example.com'` | contact address in the header |
| `mobileTitle` | `'SV1ABC WebSDR Mobile version'` | browser-tab title of the mobile page |
| `startKHz` | `7120` | where a **first-time** visitor starts, in kHz (returning visitors start where they left off) |
| `startMode` | `'LSB'` | mode for that start: `'LSB'`, `'USB'`, `'AM'`, `'CW'` or `'FM'` |
| `waterfallCalibration` | `12` | must equal `websdr_waterfall_calibration` in UberSDR's `config.yaml`; the installer copies it. It sets the dB scale of the spectrum. |
| `mainServer` | `'https://sv1abc.tunnel.ubersdr.org'` | where visitors' browsers reach UberSDR's main web server, for RADE and the CW decoder; the installer fills in UberSDR's public address; `''` means this host on port 8080 |
| `mwStepKHz` | `9` | medium-wave channel step of the >>> / <<< buttons in AM: 9 kHz in Europe, Africa and Asia, `10` in the Americas |
| `showListenerCity` | `true` | `true` gives "GR,Athens" in the users list; `false` gives the country only, "GR" |
| `otherWebSDRs` | `[ 'Twente', 'http://…' ],` | the "Switch to another WebSDR" buttons, up to 6 per row, as many rows as needed |
| `hamBands` | *(commented out)* | your own band-button table (see below); leave it out to use the built-in IARU Region 1 table |

**The band table.** Each line is:

```
[ 'button text', lowest kHz, highest kHz, kHz the button tunes to, 'mode' ],
```

For example `[ '40m', 7000, 7300, 7200, 'LSB' ],` suits Region 2. The range is also used
to highlight the right band button as a listener tunes around, and for the mode given to
listeners who don't send one.

**The desktop page title** (the browser tab) comes from UberSDR itself: its instance name
and location in the admin page. It is not set in `station.js`.

**If you make a typo** in `station.js`, the page still works but shows a red line:
"Station settings not loaded: sv1btl/station.js is missing or has a typo". Press **F12**
in the browser; the console shows the line with the error. Usually it's a missing comma
or quote.

## 4. Station labels (stationinfo.txt)

The labels on the frequency scale (broadcast stations, FT8, beacons…) come from
**`websdr_sv1btl/sv1btl/stationinfo.txt`**. There's one label per line:

```
<frequency in kHz><mode> <text>
```

```
7074usb FT8
10136usb FT8
729am ERT Athens
14100cw NCDXF beacons
```

- `mode` is one of `am`, `fm`, `usb`, `lsb` or `cw`. Clicking the label tunes there in
  that mode.
- Lines starting with `#` are comments.
- `<br>` in the text starts a second line.

The file in the package is SV1BTL's list, with time signals and broadcasters heard in
Europe and some local Athens stations. Replace or edit it for your area. The page reads
it again on each band or zoom change, so after editing just reload the page.

## 5. Other things you may want to change

These are in the HTML files. They're optional.

| What | Where |
|---|---|
| receiverbook.de registration | `websdr-head.html`, line 1: paste the `<meta name="receiverbook-confirmation" …>` line that receiverbook gives you |
| "Equipment" box (hidden by default) and the picture `sv1btl/setup_bw.gif` | `websdr-controls.html`, search for `equip_info` |
| Page background images | `sv1btl/bg6.jpg` (desktop), `sv1btl/aluminium.jpg` (mobile): replace them with images of the same name |
| Favicon | `sv1btl/favicon.ico` / `favicon.png` |
| The browser-autoplay guide linked in the header | `sv1btl/guide/guide.html` |

Please keep the credit line: "a layout based on RW3PS's template … modified by SV1BTL".

## 6. How it works

UberSDR builds its WebSDR page (port 8901) from files in the container's `/app/websdr/`
folder. The package **mounts** five of those files, plus one folder of its own, from
`~/ubersdr/websdr_sv1btl/`:

```
websdr_sv1btl/websdr-head.html      → the page <head>: styles, scripts
websdr_sv1btl/websdr-controls.html  → the desktop page body (RW3PS layout)
websdr_sv1btl/websdr-base.js        → the page logic (Twente WebSDR, RW3PS changes)
websdr_sv1btl/m.html                → the mobile page
websdr_sv1btl/mobile-controls.html  → the mobile page body
websdr_sv1btl/sv1btl/               → everything else, served as /sv1btl/…:
    station.js          your settings
    stationinfo.txt     your labels
    ubersdr-compat.js   the glue to UberSDR, plus all the extras (audio tools,
                        spectrum, waterfall brightness, tuning…)
    websdr-nr.js        noise-reduction engine
    images, fonts, less.js, jQuery, guide/
```

UberSDR's own `websdr-sound.js` (Opus audio) and `websdr-waterfall.js` are **not**
replaced. `ubersdr-compat.js` hooks into them, which is why the check script verifies
they still have what it needs after an UberSDR update.

### Editing files safely

The five single files are "bind-mounted": the container keeps using the exact file it
started with. When you edit one:

- **Editors that save into the same file** (nano, `cat > file`, most GUI editors) make
  the change live **at once**, with no restart.
- **Editors or tools that replace the file** (some vim settings, `sed -i`, copying a new
  file over it) are **not** seen until the container restarts:
  `docker restart ka9q_ubersdr`. A restart stops listeners' audio for about 15 seconds.
- Files inside the `sv1btl/` folder (including `station.js`) are always seen at once.

Browsers keep scripts in their cache. After editing a `.js` file, press **Ctrl+F5**. To
make every visitor's browser fetch a changed `ubersdr-compat.js`, raise the `?v=…`
number after `ubersdr-compat.js` in both `websdr-head.html` and `mobile-controls.html`.

### RADE (FreeDV digital voice)

The **RADEL** and **RADEU** buttons in the Mode row decode RADE V1 on the lower or upper
sideband, with a 700–2200 Hz passband (1500 Hz, the width of a RADE signal; the
**1.50 kHz** filter button, first in the LSB and USB filter presets, lights up). Pressing
the lit button again, or any other mode button, switches it off.

UberSDR decodes RADE on the server, with its FreeDV extension (`freedv-ka9q`). That
extension can only work on a session of UberSDR's own interface, not on a WebSDR
(port 8901) one. So when a listener presses RADEL or RADEU, their browser:

1. registers a session with UberSDR's main web server (`mainServer` in `station.js`);
2. opens an audio session there on the same frequency in LSB or USB, muted, so no audio
   is sent back for it;
3. asks UberSDR to start the FreeDV decoder on it, and plays the decoded voice through
   the page's volume, Hi-Boost, notch and NR, while the normal audio is silenced.

Tuning on the page is followed. A status line under the Mode row shows "waiting for a
RADE signal…" or "decoding", and the lit button turns green while voice is decoded.

Below it, a small **FreeDV Reporter** window lists the stations reported to FreeDV
Reporter on the band you are on, as in UberSDR's own FreeDV panel: callsign, country,
distance, frequency (a green dot when you are on it), message, TX and last RX. Stations
transmitting now come first (red TX badge), then those that transmitted most recently;
the TX column shows how long ago ("3m", "2h"). Clicking a station tunes to it. The
window shows four rows at a time and scrolls for more.

On the **mobile page**, RADEL and RADEU are at the end of the mode list, with the same
status line under the buttons (the reporter window is on the desktop page only).

Things to know:

- **Your visitors must be able to reach `mainServer`.** The installer fills in the
  public address from UberSDR's instance settings (for example a `…tunnel.ubersdr.org`
  address). Without one, the page uses port 8080 of the same host; forward that port too
  in that case.
- **`server.enable_cors: true`** must be set in UberSDR's `config.yaml`, because the page
  (port 8901) contacts another address. The installer warns if it is off.
- **Each RADE listener uses one more UberSDR session** and one FreeDV decoder
  (`freedv_extension.max_users` in `config.yaml`, 15 by default).
- The decoder reads the sideband when it starts, so switching between RADEL and RADEU
  restarts it. UberSDR allows one restart every 2 seconds; the page waits and retries.

### CW decoder

While the mode is **CW** (the CW button, CW narrow or wide, a keyboard key or CAT
software), a window opens under the Mode buttons with the text decoded by UberSDR's own
CW decoder (the `morse` extension, ggmorse: it finds the pitch and the speed by itself).
It shows the pitch, the speed in WPM and the decode quality; text decoded poorly is
coloured yellow, orange or red, and the list box hides text below the quality you choose.
**Clear** empties the window. Choosing another mode closes the window.

It works like RADE: the listener's browser opens a muted session on UberSDR's main web
server (`mainServer`), with the same frequency and passband as the page, and attaches
the decoder to it. The page's own audio is not changed. Things to know:

- It needs the same `mainServer` and `server.enable_cors: true` as RADE.
- **Each listener with the CW window open uses one more UberSDR session** and one CW
  decoder.
- It decodes what passes the page's filter, so tune the signal into the passband (the
  yellow band). If UberSDR cannot be reached, the window says so and tries again every
  20 seconds.
- Desktop page only.

### What listeners' browsers contact

- Your UberSDR (port 8901): the page, audio and waterfall.
- Your UberSDR's main web server (`mainServer`), only while RADE is on or the mode is CW.
- `get.geojs.io`, or `ipwho.is` as a fallback, once a day per visitor. This finds the
  visitor's own country and city for the users list. Nothing is sent to it except the
  normal web request. To switch it off, see section 12.

## 7. After an UberSDR update

UberSDR's updater only *adds* missing services to `docker-compose.yml` and never changes
the `ubersdr` service, so the mount lines stay. After each update, run:

```bash
bash ~/ubersdr/websdr_sv1btl/check-after-update.sh
```

- **Every line says OK:** everything is in place.
- **A FAIL line:** it says what is wrong. The usual case is missing mount lines; the
  line to copy is in `compose-mounts.txt` in the package. The other is
  "`websdr-sound.js` changed shape", meaning a new UberSDR version renamed something the
  audio extras rely on. The page still plays; please report it at
  https://github.com/sv1btl/WebSDR-emulation-for-UberSDR/issues.

If your UberSDR is not in `~/ubersdr`, or the container has another name:

```bash
UBERSDR_DIR=/path/to/ubersdr CONTAINER=my_container URL=http://localhost:8901 \
  bash /path/to/ubersdr/websdr_sv1btl/check-after-update.sh
```

## 8. Upgrading to a newer package

Get the new version and run its `install.sh` again:

```bash
cd WebSDR-emulation-for-UberSDR   # the folder you cloned
git pull
bash install.sh
```

(Without git, download and unpack the new ZIP or release archive, and run its
`install.sh`.) The installer:

- saves the whole current folder as `websdr_sv1btl.bak.<date>`;
- writes the new files **in place**, so they are live at once with no restart;
- **keeps your `station.js` and `stationinfo.txt`**, and adds to your `station.js` any
  settings that are new in this version (with their explanation and default value; your
  own values are not changed). It lists the settings it added.

## 9. Uninstalling

```bash
bash uninstall.sh                  # or: bash uninstall.sh /path/to/ubersdr
```

This removes the 6 mount lines (the old file is kept as `docker-compose.yml.bak.<date>`)
and, after asking, recreates the container. UberSDR's own WebSDR page is back.
`~/ubersdr/websdr_sv1btl/` stays; delete it by hand if you want.

## 10. Manual installation (without install.sh)

1. Copy the `websdr_sv1btl` folder next to `docker-compose.yml`, for example to
   `~/ubersdr/websdr_sv1btl`.
2. In `docker-compose.yml`, under `services:` → `ubersdr:` → `volumes:`, add the 6
   lines from `compose-mounts.txt`, indented like the lines already there.
3. Set `waterfallCalibration` in `sv1btl/station.js` to the value of
   `websdr_waterfall_calibration` in UberSDR's config:

   ```bash
   docker exec ka9q_ubersdr grep websdr_waterfall_calibration /app/config/config.yaml
   ```

4. Apply it with `cd ~/ubersdr && docker compose up -d ubersdr`.
5. Check it with `bash ~/ubersdr/websdr_sv1btl/check-after-update.sh`.

## 11. Troubleshooting

| Problem | Cause and fix |
|---|---|
| Port 8901 shows UberSDR's own page, not this layout | The mounts aren't active: run `docker compose up -d ubersdr` in the UberSDR folder, then the check script. |
| The check says "http://localhost:… does not answer" (older versions: many FAIL lines with `HTTP 000`) | UberSDR was still starting, the WebSDR server is off, or the port is published under another number. Wait a minute and run the check again; see `docker port ka9q_ubersdr`; for another port run `URL=http://localhost:<port> bash ~/ubersdr/websdr_sv1btl/check-after-update.sh`. The installation itself is fine if sections 1 and 2 say OK. |
| Port 8901 doesn't answer at all | `enable_websdr` is off, or the port isn't published/forwarded. Check `config.yaml` and the `ports:` of the `ubersdr` service (`8901:8901`). |
| Red "Station settings not loaded" line | A typo in `station.js` (section 3). |
| The header still says "N0CALL / Your City" | `station.js` wasn't edited, or the browser cached the old one: press Ctrl+F5. |
| An edit to an HTML file doesn't show | The file was *replaced*, not saved in place (section 6): run `docker restart ka9q_ubersdr`. |
| The spectrum's dB numbers look wrong | `waterfallCalibration` in `station.js` doesn't match `websdr_waterfall_calibration` in `config.yaml`. |
| No sound until clicking | Browsers need one click before playing audio; the page shows a "start audio" button. The header links a guide for allowing autoplay. |
| Phones don't get the mobile page | Open `/m.html?mobile` once; that clears a saved "desktop version" choice. |
| Audio or extras stopped after an UberSDR update | Run the check script (section 7). |
| RADE says "RADE unavailable: cannot reach …" | `mainServer` in `station.js` is wrong or not reachable from outside, or `server.enable_cors` is off (section 6). |
| RADE stays on "waiting for a RADE signal…" | Nobody is transmitting RADE there right now. Common RADE frequencies: 7177 kHz LSB, 14236 kHz USB. |
| Something else | Open the page with `?ubersdr_debug` at the end of the address (`http://…:8901/?ubersdr_debug`). Script errors then appear in a red panel at the bottom; please include them in a report at [github.com/sv1btl/WebSDR-emulation-for-UberSDR/issues](https://github.com/sv1btl/WebSDR-emulation-for-UberSDR/issues). |

## 12. Settings for advanced users

These constants are near the top of their sections in `sv1btl/ubersdr-compat.js`. After
editing, raise the `?v=` number (see section 6).

| Constant | Default | Meaning |
|---|---|---|
| `WAGC_TARGET_DB`, `WAGC_MAX_DB`, `WAGC_NOISE_MAX_DB` | −20, 15, 3 | Weak-signal AGC: target level (dBFS), most boost with a signal, most boost on an empty channel |
| `WAGC_HANG_S`, `WAGC_RELEASE_DBS` | 2, 4 | Weak-signal AGC hang time and release speed |
| `NR_MULT`, `NR_FLOOR` | per level | noise-reduction strength, and how far noise is turned down: −9/−14/−18/−23 dB for Low/Medium/High/Strong |
| `SQL_OPEN_DB`, `SQL_CLOSE_DB`, `SQL_HANG_S` | 8, 4, 0.6 | squelch: opens this many dB above the noise |
| `LIM_CEIL`, `LIM_KNEE` | 0.7, 0.8 | soft limiter |
| `WF_NOISE_T`, `WF_SIG_T`, `WF_GRAIN_MAX` | 0.10, 0.70, 0.22 | auto brightness: where the noise floor and strong signals sit in the colour scale |
| `WFTYPE_DEFAULT` | `'2'` | first-visit waterfall type: 0 spectrum, 1 waterfall, 2 spectrum + waterfall |
| `GEO_SERVICES` | geojs.io, ipwho.is | location lookup; set it to `[]` to switch the location in the users list off |
| `SPEC_RANGE_DB` | 70 | spectrum height in dB |

## 13. Credits and licences

- **WebSDR** client pages and scripts (`websdr-base.js`, the mobile page), © 2007–2014
  Pieter-Tjerk de Boer, PA3FWM — [websdr.org](http://www.websdr.org). They are served by
  UberSDR's WebSDR emulation, as they are on every WebSDR.
- **RW3PS**'s WebSDR template: layout, styles and the waterfall colour map.
- **UberSDR** by madpsy — [github.com/madpsy/ka9q_ubersdr](https://github.com/madpsy/ka9q_ubersdr).
- **websdr-nr.js** noise reduction © 2026 joshuah.rainstar@gmail.com. MIT terms, with a
  caveat in its header about **commercial use**; read the header before using it on a
  paid service. SV1BTL added a residual floor (`setFloor`).
- **jQuery 3.1.1** (MIT), **Less.js 3.12** (Apache 2.0), **Roboto Condensed** font
  (Apache 2.0).
- **DS-Digital** font (`sv1btl/DS-DIGII.TTF`, the frequency display) © Dusit Supasawat,
  "All Rights Reserved". It is usually free for personal use only. If that is a concern
  for your station, replace it with another digital-style font of the same file name.
- The **spectrum** is drawn after the style of PhantomSDR-Plus.
- Adaptation to UberSDR, the audio tools, spectrum, tuning features, installer and this
  guide: **SV1BTL** (2026).

SV1BTL's own work in this package is released under the **MIT licence** (see `LICENSE`).
The third-party parts listed above keep their own terms; `LICENSE` lists them too.

Questions and problem reports: https://github.com/sv1btl/WebSDR-emulation-for-UberSDR/issues
