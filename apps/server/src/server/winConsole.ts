// Windows Ctrl+C support for a ConPTY session.
//
// On POSIX the PTY line discipline turns the 0x03 byte into SIGINT for the
// foreground process group, and the ISIG termios flag is how an app opts out
// (vim wants a literal ^C, a build does not). None of that exists here:
//
//   * ConPTY does NOT convert 0x03 into a console control event. The byte is
//     delivered to the app as a character and nothing else happens — verified
//     against `ping -t` under cmd.exe and an in-process PowerShell loop.
//   * GenerateConsoleCtrlEvent does not reach ConPTY clients either. Attaching
//     to the pseudoconsole succeeds, CONIN$ opens, GetConsoleMode returns live
//     values — so we are genuinely attached — yet the event is delivered to
//     nobody, not even to this process. It returns success regardless.
//   * Bun's termios flags are documented as unsupported on Windows; they all
//     read 0 and refuse writes.
//
// What is left is to reproduce the *effect*: stop the foreground job, keep the
// shell. `ENABLE_PROCESSED_INPUT` on the console's input buffer is the faithful
// stand-in for ISIG — it is precisely the bit that says "turn Ctrl+C into an
// interrupt rather than a keystroke", and it tracks the foreground app live:
//
//   pwsh at its PSReadLine prompt   -> clear  (^C is a keystroke; cancels the line)
//   pwsh running a job              -> set
//   cmd at its prompt / running     -> set
//   a raw-mode TUI (vim, less)      -> clear
//
// So a raw-mode app keeps receiving the byte untouched and nothing is killed,
// while a job that expects to be interruptible gets its process subtree taken
// down. The honest limitation: work running *inside* the shell process itself
// (a PowerShell pipeline, not a child command) has no subtree to stop, so it
// cannot be interrupted. Child commands — the agents, builds and dev servers
// this is actually used for — can.
//
// *Which* children is the other half of the fidelity question. POSIX signals
// the foreground process group only; a job the shell put in the background is
// not in it and survives the ^C. Windows has no equivalent grouping, and "every
// immediate child of the shell" is far too wide — a `Start-Process`-launched
// build would be destroyed alongside the command the user actually meant to
// interrupt. The nearest available proxy is console membership:
// GetConsoleProcessList, called while attached to the shell's console, names
// every process attached to that console. A foreground command inherits the
// shell's ConPTY and so appears in the list; a job given its own console
// (Start-Process, `start`, anything CREATE_NEW_CONSOLE / CREATE_NO_WINDOW /
// DETACHED_PROCESS) does not, and nor does a GUI program. Intersecting that
// list with the shell's children is the foreground set. Measured here: a child
// spawned sharing this process's console is in the list; one spawned with
// windowsHide (CREATE_NO_WINDOW — its own console) is not.
//
// The honest limit again: a background job that shares the console anyway —
// `start /b`, a pipeline that inherited the handle — is indistinguishable from
// the foreground command this way and is still caught. Windows does not record
// which of a console's clients is "foreground"; nothing here can recover it.
//
// All of this runs inside the holder's keystroke handler, so cost is part of
// the contract. Finding the shell's children used to mean spawning PowerShell
// for `Get-CimInstance Win32_Process`, measured here at 2561ms for a single
// call — every ^C froze that session's input for over two seconds, and mashing
// ^C serialised them. `Get-Process` is the cheaper formulation procIdentity.ts
// settled on and still cost 1787ms. Toolhelp32 replaces the spawn entirely with
// an in-process snapshot: 20ms per call on a machine with ~450 processes,
// nearly all of it inside CreateToolhelp32Snapshot itself (the Process32NextW
// walk over the result is 0.03ms). GetConsoleProcessList adds 0.08ms, so the
// narrowing is free next to the snapshot it filters. The remaining
// `taskkill /F /T` is a spawn, but it is now fire-and-forget — only the
// *decision* is on the input path.
import { logWarn } from './log';
import { HIDE_CONSOLE } from './spawnWindow';

const ENABLE_PROCESSED_INPUT = 0x0001;
const GENERIC_READ = 0x8000_0000;
const GENERIC_WRITE = 0x4000_0000;
const FILE_SHARE_READ_WRITE = 0x3;
const OPEN_EXISTING = 3;
/** The only snapshot class needed here; the pid argument is ignored for it. */
const TH32CS_SNAPPROCESS = 0x0000_0002;
// sizeof(PROCESSENTRY32W) on x64 — NOT the 556 bytes it is on 32-bit Windows.
// th32DefaultHeapID is a ULONG_PTR, so it aligns to 8 and the tail rounds up.
// The API validates this field, which makes it measurable rather than guessable:
// 556, 564 and 572 were all rejected with ERROR_BAD_LENGTH (24) and only 568
// was accepted. The two field offsets below were read out of a live entry and
// cross-checked against this process (th32ProcessID matched process.pid, and
// szExeFile at 44 decoded to "bun.exe").
const PROCESSENTRY32W_SIZE = 568;
const PE32_PROCESS_ID = 8;
const PE32_PARENT_PROCESS_ID = 32;
/** First guess at a console's client count; a shell plus one job is 2 or 3. */
const CONSOLE_PIDS_GUESS = 16;

