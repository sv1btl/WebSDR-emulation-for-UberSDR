/**
 * diversity.js — two-site receive diversity combiner for PhantomSDR-Plus
 *
 * Takes the local /audio PCM stream plus a second stream from a remote
 * receiver (see remoteSource.js) and emits ONE PCM stream that follows
 * whichever site currently has the better signal.
 *
 * WHY SELECTION AND NOT SUMMING
 * -----------------------------
 * Two receivers hundreds of km apart hear the same transmission over
 * different ionospheric paths, so the two audio waveforms have unrelated
 * phase and slightly different Doppler.  Adding them sounds hollow and
 * comb-filtered — the classic "phasey" artefact.  Maximal-ratio combining
 * needs sample-coherent streams off a common clock, which two independent
 * WebSDRs over the internet can never provide.  So this switches between
 * them (selection combining) and only ever mixes the two during a 30 ms
 * crossfade, where the artefact is inaudible.
 *
 * The payoff is therefore continuity, not raw SNR: deep fades decorrelate
 * between distant sites, so when site A drops into a fade site B usually
 * has not, and you keep copy through it.
 *
 * HOW ALIGNMENT WORKS
 * -------------------
 * The two streams are correlated on their AUDIO ENVELOPES (log power,
 * decimated to 100 Hz), never on the waveforms.  Waveform correlation
 * fails outright here for the same phase reason as above; the envelope —
 * syllable structure — survives both the path and any codec, and is ~120x
 * cheaper to correlate.
 *
 * Envelope combining tolerates ~10 ms of alignment error, and clock drift
 * between two sites is on the order of 1 ms per 1000 s, so the delay
 * estimate only needs refreshing about once a minute.
 *
 * TIMEBASE
 * --------
 * The LOCAL stream is the timebase, because it already drives playback
 * scheduling in audio.js (this.playTime).  The remote is buffered and read
 * against the local cadence, never the reverse.  If the remote stalls or
 * underruns, output falls back to local immediately — silence is never an
 * acceptable outcome of a listening aid.
 */

// ── Tuning constants ────────────────────────────────────────────────────
const ENV_RATE      = 100    // envelope decimation rate, Hz
const CORR_WINDOW   = 6      // seconds of envelope used per delay search
const MAX_DELAY     = 4.0    // widest content offset we will search for, s
const NEAR_DELAY    = 1.5    // ...and the offset almost every link really has
// Two stages, because the envelope needed to search +/-L seconds is
// CORR_WINDOW + 2L, and that fill is what the listener is actually waiting
// through: 14 s for the full search, 9 s for a +/-1.5 s one. Nearly every
// real content offset is inside 1.5 s — it is the two sites' buffering plus
// the internet between them — so the near search almost always produces the
// first estimate five seconds earlier, and the full search still runs from
// 14 s onwards for the links that need it. A near search that finds the
// wrong peak costs one cycle, exactly as a failed confirmation does today.
const RELOCK_S      = 60     // re-run the delay search this often once confirmed
const RECHECK_S     = 5      // ...and this often while still unconfirmed
const CONFIRM_TOL_S = 0.040  // two estimates this close count as agreement
// 40 ms rather than 20: the gate exists to reject a SPURIOUS peak, and those
// land anywhere across the +/-4 s search — two of them agreeing to 40 ms is
// about a one-in-a-hundred coincidence, so the rejection is barely weaker.
// What 20 ms was actually rejecting was the honest jitter of a real peak,
// measured at +/-30 ms against a live receiver, which cost four extra
// attempts and twenty seconds. And it bought no accuracy: the alignment is
// only ever as good as the estimates themselves, so a tighter gate made the
// user wait longer for the very same number.
const XFADE_MS      = 30     // crossfade length on a site switch
const HYST_DB       = 2.5    // challenger must beat incumbent by this
const DWELL_MS      = 400    // ...and the incumbent must have held this long
const DIFF_ALPHA    = 0.05   // EMA on the SNR difference, ~1.7 s at 85 ms blocks
const COLLAPSE_DB   = 6      // below this the incumbent is carrying nothing
const COLLAPSE_MS   = 500    // ...and it must stay there this long to count
const REMOTE_DEAD_MS = 1500  // no remote data for this long → local only
const TARGET_LAG_S  = 0.30   // output lag behind local, once locked
const RATE_SETTLE_MS = 1500  // ignore the first moments: connection transients
const RATE_FIRST_MS  = 4000  // first measurement — roughly right, quickly
const RATE_WINDOW_MS = 8000  // while still converging
const RATE_HOLD_MS   = 30000 // once settled, re-measure rarely
const RATE_GAIN      = 0.9   // how much of each measurement to apply
const RATE_HOLD_GAIN = 0.3   // ...and once settled, gently
const RATE_SETTLED   = 0.002 // a window this close to 1 counts as settled
// The rate ratio is the thing that gates time-to-lock, and measuring it needs
// no correlation whatsoever — it is a count of samples on each side. So it is
// measured FIRST and fast: 4 s at 12 kHz is ~48 000 samples a side, which
// pins a 2% difference far more precisely than the lock needs. Getting it
// roughly right before the first correlation runs is what turns a 45 second
// wait into a 20 second one. Once two consecutive windows agree to 0.2% the
// measurement backs off to a long, gentle one, so a settled rate stops
// nudging an established lock.
const MAX_LAG_S     = 1.50   // resync if output falls further behind than this

