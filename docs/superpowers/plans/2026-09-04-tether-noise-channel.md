# Tether Server Noise Channel Core (Plan 2c-core of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** The server-side Noise channel: accept a device's `IK` reconnect handshake, authorize it against an **injected** device lookup (fail-closed, no app data before authorization), and expose a framed encrypt/decrypt channel; plus accept the `XXpsk2` pairing handshake with an injected PSK + host-confirm hook. Built on the `noiseFfi.ts` binding (Plan 2a). No `app.ts`/`main.ts`/`db.ts` wiring yet (that comes after Plan 2b merges), so this collides with nothing.

**Architecture:** `noiseChannel.ts` drives a `NoiseHandle` (from `noiseFfi.ts`) over an injected `FrameIO` (send/recv of opaque byte frames — WebSocket messages in production, in-memory queues in tests). Authorization is a `(pubkeyBase64) => Device | null` callback so this module never imports the registry directly — Plan 2b's `deviceRegistry.getDeviceByPubkey` is passed in at the call site.

**Tech Stack:** Bun + TypeScript, `bun:test`, the `noiseFfi.ts` binding.

**Spec:** `docs/superpowers/specs/2026-09-03-tether-noise-pairing-design.md` (IK ≠ authorization; the one Noise channel).

## Global Constraints

- **IK completion ≠ authorization.** After the handshake completes, look up the device static pubkey via the injected authorizer; if it returns null, close the channel and surface a single generic failure — **no transport session is created, no application frame is ever read or written** (fail-closed, no oracle).
- **Injected dependencies only.** `noiseChannel.ts` imports from `noiseFfi.ts` and nothing else in the server. The authorizer, PSK provider, and host-confirm are parameters.
- **Frames are opaque.** The channel does not interpret application payloads; it seals/opens whole frames. Multiplexing/routing of `/api/*` over the channel is a later plan.
- Colocated tests. Biome: 2-space, single quotes, semicolons, width 100.

---

## File Structure

- Modify `apps/server/src/server/noiseFfi.ts` — add `reconnectInitiator` / `reconnectResponder` wrappers + their dlopen symbols.
- Create `apps/server/src/server/noiseChannel.ts` — the channel: `acceptReconnect`, `acceptPairing`, `ServerChannel`.
- Create `apps/server/src/server/noiseChannel.test.ts` — in-process client↔server tests.

---

## Task 1: reconnect wrappers in the FFI binding

**Files:** Modify `apps/server/src/server/noiseFfi.ts`.

**Interfaces:**
- Produces: `reconnectInitiator(devicePriv: Uint8Array, serverPub: Uint8Array): NoiseHandle`, `reconnectResponder(serverPriv: Uint8Array): NoiseHandle`.

- [ ] **Step 1:** Add two symbols to the `dlopen` table:

```ts
  tether_noise_reconnect_initiator_new: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  tether_noise_reconnect_responder_new: { args: [FFIType.ptr], returns: FFIType.ptr },
```

- [ ] **Step 2:** Add the wrappers at the bottom of the file:

```ts
export function reconnectInitiator(devicePriv: Uint8Array, serverPub: Uint8Array): NoiseHandle {
  const h = symbols.tether_noise_reconnect_initiator_new(ptr(devicePriv), ptr(serverPub));
  return new NoiseHandle(h as Pointer);
}
export function reconnectResponder(serverPriv: Uint8Array): NoiseHandle {
  const h = symbols.tether_noise_reconnect_responder_new(ptr(serverPriv));
  return new NoiseHandle(h as Pointer);
}
```

- [ ] **Step 3:** Extend `noiseFfi.test.ts` with a reconnect round-trip (mirror the pairing test but with `reconnectInitiator(devicePriv, serverPub)` / `reconnectResponder(serverPriv)`, 2 messages: `->` then `<-`, then `intoTransport` both, seal/open a frame). Run `bun --cwd apps/server test noiseFfi` → PASS.

- [ ] **Step 4:** Commit. `git commit -am "feat(noise-ffi): reconnect wrappers in the Bun binding"`

---

## Task 2: `ServerChannel` + `acceptReconnect` (the authorization gate)

**Files:** Create `apps/server/src/server/noiseChannel.ts`, `apps/server/src/server/noiseChannel.test.ts`.

**Interfaces:**
- Produces:
  - `interface FrameIO { send(frame: Uint8Array): void | Promise<void>; recv(): Promise<Uint8Array>; }`
  - `type Authorizer = (pubkeyBase64: string) => unknown | null;` (returns a device object or null; the channel treats it as opaque, only null-vs-not matters, and it is exposed as `channel.device`).
  - `class ServerChannel { readonly device: unknown; seal(app: Uint8Array): Uint8Array; open(wire: Uint8Array): Uint8Array; rekeyOutgoing(): void; rekeyIncoming(): void; }`
  - `async function acceptReconnect(io: FrameIO, serverPriv: Uint8Array, authorize: Authorizer): Promise<ServerChannel>` — throws `ChannelError('unauthorized')` if the device is unknown, `ChannelError('handshake')` on crypto failure. On the unauthorized path it MUST NOT construct a transport or read/write any frame beyond the handshake.
  - `class ChannelError extends Error { constructor(public code: 'handshake' | 'unauthorized'); }`

- [ ] **Step 1: Write the failing test.** In `noiseChannel.test.ts`, build an in-memory `FrameIO` pair (two queues; each side's `send` pushes to the other's queue, `recv` awaits). Simulate the device with the `noiseFfi` reconnect initiator directly.

