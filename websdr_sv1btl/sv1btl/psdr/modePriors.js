/**
 * modePriors.js — band-plan evidence for the mode identifier.
 *
 * modeId.js is deliberately deaf to everything except the audio: it measures
 * the signal and nothing else.  That leaves the single strongest clue on the
 * table, because WHERE you are tuned is evidence too.  A 100 Bd / 170 Hz signal
 * on 518 kHz is NAVTEX; the identical signal on 14.070 MHz is not.
 *
 * This layer sits between the engine and the UI.  It never invents a candidate
 * the signal did not support, and the rules are deliberately weak enough that
 * frequency can reorder two close candidates but cannot overturn a confident
 * measurement — an operator on an odd frequency must still get the right answer.
 *
 * It also does the one thing the signal genuinely cannot do.  FT8 and JS8 are
 * the same 8-FSK waveform on the same 15 s grid, so modeId.js reports them as
 * one family; but they have DIFFERENT calling frequencies, so once the dial is
 * known the family can be split into a real answer.
 */

// ── Band plan ────────────────────────────────────────────────────────────────
//
// Ranges are the SIGNAL frequency in kHz, not the dial.  For the USB data modes
// the convention is a dial at the base frequency with signals sitting a few
// hundred Hz to 3 kHz above it, so the ranges are written as that whole span.
//
// `strict` marks a mode that essentially only ever appears on these
// frequencies, so being far from all of them is genuine evidence AGAINST it.
// CW, RTTY, PSK31 and Olivia are not strict — they turn up anywhere.

const PLAN = {
  ft8: {
    strict: true,
    label: 'FT8',
    ranges: [
      [1840, 1843], [3573, 3576], [5357, 5360], [7074, 7077], [10136, 10139],
      [14074, 14077], [18100, 18103], [21074, 21077], [24915, 24918],
      [28074, 28077], [50313, 50316], [50323, 50326],
    ],
  },
  js8: {
    strict: true,
    label: 'JS8',
    ranges: [
      [1842, 1845], [3578, 3581], [7078, 7081], [10130, 10133],
      [14078, 14081], [18104, 18107], [21078, 21081], [24922, 24925],
      [28078, 28081],
    ],
  },
  ft4: {
    strict: true,
    ranges: [
      [3575.5, 3578.5], [7047.5, 7050.5], [10140, 10143], [14080, 14083],
      [18104, 18107], [21140, 21143], [24919, 24922], [28180, 28183],
    ],
  },
  wspr: {
    strict: true,
    ranges: [
      [136, 137.6], [474.2, 475.8], [1836.6, 1838.2], [3568.6, 3570.2],
      [3592.6, 3594.2], [5287.2, 5288.8], [7038.6, 7040.2], [10138.7, 10140.3],
      [14095.6, 14097.2], [18104.6, 18106.2], [21094.6, 21096.2],
      [24924.6, 24926.2], [28124.6, 28126.2],
    ],
  },
  navtex: {
    strict: true,
    ranges: [[423, 425], [489, 491], [517, 519], [4208.5, 4211]],
  },
  // The ITU Appendix 15 NBDP/SITOR set, plus the MF working channel.
  'services:maritime': {
    strict: true,
    ranges: [
      [2173.5, 2175.5], [4209, 4211], [6313, 6315], [8415.5, 8417.5],
      [12578, 12580], [16805.5, 16807.5], [19679.5, 19681.5],
      [22375, 22377], [26099.5, 26101.5],
    ],
  },
  'services:weather': {
    strict: true,
    ranges: [
      [146.3, 148.3], [4582, 4584], [7645, 7647], [10099.8, 10101.8],
      [11038, 11040], [14466.3, 14468.3],
    ],
  },
  // Marine radiofax lives in the maritime HF allocations rather than on a
  // handful of exact spots, so these are the bands, not the station list — no
  // need to duplicate FAX_STATIONS and let the two drift apart.
  hffax: {
    strict: true,
    ranges: [
      [2000, 2700], [3200, 4500], [4900, 5400], [5700, 6500], [6800, 7000],
      [7300, 8800], [9000, 9300], [9900, 10200], [11000, 11200],
      [12300, 13100], [13800, 14100], [15500, 15700], [16000, 17200],
      [18000, 18100], [20400, 20500], [22400, 22700],
    ],
  },
  // ITU DSC calling channels. Same modulation as NAVTEX, different channels —
  // which is the whole reason this entry exists.
  'services:dsc': {
    strict: true,
    ranges: [
      [2186.5, 2188.5], [4206.5, 4208.5], [6311, 6313], [8413.5, 8415.5],
      [12576, 12578], [16803.5, 16805.5],
    ],
  },
  cw:            { strict: false, ranges: [] },
  sstv:          { strict: false, ranges: [[3730, 3740], [7165, 7175], [14225, 14235], [21335, 21345], [28675, 28685]] },
  'fsk:ham':     { strict: false, ranges: [[3580, 3600], [7040, 7050], [10140, 10150], [14080, 14100], [21080, 21100], [28080, 28100]] },
  'fsk:psk31':   { strict: false, ranges: [[3580, 3581], [7040, 7041], [10142, 10143], [14070, 14071], [18100, 18101], [21080, 21081], [24920, 24921], [28120, 28121]] },
  'fsk:olivia':  { strict: false, ranges: [[3577, 3584], [7040, 7074], [10142, 10144], [14072, 14109], [18099, 18100], [21072, 21073], [24922, 24923], [28122, 28123]] },
};

