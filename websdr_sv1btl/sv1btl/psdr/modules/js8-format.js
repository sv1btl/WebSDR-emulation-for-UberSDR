/**
 * js8-format.js — turning decoded JS8 into text a human reads.
 *
 * Shared by the spectrum marks in audio.js and the message list in App.svelte,
 * so the two never drift, and testable without a browser.
 *
 * JS8 renders as a sentence, not as FT8's fixed fields: "KN4CRD: SV1BTL SNR
 * -05", "SV1BTL KM17: HB", "N0JDS: @ALLCALL MEET AT NOON". The pieces that are
 * absent for a given frame type are simply left out rather than padded.
 */

/** One line for a completed (or timed-out) message from the reassembler. */
export function formatJs8Message(m) {
  if (!m) return '';

  if (m.kind === 'heartbeat') {
    return `${m.from}${m.grid ? ' ' + m.grid : ''}: HB`;
  }

  const who = m.from && m.to ? `${m.from}: ${m.to}` : m.from ? `${m.from}:` : '';
  return [who, m.cmd, m.num, m.text]
    .filter((p) => p !== null && p !== undefined && p !== '')
    .join(' ');
}

/**
 * The same line as formatJs8Message(), but split so the callsigns can be
 * styled apart from the rest.
 *
 * Returns [{ text, call }]; concatenating every `text` reproduces
 * formatJs8Message() exactly, which the tests check -- the two must not drift.
 */
export function formatJs8Parts(m) {
  if (!m) return [];

  if (m.kind === 'heartbeat') {
    const parts = [{ text: m.from, call: true }];
    if (m.grid) parts.push({ text: ' ' + m.grid, call: false });
    parts.push({ text: ': HB', call: false });
    return parts;
  }

  const parts = [];
  if (m.from && m.to) {
    parts.push({ text: m.from, call: true });
    parts.push({ text: ': ', call: false });
    parts.push({ text: m.to, call: true });
  } else if (m.from) {
    parts.push({ text: m.from, call: true });
    parts.push({ text: ':', call: false });
  }

  // Everything after the callsigns joins with single spaces, and a data frame
  // with no callsigns at all must not pick up a leading one.
  for (const tail of [m.cmd, m.num, m.text]) {
    if (tail === null || tail === undefined || tail === '') continue;
    parts.push({ text: parts.length ? ' ' + tail : tail, call: false });
  }
  return parts;
}

/** Short label for a single frame, used on the mini spectrum. */
export function formatJs8Frame(frame) {
  if (!frame) return '';
  switch (frame.kind) {
    case 'heartbeat':
      return `${frame.from}${frame.grid ? ' ' + frame.grid : ''} HB`;
    case 'directed':
      return [`${frame.from}:`, frame.to, frame.cmd, frame.num]
        .filter(Boolean).join(' ');
    case 'compound':
    case 'compound_directed':
      return [frame.from, frame.grid, frame.cmd].filter(Boolean).join(' ');
    case 'data':
      // A compressed frame before the dictionary has loaded has no text yet.
      return frame.needsDictionary ? '…' : (frame.text || '');
    default:
      return '';
  }
}
