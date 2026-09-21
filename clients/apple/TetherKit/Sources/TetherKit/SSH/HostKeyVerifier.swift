import Foundation

protocol HostKeyStore {
  func pinnedFingerprint(host: String, port: Int) -> String?
  func pin(_ fingerprint: String, host: String, port: Int)
}

enum HostKeyDecision: Equatable {
  case pinnedNew
  case matched
  case mismatch(expected: String, got: String)
}

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
