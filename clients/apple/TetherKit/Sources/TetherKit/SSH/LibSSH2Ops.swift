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
}

/// Concrete libssh2 implementation of the connect sequence. Owns the socket and
/// session until `openPTYChannel` hands them to the pump; `teardown` releases
/// whatever was created on an earlier failure.
final class LibSSH2Ops: SSHConnectionOps {
  private let config: SSHConnectionConfig
  private var socket: Int32 = -1
  private var session: OpaquePointer?
  private var transferred = false

  init(config: SSHConnectionConfig) {
    self.config = config
  }

  func connectAndHandshake() throws {
    LibSSH2Ops.initializeOnce()
    socket = try SocketDialer.open(host: config.host, port: config.port)
    guard let session = tether_libssh2_session_init() else { throw LibSSH2OpsError.sessionInit }
    self.session = session
    libssh2_session_set_blocking(session, 1)
    let rc = Int(libssh2_session_handshake(session, socket))
    guard rc == 0 else { throw LibSSH2OpsError.handshake(rc) }
  }

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
    let pump = SSHSessionPump(session: session, channel: channel, socket: socket)
    transferred = true
    return pump
  }

  func exec(_ command: String) throws -> String {
    guard let session else { throw LibSSH2OpsError.sessionInit }
    guard let channel = tether_libssh2_channel_open_session(session) else { throw LibSSH2OpsError.ptyOpenFailed }
    defer { libssh2_channel_free(channel) }
    let rc = command.withCString { tether_libssh2_channel_exec(channel, $0) }
    guard rc == 0 else { throw LibSSH2OpsError.execFailed(Int(rc)) }

    var output = Data()
    var buffer = [CChar](repeating: 0, count: 16 * 1024)
    while true {
      let count = buffer.withUnsafeMutableBufferPointer {
        LibSSH2TransportProbe.read(into: $0, from: channel)
      }
      if count > 0 {
        buffer.withUnsafeBytes { output.append($0.baseAddress!.assumingMemoryBound(to: UInt8.self), count: count) }
      } else if count == 0 {
        break
      } else if count == LibSSH2Const.eagain {
        continue
      } else {
        break
      }
    }
    return String(decoding: output, as: UTF8.self)
  }

  func execStream(_ command: String, onChunk: (String) -> Bool) throws {
    guard let session else { throw LibSSH2OpsError.sessionInit }
    guard let channel = tether_libssh2_channel_open_session(session) else { throw LibSSH2OpsError.ptyOpenFailed }
    defer { libssh2_channel_free(channel) }
    let rc = command.withCString { tether_libssh2_channel_exec(channel, $0) }
    guard rc == 0 else { throw LibSSH2OpsError.execFailed(Int(rc)) }

    var buffer = [CChar](repeating: 0, count: 16 * 1024)
    while true {
      let count = buffer.withUnsafeMutableBufferPointer {
        LibSSH2TransportProbe.read(into: $0, from: channel)
      }
      if count > 0 {
        let chunk = buffer.withUnsafeBytes {
          String(decoding: UnsafeRawBufferPointer(start: $0.baseAddress, count: count), as: UTF8.self)
        }
        if !onChunk(chunk) { break }
      } else if count == 0 {
        break
      } else if count == LibSSH2Const.eagain {
        continue
      } else {
        break
      }
    }
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
        } else if n == LibSSH2Const.eagain {
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
      Darwin.close(socket)
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
