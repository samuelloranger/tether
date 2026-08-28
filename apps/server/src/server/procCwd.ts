import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { logWarn } from './log';

// Reads a process's current working directory straight from the kernel —
// works regardless of what's in its foreground job (a shell sitting idle, a
// long-running TUI, nothing at all), unlike sniffing OSC 7 escape sequences
// out of its terminal output, which only updates on a prompt redraw.
//
// On POSIX that is /proc/<pid>/cwd (or lsof on macOS). Windows has no such
// file, and no Win32 API returns another process's cwd: Win32_Process exposes
// CommandLine and ExecutablePath but nothing else. The value does exist though
// — it lives in the target's RTL_USER_PROCESS_PARAMETERS, hanging off its PEB —
// and a plain PROCESS_VM_READ handle is enough to go and read it. That is what
// the Windows branch below does, over bun:ffi, with no native addon.
//
// Offsets are ABI, not API: they are stable but undocumented, so every one of
// them was measured on this platform (Windows 11 26200, x64, Bun 1.4.0) rather
// than trusted from a header. Confirmed by reading a child spawned into a known
// directory and getting that directory back:
//
//   PROCESS_BASIC_INFORMATION  48 bytes; PebBaseAddress at 0x08
//   PEB (64-bit)               ProcessParameters at 0x20
//   RTL_USER_PROCESS_PARAMETERS (64-bit)
//                              CurrentDirectory.DosPath is a UNICODE_STRING at
//                              0x38: Length u16 @0x38, MaximumLength u16 @0x3A,
//                              Buffer ptr @0x40
//
// The path comes back UTF-16LE with a trailing separator ("C:\Users\x\"), which
// is stripped — every consumer compares against node:path output.
//
// WOW64 is the one place where the obvious code is silently WRONG, so it is
// handled first. A 32-bit process has two PEBs. NtQueryInformationProcess with
// ProcessBasicInformation hands back the 64-bit one, whose
// RTL_USER_PROCESS_PARAMETERS parses perfectly and reports a *plausible but
// false* cwd — a 32-bit cmd.exe spawned into C:\...\tether reported
// "C:\Windows\", because only the 32-bit side is kept current. So
// ProcessWow64Information (class 26) is asked first; when it returns a non-null
// PEB32 the 32-bit layout is used instead (ProcessParameters u32 @0x10,
// DosPath Length u16 @0x24, Buffer u32 @0x28), which was verified to return the
// real directory for that same 32-bit cmd.exe.
//
// THE FINDING THAT SHAPES THE REST OF THIS FILE: reading a Windows process's
// cwd works, and for the default shell it is the wrong question. What lives in
// the PEB is the *Win32* current directory, and a program only keeps that in
// step with its own idea of where it is if it bothers to call
// SetCurrentDirectory. Measured, one shell at a time — spawn it in %USERPROFILE%,
// send it a `cd` to a temp directory, re-read:
//
//   cmd.exe          C:\Users\me  ->  C:\...\Temp\shellcwd-xxxx   tracks
//   powershell.exe   C:\Users\me  ->  C:\Users\me                 never moves
//   pwsh.exe         C:\Users\me  ->  C:\Users\me                 never moves
//   Git bash.exe     C:\Users\me  ->  C:\Users\me                 never moves
//
// PowerShell keeps its location in its own provider stack ($PWD) and does not
// push it down to the process; the MSYS runtime emulates cwd for the same
// reason it emulates paths. So for pwsh — the Windows default (ptyShell.ts) —
// the PEB holds the directory the session *started* in, forever, and it is a
// confident, stable, wrong answer. holderCwd() in holder.ts prefers this read
// over OSC 7, so returning it unconditionally would freeze every PowerShell
// session's git and file views at the startup directory: a regression, not a
// fix, and pty.liveCwd.test.ts catches it.
//
// Hence the allowlist below. getProcessCwd() answers only for programs measured
// to keep the Win32 cwd in sync, and returns null for everything else, which is
// exactly today's behaviour (the OSC 7 fallback in holder.ts). That makes it a
// strict improvement for a cmd.exe session — where the read is live even mid-TUI,
// which OSC 7 is not — and a no-op everywhere else. readWindowsProcessCwd()
// below is the ungated read, kept exported so the offsets above stay under test
// against processes the allowlist excludes.
//
// The general fix is one line elsewhere: if holderCwd() treated the kernel read
// as a cross-check rather than an override (prefer whichever moved last), the
// allowlist could go. That file is not this one's to change.
//
// Remaining limitations, all of which degrade to null and therefore to the
// OSC 7 fallback in holder.ts:
//   * Non-x64 builds return null rather than reading with x64 offsets. The
//     release matrix is x64-only; ARM64 was not available to measure on.
//   * An elevated or protected target refuses the handle — OpenProcess on
//     pid 4 (System) fails with ERROR_ACCESS_DENIED (5). A shell the daemon
//     spawned itself always belongs to the same user and opens fine.
//   * A pid that no longer exists fails at OpenProcess with
//     ERROR_INVALID_PARAMETER (87), and a process that exits mid-read fails at
//     ReadProcessMemory. Neither throws.
//
// Measured at 0.024ms per call (500 iterations against a live cmd.exe), so it
// is cheap enough for the holder's per-request path. It is also genuinely live
// where it applies: writing `cd ..` into a cmd.exe's stdin and re-reading
// returned the new directory with no prompt redraw involved, which is the whole
// point — see refreshLiveCwd in ptyHolder.ts.
export function getProcessCwd(pid: number): string | null {
  if (process.platform === 'win32') return windowsProcessCwd(pid);
  try {
    return realpathSync(`/proc/${pid}/cwd`);
  } catch {}
  try {
    const result = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
    });
    if (result.status === 0) {
      const line = result.stdout.split('\n').find((l) => l.startsWith('n'));
      if (line) return line.slice(1);
    }
  } catch {}
  return null;
}

