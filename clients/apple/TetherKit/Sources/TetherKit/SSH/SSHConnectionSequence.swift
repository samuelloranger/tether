import Foundation

/// Everything the connection sequence needs from one live SSH session. The
/// concrete implementation drives libssh2 on a dedicated thread; tests supply a
/// fake so the ordering, host-key gate, and teardown are verifiable without a host.
protocol SSHConnectionOps: AnyObject {
  /// Opens the socket, initialises the session, and performs the transport handshake.
  func connectAndHandshake() throws
  /// The server's host-key fingerprint, read after the handshake.
  func hostKeyFingerprint() throws -> String
  /// Attempts one credential. `true` = accepted, `false` = rejected (try next).
  /// A thrown error is a transport failure and aborts the whole attempt.
  func authenticate(_ credential: SSHCredential) throws -> Bool
  /// Opens an interactive PTY channel and wraps it as a byte stream.
  func openPTYChannel(cols: Int, rows: Int) throws -> any TerminalByteStream
  /// Runs a one-off command over an exec channel and returns its stdout.
  func exec(_ command: String) throws -> String
  /// Releases the channel, session, and socket. Must be safe to call after a
  /// partial connect and idempotent.
  func teardown()
}

struct SSHConnectionConfig: Equatable, Sendable {
  var host: String
  var port: Int
  var username: String
  var credentials: [SSHCredential]
  var cols: Int = 80
  var rows: Int = 24
}

enum SSHConnectError: Error, Equatable {
  case hostKeyMismatch(expected: String, got: String)
  case auth(SSHAuthError)
  case transport(String)
}

/// Runs the connect handshake as a straight-line sequence with a single failure
/// policy: any error after the socket is opened tears the session down before
/// surfacing. A host-key change is refused outright, never overridden.
enum SSHConnectionSequence {
  static func run(
    config: SSHConnectionConfig,
    ops: SSHConnectionOps,
    store: HostKeyStore
  ) throws -> any TerminalByteStream {
    do {
      try ops.connectAndHandshake()
    } catch {
      ops.teardown()
      throw SSHConnectError.transport("\(error)")
    }

    do {
      let fingerprint = try ops.hostKeyFingerprint()
      switch HostKeyVerifier.verify(fingerprint: fingerprint, host: config.host, port: config.port, store: store) {
      case .pinnedNew, .matched:
        break
      case let .mismatch(expected, got):
        ops.teardown()
        throw SSHConnectError.hostKeyMismatch(expected: expected, got: got)
      }

      _ = try authenticateInOrder(config.credentials) { try ops.authenticate($0) }

      return try ops.openPTYChannel(cols: config.cols, rows: config.rows)
    } catch let error as SSHConnectError {
      throw error
    } catch let error as SSHAuthError {
      ops.teardown()
      throw SSHConnectError.auth(error)
    } catch {
      ops.teardown()
      throw SSHConnectError.transport("\(error)")
    }
  }

  /// Same connect + host-key + auth gate as `run`, but executes a command and
  /// returns its output instead of opening a PTY. Always tears down.
  static func runExec(
    config: SSHConnectionConfig,
    ops: SSHConnectionOps,
    store: HostKeyStore,
    command: String
  ) throws -> String {
    do {
      try ops.connectAndHandshake()
    } catch {
      ops.teardown()
      throw SSHConnectError.transport("\(error)")
    }
    defer { ops.teardown() }
    do {
      let fingerprint = try ops.hostKeyFingerprint()
      if case let .mismatch(expected, got) = HostKeyVerifier.verify(
        fingerprint: fingerprint, host: config.host, port: config.port, store: store
      ) {
        throw SSHConnectError.hostKeyMismatch(expected: expected, got: got)
      }
      _ = try authenticateInOrder(config.credentials) { try ops.authenticate($0) }
      return try ops.exec(command)
    } catch let error as SSHConnectError {
      throw error
    } catch let error as SSHAuthError {
      throw SSHConnectError.auth(error)
    } catch {
      throw SSHConnectError.transport("\(error)")
    }
  }
}
