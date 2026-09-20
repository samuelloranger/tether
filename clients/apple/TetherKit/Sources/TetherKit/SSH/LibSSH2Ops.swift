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
}

/// Concrete libssh2 implementation of the connect sequence's operations.
///
/// It owns the socket and session until `openPTYChannel` hands them to the pump;
/// on any earlier failure the sequence calls `teardown`, which releases whatever
/// was created. Not thread-confined itself — the sequence runs it on the
/// connector's dedicated thread, matching where the pump will run.
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
    socket = try LibSSH2Ops.openSocket(host: config.host, port: config.port)
    guard let session = tether_libssh2_session_init() else { throw LibSSH2OpsError.sessionInit }
    self.session = session
    libssh2_session_set_blocking(session, 1)
    let rc = Int(libssh2_session_handshake(session, socket))
    guard rc == 0 else { throw LibSSH2OpsError.handshake(rc) }
  }

  func hostKeyFingerprint() throws -> String {
    guard let session, let raw = libssh2_hostkey_hash(session, LIBSSH2_HOSTKEY_HASH_SHA256) else {
      throw LibSSH2OpsError.hostKeyUnavailable
    }
    // SHA-256 digest is 32 raw bytes, not NUL-terminated.
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
    if rc == 0 { return true }
    if rc == LIBSSH2_ERROR_AUTHENTICATION_FAILED || rc == LIBSSH2_ERROR_PUBLICKEY_UNVERIFIED {
      return false // rejected credential, try the next one
    }
    throw LibSSH2OpsError.authError(Int(rc))
  }

  func openPTYChannel(cols: Int, rows: Int) throws -> any TerminalByteStream {
    guard let session else { throw LibSSH2OpsError.sessionInit }
    guard let channel = LibSSH2TransportProbe.openInteractiveChannel(
      session: session, columns: Int32(cols), rows: Int32(rows)
    ) else {
      throw LibSSH2OpsError.ptyOpenFailed
    }
    let pump = SSHSessionPump(session: session, channel: channel, socket: socket)
    transferred = true // pump now owns session/channel/socket
    return pump
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

  // MARK: - libssh2 helpers

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
            nil, 0, // derive the public key from the private key
            keyBuf.baseAddress?.assumingMemoryBound(to: CChar.self), priv.count,
            passPtr
          )
        }
      }
    }
  }

  private static func openSocket(host: String, port: Int) throws -> Int32 {
    var hints = addrinfo(
      ai_flags: 0, ai_family: AF_UNSPEC, ai_socktype: SOCK_STREAM,
      ai_protocol: 0, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil
    )
    var result: UnsafeMutablePointer<addrinfo>?
    let status = getaddrinfo(host, String(port), &hints, &result)
    guard status == 0, let list = result else {
      throw LibSSH2OpsError.socket("resolve failed for \(host):\(port)")
    }
    defer { freeaddrinfo(list) }

    var node: UnsafeMutablePointer<addrinfo>? = list
    while let current = node {
      let fd = Darwin.socket(current.pointee.ai_family, current.pointee.ai_socktype, current.pointee.ai_protocol)
      if fd >= 0 {
        if Darwin.connect(fd, current.pointee.ai_addr, current.pointee.ai_addrlen) == 0 {
          return fd
        }
        Darwin.close(fd)
      }
      node = current.pointee.ai_next
    }
    throw LibSSH2OpsError.socket("connect failed for \(host):\(port)")
  }
}

private let LIBSSH2_HOSTKEY_HASH_SHA256: Int32 = 3
private let LIBSSH2_ERROR_AUTHENTICATION_FAILED: Int32 = -18
private let LIBSSH2_ERROR_PUBLICKEY_UNVERIFIED: Int32 = -19
