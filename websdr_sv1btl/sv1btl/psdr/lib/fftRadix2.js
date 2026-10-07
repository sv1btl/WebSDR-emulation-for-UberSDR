// fftRadix2.js — drop-in replacement for the `fft-js` { fft, ifft } API used
// by the audio DSP chain (noise reduction, background-noise suppression, CW
// frequency detection).
//
// Interface is intentionally identical to `fft-js` so the call sites in
// audio.js are unchanged:
//   fft(input)   input: array of reals OR of [re, im] pairs (length = power of 2)
//                returns: array of [re, im] pairs (full N-point spectrum)
//   ifft(input)  input: array of [re, im] pairs
//                returns: array of [re, im] pairs, scaled by 1/N
//
// Why this exists: `fft-js` is a *recursive* transform that allocates several
// intermediate arrays on every call. These transforms run on the main thread
// once per audio buffer, so that allocation churn and recursion overhead show
// up as CPU. This version is an iterative in-place Cooley–Tukey (radix-2 DIT)
// with a bit-reversal permutation and twiddle table cached per FFT size and
// flat Float64 scratch buffers reused across calls — so repeated calls at the
// same size (the hot paths all use fixed sizes: 2048, 1024, 4096) allocate
// nothing beyond the [re, im] output the interface requires.
//
// Numerically this matches `fft-js` to floating-point round-off (verified
// against it on random input; see scratchpad/fft_verify.mjs), which is far
// below audible resolution.

// size -> { rev:Uint32Array, cos:Float64Array, sin:Float64Array,
//           re:Float64Array, im:Float64Array }
const _plans = new Map();

function _plan(n) {
  let p = _plans.get(n);
  if (p) return p;

  // Bit-reversal permutation.
  let bits = 0;
  while ((1 << bits) < n) bits++;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r >>> 0;
  }

  // Twiddle table for the FORWARD transform: W_n^k = exp(-2πi k / n).
  // The inverse reuses the same table with the imaginary part negated.
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    const a = (-2 * Math.PI * k) / n;
    cos[k] = Math.cos(a);
    sin[k] = Math.sin(a);
  }

  p = { rev, cos, sin, re: new Float64Array(n), im: new Float64Array(n) };
  _plans.set(n, p);
  return p;
}

function _transform(input, inverse) {
  const n = input.length;
  if (n === 0) return [];
  if ((n & (n - 1)) !== 0) {
    // Match fft-js, which rejects non-power-of-two sizes.
    throw new Error('FFT size must be a power of two, got ' + n);
  }

  const p = _plan(n);
  const re = p.re;
  const im = p.im;
  const rev = p.rev;
  const cos = p.cos;
  const sin = p.sin;
  const half = n >> 1;

  // Load input in bit-reversed order so the in-place iterative transform below
  // emits natural order. Each element may be a bare number (real) or an
  // [re, im] pair — both fft-js input forms are accepted.
  for (let i = 0; i < n; i++) {
    const v = input[rev[i]];
    if (typeof v === 'number') {
      re[i] = v;
      im[i] = 0;
    } else {
      re[i] = v[0];
      im[i] = v[1] || 0;
    }
  }

  // Iterative Danielson–Lanczos butterflies.
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const step = half / halfLen; // stride into the twiddle table for this stage
    for (let i = 0; i < n; i += len) {
      for (let j = 0, k = 0; j < halfLen; j++, k += step) {
        const wr = cos[k];
        const wi = inverse ? -sin[k] : sin[k];
        const a = i + j;
        const b = a + halfLen;
        const xr = re[b];
        const xi = im[b];
        const tr = wr * xr - wi * xi;
        const ti = wr * xi + wi * xr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }

  // Emit the [re, im] pair-array the interface requires. The forward transform
  // returns the raw spectrum; the inverse scales by 1/N (matching fft-js).
  const out = new Array(n);
  if (inverse) {
    const invN = 1 / n;
    for (let i = 0; i < n; i++) out[i] = [re[i] * invN, im[i] * invN];
  } else {
    for (let i = 0; i < n; i++) out[i] = [re[i], im[i]];
  }
  return out;
}

// Allocation-free in-place flat transform for hot paths that can hold their
// data in flat Float64 buffers instead of the [re, im] pair-arrays the
// fft()/ifft() interface returns. `re` and `im` are Float64Array(n) (n a power
// of two); on entry they hold the input (im all-zero for a real signal), on
// return they hold the transform — or, if `inverse`, the inverse scaled by
// 1/n. Apart from the cached per-size plan this allocates nothing. Verified to
// match fft()/ifft() to the bit (see scratchpad/fft_verify.mjs).
export function transformFlat(re, im, inverse) {
  const n = re.length;
  if (n === 0) return;
  if ((n & (n - 1)) !== 0) {
    throw new Error('FFT size must be a power of two, got ' + n);
  }
  const p = _plan(n);
  const rev = p.rev;
  const cos = p.cos;
  const sin = p.sin;
  const half = n >> 1;

  // In-place bit-reversal permutation (rev is an involution, so swapping each
  // i with rev[i] once — guarded by r > i — reproduces the reordered load that
  // _transform() does when it copies input[rev[i]] into slot i).
  for (let i = 0; i < n; i++) {
    const r = rev[i];
    if (r > i) {
      const tr = re[i]; re[i] = re[r]; re[r] = tr;
      const ti = im[i]; im[i] = im[r]; im[r] = ti;
    }
  }

  // Identical butterflies to _transform().
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const step = half / halfLen;
    for (let i = 0; i < n; i += len) {
      for (let j = 0, k = 0; j < halfLen; j++, k += step) {
        const wr = cos[k];
        const wi = inverse ? -sin[k] : sin[k];
        const a = i + j;
        const b = a + halfLen;
        const xr = re[b];
        const xi = im[b];
        const tr = wr * xr - wi * xi;
        const ti = wr * xi + wi * xr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }

  if (inverse) {
    const invN = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= invN;
      im[i] *= invN;
    }
  }
}

export function fft(input) {
  return _transform(input, false);
}

export function ifft(input) {
  return _transform(input, true);
}

export default { fft, ifft, transformFlat };
