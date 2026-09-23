import Foundation

/// Connect and exec block, so each runs on a dedicated thread, off the cooperative pool.
enum SSHConnector {
  static func connect(config: SSHConnectionConfig, store: HostKeyStore) async throws -> any TerminalByteStream {
    try await onThread(named: "tether.ssh.connect") {
      try SSHConnectionSequence.run(config: config, ops: LibSSH2Ops(config: config), store: store)
    }
  }

  /// `onChunk` runs on the worker thread. Cancelling the task shuts the socket, so a quiet
  /// command stops too.
  static func execStream(
    config: SSHConnectionConfig,
    store: HostKeyStore,
    command: String,
    onChunk: @escaping @Sendable (String) -> Bool
  ) async throws {
    try await execStream(config: config, store: store, command: command, ops: LibSSH2Ops(config: config), onChunk: onChunk)
  }

  static func execStream(
    config: SSHConnectionConfig,
    store: HostKeyStore,
    command: String,
    ops: any SSHConnectionOps & Sendable,
    onChunk: @escaping @Sendable (String) -> Bool
  ) async throws {
    let cancelled = LockedBox(false)
    try await withTaskCancellationHandler {
      try await onThread(named: "tether.ssh.execStream") {
        if cancelled.value { throw CancellationError() }
        try SSHConnectionSequence.runExecStream(
          config: config, ops: ops, store: store, command: command
        ) { chunk in !cancelled.value && onChunk(chunk) }
      }
    } onCancel: {
      cancelled.value = true
      ops.interrupt()
    }
  }

  static func scpSend(
    config: SSHConnectionConfig,
    store: HostKeyStore,
    data: Data,
    remotePath: String,
    mode: Int32 = 0o644
  ) async throws {
    try await onThread(named: "tether.ssh.scp") {
      try SSHConnectionSequence.runScpSend(
        config: config, ops: LibSSH2Ops(config: config), store: store,
        data: data, remotePath: remotePath, mode: mode
      )
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
