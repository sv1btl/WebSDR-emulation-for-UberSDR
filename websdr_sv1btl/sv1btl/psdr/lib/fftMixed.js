// fftMixed.js — in-place complex FFT for any length (mixed radix).
//
// fftRadix2.js only takes powers of two; the WSJT-X decoders (FST4W) use FFT
// lengths such as 7200 = 2^5·3^2·5^2 or 224640 = 2^7·3^3·5·13 so that one
// symbol is a whole number of samples. This is a plain recursive
// decimation-in-time Cooley–Tukey over the prime factors of N; factors
// above 5 use a direct DFT of that size (they are small: 7, 13, 17).
// Plans (factor lists and twiddles) are cached per length.
//
//   fftMixed(re, im, inverse=false)   Float64Arrays of equal length, in place.
//   No 1/N scaling either way (like FFTW / four2a).

const plans = new Map();

function factorize(n) {
  const f = [];
  for (const p of [4, 2, 3, 5]) while (n % p === 0) { f.push(p); n /= p; }
  for (let p = 7; p * p <= n; p += 2) while (n % p === 0) { f.push(p); n /= p; }
  if (n > 1) f.push(n);
  return f;
}

function plan(n) {
  let pl = plans.get(n);
  if (pl) return pl;
  const cos = new Float64Array(n), sin = new Float64Array(n);
  for (let k = 0; k < n; k++) { cos[k] = Math.cos(2 * Math.PI * k / n); sin[k] = Math.sin(2 * Math.PI * k / n); }
  pl = { n, factors: factorize(n), cos, sin, tre: new Float64Array(n), tim: new Float64Array(n) };
  plans.set(n, pl);
  if (plans.size > 24) plans.delete(plans.keys().next().value);
  return pl;
}

/**
 * out[k] = sum_j in[off + j*stride] * w^(jk), for this sub-problem of size n
 * (n divides the plan size N; twiddle step = N/n). Recursive over factors.
 */
function rec(pl, inRe, inIm, off, stride, outRe, outIm, outOff, n, fi, sign) {
  if (n === 1) { outRe[outOff] = inRe[off]; outIm[outOff] = inIm[off]; return; }
  const p = pl.factors[fi], m = n / p;
  // p sub-transforms of size m
  for (let q = 0; q < p; q++) rec(pl, inRe, inIm, off + q * stride, stride * p, outRe, outIm, outOff + q * m, m, fi + 1, sign);
  // butterflies of radix p
  const N = pl.n, tstep = N / n;
  const cos = pl.cos, sin = pl.sin;
  const yr = new Float64Array(p), yi = new Float64Array(p);
  for (let k = 0; k < m; k++) {
    // twiddled inputs
    for (let q = 0; q < p; q++) {
      const idx = outOff + q * m + k;
      const t = (q * k * tstep) % N;
      const c = cos[t], s = sign * sin[t];
      const a = outRe[idx], b = outIm[idx];
      yr[q] = a * c - b * s; yi[q] = a * s + b * c;
    }
    if (p === 2) {
      outRe[outOff + k] = yr[0] + yr[1]; outIm[outOff + k] = yi[0] + yi[1];
      outRe[outOff + k + m] = yr[0] - yr[1]; outIm[outOff + k + m] = yi[0] - yi[1];
      continue;
    }
    // direct DFT of size p (p = 3, 4, 5, 7, 13, 17 …)
    const pstep = N / p;
    for (let u = 0; u < p; u++) {
      let sr = 0, si = 0;
      for (let q = 0; q < p; q++) {
        const t = ((u * q) % p) * pstep;
        const c = cos[t], s = sign * sin[t];
        sr += yr[q] * c - yi[q] * s; si += yr[q] * s + yi[q] * c;
      }
      outRe[outOff + k + u * m] = sr; outIm[outOff + k + u * m] = si;
    }
  }
}

export function fftMixed(re, im, inverse = false) {
  const n = re.length;
  if (n <= 1) return;
  const pl = plan(n);
  const sign = inverse ? 1 : -1;
  rec(pl, re, im, 0, 1, pl.tre, pl.tim, 0, n, 0, sign);
  re.set(pl.tre); im.set(pl.tim);
}

export default fftMixed;
