#!/usr/bin/env python3
"""
generate-eibi.py -- turn the EiBi schedule into eibi.json for the SW Schedule window.

EiBi (Eike Bierwirth, http://www.eibispace.de/dx/) is the database shortwave.live
is built on. Its README says the lists are free to download, use and pass on,
also inside third-party software.

Input  (both fetched by update-eibi.sh):
  sked-XYY.csv      the season's CSV, ten semicolons per line, ISO-8859-1
  eibi-README.TXT   the code tables: languages, countries, target areas, sites
Output:
  eibi.json         compact JSON read by sv1btl/eibi.js (SV1BTL WebSDR page)

usage: generate-eibi.py SKED.csv README.TXT OUT.json [OUT2.json ...]
"""

import json
import os
import re
import sys
import time

# EiBi uses ITU country codes, flags need ISO 3166 alpha-2. Codes with no flag of
# their own (clandestine, international waters, unknown) are left out.
ITU_ISO = {
    "ABW": "AW", "AFG": "AF", "AFS": "ZA", "AGL": "AO", "AIA": "AI", "ALB": "AL",
    "ALG": "DZ", "ALS": "US", "AND": "AD", "AOE": "EH", "ARG": "AR", "ARM": "AM",
    "ARS": "SA", "ASC": "SH", "ATA": "AQ", "ATG": "AG", "AUS": "AU", "AUT": "AT",
    "AZE": "AZ", "AZR": "PT", "B": "BR", "BAH": "BS", "BDI": "BI", "BEL": "BE",
    "BEN": "BJ", "BER": "BM", "BES": "BQ", "BFA": "BF", "BGD": "BD", "BHR": "BH",
    "BIH": "BA", "BIO": "IO", "BLM": "BL", "BLR": "BY", "BLZ": "BZ", "BOL": "BO",
    "BOT": "BW", "BRB": "BB", "BRU": "BN", "BTN": "BT", "BUL": "BG", "BVT": "BV",
    "CAB": "AO", "CAF": "CF", "CAN": "CA", "CBG": "KH", "CEU": "ES", "CG7": "US",
    "CHL": "CL", "CHN": "CN", "CHR": "CX", "CKH": "CK", "CLM": "CO", "CLN": "LK",
    "CME": "CM", "CNR": "ES", "COD": "CD", "COG": "CG", "COM": "KM", "CPT": "FR",
    "CPV": "CV", "CRO": "TF", "CTI": "CI", "CTR": "CR", "CUB": "CU", "CUW": "CW",
    "CVA": "VA", "CYM": "KY", "CYP": "CY", "CZE": "CZ", "D": "DE", "DJI": "DJ",
    "DMA": "DM", "DNK": "DK", "DOM": "DO", "E": "ES", "EGY": "EG", "EQA": "EC",
    "ERI": "ER", "EST": "EE", "ETH": "ET", "EUR": "TF", "F": "FR", "FIN": "FI",
    "FJI": "FJ", "FLK": "FK", "FRO": "FO", "FSM": "FM", "G": "GB", "GAB": "GA",
    "GEO": "GE", "GHA": "GH", "GIB": "GI", "GLP": "GP", "GMB": "GM", "GNB": "GW",
    "GNE": "GQ", "GPG": "EC", "GRC": "GR", "GRD": "GD", "GRL": "GL", "GTM": "GT",
    "GUF": "GF", "GUI": "GN", "GUM": "GU", "GUY": "GY", "HKG": "HK", "HMD": "HM",
    "HND": "HN", "HNG": "HU", "HOL": "NL", "HRV": "HR", "HTI": "HT", "HWA": "US",
    "HWL": "UM", "I": "IT", "ICO": "CC", "IND": "IN", "INS": "ID", "IRL": "IE",
    "IRN": "IR", "IRQ": "IQ", "ISL": "IS", "ISR": "IL", "IWA": "JP", "J": "JP",
    "JAR": "UM", "JDN": "TF", "JMC": "JM", "JMY": "SJ", "JON": "UM", "JOR": "JO",
    "JUF": "CL", "KAL": "RU", "KAZ": "KZ", "KEN": "KE", "KER": "TF", "KGZ": "KG",
    "KIR": "KI", "KNA": "KN", "KOR": "KR", "KOS": "XK", "KRE": "KP", "KWT": "KW",
    "LAO": "LA", "LBN": "LB", "LBR": "LR", "LBY": "LY", "LCA": "LC", "LIE": "LI",
    "LSO": "LS", "LTU": "LT", "LUX": "LU", "LVA": "LV", "MAC": "MO", "MAF": "MF",
    "MAU": "MU", "MCO": "MC", "MDA": "MD", "MDG": "MG", "MDR": "PT", "MDW": "UM",
    "MEL": "ES", "MEX": "MX", "MHL": "MH", "MKD": "MK", "MLA": "MY", "MLD": "MV",
    "MLI": "ML", "MLT": "MT", "MNE": "ME", "MNG": "MN", "MOZ": "MZ", "MRA": "MP",
    "MRC": "MA", "MRN": "ZA", "MRT": "MQ", "MSR": "MS", "MTN": "MR", "MWI": "MW",
    "MYA": "MM", "MYT": "YT", "NCG": "NI", "NCL": "NC", "NFK": "NF", "NGR": "NE",
    "NIG": "NG", "NIU": "NU", "NMB": "NA", "NOR": "NO", "NPL": "NP", "NRU": "NR",
    "NZL": "NZ", "OCE": "PF", "OMA": "OM", "PAK": "PK", "PAQ": "CL", "PHL": "PH",
    "PHX": "KI", "PLM": "UM", "PLW": "PW", "PNG": "PG", "PNR": "PA", "POL": "PL",
    "POR": "PT", "PRG": "PY", "PRU": "PE", "PRV": "JP", "PSE": "PS", "PTC": "PN",
    "PTR": "PR", "QAT": "QA", "REU": "RE", "ROD": "MU", "ROU": "RO", "RRW": "RW",
    "RUS": "RU", "S": "SE", "SAP": "CO", "SDN": "SD", "SEN": "SN", "SEY": "SC",
    "SGA": "GS", "SHN": "SH", "SLM": "SB", "SLV": "SV", "SMA": "AS", "SMO": "WS",
    "SMR": "SM", "SNG": "SG", "SOM": "SO", "SPM": "PM", "SRB": "RS", "SRL": "SL",
    "SSD": "SS", "SSI": "GS", "STP": "ST", "SUI": "CH", "SUR": "SR", "SVB": "SJ",
    "SVK": "SK", "SVN": "SI", "SWZ": "SZ", "SXM": "SX", "SYR": "SY", "TCA": "TC",
    "TCD": "TD", "TGO": "TG", "THA": "TH", "TJK": "TJ", "TKL": "TK", "TKM": "TM",
    "TLS": "TL", "TON": "TO", "TRC": "SH", "TRD": "TT", "TUN": "TN", "TUR": "TR",
    "TUV": "TV", "TWN": "TW", "TZA": "TZ", "UAE": "AE", "UGA": "UG", "UKR": "UA",
    "URG": "UY", "USA": "US", "UZB": "UZ", "VCT": "VC", "VEN": "VE", "VIR": "VI",
    "VRG": "VG", "VTN": "VN", "VUT": "VU", "WAK": "UM", "WAL": "WF", "XGZ": "PS",
    "XWB": "PS", "YEM": "YE", "ZMB": "ZM", "ZWE": "ZW",
}

