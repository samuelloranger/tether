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

interface Cell extends CellStyle {
  ch: string;
}

export interface RenderRun {
  text: string;
  style: CellStyle;
}

export interface RenderRow {
  runs: RenderRun[];
}

const DEFAULT_FG = '#cbd5e1';
const DEFAULT_BG = '#05070e';
const MAX_SCROLLBACK = 1000;

// Standard 16-color terminal palette (VS Code integrated-terminal values),
// extended to xterm-256. Using conventional colors so themed TUIs look correct.
const BASE_16 = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];

function buildPalette(): string[] {
  const pal = [...BASE_16];
  const steps = [0, 95, 135, 175, 215, 255];
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++)
        pal.push(`#${hex(steps[r])}${hex(steps[g])}${hex(steps[b])}`);
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    pal.push(`#${hex(v)}${hex(v)}${hex(v)}`);
  }
  return pal; // length 256
}
const PALETTE = buildPalette();

function blankCell(): Cell {
  return { ch: ' ' };
}
function blankLine(cols: number): Cell[] {
  return Array.from({ length: cols }, blankCell);
}

type ParserState = 'ground' | 'esc' | 'escInt' | 'csi' | 'osc' | 'oscEsc' | 'dcs' | 'dcsEsc';

// ponytail: coarse wcwidth — the wide CJK/Hangul/emoji blocks only; combining
// marks and ambiguous-width chars are treated as narrow. Upgrade to a full
// wcwidth table if East-Asian alignment bugs surface.
// DEC Special Graphics (ESC ( 0) — the VT100 line-drawing set TUIs use for
// borders (htop, less, dialog). Unmapped chars pass through.
const DEC_GRAPHICS: Record<string, string> = {
  '`': '◆', a: '▒', f: '°', g: '±', j: '┘', k: '┐', l: '┌', m: '└',
  n: '┼', o: '⎺', p: '⎻', q: '─', r: '⎼', s: '⎽', t: '├', u: '┤',
  v: '┴', w: '┬', x: '│', y: '≤', z: '≥', '{': 'π', '|': '≠', '}': '£', '~': '·',
};

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

export class TerminalEmulator {
  cols: number;
  rows: number;

  private screen: Cell[][] = [];
  private scrollback: Cell[][] = [];
  private alt: Cell[][] | null = null; // saved normal screen while in alt buffer
  private inAlt = false;

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

  private pen: CellStyle = {};

  // True when the app has enabled mouse reporting (?1000/1002/1003h). Lets the
  // UI forward swipes as scroll-wheel events so TUIs scroll their own history.
  mouseOn = false;

  // Cursor visibility (DECTCEM ?25). Shown for shells; TUIs hide it (?25l) and
  // draw their own, so the caret only renders when the app wants it visible.
  cursorVisible = true;

  // Set by the app via ?2004h/l (bracketed paste). Read by the UI to decide
  // whether to wrap pasted text in \x1b[200~...\x1b[201~ before sending.
  bracketedPaste = false;

  // Wired by the UI to the live input channel. The emulator calls this for
  // sequences that expect a reply (DSR cursor report, DA identify) — without
  // it, apps that query the terminal and wait on the answer (readline, some
  // prompts) stall until their internal timeout.
  onReply: ((data: string) => void) | null = null;

  private state: ParserState = 'ground';
  private params = '';
  private intermediate = '';

  constructor(cols = 80, rows = 24) {
    this.cols = cols;
    this.rows = rows;
    this.scrollBot = rows - 1;
    this.screen = Array.from({ length: rows }, () => blankLine(cols));
  }

