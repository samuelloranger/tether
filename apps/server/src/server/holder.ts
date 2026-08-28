// PTY holder: a tiny detached process that owns one session's PTY so the shell
// (and everything running in it — claude, builds, ssh) survives tether server
// restarts. The server talks to it over a unix socket with length-prefixed
// binary frames — see holderFrame.ts for the frame kinds and for why a holder
// still understands the pre-v2 newline-JSON dialect on the way in.
//
// Invoked in-process via the `holder` subcommand (main.ts), so it works whether
// running from source (bun) or the compiled binary. argv is the tail after the
// subcommand: <socketPath> <cols> <rows> <cwd> <cmd> [args...]

import { chmodSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  decodeHolderFrame,
  decodeLegacyHolderLine,
  encodeHolderCwd,
  encodeHolderExit,
  encodeHolderHello,
  encodeHolderOutput,
  type HolderDialect,
  type HolderMessage,
  sniffDialect,
  takeLegacyLines,
} from './holderFrame';
import { INITIAL_LIVE_CWD_STATE, type LiveCwdState, updateLiveCwd } from './liveCwd';
import { getProcessCwd } from './procCwd';
import { FrameDecoder } from './proto/frame';
import { interruptForeground } from './winConsole';

const IS_WINDOWS = process.platform === 'win32';
/** Ctrl+C. The byte a terminal sends; on POSIX the line discipline signals on it. */
const ETX = 0x03;

// Windows has no /proc/<pid>/cwd. getProcessCwd does read the Win32 cwd out of
// the target's PEB there, but only answers for shells measured to keep that in
// step with where they actually are — cmd.exe does, PowerShell and MSYS bash
// never move it off the startup directory (the table is in procCwd.ts). So for
// the default Windows shell it still returns null, and without a fallback a
// holder that outlived a server restart could only ever report the directory it
// was *spawned* in — every `cd` the user made before the restart would be lost,
// and the git/file features would come back pointing at the wrong tree.
//
// The holder already sees every output byte, so it tracks the same OSC 7
// escapes the server parses and keeps the last one as its answer. Only on
// Windows: where the kernel read works it is strictly better (it is current
// even mid-TUI, with no prompt redraw needed), and this keeps the POSIX hot
// path free of the extra per-chunk scan.
const TRACK_OSC7_CWD = process.platform === 'win32';
let osc7Cwd: LiveCwdState = INITIAL_LIVE_CWD_STATE;
const osc7Decoder = new TextDecoder('utf-8');

function trackOsc7Cwd(bytes: Uint8Array): void {
  if (!TRACK_OSC7_CWD) return;
  osc7Cwd = updateLiveCwd(osc7Cwd, osc7Decoder.decode(bytes, { stream: true }));
}

/** The shell's cwd: straight from the kernel where that works, else last OSC 7. */
function holderCwd(pid: number): string | null {
  return getProcessCwd(pid) ?? osc7Cwd.cwd;
}

// A process's session id, read straight from the kernel (/proc/<pid>/stat
// field 6 — session — after the "pid (comm)" prefix, which we skip past by
// index since comm can itself contain spaces/parens).
function getSid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(rest[3]);
  } catch {
    return null;
  }
}

// Every live pid sharing a given session id — i.e. everything descended from
// the shell that hasn't setsid'd itself into a session of its own.
function pidsInSession(sid: number): number[] {
  const pids: number[] = [];
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (getSid(pid) === sid) pids.push(pid);
    }
  } catch {}
  return pids;
}

type HolderProc = ReturnType<typeof Bun.spawn>;

