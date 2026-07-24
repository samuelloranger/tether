import './xtermPolyfill';
import { type IBufferCell, type IBufferLine, Terminal } from '@xterm/headless';
import { computeLinkSpans, type LinkSpan } from './links';
import { base64ToUtf8, type CellStyle, PALETTE, type RenderRow } from './terminal';

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
  private cell: IBufferCell | undefined;
  private prevRows: RenderRow[] = [];
  private fed = 0; // linefeeds seen — drives the trim/logical-id math
  private promptIds = new Set<number>(); // monotonic logical ids marked by OSC 133;A

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
    this.term.onLineFeed(() => {
      this.fed++;
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
    // SGR mouse encoding (DECSET 1006) is not exposed on term.modes — observe it
    // via non-consuming DECSET/DECRST handlers.
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.includes(1006)) this.mouseSgr = true;
      return false;
    });
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (params.includes(1006)) this.mouseSgr = false;
      return false;
    });
    // DECSCUSR (CSI Ps SP q) — cursor shape.
    this.term.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
      const p = (params[0] as number) ?? 1;
      this.cursorStyle = p === 5 || p === 6 ? 'bar' : p === 3 || p === 4 ? 'underline' : 'block';
      return false;
    });

    // Title (OSC 0/2) and bell come through xterm's own events.
    this.term.onTitleChange((t2) => {
      this.title = t2;
    });
    this.term.onBell(() => {
      this.bellCount++;
    });

    // OSC 7 — cwd report (file://host/path).
    this.term.parser.registerOscHandler(7, (data) => {
      const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
      if (m) {
        try {
          this.cwd = decodeURIComponent(m[1]);
        } catch {
          this.cwd = m[1];
        }
      }
      return true;
    });
    // OSC 9 — iTerm2 growl: whole payload is the body.
    this.term.parser.registerOscHandler(9, (data) => {
      this.raiseNotify('', data);
      return true;
    });
    // OSC 777 — rxvt/ghostty "notify;<title>;<body>".
    this.term.parser.registerOscHandler(777, (data) => {
      const parts = data.split(';');
      if (parts[0] === 'notify') this.raiseNotify(parts[1] ?? '', parts[2] ?? '');
      return true;
    });
    // OSC 99 — kitty notification protocol (chunked).
    this.term.parser.registerOscHandler(99, (data) => {
      this.dispatchKittyNotify(data);
      return true;
    });
    // OSC 52 — clipboard write ("<selectors>;<base64|empty>"); query ('?') ignored.
    this.term.parser.registerOscHandler(52, (data) => {
      const sep = data.indexOf(';');
      if (sep === -1) return true;
      const payload = data.slice(sep + 1);
      if (payload === '?') return true;
      try {
        this.onClipboardWrite?.(base64ToUtf8(payload));
      } catch {
        // malformed base64 — drop silently
      }
      return true;
    });
  }

  private raiseNotify(title: string, body: string): void {
    this.lastNotify = { title, body };
    this.notifyCount++;
  }

  // kitty OSC 99: "<metadata>;<payload>" — colon-separated key=val metadata
  // (i=id, d=0 more chunks follow, p=title|body, e=1 base64). Ported verbatim
  // from the legacy emulator.
  private kittyNotif = new Map<string, { title: string; body: string }>();
  private dispatchKittyNotify(pt: string): void {
    const bodySep = pt.indexOf(';');
    if (bodySep === -1) return;
    const meta = new Map<string, string>();
    for (const kv of pt.slice(0, bodySep).split(':')) {
      const eq = kv.indexOf('=');
      if (eq !== -1) meta.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
    let payload = pt.slice(bodySep + 1);
    if (meta.get('e') === '1') {
      try {
        payload = base64ToUtf8(payload);
      } catch {
        return;
      }
    }
    const id = meta.get('i') ?? '';
    const ptype = meta.get('p') ?? 'title';
    const buf = this.kittyNotif.get(id) ?? { title: '', body: '' };
    if (ptype === 'title') buf.title += payload;
    else if (ptype === 'body') buf.body += payload;
    this.kittyNotif.set(id, buf);
    if (meta.get('d') === '0') return;
    this.kittyNotif.delete(id);
    if (buf.title || buf.body) this.raiseNotify(buf.title, buf.body);
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

  // Number of logical lines trimmed off the top of scrollback so far.
  private trimmedCount(): number {
    return Math.max(0, this.fed + 1 - this.term.buffer.active.length);
  }

  // Stable, monotonically-increasing id of the row the cursor sits on.
  private cursorLogicalId(): number {
    const buf = this.term.buffer.active;
    return this.trimmedCount() + buf.baseY + buf.cursorY;
  }

  get cols(): number {
    return this.term.cols;
  }
  get rows(): number {
    return this.term.rows;
  }

  write(data: string): void {
    this.term.write(data, () => this.syncModes());
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
    this.fed = 0;
    this.promptIds.clear();
  }

  getSnapshot(): RenderRow[] {
    const buf = this.term.buffer.active;
    const total = buf.length;
    const cursorAbs = buf.baseY + buf.cursorY;
    const trimmed = this.trimmedCount();

    // Prune prompt ids that have scrolled off the top so the Set stays bounded.
    if (this.promptIds.size) {
      for (const id of this.promptIds) if (id < trimmed) this.promptIds.delete(id);
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
      const caretCol = y === cursorAbs ? buf.cursorX : -1;
      rowRuns[y] = this.runsFor(line, caretCol);
      wrappedFlags[y] = line.isWrapped;
      texts[y] = rowRuns[y].map((r) => r.text).join('');
    }
    const linkSpans = computeLinkSpans(texts, wrappedFlags);

    const out: RenderRow[] = new Array(total);
    for (let y = 0; y < total; y++) {
      const key = trimmed + y;
      const runs = rowRuns[y];
      const wrapped = wrappedFlags[y];
      const links = linkSpans[y] ?? [];
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

  jumpToPrompt(fromRow: number, dir: 1 | -1): number | null {
    const snap = this.prevRows.length ? this.prevRows : this.getSnapshot();
    for (let i = fromRow + dir; i >= 0 && i < snap.length; i += dir) {
      if (snap[i].promptStart) return i;
    }
    return null;
  }
}
