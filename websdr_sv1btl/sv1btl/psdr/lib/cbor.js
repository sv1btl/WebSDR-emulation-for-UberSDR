// SV1BTL (websdr_sv1btl): a small CBOR (RFC 8949) reader, standing in for the
// cbor-x package PhantomSDR-Plus bundles. It covers what a PhantomSDR-Plus
// /audio packet uses and the rest of the basic data model: integers, byte and
// text strings (also indefinite length), arrays, maps, tags (skipped), simple
// values and half/single/double floats. Byte strings come back as Uint8Array.

export function decode (bytes) {
  var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  var pos = 0
  var td = new TextDecoder()

  function half (h) {
    var e = (h >> 10) & 0x1f, f = h & 0x3ff, s = (h & 0x8000) ? -1 : 1
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024)
    if (e === 31) return f ? NaN : s * Infinity
    return s * Math.pow(2, e - 15) * (1 + f / 1024)
  }

  function arg (info) {
    if (info < 24) return info
    if (info === 24) return u8[pos++]
    if (info === 25) { var a = dv.getUint16(pos); pos += 2; return a }
    if (info === 26) { var b = dv.getUint32(pos); pos += 4; return b }
    if (info === 27) {
      var hi = dv.getUint32(pos), lo = dv.getUint32(pos + 4); pos += 8
      return hi * 4294967296 + lo
    }
    if (info === 31) return -1            // indefinite length
    throw new Error('cbor: bad additional info ' + info)
  }

  function chunks (major, done) {         // indefinite-length byte/text string
    var parts = []
    while (u8[pos] !== 0xff) parts.push(item())
    pos++
    return done(parts)
  }

  function item () {
    if (pos >= u8.length) throw new Error('cbor: unexpected end')
    var ib = u8[pos++], major = ib >> 5, info = ib & 31
    var n, i, out
    switch (major) {
      case 0: return arg(info)
      case 1: return -1 - arg(info)
      case 2:
        n = arg(info)
        if (n < 0) {
          return chunks(2, function (p) {
            var len = 0, k, o
            for (k = 0; k < p.length; k++) len += p[k].length
            o = new Uint8Array(len); len = 0
            for (k = 0; k < p.length; k++) { o.set(p[k], len); len += p[k].length }
            return o
          })
        }
        out = u8.slice(pos, pos + n); pos += n
        return out
      case 3:
        n = arg(info)
        if (n < 0) return chunks(3, function (p) { return p.join('') })
        out = td.decode(u8.subarray(pos, pos + n)); pos += n
        return out
      case 4:
        n = arg(info); out = []
        if (n < 0) { while (u8[pos] !== 0xff) out.push(item()); pos++ } else for (i = 0; i < n; i++) out.push(item())
        return out
      case 5:
        n = arg(info); out = {}
        if (n < 0) {
          while (u8[pos] !== 0xff) { var k1 = item(); out[k1] = item() }
          pos++
        } else for (i = 0; i < n; i++) { var k2 = item(); out[k2] = item() }
        return out
      case 6:
        arg(info)                         // tag number: not needed here
        return item()
      case 7:
        if (info === 20) return false
        if (info === 21) return true
        if (info === 22) return null
        if (info === 23) return undefined
        if (info === 25) { var h = dv.getUint16(pos); pos += 2; return half(h) }
        if (info === 26) { var f = dv.getFloat32(pos); pos += 4; return f }
        if (info === 27) { var d = dv.getFloat64(pos); pos += 8; return d }
        if (info < 24) return info
        if (info === 24) return u8[pos++]
        throw new Error('cbor: bad simple value ' + info)
    }
  }

  return item()
}

export default { decode }