const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;
/** PROCESSINFOCLASS values; only these two are used. */
const ProcessBasicInformation = 0;
const ProcessWow64Information = 26;
const PBI_SIZE = 48;
const PBI_PEB_BASE_ADDRESS = 0x08;
const PEB64_PROCESS_PARAMETERS = 0x20n;
const PARAMS64_CURRENT_DIRECTORY = 0x38n;
const PEB32_PROCESS_PARAMETERS = 0x10n;
const PARAMS32_CURRENT_DIRECTORY = 0x24n;
// UNICODE_STRING.Length is a u16, so it cannot exceed this anyway; the check is
// there to reject a garbage read before it turns into a huge allocation.
const MAX_PATH_BYTES = 0x8000;

/** Opaque to us: bun:ffi hands back a number for an FFIType.ptr return. */
type WinHandle = unknown;

type CwdFfi = {
  OpenProcess: (access: number, inheritHandle: number, pid: number) => WinHandle;
  /** Buffers are passed as TypedArrays; bun:ffi converts them for an FFIType.ptr arg. */
  ReadProcessMemory: (
    process: WinHandle,
    address: bigint,
    buffer: Uint8Array,
    size: bigint,
    bytesRead: Uint8Array,
  ) => number;
  CloseHandle: (handle: WinHandle) => number;
  QueryFullProcessImageNameW: (
    process: WinHandle,
    flags: number,
    buffer: Uint8Array,
    size: Uint8Array,
  ) => number;
  NtQueryInformationProcess: (
    process: WinHandle,
    infoClass: number,
    buffer: Uint8Array,
    size: number,
    returnLength: null,
  ) => number;
};

let cwdFfi: CwdFfi | null = null;
let cwdFfiFailed = false;

/**
 * Lazily dlopen kernel32 + ntdll — never touched off Windows, and never fatal.
 * Same shape as winConsole.ts: a latch so a broken load is attempted once
 * rather than on every keystroke-driven cwd request.
 */
function loadCwdFfi(): CwdFfi | null {
  if (cwdFfi || cwdFfiFailed) return cwdFfi;
  try {
    // Imported inside the function so a POSIX build never resolves bun:ffi for
    // a code path it cannot reach.
    const { dlopen, FFIType } = require('bun:ffi') as typeof import('bun:ffi');
    const kernel32 = dlopen('kernel32.dll', {
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      ReadProcessMemory: {
        // lpBaseAddress is u64, not ptr: it is an address in ANOTHER process's
        // space, so there is no local TypedArray for bun:ffi to pin.
        args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
        returns: FFIType.i32,
      },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
      QueryFullProcessImageNameW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    }).symbols;
    const ntdll = dlopen('ntdll.dll', {
      NtQueryInformationProcess: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
    }).symbols;
    cwdFfi = {
      ...kernel32,
      ...ntdll,
    } as unknown as CwdFfi;
  } catch (err) {
    cwdFfiFailed = true;
    logWarn('Kernel cwd reads unavailable (ntdll/kernel32 FFI failed):', err);
  }
  return cwdFfi;
}

/** One cross-process read. Null on any failure, including a short read. */
function readMemory(ffi: CwdFfi, handle: WinHandle, address: bigint, size: number): Buffer | null {
  if (address === 0n || size <= 0) return null;
  const buffer = Buffer.alloc(size);
  const bytesRead = Buffer.alloc(8);
  const ok = ffi.ReadProcessMemory(handle, address, buffer, BigInt(size), bytesRead);
  if (!ok || bytesRead.readBigUInt64LE(0) !== BigInt(size)) return null;
  return buffer;
}

/** Reads a UNICODE_STRING's payload and normalizes it to a native path. */
function readDosPath(
  ffi: CwdFfi,
  handle: WinHandle,
  length: number,
  buffer: bigint,
): string | null {
  if (length <= 0 || length > MAX_PATH_BYTES) return null;
  const raw = readMemory(ffi, handle, buffer, length);
  if (!raw) return null;
  const cwd = raw.toString('utf16le');
  // Windows stores the cwd with a trailing separator. Drop it, except for a
  // drive root ("C:\"), where it is part of the path.
  const trimmed = cwd.length > 3 && /[\\/]$/.test(cwd) ? cwd.slice(0, -1) : cwd;
  return trimmed || null;
}

