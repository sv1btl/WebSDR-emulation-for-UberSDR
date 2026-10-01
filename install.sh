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
# Run with sudo, ~ would be root's home: use the home of the user who ran sudo
USER_HOME="$HOME"
if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then USER_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"; fi
UBERSDR_DIR="${1:-${UBERSDR_DIR:-$USER_HOME/ubersdr}}"
UBERSDR_DIR="$(cd "$UBERSDR_DIR" 2>/dev/null && pwd)" || { echo "ERROR: folder not found: ${1:-$USER_HOME/ubersdr} (give the UberSDR folder as the first argument)"; exit 1; }
COMPOSE="$UBERSDR_DIR/docker-compose.yml"
for c in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do   # the first one that exists
    [ -f "$UBERSDR_DIR/$c" ] && { COMPOSE="$UBERSDR_DIR/$c"; break; }
done
TARGET="$UBERSDR_DIR/websdr_sv1btl"
SRC="$PKG_DIR/websdr_sv1btl"
TS="$(date +%Y%m%d_%H%M%S)"
ROOT_FILES="websdr-head.html websdr-controls.html websdr-base.js m.html mobile-controls.html"

say()  { echo; echo "== $*"; }
die()  { echo "ERROR: $*"; exit 1; }

[ -f "$COMPOSE" ] || die "no docker-compose.yml (or compose.yml) in $UBERSDR_DIR (give the UberSDR folder as the first argument)"
[ -d "$SRC" ]     || die "run this from the unpacked package (websdr_sv1btl/ not found next to install.sh)"
command -v python3 >/dev/null || die "python3 is needed (sudo apt install python3)"
command -v docker  >/dev/null || die "docker is needed"
docker info >/dev/null 2>&1 || die "cannot use Docker as $(id -un): add yourself to the docker group (sudo usermod -aG docker $(id -un), then log in again) or run: sudo bash $0 $UBERSDR_DIR"
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null; then DC="docker-compose"
else die "neither 'docker compose' nor 'docker-compose' is available"; fi

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
# values may be written with or without quotes
WEBSDR_ON="$(echo "$CFG" | sed -n "s/^\s*enable_websdr:\s*[\"']*\([a-z]*\).*/\1/p" | head -1)"
CAL="$(echo "$CFG" | sed -n "s/^\s*websdr_waterfall_calibration:\s*[\"']*\(-\?[0-9.]*\).*/\1/p" | head -1)"
PORT="$(echo "$CFG" | sed -n "s/^\s*websdr_tcp_port:\s*[\"']*\([0-9]*\).*/\1/p" | head -1)"
PORT="${PORT:-8901}"
if [ -z "$CFG" ]; then
    echo "   could not read UberSDR's config.yaml (container not running?); check the settings in the guide by hand"
elif [ "$WEBSDR_ON" != "true" ]; then
    echo "   WARNING: enable_websdr is not true in UberSDR's config.yaml; turn on the WebSDR server"
    echo "            (admin page, or config.yaml: server.enable_websdr: true) or this page is never served"
fi

# ── 1. Copy the files ────────────────────────────────────────────────────────
# If the mounts were added and the container started before the files existed, Docker
# created empty folders in their place: they must go before the files can be copied
for f in $ROOT_FILES; do
    if [ -d "$TARGET/$f" ]; then
        die "$TARGET/$f is a folder (Docker made it because the file was missing when the container started).
       Remove those empty folders, then run this again:
         cd $UBERSDR_DIR && $DC stop ubersdr && rmdir websdr_sv1btl/{websdr-head.html,websdr-controls.html,websdr-base.js,m.html,mobile-controls.html} 2>/dev/null; bash $0 $UBERSDR_DIR"
    fi
done
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
    mkdir -p "$TARGET" && cp -a "$SRC"/. "$TARGET"/ || die "copy failed"
fi
chmod +x "$TARGET/check-after-update.sh" 2>/dev/null
# Run with sudo: give the files to the owner of docker-compose.yml, not to root
if [ "$(id -u)" = 0 ]; then chown -R --reference="$COMPOSE" "$TARGET" 2>/dev/null; fi

