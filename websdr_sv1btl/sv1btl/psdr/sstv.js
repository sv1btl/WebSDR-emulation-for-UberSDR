// ─────────────────────────────────────────────────────────────────────────────
// KiwiSSTVDecoder  –  PhantomSDR-Plus  (sv1btl fork)
//
// Revision history
// ─────────────────────────────────────────────────────────────────────────────
//  [1] FREQUENCY ESTIMATOR  (_estimateFreqRaw / _estimateFreq)
//      Replaced integer-lag autocorrelation (gave only ~4 discrete frequency
//      values in the SSTV pixel range) with the normalised lag-1 autocorrelation
//      identity:
//
//        f = arccos( Σ x[n]·x[n-1] / Σ x[n]² ) · sr / 2π
//
//      Continuous, amplitude-independent, stable with windows ≥ 4 samples.
//      Effective per-channel colour depth goes from ~2 bits → ~8 bits.
//
//  [2] SYNC CALIBRATION  (_freqOffset, updated every sync pulse)
//      The sync pulse is 1200 Hz by definition.  After finding each sync
//      pulse the raw estimator is applied to it and the error accumulated
//      via a slow EMA (α = 0.20, converges in ~5 lines).  _estimateFreq()
//      adds this offset so that a transmitter that is e.g. 30 Hz off-nominal
//      (common on HF USB) produces correctly scaled pixels throughout the frame.
//
//  [3] BANDPASS PREFILTER  (_bpFilter, applied after resampling in feedPCM)
//      4th-order IIR bandpass, cascade of two Butterworth biquads at Fs=12 kHz:
//        Stage 1 – Highpass  f0 = 1000 Hz,  Q = 1/√2
//        Stage 2 – Lowpass   f0 = 2500 Hz,  Q = 1/√2
//      Passband covers sync (1200 Hz) through white (2300 Hz) plus VIS bits
//      (1100/1300 Hz).  Rejects mains hum, LF noise, and adjacent interference.
//      All Robot 36 frequencies (1200–2300 Hz) are within the passband.
//
//  [4] MARTIN M2 WIDE-WINDOW HACK removed
//      The ×5.0 pixel-span window was compensating for the old lag estimator's
//      need for a full oscillation period.  The arccos estimator is stable with
//      windows ≥ 4 samples; a fixed N=8 window now applies to all modes (see [9]).
//
//  [5] SCOTTIE BRIGHTNESS CORRECTION removed
//      The old ×1.12 + 6 factor compensated for the previous estimator's
//      systematic frequency under-estimate.  With an accurate estimator it
//      over-brightens Scottie images.
//
//  [6] IMPULSE FILTER extended from 1-pixel to 2-pixel spike detection
//
//  [7] freqOffset exposed in 'line' callback events for UI diagnostics
//
//  [8] ROBOT 36 COLOR  (_decodeLineRobot36, _yuv2rgb)
//      New mode family 'robot36'.  VIS code 8, 320×240, 150 ms/line.
//      Line structure: sync(9ms) + porch(3ms) + Y(88ms) + sep(6ms) + C(44ms)
//      Color space: YCbCr (BT.601).  Even lines carry Cb (B−Y), odd lines
//      carry Cr (R−Y).  Decoder buffers even-line Y+Cb and waits for the next
//      odd line's Cr before emitting both rows together.
//      YUV→RGB: R = Y + 1.402·(Cr−128)
//               G = Y − 0.344136·(Cb−128) − 0.714136·(Cr−128)
//               B = Y + 1.772·(Cb−128)
//
//  [9] PIXEL WINDOW SIZE  N=8  (was N=6, then max(6, round(pixSpan×0.85)))
//      The arccos lag-1 estimator requires that the double-frequency cross-term
//      Σ cos(2·Δθ·n) cancels over the window.  At 1500 Hz (black, period=8 samples)
//      this term does NOT cancel for N=6 (1.5 periods of 3000 Hz residual), causing:
//        • σ = 52 px per pixel at 1500 Hz  → dark areas appear grey  (~43 px mean)
//        • σ = 35 px per pixel at 2300 Hz  → whites appear 29 px darker (226 vs 255)
//        • Overall RMS error: 17.3 px per pixel
//      N=8 = exactly one full period of 1500 Hz, so the 3000 Hz cross-term spans
//      exactly 2 full cycles and cancels perfectly:
//        • σ = 0 px at 1500 Hz → exact black, every time
//        • Error at 2300 Hz: only −5.3 px
//        • Overall RMS error: 1.9 px  (9× improvement)
//      Pixel blurring: N=8 spans 1.46 M1-pixels / 1.54 S1-pixels / 2.91 M2-pixels.
//      The accuracy gain far outweighs the mild softening on short-pixspan modes.
//
//  [10] OUTPUT GAMMA  (options.gamma, default 0.90, runtime-adjustable via setGamma())
//       A 256-entry lookup table is applied to every decoded pixel before emission.
//       gamma < 1 brightens midtones while preserving blacks (0→0) and whites (255→255).
//       At the default gamma = 0.90:
//         pixel  64  (1700 Hz, dark-mid) →  73  (+9 px)
//         pixel 128  (1900 Hz, mid-grey) → 138  (+10 px)
//         pixel 191  (2100 Hz, light-mid)→ 199  (+8 px)
//         pixel 255  (2300 Hz, white)    → 255  (exact, unchanged)
//       Applied to R/G/B channels in Martin/Scottie, and to the final RGB output
//       of the YCbCr→RGB conversion in Robot 36 (not to Y/Cb/Cr before conversion,
//       which would shift chroma).
//       Set options.gamma = 1.0 or call setGamma(1.0) for spec-accurate output.
//
//  [11] GOERTZEL BIN FORMULA  (_goertzel — removed erroneous +0.5 offset)
//       Old:  k = Math.round(0.5 + len×freq/sr)  ≡ Math.ceil for non-integers,
//             but = integer+1 when len×freq/sr is an exact integer.
//       All SSTV VIS frequencies are multiples of 100 Hz; all VIS window sizes
//       are multiples of 120 samples (12000÷100=120), so every VIS Goertzel call
//       produced an exact integer and was evaluated one DFT bin too high.
//       Power at ±1 bin from a pure tone = sin(π×1)/sin(π÷N) → 0 (DFT null).
//       Result: every leader / break / bit / start / stop Goertzel returned 0,
//       making VIS header detection and mode recognition completely fail.
//       The bug was masked before by broadband noise filling the wrong bins; the
//       bandpass filter ([3]) cleaned the signal so the zeros became exact.
//       Fix:  k = Math.max(1, Math.round(len×freq/sr))  — correct bin, full power.
//
//  [12] SCOTTIE DX  (scottieDX, VIS=76, 320×256)
//       Same decoder family as Scottie S1/S2.  chanMs = 345.6 ms (2.5× S1).
//       lineMs = porch + G + sep + B + sep + sync + porch + R
//              = 1.5 + 345.6 + 1.5 + 345.6 + 1.5 + 9.0 + 1.5 + 345.6 = 1051.8 ms.
//       256 lines ≈ 269 seconds total (~4.5 min).
//
//  [13] ROBOT 72  (robot72, VIS=12, 320×240)
//       Reuses the Robot 36 YCbCr decoder (family = 'robot36').
//       Scan times doubled: yMs = 176 ms, cMs = 88 ms, lineMs = 282 ms.
//       240 lines ≈ 67.7 seconds.  (The "72" label in common usage is
//       approximate — some references define it as 300 ms/line for exactly
//       72 s, using yMs=188/cMs=94; 282 ms is the exact 2× Robot 36 value.)
//
//  [14] BUFFER GROWTH BUG FIXED  (_detectVIS → _processPos advance)
//       When the decoder runs in VIS-detection-only mode (no mode lock),
//       _processPos was never advanced, so _ensureCapacity never compacted
//       the buffer and it doubled indefinitely on long sessions with no
//       SSTV signal.  Fix: advance _processPos alongside _visScanPos in
//       _detectVIS(), retaining one leader's worth of look-back context.
//
//  [15] LOST SYNC RECOVERY  (_lostSyncCount acted upon)
//       _lostSyncCount was tracked but never read.  Now:
//         > 6 consecutive losses → widen _findSyncNear() search to ±80 ms
//         >12 consecutive losses → abandon mode, re-enter VIS/auto detection
//       Handles QSB fades and burst interference without hanging until
//       end-of-frame.
//
//  [16] HALF-WINDOW CLAMP  (_decodeLine, _decodeLineRobot36)
//       For modes where estLen > pixSpan (Martin M2, Scottie S2, Robot
//       chroma), the estimation window start was calculated as:
//         s = segStart + x*pixSpan - halfExtra
//       At x=0, this gives s < segStart (before the channel boundary),
//       pulling in separator or porch samples that systematically darken
//       the leftmost pixels.  Fix: clamp s to [segStart, segEnd−estLen].
//
//  [17] AUTO-MODE COOLDOWN  (_tryAutoMode)
//       _tryAutoMode() was called on every feedPCM() chunk until a mode
//       locked, repeating a ~1.6 M-multiply scan on each call.  Now
//       gated behind a 500 ms advance in _bufLen so it fires at most
//       twice per second during the detection phase.
//
//  [18] FFT ESTIMATOR REWRITE  (slowrx / KiwiSDR method)  ← supersedes [8][9][13][16]
//       The pixel frequency estimator was changed from arccos lag-1
//       autocorrelation to a Hann-windowed, zero-padded 1024-pt FFT with
//       Gaussian log peak-interpolation (_estimateFreqFFT), sampled at each
//       pixel CENTRE.  This removes the tone-period-locked N=8 window (which
//       blurred the fast modes) and is far more accurate per pixel.
//       Decode rate raised 12 kHz → 48 kHz for adequate samples/pixel on the
//       fast modes; the IIR bandpass is now designed from the rate (_designBiquad)
//       so nothing is hand-tuned to 12 kHz.  Mode timings corrected to slowrx
//       values (Scottie S1 428.38, DX 1050.3).  Robot 72 given its true
//       full-colour-per-line structure (Y+R−Y+B−Y, _decodeLineRobot72), no
//       longer modelled as "2× Robot 36".  Robot 72 later corrected to the
//       138/69/69 ms unequal-channel structure.  The arccos estimator was fully
//       removed: sync-pulse frequency calibration now uses the SAME FFT estimator
//       as the pixels (_estimateFreqFFTRaw over 1000–1500 Hz) — mixing arccos
//       calibration with FFT pixels left a constant bias that tinted neutral
//       chroma below 128, a uniform green cast on the Robot modes.
//
//  [19] SPECTRAL NOISE FLOOR  (_updateNoiseSpectral)  ← fixes [the gate added in 18a]
//       The signal-presence gate measured its noise floor with a minimum
//       tracker over the block RMS.  SSTV is frequency modulation, so its
//       envelope is CONSTANT: a minimum tracker never sees a lower value
//       during a transmission.  Enabling the decoder while a picture was
//       already being sent therefore pinned the "noise" floor to the signal
//       itself and the gate never opened — measured: 0 lines at every signal
//       level tested, up to +28 dB SNR.  With a clean calibration the floor
//       still measured signal+noise, putting the usable threshold near
//       +6 dB SNR, far above what the demodulator can handle.
//       The floor is now the MEDIAN in-band FFT bin power over a 21 ms window:
//       one tone contaminates well under half the bins even while sweeping, so
//       the median is the noise whether or not a signal is present.  Measured
//       against known noise it is within ~5% of the true band-passed RMS (a
//       CAL factor corrects the zero-padding bias, which matters because
//       _syncQualityFloor squares it).  _minSnr 1.5 → 1.15.
//       Result: locks from mid-transmission at every level, and the weak-signal
//       limit moved +6.4 dB → about 0 dB SNR.  False-trigger suite: 14/14 clean.
//
//  [20] SYNC-LOST PATH  (_syncQualityFloor, _minSyncTonality, sync hit-rate)
//       "12 consecutive sync misses → abandon" never fired: measured on pure
//       noise, 87 of 87 lines were accepted as genuine sync hits, so a lock on
//       nothing was never released (a faded picture dead-reckoned forever, and
//       a forced start on an empty channel painted to the end of the frame).
//       Cause: _syncQualityFloor modelled E[Goertzel] as N·σ², true only for
//       noise that is white across the spectrum.  The buffer is band-passed to
//       1000–2500 Hz, so the density at 1200 Hz is ~8.7× that, and the noise
//       MAXIMUM over the ~300 positions probed reached 42·N·σ² — five times the
//       floor meant to exclude it.  The floor is now built on the measured
//       in-band density (_noisePsd, from the same median FFT as the noise floor,
//       calibrated against the Goertzel mean), not on nf².
//       With honest floors the accept rate is 0.000 on noise, 0.93 at +6.4 dB,
//       0.48 at +2.9 dB and 0.11 at +0.4 dB — so the ABANDON decision moved off
//       the per-line test onto a hit-RATE over ≥20 lines (bar 0.05, just above
//       zero).  The consecutive-miss backstop went 12 → 40: at +0.4 dB a real
//       picture misses 89% of its lines yet decodes fine by dead reckoning, and
//       12 in a row would have thrown it away mid-image.
//       Measured after: noise abandoned 10/10 runs at ~20 lines; +6.4/+2.9 dB
//       10/10 decoded; +0.4 dB 8/10, matching the behaviour before the change.
//
//  [21] QSB / QRM SURVIVAL  (proven locks, time-based abandon, draw hold)
//       Reported symptom: the decoder gave up mid-picture on fades and on short
//       bursts of interference.  Reproduced with a synthetic generator (Martin
//       M1 / Robot 36 + AWGN + programmable fade and QRM burst):
//         • Robot 36, +3 dB, a 3 s fade  → lock abandoned, image restarted
//         • Robot 36, +6 dB, a 2 s QRM burst → 10/10 runs broke the frame
//         • Martin M1, 0 dB, a 3 s fade  → abandoned after 11 misses
//       Three causes, all in the abandon path added by [20]:
//         a) The hit-RATE rule stayed armed for the whole frame.  It is meant to
//            ask "was this lock ever real", but a genuine picture at +0.4 dB runs
//            at an accept rate of 0.11 — only ~5 lines of EMA above the 0.05 bar —
//            so any ordinary fade crossed it.  The rule is now disarmed once the
//            lock has produced _provenHits (5) accepted pulses.  On pure noise the
//            accept rate is 0.000, so a false lock never proves itself and still
//            dies in ~20 lines: measured 0/10 locks on 30 s of noise, unchanged.
//         b) The consecutive-miss backstop was a fixed 40 lines, i.e. 2.7 s on
//            Robot 36 but 8 s on Martin M1 — and the rate rule fired first
//            anyway, at ~18 misses.  A proven lock is now released only after
//            _maxLostSeconds (12 s) of continuous absence, converted to lines per
//            mode.  A fade is dead-reckoned through: the line timing is
//            free-running, so the picture resumes IN REGISTER, whereas abandoning
//            re-acquires via AUTO and restarts at line 0, destroying the frame.
//         c) _lastSyncQuality (the relative bar, quality > last·0.35) was updated
//            only on hits, so after a fade it stayed anchored to the pre-fade
//            level and rejected the weaker pulses QSB recovery actually returns.
//            It now decays 0.93 per missed line.
//       Holding a lock through a dropout must not mean PAINTING the dropout, so
//       rows are no longer emitted after _holdSeconds (4 s) without sync — the
//       line counter and anchor still advance, keeping the geometry.
//       Measured, 10 runs each (old → new):
//         pure noise 30 s        0/10 locks  → 0/10 locks   (unchanged)
//         R36 +6 dB, 2 s QRM     1.0 unlocks/run, longest run 48 lines
//                                → 0 unlocks, longest run 100 lines
//         R36 +6 dB, 3 s fade    abandoned   → rides through
//         M1  +10 dB, 10 s fade  abandoned   → rides through
//         M1  +10 dB, 18 s fade  abandoned   → still abandoned (signal is gone)
//         M1 full frames by SNR  0 dB 0/8 → 2/8, +1 dB 1/8 → 3/8,
//                                +2 dB 3/8 → 5/8, +3 dB 6/8 → 6/8, +5 dB 8/8 → 8/8
//       Cost of the trade: after a real end of transmission the decoder paints up
//       to _holdSeconds of dead-reckoned rows before it stops drawing, and holds
//       the mode badge for up to _maxLostSeconds before releasing it.
// ─────────────────────────────────────────────────────────────────────────────

