/**
 * js8-slots.js — JS8 slot geometry.
 *
 * Pulled out of audio.js so the timing can be tested directly. It is the part
 * most likely to be quietly wrong: a capture window that opens a fraction of a
 * second early creeps earlier every slot until it wraps, and the symptom is
 * "JS8 decodes badly sometimes", not an error.
 *
 * All times are UTC-aligned, because JS8 slots are: a Normal cycle starts at
 * :00, :15, :30 and :45 of every minute.
 */

import { SUBMODE_PERIOD_S, SUBMODE_TXDUR_S } from './js8-tables.js';

/** T/R cycle in seconds. Slot boundaries are multiples of this in UTC. */
export function js8Period(submode) {
  return SUBMODE_PERIOD_S[submode] ?? SUBMODE_PERIOD_S[0];
}

/** Seconds of transmission -- what a capture actually needs to hold. */
export function js8TxDur(submode) {
  return SUBMODE_TXDUR_S[submode] ?? SUBMODE_TXDUR_S[0];
}

/**
 * Samples to capture per slot: the transmission, less 0.4 s.
 *
 * Driven by the transmit duration rather than the cycle so that Slow, which
 * sends for 28 s inside a 30 s cycle, does not spend 1.6 s capturing noise and
 * finish so late that the next boundary has already passed.
 */
export function js8CaptureSamples(submode, sampleRate) {
  return Math.floor((js8TxDur(submode) - 0.4) * sampleRate);
}

/**
 * Position within the current slot, in seconds, honouring the capture lead-in.
 * Always in [0, period).
 */
export function js8SlotPos(nowMs, period, shift = 0) {
  const t = nowMs / 1000 - shift;
  const m = t % period;
  return m < 0 ? m + period : m;
}

/**
 * Width of the window, at the head of a slot, in which a capture may start.
 *
 * Must span at least one audio block, or a boundary can fall between two calls
 * and the slot is skipped entirely. Must also stay below the slack between the
 * end of a capture and the next boundary, or the end-of-capture position falls
 * back inside the acceptance window, the next capture latches early, and every
 * slot creeps earlier until it happens to wrap -- minutes of misaligned
 * captures. This is the bug the FT8 path hit; see _ftxStartWindow in audio.js.
 *
 * The slack here is (period - txdur) + 0.4, which is 0.4 s for every submode
 * except Slow, where it is 2.4 s.
 */
export function js8StartWindow(submode, blockDur = 0) {
  const period = js8Period(submode);
  const slack = (period - js8TxDur(submode)) + 0.4;
  const ceiling = Math.min(period / 4, slack * 0.975);
  return Math.min(ceiling, Math.max(Math.min(0.35, ceiling), blockDur * 1.05));
}