  reset() {
    this.screen = Array.from({ length: this.rows }, () => blankLine(this.cols));
    this.scrollback = [];
    this.alt = null;
    this.inAlt = false;
    this.cx = this.cy = this.savedCx = this.savedCy = 0;
    this.scrollTop = 0;
    this.scrollBot = this.rows - 1;
    this.pen = {};
    this.mouseOn = false;
    this.cursorVisible = true;
    this.bracketedPaste = false;
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
    this.cols = cols;
    // Rows: shrink moves TOP lines into scrollback so the bottom (where the
    // prompt lives) stays visible — this runs on every keyboard show/hide.
    // Grow pulls them back. Alt-screen apps repaint on SIGWINCH, so there we
    // just truncate/pad. No column reflow (xterm doesn't reflow either).
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
    this.rows = rows;
    this.screen = this.screen.map((l) => this.fitLine(l, cols));
    this.cx = Math.min(this.cx, cols - 1);
    this.cy = Math.min(this.cy, rows - 1);
    this.scrollTop = 0;
    this.scrollBot = rows - 1;
  }

  private fitLine(line: Cell[], cols: number): Cell[] {
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
          if (code === 0x07) this.state = 'ground';
          else if (code === 0x1b) this.state = 'oscEsc';
          break;
        case 'oscEsc':
          this.state = 'ground'; // drop ST terminator
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
      // bell, ignore
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
      case 'M':
        this.reverseIndex();
        break;
      case 'c':
        this.reset();
        return;
      // '=', '>', 'D', 'E', etc. — ignore
    }
    this.state = 'ground';
  }

  private csi(ch: string, code: number) {
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
    const priv = this.params.startsWith('?');
    const raw = priv ? this.params.slice(1) : this.params;
    if (!raw) return [def];
    return raw.split(';').map((p) => {
      const n = parseInt(p, 10);
      return isNaN(n) ? def : n;
    });
  }

  private dispatchCsi(final: string) {
    const priv = this.params.startsWith('?');
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
        this.savedCx = this.cx;
        this.savedCy = this.cy;
        break;
      case 'u':
        this.cx = this.savedCx;
        this.cy = this.savedCy;
        break;
      case 'h':
        if (priv) this.setMode(p, true);
        break;
      case 'l':
        if (priv) this.setMode(p, false);
        break;
      case 'm':
        this.applySgr();
        break;
      case 'n':
        // DSR — device status report. 5 = "are you ok", 6 = cursor position.
        if (!priv && p[0] === 6) this.onReply?.(`\x1b[${this.cy + 1};${this.cx + 1}R`);
        else if (!priv && p[0] === 5) this.onReply?.('\x1b[0n');
        break;
      case 'c':
        // DA — device attributes. '>' (secondary DA) lands in params too since
        // it's in the 0x3c-0x3f intermediate range consumed by csi().
        if (this.params.startsWith('>')) this.onReply?.('\x1b[>0;0;0c');
        else if (!priv) this.onReply?.('\x1b[?1;2c');
        break;
      // 't', etc. (window ops) — ignored; nothing to reply on
    }
  }

  private setMode(params: number[], on: boolean) {
    for (const m of params) {
      if (m === 1049 || m === 47 || m === 1047) {
        this.setAltScreen(on);
      } else if (m === 1000 || m === 1002 || m === 1003) {
        this.mouseOn = on; // mouse reporting enabled/disabled
      } else if (m === 25) {
        this.cursorVisible = on; // DECTCEM
      } else if (m === 2004) {
        this.bracketedPaste = on;
      }
      // 2026 (sync), 1 (app cursor) — ignored.
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
      this.screen.splice(this.scrollBot, 0, blankLine(this.cols));
    }
  }

  private scrollDown(n: number) {
    for (let i = 0; i < n; i++) {
      this.screen.splice(this.scrollBot, 1);
      this.screen.splice(this.scrollTop, 0, blankLine(this.cols));
    }
  }

  private eraseDisplay(mode: number) {
    if (mode === 0) {
      this.eraseLine(0);
      for (let y = this.cy + 1; y < this.rows; y++) this.screen[y] = blankLine(this.cols);
    } else if (mode === 1) {
      this.eraseLine(1);
      for (let y = 0; y < this.cy; y++) this.screen[y] = blankLine(this.cols);
    } else if (mode === 2 || mode === 3) {
      for (let y = 0; y < this.rows; y++) this.screen[y] = blankLine(this.cols);
      if (mode === 3) this.scrollback = [];
    }
  }

  private eraseLine(mode: number) {
    const line = this.screen[this.cy];
    if (mode === 0) for (let x = this.cx; x < this.cols; x++) line[x] = blankCell();
    else if (mode === 1) for (let x = 0; x <= this.cx; x++) line[x] = blankCell();
    else if (mode === 2) for (let x = 0; x < this.cols; x++) line[x] = blankCell();
  }

  private eraseChars(n: number) {
    const line = this.screen[this.cy];
    for (let x = this.cx; x < Math.min(this.cols, this.cx + n); x++) line[x] = blankCell();
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
      this.screen.splice(this.cy, 0, blankLine(this.cols));
    }
  }

  private deleteLines(n: number) {
    if (this.cy < this.scrollTop || this.cy > this.scrollBot) return;
    for (let i = 0; i < n; i++) {
      this.screen.splice(this.cy, 1);
      this.screen.splice(this.scrollBot, 0, blankLine(this.cols));
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
      }
      else if (c === 23) this.pen.italic = false;
      else if (c === 24) this.pen.underline = false;
      else if (c === 27) this.pen.inverse = false;
      else if (c === 29) this.pen.strike = false;
      else if (c >= 30 && c <= 37) this.pen.fg = PALETTE[c - 30];
      else if (c === 39) this.pen.fg = undefined;
      else if (c >= 40 && c <= 47) this.pen.bg = PALETTE[c - 40];
      else if (c === 49) this.pen.bg = undefined;
      else if (c >= 90 && c <= 97) this.pen.fg = PALETTE[c - 90 + 8];
      else if (c >= 100 && c <= 107) this.pen.bg = PALETTE[c - 100 + 8];
      else if (c === 38 || c === 48) {
        const target = c === 38 ? 'fg' : 'bg';
        if (codes[i + 1] === 5) {
          // 38;5;n  (256-color)
          this.pen[target] = PALETTE[codes[i + 2]] ?? undefined;
          i += 2;
        } else if (codes[i + 1] === 2) {
          // 38;2;r;g;b  (24-bit truecolor)
          const r = codes[i + 2], g = codes[i + 3], b = codes[i + 4];
          const hex = (v: number) => (v || 0).toString(16).padStart(2, '0');
          this.pen[target] = `#${hex(r)}${hex(g)}${hex(b)}`;
          i += 4;
        }
      }
    }
  }

  // --- Render snapshot ---
  private prevRows: RenderRow[] = [];

  // Returns one RenderRow per line, REUSING the previous frame's object for any
  // row whose content is unchanged. Referential stability lets a memoized row
  // component skip re-rendering — critical when a TUI repaints continuously
  // (e.g. Claude Code's spinner) so only changed rows cost anything.
  getSnapshot(): RenderRow[] {
    const lines = [...this.scrollback, ...this.screen];
    // The caret sits at the cursor cell on the current screen row (when visible).
    const caretRow = this.cursorVisible ? this.scrollback.length + this.cy : -1;
    const caretCol = Math.min(this.cx, this.cols - 1); // cx can sit at cols (pending wrap)
    const out: RenderRow[] = new Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      const runs = this.mergeRuns(lines[i], i === caretRow ? caretCol : -1);
      const prev = this.prevRows[i];
      out[i] = prev && runsEqual(prev.runs, runs) ? prev : { runs };
    }
    this.prevRows = out;
    return out;
  }

  private mergeRuns(line: Cell[], caretCol = -1): RenderRun[] {
    // Trim trailing blanks so empty tails don't paint background — but never trim
    // past the caret, so the cursor still renders at end of line.
    let end = line.length;
    while (end > 0 && line[end - 1].ch === ' ' && !line[end - 1].bg && !line[end - 1].inverse) {
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
    let fg = cell.fg ?? DEFAULT_FG;
    let bg = cell.bg;
    if (cell.inverse) {
      const nfg = bg ?? DEFAULT_BG;
      const nbg = cell.fg ?? DEFAULT_FG;
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
