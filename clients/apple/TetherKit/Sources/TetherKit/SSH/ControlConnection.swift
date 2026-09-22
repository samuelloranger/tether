import Foundation

/// One long-lived SSH connection for the app's own commands, so each costs a
/// round trip instead of a fresh dial.
///
/// A second connection rather than a second channel on the terminal's: libssh2
/// reads the socket inside its channel calls, so a control channel beside the
/// live PTY can stall terminal output.
final class ControlConnection: @unchecked Sendable {
  private let config: SSHConnectionConfig
  private let store: HostKeyStore
  private let makeOps: () -> SSHConnectionOps
  /// A libssh2 session tolerates several callers only because they queue here.
  private let queue: DispatchQueue
  private var ops: SSHConnectionOps?

  init(
    config: SSHConnectionConfig,
    store: HostKeyStore,
    makeOps: @escaping () -> SSHConnectionOps
  ) {
    self.config = config
    self.store = store
    self.makeOps = makeOps
    self.queue = DispatchQueue(label: "tether.ssh.control.\(config.host):\(config.port)")
  }

  convenience init(config: SSHConnectionConfig, store: HostKeyStore) {
    self.init(config: config, store: store) { LibSSH2Ops(config: config) }
  }

  /// A command that fails on an already-open session is retried once: an idle
  /// connection can be reaped by the host or a NAT, and the first failure is
  /// how we find out.
  func exec(_ command: String) async throws -> String {
    try await onQueue { [self] in
      let reused = ops != nil
      do {
        return try run(command)
      } catch let error as SSHConnectError {
        if case .hostKeyMismatch = error { throw error }
        guard reused else { throw error }
        return try run(command)
      } catch {
        guard reused else { throw error }
        return try run(command)
      }
    }
  }

  func close() async {
    try? await onQueue { [self] in
      teardown()
      return ""
    }
  }

  // MARK: - on the connection's own thread

  private func run(_ command: String) throws -> String {
    let session = try openIfNeeded()
    do {
      return try session.exec(command)
    } catch {
      teardown()
      throw error
    }
  }

  private func openIfNeeded() throws -> SSHConnectionOps {
    if let ops { return ops }
    let fresh = makeOps()
    try SSHConnectionSequence.authenticate(config: config, ops: fresh, store: store)
    ops = fresh
    return fresh
  }

  private func teardown() {
    ops?.teardown()
    ops = nil
  }

  private func onQueue(_ body: @escaping () throws -> String) async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        do { continuation.resume(returning: try body()) }
        catch { continuation.resume(throwing: error) }
      }
    }
  }
}
