// Encode a mouse event as the byte sequence the app negotiated: SGR (?1006h) or
// legacy X10. Used by both the mobile swipe→wheel forwarder and the desktop
// wheel handler so each honours the app's actual mouse mode.
//
// `btn` is the full button value including wheel/modifier bits — e.g. 64 = wheel
// up, 65 = wheel down. `col`/`row` are 1-based cell coordinates.
export function mouseSeq(btn: number, col: number, row: number, sgr: boolean): string {
  if (sgr) {
    // SGR: decimal params, press = 'M'. Wheel events have no separate release.
    return `\x1b[<${btn};${col};${row}M`;
  }
  // Legacy X10: each value is offset by 32 into a single byte. Input reaches the
  // PTY UTF-8-encoded, so any code point ≥ 128 would become two bytes and
  // corrupt the report; clamp to 127 to guarantee one byte per field. This caps
  // the reportable position at column/row 95 — fine for wheel scrolling, and
  // legacy-only mouse mode (no ?1006h) on a >95-column grid is rare.
  const enc = (n: number) => String.fromCharCode(Math.min(127, n + 32));
  return `\x1b[M${enc(btn)}${enc(col)}${enc(row)}`;
}
