import Foundation

/// One long-lived SSH connection reserved for the app's own commands — the
/// session list, a kill, scrollback, a git diff — so each costs a single round
/// trip instead of a fresh dial, handshake and authentication.
///
/// It is a *second connection*, not a second channel on the terminal's. libssh2
/// reads the socket inside its channel calls, so multiplexing a control channel
/// beside the live PTY risks stalling terminal output for gains this does not
/// need. One channel per session is the shape libssh2 is reliable at.
///
/// Commands are serialized: a libssh2 session tolerates several callers only
/// because they queue, never overlap.
final class ControlConnection: @unchecked Sendable {
  private let config: SSHConnectionConfig
  private let store: HostKeyStore
  private let makeOps: () -> SSHConnectionOps
  /// One thread owns the session for its whole life; every call hops onto it.
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

  /// Runs one command, opening the connection if this is the first. A command
  /// that fails on an already-open session is retried once on a fresh one: an
  /// idle SSH connection can be reaped by the host or by a NAT in between, and
  /// the first failure is how we find out.
  func exec(_ command: String) async throws -> String {
    try await onQueue { [self] in
      let reused = ops != nil
      do {
        return try run(command)
      } catch let error as SSHConnectError {
        // A changed host key is never retried — that must fail loudly here as
        // it does on the terminal's own connection.
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
      // The session is suspect now; the caller decides whether to try again.
      teardown()
      throw error
    }
  }

  private func openIfNeeded() throws -> SSHConnectionOps {
    if let ops { return ops }
    let fresh = makeOps()
    // Same gate as the terminal: handshake, host-key trust, then auth.
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