// ── Small helpers ───────────────────────────────────────────────────────

/**
 * Circular sample buffer addressed by ABSOLUTE sample index, so both
 * streams can be talked about on one common timeline regardless of how
 * much has been discarded.
 */
class RingBuffer {
  constructor (capacity) {
    this.buf = new Float32Array(capacity)
    this.cap = capacity
    this.pos = 0                  // total samples ever written
  }

  write (block) {
    for (let i = 0; i < block.length; i++) {
      this.buf[(this.pos + i) % this.cap] = block[i]
    }
    this.pos += block.length
  }

  /** True when absolute range [from, from+len) is still resident. */
  has (from, len) {
    return from >= this.pos - this.cap && from + len <= this.pos
  }

  /** Copy absolute range [from, from+len) into `out`. */
  read (from, len, out) {
    for (let i = 0; i < len; i++) {
      out[i] = this.buf[(from + i) % this.cap]
    }
    return out
  }
}

/**
 * Log-power envelope at ENV_RATE, kept as a ring of absolute frame
 * indices.  Mean-removed dB is what gets correlated: it is insensitive to
 * the (quite different) absolute levels of two receivers, which a plain
 * linear-power correlation is not.
 */
class EnvTrack {
  constructor (sampleRate, seconds) {
    this.hop = Math.max(1, Math.round(sampleRate / ENV_RATE))
    this.cap = Math.ceil(ENV_RATE * seconds)
    this.env = new Float32Array(this.cap)
    this.frames = 0               // total frames ever produced
    this._acc = 0                 // partial-frame accumulator
    this._n = 0
  }

  feed (pcm) {
    for (let i = 0; i < pcm.length; i++) {
      const s = pcm[i]
      this._acc += s * s
      if (++this._n === this.hop) {
        // +1e-12 keeps digital silence out of log(0)
        this.env[this.frames % this.cap] =
          10 * Math.log10(this._acc / this.hop + 1e-12)
        this.frames++
        this._acc = 0
        this._n = 0
      }
    }
  }

  at (absFrame) { return this.env[absFrame % this.cap] }

  /** Absolute frame range currently resident. */
  span () {
    return [Math.max(0, this.frames - this.cap), this.frames]
  }
}

