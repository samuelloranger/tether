# SSH transport dependencies

Prebuilt iOS XCFrameworks for the libssh2 transport. They are vendored build
inputs, rebuilt with `scripts/build-ssh-xcframeworks.sh` (macOS + Xcode +
cmake). The script also refreshes `Sources/CLibSSH2/include/libssh2.h` so the
header always matches the binary.

## Contents

| XCFramework | Version | Upstream | License |
|---|---|---|---|
| `ssh2.xcframework` (`libssh2.a`) | `master` @ `2e1717456b8d` (1.11.2_DEV) | https://github.com/libssh2/libssh2 | BSD-3-Clause (`LICENSE-libssh2`) |
| `crypto.xcframework` (`libcrypto.a`) | OpenSSL 4.0.2 | https://github.com/openssl/openssl | Apache-2.0 (`LICENSE-openssl`) |
| `ssl.xcframework` (`libssl.a`) | OpenSSL 4.0.2 | https://github.com/openssl/openssl | Apache-2.0 (`LICENSE-openssl`) |

Slices: `ios-arm64` and `ios-arm64_x86_64-simulator`, minimum iOS 17.0. No
macOS slice — `swift test` cannot link these; run `TetherKitTests` through the
package's `TetherKit` scheme on an iOS simulator.

## Why libssh2 is built from `master`

libssh2 1.11.1 (the latest tag) and everything before it are affected by
CVE-2026-55200: `ssh2_transport_read()` does not bound `packet_length`, so a
malicious server can corrupt client heap memory during key exchange — before
host-key verification. The fix (`97acf3df`, libssh2#2052) and several other
2026 hardening fixes (chacha20-poly1305 length underflow, publickey subsystem
size caps, SFTP fixes) are only on `master`.

**Move to the `libssh2-1.11.2` tag once it is released:**

```bash
LIBSSH2_REF=libssh2-1.11.2 bash scripts/build-ssh-xcframeworks.sh
```

then update the table above and rerun `TetherKitTests`, including
`LibSSH2OpsTimeoutTests.test_a_real_sshd_completes_the_handshake`.

## Behaviour changes versus 1.11.0

- Strict KEX (Terrapin mitigation) and `chacha20-poly1305@openssh.com` are
  supported.
- SHA1/MD5-based algorithms and DSA are disabled by default: `ssh-rsa`
  (SHA1) signatures, `diffie-hellman-group{1,14}-sha1`,
  `diffie-hellman-group-exchange-sha1`, `hmac-sha1*`, `hmac-md5*`, `ssh-dss`.
  RSA keys still work through `rsa-sha2-256`/`rsa-sha2-512`. A server that
  only offers the legacy algorithms can no longer be reached.

## Build provenance

| | |
|---|---|
| Script | `scripts/build-ssh-xcframeworks.sh` (defaults are the pinned versions) |
| OpenSSL | release tarball, SHA-256 verified; `Configure <ios64-xcrun / iossimulator-arm64-xcrun / iossimulator-x86_64-xcrun> no-shared no-tests no-apps no-docs` |
| libssh2 | CMake, `CRYPTO_BACKEND=OpenSSL`, static, `ENABLE_ZLIB_COMPRESSION=ON` (links the SDK's `libz`) |
| Toolchain | Xcode 27.0 (iOS 27.0 SDK), cmake 4.4.3 |