type Kernel32 = {
  AttachConsole: (pid: number) => number;
  FreeConsole: () => number;
  GetConsoleWindow: () => unknown;
  CreateFileA: (
    name: Uint8Array,
    access: number,
    share: number,
    sa: null,
    disposition: number,
    flags: number,
    template: null,
  ) => unknown;
  GetConsoleMode: (handle: unknown, out: Uint32Array) => number;
  /** Returns how many pids are attached, or how many it needed; 0 on failure. */
  GetConsoleProcessList: (out: Uint32Array, count: number) => number;
  CloseHandle: (handle: unknown) => number;
  CreateToolhelp32Snapshot: (flags: number, pid: number) => unknown;
  /** Buffers ride in as TypedArrays; bun:ffi converts them for an FFIType.ptr arg. */
  Process32FirstW: (snapshot: unknown, entry: Uint8Array) => number;
  Process32NextW: (snapshot: unknown, entry: Uint8Array) => number;
};

let kernel32: Kernel32 | null = null;
let kernel32Failed = false;

/** Lazily dlopen kernel32 — never touched off Windows, and never fatal. */
function loadKernel32(): Kernel32 | null {
  if (kernel32 || kernel32Failed) return kernel32;
  try {
    // Imported inside the function so a POSIX build never resolves bun:ffi for
    // a code path it cannot reach.
    const { dlopen, FFIType } = require('bun:ffi') as typeof import('bun:ffi');
    kernel32 = dlopen('kernel32.dll', {
      AttachConsole: { args: [FFIType.u32], returns: FFIType.i32 },
      FreeConsole: { args: [], returns: FFIType.i32 },
      GetConsoleWindow: { args: [], returns: FFIType.ptr },
      CreateFileA: {
        args: [
          FFIType.cstring,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
        ],
        returns: FFIType.ptr,
      },
      GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      GetConsoleProcessList: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
      CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
      Process32FirstW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      Process32NextW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    }).symbols as unknown as Kernel32;
  } catch (err) {
    kernel32Failed = true;
    logWarn('Ctrl+C support unavailable (kernel32 FFI failed):', err);
  }
  return kernel32;
}

/**
 * Every pid attached to the console THIS process is currently attached to.
 *
 * Empty when there is no console — a detached holder before it attaches, or any
 * POSIX build — and on any failure, which callers read as "no opinion".
 *
 * Exported for the test: it is the only half of the narrowing that can be
 * exercised without a live ConPTY, because the test runner's own console is one
 * it may legitimately read.
 */
export function consoleProcessPids(): number[] {
  const k32 = loadKernel32();
  if (!k32) return [];
  try {
    // The count argument must be at least 1 — passing 0 is ERROR_INVALID_PARAMETER
    // rather than a size query, measured. When the buffer is too small the call
    // writes nothing and returns the count it wants, so one generous guess plus a
    // single exact retry covers any console.
    let cap = CONSOLE_PIDS_GUESS;
    for (let attempt = 0; attempt < 2; attempt++) {
      const buf = new Uint32Array(cap);
      const n = k32.GetConsoleProcessList(buf, cap);
      if (n === 0) return [];
      if (n <= cap) return Array.from(buf.subarray(0, n));
      cap = n;
    }
    return [];
  } catch {
    return [];
  }
}

/** What one attach to the session's console is worth: the ISIG bit and the roster. */
type ConsoleState = { isig: boolean; pids: number[] };

/**
 * Attach to the session's console once and read both facts out of it.
 *
 * Null when nothing can be determined, which callers treat as "do nothing but
 * deliver the byte" — the conservative half.
 *
 * Attaching moves THIS process onto the child's console, so it is undone in a
 * finally: leaving the holder attached to a pseudoconsole that later goes away
 * is a good way to lose its own std handles. Both reads happen inside that one
 * window — the second costs 0.08ms, and a second attach would only be another
 * chance to race the job exiting between them.
 */
function inspectConsole(shellPid: number): ConsoleState | null {
  const k32 = loadKernel32();
  if (!k32) return null;
  // Refuse to run in a process that owns a console. Attaching to another
  // console means detaching from your own first, and a process whose stdout IS
  // that console would lose it — a test runner in a terminal, or `tether serve`
  // run in the foreground. Holders are spawned DETACHED_PROCESS and so have no
  // console, which is exactly why this is safe there and nowhere else.
  //
  // GetConsoleWindow is not on its own a sufficient form of that question: a
  // process hosted by a *pseudo*console — any modern terminal, `bun test` under
  // Git Bash — has a real console with no window, so it answers null and the
  // FreeConsole below would take the console away anyway. Measured; it is what
  // the roster test below was added to stop. The roster is the reliable form:
  // no console lists nobody, and a console always lists at least its own reader.
  if (k32.GetConsoleWindow() || consoleProcessPids().length > 0) return null;
  k32.FreeConsole();
  if (!k32.AttachConsole(shellPid)) return null;
  try {
    // CONIN$ rather than GetStdHandle: the holder's own stdin is redirected to
    // a log file, so the std handle is not this console's input buffer.
    const conin = k32.CreateFileA(
      new Uint8Array(Buffer.from('CONIN$\0', 'ascii')),
      GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ_WRITE,
      null,
      OPEN_EXISTING,
      0,
      null,
    );
    if (!conin) return null;
    const mode = new Uint32Array(1);
    const ok = k32.GetConsoleMode(conin, mode);
    k32.CloseHandle(conin);
    if (!ok) return null;
    return { isig: (mode[0] & ENABLE_PROCESSED_INPUT) !== 0, pids: consoleProcessPids() };
  } catch {
    return null;
  } finally {
    k32.FreeConsole();
  }
}

