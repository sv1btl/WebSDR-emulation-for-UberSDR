#!/bin/bash
# check-after-update.sh — run after an UberSDR update to confirm the SV1BTL WebSDR
# layout (RW3PS-based, on port 8901) is still mounted and that UberSDR's own scripts
# still have everything sv1btl/ubersdr-compat.js hooks into.
#
#   bash ~/ubersdr/websdr_sv1btl/check-after-update.sh
#
# Exit code 0 = all OK, 1 = something needs attention (each problem is listed).

UBERSDR_DIR="${UBERSDR_DIR:-$HOME/ubersdr}"      # override: UBERSDR_DIR=/path bash check-after-update.sh
DIR="$UBERSDR_DIR/websdr_sv1btl"
COMPOSE="$UBERSDR_DIR/docker-compose.yml"
CONTAINER="${CONTAINER:-ka9q_ubersdr}"
URL="${URL:-http://localhost:8901}"
FILES="websdr-head.html websdr-controls.html websdr-base.js m.html mobile-controls.html sv1btl"

problems=0
ok()   { echo "  OK    $*"; }
warn() { echo "  FAIL  $*"; problems=$((problems + 1)); }

echo "1. docker-compose.yml mounts"
for f in $FILES; do
    if grep -q "^ *- \./websdr_sv1btl/$f:/app/websdr/$f *$" "$COMPOSE"; then ok "$f"
    else warn "$f is not mounted in $COMPOSE — copy the lines from docker-compose.yml.bak.with-sv1btl"; fi
    [ -e "$DIR/$f" ] || warn "$DIR/$f is missing — restore it from the websdr_sv1btl.bak.* folder"
done

echo "2. Running container"
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    warn "$CONTAINER is not running"
else
    mounts=$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}')
    n=$(echo "$mounts" | grep -c "/websdr_sv1btl/")
    if [ "$n" -eq 6 ]; then ok "all 6 mounts active"
    else warn "$n of 6 mounts active — run: cd ~/ubersdr && docker compose up -d ubersdr"; fi
    if docker logs "$CONTAINER" 2>&1 | grep -q "WebSDR: .* not patched"; then
        warn "UberSDR reports a WebSDR file it could not patch (docker logs $CONTAINER | grep 'not patched')"
    else ok "no 'not patched' warnings from UberSDR"; fi
fi

echo "3. Pages served"
page=$(curl -s "$URL/")
echo "$page" | grep -q "sv1btl/ubersdr-compat.js" && ok "desktop page uses the SV1BTL layout" || warn "desktop page is not the SV1BTL layout"
curl -s "$URL/m.html" | grep -q "ubersdr_mobile_audio_start" && ok "mobile page uses the SV1BTL layout" || warn "mobile page is not the SV1BTL layout"
for p in sv1btl/ubersdr-compat.js sv1btl/stationinfo.txt sv1btl/websdr-nr.js tmp/bandinfo.js; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/$p")
    [ "$code" = 200 ] && ok "$p" || warn "$p returns HTTP $code"
done

echo "4. UberSDR sound player still has what ubersdr-compat.js hooks into"
sound=$(curl -s "$URL/websdr-sound.js")
for name in "prototype._connect" "prototype._onMessage" "prototype._ensureAudio" "prototype._playDecoded" "prototype.setparam" \
            "prototype.getid" "_audioCtx" "_gainNode" "_nextPlayTime" "_basebandPower" "_decoderSR" \
            "HEADER_SIZE      = 21" "getFloat32(13, true)" "window.prep_html5sound"; do
    echo "$sound" | grep -qF "$name" && ok "$name" || warn "$name not found in websdr-sound.js — some extras (notch, NR, gain, squelch, recording) may stop working"
done

echo "5. Waterfall and page script"
curl -s "$URL/websdr-waterfall.js" | grep -q "putImageData" && ok "websdr-waterfall.js served" || warn "websdr-waterfall.js changed shape"
curl -s "$URL/websdr-base.js" | grep -q "var waterslowness=1;" && ok "UberSDR still patches websdr-base.js (fast waterfall)" || warn "websdr-base.js not patched by UberSDR (waterfall may default to slow)"

echo
if [ "$problems" -eq 0 ]; then
    echo "All checks passed. Also open $URL/?ubersdr_debug, start audio, try a band button,"
    echo "noise reduction and a notch: any browser error shows in a red panel at the bottom."
    exit 0
else
    echo "$problems problem(s) found — see FAIL lines above."
    exit 1
fi
