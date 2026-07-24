import './xtermPolyfill';
import { type IBufferCell, type IBufferLine, Terminal } from '@xterm/headless';
import { type CellStyle, PALETTE, type RenderRow } from './terminal';

const MAX_SCROLLBACK = 1000;

function hex6(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
}

function fgOf(cell: IBufferCell): string | undefined {
  if (cell.isFgDefault()) return undefined; // renderer falls back to DEFAULT_FG
  if (cell.isFgRGB()) return hex6(cell.getFgColor());
  if (cell.isFgPalette()) return PALETTE[cell.getFgColor()] ?? undefined;
  return undefined;
}

function bgOf(cell: IBufferCell): string | undefined {
  if (cell.isBgDefault()) return undefined;
  if (cell.isBgRGB()) return hex6(cell.getBgColor());
  if (cell.isBgPalette()) return PALETTE[cell.getBgColor()] ?? undefined;
  return undefined;
}

function styleOf(cell: IBufferCell, caret: boolean): CellStyle {
  const s: CellStyle = {};
  const fg = fgOf(cell);
  const bg = bgOf(cell);
  if (fg) s.fg = fg;
  if (bg) s.bg = bg;
  if (cell.isBold()) s.bold = true;
  if (cell.isDim()) s.dim = true;
  if (cell.isItalic()) s.italic = true;
  if (cell.isUnderline()) s.underline = true;
  if (cell.isStrikethrough()) s.strike = true;
  if (cell.isInverse()) s.inverse = true;
  if (caret) s.caret = true;
  return s;
}

function styleEq(a: CellStyle, b: CellStyle): boolean {
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

function runsEqual(a: RenderRow['runs'], b: RenderRow['runs']): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text || !styleEq(a[i].style, b[i].style)) return false;
  }
  return true;
}

// Adapter wrapping @xterm/headless with the TerminalEmulator public surface, so
// it is a drop-in replacement. Reads term.buffer.active to emit RenderRow[].
export class TerminalEngine {
  private term: Terminal;
  private cell: IBufferCell | undefined;
  private prevRows: RenderRow[] = [];

  bellCount = 0;
  notifyCount = 0;
  lastNotify = { title: '', body: '' };
  promptReturnCount = 0;
  title = '';
  cwd = '';
  applicationCursor = false;
  bracketedPaste = false;
  cursorStyle: 'block' | 'bar' | 'underline' = 'block';
  mouseMode: 'off' | 'x10' | 'normal' | 'button' | 'any' = 'off';
  mouseSgr = false;
  onReply: ((data: string) => void) | null = null;
  onClipboardWrite: ((text: string) => void) | null = null;

  get mouseOn(): boolean {
    return this.mouseMode !== 'off';
  }

  constructor(cols = 80, rows = 24) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback: MAX_SCROLLBACK,
      allowProposedApi: true,
    });
    // xterm emits generated replies (DSR/DA) through onData; the app sends user
    // input separately, so onData here carries only auto-replies.
    this.term.onData((d) => this.onReply?.(d));
  }

  get cols(): number {
    return this.term.cols;
  }
  get rows(): number {
    return this.term.rows;
  }

  write(data: string): void {
    this.term.write(data);
  }

  // Test/detail helper: resolve once xterm has flushed its write queue.
  drain(): Promise<void> {
    return new Promise((resolve) => this.term.write('', resolve));
  }

  resize(cols: number, rows: number): void {
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.term.resize(Math.max(1, cols), Math.max(1, rows));
  }

  reset(): void {
    this.term.reset();
    this.bellCount = 0;
    this.notifyCount = 0;
    this.lastNotify = { title: '', body: '' };
    this.promptReturnCount = 0;
    this.title = '';
    this.cwd = '';
    this.applicationCursor = false;
    this.bracketedPaste = false;
    this.cursorStyle = 'block';
    this.mouseMode = 'off';
    this.mouseSgr = false;
    this.prevRows = [];
  }

  getSnapshot(): RenderRow[] {
    const buf = this.term.buffer.active;
    const total = buf.length;
    const cursorAbs = buf.baseY + buf.cursorY;
    const out: RenderRow[] = new Array(total);
    for (let y = 0; y < total; y++) {
      const line = buf.getLine(y);
      if (!line) {
        out[y] = {
          key: y,
          runs: [{ text: '', style: {} }],
          wrapped: false,
          links: [],
          promptStart: false,
        };
        continue;
      }
      const caretCol = y === cursorAbs ? buf.cursorX : -1;
      const runs = this.runsFor(line, caretCol);
      const wrapped = line.isWrapped;
      const key = y;
      const prev = this.prevRows[y];
      out[y] =
        prev && prev.key === key && prev.wrapped === wrapped && runsEqual(prev.runs, runs)
          ? prev
          : { key, runs, wrapped, links: [], promptStart: false };
    }
    this.prevRows = out;
    return out;
  }

  private runsFor(line: IBufferLine, caretCol: number): RenderRow['runs'] {
    const runs: RenderRow['runs'] = [];
    let cur: { text: string; style: CellStyle } | null = null;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x, this.cell);
      this.cell = cell;
      if (!cell) continue;
      const w = cell.getWidth();
      if (w === 0) continue; // spacer cell after a wide glyph — already emitted
      const chars = cell.getChars() || ' ';
      const style = styleOf(cell, x === caretCol);
      if (cur && styleEq(cur.style, style)) {
        cur.text += chars;
      } else {
        cur = { text: chars, style };
        runs.push(cur);
      }
    }
    if (runs.length === 0) runs.push({ text: '', style: {} });
    return runs;
  }

  jumpToPrompt(_fromRow: number, _dir: 1 | -1): number | null {
    return null; // implemented in Task 3
  }
}