import { transformFlat } from './lib/fftRadix2.js';

export class KiwiSSTVDecoder {

  // ── Construction / configuration ──────────────────────────────────────────

  constructor(options = {}) {
    this._sampleRateFn = typeof options.sampleRate === 'function'
      ? options.sampleRate
      : (() => options.sampleRate || 12000);
    this._callback   = typeof options.callback === 'function' ? options.callback : null;
    this._forcedMode = options.defaultMode || 'auto';
    this._gamma      = (typeof options.gamma === 'number' && options.gamma > 0) ? options.gamma : 0.90;
    // Horizontal unsharp-mask amount applied to decoded lines.  The pixel
    // frequency estimator averages over an ~8-sample window that is wider than
    // one pixel in the fast modes (Martin M2, Scottie S2, Robot chroma),
    // producing a horizontal box-blur.  The unsharp pass counteracts that known
    // blur.  0 = off, ~0.55 = moderate.  Runtime-adjustable via setSharpen().
    this._sharpen    = (typeof options.sharpen === 'number' && options.sharpen >= 0) ? options.sharpen : 0.55;
    this._enabled    = false;
    this.reset({ mode: this._forcedMode });
  }

  setEnabled(enabled) {
    this._enabled = !!enabled;
    if (!this._enabled) this.reset({ mode: this._forcedMode });
  }

  setCallback(fn) {
    this._callback = typeof fn === 'function' ? fn : null;
  }

  setMode(mode) {
    this._forcedMode = mode || 'auto';
    if (this._callback) {
      this._callback({
        type: 'status',
        text: this._forcedMode === 'auto'
          ? 'AUTO mode detect'
          : `Forced ${this._forcedMode.toUpperCase()}`
      });
    }
    this._mode          = null;
    this._needFreshSync = true;
    this._line          = 0;
  }

  // Adjust output gamma at runtime.  gamma=0.90 (default) brightens midtones
  // by ~10 px.  gamma=1.0 gives spec-accurate output.  Rebuilds the LUT instantly.
  setGamma(g) {
    this._gamma = (typeof g === 'number' && g > 0 && g <= 3.0) ? g : 0.90;
    this._buildGammaLUT();
  }

  // Adjust the horizontal unsharp-mask amount at runtime.  0 = off (spec-accurate
  // softness), ~0.55 = moderate sharpening, up to ~2.0 for aggressive.  At high SNR
  // this recovers apparent detail lost to the estimator's box-blur; on noisy
  // signals keep it low, as sharpening also amplifies pixel noise.
  setSharpen(a) {
    this._sharpen = (typeof a === 'number' && a >= 0 && a <= 3.0) ? a : 0.55;
  }

  // ── Horizontal unsharp mask ────────────────────────────────────────────────
  //
  // Counteracts the box-blur left by the fixed-width frequency estimator window.
  // For each channel:  out = clamp(orig + amount·(orig − boxBlur(orig, radius))).
  // `radius` is sized to the FFT window's blur width (winLen / pixSpan, in pixels)
  // so the correction matches the actual softening — wider for the fast modes.
  // Operates in place on an RGBA Uint8ClampedArray; alpha (channel 3) untouched.
  _sharpenLine(out, W, radius) {
    const amount = this._sharpen;
    if (!(amount > 0) || W < 3) return out;
    const r = Math.max(1, Math.min(6, Math.round(radius)));
    const win = 2 * r + 1;
    // Work on a plain copy of each channel so the blur uses original values.
    const orig = new Float32Array(W);
    for (let c = 0; c < 3; c++) {
      for (let x = 0; x < W; x++) orig[x] = out[x * 4 + c];
      // Box blur via running sum (edge-clamped).
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += orig[Math.max(0, Math.min(W - 1, k))];
      for (let x = 0; x < W; x++) {
        const blur = acc / win;
        const sharp = orig[x] + amount * (orig[x] - blur);
        out[x * 4 + c] = sharp < 0 ? 0 : sharp > 255 ? 255 : sharp;
        // Slide the window: drop x−r, add x+r+1 (both edge-clamped).
        const drop = Math.max(0, Math.min(W - 1, x - r));
        const add  = Math.max(0, Math.min(W - 1, x + r + 1));
        acc += orig[add] - orig[drop];
      }
    }
    return out;
  }

