// Terminal control sequences that carry state the *app* cares about — window
// title, working directory, bell, desktop notifications, cursor shape, keyboard
// and mouse modes, clipboard writes — as opposed to sequences that only paint.
//
// Two different xterm instances need to observe these: the app-side headless
// engine, and the renderer page inside the WebView. Whichever of the two is
// parsing a given session has to be able to report them, so the handlers live
// here once and are attached to either host. Everything in this module is
// buffer-independent by design; anything that needs logical row ids (OSC 133
// prompt marks, OSC 8 link spans) stays with the host that owns the buffer.

// The subset of xterm's Terminal that registering controls requires. Declared
// structurally so the same code binds to @xterm/headless and @xterm/xterm,
// whose classes are nominally different types.
export interface ControlHost {
  parser: {
    registerOscHandler(ident: number, callback: (data: string) => boolean): unknown;
    registerCsiHandler(
      id: { prefix?: string; intermediates?: string; final: string },
      callback: (params: (number | number[])[]) => boolean,
    ): unknown;
  };
  onTitleChange(listener: (title: string) => void): unknown;
  onBell(listener: () => void): unknown;
}

export type CursorStyle = 'block' | 'bar' | 'underline';

export interface ControlSink {
  title(title: string): void;
  bell(): void;
  cwd(path: string): void;
  notify(title: string, body: string): void;
  cursorStyle(style: CursorStyle): void;
  /** DECSET 1006 — SGR mouse encoding, which xterm does not expose on modes. */
  mouseSgr(enabled: boolean): void;
  /** DECTCEM — cursor visibility. */
  cursorVisible(visible: boolean): void;
  /** A generated reply (OSC 10/11 colour query) to send back to the PTY. */
  reply(data: string): void;
  clipboardWrite(text: string): void;
}

export function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// xterm OSC 10/11 reply colour format: each "#rrggbb" hex byte doubled, e.g.
// "#1e1e2e" -> "rgb:1e1e/1e1e/2e2e".
export function hexToOscColor(hex: string): string {
  const h = hex.replace('#', '');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `rgb:${r}${r}/${g}${g}/${b}${b}`;
}

// kitty's OSC 99 arrives in chunks keyed by notification id, so the assembler
// has to outlive a single handler call.
class KittyNotifications {
  private pending = new Map<string, { title: string; body: string }>();

  clear(): void {
    this.pending.clear();
  }

  // "<metadata>;<payload>" — colon-separated key=val metadata (i=id, d=0 means
  // more chunks follow, p=title|body, e=1 means the payload is base64).
  dispatch(data: string, notify: (title: string, body: string) => void): void {
    const bodySep = data.indexOf(';');
    if (bodySep === -1) return;
    const meta = new Map<string, string>();
    for (const kv of data.slice(0, bodySep).split(':')) {
      const eq = kv.indexOf('=');
      if (eq !== -1) meta.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
    let payload = data.slice(bodySep + 1);
    if (meta.get('e') === '1') {
      try {
        payload = base64ToUtf8(payload);
      } catch {
        return;
      }
    }
    const id = meta.get('i') ?? '';
    const kind = meta.get('p') ?? 'title';
    const buf = this.pending.get(id) ?? { title: '', body: '' };
    if (kind === 'title') buf.title += payload;
    else if (kind === 'body') buf.body += payload;
    this.pending.set(id, buf);
    if (meta.get('d') === '0') return; // more chunks coming
    this.pending.delete(id);
    if (buf.title || buf.body) notify(buf.title, buf.body);
  }
}

export interface TerminalControls {
  /** Drop any half-assembled chunked notification (on terminal reset). */
  reset(): void;
}

export function registerTerminalControls(
  term: ControlHost,
  sink: ControlSink,
  colors: { foreground: string; background: string },
): TerminalControls {
  const kitty = new KittyNotifications();

  term.onTitleChange((title) => sink.title(title));
  term.onBell(() => sink.bell());

  // OSC 7 — cwd report (file://host/path).
  term.parser.registerOscHandler(7, (data) => {
    const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
    if (m) {
      try {
        sink.cwd(decodeURIComponent(m[1]));
      } catch {
        sink.cwd(m[1]);
      }
    }
    return true;
  });

  // OSC 9 — iTerm2 growl: the whole payload is the body.
  term.parser.registerOscHandler(9, (data) => {
    sink.notify('', data);
    return true;
  });

  // OSC 777 — rxvt/ghostty "notify;<title>;<body>".
  term.parser.registerOscHandler(777, (data) => {
    const parts = data.split(';');
    if (parts[0] === 'notify') sink.notify(parts[1] ?? '', parts[2] ?? '');
    return true;
  });

  // OSC 99 — kitty notification protocol (chunked).
  term.parser.registerOscHandler(99, (data) => {
    kitty.dispatch(data, (title, body) => sink.notify(title, body));
    return true;
  });

  // OSC 10/11 — fg/bg colour query. Reply with the app theme's default; setting
  // the colour is intentionally unsupported, since themes are fixed.
  term.parser.registerOscHandler(10, (data) => {
    if (data === '?') sink.reply(`\x1b]10;${hexToOscColor(colors.foreground)}\x1b\\`);
    return true;
  });
  term.parser.registerOscHandler(11, (data) => {
    if (data === '?') sink.reply(`\x1b]11;${hexToOscColor(colors.background)}\x1b\\`);
    return true;
  });

  // OSC 52 — clipboard write ("<selectors>;<base64|empty>"); query ('?') ignored.
  term.parser.registerOscHandler(52, (data) => {
    const sep = data.indexOf(';');
    if (sep === -1) return true;
    const payload = data.slice(sep + 1);
    if (payload === '?') return true;
    try {
      sink.clipboardWrite(base64ToUtf8(payload));
    } catch {
      // malformed base64 — drop silently
    }
    return true;
  });

  // DECSET/DECRST observers. These return false on purpose: xterm still has to
  // apply the mode itself, this is only an observation.
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (params.includes(1006)) sink.mouseSgr(true);
    if (params.includes(25)) sink.cursorVisible(true);
    return false;
  });
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    if (params.includes(1006)) sink.mouseSgr(false);
    if (params.includes(25)) sink.cursorVisible(false);
    return false;
  });

  // DECSCUSR (CSI Ps SP q) — cursor shape.
  term.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
    const p = (params[0] as number) ?? 1;
    sink.cursorStyle(p === 5 || p === 6 ? 'bar' : p === 3 || p === 4 ? 'underline' : 'block');
    return false;
  });

  return {
    reset: () => kitty.clear(),
  };
}
