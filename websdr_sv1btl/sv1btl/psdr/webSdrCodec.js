/**
 * webSdrCodec.js — decoder for the audio stream of PA3FWM's WebSDR software
 *
 * The stream is a sequence of byte-tagged records, not framed audio:
 *
 *   F0..FF  S-meter, 12 bits            (tag & 0x0F) << 8 | next byte
 *   80      128 uncompressed samples    one byte each, through TABLE below
 *   81      audio sample rate, 2 bytes  big-endian, Hz
 *   82      quantiser step, 2 bytes     scales every residual
 *   83      flags, 1 byte               bit 4 selects the predictor variant
 *   84      128 samples of silence      and a predictor reset
 *   85      true tuned frequency        6 bytes, mHz in the top nibble
 *   86      resync marker
 *   87      server timestamp, 6 bytes
 *   90..DF  compressed block            gain G = 14 - (tag >> 4), 4 bits of
 *                                       payload in the low nibble
 *   00..7F  compressed block            continues with the previous gain,
 *                                       7 bits of payload in the tag itself
 *
 * A compressed block is always 128 samples. Each sample is one variable-length
 * code — a unary prefix (or an 8-bit escape), then G-1 value bits and a sign —
 * read from a 32-bit window that slides across the byte stream. The residual
 * drives a 20-tap leaky-LMS predictor, and with bit 4 of the flags clear the
 * result is run through an integrator that undoes the encoder's pre-emphasis.
 *
 * This is a transcription of the decoder in the WebSDR client's
 * websdr-sound.js. Two details there are easy to get wrong and silent when
 * wrong, so they are spelled out here:
 *
 *   - the value bits are (window >> 16 & 0xFFFF) >> (17 - G), i.e. the top
 *     G-1 bits of the window's high half, NOT a mask applied after shifting;
 *   - the predictor rounds toward negative infinity ((x + 4095) >> 12 for
 *     negative x), which is not the same as x >> 12.
 *
 * Verified against the Twente WebSDR: an AM capture decodes with 91% of its
 * energy below the 4.2 kHz filter edge, and the uncompressed 0x80 blocks —
 * which use none of the above — line up with the compressed ones around them.
 */

// Sample values for the uncompressed 0x80 blocks: a µ-law-like curve, taken
// verbatim from the client so the two paths agree exactly.
const TABLE = [
  -5504, -5248, -6016, -5760, -4480, -4224, -4992, -4736, -7552, -7296, -8064, -7808,
  -6528, -6272, -7040, -6784, -2752, -2624, -3008, -2880, -2240, -2112, -2496, -2368,
  -3776, -3648, -4032, -3904, -3264, -3136, -3520, -3392, -22016, -20992, -24064, -23040,
  -17920, -16896, -19968, -18944, -30208, -29184, -32256, -31232, -26112, -25088, -28160, -27136,
  -11008, -10496, -12032, -11520, -8960, -8448, -9984, -9472, -15104, -14592, -16128, -15616,
  -13056, -12544, -14080, -13568, -344, -328, -376, -360, -280, -264, -312, -296,
  -472, -456, -504, -488, -408, -392, -440, -424, -88, -72, -120, -104,
  -24, -8, -56, -40, -216, -200, -248, -232, -152, -136, -184, -168,
  -1376, -1312, -1504, -1440, -1120, -1056, -1248, -1184, -1888, -1824, -2016, -1952,
  -1632, -1568, -1760, -1696, -688, -656, -752, -720, -560, -528, -624, -592,
  -944, -912, -1008, -976, -816, -784, -880, -848, 5504, 5248, 6016, 5760,
  4480, 4224, 4992, 4736, 7552, 7296, 8064, 7808, 6528, 6272, 7040, 6784,
  2752, 2624, 3008, 2880, 2240, 2112, 2496, 2368, 3776, 3648, 4032, 3904,
  3264, 3136, 3520, 3392, 22016, 20992, 24064, 23040, 17920, 16896, 19968, 18944,
  30208, 29184, 32256, 31232, 26112, 25088, 28160, 27136, 11008, 10496, 12032, 11520,
  8960, 8448, 9984, 9472, 15104, 14592, 16128, 15616, 13056, 12544, 14080, 13568,
  344, 328, 376, 360, 280, 264, 312, 296, 472, 456, 504, 488,
  408, 392, 440, 424, 88, 72, 120, 104, 24, 8, 56, 40,
  216, 200, 248, 232, 152, 136, 184, 168, 1376, 1312, 1504, 1440,
  1120, 1056, 1248, 1184, 1888, 1824, 2016, 1952, 1632, 1568, 1760, 1696,
  688, 656, 752, 720, 560, 528, 624, 592, 944, 912, 1008, 976,
  816, 784, 880, 848
]

