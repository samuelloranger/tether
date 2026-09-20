import Foundation

/// Trust store for pinned SSH host-key fingerprints, scoped per host:port.
protocol HostKeyStore {
  func pinnedFingerprint(host: String, port: Int) -> String?
  func pin(_ fingerprint: String, host: String, port: Int)
}

/// Outcome of checking a server's presented host key against the trust store.
enum HostKeyDecision: Equatable {
  /// Endpoint was unknown; the fingerprint has just been pinned (trust on first use).
  case pinnedNew
  /// Presented fingerprint equals the pinned one.
  case matched
  /// Presented fingerprint differs from the pin. The connection MUST be refused;
  /// the pin is left untouched so a hostile key can never replace a trusted one.
  case mismatch(expected: String, got: String)
}

/// Trust-on-first-use host-key policy: pin an unknown endpoint, accept a match,
/// hard-reject a change. There is deliberately no override path.
enum HostKeyVerifier {
  static func verify(fingerprint: String, host: String, port: Int, store: HostKeyStore) -> HostKeyDecision {
    guard let pinned = store.pinnedFingerprint(host: host, port: port) else {
      store.pin(fingerprint, host: host, port: port)
      return .pinnedNew
    }
    if pinned == fingerprint { return .matched }
    return .mismatch(expected: pinned, got: fingerprint)
  }
}
