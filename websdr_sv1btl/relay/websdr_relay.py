#!/usr/bin/env python3
"""
PhantomSDR-Plus WebSDR Relay
============================
A WebSDR (PA3FWM's websdr.org software) refuses the /~~stream WebSocket when
the Origin header is not its own site, and a browser cannot override Origin.
Receive diversity therefore needs this small relay: the browser connects here,
this process connects onward to the WebSDR with the Origin it expects, and
audio is piped back unchanged.

It also carries PhantomSDR-Plus (/audio) and KiwiSDR (/kiwi/<ts>/SND) streams
for pages served over https, which the browser forbids to open ws:// sockets;
see /ws below. Same caps, same refusal of private addresses.

That is a deliberate check on someone else's server, so this relay is built to
be a polite guest and nothing else:

  * a hard cap of MAX_PER_HOST concurrent sessions to any one WebSDR,
  * a User-Agent naming this site and its operator, so an operator who wants
    it stopped knows exactly who to contact,
  * only /~~param tuning commands are passed upstream — the socket cannot be
    used to send anything else,
  * private, loopback and carrier-NAT addresses are refused, so a public page
    cannot use the relay to reach inside the machine or the LAN.

Configuration comes from websdr_relay.json beside this file, or from the
command line; every setting has a working default.

  {
    "port": 8898,
    "max_per_host": 10,
    "max_total": 60,
    "site": "https://your.receiver.example",
    "operator": "YOURCALL <you@example.com>"
  }

Run:  python3 websdr_relay.py
      python3 websdr_relay.py --port 8898 --site https://my.sdr --operator YOURCALL
"""

import argparse
import asyncio
import ipaddress
import json
import logging
import re
import socket
import sys
from pathlib import Path
from urllib.parse import urlsplit

try:
    import aiohttp
    from aiohttp import web, ClientSession, ClientTimeout, WSMsgType
except ImportError:
    print("[ERROR] aiohttp is not installed. Run:", file=sys.stderr)
    print("        pip3 install aiohttp --break-system-packages", file=sys.stderr)
    sys.exit(1)

# ── Defaults ───────────────────────────────────────────────────────────────────
DEFAULTS = {
    "port": 8898,
    "bind": "0.0.0.0",
    "max_per_host": 10,      # concurrent sessions to any single WebSDR
    "max_total": 60,         # concurrent sessions across all of them
    "site": "",              # your receiver's public URL, put in the User-Agent
    "operator": "",          # callsign / contact, put in the User-Agent
    "idle_timeout": 30,      # seconds without upstream audio before giving up
}

# Only these reach the WebSDR. Anything else a client sends is dropped: the
# relay is a tuning path for diversity, not a general-purpose tunnel.
ALLOWED_PREFIXES = ("GET /~~param?",)

log = logging.getLogger("websdr-relay")


def load_config(argv=None):
    cfg = dict(DEFAULTS)
    path = Path(__file__).parent / "websdr_relay.json"
    if path.exists():
        try:
            with open(path) as f:
                cfg.update(json.load(f))
        except (json.JSONDecodeError, OSError) as e:
            print(f"[WARN] Ignoring {path}: {e}", file=sys.stderr)

    p = argparse.ArgumentParser(description="WebSDR relay for PhantomSDR-Plus receive diversity")
    p.add_argument("--port", type=int)
    p.add_argument("--bind")
    p.add_argument("--max-per-host", type=int, dest="max_per_host")
    p.add_argument("--max-total", type=int, dest="max_total")
    p.add_argument("--site")
    p.add_argument("--operator")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args(argv)
    for k, v in vars(args).items():
        if k != "verbose" and v is not None:
            cfg[k] = v
    cfg["verbose"] = bool(args.verbose)
    return cfg


def user_agent(cfg):
    """Identify ourselves honestly: what this is, who runs it, where to complain."""
    bits = ["PhantomSDR-Plus-diversity-relay/1.0"]
    if cfg.get("site"):
        bits.append(f"(+{cfg['site']})")
    if cfg.get("operator"):
        bits.append(f"operator {cfg['operator']}")
    return " ".join(bits)


