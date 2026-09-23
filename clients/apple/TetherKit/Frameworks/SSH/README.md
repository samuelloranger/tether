# v5 SSH transport dependencies

Prebuilt iOS XCFrameworks for the v5 libssh2 transport spike. They are
vendored build inputs, not generated output.

## Contents

| XCFramework | Version | Upstream | License |
|---|---|---|---|
| `ssh2.xcframework` (`libssh2.a`) | 1.11.0 | https://github.com/libssh2/libssh2 | BSD-style (see upstream COPYING) |
| `crypto.xcframework` (`libcrypto.a`) | openssl-4.0.1 source tree | https://github.com/openssl/openssl | Apache License 2.0 |
| `ssl.xcframework` (`libssl.a`) | openssl-4.0.1 source tree | https://github.com/openssl/openssl | Apache License 2.0 |

Versions verified from the binaries: `libssh2.a` carries the
`SSH-2.0-libssh2_1.11.0` banner and `1.11.0` version string; `libcrypto.a` and
`libssl.a` carry `../openssl-4.0.1/...` debug paths. Slices per `Info.plist`:
`ios-arm64` and `ios-arm64_x86_64-simulator`. No macOS slice — `swift test`
cannot link these; run `TetherKitTests` through the package's `TetherKit`
scheme on an iOS simulator (see `HANDOFF.md`).

## Build provenance

Built on macbuild. The upstream OpenSSL XCFramework export did not contain a
complete build-time header set, so libssh2 was built against the complete
OpenSSL *source* headers plus generated platform headers; the runtime
XCFrameworks here are still the vendored artifacts.

TODO before the Phase 1 commit: the exact configure/cmake flags, SDK versions,
and minimum deployment target were never recorded. Object strings suggest a
`arm64-apple-ios13.4.0` clang triple, but that is an observation, not a build
log — reproduce or confirm on macbuild and record it here. Check
`COPYING`/`LICENSE` texts into this directory if redistribution requires it.