/**
 * Per-stream SNR estimate from the audio alone.
 *
 * The spectral SNR in waterfall.js cannot be reused: it is computed from
 * FFT bins, and we only ever have those for the local receiver.  The
 * remote gives us audio and nothing else.  So both streams are measured
 * the same way here — block RMS against a slow min-tracked noise floor.
 * Symmetry between the two matters far more than absolute accuracy,
 * because the only use of these numbers is comparing them to each other.
 */
class SnrTracker {
  constructor (sampleRate) {
    // ~2.5 s of block measurements: long enough to span several syllables,
    // short enough that the estimate does not smear across a fade edge.
    this.cap = Math.max(16, Math.round(2.5 * sampleRate / 1024))
    this.hist = new Float32Array(this.cap)
    this.n = 0
    this.snrDb = 0
    this.lastDb = -120
    this.floorDb = -120
    this.peakDb = -120
    this._sorted = new Float32Array(this.cap)
  }

  feed (pcm) {
    let acc = 0
    for (let i = 0; i < pcm.length; i++) acc += pcm[i] * pcm[i]
    this.lastDb = 10 * Math.log10(acc / Math.max(1, pcm.length) + 1e-12)
    this.hist[this.n % this.cap] = this.lastDb
    this.n++

    const len = Math.min(this.n, this.cap)
    if (len < 8) return this.snrDb            // not enough history to judge

    // Percentile spread, not a min-tracker: an asymmetric attack/decay
    // tracker has to be seeded correctly and takes tens of seconds to
    // recover from a wrong seed, which is long enough to make every
    // comparison during that time meaningless.  Percentiles have no state
    // to converge and give the same answer on both streams by
    // construction — and comparability between the two is the only thing
    // these numbers are for.
    const s = this._sorted.subarray(0, len)
    s.set(this.hist.subarray(0, len))
    s.sort()
    this.floorDb = s[Math.floor(len * 0.10)]
    this.peakDb = s[Math.floor(len * 0.90)]
    this.snrDb = this.peakDb - this.floorDb
    return this.snrDb
  }
}

/** Linear resampler — good enough for an envelope-domain combiner. */
function resampleLinear (input, srIn, srOut) {
  if (srIn === srOut) return input
  const ratio = srIn / srOut
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const p = i * ratio
    const i0 = p | 0
    const frac = p - i0
    const a = input[i0]
    const b = i0 + 1 < input.length ? input[i0 + 1] : a
    out[i] = a + (b - a) * frac
  }
  return out
}

/**
 * Resampler that carries its fractional position across blocks.
 *
 * The remote stream has to be rate-locked to the local one, and the required
 * ratio is not a round number — so a stateless per-block resampler would
 * round the block boundary every time and the two streams would still creep
 * apart. Keeping the phase means an arbitrary ratio can be held indefinitely.
 */
class DriftResampler {
  constructor () {
    this.pos = 0        // fractional read position within the next block
    this.prev = 0       // last sample of the previous block
    this.primed = false
  }

  process (input, ratio) {
    if (!input || input.length === 0) return input
    // One sample of history in front, so interpolation spans the join.
    const buf = new Float32Array(input.length + 1)
    buf[0] = this.primed ? this.prev : input[0]
    buf.set(input, 1)

    const est = Math.ceil((buf.length - this.pos) / ratio) + 2
    const out = new Float32Array(est)
    let n = 0
    let p = this.pos
    while (p < buf.length - 1) {
      const i0 = p | 0
      const f = p - i0
      out[n++] = buf[i0] + (buf[i0 + 1] - buf[i0]) * f
      p += ratio
    }
    this.prev = input[input.length - 1]
    this.primed = true
    this.pos = p - input.length          // carry into the next block
    return out.subarray(0, n)
  }
}

// ── The combiner ────────────────────────────────────────────────────────