  reset(opts = {}) {
    if (opts.mode) this._forcedMode = opts.mode;

    // Decode at a high internal rate (Kiwi/slowrx-class) so the fast modes have
    // enough samples per pixel for the FFT frequency estimator.  Everything below
    // (filter design, mode timing, sync/VIS windows) is derived from this, so the
    // rate can be changed here alone.
    this._decodeSps     = 48000;
    // ── FFT frequency-estimator scratch (Hann-windowed, zero-padded to _fftN) ─
    this._fftN          = 1024;
    this._fftRe         = new Float64Array(this._fftN);
    this._fftIm         = new Float64Array(this._fftN);
    this._hannCache     = new Map();   // winLen -> Float64Array Hann window
    this._inSps         = this._sampleRateFn() || 12000;
    this._resampleRatio = this._inSps / this._decodeSps;
    this._resamplePhase = 0.0;
    this._resampleLast  = 0.0;   // raw (pre-filter) last input sample

    this._buf        = new Float32Array(this._decodeSps * 20);
    this._bufLen     = 0;
    this._processPos = 0;
    this._visScanPos = 0;
    this._jitterLead = Math.floor(this._decodeSps * 0.45);

    this._mode            = null;
    this._detectedMode    = '';
    this._visConfidence   = 0;
    this._autoScore       = 0;
    this._syncAnchor      = 0;
    this._line            = 0;
    this._needFreshSync   = true;
    this._lastSyncQuality = 0;
    this._lostSyncCount   = 0;
    this._imageW          = 320;
    this._imageH          = 256;

    // ── Frequency calibration ──────────────────────────────────────────────
    this._freqOffset      = 0;
    this._freqOffsetCount = 0;

    // ── Auto-mode cooldown ─────────────────────────────────────────────────
    // _tryAutoMode() is expensive (~1.6M mults per call).  Only re-run
    // when _bufLen has advanced by at least 500 ms since the last attempt.
    this._lastAutoAttemptPos = 0;

    // ── AUTO detector acceptance (see _tryAutoMode) ────────────────────────
    // Probe N predicted sync pulses per candidate anchor and require the
    // _autoQuantile-th weakest of them to clear _autoMinQ.  Measured
    // acquisition floor: ~+4 dB with 4-of-4 at 0.50, ~−2 dB with these.
    this._autoProbeLines = 8;
    this._autoMinValid   = 6;      // fewer than this fit in the buffer → skip
    this._autoQuantile   = 0.25;   // 25th percentile ≈ "second weakest of 8"
    this._autoMinScore   = 0.34;
    this._autoMinQ       = 0.34;
    this._autoMinMargin  = 0.04;   // vs the best OTHER mode, not another anchor
    this._autoLineScores = new Float64Array(this._autoProbeLines);
    // How far back _processPos must leave intact for the anchor search to have
    // anything to search.  Probing 8 Martin/Scottie lines spans ~3.6 s, but the
    // buffer housekeeping used to retain only the 1.1 s VIS leader — so
    // anchorMax fell below anchorMin and the AUTO scan silently examined ZERO
    // anchors.  Anything that advances _processPos must honour this.
    //
    // Sized for the slowest mode: Scottie DX has 1050 ms lines, so 6 probes plus
    // one line period of anchor phase needs ~7.4 s.  Retaining audio is only
    // memory (the buffer holds 20 s) — the CPU cost is anchors, and that is
    // bounded to one line period in _tryAutoMode regardless of this.
    this._autoLookBack = Math.round(8.0 * this._decodeSps);

    // ── Signal-presence gate (see _updateLevels / _gateOpen) ───────────────
    // Every detection metric in this file is a power RATIO, and ratios are
    // scale-invariant: receiver noise with no signal at all produces the same
    // statistics as a weak transmission, so a single static crash could start
    // the decoder.  These trackers add the missing ABSOLUTE reference.
    this._noiseFloor  = 0;      // spectral (median-bin) noise RMS — see _updateNoiseSpectral
    this._sigRms      = 0;      // fast RMS of the band-passed input
    this._levelInit   = false;
    this._noisePos    = 0;      // samples since the last spectral noise measurement
    this._noiseBins   = null;   // scratch for the median
    this._gateOpenPos = -1e12;  // _bufLen position at which the gate last saw signal
    // The gate compares total band RMS against the noise floor, so it reads
    // sqrt(1 + SNR): 1.15 corresponds to roughly −4 dB SNR in the 1.5 kHz decode
    // band.  False-alarm rejection is the job of tonality + lock confirmation
    // below; this gate exists only to keep the detectors off bare noise, and it
    // must never be the reason a weak but decodable transmission is missed.
    //
    // It was exactly that.  At 1.15 the gate demanded sqrt(1+SNR) > 1.15, i.e.
    // better than −4.9 dB, and closed over signals the VIS detector could still
    // read: measured acquisition at −4.3 dB was 1/20 at 1.15 against 6/20 at
    // 1.05, with pure noise producing zero locks at either setting (6 min × 2
    // levels).  1.05 (≈ −13 dB) keeps an absolute reference — the detectors
    // still have their own noise-referenced floors — without being the binding
    // constraint.  Below about −6 dB nothing acquires anyway, and that limit is
    // now set by the detectors rather than by this gate.
    this._minSnr      = 1.05;
    this._minTonality = 0.10;   // 1200 Hz bin / total window energy (see _syncTonality)
    this._noisePsd    = 0;      // measured in-band noise density (see _updateNoiseSpectral)
    // Floors for the POST-lock sync test, i.e. "is this lock still real".  Both
    // are set just above the measured noise maximum: over pure noise the sync
    // search reaches qRatio 9.6 and tonality 0.228 at the 95th percentile, while
    // a genuine pulse at +5 dB SNR sits at 20 and 0.35.  Below ~0 dB the two
    // distributions overlap — that is unavoidable for a 4.9 ms pulse — but a
    // rejected line is still DEAD-RECKONED and drawn, so weak pictures decode
    // exactly as before.  The only thing these thresholds decide is whether the
    // decoder keeps believing in the lock.
    this._syncFloorK      = 8;
    this._minSyncTonality = 0.20;
    // Abandon decision.  Deliberately NOT the per-line thresholds: making those
    // strict enough to detect a dead signal within a dozen lines also rejected
    // real weak pulses (measured: +0.4 dB decoded 3/10 instead of 7/10).  The two
    // questions are separate — "is this line's sync trustworthy" is per-line and
    // may be wrong often on a weak signal, while "is there still a signal" is a
    // RATE over many lines, where noise (~25% accepted) and a weak but real
    // picture (~60%) separate cleanly.
    // MEASURED accept rates with the floors above: pure noise 0.000, a real
    // picture 0.93 at +6.4 dB, 0.48 at +2.9 dB and 0.11 at +0.4 dB.  Noise is
    // not "low", it is zero, so the bar sits just above zero — anything a real
    // signal produces survives, and a lock on nothing dies.  A signal below this
    // is one whose sync is never found at all, which is indistinguishable from
    // noise by any means available here.
    // The rate rule answers "was this lock ever real at all", so it is armed
    // only until the lock has PROVEN itself with a handful of accepted pulses.
    // Measured accept rate on pure noise is 0.000, so a false lock never proves
    // itself and still dies in ~20 lines; a real picture proves itself within a
    // few lines at any workable SNR.  Leaving the rate rule armed for the whole
    // frame was the bug behind "gives up during QSB": at +0.4 dB a genuine
    // picture runs at an accept rate of 0.11, only ~5 lines of EMA above the
    // 0.05 bar, so an ordinary fade crossed it and threw the frame away.
    this._syncHitRate     = 1;
    this._syncLines       = 0;
    this._syncHits        = 0;
    this._minSyncHitRate  = 0.05;
    this._minRateLines    = 20;   // EMA needs ~20 lines to fall from 1 to 0.04
    this._provenHits      = 5;    // accepted pulses after which the rate rule disarms
    // Once proven, the only thing that ends a lock is a sustained ABSENCE of
    // sync, measured in SECONDS rather than lines — the previous fixed 40-line
    // backstop meant 2.7 s on Robot 36 but 8 s on Martin M1, and the rate rule
    // fired even sooner.  QSB fades of 3-8 s are ordinary on HF, and the frame
    // survives them by dead reckoning: the line timing is free-running, so a
    // faded picture resumes in register while abandoning restarts it at line 0.
    this._maxLostSeconds  = 12;
    this._maxLostLinesMin = 25;   // ...but never fewer than this many lines
    this._maxLostLinesMax = 90;   // ...nor more (Robot 36 would reach 80)
    // Holding the lock through a fade should not mean PAINTING the fade.  After
    // this long with no accepted sync there is no picture in the audio either,
    // so the dead-reckoned rows are noise: keep decoding and keep the line
    // timing running (that is what lets the picture resume in register), but
    // stop emitting until sync comes back.  Without this, riding out a 12 s
    // dropout wrote 12 s of static across the image.
    this._holdSeconds     = 4;
    this._holdLinesMin    = 10;
    this._holdLinesMax    = 40;
    this._gateHold    = Math.round(2.0 * this._decodeSps);   // hangover after signal drops

    // ── Lock confirmation (AUTO / FORCED only — VIS is parity-checked) ─────
    // An AUTO lock is the MAXIMUM over ~7 modes × hundreds of anchors, so noise
    // wins it far more often than the per-anchor probability suggests.  Rather
    // than tightening the search further, a provisional lock must now predict
    // sync pulses on lines it has NOT seen yet before anything is drawn.
    // Horizontal placement correction, measured per mode (see _videoTimingAdjust).
    this._videoTimingAdj   = 0;
    this._videoTimingCache = new Map();

    this._confirmLeft        = 0;   // probes still to run
    this._confirmHits        = 0;   // predicted pulses that were actually there
    this._confirmProbes      = 6;   // probe this many predicted sync pulses...
    this._confirmNeed        = 3;   // ...and require this many hits (not a run)
    this._confirmNext        = 0;   // running anchor of the probe sequence
    this._confirmStartAnchor = 0;   // anchor to rewind to once confirmed
    this._confirmVia         = 'AUTO';
    this._modeKey            = null;

    // ── IIR bandpass filter (designed for the current decode rate) ──────────
    // 4th-order Butterworth bandpass = HP 1000 Hz cascaded with LP 2500 Hz,
    // Q = 1/√2, transposed direct-form II.  Coefficients are computed from
    // _decodeSps (RBJ Audio-EQ-Cookbook formulas) so the passband is correct at
    // any rate.  Passband ~1000–2500 Hz covers VIS bits (1100/1300), sync (1200),
    // and the 1500–2300 Hz video band.
    const _hp = this._designBiquad('hp', 1000, Math.SQRT1_2, this._decodeSps);
    const _lp = this._designBiquad('lp', 2500, Math.SQRT1_2, this._decodeSps);
    this._hp_b = _hp.b; this._hp_a = _hp.a; this._hp_z = [0.0, 0.0];
    this._lp_b = _lp.b; this._lp_a = _lp.a; this._lp_z = [0.0, 0.0];

    // ── Robot 36 inter-line chroma buffer ─────────────────────────────────
    // Even lines (Cb) are held here until the following odd line (Cr) arrives,
    // then both rows are emitted together.
    this._r36_pendingY    = null;   // Uint8Array(320) or null
    this._r36_pendingCb   = null;   // buffered chroma (R−Y or B−Y per _r36_pendingIsRY)
    this._r36_pendingIsRY = false;  // true if the buffered chroma is R−Y (Cr), else B−Y (Cb)
    this._r36_pendingLine = -1;     // visual line number of the buffered row

    // Build (or rebuild) the output gamma lookup table.
    this._buildGammaLUT();

    // ── Mode table ─────────────────────────────────────────────────────────
    this._modes = {
      // ── RGB modes (Martin / Scottie families) ───────────────────────────
      martin1: {
        name: 'Martin M1', vis: 44, width: 320, height: 256,
        family: 'martin',
        syncMs: 4.862, porchMs: 0.572, sepMs: 0.572,
        chanMs: 146.432, lineMs: 446.446, order: ['g', 'b', 'r']
      },
      martin2: {
        name: 'Martin M2', vis: 40, width: 320, height: 256,
        family: 'martin',
        syncMs: 4.862, porchMs: 0.572, sepMs: 0.572,
        chanMs: 73.216, lineMs: 226.798, order: ['g', 'b', 'r']
      },
      scottie1: {
        name: 'Scottie S1', vis: 60, width: 320, height: 256,
        family: 'scottie',
        syncMs: 9.0, porchMs: 1.5, sepMs: 1.5,
        chanMs: 138.240, lineMs: 428.38, order: ['g', 'b', 'r']
      },
      scottie2: {
        name: 'Scottie S2', vis: 56, width: 320, height: 256,
        family: 'scottie',
        syncMs: 9.0, porchMs: 1.5, sepMs: 1.5,
        chanMs: 88.064, lineMs: 277.692, order: ['g', 'b', 'r']
      },
      scottieDX: {
        // Scottie DX — slow, high-quality; very common on 14.230 MHz DX QSOs.
        // Line: porch(1.5) + G(345.6) + sep(1.5) + B(345.6) + sep(1.5)
        //     + sync(9.0) + porch(1.5) + R(345.6) = 1051.8 ms.
        // 256 lines ≈ 269 s total (~4.5 min).
        name: 'Scottie DX', vis: 76, width: 320, height: 256,
        family: 'scottie',
        syncMs: 9.0, porchMs: 1.5, sepMs: 1.5,
        chanMs: 345.77, lineMs: 1050.3, order: ['g', 'b', 'r']
      },

      // ── YUV modes (Robot family) ─────────────────────────────────────────
      // Robot 36 (family 'robot36'): sync(9) + porch(3) + Y(88) + sep(6) +
      //   chroma(44).  Y at 0.275 ms/px, ONE chroma at 0.1375 ms/px, the chroma
      //   alternating R−Y / B−Y line-to-line (selected by the separator tone).
      //   Chroma is subsampled 2:1 vertically (paired across two lines).
      robot36: {
        name: 'Robot 36', vis: 8, width: 320, height: 240,
        family: 'robot36',
        syncMs: 9.0, porchMs: 3.0, sepMs: 6.0,
        yMs: 88.0, cMs: 44.0, lineMs: 150.0
      },
      // Robot 72 (family 'robot72'): FULL colour every line, but UNEQUAL channels
      //   — Y = 138 ms (0.4313 ms/px) then R−Y = 69 ms and B−Y = 69 ms (chroma at
      //   2× the luma pixel rate, still 320 px each), separated by 4.7 ms.
      //   sync(9)+porch(3)+Y(138)+sep(4.7)+R−Y(69)+sep(4.7)+B−Y(69) ≈ 300.
      //   (NOT "2× Robot 36", and NOT three equal channels — own decoder path.)
      robot72: {
        name: 'Robot 72', vis: 12, width: 320, height: 240,
        family: 'robot72',
        syncMs: 9.0, porchMs: 3.0, sepMs: 4.7,
        yMs: 138.0, cMs: 69.0, lineMs: 300.0
      }
    };
    this._visMap = new Map(
      Object.entries(this._modes).map(([k, v]) => [v.vis, k])
    );
  }

  destroy() {
    this._enabled        = false;
    this._callback       = null;
    this._buf            = new Float32Array(0);
    this._bufLen         = 0;
    this._r36_pendingY   = null;
    this._r36_pendingCb  = null;
  }

  // ── Audio ingestion ───────────────────────────────────────────────────────

  feedPCM(pcm) {
    if (!this._enabled || !pcm || pcm.length === 0) return;

    const inSr = this._sampleRateFn() || this._inSps || 12000;
    if (!Number.isFinite(this._resampleRatio) || Math.abs(inSr - this._inSps) > 1) {
      this._inSps         = inSr;
      this._resampleRatio = inSr / this._decodeSps;
    }

    const estOut = Math.ceil(pcm.length / this._resampleRatio) + 4;
    this._ensureCapacity(estOut);

    let phase = this._resamplePhase;
    let last  = this._resampleLast;
    const ratio = this._resampleRatio;
    let sumSq = 0, produced = 0;

    for (let i = 0; i < pcm.length; i++) {
      const cur = pcm[i];
      // Resample to the decode rate first (linear interpolation), then apply the
      // bandpass filter at that rate so the IIR coefficients are correct.
      while (phase <= 1.0) {
        const s = last + (cur - last) * phase;
        const y = this._bpFilter(s);
        this._buf[this._bufLen++] = y;
        sumSq += y * y;
        produced++;
        phase += ratio;
      }
      phase -= 1.0;
      last = cur;
    }
    this._resamplePhase = phase;
    this._resampleLast  = last;
    if (produced > 0) {
      // Noise floor first: _updateLevels compares against it in the same call.
      this._noisePos = (this._noisePos || 0) + produced;
      if (this._noisePos >= this._decodeSps * 0.25) {
        this._noisePos = 0;
        this._updateNoiseSpectral();
      }
      this._updateLevels(Math.sqrt(sumSq / produced));
    }
    this._process();
  }

  // ── Signal-presence gate ────────────────────────────────────────────────────
  //
  // `blockRms` is the RMS of the band-passed (1000–2500 Hz) audio just added.
  // Two trackers are derived from it:
  //
  //   _sigRms     — fast EMA (≈3 blocks), "how loud is the band right now"
  //   _noiseFloor — minimum tracker: falls quickly, rises very slowly, and does
  //                 NOT rise at all while a mode is locked.  Freezing the rise
  //                 during a lock matters because a Scottie DX frame runs 4.5
  //                 minutes — long enough for a plain EMA floor to creep up onto
  //                 the signal it is supposed to be measured against.
  //
  // The gate opens at _minSnr (+6 dB) and holds open for _gateHold (2 s) after
  // the level drops, so brief fades inside a transmission do not close it.
  _updateLevels(blockRms) {
    this._sigRms = this._levelInit ? this._sigRms + 0.30 * (blockRms - this._sigRms)
                                   : blockRms;
    if (this._levelInit && this._sigRms > this._noiseFloor * this._minSnr) {
      this._gateOpenPos = this._bufLen;
    }
  }

