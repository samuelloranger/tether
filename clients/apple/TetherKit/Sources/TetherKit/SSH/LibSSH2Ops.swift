import CLibSSH2
import Darwin
import Foundation

enum LibSSH2OpsError: Error, Equatable {
  case socket(String)
  case sessionInit
  case handshake(Int)
  case hostKeyUnavailable
  case authError(Int)
  case ptyOpenFailed
  case execFailed(Int)
  case scpOpenFailed
  case scpWriteFailed(Int)
  case readFailed(Int)
}

/// Concrete libssh2 implementation of the connect sequence. Owns the socket and
/// session until `openPTYChannel` hands them to the pump; `teardown` releases
/// whatever was created on an earlier failure.
final class LibSSH2Ops: SSHConnectionOps, @unchecked Sendable {
  private let config: SSHConnectionConfig
  private let operationTimeoutMs: Int
  private let commandDeadline: TimeInterval
  private let socketGuard = SocketGuard()
  private var socket: Int32 = -1
  private var session: OpaquePointer?
  private var transferred = false

  init(
    config: SSHConnectionConfig,
    operationTimeoutMs: Int = SSHTimeouts.operationMs,
    commandDeadline: TimeInterval = SSHTimeouts.commandSeconds
  ) {
    self.config = config
    self.operationTimeoutMs = operationTimeoutMs
    self.commandDeadline = commandDeadline
  }

  func connectAndHandshake() throws {
    LibSSH2Ops.initializeOnce()
    socket = try SocketDialer.open(host: config.host, port: config.port, socketGuard: socketGuard)
    guard let session = tether_libssh2_session_init() else { throw LibSSH2OpsError.sessionInit }
    self.session = session
    libssh2_session_set_blocking(session, 1)
    libssh2_session_set_timeout(session, operationTimeoutMs)
    let rc = Int(libssh2_session_handshake(session, socket))
    guard rc == 0 else { throw LibSSH2OpsError.handshake(rc) }
  }

  func interrupt() { socketGuard.shutdown() }

  func hostKeyFingerprint() throws -> String {
    guard let session, let raw = libssh2_hostkey_hash(session, LibSSH2Const.hostKeyHashSHA256) else {
      throw LibSSH2OpsError.hostKeyUnavailable
    }
    let bytes = UnsafeRawPointer(raw).assumingMemoryBound(to: UInt8.self)
    return (0..<32).map { String(format: "%02x", bytes[$0]) }.joined(separator: ":")
  }

  func authenticate(_ credential: SSHCredential) throws -> Bool {
    guard let session else { throw LibSSH2OpsError.sessionInit }
    let rc: Int32
    switch credential {
    case let .password(password):
      rc = Int32(tether_libssh2_userauth_password(session, config.username, password))
    case let .privateKey(pem, passphrase):
      rc = LibSSH2Ops.authPublicKey(session: session, username: config.username, pem: pem, passphrase: passphrase)
    }
    if rc == 0 {
      lastAuthDetail = nil
      // Only now: a keepalive is a global request, and OpenSSH's strict key
      // exchange drops a connection that sends one before the session is up.
      libssh2_keepalive_config(session, 1, SSHTimeouts.keepaliveSeconds)
      return true
    }
    lastAuthDetail = LibSSH2Ops.lastError(session: session, rc: rc)
    if rc == LibSSH2Const.authenticationFailed || rc == LibSSH2Const.publickeyUnverified {
      return false
    }
    throw LibSSH2OpsError.authError(Int(rc))
  }

  private(set) var lastAuthDetail: String?

  private static func lastError(session: OpaquePointer, rc: Int32) -> String {
    var message: UnsafeMutablePointer<CChar>?
    var length: Int32 = 0
    _ = libssh2_session_last_error(session, &message, &length, 0)
    guard let message, length > 0 else { return "libssh2 error \(rc)" }
    return "\(String(cString: message)) (libssh2 \(rc))"
  }