/**
 * Does the app currently holding the session's console want Ctrl+C turned into
 * an interrupt? Null when it cannot be determined.
 */
export function foregroundWantsInterrupt(shellPid: number): boolean | null {
  return inspectConsole(shellPid)?.isig ?? null;
}

/**
 * The immediate children of `pid`, from a Toolhelp32 process snapshot.
 *
 * Exported for the test that pins the struct layout: the offsets are ABI, and a
 * wrong one reads a plausible number rather than failing, so the only way to
 * know it still works is to spawn a child and look for it.
 *
 * Empty on any failure — a missing kernel32, a refused snapshot, an
 * unrecognised pid. Callers treat that as "nothing to interrupt".
 */
export function childPids(pid: number): number[] {
  // Not just hygiene: orphaned processes carry th32ParentProcessID 0, so a
  // caller that passed 0 would be handed a list of unrelated pids to kill.
  if (!Number.isInteger(pid) || pid <= 0) return [];
  const k32 = loadKernel32();
  if (!k32) return [];
  // A failed snapshot is INVALID_HANDLE_VALUE, not null, so it is not caught
  // here — Process32FirstW is what rejects it, and closing it is harmless.
  let snapshot: unknown = null;
  try {
    snapshot = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (!snapshot) return [];
    const entry = Buffer.alloc(PROCESSENTRY32W_SIZE);
    // dwSize must be set before the FIRST call; Process32NextW keeps reusing
    // the value the snapshot already accepted, so it is written once.
    entry.writeUInt32LE(PROCESSENTRY32W_SIZE, 0);
    const children: number[] = [];
    let ok = k32.Process32FirstW(snapshot, entry);
    while (ok) {
      if (entry.readUInt32LE(PE32_PARENT_PROCESS_ID) === pid) {
        children.push(entry.readUInt32LE(PE32_PROCESS_ID));
      }
      ok = k32.Process32NextW(snapshot, entry);
    }
    return children;
  } catch {
    return [];
  } finally {
    if (snapshot) {
      try {
        k32.CloseHandle(snapshot);
      } catch {}
    }
  }
}

/**
 * The subset of `children` attached to the console described by `consolePids` —
 * as near a foreground process group as Windows offers. See the header.
 *
 * Pure, so the include/exclude behaviour can be pinned against two children the
 * test spawned itself rather than needing a live ConPTY.
 */
export function foregroundChildren(children: number[], consolePids: number[]): number[] {
  const attached = new Set(consolePids);
  // The reader's own pid and the shell's are in `consolePids` too, but neither
  // can be a child of the shell, so the intersection drops them unremarked.
  return children.filter((child) => attached.has(child));
}

/** What a ^C did, for logging. `background` = children, but all detached ones. */
export type InterruptResult = 'interrupted' | 'raw' | 'idle' | 'background' | 'unknown';

/**
 * Best-effort Ctrl+C for a ConPTY session. Returns what it did, for logging.
 *
 * Only children sharing the session's console are taken down, and never the
 * shell: the point of an interrupt is to get the prompt back, not to end the
 * session — nor the user's background jobs. /T covers grandchildren, so
 * enumerating one level is enough.
 */
export function interruptForeground(shellPid: number): InterruptResult {
  const state = inspectConsole(shellPid);
  if (state === null) return 'unknown';
  // A raw-mode app (vim, or PSReadLine sitting at its prompt) reads ^C as a
  // keystroke and handles it itself. Killing anything here would be wrong.
  if (!state.isig) return 'raw';
  // We were attached when the roster was read, and a console always lists its
  // own readers — so an empty one means the query failed, not that the console
  // is deserted. Killing on that basis would be killing blind.
  if (state.pids.length === 0) return 'unknown';
  const children = childPids(shellPid);
  if (children.length === 0) return 'idle';
  const foreground = foregroundChildren(children, state.pids);
  if (foreground.length === 0) return 'background';
  const args = ['taskkill.exe', '/F', '/T'];
  for (const child of foreground) args.push('/PID', String(child));
  try {
    // Fire and forget. Everything above this line — the ISIG check and the
    // snapshot — has to finish before the byte's effect can be judged, but
    // waiting for taskkill to report back adds nothing except latency on the
    // keystroke path. unref() so a holder that is shutting down is not held
    // open by it; taskkill is a separate process and finishes either way.
    Bun.spawn(args, { stdio: ['ignore', 'ignore', 'ignore'], ...HIDE_CONSOLE }).unref();
  } catch {}
  return 'interrupted';
}