def parse_target(raw):
    """
    Accept 'host:port', 'http://host:port', 'ws://host:port/…' and return
    (scheme, host, port, netloc) or raise ValueError.
    """
    if not raw:
        raise ValueError("no host given")
    raw = raw.strip()
    if "://" not in raw:
        raw = "http://" + raw
    u = urlsplit(raw)
    scheme = {"ws": "http", "wss": "https"}.get(u.scheme, u.scheme)
    if scheme not in ("http", "https"):
        raise ValueError(f"unsupported scheme {u.scheme!r}")
    if not u.hostname:
        raise ValueError("no hostname")
    port = u.port or (443 if scheme == "https" else 80)
    if not (1 <= port <= 65535):
        raise ValueError("bad port")
    netloc = f"{u.hostname}:{port}"
    return scheme, u.hostname, port, netloc


def check_public(host):
    """
    Refuse anything that is not a globally routable address. Without this a
    public page could point the relay at 127.0.0.1 or the LAN and read
    services that were never meant to be reachable from outside.
    """
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise ValueError(f"cannot resolve {host}: {e.strerror or e}")
    if not infos:
        raise ValueError(f"cannot resolve {host}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global or ip.is_multicast:
            raise ValueError(f"{host} resolves to non-public address {ip}")
        # 100.64.0.0/10 is carrier NAT: routable-looking, not reachable.
        if ip.version == 4 and ip in ipaddress.ip_network("100.64.0.0/10"):
            raise ValueError(f"{host} resolves to a carrier-NAT address {ip}")


class Counters:
    """Concurrent session counts, per WebSDR and overall."""

    def __init__(self, per_host, total):
        self.per_host = per_host
        self.total = total
        self._hosts = {}
        self._all = 0

    def acquire(self, netloc):
        if self._all >= self.total:
            return f"relay is at its overall limit of {self.total} sessions"
        if self._hosts.get(netloc, 0) >= self.per_host:
            return (f"already relaying {self.per_host} sessions to {netloc}, "
                    f"which is this relay's per-site limit")
        self._hosts[netloc] = self._hosts.get(netloc, 0) + 1
        self._all += 1
        return None

    def release(self, netloc):
        n = self._hosts.get(netloc, 0) - 1
        if n > 0:
            self._hosts[netloc] = n
        else:
            self._hosts.pop(netloc, None)
        self._all = max(0, self._all - 1)

    def snapshot(self):
        return {"total": self._all, "hosts": dict(self._hosts)}


@web.middleware
async def cors(request, handler):
    """
    Allow the receiver page to read /bandinfo.

    The relay listens on its own port, so every request from the page is
    cross-origin however the site is reached, and without this header the
    browser blocks the response before the page ever sees it — while curl
    and any non-browser client work perfectly, which makes it a confusing
    failure to diagnose. WebSockets are not subject to this, so only the
    plain GETs need it.

    A wildcard is right here: the relay holds no credentials and no private
    data, and it is meant to be usable from whatever hostname the receiver
    happens to be served under.
    """
    if request.method == "OPTIONS":
        resp = web.Response(status=204)
    else:
        resp = await handler(request)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    resp.headers["Access-Control-Max-Age"] = "86400"
    return resp


async def pump_upstream(up, down, state):
    """WebSDR → browser. Audio is binary; pass text through untouched."""
    async for msg in up:
        if msg.type == WSMsgType.BINARY:
            state["rx"] += 1
            await down.send_bytes(msg.data)
        elif msg.type == WSMsgType.TEXT:
            await down.send_str(msg.data)
        elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR):
            break


async def pump_downstream(down, up, state):
    """Browser → WebSDR, tuning commands only."""
    async for msg in down:
        if msg.type == WSMsgType.TEXT:
            text = msg.data
            if any(text.startswith(p) for p in ALLOWED_PREFIXES):
                state["tx"] += 1
                await up.send_str(text)
            else:
                log.debug("dropped non-tuning frame: %.60s", text)
        elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR):
            break