export class DiversityCombiner {
  /**
   * @param {number} sampleRate      local audioOutputSps — the timebase
   * @param {number} remoteCalibDb   added to the remote's SNR before
   *   comparison.  A lossy remote (a classic WebSDR sends 8-bit aLaw) has a
   *   codec-limited noise floor, so its measured SNR saturates and is not
   *   directly comparable to a FLAC local stream.  Determine empirically.
   */
  constructor ({ sampleRate, remoteCalibDb = 0 }) {
    this.sr = sampleRate
    this.remoteCalibDb = remoteCalibDb
    this.active = false

    const cap = Math.ceil(sampleRate * (MAX_DELAY + 2))
    this.localBuf  = new RingBuffer(cap)
    this.remoteBuf = new RingBuffer(cap)

    // Window must hold the correlation window PLUS a full maxLag of slack
    // on BOTH sides, or the search cannot reach negative lags at all: the
    // anchored local window would start at the oldest resident frame and
    // every rStart < lStart would fall off the end of the remote ring.
    this.localEnv  = new EnvTrack(sampleRate, CORR_WINDOW + 2 * MAX_DELAY)
    this.remoteEnv = new EnvTrack(sampleRate, CORR_WINDOW + 2 * MAX_DELAY)

    this.snrLocal  = new SnrTracker(sampleRate)
    this.snrRemote = new SnrTracker(sampleRate)

    // Content alignment: local sample index i holds the same on-air audio
    // as remote sample index i + contentOffset.  null until first lock.
    this.contentOffset = null
    this.lockConfirmed = false      // see _estimateOffset
    // Offset used while there is no confirmed lock.  The correlator can only
    // lock when BOTH sites hear the same thing, and the case diversity
    // matters most — the remote hears a station this receiver does not —
    // is exactly the case it can never lock on.  So until it does, the two
    // streams are paired by ARRIVAL (or by the last confirmed offset, if
    // the lock was lost) and the selector runs anyway.  A switch made on
    // this pairing can repeat or skip up to the true content offset, which
    // is nothing when only one site carries the signal.
    this.freeOffset = null
    this.outPos = 0                 // absolute local index of next output
    this.corrPeak = 0

    // All timing below is STREAM time (derived from samples pushed), never
    // performance.now().  A backgrounded tab that resumes and flushes a
    // second of buffered packets in one burst advances wall-clock time by
    // milliseconds and stream time by a second; every timer here cares
    // about the latter.  It also makes the whole module deterministic and
    // testable off-line.
    this.streamMs = 0
    this.lastCorrAt = -Infinity
    this.lastRemoteMs = 0

    // Rate locking. Two receivers are two pieces of hardware with two clocks
    // and two decimation chains, so their audio streams do NOT arrive at the
    // same rate even when both declare 12 kHz — measured 2% apart between two
    // PhantomSDR-Plus receivers with different front ends. Two percent is
    // 240 samples a second of creep, which no amount of correlation can hold:
    // the delay estimate simply walks, and the lock is never confirmed.
    // So the remote is continuously resampled to the LOCAL stream's rate,
    // with the ratio measured from how many samples each side actually
    // delivers rather than from what either of them claims.
    this._rs = new DriftResampler()
    this.rateCorrection = 1
    this._rateAtLastEst = 1
    this._rateRemote = 0
    this._rateLocal = 0
    this._rateNextMs = RATE_SETTLE_MS + RATE_FIRST_MS
    this._rateSettledCount = 0

    this.sel = 'local'
    this.selSince = 0
    this.diffEma = 0                // smoothed (remote - local) SNR, dB
    // Remote streams do not arrive on the local pipeline's scale: a
    // PhantomSDR peer lands within a hair of it, but a KiwiSDR delivers
    // normalised +/-1 PCM against a local working level of a few tenths.
    // Unmatched, every switch would be an audible jump in level.  Matched
    // on the two p90 levels, which the SNR trackers already compute.
    this.levelGain = 1
    this.matchLevel = true
    this.collapseSince = null       // stream ms when the incumbent went quiet
    this.fade = 1                   // 1 = all local, 0 = all remote
    this._scratchL = new Float32Array(0)
    this._scratchR = new Float32Array(0)
  }

