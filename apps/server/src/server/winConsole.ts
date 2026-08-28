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
// All of this runs inside the holder's keystroke handler, so cost is part of
// the contract. Finding the shell's children used to mean spawning PowerShell
// for `Get-CimInstance Win32_Process`, measured here at 2561ms for a single
// call — every ^C froze that session's input for over two seconds, and mashing
// ^C serialised them. `Get-Process` is the cheaper formulation procIdentity.ts
// settled on and still cost 1787ms. Toolhelp32 replaces the spawn entirely with
// an in-process snapshot: 20ms per call on a machine with ~450 processes,
// nearly all of it inside CreateToolhelp32Snapshot itself (the Process32NextW
// walk over the result is 0.03ms). The remaining `taskkill /F /T` is a spawn,
// but it is now fire-and-forget — only the *decision* is on the input path.
import { logWarn } from './log';

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
 * Does the app currently holding the session's console want Ctrl+C turned into
 * an interrupt? Null when it cannot be determined, which callers treat as "do
 * nothing but deliver the byte" — the conservative half.
 *
 * Attaching moves THIS process onto the child's console, so it is undone in a
 * finally: leaving the holder attached to a pseudoconsole that later goes away
 * is a good way to lose its own std handles.
 */
export function foregroundWantsInterrupt(shellPid: number): boolean | null {
  const k32 = loadKernel32();
  if (!k32) return null;
  // Refuse to run in a process that owns a console. Attaching to another
  // console means detaching from your own first, and a process whose stdout IS
  // that console would lose it — a test runner in a terminal, or `tether serve`
  // run in the foreground. Holders are spawned DETACHED_PROCESS and so have no
  // console, which is exactly why this is safe there and nowhere else.
  if (k32.GetConsoleWindow()) return null;
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
    return (mode[0] & ENABLE_PROCESSED_INPUT) !== 0;
  } catch {
    return null;
  } finally {
    k32.FreeConsole();
  }
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
 * Best-effort Ctrl+C for a ConPTY session. Returns what it did, for logging.
 *
 * Only the children are taken down, never the shell: the point of an interrupt
 * is to get the prompt back, not to end the session. /T covers grandchildren,
 * so enumerating one level is enough.
 */
export function interruptForeground(shellPid: number): 'interrupted' | 'raw' | 'idle' | 'unknown' {
  const wants = foregroundWantsInterrupt(shellPid);
  if (wants === null) return 'unknown';
  // A raw-mode app (vim, or PSReadLine sitting at its prompt) reads ^C as a
  // keystroke and handles it itself. Killing anything here would be wrong.
  if (!wants) return 'raw';
  const children = childPids(shellPid);
  if (children.length === 0) return 'idle';
  const args = ['taskkill.exe', '/F', '/T'];
  for (const child of children) args.push('/PID', String(child));
  try {
    // Fire and forget. Everything above this line — the ISIG check and the
    // snapshot — has to finish before the byte's effect can be judged, but
    // waiting for taskkill to report back adds nothing except latency on the
    // keystroke path. unref() so a holder that is shutting down is not held
    // open by it; taskkill is a separate process and finishes either way.
    Bun.spawn(args, { stdio: ['ignore', 'ignore', 'ignore'] }).unref();
  } catch {}
  return 'interrupted';
}
