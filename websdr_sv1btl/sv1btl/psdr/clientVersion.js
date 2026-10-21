// Client build marker on /audio. A page that has been open since before a
// frontend change is still running the JavaScript it loaded then, and there is
// no way to reach it: the server can only refuse it and let the listener
// reload. This is the handle for that — see min_client_version in config.toml
// and on_open() in src/websocket.cpp.
//
// 2 = the build that stopped reconnecting on its own (2026-09-17).
export const CLIENT_VERSION = 2
