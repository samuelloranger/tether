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
  /// The session a `reset()` from another thread may cut. The queue owns `ops`;
  /// this is only ever used to call `interrupt()`.
  private let liveLock = NSLock()
  private var live: SSHConnectionOps?

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
        guard reused, error.isTransient else { throw error }
        return try run(command)
      }
    }
  }

  /// Cuts the current session's socket from any thread: a command blocked on a
  /// dead path fails now instead of when TCP gives up, and the next one dials
  /// fresh. Safe when nothing is open.
  func reset() {
    liveLock.lock()
    let current = live
    liveLock.unlock()
    current?.interrupt()
  }

  func close() async {
    reset()
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
    } catch let error as SSHConnectError {
      teardown()
      throw error
    } catch {
      teardown()
      throw SSHConnectError.transport("\(error)")
    }
  }

  private func openIfNeeded() throws -> SSHConnectionOps {
    if let ops { return ops }
    let fresh = makeOps()
    setLive(fresh)
    do {
      try SSHConnectionSequence.authenticate(config: config, ops: fresh, store: store)
    } catch {
      setLive(nil)
      throw error
    }
    ops = fresh
    return fresh
  }

  private func teardown() {
    ops?.teardown()
    ops = nil
    setLive(nil)
  }

  private func setLive(_ ops: SSHConnectionOps?) {
    liveLock.lock()
    live = ops
    liveLock.unlock()
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