  // Noise floor, measured SPECTRALLY as the median in-band bin power.
  //
  // This replaced a minimum-tracker over the block RMS, which had two failures
  // that between them made the decoder deaf:
  //
  //   1. SSTV is frequency modulation — its envelope is CONSTANT.  A minimum
  //      tracker therefore never sees a lower value during a transmission, so
  //      enabling the decoder while a picture is already being sent pinned the
  //      "noise" floor to the signal itself.  The gate then never opened, at
  //      ANY signal strength, for the whole transmission.  Switching the
  //      decoder on because you can hear SSTV is the normal way to use it.
  //   2. Even with a clean calibration the floor measured signal+noise, so the
  //      usable threshold sat around +6 dB SNR — far above what the decoder can
  //      actually demodulate.
  //
  // The median is immune to both: an SSTV signal is one tone at a time, so over
  // a 21 ms window it contaminates well under half of the ~128 in-band bins even
  // while sweeping, and the median of the rest is the noise.  Converted back to
  // the band-passed time-domain RMS that the gate and _syncQualityFloor expect:
  // E[P] = median/ln2 for exponentially distributed bin powers, divided by the
  // window energy Σw², and scaled by the band fraction.
  _updateNoiseSpectral() {
    const N = this._fftN, sr = this._decodeSps;
    const L = Math.min(256, N);
    if (this._bufLen < L) return;

    const re = this._fftRe, im = this._fftIm;
    re.fill(0); im.fill(0);
    const hann  = this._hannFor(L);
    const start = this._bufLen - L;
    for (let i = 0; i < L; i++) re[i] = this._buf[start + i] * hann[i];
    transformFlat(re, im, false);

    const loBin = Math.max(1, Math.floor(1000 * N / sr));
    const hiBin = Math.min((N >> 1) - 1, Math.ceil(2500 * N / sr));
    const n     = hiBin - loBin + 1;
    if (n < 8) return;
    if (!this._noiseBins || this._noiseBins.length !== n) this._noiseBins = new Float64Array(n);
    const pw = this._noiseBins;
    for (let k = loBin; k <= hiBin; k++) pw[k - loBin] = re[k] * re[k] + im[k] * im[k];
    pw.sort();
    const median = pw[n >> 1];

    let sumW2 = 0;
    for (let i = 0; i < L; i++) sumW2 += hann[i] * hann[i];
    // CAL corrects the median/ln2 step: the window is zero-padded into the FFT,
    // so neighbouring bins are correlated and the bin powers are not quite the
    // independent exponentials that identity assumes.  Measured against the true
    // band-passed RMS of known noise, the raw estimate lands ~0.80 of it.  The
    // factor matters because _syncQualityFloor squares this — an under-estimate
    // would quietly lower the false-lock bar it exists to enforce.
    const CAL      = 1.25;
    const bandFrac = (2500 - 1000) / (sr * 0.5);
    const psdRaw   = (median / Math.LN2) / sumW2;
    const varBand  = psdRaw * bandFrac;
    const nf       = CAL * Math.sqrt(Math.max(varBand, 0));

    // Same measurement expressed as the per-sample noise power density that an
    // UNWINDOWED Goertzel of the sync pulse sees: E[Goertzel over N] = N·psd.
    // PSD_CAL is the Hann-window/zero-padding correction, measured against the
    // Goertzel mean over pure noise at three levels (0.885, stable to ±1.5%).
    // The sync floors are built on this rather than on nf², because nf² only
    // predicts the Goertzel mean for noise that is white across the spectrum.
    const PSD_CAL = 1.13;
    const psd     = PSD_CAL * psdRaw;

    if (!this._levelInit) {
      this._levelInit = true;
      this._noiseFloor = nf;
      this._noisePsd   = psd;
    } else {
      this._noiseFloor += 0.25 * (nf - this._noiseFloor);
      this._noisePsd   += 0.25 * (psd - this._noisePsd);
    }
  }

  _gateOpen() {
    if (!this._levelInit) return false;
    return (this._bufLen - this._gateOpenPos) < this._gateHold;
  }

  // Absolute noise-referenced floor for the sync-pulse quality returned by
  // _findSyncNear (q = P1200 − 0.35·(P1500 + P1900), an UNNORMALISED Goertzel
  // power).  For band-passed noise of RMS σ, E[P] ≈ N·σ², so a pure-noise q
  // averages ≈0.3·N·σ² and its maximum over the ~300 positions _findSyncNear
  // probes lands near 6·N·σ².  A genuine sync pulse of amplitude A gives
  // (A·N/2)² — orders of magnitude larger — so 8·N·σ² sits comfortably between
  // the two.  This is the reference the decoder previously had nowhere: without
  // it the very first line was accepted at ANY quality > 0 (_lastSyncQuality
  // starts at 0), and the acceptance bar then tracked the noise itself, which is
  // what made a false lock self-sustaining.
  _syncQualityFloor(syncS) {
    // MEASURED density, not nf².  The original form assumed E[Goertzel] ≈ N·σ²,
    // which holds only for noise that is white across the whole spectrum.  The
    // buffer is band-passed to 1000–2500 Hz, so the same variance is packed into
    // a sixteenth of the band and the density at 1200 Hz is ~8.7× higher —
    // measured, the noise MAXIMUM over the ~300 positions _findSyncNear probes
    // reached 42·N·σ², five times the floor that was supposed to exclude it.
    // That is why a forced start on noise kept "finding" sync on every line.
    if (this._noisePsd > 0) return this._syncFloorK * syncS * this._noisePsd;
    const nf = this._noiseFloor;                      // pre-measurement fallback
    return 8.0 * syncS * nf * nf;
  }

  // Buffer housekeeping for chunks discarded by the gate: keeps the compaction
  // in _ensureCapacity working (otherwise _processPos stays put and the buffer
  // grows without bound during long quiet periods).  Retains ~1.1 s of look-back
  // so a VIS leader that starts while the gate is still closed is not lost.
  _idleCompact() {
    const need      = Math.floor(this._decodeSps * 1.05);
    const scanLimit = this._bufLen - need;
    if (scanLimit <= this._visScanPos) return;
    this._visScanPos = scanLimit;
    this._processPos = Math.max(this._processPos,
                                this._visScanPos - this._keepBack());
  }

