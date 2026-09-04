import { dlopen, FFIType, type Pointer, ptr, suffix } from 'bun:ffi';

// Debug-build path; the shipped binary will embed + extract the library (Plan 2c).
const LIB = new URL(
  `../../../../crates/tether-noise-ffi/target/debug/libtether_noise_ffi.${suffix}`,
  import.meta.url,
).pathname;

const { symbols } = dlopen(LIB, {
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

// A big-enough scratch buffer for any single Noise message / framed payload.
const BUF = 128 * 1024;

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
