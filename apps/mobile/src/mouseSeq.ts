// Encode a mouse event as the byte sequence the app negotiated: SGR (?1006h) or
// legacy X10. Used by both the mobile swipe→wheel forwarder and the desktop
// wheel handler so each honours the app's actual mouse mode.
//
// `btn` is the full button value including wheel/modifier bits — e.g. 64 = wheel
// up, 65 = wheel down. `col`/`row` are 1-based cell coordinates. `opts.motion`
// ORs the +32 motion bit; `opts.release` marks a button-up event.
export function mouseSeq(
  btn: number,
  col: number,
  row: number,
  sgr: boolean,
  opts?: { release?: boolean; motion?: boolean },
): string {
  const motion = opts?.motion ? 32 : 0;
  if (sgr) {
    // SGR: decimal params, real button preserved; press/motion 'M', release 'm'.
    const cb = btn + motion;
    return `\x1b[<${cb};${col};${row}${opts?.release ? 'm' : 'M'}`;
  }
  // Legacy X10: release sets the low two button bits to 3 (the button is
  // unknowable in legacy), preserving modifier/high bits; motion ORs +32. Each
  // value is offset by 32 into a single byte. Input reaches the PTY UTF-8-
  // encoded, so any code point ≥ 128 would become two bytes and corrupt the
  // report; clamp to 127 to guarantee one byte per field. This caps the
  // reportable position at column/row 95 — fine for wheel scrolling, and
  // legacy-only mouse mode (no ?1006h) on a >95-column grid is rare.
  const cb = (opts?.release ? (btn & ~0b11) | 0b11 : btn) + motion;
  const enc = (n: number) => String.fromCharCode(Math.min(127, n + 32));
  return `\x1b[M${enc(cb)}${enc(col)}${enc(row)}`;
}
