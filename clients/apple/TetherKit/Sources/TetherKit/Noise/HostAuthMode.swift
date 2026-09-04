import Foundation

/// How a host authenticates its transport.
///
/// There is deliberately NO `authMode` field on `HostProfileModel` or the Rust
/// FFI — adding one would force a `tether-core` + UniFFI change that also touches
/// desktop. Instead the mode is DERIVED from what key material exists for the
/// host (see `HostAuthModeResolver`). This enum is the interim, Swift-only shape;
/// a real persisted `authMode` can replace the derivation later.
public enum HostAuthMode: Equatable, Sendable {
  /// Bearer-token / password transport (`NativeHostClient` over `/api/ws`).
  case password
  /// Noise-secured transport (`NoiseSessionClient` over `/api/noise/session`).
  case noise
}

/// Derives a host's `HostAuthMode` from its stored key material.
///
/// Interim scheme: a host is a **Noise host iff BOTH Noise keys exist for it (the
/// pinned server public key AND the device private key) AND it has no stored
/// password**. Requiring both keys matters: a reconnect needs both, so a host
/// with only one (e.g. a half-finished migration) must NOT classify as `.noise`
/// — it would sail past this gate and then fail obscurely inside the handshake.
/// A password host is anything else — it either has a password secret, or (a
/// freshly restored / half-set-up host) lacks the key material, in which case
/// the password path is the safe default because that is what every pre-Noise
/// host was. Kept as a pure function so it is testable without a Keychain.
public enum HostAuthModeResolver {
  public static func resolve(
    hasPinnedNoiseKey: Bool,
    hasDeviceKey: Bool,
    hasPassword: Bool
  ) -> HostAuthMode {
    hasPinnedNoiseKey && hasDeviceKey && !hasPassword ? .noise : .password
  }
}

/// Errors from the Noise host-profile lifecycle.
public enum NoiseHostError: Error, Equatable {
  /// `createNoiseHost` could not find the paired key material under the pairing
  /// id — pairing did not actually complete, so no profile is created.
  case missingPairedKeys
}