/** How strongly frequency may push a score around. */
const ON_PLAN_BOOST = 0.35;   // multiplicative, on top of the measured score
const OFF_PLAN_CUT = 0.70;    // only for `strict` modes, never to zero

function planKey(c) {
  if (!c.key) return '';
  return c.variant ? `${c.key}:${c.variant}` : c.key;
}

function inRanges(khz, ranges) {
  for (const [lo, hi] of ranges) if (khz >= lo && khz <= hi) return true;
  return false;
}

/**
 * Signal frequency in kHz from the dial and the audio offset.  USB puts audio
 * above the dial, LSB below it.
 */
export function signalKhz(dialKhz, audioHz, demodulation) {
  if (!dialKhz || !audioHz) return 0;
  const inverted = demodulation === 'LSB' || demodulation === 'CW-L';
  return dialKhz + (inverted ? -audioHz : audioHz) / 1000;
}

/**
 * Re-rank candidates using the frequency, and split the FT8/JS8/FT2 family when
 * the band plan can settle it.
 *
 * @param candidates  from modeId.js, already ranked by signal evidence
 * @param khz         signal frequency; 0/undefined disables the whole layer
 * @returns           new array, re-sorted, each entry carrying `.onPlan`
 */
export function applyBandPriors(candidates, khz) {
  if (!candidates || !candidates.length || !khz) return candidates || [];

  const out = [];
  for (const c of candidates) {
    // The family candidate becomes a specific mode when the frequency says so.
    if (c.key === 'ft8') {
      const isFt8 = inRanges(khz, PLAN.ft8.ranges);
      const isJs8 = inRanges(khz, PLAN.js8.ranges);
      // 18.104 MHz is on both the JS8 and FT4 plans, and the FT8/JS8 ranges can
      // abut, so only an UNAMBIGUOUS match is allowed to split the family.
      if (isFt8 && !isJs8) {
        out.push({ ...c, key: 'ft8', label: 'FT8', onPlan: true,
                   why: `${c.why}, and on an FT8 calling frequency` });
        continue;
      }
      if (isJs8 && !isFt8) {
        out.push({ ...c, key: 'js8', label: 'JS8', onPlan: true,
                   why: `${c.why}, and on a JS8 calling frequency` });
        continue;
      }
      out.push({ ...c, onPlan: false });
      continue;
    }
    out.push({ ...c, onPlan: false });
  }

  // Now apply the boost/cut to everything, including the split FTx entries.
  for (const c of out) {
    const plan = PLAN[planKey(c)] || PLAN[c.key];
    if (!plan || !plan.ranges.length) continue;
    const on = c.onPlan || inRanges(khz, plan.ranges);
    if (on) {
      c.onPlan = true;
      c.score = Math.min(1, c.score * (1 + ON_PLAN_BOOST));
    } else if (plan.strict) {
      c.score = c.score * OFF_PLAN_CUT;
      c.offPlan = true;
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

export default { applyBandPriors, signalKhz };