  // Look-back that must survive buffer housekeeping: enough for one VIS leader
  // AND for the AUTO detector's multi-line probe span.
  _keepBack() {
    return Math.max(Math.round(this._decodeSps * 1.10), this._autoLookBack);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  _emit(event) {
    if (typeof this._callback === 'function') this._callback(event);
  }

  _ensureCapacity(extra) {
    if (this._bufLen + extra <= this._buf.length) return;
    if (this._processPos > 0) {
      const keep  = this._bufLen - this._processPos;
      const shift = this._processPos;
      this._buf.copyWithin(0, this._processPos, this._bufLen);
      this._bufLen     = keep;
      this._visScanPos = Math.max(0, this._visScanPos - shift);
      this._syncAnchor -= shift;
      this._processPos  = 0;
      // EVERY absolute buffer position has to be rebased here, not just the
      // three above.  The ones that were missed all compare against _bufLen,
      // so after a compaction they sat in the FUTURE and their comparisons
      // inverted permanently:
      //   • _lastAutoAttemptPos — (_bufLen - it) went negative, so the 500 ms
      //     cooldown never expired and _tryAutoMode() returned false forever.
      //     That is why decoding stopped after the first frame and only Reset
      //     (which zeroes it) brought it back: any image whose VIS header was
      //     missed had no AUTO fallback left.  A compaction is guaranteed
      //     during the first frame — the buffer holds 20 s, an image runs
      //     1–4½ min — so this bit every session, on the first image.
      //   • _gateOpenPos — same inversion, opposite effect: the signal-presence
      //     gate read permanently OPEN, running the detectors on bare noise.
      //   • _confirm* — a compaction inside the 4-line confirmation window
      //     pushed the probe anchor past the end of the buffer, so the lock
      //     could never confirm and the frame was silently dropped.
      this._lastAutoAttemptPos  = Math.max(0, this._lastAutoAttemptPos - shift);
      this._gateOpenPos        -= shift;
      this._confirmNext        -= shift;
      this._confirmStartAnchor -= shift;
      if (this._bufLen + extra <= this._buf.length) return;
    }
    const n = new Float32Array(
      Math.max(this._buf.length * 2, this._bufLen + extra + 8192)
    );
    n.set(this._buf.subarray(0, this._bufLen));
    this._buf = n;
  }

  // Build a 256-entry Uint8Array gamma lookup table from this._gamma.
  // Precomputing avoids calling Math.pow() per pixel (3 calls × 320 pixels × 256 lines
  // = ~245 k calls per frame).  gamma=1.0 produces the identity table.
  _buildGammaLUT() {
    const lut = new Uint8Array(256);
    if (this._gamma === 1.0) {
      for (let i = 0; i < 256; i++) lut[i] = i;
    } else {
      const inv = this._gamma;           // pow(x/255, gamma) * 255
      for (let i = 0; i < 256; i++) {
        lut[i] = Math.min(255, Math.round(255 * Math.pow(i / 255, inv)));
      }
    }
    this._gammaLUT = lut;
  }

  // ── Bandpass filter ───────────────────────────────────────────────────────
  //
  // 4th-order IIR bandpass (cascade of two Butterworth biquads, Fs = 12 kHz)
  // in transposed direct-form II.
  //
  // Passband: ~1000–2500 Hz (−3 dB)
  //   Covers: VIS bits (1100/1300 Hz), sync (1200 Hz), black (1500 Hz),
  //           white (2300 Hz), Robot 36 chroma (1500–2300 Hz)
  //   Rejects: mains hum, LF rumble, interference above ~2600 Hz
  //
  // To redesign for a different Fs use the Audio EQ Cookbook (Bristow-Johnson)
  // HP/LP formulas with Q = 1/√2.
  _bpFilter(x) {
    // Stage 1 — Highpass at 1000 Hz
    const y1      = this._hp_b[0] * x  + this._hp_z[0];
    this._hp_z[0] = this._hp_b[1] * x  - this._hp_a[0] * y1 + this._hp_z[1];
    this._hp_z[1] = this._hp_b[2] * x  - this._hp_a[1] * y1;

    // Stage 2 — Lowpass at 2500 Hz
    const y2      = this._lp_b[0] * y1 + this._lp_z[0];
    this._lp_z[0] = this._lp_b[1] * y1 - this._lp_a[0] * y2 + this._lp_z[1];
    this._lp_z[1] = this._lp_b[2] * y1 - this._lp_a[1] * y2;

    return y2;
  }

  // RBJ Audio-EQ-Cookbook biquad, normalised (a0=1).  Returns { b:[b0,b1,b2],
  // a:[a1,a2] } for the transposed-DF-II _bpFilter above.  type 'hp' | 'lp'.
  _designBiquad(type, f0, Q, fs) {
    const w0    = 2 * Math.PI * f0 / fs;
    const cw    = Math.cos(w0);
    const sw    = Math.sin(w0);
    const alpha = sw / (2 * Q);
    const a0    = 1 + alpha;
    let b0, b1, b2;
    if (type === 'hp') {
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
    } else { // 'lp'
      b0 = (1 - cw) / 2; b1 =  (1 - cw); b2 = (1 - cw) / 2;
    }
    const a1 = -2 * cw, a2 = 1 - alpha;
    return { b: [b0 / a0, b1 / a0, b2 / a0], a: [a1 / a0, a2 / a0] };
  }

  // ── FFT frequency estimator (slowrx / Kiwi method) ─────────────────────────
  //
  // Hann-windowed, zero-padded 1024-point FFT; peak bin in the 1400–2400 Hz
  // video band refined by the slowrx Gaussian log-interpolation:
  //   δ = ln(P₊/P₋) / (2·ln(P₀²/(P₊·P₋)))   (sub-bin offset from the peak bin)
  // Returns the estimated tone frequency (Hz) plus the sync-calibrated offset.
  // Far more accurate per pixel than the arccos autocorrelation it replaces,
  // and with no tone-period-locked window it does not blur across pixels.

  _hannFor(len) {
    let h = this._hannCache.get(len);
    if (h) return h;
    h = new Float64Array(len);
    const d = len > 1 ? (len - 1) : 1;
    for (let i = 0; i < len; i++) h[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / d);
    this._hannCache.set(len, h);
    return h;
  }

  // Raw FFT peak frequency (Hz) in the band [loHz, hiHz], WITHOUT the sync
  // calibration offset.  loHz/hiHz default to the 1400–2400 Hz video band.
  _estimateFreqFFTRaw(center, winLen, loHz = 1400, hiHz = 2400) {
    const N  = this._fftN;
    const sr = this._decodeSps;
    const L  = Math.max(4, Math.min(winLen | 0, N));
    let start = Math.round(center - L * 0.5);
    if (start < 0) start = 0;
    if (start + L > this._bufLen) start = this._bufLen - L;
    if (start < 0) return (loHz + hiHz) * 0.5;

    const re = this._fftRe, im = this._fftIm;
    re.fill(0); im.fill(0);
    const hann = this._hannFor(L);
    for (let i = 0; i < L; i++) re[i] = this._buf[start + i] * hann[i];
    transformFlat(re, im, false);

    const loBin = Math.max(1, Math.floor(loHz * N / sr));
    const hiBin = Math.min((N >> 1) - 1, Math.ceil(hiHz * N / sr));
    let maxBin = loBin, maxP = -1;
    for (let k = loBin; k <= hiBin; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      if (p > maxP) { maxP = p; maxBin = k; }
    }
    // Gaussian log-interpolation for sub-bin accuracy (guarded against ≤0 power).
    const pm = re[maxBin - 1] * re[maxBin - 1] + im[maxBin - 1] * im[maxBin - 1];
    const p0 = maxP;
    const pp = re[maxBin + 1] * re[maxBin + 1] + im[maxBin + 1] * im[maxBin + 1];
    let delta = 0;
    if (pm > 0 && pp > 0 && p0 > 0) {
      const denom = 2 * Math.log((p0 * p0) / (pm * pp));
      if (isFinite(denom) && Math.abs(denom) > 1e-12) {
        delta = Math.log(pp / pm) / denom;
        if (!isFinite(delta) || delta > 0.5 || delta < -0.5) delta = 0;
      }
    }
    return (maxBin + delta) * sr / N;
  }

  // Calibrated video-band estimate: raw FFT peak + the sync-derived offset.
  _estimateFreqFFT(center, winLen) {
    return this._estimateFreqFFTRaw(center, winLen, 1400, 2400) + this._freqOffset;
  }

  // Map an estimated tone frequency to a 0–255 level: 1500 Hz = 0, 2300 Hz = 255.
  _freqToLevel(freq) {
    const v = Math.round((freq - 1500) * 255 / 800);
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  // ── Goertzel / tone analysis ──────────────────────────────────────────────

  _goertzel(start, len, freq) {
    if (start < 0 || len <= 0 || start + len > this._bufLen) return 0;
    // NOTE: do NOT add 0.5 before rounding.  All SSTV VIS frequencies (1100, 1200,
    // 1300, 1900 Hz) are multiples of 100 Hz, and all VIS window sizes are multiples
    // of 120 samples (12000÷100=120), so len×freq÷sr is always an exact integer.
    // Math.round(integer + 0.5) = integer + 1 → one DFT bin too high → power = 0.
    // Math.round(integer) = integer → correct bin → full power.
    const k     = Math.max(1, Math.round((len * freq) / this._decodeSps));
    const w     = 2.0 * Math.PI * k / len;
    const coeff = 2.0 * Math.cos(w);
    let q0 = 0, q1 = 0, q2 = 0;
    for (let i = 0; i < len; i++) {
      q0 = coeff * q1 - q2 + this._buf[start + i];
      q2 = q1;
      q1 = q0;
    }
    return q1 * q1 + q2 * q2 - coeff * q1 * q2;
  }

  // ── Sync-pulse tonality ─────────────────────────────────────────────────────
  //
  // The 1200/1500/1900 ratio used everywhere else compares three bins to each
  // other and says nothing about the other ~20 bins in the window — so a
  // BROADBAND transient (static crash, mains buzz, switching-supply hash) that
  // happens to put a little more energy at 1200 than at 1500/1900 scores as high
  // as a real sync pulse.  That is the failure the operator sees as "a spark
  // starts the decoder", and it is worst for periodic interference, whose
  // repetition rate can line up with a mode's line period.
  //
  // Tonality compares the 1200 Hz bin to the TOTAL energy in the window:
  //
  //   pure 1200 Hz tone, amplitude A:  P₁₂₀₀ = (A·N/2)²,  E = N·A²/2  → 0.50
  //   broadband noise/impulse:         P₁₂₀₀ ≈ N·σ²,      E = N·σ²    → 1/N ≈ 0.002
  //
  // Two orders of magnitude apart, and scale-invariant, so it needs no noise
  // calibration.  0.10 corresponds to roughly −6 dB SNR inside the sync window —
  // far below anything decodable — while still rejecting transients outright.
  _syncTonality(start, len, p1200) {
    if (start < 0 || len <= 0 || start + len > this._bufLen) return 0;
    let e = 0;
    for (let i = start; i < start + len; i++) { const v = this._buf[i]; e += v * v; }
    if (e <= 0) return 0;
    return p1200 / (len * e);
  }

  _tonePairScore(start, len, lowF, highF) {
    const a   = this._goertzel(start, len, lowF);
    const b   = this._goertzel(start, len, highF);
    const sum = a + b + 1e-12;
    return {
      low: a, high: b,
      lowNorm:    a / sum,
      highNorm:   b / sum,
      confidence: Math.abs(a - b) / sum
    };
  }

  // ── VIS header detection ──────────────────────────────────────────────────

  _decodeVISCandidate(pos) {
    const sym30  = Math.round(0.030 * this._decodeSps);
    const leader = Math.round(0.300 * this._decodeSps);
    const brk    = Math.round(0.010 * this._decodeSps);

    const l1 = this._tonePairScore(pos,                leader, 1200, 1900);
    const b1 = this._tonePairScore(pos + leader,       brk,    1200, 1900);
    const l2 = this._tonePairScore(pos + leader + brk, leader, 1200, 1900);
    const s0 = pos + leader + brk + leader;

    if (!(l1.highNorm > 0.72 && b1.lowNorm > 0.72 && l2.highNorm > 0.72)) return null;

    // Tonality gate on both leader tones — the same test the sync detector uses,
    // and for the same reason.  The three-way ratio above only asks whether more
    // energy sits at 1900 than at 1200; a broadband transient (static crash, or
    // impulsive interference) satisfies that by luck often enough that an
    // impulse train could occasionally clear the whole VIS header — leader,
    // parity and stop bit — and lock a random mode.  This was the residual
    // false-trigger path after the AUTO detector was gated: VIS was exempted as
    // "parity-checked", but 7 data bits plus parity is only ~8 bits of evidence,
    // which noise does clear given enough attempts.  A real leader is a pure
    // 300 ms tone and scores ~0.5 here; a transient scores ~1/N.
    if (this._syncTonality(pos, leader, l1.high) < this._minTonality) return null;
    if (this._syncTonality(pos + leader + brk, leader, l2.high) < this._minTonality) return null;

    const start1200 = this._goertzel(s0, sym30, 1200);
    const startSides = this._goertzel(s0, sym30, 1100)
                     + this._goertzel(s0, sym30, 1300) + 1e-12;
    if (!(start1200 / startSides > 1.20)) return null;

    let vis = 0, ones = 0, bitConfidence = 0;
    for (let i = 0; i < 7; i++) {
      const bit = this._tonePairScore(s0 + sym30 * (i + 1), sym30, 1100, 1300);
      bitConfidence += bit.confidence;
      if (bit.low > bit.high) { vis |= (1 << i); ones++; }
    }
    const parity    = this._tonePairScore(s0 + sym30 * 8, sym30, 1100, 1300);
    const parityBit = parity.low > parity.high ? 1 : 0;
    bitConfidence  += parity.confidence;

    const stop1200 = this._goertzel(s0 + sym30 * 9, sym30, 1200);
    const stopSides = this._goertzel(s0 + sym30 * 9, sym30, 1100)
                    + this._goertzel(s0 + sym30 * 9, sym30, 1300) + 1e-12;
    if (!(stop1200 / stopSides > 1.15)) return null;

    if (parityBit !== (ones & 1)) return null;
    const modeKey = this._visMap.get(vis);
    if (!modeKey) return null;

    const leaderConf = (l1.confidence + b1.confidence + l2.confidence) / 3;
    return {
      modeKey, vis,
      confidence: 0.55 * leaderConf + 0.45 * (bitConfidence / 8),
      syncAnchor: s0 + sym30 * 10
    };
  }

  // ── Video timing calibration ──────────────────────────────────────────────
  //
  // The picture is positioned by anchoring off the sync pulse, which means any
  // difference between HOW the sync is located and HOW a pixel is measured lands
  // in the image as a horizontal shift.  There is such a difference, and it is
  // not small:
  //
  //   • the sync pulse is found as the peak of a Goertzel ENERGY window.  The
  //     bandpass needs a few cycles to reach full amplitude, so the early part of
  //     a 4.9 ms burst is attenuated and the peak-energy window sits noticeably
  //     LATE of the true pulse start;
  //   • a pixel is measured by an FFT window centred on the pixel, which lags
  //     only by the filter's group delay at the video frequency.
  //
  // Measured against an independent reference decoder, the two disagree by about
  // 0.75 ms.  That is a constant in TIME, so it costs ~1.6 px on Martin M1 but
  // ~3 px on Martin M2 — the fast modes are hurt twice as much, in a picture only
  // 320 px wide.
  //
  // Rather than hard-code 0.75 ms (which would silently rot if the filter, the
  // decode rate or the sync metric ever changed) this measures the decoder's own
  // two lags on a synthetic pulse+step, through the real code paths, and returns
  // their difference in samples.  Result is cached per mode.
  _videoTimingAdjust(modeKey) {
    if (this._videoTimingCache.has(modeKey)) return this._videoTimingCache.get(modeKey);

    const m     = this._modes[modeKey];
    const sps   = this._decodeSps;
    const syncS = Math.max(24, Math.round(m.syncMs * sps / 1000));
    const pad   = Math.round(0.050 * sps);

    // 1500 Hz | 1200 Hz sync | 1500 Hz | step to 2300 Hz — i.e. a sync pulse and
    // a video edge whose true positions are known exactly.
    const trueSync  = pad;
    const trueEdge  = pad + syncS + pad;
    const total     = trueEdge + pad;
    const sig       = new Float32Array(total);
    let hp = [0, 0], lp = [0, 0], ph = 0;
    for (let n = 0; n < total; n++) {
      const f = (n >= trueSync && n < trueSync + syncS) ? 1200
              : (n >= trueEdge) ? 2300 : 1500;
      ph += 2 * Math.PI * f / sps;
      const x  = Math.sin(ph);
      // Same cascade as _bpFilter, on private state.
      const y1 = this._hp_b[0] * x  + hp[0];
      hp[0]    = this._hp_b[1] * x  - this._hp_a[0] * y1 + hp[1];
      hp[1]    = this._hp_b[2] * x  - this._hp_a[1] * y1;
      const y2 = this._lp_b[0] * y1 + lp[0];
      lp[0]    = this._lp_b[1] * y1 - this._lp_a[0] * y2 + lp[1];
      lp[1]    = this._lp_b[2] * y1 - this._lp_a[1] * y2;
      sig[n]   = y2;
    }

    // Measure with the REAL routines by pointing them at the scratch signal.
    const savedBuf = this._buf, savedLen = this._bufLen;
    this._buf = sig; this._bufLen = total;
    let adj = 0;
    try {
      // Sync lag: peak of the same quality metric _findSyncNear maximises.
      let bestPos = trueSync, bestQ = -Infinity;
      for (let p = trueSync - pad + 1; p <= trueSync + pad; p++) {
        if (p < 0 || p + syncS >= total) continue;
        const q = this._goertzel(p, syncS, 1200)
                - 0.35 * this._goertzel(p, syncS, 1500)
                - 0.35 * this._goertzel(p, syncS, 1900);
        if (q > bestQ) { bestQ = q; bestPos = p; }
      }
      const lagSync = bestPos - trueSync;

      // Video lag: 50% crossing of the pixel estimator across the 1500→2300 step.
      const pixSpan = (m.chanMs || m.yMs || 100) * sps / 1000 / (m.width || 320);
      const winLen  = this._pixelWinLen(pixSpan);
      let lagVideo = 0;
      for (let p = trueEdge - pad + 1; p < trueEdge + pad; p++) {
        if (this._estimateFreqFFTRaw(p, winLen, 1400, 2400) >= 1900) { lagVideo = p - trueEdge; break; }
      }
      adj = Math.round(lagSync - lagVideo);
    } finally {
      this._buf = savedBuf; this._bufLen = savedLen;
    }

    // Sanity clamp: a correction beyond ±3 ms would mean the calibration itself
    // went wrong, and a wrong correction is worse than none.
    const limit = Math.round(0.003 * sps);
    if (!isFinite(adj) || Math.abs(adj) > limit) adj = 0;
    this._videoTimingCache.set(modeKey, adj);
    return adj;
  }

  // q-th quantile of the first `n` entries of `arr`, sorting them in place.
  // `arr` is scratch owned by the caller; n is small (≤ _autoProbeLines) so an
  // insertion sort beats Array.prototype.sort and allocates nothing.
  _quantileInPlace(arr, n, q) {
    for (let i = 1; i < n; i++) {
      const v = arr[i];
      let j = i - 1;
      while (j >= 0 && arr[j] > v) { arr[j + 1] = arr[j]; j--; }
      arr[j + 1] = v;
    }
    return arr[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))];
  }

  _candidateSyncScore(modeKey, anchor) {
    const m = this._modes[modeKey];
    if (!m) return -1e30;
    const lineS      = Math.round(m.lineMs  * this._decodeSps / 1000);
    const syncS      = Math.max(24, Math.round(m.syncMs * this._decodeSps / 1000));
    // Scottie has sync mid-line; Martin and Robot 36 have sync at line start.
    const syncOffset = (m.family === 'scottie')
      ? Math.round((m.porchMs + m.chanMs + m.sepMs + m.chanMs) * this._decodeSps / 1000)
      : 0;
    let score = 0, lines = 0;
    for (let n = 0; n < 4; n++) {
      const syncStart = anchor + n * lineS + syncOffset;
      if (syncStart < 0 || syncStart + syncS >= this._bufLen) break;
      const p1200 = this._goertzel(syncStart, syncS, 1200);
      const p1500 = this._goertzel(syncStart, syncS, 1500);
      const p1900 = this._goertzel(syncStart, syncS, 1900);
      score += (p1200 - 0.28 * p1500 - 0.42 * p1900) / (p1200 + p1500 + p1900 + 1e-12);
      lines++;
    }
    if (!lines) return -1e30;
    return score / lines;
  }