# Prefixes EiBi puts in front of an area ("C.. - Central ..", "N.. - North ..").
DIRS = {
    "C": "Central", "E": "East", "N": "North", "S": "South", "W": "West",
    "NE": "Northeast", "NW": "Northwest", "SE": "Southeast", "SW": "Southwest",
}


def read_latin1(path):
    with open(path, "rb") as f:
        return f.read().decode("latin-1").replace("\r", "")


def section(lines, start_pat, end_pat):
    """Lines after the header matching start_pat, up to end_pat (exclusive)."""
    out, on = [], False
    for ln in lines:
        if not on:
            if re.match(start_pat, ln):
                on = True
            continue
        if end_pat and re.match(end_pat, ln):
            break
        out.append(ln)
    return out


def parse_readme(path):
    lines = read_latin1(path).split("\n")
    # The header of each table appears twice: once in the overview (indented,
    # "I)   Language codes.") and once as the table itself. The table's header
    # is followed by the entries, so take the LAST match.
    def last_section(start, end):
        idx = [i for i, ln in enumerate(lines) if re.match(start, ln)]
        if not idx:
            return []
        out = []
        for ln in lines[idx[-1] + 1:]:
            if end and re.match(end, ln):
                break
            out.append(ln)
        return out

    lang_lines = last_section(r"^\s+I\)\s+Language codes", r"^\s+II\)\s+Country codes")
    ctry_lines = last_section(r"^\s+II\)\s+Country codes", r"^\s+III\)\s+Target-area codes")
    tgt_lines = last_section(r"^\s+III\)\s+Target-area codes", r"^\s+IV\)\s+Transmitter site codes")
    site_lines = last_section(r"^\s+IV\)\s+Transmitter site codes", None)

    langs = {}
    for ln in lang_lines:
        m = re.match(r"^ {1,4}(\S+)\s{2,}(.+?)\s*$", ln)
        if not m:
            continue
        code, text = m.group(1), m.group(2)
        text = re.sub(r"\s*\[[a-z]{3}\]\s*$", "", text)       # ISO 639-3
        text = text.split(":")[0]                              # "Abkhaz: Georgia..."
        text = re.sub(r"\s*\([^)]*\)\s*$", "", text).strip()   # "(300m)"
        if text:
            langs[code] = text
    langs.setdefault("-CW", "Morse Station")
    langs.setdefault("-TY", "Teletype / digital")

    countries = {}
    for ln in ctry_lines:
        m = re.match(r"^ {1,4}([A-Z][A-Z0-9]{0,2})\s{2,}(.+?)\s*$", ln)
        if m:
            name = re.sub(r"\s*\*$", "", m.group(2)).strip()
            name = re.sub(r"\s*\(.*\)$", "", name).strip() or name
            countries[m.group(1)] = name

    areas = {}
    for ln in tgt_lines:
        m = re.match(r"^ {1,4}(\S+)\s+-\s+(.+?)\s*$", ln)
        if m and ".." not in m.group(1):
            areas[m.group(1)] = re.sub(r"\s*\(.*\)$", "", m.group(2)).strip()

    sites, cur = {}, None
    coord = re.compile(r"\s+\d{1,3}[NS]\d.*$")
    for ln in site_lines:
        m = re.match(r"^ {1,4}([A-Z][A-Z0-9]{0,2}):\s*(.*)$", ln)
        if m:
            cur, rest = m.group(1), m.group(2)
        elif cur and re.match(r"^\s{5,}\S", ln):
            rest = ln.strip()
        else:
            if not ln.strip():
                continue
            cur = None
            continue
        rest = rest.strip()
        if not rest:
            continue
        # "k-Kabul ..." names site k; a line without a short code before the
        # hyphen ("Meyerton 26S35-28E08 except:") is the country's main site.
        sm = re.match(r"^([A-Za-z0-9]{1,3})-(\S.*)$", rest)
        if sm:
            code, name = sm.group(1), sm.group(2)
        else:
            code, name = "", rest
        name = coord.sub("", re.sub(r"\s+except:?$", "", name)).strip().rstrip(",")
        if name:
            sites.setdefault(f"{cur}-{code}", name)
    return langs, countries, areas, sites