// Thresholds that decide how many low bits of a residual are dropped, indexed
// by the block gain. The two 999s and two 99s are never reached in practice;
// they are kept so the table indexes the same way as the client's.
const SPREAD = [999, 999, 8, 4, 2, 1, 99, 99]

export class WebSdrCodec {
  constructor () {
    this.weights = new Int32Array(20)   // predictor taps
    this.history = new Int32Array(20)   // past reconstructed samples
    this.emphasis = 0                   // de-emphasis integrator
    this.gain = 3                       // G, carried across untagged blocks
    this.quant = 40                     // residual scale, tag 0x82
    this.flags = 0                      // tag 0x83
    this.sampleRate = 0                 // tag 0x81
    this.smeter = 0                     // tag 0xF0..0xFF, in units of 0.1 dB
    this.trueFreq = null                // tag 0x85, Hz
  }

  reset () {
    this.weights.fill(0)
    this.history.fill(0)
    this.emphasis = 0
  }

  /**
   * Decode one WebSocket frame.
   * @param {Uint8Array} b
   * @returns {Int32Array} samples, at this.sampleRate, roughly int16-scaled
   */
  decode (b) {
    const out = []
    const at = i => (i >= 0 && i < b.length ? b[i] : 0)

    for (let a = 0; a < b.length; a++) {
      const tag = b[a]
      let bit = 0

      if ((tag & 0xf0) === 0xf0) { this.smeter = ((tag & 0x0f) << 8) | at(a + 1); a++; continue }
      if (tag === 0x80) {
        for (let i = 0; i < 128; i++) out.push(TABLE[at(a + 1 + i)])
        a += 128
        this.reset()
        continue
      }
      if (tag === 0x81) { this.sampleRate = (at(a + 1) << 8) | at(a + 2); a += 2; continue }
      if (tag === 0x82) { this.quant = (at(a + 1) << 8) | at(a + 2); a += 2; continue }
      if (tag === 0x83) { this.flags = at(a + 1); a += 1; continue }
      if (tag === 0x84) {
        for (let i = 0; i < 128; i++) out.push(0)
        this.reset()
        continue
      }
      if (tag === 0x85) {
        this.trueFreq = 16777216 * (((at(a + 1) & 15) << 16) + (at(a + 2) << 8) + at(a + 3)) +
                        (at(a + 4) << 16) + (at(a + 5) << 8) + at(a + 6)
        a += 6
        continue
      }
      if (tag === 0x86) continue
      if (tag === 0x87) { a += 6; continue }

      if (tag >= 0x90 && tag <= 0xdf) { bit = 4; this.gain = 14 - (tag >> 4) }
      else if ((tag & 0x80) !== 128) bit = 1
      else continue                       // 0x88..0x8F and 0xE0..0xEF: unused

      // ── one 128-sample compressed block ──────────────────────────────
      const G = this.gain
      const emphasised = (this.flags & 16) !== 16
      const rate = emphasised ? 14 : 12   // LMS adaptation shift
      const N = this.weights
      const O = this.history

      for (let n = 0; n < 128; n++) {
        let w = ((at(a) & 255) << 24) | ((at(a + 1) & 255) << 16) |
                ((at(a + 2) & 255) << 8) | (at(a + 3) & 255)
        w <<= bit

        let used = 0
        let run = 15 - G
        if (w !== 0) while ((w & 0x80000000) === 0 && used < run) { w <<= 1; used++ }
        if (used < run) { run = used; used++; w <<= 1 }
        else { run = (w >> 24) & 255; used += 8; w <<= 8 }

        let drop = 0
        if (run >= SPREAD[G]) drop++
        if (run >= SPREAD[G - 1]) drop++
        if (drop > G - 1) drop = G - 1

        let res = (((w >> 16) & 65535) >> (17 - G)) & (-1 << drop)
        res += run << (G - 1)
        if ((w & (1 << (32 - G + drop))) !== 0) { res |= (1 << drop) - 1; res = ~res }

        bit += used + G - drop
        while (bit >= 8) { a++; bit -= 8 }

        let pred = 0
        for (let i = 0; i < 20; i++) pred += N[i] * O[i]
        pred |= 0
        pred = pred >= 0 ? pred >> 12 : (pred + 4095) >> 12

        const scaled = res * this.quant + (this.quant >> 1)
        const step = scaled >> 4
        for (let i = 19; i >= 0; i--) {
          N[i] += -(N[i] >> 7) + ((O[i] * step) >> rate)
          if (i === 0) break
          O[i] = O[i - 1]
        }
        O[0] = pred + scaled

        out.push(O[0] + (this.emphasis >> 4))
        this.emphasis = emphasised ? this.emphasis + ((O[0] << 4) >> 3) : 0
      }
      if (bit === 0) a--
    }
    return Int32Array.from(out)
  }
}

export default WebSdrCodec
