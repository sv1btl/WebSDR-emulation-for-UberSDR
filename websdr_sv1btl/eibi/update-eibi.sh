#!/bin/bash
# update-eibi.sh -- keep the EiBi schedule for the EiBi window of the SV1BTL WebSDR
# page (port 8901) current. Adapted from PhantomSDR-Plus frequencylist/update-eibi.sh.
#
# EiBi (http://www.eibispace.de/dx/) is free to download, use and pass on, also
# inside third-party software (its README, section A).
#
# Run daily by cron; it only goes to the network when needed: the CSV is fetched
# with If-Modified-Since. It writes ../sv1btl/eibi.json (live at once, the
# sv1btl/ folder is mounted into the container).
#
# usage: update-eibi.sh [--force]

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" || exit 1

BASE_URL="http://www.eibispace.de/dx"
PUBLIC=../sv1btl/eibi.json
STAMP=.eibi-checked
FORCE=0
[ "$1" = "--force" ] && FORCE=1

# Once a day is plenty: EiBi updates every week or two.
if [ $FORCE -eq 0 ] && [ -f "$STAMP" ] && [ -f "$PUBLIC" ] \
   && [ -n "$(find "$STAMP" -mmin -1440 2>/dev/null)" ]; then
    exit 0
fi

# Season codes: A = summer (last Sunday of March to last Sunday of October),
# B = winter. B26 runs from late October 2026 to late March 2027, so in
# January-March the season is the previous year's B.
season_now() {
    local y m d
    y=$(date -u +%y); m=$(date -u +%-m); d=$(date -u +%-d)
    last_sunday() {  # day of month of the last Sunday of month $1 this year
        local n
        n=$(date -u -d "$(date -u +%Y)-$1-31" +%u)
        echo $((31 - n % 7))
    }
    if [ "$m" -lt 3 ] || { [ "$m" -eq 3 ] && [ "$d" -lt "$(last_sunday 03)" ]; }; then
        printf 'b%02d\n' $((10#$y - 1))
    elif [ "$m" -lt 10 ] || { [ "$m" -eq 10 ] && [ "$d" -lt "$(last_sunday 10)" ]; }; then
        printf 'a%02d\n' $((10#$y))
    else
        printf 'b%02d\n' $((10#$y))
    fi
}

SEASON=$(season_now)
CSV="sked-$SEASON.csv"
get() {  # get URL FILE: download if newer than FILE; 0 = file present
    local url=$1 out=$2 tmp="$2.part" code
    if [ -f "$out" ]; then
        code=$(curl -sS -L -m 60 -z "$out" -R -o "$tmp" -w '%{http_code}' "$url")
    else
        code=$(curl -sS -L -m 60 -R -o "$tmp" -w '%{http_code}' "$url")
    fi
    if [ "$code" = "200" ] && [ -s "$tmp" ]; then mv -f "$tmp" "$out"; echo "EiBi: downloaded $url"; fi
    rm -f "$tmp"
    [ -s "$out" ]
}

# A new season's file appears a few days before the change; until it does,
# keep the one we have (or fall back to the season before).
if ! get "$BASE_URL/$CSV" "$CSV"; then
    prev=$(ls -t sked-[ab][0-9][0-9].csv 2>/dev/null | head -1)
    if [ -z "$prev" ]; then echo "EiBi: could not download $CSV" >&2; exit 1; fi
    echo "EiBi: $CSV not available yet, keeping $prev"
    CSV=$prev
fi
get "$BASE_URL/README.TXT" eibi-README.TXT || { echo "EiBi: could not download README.TXT" >&2; exit 1; }

# Only the current season's CSV is needed.
for f in sked-[ab][0-9][0-9].csv; do
    [ -f "$f" ] && [ "$f" != "$CSV" ] && rm -f "$f"
done

if [ $FORCE -eq 1 ] || [ ! -f "$PUBLIC" ] || [ "$CSV" -nt "$PUBLIC" ] || [ eibi-README.TXT -nt "$PUBLIC" ]; then
    python3 generate-eibi.py "$CSV" eibi-README.TXT "$PUBLIC" || exit 1
fi
touch "$STAMP"
exit 0