def target_name(code, areas, countries):
    if not code:
        return ""
    if code in areas:
        return areas[code]
    if code in countries:
        return countries[code]
    for n in (2, 1):
        p, rest = code[:n], code[n:]
        if p in DIRS and rest in areas:
            return f"{DIRS[p]} {areas[rest]}"
    return code


def receiver_mode(khz, days, lang, station):
    """The marker mode a click on this row asks for (see MARKER_DECODERS in
    App.svelte). EiBi has no mode column: the mode is written in the days field
    (USB / LSB), in the language code (-CW, -TY, -HF) or in the station name
    ("Fax", "NAVTEX", "RTTY", "USB/FSK", "DIGITAL"...). Plain broadcasting is AM."""
    s = station.lower()
    if days in ("USB", "LSB"):
        return days
    if re.search(r"\busb\b", s):
        return "USB"
    if re.search(r"\blsb\b", s):
        return "LSB"
    if lang == "-HF" or "hfdl" in s:
        return "HFDL"
    if re.search(r"\bdrm\b|\bdigital\b", s):
        return "DRM"
    if "fax" in s:
        return "FAX"
    if "navtex" in s:
        return "NAVTEX"
    if "rtty" in s:
        # DWD Pinneberg's RTTY is the weather service (SERVICES "Weather RTTY").
        return "RTTY-WX" if ("dwd" in s or "meteo" in s or "wx" in s) else "RTTY"
    if lang == "-CW" or re.search(r"\bcw\b|morse", s):
        return "CW"
    if lang == "-TY" or re.search(r"\bfsk\b|stanag|\bale\b", s):
        return "USB"
    # Utility voice is upper sideband (EiBi README: "USB - default for utility
    # voice transmissions"): aviation and coastal weather, navies, coastguards,
    # maritime radio, military networks, numbers stations, channel markers.
    if re.search(r"volmet|coastg|coastgd|coast guard|maritime|navy|\bny\b|air force|"
                 r"ejercito|meteo|\bwx\b|spy numbers|channel marker|radio\b.*\bcoast", s):
        return "USB"
    # Coast and aeronautical stations are "<place> Radio" ("Olimpia Radio",
    # "Auckland Radio") on the maritime / aeronautical bands; broadcasters
    # named like that ("Myanma Radio") sit in the broadcast bands and stay AM.
    if (re.search(r"\bradio$", s) and not s.startswith("radio")
            and (in_maritime_band(khz) or not in_broadcast_band(khz))):
        return "USB"
    if khz < 150:
        return "USB"
    return "AM"