  _detectVIS() {
    const need = Math.floor(this._decodeSps * 1.05);
    if (this._bufLen - this._visScanPos < need) return false;

    const scanLimit = this._bufLen - need;
    let best = null;

    for (
      let pos = this._visScanPos;
      pos <= scanLimit;
      pos += Math.max(8, Math.round(0.0025 * this._decodeSps))
    ) {
      const cand = this._decodeVISCandidate(pos);
      if (!cand) continue;
      cand.syncScore = this._candidateSyncScore(cand.modeKey, cand.syncAnchor);
      const total = cand.confidence + 0.45 * Math.max(0, cand.syncScore);
      if (!best || total > best.total) best = { ...cand, total };
    }

    // Accept on VIS confidence ALONE.  _decodeVISCandidate has already required a
    // valid 1900/1200 leader pair, a 1200 Hz start bit, EVEN-PARITY-checked data
    // bits, a 1200 Hz stop bit, and a known VIS code — a strong, low-false-
    // positive combination.  syncScore stays in `total` above (to rank competing
    // candidates) but must NOT gate acceptance: when the ~1 s VIS header finishes,
    // only a single short image sync pulse is buffered after it, so syncScore is
    // computed from one 4.9 ms Martin pulse and a few ms of timing error zeroes
    // it — which was rejecting perfectly valid VIS headers (Martin M1, etc.) and
    // forcing the weaker AUTO fallback (which confuses Martin with Scottie).
    if (best && best.confidence >= 0.62) {
      this._visConfidence   = best.confidence;
      this._autoScore       = best.syncScore;
      this._setMode(best.modeKey, 'VIS');
      // best.syncAnchor is the start of the first image line.  The decode loop
      // tracks the SYNC PULSE, which for Scottie sits mid-line (after
      // porch+G+sep+B), not at the line start.  Advance the anchor to the first
      // sync pulse for Scottie — matching _tryAutoMode — otherwise the loop hunts
      // for a 1200 Hz pulse at the line start (green/porch, no sync), floundering
      // and re-acquiring a few times before it settles (Scottie "restart").
      const vm = this._modes[best.modeKey];
      this._syncAnchor      = best.syncAnchor + (vm.family === 'scottie'
        ? Math.round((vm.porchMs + vm.chanMs + vm.sepMs + vm.chanMs) * this._decodeSps / 1000)
        : 0);
      this._line            = 0;
      this._needFreshSync   = true;
      this._lastSyncQuality = 0;
      this._confirmLeft     = 0;   // VIS is parity-checked; it needs no confirmation
      this._confirmHits     = 0;
      this._visScanPos      = this._syncAnchor;
      this._freqOffset      = 0;
      this._freqOffsetCount = 0;
      this._r36_pendingY    = null;
      this._r36_pendingCb   = null;
      this._r36_pendingLine = -1;
      return true;
    }

    // FIX [14]: advance _processPos so _ensureCapacity can compact the buffer
    // during long periods with no SSTV signal.  Without this, _processPos
    // stays at 0 forever and the buffer doubles on every reallocation.
    // Retain one full VIS leader window (≈1.05 s) of look-back context.
    this._visScanPos = Math.max(this._visScanPos, scanLimit);
    this._processPos = Math.max(this._processPos, this._visScanPos - this._keepBack());
    return false;
  }

  // ── Mode management ───────────────────────────────────────────────────────

  // `announce = false` installs the mode without telling the UI — used for the
  // provisional AUTO/FORCED lock, which must survive _confirmLock() before the
  // operator sees a mode badge or any pixels.
  _setMode(modeKey, via = 'AUTO', announce = true) {
    const mode = this._modes[modeKey];
    if (!mode) return;
    this._mode         = mode;
    this._modeKey      = modeKey;
    this._detectedMode = mode.name;
    // Horizontal placement correction for this mode — see _videoTimingAdjust.
    this._videoTimingAdj = this._videoTimingAdjust(modeKey);
    // Every path into a lock passes through here, so the sync hit-rate is armed
    // in one place rather than at each call site.
    this._syncHitRate  = 1;
    this._syncLines    = 0;
    this._syncHits     = 0;
    this._imageW       = mode.width;
    this._imageH       = mode.height;
    if (!announce) return;
    this._emit({
      type: 'mode', mode: mode.name, via,
      visConfidence: this._visConfidence,
      autoScore:     this._autoScore
    });
    const extra = via === 'VIS'  ? ` conf=${this._visConfidence.toFixed(2)}`
                : via === 'AUTO' ? ` score=${this._autoScore.toFixed(2)}`
                : '';
    this._emit({ type: 'status', text: `${mode.name} lock (${via}${extra})` });
  }

  _tryAutoMode() {
    if (this._mode) return true;

    // A FORCED mode no longer bypasses detection.  It used to install the mode
    // unconditionally with _syncAnchor = 0, so the decoder immediately painted
    // noise (and any spark "started" it).  Forcing now only restricts the
    // candidate list to that one mode — the anchor still has to be found, and
    // the lock still has to be confirmed.  Thresholds are relaxed a little since
    // there is no competing mode to be confused with.
    let forcedKey = null;
    if (this._forcedMode && this._forcedMode !== 'auto') {
      forcedKey = Object.keys(this._modes).find(k =>
        this._modes[k].name.toLowerCase() === this._forcedMode.toLowerCase() ||
        k === this._forcedMode.toLowerCase()
      ) || null;
      if (!forcedKey) return false;
    }

    if (this._bufLen < this._decodeSps * 2.0) return false;

    // FIX [17]: cooldown — skip re-scan if buffer hasn't advanced 500 ms.
    // _tryAutoMode() performs ~1.6M multiplications per call; running it on
    // every feedPCM() chunk during detection is needlessly expensive.
    const cooldown = Math.round(0.5 * this._decodeSps);
    if (this._bufLen - this._lastAutoAttemptPos < cooldown) return false;
    this._lastAutoAttemptPos = this._bufLen;

    let best = null;
    // Best anchor PER MODE.  The old code kept a single overall runner-up, which
    // was usually the winning mode itself one anchor step away — two
    // near-identical scores, so the mode-confusion margin below collapsed to ~0
    // and vetoed a correct lock whenever the winning mode happened to occupy
    // both slots.  Which mode came second was an accident of how many anchors
    // each one had room to scan.
    const bestByKey = new Map();
    // All supported modes including Scottie DX and Robot 72.
    const candidateKeys = forcedKey ? [forcedKey] : [
      'martin1', 'martin2',
      'scottie1', 'scottie2', 'scottieDX',
      'robot36', 'robot72'
    ];

    for (const key of candidateKeys) {
      const m          = this._modes[key];
      const lineS      = Math.round(m.lineMs * this._decodeSps / 1000);
      const syncS      = Math.max(24, Math.round(m.syncMs * this._decodeSps / 1000));
      const syncOffset = (m.family === 'scottie')
        ? Math.round((m.porchMs + m.chanMs + m.sepMs + m.chanMs) * this._decodeSps / 1000)
        : 0;
      const step      = Math.max(10, Math.round(0.008 * this._decodeSps));
      const probeN    = this._autoProbeLines;
      // The line grid repeats every lineS, so anchors more than one line period
      // apart test the SAME phase against different audio.  Sweeping the whole
      // look-back therefore did ~9x redundant work for Martin (446 ms lines in a
      // 4 s window).  Sweep exactly one period, ending as late as the probe span
      // allows, so every phase is covered using the freshest audio.
      const anchorMax = this._bufLen - lineS * this._autoMinValid - syncS - 8;
      const anchorMin = Math.max(this._processPos, anchorMax - lineS);
      if (anchorMax < anchorMin) continue;

      for (let a = anchorMin; a <= anchorMax; a += step) {
        let score = 0, valid = 0;
        const ls = this._autoLineScores;
        for (let n = 0; n < probeN; n++) {
          const syncStart = a + n * lineS + syncOffset;
          if (syncStart < 0 || syncStart + syncS >= this._bufLen) break;
          const p1200 = this._goertzel(syncStart, syncS, 1200);
          const p1500 = this._goertzel(syncStart, syncS, 1500);
          const p1900 = this._goertzel(syncStart, syncS, 1900);
          // A broadband transient can beat the three-bin ratio below; it cannot
          // beat tonality.  Zeroing the line score here makes the minLine gate
          // reject the anchor outright.
          const lineScore =
            (this._syncTonality(syncStart, syncS, p1200) < this._minTonality)
              ? 0
              : (p1200 - 0.28 * p1500 - 0.42 * p1900) /
                (p1200 + p1500 + p1900 + 1e-12);
          score += lineScore;
          ls[valid++] = lineScore;
        }
        if (valid < this._autoMinValid) continue;
        score /= valid;
        // "Weakest line" as an ORDER STATISTIC, not the strict minimum.
        //
        // The rule was: probe 4 lines, require ALL FOUR above a high bar.  As a
        // noise test that is sound, but as a sensitivity limit it is brutal —
        // on a weak signal the per-line sync test is a coin flip (measured: 48%
        // of lines accepted at +2.9 dB), so the chance that no line out of 4
        // falls below the bar decays as p^4 and AUTO died at about +4 dB while
        // the VIS path still worked at −3 dB.
        //
        // Probing MORE lines and allowing a fraction of them to be weak is both
        // more sensitive and better evidence: 8 predicted sync pulses of which 6
        // must land is a far less likely coincidence than 4 of 4, because noise
        // has to keep hitting a fixed grid for twice as long.  So the bar per
        // line can come down while the false-alarm rate goes DOWN, not up.
        const q = this._quantileInPlace(ls, valid, this._autoQuantile);
        const item = { key, score, anchor: a, valid, minLine: q };
        const bk   = bestByKey.get(key);
        if (!bk || score > bk.score) bestByKey.set(key, item);
        if (!best || score > best.score) best = item;
      }
    }

    // Noise rejection is gated on the PER-LINE MINIMUM, not the mean.
    //
    // Why the old mean threshold failed: the accepted value is the MAXIMUM of
    // best.score over a large anchor search — an order statistic, not the mean.
    // The metric's mean on pure noise is (1 − 0.28 − 0.42)/3 = 0.10, but the max
    // over the hundreds of anchors scanned by the shortest-line mode (Robot 36)
    // reaches ~0.5, so raising the absolute mean gate (0.10 → 0.35) barely helped
    // — Robot 36 still cleared it on noise and won by search size.
    //
    // A genuine 1200 Hz sync train is dominant on EVERY line, so even its weak
    // lines score high; noise inflates the *average* off a few lucky lines but
    // cannot hold a whole predicted grid.  The joint condition is therefore
    // "most of N predicted pulses landed" (the quantile above) rather than "all
    // four did" — see the note at the quantile for why more lines at a lower bar
    // is the stricter test, not the looser one.
    //
    // The margin term is deliberately NOT applied to the runner-up anchor of the
    // same mode: adjacent anchors of a correct lock score almost identically, so
    // that comparison is always ~0 and would veto every real signal.  It asks
    // only whether a DIFFERENT mode is competing.
    let rival = null;
    if (best) {
      for (const [k, v] of bestByKey)
        if (k !== best.key && (!rival || v.score > rival.score)) rival = v;
    }
    const margin2 = rival ? best.score - rival.score : Infinity;
    const accepted = forcedKey
      ? (best && best.score >= this._autoMinScore * 0.75 &&
                 best.minLine >= this._autoMinQ * 0.8)
      : (best && best.score >= this._autoMinScore &&
                 best.minLine >= this._autoMinQ &&
                 margin2 >= this._autoMinMargin);

    if (accepted) {
      this._autoScore = best.score;
      // Provisional: no 'mode' event, no pixels, until _confirmLock() passes.
      this._setMode(best.key, forcedKey ? 'FORCED' : 'AUTO', false);
      this._confirmVia = forcedKey ? 'FORCED' : 'AUTO';
      this._syncAnchor = best.anchor;
      if (this._modes[best.key].family === 'scottie') {
        const m = this._modes[best.key];
        this._syncAnchor += Math.round(
          (m.porchMs + m.chanMs + m.sepMs + m.chanMs) * this._decodeSps / 1000
        );
      }
      this._line            = 0;
      this._needFreshSync   = true;
      this._freqOffset      = 0;
      this._freqOffsetCount = 0;
      this._lastSyncQuality = 0;
      this._r36_pendingY    = null;
      this._r36_pendingCb   = null;
      this._r36_pendingLine = -1;

      // Arm confirmation.  The lines that produced this score are already in the
      // buffer, so re-testing them would prove nothing — probe the ones AFTER
      // them, which have not been seen yet.  _confirmStartAnchor is kept so
      // decoding can rewind to line 0 once the prediction holds.
      this._confirmStartAnchor = this._syncAnchor;
      this._confirmNext        = this._syncAnchor + best.valid * Math.round(
        this._modes[best.key].lineMs * this._decodeSps / 1000);
      this._confirmLeft        = this._confirmProbes;
      this._confirmHits        = 0;
      this._emit({ type: 'status',
                   text: `${this._modes[best.key].name}? verifying sync…` });
      return true;
    }
    return false;
  }

  /**
   * Operator override: start drawing NOW, in `modeKey`, without waiting for a
   * VIS header or a sync-timing match.
   *
   * Every other path into a lock has to prove itself, for good reason — noise
   * wins an unguarded search often enough to paint garbage.  This one is
   * deliberately unguarded because the proof came from outside: a human looked
   * at the waterfall, picked the mode and pressed a button.  It is the one case
   * where bypassing detection is not a false trigger.
   *
   * The frame is anchored one line back from the newest audio so decoding can
   * begin immediately, and _needFreshSync is left set so the first _findSyncNear
   * still snaps to a real pulse if there is one — the operator supplies the mode
   * and the timing origin, the decoder refines it from there.
   *
   * A mistaken press does NOT self-correct: measured on pure noise, the per-line
   * sync test accepts often enough that _lostSyncCount never reaches the 12-miss
   * abandon, so it keeps painting until the frame completes.  That is a property
   * of the post-lock line loop, not of this method (the pre-lock detectors reject
   * the same noise), and it predates the button — Stop or Reset is the way out.
   */
  forceStartNow(modeKey) {
    const key  = modeKey && this._modes[modeKey] ? modeKey
               : (this._forcedMode && this._modes[this._forcedMode] ? this._forcedMode : null);
    const mode = key ? this._modes[key] : null;
    if (!mode) return false;

    const lineS = Math.round(mode.lineMs * this._decodeSps / 1000);
    this._syncAnchor      = Math.max(0, this._bufLen - lineS - this._jitterLead);
    this._line            = 0;
    this._needFreshSync   = true;
    this._freqOffset      = 0;
    this._freqOffsetCount = 0;
    this._lastSyncQuality = 0;
    this._lostSyncCount   = 0;
    this._confirmLeft     = 0;
    this._confirmHits     = 0;
    this._r36_pendingY    = null;
    this._r36_pendingCb   = null;
    this._r36_pendingLine = -1;
    this._setMode(key, 'MANUAL', true);
    this._process();
    return true;
  }

