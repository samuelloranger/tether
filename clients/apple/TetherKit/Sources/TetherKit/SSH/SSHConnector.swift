import Foundation

/// Establishes SSH work off the cooperative thread pool. The connect handshake
/// and one-off exec both block, so they run on a dedicated thread and resume the
/// caller with the result. A returned pump owns its own thread thereafter.
enum SSHConnector {
  static func connect(config: SSHConnectionConfig, store: HostKeyStore) async throws -> any TerminalByteStream {
    try await onThread(named: "tether.ssh.connect") {
      try SSHConnectionSequence.run(config: config, ops: LibSSH2Ops(config: config), store: store)
    }
  }

  static func exec(config: SSHConnectionConfig, store: HostKeyStore, command: String) async throws -> String {
    try await onThread(named: "tether.ssh.exec") {
      try SSHConnectionSequence.runExec(config: config, ops: LibSSH2Ops(config: config), store: store, command: command)
    }
  }

  private static func onThread<T: Sendable>(named name: String, _ body: @escaping @Sendable () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
      let thread = Thread {
        do { continuation.resume(returning: try body()) }
        catch { continuation.resume(throwing: error) }
      }
      thread.name = name
      thread.stackSize = 1024 * 1024
      thread.start()
    }
  }
}

/// UserDefaults-backed host-key trust store. Fingerprints are public host
/// identities, not secrets, so plain defaults is the right home.
final class UserDefaultsHostKeyStore: HostKeyStore {
  private let defaults: UserDefaults
  private let prefix = "tether.ssh.hostkey."

  init(defaults: UserDefaults = .standard) { self.defaults = defaults }

  private func key(_ host: String, _ port: Int) -> String { "\(prefix)\(host):\(port)" }

  func pinnedFingerprint(host: String, port: Int) -> String? { defaults.string(forKey: key(host, port)) }
  func pin(_ fingerprint: String, host: String, port: Int) { defaults.set(fingerprint, forKey: key(host, port)) }
}