# ITU Appendix 17 / RR maritime mobile allocations (kHz), MF and HF.
MARITIME_BANDS = [
    (1606.5, 2300), (2495, 2850), (3155, 3200), (3500, 3800), (4000, 4438),
    (6200, 6525), (8100, 8815), (12230, 13200), (16360, 17410), (18780, 18900),
    (19680, 19800), (22000, 22855), (25070, 25210), (26100, 26175),
    # aeronautical mobile (R) and (OR)
    (2850, 3155), (3400, 3500), (4650, 4750), (5450, 5730), (6525, 6765),
    (8815, 9040), (10005, 10100), (11175, 11400), (13200, 13360),
    (15010, 15100), (17900, 18030), (21924, 22000), (23200, 23350),
]


# Broadcasting allocations (kHz): LW, MW and the shortwave broadcast bands.
BROADCAST_BANDS = [
    (148.5, 283.5), (526.5, 1606.5), (2300, 2495), (3200, 3400), (3900, 4000),
    (4750, 5060), (5900, 6200), (7200, 7450), (9400, 9900), (11600, 12100),
    (13570, 13870), (15100, 15800), (17480, 17900), (18900, 19020),
    (21450, 21850), (25670, 26100),
]


def in_broadcast_band(khz):
    return any(lo <= khz <= hi for lo, hi in BROADCAST_BANDS)


