import Darwin
import Foundation

/// Resolves and dials a TCP connection for libssh2, with the socket options
/// that let a dead path fail instead of hanging.
enum SocketDialer {
  static func open(
    host: String,
    port: Int,
    connectTimeout: Int32 = SSHTimeouts.connectSeconds
  ) throws -> Int32 {
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
        tune(fd, connectTimeout: connectTimeout)
        if Darwin.connect(fd, current.pointee.ai_addr, current.pointee.ai_addrlen) == 0 {
          return fd
        }
        Darwin.close(fd)
      }
      node = current.pointee.ai_next
    }
    throw LibSSH2OpsError.socket("connect failed for \(host):\(port)")
  }

  static func tune(_ fd: Int32, connectTimeout: Int32 = SSHTimeouts.connectSeconds) {
    set(fd, SOL_SOCKET, SO_NOSIGPIPE, 1)
    set(fd, SOL_SOCKET, SO_KEEPALIVE, 1)
    set(fd, IPPROTO_TCP, TCP_NODELAY, 1)
    set(fd, IPPROTO_TCP, TCP_KEEPALIVE, SSHTimeouts.tcpKeepIdleSeconds)
    set(fd, IPPROTO_TCP, TCP_KEEPINTVL, SSHTimeouts.tcpKeepIntervalSeconds)
    set(fd, IPPROTO_TCP, TCP_KEEPCNT, SSHTimeouts.tcpKeepCount)
    set(fd, IPPROTO_TCP, TCP_RXT_CONNDROPTIME, SSHTimeouts.retransmitDropSeconds)
    set(fd, IPPROTO_TCP, TCP_CONNECTIONTIMEOUT, connectTimeout)
  }

  private static func set(_ fd: Int32, _ level: Int32, _ name: Int32, _ value: Int32) {
    var value = value
    _ = setsockopt(fd, level, name, &value, socklen_t(MemoryLayout<Int32>.size))
  }
}
