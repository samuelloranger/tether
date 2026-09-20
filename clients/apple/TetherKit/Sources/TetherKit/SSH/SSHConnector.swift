import Foundation

/// Establishes an authenticated SSH PTY off the cooperative thread pool.
///
/// The connect handshake blocks (DNS, TCP, key exchange, auth), so it runs on a
/// dedicated thread and resumes the caller with the live byte stream. The
/// returned pump owns its own thread for the session's lifetime.
enum SSHConnector {
  static func connect(
    config: SSHConnectionConfig,
    store: HostKeyStore
  ) async throws -> any TerminalByteStream {
    try await withCheckedThrowingContinuation { continuation in
      let thread = Thread {
        do {
          let ops = LibSSH2Ops(config: config)
          let stream = try SSHConnectionSequence.run(config: config, ops: ops, store: store)
          continuation.resume(returning: stream)
        } catch {
          continuation.resume(throwing: error)
        }
      }
      thread.name = "tether.ssh.connect"
      thread.stackSize = 1024 * 1024
      thread.start()
    }
  }

  /// Runs a one-off command on the host (e.g. `zmx ls`) over a short-lived
  /// connection, off the cooperative pool, and returns its stdout.
  static func exec(
    config: SSHConnectionConfig,
    store: HostKeyStore,
    command: String
  ) async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      let thread = Thread {
        do {
          let ops = LibSSH2Ops(config: config)
          let output = try SSHConnectionSequence.runExec(config: config, ops: ops, store: store, command: command)
          continuation.resume(returning: output)
        } catch {
          continuation.resume(throwing: error)
        }
      }
      thread.name = "tether.ssh.exec"
      thread.stackSize = 1024 * 1024
      thread.start()
    }
  }
}

/// UserDefaults-backed host-key trust store. Fingerprints are not secret (they
/// are public host identities), so plain defaults is the right home; the private
/// key material lives in the Keychain vault, not here.
final class UserDefaultsHostKeyStore: HostKeyStore {
  private let defaults: UserDefaults
  private let prefix = "tether.ssh.hostkey."

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  private func key(_ host: String, _ port: Int) -> String { "\(prefix)\(host):\(port)" }

  func pinnedFingerprint(host: String, port: Int) -> String? {
    defaults.string(forKey: key(host, port))
  }

  func pin(_ fingerprint: String, host: String, port: Int) {
    defaults.set(fingerprint, forKey: key(host, port))
  }
}