  /** Remote PCM arrives here, at whatever rate the remote runs. */
  pushRemote (pcm, srIn) {
    if (!pcm || pcm.length === 0) return
    // Declared rate first, then the measured correction on top of it.
    const ratio = ((srIn || this.sr) * this.rateCorrection) / this.sr
    const block = this._rs.process(pcm, ratio)
    this._rateRemote += block.length
    // Counted for the UI: "locked" can fail for two completely different
    // reasons — no remote audio at all, or audio that will not correlate —
    // and without this the panel cannot tell them apart.
    this.remoteSamples = (this.remoteSamples || 0) + block.length
    this.remoteRateIn = srIn || this.sr
    this.remoteBuf.write(block)
    this.remoteEnv.feed(block)
    this.lastRemoteMs = this.streamMs
  }

  /**
   * Local PCM arrives here; the combined block comes back.
   *
   * Returns the caller's own buffer unchanged whenever diversity cannot
   * help (not locked yet, remote stalled, stereo).  That makes the
   * integration in audio.js a no-op in every degraded case rather than a
   * source of dropouts.
   */
  pushLocal (pcm, channels = 1) {
    if (!pcm || pcm.length === 0) return pcm

    // C-QUAM stereo is interleaved L/R; the combiner is mono-only and
    // interleaving would wreck the envelope.  Pass it straight through.
    if (channels !== 1 || !this.active) return pcm

    this.localBuf.write(pcm)
    this.localEnv.feed(pcm)

    this.streamMs = (this.localBuf.pos / this.sr) * 1000
    const now = this.streamMs
    this._rateLocal += pcm.length
    if (now < RATE_SETTLE_MS) {
      // Buffers are still filling; anything counted here is not a clock.
      this._rateLocal = 0
      this._rateRemote = 0
    } else if (now >= this._rateNextMs && this._rateLocal > this.sr * 2 &&
               this._rateRemote > 0) {
      const k = this._rateRemote / this._rateLocal
      // Anything wilder than this is a stall or a reconnect, not a clock.
      if (k > 0.8 && k < 1.25) {
        const settled = this._rateSettledCount >= 2
        this.rateCorrection *= 1 + (k - 1) * (settled ? RATE_HOLD_GAIN : RATE_GAIN)
        if (Math.abs(k - 1) < RATE_SETTLED) this._rateSettledCount++
        else this._rateSettledCount = 0
      }
      this._rateRemote = 0
      this._rateLocal = 0
      this._rateNextMs = now +
        (this._rateSettledCount >= 2 ? RATE_HOLD_MS : RATE_WINDOW_MS)
    }
    const remoteAlive = (now - this.lastRemoteMs) < REMOTE_DEAD_MS

    if (!remoteAlive) {
      // Remote gone: hand back local and resync the output cursor so we
      // do not try to replay a backlog when it returns.
      this.contentOffset = null
      this.lockConfirmed = false
      this.freeOffset = null
      this.outPos = this.localBuf.pos
      this._forceLocal()
      return pcm
    }

    const interval = (this.lockConfirmed ? RELOCK_S : RECHECK_S) * 1000
    if (this.contentOffset === null || (now - this.lastCorrAt) > interval) {
      const wasLocked = this.lockConfirmed
      const lastGood = this.contentOffset
      this._estimateOffset(now)
      if (wasLocked && !this.lockConfirmed) this.freeOffset = lastGood
    }
    if (this.lockConfirmed) return this._emit(pcm, now, this.contentOffset)

    // Unaligned: wait until the remote has actually delivered something
    // worth pairing with, then pin the pairing once.  Re-deriving it every
    // block would let network jitter slide the remote back and forth.
    if (this.freeOffset === null) {
      if (this.remoteBuf.pos < this.sr * TARGET_LAG_S * 2) return pcm
      this.freeOffset = this.remoteBuf.pos - this.localBuf.pos
      this.outPos = Math.max(
        this.outPos,
        this.localBuf.pos - Math.round(TARGET_LAG_S * this.sr)
      )
    }
    return this._emit(pcm, now, this.freeOffset)
  }