  func openPTYChannel(cols: Int, rows: Int) throws -> any TerminalByteStream {
    guard let session else { throw LibSSH2OpsError.sessionInit }
    guard let channel = LibSSH2TransportProbe.openInteractiveChannel(
      session: session, columns: Int32(cols), rows: Int32(rows)
    ) else {
      throw LibSSH2OpsError.ptyOpenFailed
    }
    let pump = SSHSessionPump(session: session, channel: channel, socket: socket, socketGuard: socketGuard)
    transferred = true
    return pump
  }

  func exec(_ command: String) throws -> String {
    var output = Data()
    try runCommand(command, deadline: commandDeadline) { chunk in
      output.append(contentsOf: chunk)
      return true
    }
    return String(decoding: output, as: UTF8.self)
  }

  func execStream(_ command: String, onChunk: (String) -> Bool) throws {
    try runCommand(command, deadline: nil) { onChunk(String(decoding: $0, as: UTF8.self)) }
  }

  private func runCommand(
    _ command: String, deadline: TimeInterval?, onChunk: (UnsafeRawBufferPointer) -> Bool
  ) throws {
    guard let session else { throw LibSSH2OpsError.sessionInit }
    guard let channel = tether_libssh2_channel_open_session(session) else { throw LibSSH2OpsError.ptyOpenFailed }
    defer { libssh2_channel_free(channel) }
    // Unread stderr still spends the channel window; once it is gone the host
    // stops sending stdout too.
    _ = libssh2_channel_handle_extended_data2(channel, LIBSSH2_CHANNEL_EXTENDED_DATA_IGNORE)
    let rc = command.withCString { tether_libssh2_channel_exec(channel, $0) }
    guard rc == 0 else { throw LibSSH2OpsError.execFailed(Int(rc)) }
    try ExecReader.run(
      read: { LibSSH2TransportProbe.read(into: $0, from: channel) },
      now: { ProcessInfo.processInfo.systemUptime },
      deadline: deadline,
      onChunk: onChunk)
  }

  func scpSend(data: Data, remotePath: String, mode: Int32) throws {
    guard let session else { throw LibSSH2OpsError.sessionInit }
    guard let channel = remotePath.withCString({
      tether_libssh2_scp_send(session, $0, mode, data.count)
    }) else {
      throw LibSSH2OpsError.scpOpenFailed
    }
    defer { libssh2_channel_free(channel) }
    try data.withUnsafeBytes { raw in
      guard let base = raw.baseAddress?.assumingMemoryBound(to: CChar.self) else { return }
      var offset = 0
      while offset < data.count {
        let n = tether_libssh2_channel_write(channel, base.advanced(by: offset), data.count - offset)
        if n > 0 {
          offset += n
        } else if n == LibSSH2Const.eagain || n == LibSSH2Const.timeout {
          // A slow uplink, not a dead one: the kernel's retransmit drop ends that.
          continue
        } else {
          throw LibSSH2OpsError.scpWriteFailed(Int(n))
        }
      }
    }
    _ = libssh2_channel_send_eof(channel)
    _ = libssh2_channel_wait_eof(channel)
    _ = libssh2_channel_wait_closed(channel)
  }

  func teardown() {
    guard !transferred else { return }
    if let session {
      tether_libssh2_session_disconnect(session, "tether aborted")
      libssh2_session_free(session)
      self.session = nil
    }
    if socket >= 0 {
      socketGuard.close()
      socket = -1
    }
  }

  private static let initOnce: Void = { _ = libssh2_init(0) }()
  private static func initializeOnce() { _ = initOnce }

  private static func authPublicKey(session: OpaquePointer, username: String, pem: String, passphrase: String?) -> Int32 {
    let priv = Array(pem.utf8)
    let pass = passphrase ?? ""
    return username.withCString { user in
      pass.withCString { passPtr in
        priv.withUnsafeBytes { keyBuf in
          libssh2_userauth_publickey_frommemory(
            session,
            user, username.utf8.count,
            nil, 0,
            keyBuf.baseAddress?.assumingMemoryBound(to: CChar.self), priv.count,
            passPtr
          )
        }
      }
    }
  }
}