# ── Settings added in newer versions → your station.js (your values are kept) ──
python3 - "$SRC/sv1btl/station.js" "$TARGET/sv1btl/station.js" <<'EOF3'
import re, sys
tpl_path, cur_path = sys.argv[1], sys.argv[2]
tpl = open(tpl_path, encoding='utf-8').read().split('\n')
try:
    cur_text = open(cur_path, encoding='utf-8').read()
except OSError:
    sys.exit()
if cur_text == open(tpl_path, encoding='utf-8').read():
    sys.exit()
KEY = re.compile(r'^  ([A-Za-z_][A-Za-z0-9_]*)\s*:')
def blocks(lines):
    """[(key, [lines])] for the settings in a station.js, each with the comment lines
    above it; a setting ends when its brackets are balanced again."""
    out, pending, i = [], [], 0
    while i < len(lines) and 'window.STATION' not in lines[i]:
        i += 1
    i += 1
    while i < len(lines):
        l = lines[i]
        if l.startswith('};'):
            break
        m = KEY.match(l)
        if not m:
            pending.append(l); i += 1; continue
        block, depth = pending + [l], l.count('[') + l.count('{') - l.count(']') - l.count('}')
        while depth > 0 and i + 1 < len(lines):
            i += 1; block.append(lines[i])
            depth += lines[i].count('[') + lines[i].count('{') - lines[i].count(']') - lines[i].count('}')
        out.append((m.group(1), block)); pending = []; i += 1
    return out
have = set(re.findall(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:', cur_text, re.M))
add = [(k, b) for k, b in blocks(tpl) if k not in have and k != '_end']
if not add:
    sys.exit()
cur = cur_text.split('\n')
at = next((i for i, l in enumerate(cur) if re.match(r'^\s*_end\s*:', l)), None)
if at is None:
    at = next((i for i in range(len(cur) - 1, -1, -1) if cur[i].startswith('};')), None)
if at is None:
    print('   NOTE: could not add new settings to station.js (unusual layout); compare it with the package')
    sys.exit()
# inserting before "};" (no _end line): the setting above needs its comma
if not re.match(r'^\s*_end\s*:', cur[at]):
    j = at - 1
    while j >= 0 and (cur[j].strip() == '' or cur[j].strip().startswith('//')):
        j -= 1
    if j >= 0 and not cur[j].rstrip().endswith((',', '{')):
        code, sep, comment = cur[j].partition('//')
        if "'" not in comment and '"' not in comment:
            cur[j] = code.rstrip() + ',' + (' ' + sep + comment if sep else '')
        else:
            cur[j] = cur[j].rstrip() + ','
new = []
for k, b in add:
    while b and b[0].strip() == '' and new and new[-1].strip() == '':
        b = b[1:]
    new += b + ['']
cur[at:at] = new
open(cur_path, 'w', encoding='utf-8').write('\n'.join(cur))   # same file (inode): live at once
print('   added to your station.js (new in this version): ' + ', '.join(k for k, _ in add))
EOF3

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

# ── RADE: UberSDR's public main-server address → station.js (mainServer) ───────
if [ -n "$CFG" ]; then
    MAINURL="$(echo "$CFG" | python3 -c '
import re, sys
t = sys.stdin.read()
m = re.search(r"^instance_reporting:\s*\n((?:[ \t].*\n|\s*\n)*)", t, re.M)
b = m.group(1) if m else ""
i = re.search(r"^  instance:\s*\n((?:    .*\n)*)", b, re.M)
ib = i.group(1) if i else ""
h = re.search(r"^\s*host:\s*\"?([^\"\s#]+)", ib, re.M)
p = re.search(r"^\s*port:\s*(\d+)", ib, re.M)
tls = re.search(r"^\s*tls:\s*(true|false)", ib, re.M)
if h and h.group(1) not in ("", "localhost"):
    https = bool(tls and tls.group(1) == "true")
    port = p.group(1) if p else ("443" if https else "80")
    default = (https and port == "443") or (not https and port == "80")
    print(("https" if https else "http") + "://" + h.group(1) + ("" if default else ":" + port))
')"
    CORS="$(echo "$CFG" | sed -n "s/^\s*enable_cors:\s*[\"']*\([a-z]*\).*/\1/p" | head -1)"
    if [ -n "$MAINURL" ]; then
        python3 - "$TARGET/sv1btl/station.js" "$MAINURL" <<'EOF2'
import re, sys
p, url = sys.argv[1], sys.argv[2]
s = open(p).read()
n = re.sub(r"(mainServer:\s*)'[^']*'", lambda m: m.group(1) + "'" + url + "'", s, count=1)
if n != s and re.search(r"mainServer:\s*''", s):      # only fill an empty setting
    open(p, 'w').write(n)
EOF2
        say "RADE: UberSDR's public address $MAINURL (mainServer in station.js, if it was empty)"
    else
        say "RADE: no public UberSDR address in its config; the page will use port 8080 of this host"
        echo "   (set mainServer in station.js if your visitors reach UberSDR another way)"
    fi
    [ "$CORS" = "true" ] || echo "   WARNING: server.enable_cors is not true in UberSDR's config.yaml; the RADE buttons need it"
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
# the service ends at the next service ("  name:") or top-level key; comment lines do not end it
end = next((i for i in range(start + 1, len(lines)) if re.match(r'^  [A-Za-z0-9_.-]+:', lines[i]) or re.match(r'^[A-Za-z]', lines[i])), len(lines))
vol = next((i for i in range(start + 1, end) if re.match(r'^    volumes:\s*$', lines[i])), None)
# a mount counts as present when the service already mounts something on its target, however
# it is written (relative or absolute path, quoted or not) - adding it twice breaks the start
def target_of(w): return w.split(':', 1)[1]
present = [w for w in want if any(re.search(r':' + re.escape(target_of(w)) + r'(["\']|:|\s|$)', l)
                                  for l in lines[start:end] if not l.strip().startswith('#'))]
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
    PRESENT)   say "$(basename "$COMPOSE") already has the 6 mount lines" ;;
    NOSERVICE) die "no \"ubersdr:\" service found in $COMPOSE — add the lines from compose-mounts.txt by hand" ;;
    ADDED*)    say "$(basename "$COMPOSE"): ${ADDED#ADDED } mount line(s) added (backup: $(basename "$COMPOSE").bak.$TS)" ;;
    *)         die "could not edit $(basename "$COMPOSE"): $ADDED" ;;
