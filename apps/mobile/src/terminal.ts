import { APP_THEMES } from './appTheme';
import { computeLinkSpans, type LinkSpan, type LinkTarget } from './links';

// A compact VT100/xterm terminal emulator: consumes the raw PTY byte stream and
// maintains a screen grid + scrollback so cursor-addressed output (prompts,
// status lines, TUIs like vim / Claude Code) renders correctly instead of being
// appended as literal control-code litter.
//
// Deliberately a common subset: cursor movement, erase, scroll regions, SGR
// (incl. 256-color / truecolor), and the alternate screen buffer. It is NOT a
// full DEC-conformant terminal.
// ponytail: covers the everyday agent/shell case; upgrade to xterm-headless if a
// TUI needs modes not handled here.

export interface CellStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  inverse?: boolean;
  caret?: boolean;
}

interface PaletteStyle {
  fgIndex?: number;
  bgIndex?: number;
}

interface Cell extends CellStyle, PaletteStyle {
  ch: string;
  url?: string;
}

export interface RenderRun {
  text: string;
  style: CellStyle;
}

export interface RenderRow {
  // Stable identity of the underlying logical screen line. Monotonic per
  // emulator; survives the line moving between screen and scrollback, so list
  // renderers can key on it instead of the array index (index keys shift by
  // one every time a line enters scrollback, remounting every visible row).
  key: number;
  runs: RenderRun[];
  // True when this row's logical line continues on the next row (soft-wrap, not
  // a real newline) — used to rejoin URLs split across the grid width.
  wrapped: boolean;
  // Link spans (column ranges → full URL) resolved across any soft-wrapped rows.
  links: LinkSpan[];
  // True when OSC 133;A (shell-integration prompt-start) marked this row.
  promptStart: boolean;
}

export let DEFAULT_FG = APP_THEMES.mocha.terminal.fg;
export let DEFAULT_BG = APP_THEMES.mocha.terminal.bg;
const MAX_SCROLLBACK = 1000;
// Cap OSC/CSI accumulation so a garbled or hostile stream that opens an escape
// sequence and never terminates it can't grow a buffer without bound.
const MAX_SEQ_LEN = 4096;

// The default Catppuccin Mocha ANSI palette, extended to xterm-256. Mutable:
// setTheme() below replaces BASE_16/PALETTE/DEFAULT_FG/DEFAULT_BG at
// runtime so an active session re-colors on its next repaint without needing a
// fresh TerminalEmulator instance.
let BASE_16 = [...APP_THEMES.mocha.terminal.base16];

function buildPalette(): string[] {
  const pal = [...BASE_16];
  const steps = [0, 95, 135, 175, 215, 255];
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++) pal.push(`#${hex(steps[r])}${hex(steps[g])}${hex(steps[b])}`);
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    pal.push(`#${hex(v)}${hex(v)}${hex(v)}`);
  }
  return pal; // length 256
}

// xterm OSC 10/11 reply color format: each "#rrggbb" hex byte doubled, e.g.
// "#1e1e2e" -> "rgb:1e1e/1e1e/2e2e".
function hexToOscColor(hex: string): string {
  const h = hex.replace('#', '');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `rgb:${r}${r}/${g}${g}/${b}${b}`;
}

// btoa/atob are Latin1-only; decoding arbitrary clipboard text (which may
// contain multi-byte UTF-8) needs the decodeURIComponent trick below rather
// than TextDecoder, whose Hermes support is less consistently available
// across RN versions than atob/decodeURIComponent.
function base64ToUtf8(b64: string): string {
  const latin1 = atob(b64);
  const percentEncoded = latin1
    .split('')
    .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');
  return decodeURIComponent(percentEncoded);
}

export let PALETTE = buildPalette();

export interface Theme {
  base16: string[]; // exactly 16 ANSI colors
  fg: string;
  bg: string;
}

// Applies a theme — rebuilds the 256-color PALETTE from the theme's 16 base
// colors and swaps the default fg/bg used by cells with no explicit SGR color.
export function setTheme(theme: Theme) {
  BASE_16 = theme.base16;
  PALETTE = buildPalette();
  DEFAULT_FG = theme.fg;
  DEFAULT_BG = theme.bg;
}

function blankCell(): Cell {
  return { ch: ' ' };
}
function blankLine(cols: number): Cell[] {
  return Array.from({ length: cols }, blankCell);
}

type ParserState = 'ground' | 'esc' | 'escInt' | 'csi' | 'osc' | 'oscEsc' | 'dcs' | 'dcsEsc';

// DEC Special Graphics (ESC ( 0) — the VT100 line-drawing set TUIs use for
// borders (htop, less, dialog). Unmapped chars pass through.
const DEC_GRAPHICS: Record<string, string> = {
  '`': '◆',
  a: '▒',
  f: '°',
  g: '±',
  j: '┘',
  k: '┐',
  l: '┌',
  m: '└',
  n: '┼',
  o: '⎺',
  p: '⎻',
  q: '─',
  r: '⎼',
  s: '⎽',
  t: '├',
  u: '┤',
  v: '┴',
  w: '┬',
  x: '│',
  y: '≤',
  z: '≥',
  '{': 'π',
  '|': '≠',
  '}': '£',
  '~': '·',
};