  // Cross-correlate the two log envelopes to find the content offset.
  _estimateOffset (now) {
    const [lLo, lHi] = this.localEnv.span()
    const [rLo, rHi] = this.remoteEnv.span()
    const win = ENV_RATE * CORR_WINDOW

    // Need a full window on both sides plus room to slide it either way.
    // Take the widest search the resident envelope can actually support.
    const have = Math.min(lHi - lLo, rHi - rLo)
    const lagFull = Math.round(ENV_RATE * MAX_DELAY)
    const lagNear = Math.round(ENV_RATE * NEAR_DELAY)
    let maxLag
    if (have >= win + 2 * lagFull) maxLag = lagFull
    else if (have >= win + 2 * lagNear) maxLag = lagNear
    else return
    this.lastCorrAt = now

    // Anchor the local window far enough back that every candidate lag
    // stays inside what the remote still holds.
    const lStart = lHi - win - maxLag
    if (lStart < lLo) return

    let lMean = 0
    for (let i = 0; i < win; i++) lMean += this.localEnv.at(lStart + i)
    lMean /= win

    let best = 0
    let bestLag = null
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      const rStart = lStart + lag
      if (rStart < rLo || rStart + win > rHi) continue

      let rMean = 0
      for (let i = 0; i < win; i++) rMean += this.remoteEnv.at(rStart + i)
      rMean /= win

      let num = 0, dl = 0, dr = 0
      for (let i = 0; i < win; i++) {
        const a = this.localEnv.at(lStart + i) - lMean
        const b = this.remoteEnv.at(rStart + i) - rMean
        num += a * b
        dl += a * a
        dr += b * b
      }
      const denom = Math.sqrt(dl * dr)
      if (denom <= 0) continue
      const c = num / denom
      if (c > best) { best = c; bestLag = lag }
    }

    // Below ~0.35 the "peak" is noise, not a shared signal: the two sites
    // are hearing different things (wrong frequency, wrong mode, or one of
    // them has nothing but static).  Refusing to lock is the honest
    // outcome — a bad offset would sound far worse than no diversity.
    this.lastCorrAttempt = best
    if (bestLag === null || best < 0.35) return
    this.corrPeak = best

    // A single strong peak is not proof.  When the two sites fade in
    // antiphase they are never both carrying the signal at the same
    // moment, and the correlator will happily lock onto whatever lag makes
    // the two fade patterns line up — a confident, completely wrong
    // answer that would sound like an echo.  So a lag is only trusted
    // once a second, independent search agrees with it; until then we
    // re-check every RECHECK_S instead of every RELOCK_S and keep passing
    // local audio through untouched.
    const proposed = bestLag * this.localEnv.hop
    // A rate correction applied between the two estimates moves the measured
    // offset with it: a ratio change of d, over a W second window, shifts the
    // content by up to d*W. Charging that to the confirmation gate fails a
    // perfectly good pair of estimates and costs another RECHECK_S — which is
    // exactly what happens on a WebSDR, whose declared rate is furthest from
    // what it really delivers, and whose first big correction lands between
    // the first two searches. The allowance is a few tens of milliseconds
    // against a +/-4 s search space, so the rejection is not measurably
    // weaker.
    const rateShift = Math.abs(this.rateCorrection - this._rateAtLastEst) *
                      CORR_WINDOW * this.sr
    const tol = CONFIRM_TOL_S * this.sr + rateShift
    const agrees = this.contentOffset !== null &&
                   Math.abs(proposed - this.contentOffset) <= tol
    this._rateAtLastEst = this.rateCorrection
    this.lockConfirmed = agrees
    // Two estimates that agree are two measurements of one delay, so take
    // the mean rather than the latest. That halves the jitter, and more than
    // pays back the wider gate above.
    this.contentOffset = agrees
      ? Math.round((proposed + this.contentOffset) / 2)
      : proposed

