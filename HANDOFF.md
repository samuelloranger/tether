# Tether v5 handoff

## Current state

Board task **1335** is still `in_progress`. The v5 plan is at:
https://glim.samlo.cloud/tether-v5-migration-plan-w63z/

The transport decision is **libssh2 + OpenSSL**, not Citadel. The current worktree contains an uncommitted Phase 1 spike:

- iOS-only `ssh2`, `crypto`, and `ssl` XCFrameworks under `clients/apple/TetherKit/Frameworks/SSH/`, plus `Frameworks/SSH/README.md` (versions, slices, licenses, build provenance).
- SwiftPM binary targets and a local `CLibSSH2` C module in `clients/apple/TetherKit/Package.swift` and `Sources/CLibSSH2/`.
- `LibSSH2TransportProbe.swift` with the low-level handshake/PTY/shell/read/write call surface.
- `TerminalByteStream.swift` plus `TerminalPipeline.connectSSH(...)`, which routes incoming bytes through the existing `applyOutput` → emulator → TGRD snapshot path and routes terminal input/paste back to the stream.
- Renderer-routing tests added to `TerminalPipelineRenderingTests.swift` and the existing libssh2 probe test.

No commit has been created. Preserve unrelated pre-existing untracked files:

- `.tether-present/`
- `apps/server/dev-prod-pair.ts`

## Verification completed (2026-09-20)

- macbuild (`ssh macbuild`, path `~/Sites/tether` — note capital `S`, differs from this checkout) has Xcode 27.0.
- Correct simulator test runner found: the SwiftPM package exposes its own **`TetherKit` scheme** (`xcodebuild -list` in `clients/apple/TetherKit`). The earlier failure was looking for `TetherKitTests` in the `TetherIOS` app scheme, which never contained it. `swift test` cannot work — the XCFrameworks have no macOS slice. Command (from `clients/apple/TetherKit` on macbuild):

  `xcodebuild test -scheme TetherKit -destination 'platform=iOS Simulator,id=C5D4C289-36D5-433A-970B-2E2665D6FA7D' -only-testing:TetherKitTests/TerminalPipelineRenderingTests -only-testing:TetherKitTests/LibSSH2TransportProbeTests`

  Result: **TEST SUCCEEDED — 6 tests, 0 failures** (5 rendering/routing + 1 probe), reproduced both before and after the review fixes below.
- Removed a stray exact duplicate of the rendering tests at `Sources/TetherKit/Terminal/TerminalPipelineRenderingTests.swift` on macbuild (it polluted the library target with XCTest). It never existed in this checkout.
- The live simulator harness proved TCP → libssh2 handshake → in-memory Ed25519 auth → PTY → shell → `~/.local/bin/zmx attach ...`; the simulator received ANSI output and `TETHER_V5_LIVE_RENDER_SPIKE`.
- Temporary key, temporary probe binary/source, authorized_keys entry, and disposable zmx session were removed and independently verified.
- `git diff --check` is clean.

## Review findings applied (uncommitted)

1. `LIBSSH2_ERROR_EAGAIN` (-37) was fatal: any nonblocking no-data read/write threw `readFailed`/`writeFailed`, killing the pipeline with a spurious error event. Now `LibSSH2TransportProbe.wouldBlockStatus` with sleep-and-retry in both `read()` and `write()`.
2. `write()` copied the remaining `Data` on every partial write (`Data(dropFirst:)`). Now slices via pointer arithmetic.
3. `read()` had no cancellation check before re-entering the blocking C call; `Task.checkCancellation()` added to both loops.
4. SSH input/paste write failures were swallowed by `try?`, leaving a dead-looking terminal with `isConnected == true`. Now detaches `sshTransport` and yields the error, mirroring the read-loop close path.
5. Test helper `eventually` threw `XCTSkip` on timeout, hiding regressions as skips. Now `XCTFail` + throw.
6. Ownership documented on `LibSSH2ChannelByteStream`: it owns the channel only; session + socket teardown, auth, and host-key verification belong to the future connector.

Still open (production blockers, not Phase 1): no host-key verification anywhere; no `libssh2_channel_eof`/exit-status handling (0-byte read == EOF by assumption); `read()` blocks a cooperative thread in blocking mode; stale-key `continue` in `readLoopSSH` mirrors the Noise loop and both should probably `break`.

## Decisions

- `connectSSH` **stays an injected seam**. The byte-stream boundary is proven testable without a host. Next cutover step: write the concrete authenticated connector (socket + handshake + host-key verification + auth + PTY open) that produces a `LibSSH2ChannelByteStream` and hands it to `connectSSH` — no pipeline signature change needed.
- Provenance lives in `clients/apple/TetherKit/Frameworks/SSH/README.md`: libssh2 **1.11.0** (banner/version strings in `libssh2.a`), OpenSSL **4.0.1** source tree (debug paths in `libcrypto.a`/`libssl.a`), `ios-arm64` + `ios-arm64_x86_64-simulator` slices, licenses (libssh2 BSD-style, OpenSSL Apache-2.0). Exact cmake/configure flags and min deployment target were never recorded — the README marks that TODO.

## Next agent checklist

1. Record the exact libssh2/OpenSSL build flags + deployment target in `Frameworks/SSH/README.md` (reproduce or confirm on macbuild).
2. Commit Phase 1 from **one** checkout and reconcile the other: this checkout has the `.gitignore` un-ignore for `Frameworks/SSH/` (without it the XCFrameworks are silently excluded from the commit); macbuild has an untracked `build/` dir and a `~/Sites` path. Verify `git status` on the committing machine lists `Frameworks/SSH/**`, the revised `.gitignore`, and the README.
3. Build the authenticated connector (host-key verification first), then the SessionStore/host-storage/Keychain/TOFU/reconnect/UI cutover.
4. Do not delete Rust/Noise/server/desktop systems yet; deletion is the final v5 phase.

## Live host details

- Host: `samuelloranger@192.168.50.30`, SSH port `2222`.
- zmx: `~/.local/bin/zmx`.
- No credentials remain installed from the live proof. Generate a new dedicated temporary key only with explicit authorization, and remove it after use.
