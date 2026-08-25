# tether-proto

The protocol v2 wire schema. `schema/wire.proto` is the single source of truth for
the frame kinds and for every structural message on the WebSocket gateway.

## Framing

Protocol v2 frames are length-prefixed binary:

```
u8  kind        (FrameKind, from wire.proto)
u32 len         (big-endian)
[len bytes payload]
```

`FRAME_KIND_OUTPUT` carries **raw PTY bytes** — no protobuf wrapper, no base64.
Every other kind carries the protobuf message named after it.

The server ↔ holder unix socket uses the *same* framing with its own kinds and
hand-rolled payloads (see `apps/server/src/server/holderFrame.ts`); it is not
described here because nothing outside the server process ever sees it.

## Code generation

- **TypeScript** (`@bufbuild/protobuf` / protobuf-es): `bun run gen:proto` from
  the repo root, driven by `buf.gen.yaml`. The output lands in
  `apps/server/src/server/proto/gen/` and **is committed** — CI never runs buf or
  protoc. Rerun it only when this schema changes, and commit the result with it.
- **Rust** (`prost`): not wired up yet. It depends on `crates/tether-core`.

## Compatibility

Field numbers are explicit and are never reused; a retired field or enum value
becomes `reserved`. Protocol v1 — the JSON protocol the Expo client speaks — is
frozen and deliberately absent from this schema.