// Interactive shells ignore SIGTERM; SIGHUP is the "terminal went away" signal
// they honor. Escalate to SIGKILL for anything that ignores both.
// Windows has no process groups to signal and no SIGHUP: node maps every
// signal name it accepts to a bare TerminateProcess on the one pid, which
// leaves the shell's children (the build, the agent, the ssh) orphaned and
// running. taskkill /T walks the real parent/child tree the kernel tracks, so
// it is the only thing here that actually matches the POSIX behaviour above.
// /F because an interactive shell will not close on the polite request either.
function killWindowsTree(pid: number): void {
  try {
    Bun.spawnSync(['taskkill.exe', '/PID', String(pid), '/T', '/F'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {}
}

function killHolderPty(proc: HolderProc): void {
  if (process.platform === 'win32') {
    killWindowsTree(proc.pid);
    return;
  }
  // Background jobs the shell was told to survive it (nohup, disown) never
  // get the shell's SIGHUP forwarded to them and would otherwise keep
  // running as orphans after an explicit "kill this terminal" — sweep the
  // whole session synchronously, before touching the shell itself, so it
  // can't race the holder's own exit-on-shell-death path below.
  const sid = getSid(proc.pid) ?? proc.pid;
  // Freeze the session first so nothing new can fork out from under the scan,
  // then re-enumerate and kill. A child forked between the two passes is still
  // caught. (A child that setsid's into its own session is intentionally out
  // of scope — that's how real daemons detach.)
  for (const pid of pidsInSession(sid)) {
    if (pid === proc.pid) continue;
    try {
      process.kill(pid, 'SIGSTOP');
    } catch {}
  }
  for (const pid of pidsInSession(sid)) {
    if (pid === proc.pid) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  proc.kill('SIGHUP');
  setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {}
  }, 1000);
}

function applyHolderFrame(
  proc: HolderProc,
  msg: HolderMessage | null,
  killPty: () => void,
  buf?: HolderBuffer,
): void {
  if (!msg) return;
  try {
    if (msg.type === 'input' && proc.terminal) {
      proc.terminal.write(Buffer.from(msg.data).toString('utf8'));
      // The byte still goes through first, unconditionally: that is what makes
      // ^C work at a PSReadLine prompt and inside raw-mode TUIs. On Windows it
      // is also all that happens, so a running job additionally needs the
      // interrupt reproduced by hand — see winConsole.ts.
      if (IS_WINDOWS && msg.data.includes(ETX)) interruptForeground(proc.pid);
    } else if (msg.type === 'resize' && proc.terminal) {
      proc.terminal.resize(msg.cols, msg.rows);
    } else if (msg.type === 'kill') {
      killPty();
    } else if (msg.type === 'cwdRequest') {
      // Answer from the kernel, not from a remembered value: the point of the
      // request is that the shell may have `cd`-ed since anyone last looked.
      const cwd = holderCwd(proc.pid);
      if (cwd && buf?.client) buf.client.write(encodeHolderCwd(cwd));
    }
  } catch {}
}

// ponytail: 2MB ring of pending output while no server is attached — enough
// for a restart window; oldest frames drop first if a firehose runs unattached.
const BUFFER_CAP = 2_000_000;

type HolderClient = import('bun').Socket<unknown>;

type HolderBuffer = {
  client: HolderClient | null;
  frames: Uint8Array[];
  bytes: number;
  // Inbound state, reset per connection: which dialect the attached server is
  // speaking, plus the reassembly buffer for whichever it turned out to be.
  dialect: HolderDialect | null;
  decoder: FrameDecoder;
  lineBuf: string;
};

function sendHolderFrame(buf: HolderBuffer, frame: Uint8Array): void {
  if (buf.client) {
    buf.client.write(frame);
    return;
  }
  buf.frames.push(frame);
  buf.bytes += frame.byteLength;
  while (buf.bytes > BUFFER_CAP && buf.frames.length > 1) {
    const dropped = buf.frames.shift();
    if (dropped) buf.bytes -= dropped.byteLength;
  }
}

// A server can only be mid-update, not mid-dialect: the first byte it sends
// decides, and the frame kinds can never collide with `{`.
function readHolderInput(
  buf: HolderBuffer,
  chunk: Buffer,
  proc: HolderProc,
  killPty: () => void,
): void {
  if (buf.dialect === null && chunk.length > 0) buf.dialect = sniffDialect(chunk[0]);
  if (buf.dialect === 'legacy') {
    buf.lineBuf += chunk.toString('utf8');
    const { lines, rest } = takeLegacyLines(buf.lineBuf);
    buf.lineBuf = rest;
    for (const line of lines) applyHolderFrame(proc, decodeLegacyHolderLine(line), killPty, buf);
    return;
  }
  try {
    for (const frame of buf.decoder.push(new Uint8Array(chunk))) {
      applyHolderFrame(proc, decodeHolderFrame(frame), killPty, buf);
    }
  } catch {
    // Desynced stream: there is no honest resync point. Drop the link and let
    // the server reconnect — the PTY is untouched, so nothing is lost.
    buf.client?.end();
  }
}

function listenHolder(
  socketPath: string,
  proc: HolderProc,
  buf: HolderBuffer,
  killPty: () => void,
): ReturnType<typeof Bun.listen> {
  return Bun.listen({
    unix: socketPath,
    socket: {
      open(sock) {
        // One server at a time: a reconnecting tether server replaces the old link.
        if (buf.client) buf.client.end();
        buf.client = sock;
        buf.dialect = null;
        buf.decoder = new FrameDecoder();
        buf.lineBuf = '';
        // HELLO first, before anything else: it is how the server learns which
        // dialect this holder speaks without waiting on PTY output. A pre-v2
        // server discards it as an unparseable line, which is harmless.
        sock.write(encodeHolderHello());
        // Fresh read (not just whatever was true at spawn time) so a
        // reattaching server learns about every `cd` that happened while it
        // was gone, not just the shell's starting directory.
        const currentCwd = holderCwd(proc.pid);
        if (currentCwd) sock.write(encodeHolderCwd(currentCwd));
        for (const frame of buf.frames) sock.write(frame);
        buf.frames = [];
        buf.bytes = 0;
      },
      data(_sock, chunk) {
        readHolderInput(buf, chunk, proc, killPty);
      },
      close(sock) {
        if (buf.client === sock) buf.client = null; // detached — keep running, buffer output
      },
      error() {},
    },
  });
}

function cleanupHolderSocket(socketPath: string): void {
  try {
    unlinkSync(socketPath);
  } catch {}
  try {
    unlinkSync(`${socketPath}.pid`);
  } catch {}
}

export function runHolder(argv: string[]): void {
  const [socketPath, colsArg, rowsArg, cwd, ...cmdArgs] = argv;
  if (!socketPath || cmdArgs.length === 0) {
    console.error('usage: tether holder <socketPath> <cols> <rows> <cwd> <cmd> [args...]');
    process.exit(2);
  }

  const buf: HolderBuffer = {
    client: null,
    frames: [],
    bytes: 0,
    dialect: null,
    decoder: new FrameDecoder(),
    lineBuf: '',
  };
  const proc = Bun.spawn(cmdArgs, {
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
    terminal: {
      cols: Number(colsArg) || 80,
      rows: Number(rowsArg) || 24,
      data(_terminal, bytes) {
        const chunk = new Uint8Array(bytes);
        trackOsc7Cwd(chunk);
        sendHolderFrame(buf, encodeHolderOutput(chunk));
      },
    },
  });

  // Report the shell's cwd right away too — a client attaching before the
  // shell ever draws a prompt (a brand new session, or a server reconnecting
  // to a holder that survived a restart) would otherwise have no way to know
  // it until the next OSC 7 escape comes through.
  sendHolderFrame(buf, encodeHolderCwd(cwd));

  try {
    unlinkSync(socketPath); // stale socket from a crashed predecessor
  } catch {}

  const killPty = () => killHolderPty(proc);
  // Write the pid file BEFORE the socket can accept connections, so a
  // killSession fallback that reads "<sock>.pid" never hits an empty window.
  writeFileSync(`${socketPath}.pid`, String(process.pid));
  try {
    chmodSync(`${socketPath}.pid`, 0o600);
  } catch {}
  // No secureWindowsPath() here, deliberately — and none on the socket below.
  //
  // Both live in HOLDERS_DIR, which ptyHolder.ts secures with an INHERITABLE
  // grant ((OI)(CI) — see winAcl.ts), so everything created inside it picks up
  // the owner-only DACL at creation time with no call of our own. The server
  // process creates and secures that directory at import, and it is the same
  // process that spawns us, so by the time a holder runs the grant is already
  // in place.
  //
  // Relying on inheritance is not just tidier, it is the point: this runs on the
  // session-start path, once per session, and an explicit call for each of these
  // two paths would put two `icacls` process spawns between the user pressing
  // "new session" and the shell appearing. Inheritance gets the same DACL for
  // free.
  //
  // The POSIX chmods stay because inheritance is a Windows ACL mechanism with no
  // POSIX counterpart — a 0o700 directory restricts traversal, but does not make
  // the files inside it 0o600.

  let server: ReturnType<typeof Bun.listen>;
  try {
    server = listenHolder(socketPath, proc, buf, killPty);
  } catch (err) {
    // The shell is already spawned; without a socket nobody can ever own or
    // kill it. Take it down with us rather than leaking an orphan PTY.
    try {
      proc.kill('SIGKILL');
    } catch {}
    throw err;
  }
  try {
    chmodSync(socketPath, 0o600);
  } catch {}

  proc.exited.then((code) => {
    sendHolderFrame(buf, encodeHolderExit(code));
    // Give the attached server a beat to read the exit frame before dying.
    setTimeout(() => {
      server.stop(true);
      cleanupHolderSocket(socketPath);
      process.exit(code ?? 0);
    }, 150);
  });

  process.on('SIGTERM', killPty);
}