// ponytail: coarse wcwidth — the wide CJK/Hangul/emoji blocks only; combining
// marks and ambiguous-width chars are treated as narrow. Upgrade to a full
// wcwidth table if East-Asian alignment bugs surface.
function charWidth(cp: number): 1 | 2 {
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

// Mouse-reporting mode the app negotiated via DECSET 9/1000/1002/1003.
export type MouseMode = 'off' | 'x10' | 'normal' | 'button' | 'any';

export class TerminalEmulator {
  cols: number;
  rows: number;

  private screen: Cell[][] = [];
  private scrollback: Cell[][] = [];
  private alt: Cell[][] | null = null; // saved normal screen while in alt buffer
  private inAlt = false;

  // Lines whose content overflowed the width and continued on the next row
  // (soft-wrap). Keyed on the line array itself so membership follows the line
  // through splice/shift/scrollUp with no parallel bookkeeping; a fresh
  // blankLine (clear/scroll) is naturally absent, so its flag reads false.
  private wrappedLines = new WeakSet<Cell[]>();
  // Rows marked by OSC 133;A (shell-integration prompt-start), same
  // keyed-on-the-line-array pattern as wrappedLines above.
  private promptRows = new WeakSet<Cell[]>();
  private lastExitCode: number | null = null;

  private cx = 0;
  private cy = 0;
  private savedCx = 0;
  private savedCy = 0;
  private g0: 'ascii' | 'dec' = 'ascii';
  private g1: 'ascii' | 'dec' = 'ascii';
  private shiftOut = false; // SO selects G1, SI back to G0
  private escTarget: 'g0' | 'g1' | null = null;
  private scrollTop = 0;
  private scrollBot = 0;

  private pen: CellStyle & PaletteStyle = {};

  // Which mouse-reporting mode the app negotiated (DECSET 9/1000/1002/1003).
  // 'off' ⇒ no reporting. Lets the UI decide press-only vs drag vs any-motion.
  mouseMode: MouseMode = 'off';

  // True when reporting is active in any mode. Kept as a getter so existing
  // call sites (scroll gate, wheel forwarders) read it unchanged.
  get mouseOn(): boolean {
    return this.mouseMode !== 'off';
  }

  // True when the app negotiated SGR mouse encoding (?1006h). Off ⇒ the UI must
  // send legacy X10 mouse reports, which is what those apps parse.
  mouseSgr = false;

  // Cursor visibility (DECTCEM ?25). Shown for shells; TUIs hide it (?25l) and
  // draw their own, so the caret only renders when the app wants it visible.
  cursorVisible = true;

  // DECSCUSR (CSI Ps SP q) cursor shape + blink. Read by TermRow to render the
  // caret; defaults match a real terminal's power-on default (blinking block).
  cursorStyle: 'block' | 'bar' | 'underline' = 'block';
  cursorBlink = true;

  // Application-cursor-keys mode (DECCKM ?1). When on, arrow/Home/End keys must
  // be sent as SS3 (ESC O x) instead of CSI (ESC [ x) — vim, less, readline apps
  // enable it and misread CSI arrows otherwise. Read by the UI when encoding keys.
  applicationCursor = false;

  // Set by the app via ?2004h/l (bracketed paste). Read by the UI to decide
  // whether to wrap pasted text in \x1b[200~...\x1b[201~ before sending.
  bracketedPaste = false;

  // Monotonically increasing counter, incremented once per BEL (0x07) byte. A
  // counter (not a boolean) so the UI can detect a second bell even if it
  // hasn't re-rendered since the first.
  bellCount = 0;

  // Monotonically increasing counter, incremented once per OSC 133;A (shell
  // prompt start). A new prompt means the previous command finished — used
  // by the desktop app to notify when a long-running command completes.
  promptReturnCount = 0;

  // Bumped once per desktop-notification escape — OSC 9 (iTerm2), OSC 99
  // (kitty), OSC 777;notify (rxvt/ghostty); `lastNotify` holds the latest one.
  notifyCount = 0;
  lastNotify: { title: string; body: string } = { title: '', body: '' };
  // In-flight kitty (OSC 99) notifications by `i` id, accumulated across chunks.
  private kittyNotif = new Map<string, { title: string; body: string }>();

  // Set by OSC 0 ("icon name + title") or OSC 2 ("title"). Empty until the
  // remote shell/app sends one.
  title = '';

  // Set by OSC 7 (shell-integration cwd report, "file://host/path"). Empty
  // until the remote shell's prompt hook has fired at least once.
  cwd = '';

  // Wired by the UI to the live input channel. The emulator calls this for
  // sequences that expect a reply (DSR cursor report, DA identify) — without
  // it, apps that query the terminal and wait on the answer (readline, some
  // prompts) stall until their internal timeout.
  onReply: ((data: string) => void) | null = null;

  // Wired by the UI to the device clipboard (OSC 52 write: decoded payload
  // text). The query/read direction (OSC 52;c;?) is intentionally NOT
  // implemented — it would let any process running in the shell silently
  // read the device clipboard with no user consent, which is why real
  // terminals (xterm, kitty) disable OSC 52 read by default.
  onClipboardWrite: ((text: string) => void) | null = null;

  private state: ParserState = 'ground';
  private params = '';
  private intermediate = '';
  private oscBuf = '';

  constructor(cols = 80, rows = 24) {
    this.cols = cols;
    this.rows = rows;
    this.scrollBot = rows - 1;
    this.screen = Array.from({ length: rows }, () => blankLine(cols));
  }

  reset() {
    this.screen = Array.from({ length: this.rows }, () => blankLine(this.cols));
    this.scrollback = [];
    this.wrappedLines = new WeakSet();
    this.alt = null;
    this.inAlt = false;
    this.cx = this.cy = this.savedCx = this.savedCy = 0;
    this.scrollTop = 0;
    this.scrollBot = this.rows - 1;
    this.pen = {};
    this.mouseMode = 'off';
    this.mouseSgr = false;
    this.cursorVisible = true;
    this.cursorStyle = 'block';
    this.cursorBlink = true;
    this.bracketedPaste = false;
    this.applicationCursor = false;
    this.bellCount = 0;
    this.promptReturnCount = 0;
    this.notifyCount = 0;
    this.lastNotify = { title: '', body: '' };
    this.kittyNotif.clear();
    this.title = '';
    this.cwd = '';
    this.promptRows = new WeakSet();
    this.lastExitCode = null;
    this.oscBuf = '';
    this.prevRows = [];
    this.state = 'ground';
    this.params = '';
    this.intermediate = '';
    this.g0 = 'ascii';
    this.g1 = 'ascii';
    this.shiftOut = false;
    this.escTarget = null;
  }

  resize(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return;
    const colsChanged = cols !== this.cols;
    this.cols = cols;
    // Rows: shrink moves TOP lines into scrollback so the bottom (where the
    // prompt lives) stays visible — this runs on every keyboard show/hide.
    // Grow pulls them back. Alt-screen apps repaint on SIGWINCH, so there we
    // just truncate/pad.
    while (this.screen.length > rows) {
      if (!this.inAlt && this.cy > 0) {
        const top = this.screen.shift()!;
        this.scrollback.push(top);
        if (this.scrollback.length > MAX_SCROLLBACK) this.scrollback.shift();
        this.cy--;
      } else {
        this.screen.pop();
      }
    }
    while (this.screen.length < rows) {
      if (!this.inAlt && this.scrollback.length > 0) {
        this.screen.unshift(this.scrollback.pop()!);
        this.cy++;
      } else {
        this.screen.push(blankLine(cols));
      }
    }
    // Width changed → re-wrap scrollback history at the new width so old
    // output doesn't stay ragged after a font-size change or rotation. Runs
    // AFTER the row loops above so screen rows a shrink just pushed into
    // scrollback get rewrapped too (a combined cols+rows resize — rotation —
    // would otherwise leave them at the old width). The live screen is left
    // alone: the shell/TUI repaints it on SIGWINCH, and leaving it keeps the
    // cursor math untouched.
    if (colsChanged && !this.inAlt) this.reflowScrollback(cols);
    this.rows = rows;
    this.screen = this.screen.map((l) => this.fitLine(l, cols));
    this.cx = Math.min(this.cx, cols - 1);
    this.cy = Math.min(this.cy, rows - 1);
    this.scrollTop = 0;
    this.scrollBot = rows - 1;
  }

  // Re-wrap scrollback at a new width. Soft-wrapped fragments (wrappedLines
  // marks) are joined into their logical line, trailing default blanks
  // trimmed, and the cells re-chunked at the new width with fresh wrap marks.
  // A logical line whose last fragment continues onto the live screen is
  // copied through untouched — reflowing half a line would tear it.
  private reflowScrollback(cols: number) {
    if (this.scrollback.length === 0) return;
    const out: Cell[][] = [];
    let i = 0;
    while (i < this.scrollback.length) {
      let last = i;
      while (last < this.scrollback.length - 1 && this.wrappedLines.has(this.scrollback[last])) {
        last++;
      }
      if (this.wrappedLines.has(this.scrollback[last])) {
        // Continues into the screen — pass the fragments through as-is.
        for (let j = i; j <= last; j++) out.push(this.scrollback[j]);
        i = last + 1;
        continue;
      }
      const promptStart = this.promptRows.has(this.scrollback[i]);
      const chunk: Cell[] = [];
      for (let j = i; j <= last; j++) chunk.push(...this.scrollback[j]);
      let end = chunk.length;
      while (
        end > 0 &&
        chunk[end - 1].ch === ' ' &&
        !chunk[end - 1].bg &&
        chunk[end - 1].bgIndex === undefined &&
        !chunk[end - 1].inverse
      ) {
        end--;
      }
      const cells = chunk.slice(0, end);
      const rows: Cell[][] = [];
      if (cells.length === 0) rows.push(blankLine(cols));
      else {
        for (let p = 0; p < cells.length; p += cols) {
          const row = cells.slice(p, p + cols);
          while (row.length < cols) row.push(blankCell());
          rows.push(row);
        }
      }
      for (let k = 0; k < rows.length - 1; k++) this.wrappedLines.add(rows[k]);
      if (promptStart) this.promptRows.add(rows[0]);
      out.push(...rows);
      i = last + 1;
    }
    while (out.length > MAX_SCROLLBACK) out.shift();
    this.scrollback = out;
  }

  private fitLine(line: Cell[], cols: number): Cell[] {
    // Return the SAME array when it already fits: resize() maps this over
    // every on-screen row on ANY resize (e.g. rows-only changes from the
    // keyboard showing/hiding), and wrappedLines/promptRows are WeakSets
    // keyed on row identity — a needless copy here silently orphans those
    // flags, breaking wrapped-link reconstruction and jump-to-prompt nav.
    if (line.length === cols) return line;
    const out = line.slice(0, cols);
    while (out.length < cols) out.push(blankCell());
    return out;
  }

  // --- Stream input (state persists across calls, so split sequences are fine) ---
  write(data: string) {
    for (const ch of data) {
      const code = ch.codePointAt(0)!;
      switch (this.state) {
        case 'ground':
          this.ground(ch, code);
          break;
        case 'esc':
          this.esc(ch);
          break;
        case 'escInt': {
          if (this.escTarget) {
            const set = ch === '0' ? 'dec' : 'ascii';
            if (this.escTarget === 'g0') this.g0 = set;
            else this.g1 = set;
            this.escTarget = null;
          }
          this.state = 'ground';
          break;
        }
        case 'csi':
          this.csi(ch, code);
          break;
        case 'osc':
          if (code === 0x07) {
            this.dispatchOsc(this.oscBuf);
            this.oscBuf = '';
            this.state = 'ground';
          } else if (code === 0x1b) {
            this.state = 'oscEsc';
          } else {
            this.oscBuf += ch;
            if (this.oscBuf.length > MAX_SEQ_LEN) {
              this.oscBuf = '';
              this.state = 'ground';
            }
          }
          break;
        case 'oscEsc':
          // ESC \ (ST) properly terminates; any other byte here means a
          // malformed OSC (seen in the wild from a corrupted Warp
          // shell-integration string, same failure mode as the DCS parser
          // below) — dispatch what we buffered anyway rather than drop a
          // whole title/cwd/hyperlink update.
          this.dispatchOsc(this.oscBuf);
          this.oscBuf = '';
          this.state = 'ground';
          break;
        case 'dcs':
          if (code === 0x07) this.state = 'ground';
          else if (code === 0x1b) this.state = 'dcsEsc';
          break;
        case 'dcsEsc':
          // Proper ST terminator (ESC \) drops it. Anything else means the DCS
          // never got terminated (seen in the wild from a corrupted Warp
          // shell-integration string) — treat this ESC as the start of a new
          // sequence instead of swallowing it, so the parser recovers.
          if (ch === '\\') this.state = 'ground';
          else this.esc(ch);
          break;
      }
    }
  }

  private ground(ch: string, code: number) {
    if (code === 0x1b) {
      this.state = 'esc';
    } else if (code === 0x0a || code === 0x0b || code === 0x0c) {
      this.lineFeed();
    } else if (code === 0x0d) {
      this.cx = 0;
    } else if (code === 0x08) {
      this.cx = Math.max(0, this.cx - 1);
    } else if (code === 0x09) {
      this.cx = Math.min(this.cols - 1, (Math.floor(this.cx / 8) + 1) * 8);
    } else if (code === 0x07) {
      this.bellCount++;
    } else if (code === 0x0e) {
      this.shiftOut = true; // SO
    } else if (code === 0x0f) {
      this.shiftOut = false; // SI
    } else if (code >= 0x20) {
      this.putChar(ch);
    }
    // other C0 controls ignored
  }

  private esc(ch: string) {
    switch (ch) {
      case '[':
        this.state = 'csi';
        this.params = '';
        this.intermediate = '';
        return;
      case ']':
        this.oscBuf = '';
        this.state = 'osc';
        return;
      case 'P':
        this.state = 'dcs';
        return;
      case '(':
      case ')':
        this.escTarget = ch === '(' ? 'g0' : 'g1';
        this.state = 'escInt';
        return;
      case '*':
      case '+':
        this.escTarget = null; // G2/G3 unsupported — consume designator only
        this.state = 'escInt';
        return;
      case '7':
        this.savedCx = this.cx;
        this.savedCy = this.cy;
        break;
      case '8':
        this.cx = this.savedCx;
        this.cy = this.savedCy;
        break;
      case 'D':
        this.lineFeed(); // IND — index (line feed without carriage return)
        break;
      case 'E':
        this.lineFeed(); // NEL — next line
        this.cx = 0;
        break;
      case 'M':
        this.reverseIndex();
        break;
      case 'c':
        this.reset();
        return;
      // '=', '>', etc. — ignore
    }
    this.state = 'ground';
  }

  private csi(ch: string, code: number) {
    if (this.params.length + this.intermediate.length > MAX_SEQ_LEN) {
      // Runaway parameter/intermediate run — abandon the sequence.
      this.params = '';
      this.intermediate = '';
      this.state = 'ground';
      return;
    }
    if (code >= 0x30 && code <= 0x3f) {
      this.params += ch;
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.intermediate += ch;
      return;
    }
    if (code >= 0x40 && code <= 0x7e) {
      this.dispatchCsi(ch);
      this.state = 'ground';
    }
    // else: malformed, stay until a final byte arrives
  }

  private nums(def: number): number[] {
    const raw = /^[<=>?]/.test(this.params) ? this.params.slice(1) : this.params;
    if (!raw) return [def];
    return raw.split(';').map((p) => {
      const n = parseInt(p, 10);
      return isNaN(n) ? def : n;
    });
  }

  private dispatchCsi(final: string) {
    // DECSCUSR: CSI Ps SP q — cursor shape/blink. Handled before the generic
    // intermediate-byte bail-out below (this is the one intermediate-byte
    // sequence we do implement).
    if (this.intermediate === ' ' && final === 'q') {
      const n = this.nums(0)[0] ?? 0;
      this.cursorStyle = n <= 2 ? 'block' : n <= 4 ? 'underline' : 'bar';
      this.cursorBlink = n === 0 || n % 2 === 1;
      return;
    }
    // Sequences with intermediate bytes (CSI Ps SP A scroll-right, CSI ! p
    // soft reset, ...) share final bytes with plain ANSI actions but mean
    // something else entirely. None of the rest are implemented — ignore
    // them wholesale rather than misdispatch (SP A would run as cursor-up).
    if (this.intermediate) return;
    // Private parameter prefix byte (0x3c-0x3f): '?' DEC modes, and '<' '=' '>'
    // used by the kitty keyboard protocol / XTMODKEYS / XTVERSION. A prefixed
    // sequence is never the plain ANSI action with the same final byte.
    const prefix = /^[<=>?]/.test(this.params) ? this.params[0] : '';
    const priv = prefix === '?';
    const p = this.nums(0);
    const n = Math.max(1, p[0] || 1);

    switch (final) {
      case 'A':
        this.cy = Math.max(this.scrollTop, this.cy - n);
        break;
      case 'B':
        this.cy = Math.min(this.scrollBot, this.cy + n);
        break;
      case 'C':
        this.cx = Math.min(this.cols - 1, this.cx + n);
        break;
      case 'D':
        this.cx = Math.max(0, this.cx - n);
        break;
      case 'E':
        this.cy = Math.min(this.scrollBot, this.cy + n);
        this.cx = 0;
        break;
      case 'F':
        this.cy = Math.max(this.scrollTop, this.cy - n);
        this.cx = 0;
        break;
      case 'G':
      case '`':
        this.cx = this.clampX((p[0] || 1) - 1);
        break;
      case 'd':
        this.cy = this.clampY((p[0] || 1) - 1);
        break;
      case 'H':
      case 'f':
        this.cy = this.clampY((p[0] || 1) - 1);
        this.cx = this.clampX((p[1] || 1) - 1);
        break;
      case 'J':
        this.eraseDisplay(p[0] || 0);
        break;
      case 'K':
        this.eraseLine(p[0] || 0);
        break;
      case 'L':
        this.insertLines(n);
        break;
      case 'M':
        this.deleteLines(n);
        break;
      case 'P':
        this.deleteChars(n);
        break;
      case '@':
        this.insertChars(n);
        break;
      case 'X':
        this.eraseChars(n);
        break;
      case 'S':
        this.scrollUp(n);
        break;
      case 'T':
        this.scrollDown(n);
        break;
      case 'r':
        this.scrollTop = this.clampY((p[0] || 1) - 1);
        this.scrollBot = this.clampY((p[1] || this.rows) - 1);
        if (this.scrollBot < this.scrollTop) this.scrollBot = this.scrollTop;
        this.cx = 0;
        this.cy = this.scrollTop;
        break;
      case 's':
        // Plain CSI s = save cursor. CSI ? Ps s is XTSAVE (private mode save).
        if (!prefix) {
          this.savedCx = this.cx;
          this.savedCy = this.cy;
        }
        break;
      case 'u':
        // Plain CSI u = restore cursor. CSI < u / CSI > Ps u / CSI = Ps u /
        // CSI ? u are the kitty keyboard protocol (pop/push/set/query) —
        // claude emits CSI < u on exit; treating it as restore-cursor
        // teleported the cursor into the old transcript.
        if (!prefix) {
          this.cx = this.savedCx;
          this.cy = this.savedCy;
        }
        break;
      case 'h':
        if (priv) this.setMode(p, true);
        break;
      case 'l':
        if (priv) this.setMode(p, false);
        break;
      case 'm':
        // CSI > Ps m is XTMODKEYS, CSI ? Ps m is XTQMODKEYS — not SGR.
        if (!prefix) this.applySgr();
        break;
      case 'n':
        // DSR — device status report. 5 = "are you ok", 6 = cursor position.
        // Only plain DSR; CSI > Ps n (key-modifier control) and CSI ? Ps n
        // (DEC DSR) are private — replying to them injects a bogus cursor
        // report into the PTY.
        if (!prefix && p[0] === 6) this.onReply?.(`\x1b[${this.cy + 1};${this.cx + 1}R`);
        else if (!prefix && p[0] === 5) this.onReply?.('\x1b[0n');
        break;
      case 'c':
        // DA — device attributes. Plain = primary, '>' = secondary. '=' is
        // tertiary DA — answering it with the primary string confuses the
        // querying app, so stay silent (like the ignored '?' form).
        if (prefix === '>') this.onReply?.('\x1b[>0;0;0c');
        else if (!prefix) this.onReply?.('\x1b[?1;2c');
        break;
      // 't', etc. (window ops) — ignored; nothing to reply on
    }
  }

  private setMode(params: number[], on: boolean) {
    for (const m of params) {
      if (m === 1049 || m === 47 || m === 1047) {
        this.setAltScreen(on);
      } else if (m === 9) {
        this.mouseMode = on ? 'x10' : 'off';
      } else if (m === 1000) {
        this.mouseMode = on ? 'normal' : 'off';
      } else if (m === 1002) {
        this.mouseMode = on ? 'button' : 'off';
      } else if (m === 1003) {
        this.mouseMode = on ? 'any' : 'off';
      } else if (m === 25) {
        this.cursorVisible = on; // DECTCEM
      } else if (m === 1006) {
        this.mouseSgr = on; // SGR extended mouse encoding
      } else if (m === 2004) {
        this.bracketedPaste = on;
      } else if (m === 1) {
        this.applicationCursor = on; // DECCKM — app cursor keys (SS3 vs CSI)
      }
      // 2026 (sync) — ignored.
    }
  }

  private setAltScreen(on: boolean) {
    if (on && !this.inAlt) {
      this.alt = this.screen;
      this.savedCx = this.cx;
      this.savedCy = this.cy;
      this.screen = Array.from({ length: this.rows }, () => blankLine(this.cols));
      this.cx = 0;
      this.cy = 0;
      this.scrollTop = 0;
      this.scrollBot = this.rows - 1;
      this.inAlt = true;
    } else if (!on && this.inAlt) {
      this.screen = this.alt || Array.from({ length: this.rows }, () => blankLine(this.cols));
      this.alt = null;
      this.cx = this.savedCx;
      this.cy = this.savedCy;
      this.inAlt = false;
    }
  }

  // --- OSC (title, cwd, hyperlinks, shell-integration) ---
  // buf is the content between "ESC ]" and the terminator, format "Ps;Pt...".
  private dispatchOsc(buf: string) {
    const sep = buf.indexOf(';');
    const ps = sep === -1 ? buf : buf.slice(0, sep);
    const pt = sep === -1 ? '' : buf.slice(sep + 1);
    if (ps === '0' || ps === '2') {
      this.title = pt;
    } else if (ps === '9') {
      // iTerm2 growl notification: the whole payload is the message body.
      this.raiseNotify('', pt);
    } else if (ps === '99') {
      this.dispatchKittyNotify(pt);
    } else if (ps === '777') {
      // rxvt/ghostty: "notify;<title>;<body>" (body optional). Other 777
      // subcommands (precmd, …) are ignored.
      const parts = pt.split(';');
      if (parts[0] === 'notify') this.raiseNotify(parts[1] ?? '', parts[2] ?? '');
    } else if (ps === '7') {
      const m = /^file:\/\/[^/]*(\/.*)$/.exec(pt);
      if (m) {
        try {
          this.cwd = decodeURIComponent(m[1]);
        } catch {
          this.cwd = m[1];
        }
      }
    } else if (ps === '133') {
      if (pt.startsWith('A')) {
        this.promptRows.add(this.screen[this.cy]);
        this.promptReturnCount++;
      } else if (pt.startsWith('D')) {
        const codeStr = pt.split(';')[1];
        this.lastExitCode = codeStr !== undefined ? parseInt(codeStr, 10) : null;
      }
    } else if (ps === '8') {
      // "params;URI" — params (e.g. id=xxx) is ignored; empty URI closes the link.
      const uriSep = pt.indexOf(';');
      const uri = uriSep === -1 ? '' : pt.slice(uriSep + 1);
      (this.pen as Cell).url = uri || undefined;
    } else if (ps === '10' || ps === '11') {
      // Query-only (xterm's "set fg/bg" direction is intentionally unsupported —
      // our themes are fixed, a remote app should not override them).
      if (pt === '?') {
        const color = ps === '10' ? DEFAULT_FG : DEFAULT_BG;
        this.onReply?.(`\x1b]${ps};${hexToOscColor(color)}\x1b\\`);
      }
    } else if (ps === '52') {
      // pt is "<buffer-letters>;<base64-or-empty>" — buffer letter (c/p/s/0-7)
      // is ignored, mobile has no separate primary-selection concept. Query
      // (Pt === '?') is intentionally NOT implemented — see onClipboardWrite's
      // doc comment above for why.
      const dataSep = pt.indexOf(';');
      if (dataSep === -1) return;
      const payload = pt.slice(dataSep + 1);
      if (payload === '?') return;
      try {
        // Empty payload is the valid "clear the clipboard" form.
        this.onClipboardWrite?.(base64ToUtf8(payload));
      } catch {
        // Malformed base64 — drop silently, same as other malformed OSC payloads.
      }
    }
  }

  private raiseNotify(title: string, body: string) {
    this.lastNotify = { title, body };
    this.notifyCount++;
  }

  // kitty notification protocol (OSC 99): "<metadata>;<payload>". Metadata is a
  // colon-separated key=val list — i=id, d=0 means more chunks follow (else
  // done), p=title|body (default title; other types carry no text), e=1 base64.
  private dispatchKittyNotify(pt: string) {
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
        return; // malformed base64 — drop, same as other malformed OSC payloads
      }
    }
    const id = meta.get('i') ?? '';
    const ptype = meta.get('p') ?? 'title';
    const buf = this.kittyNotif.get(id) ?? { title: '', body: '' };
    if (ptype === 'title') buf.title += payload;
    else if (ptype === 'body') buf.body += payload;
    // Any other payload type (close/alive/…) contributes no text.
    this.kittyNotif.set(id, buf);
    if (meta.get('d') === '0') return; // incomplete — wait for the final chunk
    this.kittyNotif.delete(id);
    if (buf.title || buf.body) this.raiseNotify(buf.title, buf.body);
  }

  // --- Grid operations ---
  private clampX(x: number) {
    return Math.max(0, Math.min(this.cols - 1, x));
  }
  private clampY(y: number) {
    return Math.max(0, Math.min(this.rows - 1, y));
  }

  private putChar(ch: string) {
    const active = this.shiftOut ? this.g1 : this.g0;
    if (active === 'dec') ch = DEC_GRAPHICS[ch] ?? ch;
    const w = charWidth(ch.codePointAt(0)!);
    if (this.cx + w > this.cols) {
      // The row we're leaving continues here — mark it soft-wrapped so a URL
      // split across the width can be rejoined at render time.
      this.wrappedLines.add(this.screen[this.cy]);
      this.cx = 0;
      this.lineFeed();
    }
    this.screen[this.cy][this.cx] = { ch, ...this.pen };
    // Wide glyphs own two cells: the second is a zero-width filler so column
    // math (cursor addressing, erase) stays aligned. mergeRuns concats '' away.
    if (w === 2 && this.cx + 1 < this.cols) {
      this.screen[this.cy][this.cx + 1] = { ch: '', ...this.pen };
    }
    this.cx += w;
  }

  private lineFeed() {
    if (this.cy === this.scrollBot) {
      this.scrollUp(1);
    } else if (this.cy < this.rows - 1) {
      this.cy++;
    }
  }

  private reverseIndex() {
    if (this.cy === this.scrollTop) {
      this.scrollDown(1);
    } else if (this.cy > 0) {
      this.cy--;
    }
  }

  private scrollUp(n: number) {
    for (let i = 0; i < n; i++) {
      const removed = this.screen[this.scrollTop];
      // Only content leaving the top of a full-height normal screen is history.
      // (Alt-screen apps repaint in place; capturing there just yields garbage.)
      if (!this.inAlt && this.scrollTop === 0) {
        this.scrollback.push(removed);
        if (this.scrollback.length > MAX_SCROLLBACK) this.scrollback.shift();
      }
      this.screen.splice(this.scrollTop, 1);
      this.screen.splice(this.scrollBot, 0, this.penBlankLine());
    }
  }

  private scrollDown(n: number) {
    for (let i = 0; i < n; i++) {
      this.screen.splice(this.scrollBot, 1);
      this.screen.splice(this.scrollTop, 0, this.penBlankLine());
    }
  }

  private eraseDisplay(mode: number) {
    if (mode === 0) {
      this.eraseLine(0);
      for (let y = this.cy + 1; y < this.rows; y++) this.screen[y] = this.penBlankLine();
    } else if (mode === 1) {
      this.eraseLine(1);
      for (let y = 0; y < this.cy; y++) this.screen[y] = this.penBlankLine();
    } else if (mode === 2 || mode === 3) {
      for (let y = 0; y < this.rows; y++) this.screen[y] = this.penBlankLine();
      if (mode === 3) this.scrollback = [];
    }
  }

  // Background Color Erase (BCE): erase/scroll fills take the pen's current
  // background (xterm semantics), so a TUI that sets a bg then clears paints
  // the whole area — not just cells it explicitly wrote. fg/attrs never copy.
  private penBlank(): Cell {
    const cell: Cell = { ch: ' ' };
    if (this.pen.bgIndex !== undefined) cell.bgIndex = this.pen.bgIndex;
    else if (this.pen.bg) cell.bg = this.pen.bg;
    return cell;
  }

  private penBlankLine(): Cell[] {
    return Array.from({ length: this.cols }, () => this.penBlank());
  }

  private eraseLine(mode: number) {
    const line = this.screen[this.cy];
    // An erased line is no longer a full soft-wrap continuation.
    this.wrappedLines.delete(line);
    if (mode === 0) for (let x = this.cx; x < this.cols; x++) line[x] = this.penBlank();
    else if (mode === 1) for (let x = 0; x <= this.cx; x++) line[x] = this.penBlank();
    else if (mode === 2) for (let x = 0; x < this.cols; x++) line[x] = this.penBlank();
  }

  private eraseChars(n: number) {
    const line = this.screen[this.cy];
    for (let x = this.cx; x < Math.min(this.cols, this.cx + n); x++) line[x] = this.penBlank();
  }

  private insertChars(n: number) {
    const line = this.screen[this.cy];
    for (let i = 0; i < n; i++) {
      line.splice(this.cx, 0, blankCell());
      line.pop();
    }
  }

  private deleteChars(n: number) {
    const line = this.screen[this.cy];
    for (let i = 0; i < n; i++) {
      line.splice(this.cx, 1);
      line.push(blankCell());
    }
  }

  private insertLines(n: number) {
    if (this.cy < this.scrollTop || this.cy > this.scrollBot) return;
    for (let i = 0; i < n; i++) {
      this.screen.splice(this.scrollBot, 1);
      this.screen.splice(this.cy, 0, this.penBlankLine());
    }
  }

  private deleteLines(n: number) {
    if (this.cy < this.scrollTop || this.cy > this.scrollBot) return;
    for (let i = 0; i < n; i++) {
      this.screen.splice(this.cy, 1);
      this.screen.splice(this.scrollBot, 0, this.penBlankLine());
    }
  }

  // --- SGR (colors / attributes) ---
  private applySgr() {
    const codes = this.nums(0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) this.pen = {};
      else if (c === 1) this.pen.bold = true;
      else if (c === 2) this.pen.dim = true;
      else if (c === 3) this.pen.italic = true;
      else if (c === 4) this.pen.underline = true;
      else if (c === 7) this.pen.inverse = true;
      else if (c === 9) this.pen.strike = true;
      else if (c === 22) {
        this.pen.bold = false;
        this.pen.dim = false;
      } else if (c === 23) this.pen.italic = false;
      else if (c === 24) this.pen.underline = false;
      else if (c === 27) this.pen.inverse = false;
      else if (c === 29) this.pen.strike = false;
      else if (c >= 30 && c <= 37) this.pen.fgIndex = c - 30;
      else if (c === 39) {
        this.pen.fg = undefined;
        this.pen.fgIndex = undefined;
      } else if (c >= 40 && c <= 47) this.pen.bgIndex = c - 40;
      else if (c === 49) {
        this.pen.bg = undefined;
        this.pen.bgIndex = undefined;
      } else if (c >= 90 && c <= 97) this.pen.fgIndex = c - 90 + 8;
      else if (c >= 100 && c <= 107) this.pen.bgIndex = c - 100 + 8;
      else if (c === 38 || c === 48) {
        const target = c === 38 ? 'fg' : 'bg';
        if (codes[i + 1] === 5) {
          // 38;5;n  (256-color)
          const index = codes[i + 2];
          this.pen[target] = PALETTE[index] ?? undefined;
          this.pen[target === 'fg' ? 'fgIndex' : 'bgIndex'] = PALETTE[index] ? index : undefined;
          i += 2;
        } else if (codes[i + 1] === 2) {
          // 38;2;r;g;b  (24-bit truecolor)
          const r = codes[i + 2],
            g = codes[i + 3],
            b = codes[i + 4];
          const hex = (v: number) => (v || 0).toString(16).padStart(2, '0');
          this.pen[target] = `#${hex(r)}${hex(g)}${hex(b)}`;
          this.pen[target === 'fg' ? 'fgIndex' : 'bgIndex'] = undefined;
          i += 4;
        }
      }
    }
  }

  // --- Render snapshot ---
  private prevRows: RenderRow[] = [];

  // See RenderRow.key. WeakMap keyed on the line array itself, same pattern
  // as wrappedLines — identity follows the line through splice/shift/scroll.
  private lineIds = new WeakMap<Cell[], number>();
  private lineIdSeq = 1;
  private idFor(line: Cell[]): number {
    let id = this.lineIds.get(line);
    if (id === undefined) {
      id = this.lineIdSeq++;
      this.lineIds.set(line, id);
    }
    return id;
  }

  // Returns one RenderRow per line, REUSING the previous frame's object for any
  // row whose content is unchanged. Referential stability lets a memoized row
  // component skip re-rendering — critical when a TUI repaints continuously
  // (e.g. Claude Code's spinner) so only changed rows cost anything.
  getSnapshot(): RenderRow[] {
    const lines = [...this.scrollback, ...this.screen];
    // The caret sits at the cursor cell on the current screen row (when visible).
    const caretRow = this.cursorVisible ? this.scrollback.length + this.cy : -1;
    const caretCol = Math.min(this.cx, this.cols - 1); // cx can sit at cols (pending wrap)
    const rowRuns = lines.map((l, i) => this.mergeRuns(l, i === caretRow ? caretCol : -1));
    const wrapped = lines.map((l) => this.wrappedLines.has(l));
    const promptFlags = lines.map((l) => this.promptRows.has(l));
    // Resolve URLs over logical lines (joining soft-wrapped rows) so a link
    // split across the width is tappable — as a whole — on every fragment.
    const texts = rowRuns.map((runs) => runs.map((r) => r.text).join(''));
    const regexLinks = computeLinkSpans(texts, wrapped);
    const links = lines.map((line, i) => {
      const explicit = explicitLinkSpans(line);
      return explicit.length ? explicit : regexLinks[i];
    });
    const out: RenderRow[] = new Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      const prev = this.prevRows[i];
      const key = this.idFor(lines[i]);
      out[i] =
        prev &&
        prev.key === key &&
        prev.wrapped === wrapped[i] &&
        prev.promptStart === promptFlags[i] &&
        runsEqual(prev.runs, rowRuns[i]) &&
        linksEqual(prev.links, links[i])
          ? prev
          : { key, runs: rowRuns[i], wrapped: wrapped[i], links: links[i], promptStart: promptFlags[i] };
    }
    this.prevRows = out;
    return out;
  }

  // Returns the row index (in getSnapshot()'s combined scrollback+screen
  // coordinate space) of the next prompt-start row searching from `fromRow` in
  // direction `dir` (1 = forward, -1 = backward), or null if there is none.
  jumpToPrompt(fromRow: number, dir: 1 | -1): number | null {
    const lines = [...this.scrollback, ...this.screen];
    for (let i = fromRow + dir; i >= 0 && i < lines.length; i += dir) {
      if (this.promptRows.has(lines[i])) return i;
    }
    return null;
  }

  private mergeRuns(line: Cell[], caretCol = -1): RenderRun[] {
    // Trim trailing blanks so empty tails don't paint background — but never trim
    // past the caret, so the cursor still renders at end of line.
    let end = line.length;
    while (
      end > 0 &&
      line[end - 1].ch === ' ' &&
      !line[end - 1].bg &&
      line[end - 1].bgIndex === undefined &&
      !line[end - 1].inverse
    ) {
      end--;
    }
    if (caretCol >= 0) end = Math.max(end, caretCol + 1);
    if (end === 0) return [{ text: ' ', style: {} }];

    const runs: RenderRun[] = [];
    let cur: RenderRun | null = null;
    for (let x = 0; x < end; x++) {
      const cell = line[x];
      const style = this.cellStyle(cell);
      if (x === caretCol) style.caret = true; // isolate the caret cell into its own run
      if (cur && !style.caret && sameStyle(cur.style, style)) {
        cur.text += cell.ch;
      } else {
        cur = { text: cell.ch, style };
        runs.push(cur);
      }
    }
    return runs;
  }

  private cellStyle(cell: Cell): CellStyle {
    let fg = cell.fgIndex === undefined ? (cell.fg ?? DEFAULT_FG) : PALETTE[cell.fgIndex];
    let bg = cell.bgIndex === undefined ? cell.bg : PALETTE[cell.bgIndex];
    if (cell.inverse) {
      const nfg = bg ?? DEFAULT_BG;
      const nbg = fg;
      fg = nfg;
      bg = nbg;
    }
    const style: CellStyle = { fg };
    if (bg) style.bg = bg;
    if (cell.bold) style.bold = true;
    if (cell.dim) style.dim = true;
    if (cell.italic) style.italic = true;
    if (cell.underline) style.underline = true;
    if (cell.strike) style.strike = true;
    return style;
  }
}

function sameStyle(a: CellStyle, b: CellStyle): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    !!a.caret === !!b.caret
  );
}

function runsEqual(a: RenderRun[], b: RenderRun[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text || !sameStyle(a[i].style, b[i].style)) return false;
  }
  return true;
}

function linksEqual(a: LinkSpan[], b: LinkSpan[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].start !== b[i].start ||
      a[i].end !== b[i].end ||
      !targetsEqual(a[i].target, b[i].target)
    )
      return false;
  }
  return true;
}

function targetsEqual(a: LinkTarget, b: LinkTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'external' && b.kind === 'external') return a.url === b.url;
  if (a.kind === 'file' && b.kind === 'file')
    return a.path === b.path && a.line === b.line && a.column === b.column;
  return false;
}

// Contiguous same-URL cell runs on one row, as LinkSpans — explicit OSC-8
// links take priority over regex URL detection for any row that has them.
function explicitLinkSpans(line: Cell[]): LinkSpan[] {
  const out: LinkSpan[] = [];
  let i = 0;
  while (i < line.length) {
    const url = line[i].url;
    if (!url) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < line.length && line[j].url === url) j++;
    out.push({ start: i, end: j, target: { kind: 'external', url } });
    i = j;
  }
  return out;
}