esac

# ── 4. Apply ─────────────────────────────────────────────────────────────────
NEED_UP=0
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    n=$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' | grep -c "/websdr_sv1btl/")
    [ "$n" -ge 6 ] || NEED_UP=1
else
    NEED_UP=1
fi
if [ "$NEED_UP" -eq 1 ]; then
    say "The container must be recreated once to pick up the mounts."
    echo "   This cuts the audio of anyone listening for about 15 seconds."
    read -r -p "   Do it now? [y/N] " a
    if [ "$a" = "y" ] || [ "$a" = "Y" ]; then
        ( cd "$UBERSDR_DIR" && $DC up -d ubersdr ) || die "$DC up failed"
        echo "   waiting for UberSDR to start (up to 2 minutes)…"
        HP=$(docker port "$CONTAINER" "$PORT/tcp" 2>/dev/null | head -1 | sed 's/.*://')
        for i in $(seq 24); do
            sleep 5
            [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://localhost:${HP:-$PORT}/")" != 000 ] && break
        done
    else
        echo "   Later, run:  cd $UBERSDR_DIR && $DC up -d ubersdr"
        exit 0
    fi
else
    say "Mounts already active: the new files are live now (no restart needed)"
fi

# ── 5. Check ─────────────────────────────────────────────────────────────────
say "Checking"
UBERSDR_DIR="$UBERSDR_DIR" CONTAINER="$CONTAINER" bash "$TARGET/check-after-update.sh"   # it finds the published port itself
echo
echo "Next: edit $TARGET/sv1btl/station.js (your callsign, location, …),"
HP=$(docker port "$CONTAINER" "$PORT/tcp" 2>/dev/null | head -1 | sed 's/.*://')
echo "then open http://<your-address>:${HP:-$PORT}/ and press Ctrl+F5."