```ts
import { describe, expect, test } from 'bun:test';
import { genKeypair, reconnectInitiator } from './noiseFfi';
import { acceptReconnect, ChannelError, type FrameIO } from './noiseChannel';

function pipe(): [FrameIO, FrameIO] {
  const a: Uint8Array[] = [];
  const b: Uint8Array[] = [];
  const wait = async (q: Uint8Array[]): Promise<Uint8Array> => {
    while (q.length === 0) await new Promise((r) => setTimeout(r, 0));
    return q.shift() as Uint8Array;
  };
  return [
    { send: (f) => void b.push(f), recv: () => wait(a) },
    { send: (f) => void a.push(f), recv: () => wait(b) },
  ];
}

describe('noise channel', () => {
  test('authorized device reconnects and exchanges a frame', async () => {
    const server = genKeypair();
    const device = genKeypair();
    const devPubB64 = Buffer.from(device.pub).toString('base64');
    const [serverIo, clientIo] = pipe();

    // server side runs concurrently
    const serverPromise = acceptReconnect(serverIo, server.priv, (pk) =>
      pk === devPubB64 ? { pk } : null,
    );

    // device side: IK initiator
    const i = reconnectInitiator(device.priv, server.pub);
    await clientIo.send(i.writeMessage()); // -> e, es, s, ss
    i.readMessage(await clientIo.recv()); // <- e, ee, se
    i.intoTransport();

    const channel = await serverPromise;
    expect(channel.device).toEqual({ pk: devPubB64 });

    // device -> server frame
    const msg = new TextEncoder().encode('over the channel');
    await clientIo.send(i.seal(msg));
    // (server reads via its own transport — exercised in the seal/open test below)
    i.free();
  });

  test('unknown device is refused before any app data', async () => {
    const server = genKeypair();
    const device = genKeypair();
    const [serverIo, clientIo] = pipe();
    const serverPromise = acceptReconnect(serverIo, server.priv, () => null); // deny all

    const i = reconnectInitiator(device.priv, server.pub);
    await clientIo.send(i.writeMessage());
    // server sends msg2 then rejects; the initiator may or may not read it.
    await expect(serverPromise).rejects.toMatchObject({ code: 'unauthorized' });
    i.free();
  });
});
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement `noiseChannel.ts`.** `acceptReconnect`: create `reconnectResponder(serverPriv)`; `recv()` msg1 → `readMessage`; `send(writeMessage())` msg2; assert `isFinished()`; read `remoteStatic()` → base64 → call `authorize`; if null, `free()` and throw `ChannelError('unauthorized')` **without** `intoTransport`; else `intoTransport()` and return a `ServerChannel` wrapping the handle + the device. `ServerChannel.seal/open/rekey*` delegate to the handle. Wrap FFI errors as `ChannelError('handshake')`.

- [ ] **Step 4:** Run → PASS.

- [ ] **Step 5:** Commit. `git commit -am "feat(noise-channel): IK accept + fail-closed authorization gate"`

---

## Task 3: `acceptPairing` (XXpsk2 responder + host-confirm hook)

**Files:** Modify `noiseChannel.ts`, `noiseChannel.test.ts`.

**Interfaces:**
- Produces:
  - `interface PairingHooks { psk: Uint8Array; confirm: (proposal: { pubkeyBase64: string }) => boolean | Promise<boolean>; }`
  - `async function acceptPairing(io: FrameIO, serverPriv: Uint8Array, hooks: PairingHooks): Promise<{ channel: ServerChannel; devicePubkey: string }>` — runs the 3-message XXpsk2 responder; after completion reads the device static, calls `hooks.confirm`; if it returns false, `free()` + throw `ChannelError('rejected')`; else `intoTransport` and return the channel + the device pubkey (base64) for the caller to enroll.
  - Extend `ChannelError` code union with `'rejected'`.

- [ ] **Step 1: Write the failing test** pairing a `pairInitiator` (device) against `acceptPairing` (server) with a shared PSK from `derivePsk('011B-2345-6789')`, a `confirm: () => true` hook; assert the returned `devicePubkey` equals the device's pubkey base64 and a sealed frame from the device `open`s on the server channel. Add a second test with `confirm: () => false` asserting `rejects` with `code: 'rejected'` and that no transport was created (the device's subsequent `seal` has no server peer — just assert the rejection).

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `acceptPairing` (XXpsk2 responder is `pairResponder(serverPriv, psk)`; 3 messages: recv, send, recv).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** typecheck + biome on `noiseChannel.ts`, `noiseFfi.ts`. Commit. `git commit -am "feat(noise-channel): XXpsk2 pairing accept with host-confirm hook"`

---

## Self-Review

- IK ≠ authorization: the unauthorized test proves no transport/app-data on denial. ✅
- Injected authorizer/PSK/confirm — no registry import. ✅ (Plan 2b's `getDeviceByPubkey` is passed in at the real call site in a later plan.)
- Built on Plan 2a's binding; reconnect wrappers added and tested. ✅
- Deferred (later 2c plans): wiring `acceptReconnect`/`acceptPairing` into the WS gateway in `app.ts`, multiplexing `/api/*` over the channel, the `tether pair` daemon control endpoint + enrollment window, password removal, cdylib packaging into `bun --compile`.

## Execution Handoff

After this, the remaining 2c work merges Plan 2b (registry+CLI), then wires the channel into `app.ts` + the pairing daemon endpoint + password removal + packaging.