function cwdFromPeb64(ffi: CwdFfi, handle: WinHandle, peb: bigint): string | null {
  const params = readMemory(ffi, handle, peb + PEB64_PROCESS_PARAMETERS, 8);
  if (!params) return null;
  // Length u16, MaximumLength u16, 4 bytes of padding, Buffer ptr — 16 bytes.
  const dir = readMemory(ffi, handle, params.readBigUInt64LE(0) + PARAMS64_CURRENT_DIRECTORY, 16);
  if (!dir) return null;
  return readDosPath(ffi, handle, dir.readUInt16LE(0), dir.readBigUInt64LE(8));
}

function cwdFromPeb32(ffi: CwdFfi, handle: WinHandle, peb: bigint): string | null {
  const params = readMemory(ffi, handle, peb + PEB32_PROCESS_PARAMETERS, 4);
  if (!params) return null;
  // Same UNICODE_STRING, 32-bit: Length u16, MaximumLength u16, Buffer u32.
  const base = BigInt(params.readUInt32LE(0)) + PARAMS32_CURRENT_DIRECTORY;
  const dir = readMemory(ffi, handle, base, 8);
  if (!dir) return null;
  return readDosPath(ffi, handle, dir.readUInt16LE(0), BigInt(dir.readUInt32LE(4)));
}

/**
 * The image path of an open process, via the documented
 * QueryFullProcessImageNameW (flags 0 = Win32 path form). PROCESS_QUERY_INFORMATION
 * is a superset of the PROCESS_QUERY_LIMITED_INFORMATION it needs, so the handle
 * already in hand is enough.
 */
function imageName(ffi: CwdFfi, handle: WinHandle): string | null {
  // The size is in CHARACTERS, in and out. MAX_PATH is not a real ceiling on
  // NTFS, but every shell that could be on the allowlist lives well inside it,
  // and a truncated read only ever costs a null.
  const size = Buffer.alloc(4);
  size.writeUInt32LE(260, 0);
  const buffer = Buffer.alloc(260 * 2);
  if (!ffi.QueryFullProcessImageNameW(handle, 0, buffer, size)) return null;
  const chars = size.readUInt32LE(0);
  if (chars <= 0 || chars > 260) return null;
  return buffer.subarray(0, chars * 2).toString('utf16le');
}

/**
 * Windows programs measured to keep their Win32 cwd in step with their own
 * current directory — see the table at the top of the file. An allowlist, not a
 * denylist: an unmeasured program falling through to "no answer" costs the OSC 7
 * fallback, whereas falling through to "answer" costs a wrong directory.
 */
const CWD_TRACKING_IMAGES = new Set(['cmd.exe']);

function keepsWin32CwdInSync(ffi: CwdFfi, handle: WinHandle): boolean {
  const image = imageName(ffi, handle);
  if (!image) return false;
  return CWD_TRACKING_IMAGES.has(path.win32.basename(image).toLowerCase());
}

/**
 * The raw PEB read, with no allowlist: the Win32 cwd of `pid`, whether or not
 * that process keeps it current. Null off Windows and on any failure.
 *
 * Exported so procCwd.test.ts can pin the struct offsets against processes the
 * allowlist excludes (this one, a WOW64 child). Callers that want "where is
 * this shell?" want getProcessCwd.
 */
export function readWindowsProcessCwd(pid: number): string | null {
  return windowsProcessCwd(pid, false);
}

function windowsProcessCwd(pid: number, gated = true): string | null {
  if (process.platform !== 'win32') return null;
  // The offsets above were measured on x64 only. Reading a 4KB-aligned PEB with
  // the wrong layout would hand back a confident, wrong path, which is worse
  // than the OSC 7 fallback.
  if (process.arch !== 'x64') return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const ffi = loadCwdFfi();
  if (!ffi) return null;
  let handle: WinHandle = null;
  try {
    handle = ffi.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
    if (!handle) return null;
    if (gated && !keepsWin32CwdInSync(ffi, handle)) return null;
    // WOW64 first — see the note at the top of the file: the 64-bit PEB of a
    // 32-bit process parses cleanly and lies.
    const peb32 = Buffer.alloc(8);
    if (ffi.NtQueryInformationProcess(handle, ProcessWow64Information, peb32, 8, null) === 0) {
      const address = peb32.readBigUInt64LE(0);
      if (address !== 0n) return cwdFromPeb32(ffi, handle, address);
    }
    const pbi = Buffer.alloc(PBI_SIZE);
    // NTSTATUS: 0 is STATUS_SUCCESS, everything else is a failure.
    if (ffi.NtQueryInformationProcess(handle, ProcessBasicInformation, pbi, PBI_SIZE, null) !== 0) {
      return null;
    }
    return cwdFromPeb64(ffi, handle, pbi.readBigUInt64LE(PBI_PEB_BASE_ADDRESS));
  } catch {
    // Never throws: the holder calls this from its frame handler, where an
    // exception would take the session's input path down with it.
    return null;
  } finally {
    if (handle) {
      try {
        ffi.CloseHandle(handle);
      } catch {}
    }
  }
}
