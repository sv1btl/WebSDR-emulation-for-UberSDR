#!/bin/bash
# install.sh — install (or upgrade) the SV1BTL WebSDR layout on an UberSDR station.
#
#   bash install.sh                  # UberSDR in ~/ubersdr (the usual place)
#   bash install.sh /path/to/ubersdr # UberSDR somewhere else
#
# What it does (nothing is deleted; every file it changes is backed up first):
#   1. copies websdr_sv1btl/ next to UberSDR's docker-compose.yml
#      (upgrade: keeps your sv1btl/station.js and sv1btl/stationinfo.txt)
#   2. adds 6 mount lines to the "ubersdr" service in docker-compose.yml
#   3. copies the waterfall calibration from UberSDR's config into station.js
#   4. applies it (asks first: recreating the container cuts listeners' audio ~15 s)
#   5. runs the check script
set -u

PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
UBERSDR_DIR="${1:-${UBERSDR_DIR:-$HOME/ubersdr}}"
UBERSDR_DIR="$(cd "$UBERSDR_DIR" 2>/dev/null && pwd)" || { echo "ERROR: folder not found: ${1:-$HOME/ubersdr}"; exit 1; }
COMPOSE="$UBERSDR_DIR/docker-compose.yml"
TARGET="$UBERSDR_DIR/websdr_sv1btl"
SRC="$PKG_DIR/websdr_sv1btl"
TS="$(date +%Y%m%d_%H%M%S)"
ROOT_FILES="websdr-head.html websdr-controls.html websdr-base.js m.html mobile-controls.html"

say()  { echo; echo "== $*"; }
die()  { echo "ERROR: $*"; exit 1; }

[ -f "$COMPOSE" ] || die "no docker-compose.yml in $UBERSDR_DIR (give the UberSDR folder as the first argument)"
[ -d "$SRC" ]     || die "run this from the unpacked package (websdr_sv1btl/ not found next to install.sh)"
command -v python3 >/dev/null || die "python3 is needed (sudo apt install python3)"
command -v docker  >/dev/null || die "docker is needed"

# ── The UberSDR service and its container ────────────────────────────────────
CONTAINER="$(python3 - "$COMPOSE" <<'EOF'
import re, sys
lines = open(sys.argv[1]).read().split('\n')
svc, name = None, None
for l in lines:
    m = re.match(r'^  ([A-Za-z0-9_.-]+):\s*$', l)
    if m: svc = m.group(1); continue
    m = re.match(r'^    container_name:\s*["\']?([^"\'\s#]+)', l)
    if m and svc == 'ubersdr': name = m.group(1)
print(name or 'ka9q_ubersdr')
EOF
)"
say "UberSDR folder: $UBERSDR_DIR   container: $CONTAINER"
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || echo "   (note: container $CONTAINER is not running right now)"

# ── UberSDR settings the layout depends on ───────────────────────────────────
CFG="$(docker exec "$CONTAINER" cat /app/config/config.yaml 2>/dev/null || true)"
WEBSDR_ON="$(echo "$CFG" | sed -n 's/^\s*enable_websdr:\s*\([a-z]*\).*/\1/p' | head -1)"
CAL="$(echo "$CFG" | sed -n 's/^\s*websdr_waterfall_calibration:\s*\(-\?[0-9.]*\).*/\1/p' | head -1)"
PORT="$(echo "$CFG" | sed -n 's/^\s*websdr_tcp_port:\s*\([0-9]*\).*/\1/p' | head -1)"
PORT="${PORT:-8901}"
if [ -z "$CFG" ]; then
    echo "   could not read UberSDR's config.yaml (container not running?); check the settings in the guide by hand"
elif [ "$WEBSDR_ON" != "true" ]; then
    echo "   WARNING: enable_websdr is not true in UberSDR's config.yaml; turn on the WebSDR server"
    echo "            (admin page, or config.yaml: server.enable_websdr: true) or this page is never served"
fi

# ── 1. Copy the files ────────────────────────────────────────────────────────
if [ -d "$TARGET" ]; then
    say "Upgrading $TARGET (backup: websdr_sv1btl.bak.$TS)"
    cp -a "$TARGET" "$UBERSDR_DIR/websdr_sv1btl.bak.$TS" || die "backup failed"
    # Write every file IN PLACE: the running container holds the old files open by
    # inode, so replacing (moving) them would not be seen until a restart.
    for f in $ROOT_FILES check-after-update.sh; do cat "$SRC/$f" > "$TARGET/$f" || die "cannot write $TARGET/$f"; done
    mkdir -p "$TARGET/sv1btl"
    ( cd "$SRC/sv1btl" && find . -type d ) | while read -r d; do mkdir -p "$TARGET/sv1btl/$d"; done
    ( cd "$SRC/sv1btl" && find . -type f ) | while read -r f; do
        case "$f" in ./station.js|./stationinfo.txt) [ -f "$TARGET/sv1btl/$f" ] && continue ;; esac
        cat "$SRC/sv1btl/$f" > "$TARGET/sv1btl/$f" || die "cannot write $TARGET/sv1btl/$f"
    done
    echo "   kept your sv1btl/station.js and sv1btl/stationinfo.txt"
