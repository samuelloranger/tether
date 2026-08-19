import type { IBufferCell, IBufferLine } from '@xterm/headless';
import type { LinkSpan } from './links';
import { type CellStyle, DEFAULT_BG, DEFAULT_FG, PALETTE, type RenderRow } from './terminal';

export function hex6(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
}

function fgOf(cell: IBufferCell): string | undefined {
  if (cell.isFgDefault()) return undefined;
  if (cell.isFgRGB()) return hex6(cell.getFgColor());
  if (cell.isFgPalette()) return PALETTE[cell.getFgColor()] ?? undefined;
  return undefined;
}

export function bgOf(cell: IBufferCell): string | undefined {
  if (cell.isBgDefault()) return undefined;
  if (cell.isBgRGB()) return hex6(cell.getBgColor());
  if (cell.isBgPalette()) return PALETTE[cell.getBgColor()] ?? undefined;
  return undefined;
}

export function lastContentCol(line: IBufferLine): number {
  let last = 0;
  for (let x = 0; x < line.length; x++) {
    const c = line.getCell(x);
    if (c && (c.getChars() || '').trim() !== '') last = x + c.getWidth();
  }
  return last;
}

export function styleOf(cell: IBufferCell, caret: boolean): CellStyle {
  const s: CellStyle = {};
  let fg = fgOf(cell);
  let bg = bgOf(cell);
  if (cell.isInverse()) {
    const nfg = bg ?? DEFAULT_BG;
    const nbg = fg ?? DEFAULT_FG;
    fg = nfg;
    bg = nbg;
  }
  if (fg) s.fg = fg;
  if (bg) s.bg = bg;
  if (cell.isBold()) s.bold = true;
  if (cell.isDim()) s.dim = true;
  if (cell.isItalic()) s.italic = true;
  if (cell.isUnderline()) s.underline = true;
  if (cell.isStrikethrough()) s.strike = true;
  if (caret) s.caret = true;
  return s;
}

export function styleEq(a: CellStyle, b: CellStyle): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    !!a.inverse === !!b.inverse &&
    !!a.caret === !!b.caret
  );
}

export function runsEqual(a: RenderRow['runs'], b: RenderRow['runs']): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text || !styleEq(a[i].style, b[i].style)) return false;
  }
  return true;
}

function targetEq(a: LinkSpan['target'], b: LinkSpan['target']): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'external' && b.kind === 'external') return a.url === b.url;
  if (a.kind === 'file' && b.kind === 'file')
    return a.path === b.path && a.line === b.line && a.column === b.column;
  return false;
}

export function linksEqual(a: RenderRow['links'], b: RenderRow['links']): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end || !targetEq(a[i].target, b[i].target))
      return false;
  }
  return true;
}
