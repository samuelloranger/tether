import './xtermPolyfill';
import { SerializeAddon } from '@xterm/addon-serialize';
import { type IBufferCell, type IBufferLine, Terminal } from '@xterm/headless';
import type { Terminal as BrowserTerminal } from '@xterm/xterm';
import { computeLinkSpans, type LinkSpan } from './links';
import { type CellStyle, DEFAULT_BG, DEFAULT_FG, PALETTE, type RenderRow } from './terminal';
import {
  type ControlHost,
  registerTerminalControls,
  type TerminalControls,
} from './terminalControls';

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

// Exclusive column after the last non-blank cell on a line (for clamping an
// OSC 8 span that closed on a later row).
function lastContentCol(line: IBufferLine): number {
  let last = 0;
  for (let x = 0; x < line.length; x++) {
    const c = line.getCell(x);
    if (c && (c.getChars() || '').trim() !== '') last = x + c.getWidth();
  }
  return last;
}

function styleOf(cell: IBufferCell, caret: boolean): CellStyle {
  const s: CellStyle = {};
  let fg = fgOf(cell);
  let bg = bgOf(cell);
  // Resolve SGR 7 reverse video by swapping fg/bg here — TermRow renders only
  // resolved fg/bg and never consumes an `inverse` flag (matches legacy).
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

function targetEq(a: LinkSpan['target'], b: LinkSpan['target']): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'external' && b.kind === 'external') return a.url === b.url;
  if (a.kind === 'file' && b.kind === 'file')
    return a.path === b.path && a.line === b.line && a.column === b.column;
  return false;
}

function linksEqual(a: RenderRow['links'], b: RenderRow['links']): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end || !targetEq(a[i].target, b[i].target))
      return false;
  }
  return true;
}