  // ── Sync tracking ─────────────────────────────────────────────────────────

  _findSyncNear(expectedSyncStart) {
    const m = this._mode;
    if (!m) return { pos: expectedSyncStart, quality: 0 };

    const syncS = Math.max(24, Math.round(m.syncMs * this._decodeSps / 1000));

    // FIX [15]: widen the search window when sync is being lost.
    // Normal ±25 ms keeps tracking tight; after 6 consecutive losses open
    // to ±80 ms to catch drift and QSB recovery.
    const wideSearch = this._lostSyncCount > 6;
    const span  = Math.round((wideSearch ? 0.080 : 0.025) * this._decodeSps);

    let bestPos = expectedSyncStart, bestQ = -1e30, bestP1200 = 0;

    for (
      let pos = expectedSyncStart - span;
      pos <= expectedSyncStart + span;
      pos += 8
    ) {
      if (pos < 0 || pos + syncS >= this._bufLen) continue;
      const p1200 = this._goertzel(pos, syncS, 1200);
      const p1500 = this._goertzel(pos, syncS, 1500);
      const p1900 = this._goertzel(pos, syncS, 1900);
      const q = p1200 - 0.35 * p1500 - 0.35 * p1900;
      if (q > bestQ) { bestQ = q; bestPos = pos; bestP1200 = p1200; }
    }

    // Tonality is evaluated only for the winner — one extra pass over ~9 ms.
    const tonality = this._syncTonality(bestPos, syncS, bestP1200);

    // Sync pulse frequency calibration: the sync pulse is 1200 Hz by spec.
    // Measure it with the SAME FFT estimator used for pixels (band 1000–1500 Hz),
    // not arccos — otherwise the estimator mismatch leaves a small constant error
    // in every pixel.  That error is invisible in luma (whites clamp, grays shift
    // imperceptibly) but tints neutral chroma below 128 → a uniform green cast on
    // the Robot modes.  Using one estimator for both makes the residual cancel.
    // Accumulate via a slow EMA (α = 0.20).
    if (bestQ > 0 && bestPos >= 0 && bestPos + syncS <= this._bufLen) {
      const measured = this._estimateFreqFFTRaw(bestPos + syncS * 0.5, syncS, 1000, 1500);
      if (measured > 900 && measured < 1600) {
        const newOffset = 1200.0 - measured;
        if (this._freqOffsetCount === 0) {
          this._freqOffset = newOffset;
        } else {
          this._freqOffset = 0.80 * this._freqOffset + 0.20 * newOffset;
        }
        this._freqOffsetCount++;
      }
    }

    return { pos: bestPos, quality: bestQ, tonality };
  }

  // ── RGB line decoder  (Martin / Scottie) ─────────────────────────────────

  _decodeLine(lineStart, syncStart) {
    const m = this._mode;
    if (!m) return null;

    const W      = m.width;
    const out    = new Uint8ClampedArray(W * 4);
    const chS    = m.chanMs  * this._decodeSps / 1000;
    const porchS = m.porchMs * this._decodeSps / 1000;
    const sepS   = m.sepMs   * this._decodeSps / 1000;

    let segments;
    if (m.family === 'martin') {
      // sync → porch → G → sep → B → sep → R
      const base = syncStart + Math.round(m.syncMs * this._decodeSps / 1000) + porchS;
      segments = { g: base, b: base + chS + sepS, r: base + chS + sepS + chS + sepS };
    } else {
      // Scottie: porch → G → sep → B → sep → sync → porch → R
      const g = lineStart + porchS;
      segments = { g, b: g + chS + sepS,
                   r: syncStart + Math.round(m.syncMs * this._decodeSps / 1000) + porchS };
    }

    const pixSpan = chS / W;
    // FFT window: ~1.4 pixels wide, floored for frequency resolution and capped.
    // Sampled at each pixel CENTRE ((x+0.5)·pixSpan) rather than its leading edge.
    const winLen = this._pixelWinLen(pixSpan);

    for (let x = 0; x < W; x++) {
      const cx = (x + 0.5) * pixSpan;
      // 1500 Hz = black (0), 2300 Hz = white (255).  Gamma LUT applied.
      const rv = this._gammaLUT[this._freqToLevel(this._estimateFreqFFT(segments.r + cx, winLen))];
      const gv = this._gammaLUT[this._freqToLevel(this._estimateFreqFFT(segments.g + cx, winLen))];
      const bv = this._gammaLUT[this._freqToLevel(this._estimateFreqFFT(segments.b + cx, winLen))];

      const i    = x * 4;
      out[i]     = rv;
      out[i + 1] = gv;
      out[i + 2] = bv;
      out[i + 3] = 255;
    }

    // Impulse noise suppression: single-pixel and two-pixel spike removal.
    // Only fires when flanking neighbours agree (smooth background) but centre
    // deviates sharply — avoids smearing genuine edges.
    for (let x = 2; x < W - 2; x++) {
      const i = x * 4;
      for (let c = 0; c < 3; c++) {
        const l2  = out[(x - 2) * 4 + c];
        const l1  = out[(x - 1) * 4 + c];
        const mid = out[i + c];
        const r1  = out[(x + 1) * 4 + c];
        const r2  = out[(x + 2) * 4 + c];

        // Single-pixel spike
        const n1Avg = (l1 + r1) * 0.5;
        if (Math.abs(l1 - r1) <= 8 && Math.abs(mid - n1Avg) >= 48) {
          out[i + c] = Math.round(n1Avg);
          continue;
        }
        // Two-pixel spike
        const n2Avg = (l2 + r2) * 0.5;
        if (Math.abs(l2 - r2) <= 12 &&
            Math.abs(mid - n2Avg) >= 48 &&
            Math.abs(l1  - n2Avg) >= 40) {
          out[i + c] = Math.round(n2Avg);
        }
      }
    }

    // Horizontal unsharp mask, radius matched to the FFT window's blur width.
    this._sharpenLine(out, W, winLen / pixSpan);

    return out;
  }

  // FFT window length (samples) for a channel whose pixels span `pixSpan`
  // samples.  ~1.4 pixels wide for sharpness, floored so the estimator has
  // enough signal to work with, and capped at 96 so the slow modes (Scottie DX)
  // do not over-blur.
  //
  // The floor used to be ONE CYCLE of the lowest video tone (sr/1500 = 32
  // samples).  That is the theoretical minimum, not a working one: measured on a
  // CLEAN, noise-free tone swept across the video band, a 32-sample window gives
  // 21 levels RMS error out of 255, with worst cases near 90.  It is not the
  // interpolation — at 32 samples every estimator tried (FFT peak, parabolic on
  // a matched grid, phase slope) lands between 16 and 43 levels, because one
  // cycle simply does not determine a frequency, and the answer then moves with
  // the phase of the slice.  That is a per-pixel random error, i.e. visible
  // speckle on a strong signal, and it is why Scottie DX (73-sample window,
  // 0.6 levels) always looked cleaner than everything else.
  //
  // 40 samples (one cycle of 1200 Hz, 1.25 cycles of 1500 Hz) is where the
  // estimator starts working.  Measured end-to-end against a ground-truth chart
  // at sharpen 0.55, floor 32 -> 40, RMS level error and bar contrast:
  //
  //     Martin M2   16.7 -> 10.9   8px 81->86%  4px 64->67%  2px 25->13%
  //     Scottie S2  18.8 -> 10.3   8px 80->90%  4px 67->76%  2px 29->15%
  //     Martin M1   16.6 ->  9.8   8px 85->92%  4px 74->77%  2px 17->13%
  //     Scottie S1  20.7 -> 12.0   8px 91->96%  4px 90->92%  2px 67->34%
  //
  // So coarse and medium detail get BETTER as the noise drops; only structure at
  // the 2-pixel limit is given up, and on a 320-pixel line that is mostly where
  // the speckle lived.  Raising it further to 48 roughly halves the noise again
  // (M2 5.2, S1 5.3) but costs most of the 2-pixel detail (S1 34% -> 15%), which
  // is too much to spend by default.
  _pixelWinLen(pixSpan) {
    const floor = Math.round(this._decodeSps / 1200);   // 40 at 48 kHz
    return Math.max(floor, Math.min(96, Math.round(pixSpan * 1.4)));
  }

  // Decode one channel of a YUV line into a Uint8Array(W) of 0–255 levels using
  // the FFT estimator, sampling at each pixel centre.
  _decodeYUVChannel(chanStart, pixSpan, winLen, W) {
    const out = new Uint8Array(W);
    for (let x = 0; x < W; x++) {
      out[x] = this._freqToLevel(this._estimateFreqFFT(chanStart + (x + 0.5) * pixSpan, winLen));
    }
    return out;
  }

  // ── Robot YUV line decoders ───────────────────────────────────────────────
  //
  // Robot 36 and Robot 72 have DIFFERENT structures, so they no longer share a
  // decoder:
  //   • Robot 36 (family 'robot36'): sync+porch+Y(88)+sep(6)+chroma(44).  One
  //     chroma per line, alternating R−Y / B−Y (chosen by the separator tone),
  //     subsampled 2:1 vertically → pairs of lines share Cr/Cb.
  //   • Robot 72 (family 'robot72'): sync+porch+Y(92)+sep+R−Y(92)+sep+B−Y(92).
  //     Full colour every line → one row per line, no pairing.
  // Both return an array of {pixels, lineNum} (0 or 2 rows for R36, 1 for R72).
  _decodeLineRobot(lineStart, syncStart) {
    return this._mode.family === 'robot72'
      ? this._decodeLineRobot72(syncStart)
      : this._decodeLineRobot36(syncStart);
  }

  _decodeLineRobot36(syncStart) {
    const m   = this._mode;
    const W   = m.width;
    const sr  = this._decodeSps;

    const syncS  = Math.round(m.syncMs  * sr / 1000);
    const porchS = Math.round(m.porchMs * sr / 1000);
    const yS     = m.yMs  * sr / 1000;
    const sepS   = Math.round(m.sepMs   * sr / 1000);
    const cS     = m.cMs  * sr / 1000;

    const yStart = syncStart + syncS + porchS;   // start of Y scan
    const cStart = yStart + yS + sepS;           // start of chroma scan

    const pixSpanY = yS / W;
    const pixSpanC = cS / W;
    const winY = this._pixelWinLen(pixSpanY);
    const winC = this._pixelWinLen(pixSpanC);

    const Y = this._decodeYUVChannel(yStart, pixSpanY, winY, W);
    const C = this._decodeYUVChannel(cStart, pixSpanC, winC, W);

    const lineNum = this._line;

    // This line's chroma type comes from the SEPARATOR TONE between Y and chroma
    // (1500 Hz → R−Y / Cr, 2300 Hz → B−Y / Cb), not line parity — self-correcting
    // across dropped lines.  NOTE: if colours swap, flip this comparison (>= ↔ <).
    const sepStart = yStart + yS;
    const isRY = this._goertzel(sepStart, sepS, 1500) >= this._goertzel(sepStart, sepS, 2300);

    // Buffer the first line of a pair; emit both rows once the complement arrives.
    if (this._r36_pendingY === null || this._r36_pendingIsRY === isRY) {
      this._r36_pendingY    = Y;
      this._r36_pendingCb   = C;
      this._r36_pendingIsRY = isRY;
      this._r36_pendingLine = lineNum;
      return [];
    }

    const Cr = isRY ? C : this._r36_pendingCb;   // R−Y
    const Cb = isRY ? this._r36_pendingCb : C;   // B−Y
    const radius = winY / pixSpanY;

    const rows = [
      { pixels: this._yuv2rgb(this._r36_pendingY, Cb, Cr, radius), lineNum: this._r36_pendingLine },
      { pixels: this._yuv2rgb(Y,                  Cb, Cr, radius), lineNum }
    ];

    this._r36_pendingY    = null;
    this._r36_pendingCb   = null;
    this._r36_pendingLine = -1;
    return rows;
  }

  _decodeLineRobot72(syncStart) {
    const m   = this._mode;
    const W   = m.width;
    const sr  = this._decodeSps;

    const syncS  = Math.round(m.syncMs  * sr / 1000);
    const porchS = Math.round(m.porchMs * sr / 1000);
    const sepS   = Math.round(m.sepMs   * sr / 1000);
    const yW     = m.yMs * sr / 1000;                    // 138 ms luma channel
    const cW     = m.cMs * sr / 1000;                    //  69 ms chroma channels

    // sync+porch → Y(138) → sep → R−Y(69) → sep → B−Y(69).  Chroma pixels are
    // half the luma pixel duration (both 320 px wide).
    const yStart  = syncStart + syncS + porchS;
    const ryStart = yStart  + yW + sepS;
    const byStart = ryStart + cW + sepS;

    const yPixSpan = yW / W;
    const cPixSpan = cW / W;
    const winY = this._pixelWinLen(yPixSpan);
    const winC = this._pixelWinLen(cPixSpan);

    const Y  = this._decodeYUVChannel(yStart,  yPixSpan, winY, W);
    const Cr = this._decodeYUVChannel(ryStart, cPixSpan, winC, W);   // R−Y
    const Cb = this._decodeYUVChannel(byStart, cPixSpan, winC, W);   // B−Y

    // Full colour on this line — no vertical chroma pairing.
    return [{ pixels: this._yuv2rgb(Y, Cb, Cr, winY / yPixSpan), lineNum: this._line }];
  }