async def relay(request):
    cfg = request.app["cfg"]
    counters = request.app["counters"]

    try:
        scheme, host, port, netloc = parse_target(request.query.get("host"))
        check_public(host)
    except ValueError as e:
        return web.Response(status=400, text=str(e))

    busy = counters.acquire(netloc)
    if busy:
        log.info("refused %s: %s", netloc, busy)
        return web.Response(status=503, text=busy)

    down = web.WebSocketResponse(max_msg_size=0, heartbeat=25)
    await down.prepare(request)

    origin = f"{scheme}://{netloc}"
    upstream = f"{'wss' if scheme == 'https' else 'ws'}://{netloc}/~~stream"
    state = {"rx": 0, "tx": 0}
    session = None
    try:
        session = ClientSession(timeout=ClientTimeout(total=None, sock_connect=10))
        async with session.ws_connect(
            upstream,
            origin=origin,
            headers={"User-Agent": request.app["ua"]},
            max_msg_size=0,
            heartbeat=25,
            autoping=True,
        ) as up:
            log.info("open  %s  (%d to this site)", netloc, counters.snapshot()["hosts"].get(netloc, 0))
            a = asyncio.create_task(pump_upstream(up, down, state))
            b = asyncio.create_task(pump_downstream(down, up, state))
            done, pending = await asyncio.wait({a, b}, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
    except aiohttp.WSServerHandshakeError as e:
        # 403 here is the Origin check, i.e. the operator has said no.
        log.warning("upstream refused %s: HTTP %s", netloc, e.status)
        await down.close(code=4403, message=f"WebSDR refused the connection (HTTP {e.status})".encode())
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
        log.warning("upstream failed %s: %s", netloc, e)
        await down.close(code=4502, message=f"cannot reach {netloc}: {e}".encode()[:120])
    finally:
        if session is not None:
            await session.close()
        counters.release(netloc)
        if not down.closed:
            await down.close()
        log.info("close %s  (%d frames in, %d tuning out)", netloc, state["rx"], state["tx"])
    return down


# ── Pass-through for pages served over HTTPS ──────────────────────────────────
# A page loaded over https may not open a ws:// socket (mixed content), and most
# PhantomSDR-Plus stations and KiwiSDRs are plain http with no wss:// at all. So
# an https page reaches them through here: wss:// to us, ws:// onward. Only the
# two audio paths diversity uses are accepted, so this is not a general tunnel.
_PASS_PATHS = re.compile(r"^/audio$|^/kiwi/\d{1,16}/SND$")
_PASS_QUERY = re.compile(r"^(v=\d{1,3})?$")      # /audio?v=N, nothing else


def parse_passthrough(raw):
    """Return (upstream URL, netloc) for an allowed ws:// target, else raise."""
    if not raw:
        raise ValueError("no url given")
    u = urlsplit(raw.strip())
    if u.scheme not in ("ws", "wss"):
        raise ValueError(f"unsupported scheme {u.scheme!r}")
    if not _PASS_PATHS.match(u.path or ""):
        raise ValueError(f"path {u.path!r} is not a diversity audio path")
    if not _PASS_QUERY.match(u.query or "") or (u.query and u.path != "/audio"):
        raise ValueError("query not allowed")
    _, host, port, netloc = parse_target(raw)
    path = u.path + (f"?{u.query}" if u.query else "")
    return f"{u.scheme}://{netloc}{path}", host, netloc


async def pass_frames(src, dst, state, key):
    """
    Copy frames one way and return the close (code, reason) seen, if any.
    receive() rather than `async for`, which swallows the close frame — and
    the remote's reason is what tells a diversity client to retry with ?v=.
    """
    while True:
        msg = await src.receive()
        if msg.type == WSMsgType.TEXT:
            state[key] += 1
            await dst.send_str(msg.data)
        elif msg.type == WSMsgType.BINARY:
            state[key] += 1
            await dst.send_bytes(msg.data)
        else:
            if msg.type == WSMsgType.CLOSE:
                return msg.data, msg.extra or ""
            return None, ""


async def passthrough(request):
    counters = request.app["counters"]
    try:
        upstream, host, netloc = parse_passthrough(request.query.get("url"))
        check_public(host)
    except ValueError as e:
        return web.Response(status=400, text=str(e))

    busy = counters.acquire(netloc)
    if busy:
        log.info("refused %s: %s", netloc, busy)
        return web.Response(status=503, text=busy)

    down = web.WebSocketResponse(max_msg_size=0, heartbeat=25)
    await down.prepare(request)

    state = {"rx": 0, "tx": 0}
    code, reason = 1000, ""
    session = None
    try:
        session = ClientSession(timeout=ClientTimeout(total=None, sock_connect=10))
        async with session.ws_connect(
            upstream,
            headers={"User-Agent": request.app["ua"]},
            max_msg_size=0,
            heartbeat=25,
            autoping=True,
        ) as up:
            log.info("open  %s  (pass-through, %d to this site)",
                     upstream, counters.snapshot()["hosts"].get(netloc, 0))
            a = asyncio.create_task(pass_frames(up, down, state, "rx"))
            b = asyncio.create_task(pass_frames(down, up, state, "tx"))
            done, pending = await asyncio.wait({a, b}, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            if a in done and not a.exception():
                c, r = a.result()
                code, reason = (c or up.close_code or 1000), r
            elif b in done and not up.closed:
                await up.close(code=down.close_code or 1000)
    except aiohttp.WSServerHandshakeError as e:
        log.warning("upstream refused %s: HTTP %s", upstream, e.status)
        code, reason = 4403, f"station refused the connection (HTTP {e.status})"
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
        log.warning("upstream failed %s: %s", upstream, e)
        code, reason = 4502, f"cannot reach {netloc}: {e}"
    finally:
        if session is not None:
            await session.close()
        counters.release(netloc)
        if not down.closed:
            # 123 bytes is the protocol's cap; never cut a character in half.
            msg = reason.encode("utf-8")[:123].decode("utf-8", "ignore").encode("utf-8")
            await down.close(code=code if 1000 <= code < 5000 else 1000, message=msg)
        log.info("close %s  (%d frames in, %d out)", netloc, state["rx"], state["tx"])
    return down


_BAND_RE = re.compile(
    r"centerfreq:\s*([-\d.]+).*?samplerate:\s*([-\d.]+).*?name:\s*'([^']*)'",
    re.S,
)


async def bandinfo(request):
    """
    Hand the browser the WebSDR's band list.

    The page cannot fetch it itself — tmp/bandinfo.js is on the WebSDR's
    origin with no CORS headers — but the adapter needs it twice over: to
    know whether a frequency is within reach before offering the site as a
    diversity partner, and to pick the band index that tuning requires. It
    is one small GET per session, cached by the browser thereafter.
    """
    try:
        scheme, host, port, netloc = parse_target(request.query.get("host"))
        check_public(host)
    except ValueError as e:
        return web.Response(status=400, text=str(e))

    url = f"{scheme}://{netloc}/tmp/bandinfo.js"
    try:
        async with ClientSession(timeout=ClientTimeout(total=10)) as s:
            async with s.get(url, headers={"User-Agent": request.app["ua"]}) as r:
                if r.status != 200:
                    return web.Response(status=502, text=f"{url} returned HTTP {r.status}")
                text = await r.text()
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
        return web.Response(status=502, text=f"cannot fetch {url}: {e}")

    bands = [
        {"centerfreq": float(c) * 1000.0,     # the file is in kHz, we speak Hz
         "samplerate": float(sr) * 1000.0,
         "name": name}
        for c, sr, name in _BAND_RE.findall(text)
    ]
    if not bands:
        return web.Response(status=502, text="no bands found in bandinfo.js")
    return web.json_response({"bands": bands})


async def status(request):
    counters = request.app["counters"]
    cfg = request.app["cfg"]
    snap = counters.snapshot()
    return web.json_response({
        "service": "PhantomSDR-Plus WebSDR relay",
        "user_agent": request.app["ua"],
        "max_per_host": cfg["max_per_host"],
        "max_total": cfg["max_total"],
        "sessions": snap,
    })


def main():
    cfg = load_config()
    logging.basicConfig(
        level=logging.DEBUG if cfg.get("verbose") else logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    app = web.Application(middlewares=[cors])
    app["cfg"] = cfg
    app["ua"] = user_agent(cfg)
    app["counters"] = Counters(cfg["max_per_host"], cfg["max_total"])
    app.router.add_get("/websdr", relay)
    app.router.add_get("/ws", passthrough)
    app.router.add_get("/bandinfo", bandinfo)
    app.router.add_get("/status", status)

    if not cfg.get("site") or not cfg.get("operator"):
        log.warning("site/operator are unset — the User-Agent will not say who is")
        log.warning("calling. Set them in websdr_relay.json before going public.")
    log.info("User-Agent: %s", app["ua"])
    log.info("caps: %d per WebSDR, %d overall", cfg["max_per_host"], cfg["max_total"])
    log.info("listening on %s:%d   (ws://…/websdr?host=<websdr host:port>)", cfg["bind"], cfg["port"])
    log.info("pass-through for https pages: ws://…/ws?url=<ws://station/audio>")
    web.run_app(app, host=cfg["bind"], port=cfg["port"], print=None)


if __name__ == "__main__":
    main()