else
    say "Copying the layout to $TARGET"
    cp -a "$SRC" "$TARGET" || die "copy failed"
fi
chmod +x "$TARGET/check-after-update.sh" 2>/dev/null

# ── 2. Waterfall calibration → station.js ────────────────────────────────────
if [ -n "$CAL" ]; then
    python3 - "$TARGET/sv1btl/station.js" "$CAL" <<'EOF'
import re, sys
p, cal = sys.argv[1], sys.argv[2]
s = open(p).read()
n = re.sub(r'(waterfallCalibration:\s*)-?[0-9.]+', lambda m: m.group(1) + cal, s, count=1)
if n != s:
    open(p, 'w').write(n)     # same file (inode) — the container sees it at once
EOF
    say "Waterfall calibration from UberSDR's config: $CAL (written to station.js)"
fi

# ── 3. Mount lines in docker-compose.yml ─────────────────────────────────────
ADDED="$(python3 - "$COMPOSE" "$TS" <<'EOF'
import re, shutil, sys
path, ts = sys.argv[1], sys.argv[2]
want = ['./websdr_sv1btl/%s:/app/websdr/%s' % (f, f) for f in
        ['websdr-head.html', 'websdr-controls.html', 'websdr-base.js', 'm.html', 'mobile-controls.html', 'sv1btl']]
lines = open(path).read().split('\n')
# the "ubersdr" service block and its volumes: list
start = next((i for i, l in enumerate(lines) if re.match(r'^  ubersdr:\s*$', l)), None)
if start is None:
    print('NOSERVICE'); sys.exit()
end = next((i for i in range(start + 1, len(lines)) if re.match(r'^  \S', lines[i]) or re.match(r'^\S', lines[i])), len(lines))
vol = next((i for i in range(start + 1, end) if re.match(r'^    volumes:\s*$', lines[i])), None)
present = [w for w in want if any(l.strip().lstrip('- ').strip() == w for l in lines[start:end])]
missing = [w for w in want if w not in present]
if not missing:
    print('PRESENT'); sys.exit()
shutil.copy2(path, path + '.bak.' + ts)
note = '      # SV1BTL WebSDR layout on the WebSDR port (installed by websdr_sv1btl install.sh)'
if vol is None:                      # no volumes: list yet — add one at the end of the service
    ins = end
    while ins > start and lines[ins - 1].strip() == '':
        ins -= 1
    new = ['    volumes:', note] + ['      - ' + w for w in missing]
else:                                # after the last entry of the existing list
    ins, i = vol + 1, vol + 1
    while i < end and (re.match(r'^      - ', lines[i]) or re.match(r'^\s*#', lines[i]) or lines[i].strip() == ''):
        if re.match(r'^      - ', lines[i]):
            ins = i + 1
        i += 1
    new = [note] + ['      - ' + w for w in missing]
lines[ins:ins] = new
with open(path, 'w') as f:
    f.write('\n'.join(lines))
print('ADDED %d' % len(missing))
EOF
)"
case "$ADDED" in
    PRESENT)   say "docker-compose.yml already has the 6 mount lines" ;;
    NOSERVICE) die "no \"ubersdr:\" service found in $COMPOSE — add the lines from compose-mounts.txt by hand" ;;
    ADDED*)    say "docker-compose.yml: ${ADDED#ADDED } mount line(s) added (backup: docker-compose.yml.bak.$TS)" ;;
    *)         die "could not edit docker-compose.yml: $ADDED" ;;
esac

# ── 4. Apply ─────────────────────────────────────────────────────────────────
NEED_UP=0
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    n=$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' | grep -c "/websdr_sv1btl/")
    [ "$n" -eq 6 ] || NEED_UP=1
else
    NEED_UP=1
fi
if [ "$NEED_UP" -eq 1 ]; then
    say "The container must be recreated once to pick up the mounts."
    echo "   This cuts the audio of anyone listening for about 15 seconds."
    read -r -p "   Do it now? [y/N] " a
    if [ "$a" = "y" ] || [ "$a" = "Y" ]; then
        ( cd "$UBERSDR_DIR" && docker compose up -d ubersdr ) || die "docker compose up failed"
        echo "   waiting for UberSDR to start…"; sleep 20
    else
        echo "   Later, run:  cd $UBERSDR_DIR && docker compose up -d ubersdr"
        exit 0
    fi
else
    say "Mounts already active: the new files are live now (no restart needed)"
fi

# ── 5. Check ─────────────────────────────────────────────────────────────────
say "Checking"
UBERSDR_DIR="$UBERSDR_DIR" CONTAINER="$CONTAINER" URL="http://localhost:$PORT" bash "$TARGET/check-after-update.sh"
echo
echo "Next: edit $TARGET/sv1btl/station.js (your callsign, location, …),"
echo "then open http://<your-address>:$PORT/ and press Ctrl+F5."
