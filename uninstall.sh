#!/bin/bash
# uninstall.sh — go back to UberSDR's own WebSDR page.
#
#   bash uninstall.sh                  # UberSDR in ~/ubersdr
#   bash uninstall.sh /path/to/ubersdr
#
# Removes the 6 websdr_sv1btl mount lines from docker-compose.yml (backup kept) and,
# after asking, recreates the container. The websdr_sv1btl folder itself is left in
# place (delete it by hand if you no longer want it).
set -u
USER_HOME="$HOME"
if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then USER_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"; fi
UBERSDR_DIR="${1:-${UBERSDR_DIR:-$USER_HOME/ubersdr}}"
if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi
COMPOSE="$UBERSDR_DIR/docker-compose.yml"
for c in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
    [ -f "$UBERSDR_DIR/$c" ] && { COMPOSE="$UBERSDR_DIR/$c"; break; }
done
TS="$(date +%Y%m%d_%H%M%S)"
[ -f "$COMPOSE" ] || { echo "ERROR: no docker-compose.yml (or compose.yml) in $UBERSDR_DIR"; exit 1; }

R="$(python3 - "$COMPOSE" "$TS" <<'EOF'
import re, shutil, sys
path, ts = sys.argv[1], sys.argv[2]
lines = open(path).read().split('\n')
keep = [l for l in lines if not re.match(r'^\s*-\s*\./websdr_sv1btl/', l)
        and 'installed by websdr_sv1btl install.sh' not in l]
if len(keep) == len(lines):
    print('NONE'); sys.exit()
shutil.copy2(path, path + '.bak.' + ts)
open(path, 'w').write('\n'.join(keep))
print('REMOVED %d' % (len(lines) - len(keep)))
EOF
)"
case "$R" in
    NONE)     echo "No websdr_sv1btl mount lines in $COMPOSE — nothing to do."; exit 0 ;;
    REMOVED*) echo "Removed ${R#REMOVED } line(s) from $(basename "$COMPOSE") (backup: $(basename "$COMPOSE").bak.$TS)" ;;
    *)        echo "ERROR: $R"; exit 1 ;;
esac
echo "The container must be recreated to go back to UberSDR's own page (listeners' audio stops ~15 s)."
read -r -p "Do it now? [y/N] " a
if [ "$a" = "y" ] || [ "$a" = "Y" ]; then
    ( cd "$UBERSDR_DIR" && $DC up -d ubersdr )
else
    echo "Later, run:  cd $UBERSDR_DIR && $DC up -d ubersdr"
fi
