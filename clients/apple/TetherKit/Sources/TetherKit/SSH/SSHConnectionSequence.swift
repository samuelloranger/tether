import Foundation

protocol SSHConnectionOps: AnyObject {
  func connectAndHandshake() throws
  func hostKeyFingerprint() throws -> String
  func authenticate(_ credential: SSHCredential) throws -> Bool
  func openPTYChannel(cols: Int, rows: Int) throws -> any TerminalByteStream
  func exec(_ command: String) throws -> String
  func scpSend(data: Data, remotePath: String, mode: Int32) throws
  /// Why the last authentication attempt failed, in the transport's words.
  var lastAuthDetail: String? { get }
  func teardown()
}

extension SSHConnectionOps {
  var lastAuthDetail: String? { nil }

  func scpSend(data: Data, remotePath: String, mode: Int32) throws {
    throw SSHConnectError.transport("File transfer not supported")
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
    }
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

  static func runExec(
    config: SSHConnectionConfig,
    ops: SSHConnectionOps,
    store: HostKeyStore,
    command: String
  ) throws -> String {
    defer { ops.teardown() }
    try gate(config: config, ops: ops, store: store)
    do {
      return try ops.exec(command)
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
    try gate(config: config, ops: ops, store: store)
    do {
      try ops.scpSend(data: data, remotePath: remotePath, mode: mode)
    } catch let error as SSHConnectError {
      throw error
    } catch {
      throw SSHConnectError.transport("\(error)")
    }
  }

  /// Connect and authenticate, leaving the session open for repeated use. The
  /// control connection runs many commands over one session, so unlike
  /// `runExec` this never tears it down on success.
  static func authenticate(
    config: SSHConnectionConfig,
    ops: SSHConnectionOps,
    store: HostKeyStore
  ) throws {
    try gate(config: config, ops: ops, store: store)
  }

  /// Shared connect → host-key gate → auth. Trust-on-first-use pins an unknown
  /// key and refuses a changed one. Tears the session down on any failure and
  /// leaves it authenticated on success.
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
