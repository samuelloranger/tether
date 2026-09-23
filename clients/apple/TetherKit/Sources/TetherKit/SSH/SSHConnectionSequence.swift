import Foundation

protocol SSHConnectionOps: AnyObject {
  func connectAndHandshake() throws
  func hostKeyFingerprint() throws -> String
  func authenticate(_ credential: SSHCredential) throws -> Bool
  func openPTYChannel(cols: Int, rows: Int) throws -> any TerminalByteStream
  func exec(_ command: String) throws -> String
  /// `onChunk` returns false to stop reading and tear the channel down.
  func execStream(_ command: String, onChunk: (String) -> Bool) throws
  func scpSend(data: Data, remotePath: String, mode: Int32) throws
  var lastAuthDetail: String? { get }
  func teardown()
  /// Cuts the socket from any thread, so a call blocked on a dead path returns.
  func interrupt()
}

extension SSHConnectionOps {
  var lastAuthDetail: String? { nil }

  func interrupt() {}

  func scpSend(data: Data, remotePath: String, mode: Int32) throws {
    throw SSHConnectError.transport("File transfer not supported")
  }

  func execStream(_ command: String, onChunk: (String) -> Bool) throws {
    _ = onChunk(try exec(command))
  }
}

struct SSHConnectionConfig: Equatable, Sendable {
  var host: String
  var port: Int
  var username: String
  var credentials: [SSHCredential]
  var cols: Int = 80
  var rows: Int = 24
}

enum SSHConnectError: Error, Equatable, LocalizedError {
  case hostKeyMismatch(expected: String, got: String)
  case auth(SSHAuthError)
  case transport(String)
  case missingCredential(name: String)
  case commandTimedOut

  var errorDescription: String? {
    switch self {
    case let .hostKeyMismatch(expected, got):
      return "Host key changed — refused.\nExpected \(expected)\nGot \(got)"
    case let .auth(error):
      guard case let .allFailed(detail) = error, let detail, !detail.isEmpty else {
        return "Authentication failed. Check the key or password."
      }
      return "Authentication failed. Check the key or password.\n\(detail)"
    case let .transport(detail):
      return "Could not connect: \(detail)"
    case let .missingCredential(name):
      return "No credential for \(name) — check its key or password."
    case .commandTimedOut:
      return "The host stopped answering."
    }
  }
}

extension SSHConnectError {
  var isTransient: Bool {
    if case .transport = self { return true }
    return false
  }
}

enum SSHConnectionSequence {
  static func run(
    config: SSHConnectionConfig,
    ops: SSHConnectionOps,
    store: HostKeyStore
  ) throws -> any TerminalByteStream {
    try gate(config: config, ops: ops, store: store)
    do {
      return try ops.openPTYChannel(cols: config.cols, rows: config.rows)
    } catch {
      ops.teardown()
      throw SSHConnectError.transport("\(error)")
    }
  }

  static func runExecStream(
    config: SSHConnectionConfig,
    ops: SSHConnectionOps,
    store: HostKeyStore,
    command: String,
    onChunk: (String) -> Bool
  ) throws {
    defer { ops.teardown() }
    try gate(config: config, ops: ops, store: store)
    do {
      try ops.execStream(command, onChunk: onChunk)
    } catch let error as SSHConnectError {
      throw error
    } catch {
      throw SSHConnectError.transport("\(error)")
    }
  }

  static func runScpSend(
    config: SSHConnectionConfig,
    ops: SSHConnectionOps,
    store: HostKeyStore,
    data: Data,
    remotePath: String,
    mode: Int32
  ) throws {
    defer { ops.teardown() }
    for attempt in 0...1 {
      do {
        try gate(config: config, ops: ops, store: store)
        try ops.scpSend(data: data, remotePath: remotePath, mode: mode)
        return
      } catch let error as SSHConnectError {
        guard attempt == 0, error.isTransient else { throw error }
        ops.teardown()
      } catch {
        let transportError = SSHConnectError.transport("\(error)")
        guard attempt == 0, transportError.isTransient else { throw transportError }
        ops.teardown()
      }
    }
  }

  /// Connect and authenticate, leaving the session open for repeated use —
  /// unlike `runExecStream`, which tears it down.
  static func authenticate(
    config: SSHConnectionConfig,
    ops: SSHConnectionOps,
    store: HostKeyStore
  ) throws {
    try gate(config: config, ops: ops, store: store)
  }

  /// Concurrent publickey signing intermittently fails (libssh2 -19). Serialize only the signing,
  /// per host: a lock across the TCP connect lets one unreachable host stall every other dial.
  private static let authLocksGuard = NSLock()
  private static var authLocks: [String: NSLock] = [:]

  private static func authLock(host: String, port: Int) -> NSLock {
    let key = "\(host):\(port)"
    authLocksGuard.lock()
    defer { authLocksGuard.unlock() }
    if let existing = authLocks[key] { return existing }
    let lock = NSLock()
    authLocks[key] = lock
    return lock
  }

  /// Tears the session down on any failure; leaves it authenticated on success.
  private static func gate(
    config: SSHConnectionConfig,
    ops: SSHConnectionOps,
    store: HostKeyStore
  ) throws {
    do {
      try ops.connectAndHandshake()
    } catch {
      ops.teardown()
      throw SSHConnectError.transport("\(error)")
    }
    do {
      let fingerprint = try ops.hostKeyFingerprint()
      if case let .mismatch(expected, got) = HostKeyVerifier.verify(
        fingerprint: fingerprint, host: config.host, port: config.port, store: store
      ) {
        throw SSHConnectError.hostKeyMismatch(expected: expected, got: got)
      }
      let lock = authLock(host: config.host, port: config.port)
      lock.lock()
      defer { lock.unlock() }
      _ = try authenticateInOrder(config.credentials) { try ops.authenticate($0) }
    } catch let error as SSHConnectError {
      ops.teardown()
      throw error
    } catch let error as SSHAuthError {
      let detail = ops.lastAuthDetail
      ops.teardown()
      if case .allFailed = error { throw SSHConnectError.auth(.allFailed(detail: detail)) }
      throw SSHConnectError.auth(error)
    } catch {
      ops.teardown()
      throw SSHConnectError.transport("\(error)")
    }
  }
}