  // ── YCbCr → RGB conversion (BT.601) ──────────────────────────────────────
  //
  // Y  : [0, 255]  luminance
  // Cb : [0, 255]  B−Y chroma  (128 = neutral)
  // Cr : [0, 255]  R−Y chroma  (128 = neutral)
  //
  // Applies the same impulse-noise filter used by the RGB decoder since static
  // bursts affect all three output channels simultaneously.
  _yuv2rgb(Y, Cb, Cr, radius = 1) {
    const W   = Y.length;
    const out = new Uint8ClampedArray(W * 4);

    for (let x = 0; x < W; x++) {
      const y  =  Y[x];
      const cb = Cb[x] - 128;
      const cr = Cr[x] - 128;

      const i    = x * 4;
      // Gamma LUT applied to final RGB — not to Y/Cb/Cr, to avoid chroma shifts.
      out[i]     = this._gammaLUT[Math.max(0, Math.min(255, Math.round(y + 1.402    * cr)))];
      out[i + 1] = this._gammaLUT[Math.max(0, Math.min(255, Math.round(y - 0.344136 * cb - 0.714136 * cr)))];
      out[i + 2] = this._gammaLUT[Math.max(0, Math.min(255, Math.round(y + 1.772    * cb)))];
      out[i + 3] = 255;
    }

    // Impulse noise suppression (same logic as RGB decoder)
    for (let x = 2; x < W - 2; x++) {
      const i = x * 4;
      for (let c = 0; c < 3; c++) {
        const l2  = out[(x - 2) * 4 + c];
        const l1  = out[(x - 1) * 4 + c];
        const mid = out[i + c];
        const r1  = out[(x + 1) * 4 + c];
        const r2  = out[(x + 2) * 4 + c];

        const n1Avg = (l1 + r1) * 0.5;
        if (Math.abs(l1 - r1) <= 8 && Math.abs(mid - n1Avg) >= 48) {
          out[i + c] = Math.round(n1Avg);
          continue;
        }
        const n2Avg = (l2 + r2) * 0.5;
        if (Math.abs(l2 - r2) <= 12 &&
            Math.abs(mid - n2Avg) >= 48 &&
            Math.abs(l1  - n2Avg) >= 40) {
          out[i + c] = Math.round(n2Avg);
        }
      }
    }

    // Horizontal unsharp mask (radius = luma box-blur width from the caller).
    this._sharpenLine(out, W, radius);

    return out;
  }

  // ── Main decode loop ──────────────────────────────────────────────────────

  // Verify a provisional AUTO/FORCED lock against lines the search never saw.
  // Returns true when the lock is confirmed (state rewound to line 0, mode
  // announced), false while still waiting for audio or after a rejection.
  _confirmLock(lineS, qFloor) {
    const syncS = Math.max(24, Math.round(this._mode.syncMs * this._decodeSps / 1000));
    const guard = syncS + Math.round(0.05 * this._decodeSps);

    // Confirmation is a COUNT over the probe window, not a run of consecutive
    // hits.  Requiring 4 in a row made this the hardest gate in the decoder: the
    // per-line sync test is honestly noisy on a weak signal (the thresholds are
    // set so pure noise scores 0.00, which costs a real picture ~50% of its
    // lines at +3 dB and ~89% at +0.4 dB), so a run of four succeeded only ~6%
    // of the time on a signal that was plainly there.  Measured: 5 of 29 true
    // candidates confirmed at +4.3 dB, 0 of 33 at +1.8 dB.
    //
    // Needing 3 of 6 predicted pulses is stronger evidence against noise than 4
    // consecutive, because the grid is fixed over a longer span, while it no
    // longer throws away a real lock over one fade.
    while (this._confirmLeft > 0) {
      if (this._confirmNext + guard >= this._bufLen) return false;   // need more audio

      const found = this._findSyncNear(this._confirmNext);
      const hit   = found.quality > qFloor && found.tonality >= this._minSyncTonality;
      if (hit) this._confirmHits++;
      // Advance on the measured pulse when there was one, otherwise dead-reckon,
      // so a missed probe does not drag the grid off the signal.
      this._confirmNext = (hit ? found.pos : this._confirmNext) + lineS;
      this._confirmLeft--;

      if (this._confirmHits >= this._confirmNeed) break;
      if (this._confirmHits + this._confirmLeft < this._confirmNeed) {
        // Cannot reach the target any more — this was noise.  Nothing was drawn
        // and no 'mode' event was sent, so the UI never saw the false lock.
        this._emit({ type: 'status', text: 'Candidate rejected (no sync)' });
        this._mode          = null;
        this._modeKey       = null;
        this._detectedMode  = '';
        this._confirmLeft   = 0;
        this._confirmHits   = 0;
        this._needFreshSync = true;
        // Do not re-lock the same spot on the next call, and restart the
        // auto-scan cooldown so the rejected window is not rescanned at once.
        this._visScanPos         = Math.max(this._visScanPos, this._confirmStartAnchor + 1);
        this._processPos         = Math.max(this._processPos, this._confirmStartAnchor);
        this._lastAutoAttemptPos = this._bufLen;
        return false;
      }
    }
    this._confirmLeft = 0;
    this._confirmHits = 0;

    // Confirmed — rewind to the first line of the candidate and start for real.
    this._syncAnchor      = this._confirmStartAnchor;
    this._line            = 0;
    this._needFreshSync   = true;
    this._lastSyncQuality = 0;
    this._setMode(this._modeKey, this._confirmVia, true);
    return true;
  }

  _process() {
    // Only scan for a VIS header when no mode is locked.  Running _detectVIS()
    // during an active frame risks a noise-induced false VIS match calling
    // _setMode() and resetting _line=0 mid-image, corrupting the frame; it also
    // wastes the (~1 s window) scan cost on every chunk while decoding.
    if (!this._mode) {
      // Signal-presence gate: with no signal in the passband there is nothing to
      // detect, and every detector here is scale-invariant, so running them on
      // bare noise is both the false-trigger source and a pointless main-thread
      // cost (_detectVIS ≈ 2M inner iterations per 100 ms of audio).
      if (!this._gateOpen()) { this._idleCompact(); return; }
      this._detectVIS();
    }
    if (!this._mode && !this._tryAutoMode()) return;
    const m = this._mode;
    if (!m) return;

    const lineS = Math.round(m.lineMs * this._decodeSps / 1000);
    const syncS = Math.max(24, Math.round(m.syncMs * this._decodeSps / 1000));
    const qFloor = this._syncQualityFloor(syncS);
    if (this._confirmLeft > 0 && !this._confirmLock(lineS, qFloor)) return;

    const syncOffsetScottie = (m.family === 'scottie')
      ? Math.round((m.porchMs + m.chanMs + m.sepMs + m.chanMs) * this._decodeSps / 1000)
      : 0;

    while (
      this._bufLen - this._syncAnchor >= lineS + this._jitterLead &&
      this._line < m.height
    ) {
      const expectedSync = this._needFreshSync
        ? this._syncAnchor
        : (this._syncAnchor + lineS);

      const found = this._findSyncNear(expectedSync);
      // Two conditions, not one:
      //   • ABSOLUTE — the pulse must stand above the noise-referenced floor.
      //     Without this the first line was accepted at any quality > 0
      //     (_lastSyncQuality starts at 0) and the relative bar below then
      //     calibrated itself to the noise, so a false lock could never die.
      //   • RELATIVE — and it must not collapse against recent lines.
      const useFound  = found.quality > qFloor &&
                        found.tonality >= this._minSyncTonality &&
                        found.quality > (this._lastSyncQuality * 0.35);
      const syncStart = useFound ? found.pos : expectedSync;

      this._syncLines++;
      this._syncHitRate += 0.15 * ((useFound ? 1 : 0) - this._syncHitRate);
      if (useFound) this._syncHits++;

      if (useFound) {
        // EMA, not "whatever the last line was": a single strong pulse used to
        // raise the bar so far that the next lines were all misses, and a single
        // weak one used to drop the bar onto the noise.
        this._lastSyncQuality = this._lastSyncQuality > 0
          ? (0.80 * this._lastSyncQuality + 0.20 * found.quality)
          : Math.max(found.quality, 1e-9);
        this._lostSyncCount   = 0;
      } else {
        this._lostSyncCount++;
        // The relative bar must FOLLOW the signal down.  _lastSyncQuality is
        // updated only on hits, so after a fade it stayed anchored to the
        // pre-fade (strong) pulses: when the signal came back weaker — which is
        // what QSB recovery looks like — every pulse failed `> last * 0.35`
        // against a bar built on a signal that no longer exists, and the miss
        // run continued through the recovery.  Decaying it per missed line lets
        // the lock re-acquire at whatever level the signal returns at, while
        // still resisting a single noise spike.
        this._lastSyncQuality *= 0.93;

        // Two separate questions, and they need separate rules (see [21]).
        //
        //   • "Was this lock ever real?"  — a RATE over the opening lines.  On
        //     pure noise the accept rate is 0.000, so a false lock never reaches
        //     _provenHits and still dies in ~20 lines, exactly as before.
        //   • "Has the signal gone away?" — a sustained ABSENCE of sync, in
        //     seconds.  Once a lock has proven itself this is the only thing
        //     that ends it, so a fade is dead-reckoned through instead of
        //     throwing the frame away and restarting it at line 0.
        const proven  = this._syncHits >= this._provenHits;
        const lostBar = Math.max(
          this._maxLostLinesMin,
          Math.min(this._maxLostLinesMax,
                   Math.round(this._maxLostSeconds * 1000 / m.lineMs)));
        if (this._lostSyncCount > lostBar ||
            (!proven &&
             this._syncLines >= this._minRateLines &&
             this._syncHitRate < this._minSyncHitRate)) {
          this._emit({ type: 'status', text: `${m.name} — sync lost, resetting` });
          // Clear the UI mode badge — otherwise a transient (e.g. noise-induced)
          // lock leaves its label stuck on screen after the decoder gives up.
          this._emit({ type: 'mode', mode: '', via: 'unlock' });
          this._mode            = null;
          this._modeKey         = null;
          this._detectedMode    = '';
          this._needFreshSync   = true;
          this._visScanPos      = Math.max(0, this._syncAnchor - Math.round(this._decodeSps * 0.5));
          this._lostSyncCount   = 0;
          this._lastSyncQuality = 0;
          this._confirmLeft     = 0;
          this._confirmHits     = 0;
          this._r36_pendingY  = null;
          this._r36_pendingCb = null;
          break;
        }
      }

      const lineStart = (m.family === 'scottie')
        ? (syncStart - syncOffsetScottie)
        : syncStart;

      if (lineStart < 0 || lineStart + lineS >= this._bufLen) break;

      // Decode line and emit.  Robot 36 returns 0 rows (first line of a pair
      // buffered) or 2 rows; Robot 72 returns 1 row (full colour); Martin/Scottie
      // return 1 row wrapped in an array for uniformity.
      //
      // The video anchors are shifted by the measured sync-vs-pixel timing
      // difference; sync TRACKING deliberately keeps the uncorrected positions,
      // since the line-to-line prediction only has to be self-consistent.
      const vAdj = this._videoTimingAdj;
      let rows;
      if (m.family === 'robot36' || m.family === 'robot72') {
        rows = this._decodeLineRobot(lineStart - vAdj, syncStart - vAdj);
      } else {
        const pixels = this._decodeLine(lineStart - vAdj, syncStart - vAdj);
        rows = pixels ? [{ pixels, lineNum: this._line }] : [];
      }

      // Suppress dead-reckoned rows once sync has been absent long enough that
      // they can only be noise (see _holdSeconds).  The line counter and anchor
      // below still advance, so the frame keeps its geometry across the gap.
      const holdBar = Math.max(
        this._holdLinesMin,
        Math.min(this._holdLinesMax,
                 Math.round(this._holdSeconds * 1000 / m.lineMs)));
      const drawing = this._lostSyncCount <= holdBar;

      for (const row of (drawing ? rows : [])) {
        this._emit({
          type:        'line',
          pixels:      row.pixels,
          lineNum:     row.lineNum,
          width:       m.width,
          height:      m.height,
          mode:        m.name,
          syncQuality: found.quality,
          freqOffset:  this._freqOffset,
          soft:        !useFound
        });
      }

      this._line++;
      this._needFreshSync = false;
      this._syncAnchor    = syncStart;
      this._processPos    = Math.max(this._processPos, lineStart);

      if (this._line >= m.height) {
        this._emit({ type: 'status', text: 'Frame complete' });
        // Return to the same state a fresh detection starts from.  Anything
        // left over here is carried into the NEXT image: a non-zero _line
        // would truncate it, a stale _lostSyncCount would abandon it early,
        // and a buffered Robot 36 luma row would pair the new frame's first
        // chroma with the old frame's last line.
        this._mode            = null;
        this._modeKey         = null;
        this._detectedMode    = '';
        this._needFreshSync   = true;
        this._lastSyncQuality = 0;
        this._lostSyncCount   = 0;
        this._confirmLeft     = 0;
        this._confirmHits     = 0;
        this._line            = 0;
        this._syncHitRate     = 1;
        this._syncLines       = 0;
        this._syncHits        = 0;
        this._r36_pendingY    = null;
        this._r36_pendingCb   = null;
        this._r36_pendingLine = -1;
        this._visScanPos      = this._processPos;
        break;
      }
    }
  }
}