// Adapter wrapping @xterm/headless with the TerminalEmulator public surface, so
// it is a drop-in replacement. Reads term.buffer.active to emit RenderRow[].
export class TerminalEngine {
  private term: Terminal;
  private serializeAddon = new SerializeAddon();
  private cell: IBufferCell | undefined;
  private prevRows: RenderRow[] = [];
  private fed = 0; // linefeeds seen — drives the trim/logical-id math
  private promptIds = new Set<number>(); // monotonic logical ids marked by OSC 133;A
  // logical row id -> OSC 8 spans + the label text captured at close, so a later
  // repaint of the row (CR/EL overwriting those cells) invalidates the stale span.
  private osc8Spans = new Map<number, { span: LinkSpan; text: string }[]>();
  private osc8Open: { url: string; startId: number; startCol: number } | null = null;
  private controls: TerminalControls;

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
  cursorVisible = true; // DECTCEM (CSI ?25 h/l)
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
    // SerializeAddon uses only xterm's public buffer API and works with the
    // headless Terminal at runtime, but its published type names the browser
    // Terminal class specifically.
    this.serializeAddon.activate(this.term as unknown as BrowserTerminal);
    // xterm emits generated replies (DSR/DA) through onData; the app sends user
    // input separately, so onData here carries only auto-replies.
    this.term.onData((d) => this.onReply?.(d));
    this.term.onLineFeed(() => {
      // Only normal-buffer feeds grow scrollback. The alt screen (vim/less) has
      // a fixed viewport, so counting its feeds would inflate the trim math and
      // wrongly prune promptIds/OSC 8 spans after the app exits full-screen.
      if (this.term.buffer.active.type === 'normal') this.fed++;
    });
    // OSC 133;A marks a prompt start; ;D reports command-return. Record the
    // prompt at the cursor's current monotonic logical id.
    this.term.parser.registerOscHandler(133, (data) => {
      // ;A = new prompt start (previous command finished) — mark the row and
      // bump the return counter (matches the legacy emulator's semantics).
      if (data.startsWith('A')) {
        this.promptIds.add(this.cursorLogicalId());
        this.promptReturnCount++;
      }
      return false; // let xterm run its own OSC 133 handling too
    });
    // OSC 8 explicit hyperlinks: "params;URI" (empty URI closes). xterm headless
    // exposes no per-cell URL, so track open/close against the cursor and emit
    // column ranges into the row's link spans (text != URL, unlike regex links).
    this.term.parser.registerOscHandler(8, (data) => {
      const semi = data.indexOf(';');
      const uri = semi === -1 ? '' : data.slice(semi + 1);
      this.closeOsc8();
      if (uri) {
        this.osc8Open = {
          url: uri,
          startId: this.cursorLogicalId(),
          startCol: this.term.buffer.active.cursorX,
        };
      }
      return true;
    });
    // Everything below is buffer-independent control state, shared with the
    // renderer page so whichever host is parsing can report it — see
    // terminalControls.ts.
    this.controls = registerTerminalControls(
      this.term as unknown as ControlHost,
      {
        title: (t2) => {
          this.title = t2;
        },
        bell: () => {
          this.bellCount++;
        },
        cwd: (path) => {
          this.cwd = path;
        },
        notify: (title, body) => this.raiseNotify(title, body),
        cursorStyle: (style) => {
          this.cursorStyle = style;
        },
        mouseSgr: (enabled) => {
          this.mouseSgr = enabled;
        },
        cursorVisible: (visible) => {
          this.cursorVisible = visible;
        },
        reply: (data) => this.onReply?.(data),
        clipboardWrite: (text) => this.onClipboardWrite?.(text),
      },
      { foreground: DEFAULT_FG, background: DEFAULT_BG },
    );
  }

  private raiseNotify(title: string, body: string): void {
    this.lastNotify = { title, body };
    this.notifyCount++;
  }

  private syncModes(): void {
    const m = this.term.modes;
    this.applicationCursor = m.applicationCursorKeysMode;
    this.bracketedPaste = m.bracketedPasteMode;
    switch (m.mouseTrackingMode) {
      case 'x10':
        this.mouseMode = 'x10';
        break;
      case 'vt200':
        this.mouseMode = 'normal';
        break;
      case 'drag':
        this.mouseMode = 'button';
        break;
      case 'any':
        this.mouseMode = 'any';
        break;
      default:
        this.mouseMode = 'off';
    }
  }

  // Number of logical lines trimmed off the top of scrollback so far. Always
  // measured against the NORMAL buffer length so it stays stable while the alt
  // screen is active (the alt buffer has no scrollback and a fixed length).
  private trimmedCount(): number {
    return Math.max(0, this.fed + 1 - this.term.buffer.normal.length);
  }

  // Stable, monotonically-increasing id of the row the cursor sits on.
  private cursorLogicalId(): number {
    const buf = this.term.buffer.active;
    return this.trimmedCount() + buf.baseY + buf.cursorY;
  }

  // Finalize an open OSC 8 link from its start marker to the cursor now.
  private closeOsc8(): void {
    const o = this.osc8Open;
    if (!o) return;
    this.osc8Open = null;
    const buf = this.term.buffer.active;
    const trimmed = this.trimmedCount();
    const endId = this.cursorLogicalId();
    const endCol = buf.cursorX;
    // The hyperlinked label can span multiple logical rows (soft-wrap or a
    // newline before the close). Tag every covered row so the whole label is
    // tappable — start row from startCol, interior rows fully, end row up to the
    // cursor. (headless has no per-cell URL, so we reconstruct from the range.)
    for (let id = o.startId; id <= endId; id++) {
      const startCol = id === o.startId ? o.startCol : 0;
      const y = id - trimmed;
      const line = y >= 0 && y < buf.length ? buf.getLine(y) : null;
      const end = id === endId ? endCol : line ? lastContentCol(line) : this.term.cols;
      if (end <= startCol) continue;
      const span: LinkSpan = { start: startCol, end, target: { kind: 'external', url: o.url } };
      const text = line ? line.translateToString(false, startCol, end) : '';
      const list = this.osc8Spans.get(id) ?? [];
      list.push({ span, text });
      this.osc8Spans.set(id, list);
    }
  }

  // OSC 8 spans for a row whose labeled cells still hold the captured text.
  // A repaint (overwrite/erase) changes the text → the stale span is dropped.
  private freshOsc8(id: number): LinkSpan[] {
    const entries = this.osc8Spans.get(id);
    if (!entries) return [];
    const y = id - this.trimmedCount();
    const line =
      y >= 0 && y < this.term.buffer.active.length ? this.term.buffer.active.getLine(y) : null;
    if (!line) return [];
    const kept = entries.filter(
      (e) => line.translateToString(false, e.span.start, e.span.end) === e.text,
    );
    if (kept.length !== entries.length) {
      if (kept.length) this.osc8Spans.set(id, kept);
      else this.osc8Spans.delete(id);
    }
    return kept.map((e) => e.span);
  }

  get cols(): number {
    return this.term.cols;
  }
  get rows(): number {
    return this.term.rows;
  }

  // `onFlush` runs after xterm drains this write — by then OSC/BEL handlers have
  // bumped bellCount/notifyCount, so the ws handler can check notifications there
  // (a synchronous read right after write() sees stale counters — xterm is async).
  write(data: string, onFlush?: () => void): void {
    this.term.write(data, () => {
      this.syncModes();
      onFlush?.();
    });
  }

  // Test/detail helper: resolve once xterm has flushed its write queue.
  drain(): Promise<void> {
    return new Promise((resolve) => this.term.write('', resolve));
  }

  async getSettledSnapshot(): Promise<RenderRow[]> {
    await this.drain();
    return this.getSnapshot();
  }

  serialize(): string {
    return this.serializeAddon.serialize();
  }

  /** Buffer-local y indices of OSC 133 prompt marks (for page hydrate handoff). */
  getPromptLines(): number[] {
    const trimmed = this.trimmedCount();
    const lines: number[] = [];
    for (const id of this.promptIds) {
      const y = id - trimmed;
      if (y >= 0) lines.push(y);
    }
    return lines.sort((a, b) => a - b);
  }

  /** Restore prompt marks after a serialize seed (ids relative to current trim). */
  restorePromptLines(lines: number[]): void {
    this.promptIds.clear();
    const trimmed = this.trimmedCount();
    for (const y of lines) {
      if (Number.isInteger(y) && y >= 0) this.promptIds.add(trimmed + y);
    }
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
    this.cursorVisible = true;
    this.prevRows = [];
    this.fed = 0;
    this.promptIds.clear();
    this.osc8Spans.clear();
    this.osc8Open = null;
    this.controls.reset(); // drop any half-assembled kitty OSC 99 chunk
  }

  getSnapshot(): RenderRow[] {
    const buf = this.term.buffer.active;
    const total = buf.length;
    const cursorAbs = buf.baseY + buf.cursorY;
    const trimmed = this.trimmedCount();

    // Prune prompt ids / OSC 8 spans that scrolled off the top (bounded Sets/Maps).
    if (this.promptIds.size) {
      for (const id of this.promptIds) if (id < trimmed) this.promptIds.delete(id);
    }
    if (this.osc8Spans.size) {
      for (const id of this.osc8Spans.keys()) if (id < trimmed) this.osc8Spans.delete(id);
    }

    // First pass: per-row runs + text, so links can be resolved across soft wraps.
    const rowRuns: RenderRow['runs'][] = new Array(total);
    const wrappedFlags: boolean[] = new Array(total);
    const texts: string[] = new Array(total);
    for (let y = 0; y < total; y++) {
      const line = buf.getLine(y);
      if (!line) {
        rowRuns[y] = [{ text: '', style: {} }];
        wrappedFlags[y] = false;
        texts[y] = '';
        continue;
      }
      const caretCol = this.cursorVisible && y === cursorAbs ? buf.cursorX : -1;
      rowRuns[y] = this.runsFor(line, caretCol);
      // xterm's `isWrapped` means "this row is a CONTINUATION of the previous
      // one"; computeLinkSpans wants "this row wraps INTO the next", so read the
      // flag off the following line.
      wrappedFlags[y] = buf.getLine(y + 1)?.isWrapped ?? false;
      texts[y] = rowRuns[y].map((r) => r.text).join('');
    }
    const linkSpans = computeLinkSpans(texts, wrappedFlags);

    const out: RenderRow[] = new Array(total);
    for (let y = 0; y < total; y++) {
      const key = trimmed + y;
      const runs = rowRuns[y];
      const wrapped = wrappedFlags[y];
      // OSC 8 explicit hyperlinks (validated against current row content) take
      // precedence over regex-detected URLs.
      const osc8 = this.osc8Spans.has(key) ? this.freshOsc8(key) : [];
      const links = osc8.length ? osc8 : (linkSpans[y] ?? []);
      const promptStart = this.promptIds.has(key);
      const prev = this.prevRows[y];
      out[y] =
        prev &&
        prev.key === key &&
        prev.wrapped === wrapped &&
        prev.promptStart === promptStart &&
        runsEqual(prev.runs, runs) &&
        linksEqual(prev.links, links)
          ? prev
          : { key, runs, wrapped, links, promptStart };
    }
    this.prevRows = out;
    return out;
  }

  private runsFor(line: IBufferLine, caretCol: number): RenderRow['runs'] {
    // Trim trailing default blanks so empty tails don't pad copied/searched text
    // or paint background — but keep bg-colored / inverse cells and never trim
    // past the caret (matches the legacy emulator).
    let end = 0;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x, this.cell);
      this.cell = cell;
      if (!cell) continue;
      const w = cell.getWidth() || 1;
      const chars = cell.getChars();
      const significant =
        (chars !== '' && chars.trim() !== '') || bgOf(cell) !== undefined || cell.isInverse();
      if (significant) end = x + w;
    }
    if (caretCol >= 0) end = Math.max(end, caretCol + 1);
    if (end === 0) return [{ text: '', style: {} }];

    const runs: RenderRow['runs'] = [];
    let cur: { text: string; style: CellStyle } | null = null;
    for (let x = 0; x < end; x++) {
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

  jumpToPrompt(fromRow: number, dir: 1 | -1): number | null {
    const snap = this.prevRows.length ? this.prevRows : this.getSnapshot();
    for (let i = fromRow + dir; i >= 0 && i < snap.length; i += dir) {
      if (snap[i].promptStart) return i;
    }
    return null;
  }
}