def in_maritime_band(khz):
    return any(lo <= khz <= hi for lo, hi in MARITIME_BANDS)


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return 2
    sked, readme, outs = sys.argv[1], sys.argv[2], sys.argv[3:]
    langs, countries, areas, sites = parse_readme(readme)

    season = re.search(r"sked-([AB]\d\d)", os.path.basename(sked), re.I)
    season = season.group(1).upper() if season else ""

    rows = []
    used_lang, used_ctry, used_tgt, used_site = set(), set(), set(), set()
    skipped = 0
    for ln in read_latin1(sked).split("\n")[1:]:
        f = ln.split(";")
        if len(f) < 11:
            continue
        try:
            khz = float(f[0])
        except ValueError:
            continue
        tm = re.match(r"^(\d{4})-(\d{4})$", f[1].strip())
        if not tm:
            continue
        days, itu, station = f[2].strip(), f[3].strip(), f[4].strip()
        lang, target, site = f[5].strip(), f[6].strip(), f[7].strip()
        try:
            pers = int(f[8].strip() or "1")
        except ValueError:
            pers = 1
        p = pers % 90
        # 8 = inactive; 4/5 = winter/summer-only entries in the other season.
        if p == 8 or (p == 4 and season.startswith("A")) or (p == 5 and season.startswith("B")):
            skipped += 1
            continue
        start, stop = f[9].strip(), f[10].strip()
        heard = ""
        hm = re.search(r"\[(\d{4})\]", stop)
        if hm:
            heard = hm.group(1)
            stop = re.sub(r"\s*\[\d{4}\]", "", stop).strip()
        if p != 6:
            start = stop = ""   # dates only bind entries valid for part of the season

        # Transmitter site: "v" (home country, site v), "/RUS-s" (relay abroad),
        # "/XUU" (abroad, one site), "" (home country, main site).
        host, scode = itu, site
        if site.startswith("/"):
            host, _, scode = site[1:].partition("-")
        scode = scode.split(",")[0].strip()
        site_key = f"{host}-{scode}"
        if site_key not in sites and f"{host}-" in sites and not scode:
            site_key = f"{host}-"
        used_site.add(site_key)

        for l in lang.split(","):
            if l:
                used_lang.add(l)
        used_ctry.add(itu)
        used_ctry.add(host)
        if target:
            used_tgt.add(target)

        rows.append([
            int(khz) if khz == int(khz) else khz,
            int(tm.group(1)), int(tm.group(2)),
            days, itu, station, lang, target, site_key,
            receiver_mode(khz, days, lang, station),
            start, stop, heard,
        ])

    rows.sort(key=lambda r: (r[0], r[1]))
    # Over the public proxy the file goes uncompressed, so keep it small: each
    # station name once (rows carry its index) and no trailing empty fields.
    stations = sorted({r[5] for r in rows})
    sidx = {n: i for i, n in enumerate(stations)}
    for r in rows:
        r[5] = sidx[r[5]]
        if r[9] == "AM":
            r[9] = ""       # the default; the window reads "" as AM
        while r and r[-1] == "":
            r.pop()
    out = {
        "source": "EiBi, http://www.eibispace.de/dx/",
        "season": season,
        "season_year": 2000 + int(season[1:]) if season else 0,
        "file_date": time.strftime("%Y-%m-%d", time.gmtime(os.path.getmtime(sked))),
        "generated": time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime()),
        # station = index into "stations"; trailing empty fields are left out.
        "fields": ["khz", "start", "end", "days", "itu", "station", "lang", "target",
                   "site", "mode", "from", "to", "heard"],
        "lang": {c: langs.get(c, c) for c in sorted(used_lang)},
        "country": {c: [countries.get(c, c), ITU_ISO.get(c, "")] for c in sorted(used_ctry) if c},
        "target": {c: target_name(c, areas, countries) for c in sorted(used_tgt)},
        "site": {k: sites.get(k, "") for k in sorted(used_site) if sites.get(k)},
        "stations": stations,
        "rows": rows,
    }
    data = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    for path in outs:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(data)
        os.replace(tmp, path)
    print(f"EiBi {season}: {len(rows)} entries ({skipped} inactive skipped), "
          f"{len(out['lang'])} languages, {len(out['country'])} countries, "
          f"{len(out['site'])} sites -> {', '.join(outs)} ({len(data) // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