    if (this.lockConfirmed) {
      this.outPos = Math.max(
        this.outPos,
        this.localBuf.pos - Math.round(TARGET_LAG_S * this.sr)
      )
    }
  }

  _forceLocal () {
    this.sel = 'local'
    this.fade = 1
    this.diffEma = 0
    this.collapseSince = null
  }

  // Decide which site should be live, with hysteresis and a dwell timer.
  // Without both, the selector flaps continuously whenever the two sites
  // are close in SNR, and flapping sounds worse than the weaker receiver.
  //
  // The comparison runs on a SMOOTHED difference, not the instantaneous
  // one.  Percentile SNR estimates jitter by a couple of dB block to
  // block, which is enough to cross a 2.5 dB gate several times a second
  // when the two sites are genuinely equal — the exact case the
  // hysteresis exists to protect.  Smoothing the difference makes a
  // challenger earn the switch by sustaining its advantage for ~2 s.
  _select (now) {
    const l = this.snrLocal.snrDb
    const r = this.snrRemote.snrDb + this.remoteCalibDb
    this.diffEma = DIFF_ALPHA * (r - l) + (1 - DIFF_ALPHA) * this.diffEma

    const want = this.sel === 'local'
      ? (this.diffEma > HYST_DB ? 'remote' : 'local')
      : (this.diffEma < -HYST_DB ? 'local' : 'remote')

    // Escape hatch.  The smoothing above costs ~4 s to react, which is the
    // right price when both sites are usable and the wrong one when the
    // incumbent has collapsed into the noise — that is precisely the fade
    // this whole feature exists to ride through.  So when the live site is
    // carrying nothing and the other one clearly is, switch at once and
    // let the crossfade do the rest.
    // A single quiet block is a gap between syllables, not a collapse, so
    // the condition has to hold for COLLAPSE_MS before it counts.  Without
    // that the hatch fires on ordinary speech pauses and reintroduces
    // exactly the flapping the EMA above removes.
    const incumbent = this.sel === 'local' ? l : r
    const challenger = this.sel === 'local' ? r : l
    if (incumbent < COLLAPSE_DB && challenger > incumbent + HYST_DB) {
      if (this.collapseSince === null) this.collapseSince = now
      if ((now - this.collapseSince) > COLLAPSE_MS) {
        this.sel = this.sel === 'local' ? 'remote' : 'local'
        this.selSince = now
        this.collapseSince = null
        this.diffEma = this.sel === 'remote' ? HYST_DB * 2 : -HYST_DB * 2
        this.switches = (this.switches || 0) + 1
        return
      }
    } else {
      this.collapseSince = null
    }

    if (want !== this.sel && (now - this.selSince) > DWELL_MS) {
      this.sel = want
      this.selSince = now
      this.switches = (this.switches || 0) + 1
    }
  }

  _emit (localBlock, now, off) {
    const len = localBlock.length

    // We can only output local index n once remote index n+off has landed.
    const limit = Math.min(this.localBuf.pos, this.remoteBuf.pos - off)

    // Drifted too far behind (a stall we recovered from, or a tab that was
    // backgrounded): jump forward rather than trying to catch up.
    if (limit - this.outPos > MAX_LAG_S * this.sr) {
      this.outPos = limit - Math.round(TARGET_LAG_S * this.sr)
    }
    if (this.outPos + len > limit) return localBlock   // remote not ready yet
    if (!this.localBuf.has(this.outPos, len) ||
        !this.remoteBuf.has(this.outPos + off, len)) {
      return localBlock
    }

    if (this._scratchL.length !== len) {
      this._scratchL = new Float32Array(len)
      this._scratchR = new Float32Array(len)
    }
    const L = this.localBuf.read(this.outPos, len, this._scratchL)
    const R = this.remoteBuf.read(this.outPos + off, len, this._scratchR)
    this.outPos += len

    // SNR is measured HERE, on the content-aligned pair, not where each
    // block arrived.  Measured at arrival the two trackers describe
    // moments up to several seconds apart, and at the edge of a pause one
    // site reads silent while the other has not reached the pause yet —
    // which looks exactly like a fade and triggers a switch that is
    // purely an artefact of the alignment offset.
    this.snrLocal.feed(L)
    this.snrRemote.feed(R)

    // Level matching: NOISE against NOISE.
    //
    // The ratio is learned only from blocks where BOTH streams are sitting
    // within a few dB of their own floor — i.e. a gap in the traffic, where
    // what remains is each receiver's noise.  That is the quantity a switch
    // exposes (background hiss changing level), and unlike a peak- or
    // percentile-based match it does not move when a signal fades: a faded
    // site's noise is still its noise.
    //
    // Matching peaks instead fails twice over: it drags the gain down with
    // a dying incumbent, and it only ever learns while both sites carry a
    // strong signal — measured against a Kiwi 3x hotter than the local
    // pipeline, a peak-gated version never updated once in 55 s.
    const lDb = this.snrLocal.lastDb
    const rDb = this.snrRemote.lastDb
    if (this.matchLevel &&
        this.snrLocal.n > 16 && this.snrRemote.n > 16 &&
        lDb > -100 && rDb > -100 &&
        lDb < this.snrLocal.floorDb + 3 &&
        rDb < this.snrRemote.floorDb + 3) {
      const want = Math.pow(10, (lDb - rDb) / 20)
      const g = Math.min(200, Math.max(0.005, want))
      this.levelGain = 0.05 * g + 0.95 * this.levelGain
    }

    this._select(now)

    const target = this.sel === 'local' ? 1 : 0
    const step = 1 / Math.max(1, (XFADE_MS / 1000) * this.sr)
    const out = new Float32Array(len)
    let f = this.fade
    for (let i = 0; i < len; i++) {
      if (f < target) f = Math.min(target, f + step)
      else if (f > target) f = Math.max(target, f - step)
      // Equal-power crossfade: the two streams are uncorrelated, so a
      // linear fade would dip ~3 dB through the middle of a switch.
      const th = (1 - f) * Math.PI / 2
      out[i] = L[i] * Math.cos(th) + R[i] * this.levelGain * Math.sin(th)
    }
    this.fade = f
    return out
  }

  /**
   * Everything the UI needs, in one object.  Note that the SNR figures are
   * only meaningful once `locked` is true — before that nothing has been
   * measured, because nothing has been aligned.
   */
  getStatus () {
    return {
      active: this.active,
      locked: this.lockConfirmed,
      // Combining on the arrival pairing: the remote is selectable even
      // though the two sites have not been content-aligned.
      unaligned: !this.lockConfirmed && this.freeOffset !== null,
      live: this.fade > 0.5 ? 'local' : 'remote',
      delayMs: this.contentOffset === null
        ? null : (this.contentOffset / this.sr) * 1000,
      corrPeak: this.corrPeak,
      remoteSamples: this.remoteSamples || 0,
      remoteRateIn: this.remoteRateIn || null,
      rateCorrection: this.rateCorrection,
      diffEmaDb: this.diffEma,
      levelGain: this.levelGain,
      switches: this.switches || 0,
      snrLocalDb: this.snrLocal.snrDb,
      snrRemoteDb: this.snrRemote.snrDb + this.remoteCalibDb
    }
  }

  reset () {
    this.contentOffset = null
    this.lockConfirmed = false
    this.freeOffset = null
    this.outPos = this.localBuf.pos
    this.corrPeak = 0
    this.levelGain = 1
    // The rate correction is a property of the two receivers, not of this
    // lock, so it survives a reset — re-measuring it from scratch would put
    // the streams back where they started.
    this._rs = new DriftResampler()
    this._rateAtLastEst = this.rateCorrection
    this._forceLocal()
  }
}

export default DiversityCombiner
