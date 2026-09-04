import { dlopen, FFIType, type Pointer, ptr, suffix } from 'bun:ffi';
import { copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The Noise crypto lives in a native cdylib (crates/tether-noise-ffi). We embed
// it into the binary as a file asset: `bun build --compile` bundles the file at
// this specifier, and at runtime `embeddedNoiseLib` is a path to it. `build:ffi`
// (scripts/build-ffi.ts) compiles the cdylib and copies it to this path for both
// source runs (dev, `bun run test`) and the compile step — and release.yml swaps
// in the correct-arch cdylib before each cross-target `bun build`. This replaced
// an `import.meta.url`-relative path that resolved to a non-existent `/crates/…`
// inside the compiled binary, so the shipped server crashed on boot.
import embeddedNoiseLib from './noiseNativeLib' with { type: 'file' };

// dlopen(3) on Linux/macOS loads any filename, including bun's extension-less
// `$bunfs` extraction path, so use it as-is. Windows' LoadLibrary appends `.dll`
// to an extension-less path and then fails to find it, so materialize a copy
// with the real suffix and load that. The destination is per-process (pid): the
// server test suite runs `bun test --parallel`, and a shared destination would
// have every worker copy/lock the same .dll at once — which on Windows blocks
// on the file lock and hangs the run. This module is imported once per process,
// so the copy happens at most once.
function resolveNoiseLib(): string {
  if (process.platform !== 'win32') return embeddedNoiseLib;
  const dest = join(tmpdir(), `tether-noise-${process.pid}.${suffix}`);
  if (!existsSync(dest)) copyFileSync(embeddedNoiseLib, dest);
  return dest;
}

const { symbols } = dlopen(resolveNoiseLib(), {
  tether_noise_gen_keypair: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  tether_noise_derive_psk: {
    args: [FFIType.ptr, FFIType.u64_fast, FFIType.ptr],
    returns: FFIType.i32,
  },
  tether_noise_pair_initiator_new: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  tether_noise_pair_responder_new: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  tether_noise_reconnect_initiator_new: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  tether_noise_reconnect_responder_new: { args: [FFIType.ptr], returns: FFIType.ptr },
  tether_noise_write_message: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr, FFIType.u64_fast, FFIType.ptr],
    returns: FFIType.i32,
  },
  tether_noise_read_message: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr, FFIType.u64_fast, FFIType.ptr],
    returns: FFIType.i32,
  },
  tether_noise_is_finished: { args: [FFIType.ptr], returns: FFIType.i32 },
  tether_noise_remote_static: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr],
    returns: FFIType.i32,
  },
  tether_noise_into_transport: { args: [FFIType.ptr], returns: FFIType.i32 },
  tether_noise_seal: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr, FFIType.u64_fast, FFIType.ptr],
    returns: FFIType.i32,
  },
  tether_noise_open: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr, FFIType.u64_fast, FFIType.ptr],
    returns: FFIType.i32,
  },
  tether_noise_free: { args: [FFIType.ptr], returns: FFIType.void },
});

const OK = 0;

// Scratch buffer for a single Noise message / framed payload. Callers keep
// individual frames well under this (session output is chunked to ~16 KiB of
// plaintext); the margin absorbs JSON escaping expansion + Noise framing.
const BUF = 512 * 1024;

type IoFn = (
  h: Pointer,
  input: Pointer | null,
  inLen: bigint,
  out: Pointer | null,
  outCap: bigint,
  written: Pointer | null,
) => number;

export function genKeypair(): { pub: Uint8Array; priv: Uint8Array } {
  const pub = new Uint8Array(32);
  const priv = new Uint8Array(32);
  if (symbols.tether_noise_gen_keypair(ptr(pub), ptr(priv)) !== OK) throw new Error('keypair');
  return { pub, priv };
}

export function derivePsk(code: string): Uint8Array {
  const codeBytes = new TextEncoder().encode(code);
  const out = new Uint8Array(32);
  if (symbols.tether_noise_derive_psk(ptr(codeBytes), BigInt(codeBytes.length), ptr(out)) !== OK)
    throw new Error('psk');
  return out;
}

export class NoiseHandle {
  constructor(private h: Pointer) {
    if (!h) throw new Error('null handle');
  }

  private io(fn: IoFn, input: Uint8Array): Uint8Array {
    const out = new Uint8Array(BUF);
    const written = new BigUint64Array(1);
    // bun:ffi ptr() throws on a zero-length TypedArray; a null pointer is how the
    // ABI already expects "no payload" (e.g. the empty handshake messages).
    const inPtr = input.length ? ptr(input) : null;
    const rc = fn(this.h, inPtr, BigInt(input.length), ptr(out), BigInt(out.length), ptr(written));
    if (rc !== OK) throw new Error(`ffi ${rc}`);
    return out.slice(0, Number(written[0]));
  }

  writeMessage(payload: Uint8Array = new Uint8Array()): Uint8Array {
    return this.io(symbols.tether_noise_write_message as IoFn, payload);
  }
  readMessage(msg: Uint8Array): Uint8Array {
    return this.io(symbols.tether_noise_read_message as IoFn, msg);
  }
  isFinished(): boolean {
    return symbols.tether_noise_is_finished(this.h) === 1;
  }
  remoteStatic(): Uint8Array {
    const out = new Uint8Array(32);
    const written = new BigUint64Array(1);
    if (symbols.tether_noise_remote_static(this.h, ptr(out), 32n, ptr(written)) !== OK)
      throw new Error('remote_static');
    return out.slice(0, Number(written[0]));
  }
  intoTransport(): void {
    if (symbols.tether_noise_into_transport(this.h) !== OK) throw new Error('into_transport');
  }
  seal(plaintext: Uint8Array): Uint8Array {
    return this.io(symbols.tether_noise_seal as IoFn, plaintext);
  }
  open(wire: Uint8Array): Uint8Array {
    return this.io(symbols.tether_noise_open as IoFn, wire);
  }
  free(): void {
    symbols.tether_noise_free(this.h);
  }
}

export function pairInitiator(devicePriv: Uint8Array, psk: Uint8Array): NoiseHandle {
  const h = symbols.tether_noise_pair_initiator_new(ptr(devicePriv), ptr(psk));
  return new NoiseHandle(h as Pointer);
}
export function pairResponder(serverPriv: Uint8Array, psk: Uint8Array): NoiseHandle {
  const h = symbols.tether_noise_pair_responder_new(ptr(serverPriv), ptr(psk));
  return new NoiseHandle(h as Pointer);
}
export function reconnectInitiator(devicePriv: Uint8Array, serverPub: Uint8Array): NoiseHandle {
  const h = symbols.tether_noise_reconnect_initiator_new(ptr(devicePriv), ptr(serverPub));
  return new NoiseHandle(h as Pointer);
}
export function reconnectResponder(serverPriv: Uint8Array): NoiseHandle {
  const h = symbols.tether_noise_reconnect_responder_new(ptr(serverPriv));
  return new NoiseHandle(h as Pointer);
}
