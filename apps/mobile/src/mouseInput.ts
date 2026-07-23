// Pure helpers shared by the mobile gesture path and the desktop mouse path:
// map a pointer coordinate to a terminal cell, and build the byte sequences for
// clicks and drags honouring the app's negotiated mouse mode + SGR encoding.
import { mouseSeq } from './mouseSeq';
import type { MouseMode } from './terminal';

export function cellFromPoint(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
  cols: number,
  rows: number,
): { col: number; row: number } {
  const col = Math.min(cols, Math.max(1, Math.floor((x - rect.left) / (rect.width / cols)) + 1));
  const row = Math.min(rows, Math.max(1, Math.floor((y - rect.top) / (rect.height / rows)) + 1));
  return { col, row };
}

export function pressSeq(col: number, row: number, sgr: boolean, btn = 0, mods = 0): string {
  return mouseSeq(btn + mods, col, row, sgr);
}

export function releaseSeq(
  col: number,
  row: number,
  mode: MouseMode,
  sgr: boolean,
  btn = 0,
  mods = 0,
): string | null {
  if (mode === 'x10') return null; // X10 reports press only
  return mouseSeq(btn + mods, col, row, sgr, { release: true });
}

export function motionSeq(
  col: number,
  row: number,
  mode: MouseMode,
  sgr: boolean,
  btn = 0,
  mods = 0,
): string | null {
  if (mode !== 'button' && mode !== 'any') return null; // motion only in 1002/1003
  return mouseSeq(btn + mods, col, row, sgr, { motion: true });
}

export function clickSeqs(
  col: number,
  row: number,
  mode: MouseMode,
  sgr: boolean,
  btn = 0,
  mods = 0,
): string[] {
  const seqs = [pressSeq(col, row, sgr, btn, mods)];
  const rel = releaseSeq(col, row, mode, sgr, btn, mods);
  if (rel) seqs.push(rel);
  return seqs;
}
