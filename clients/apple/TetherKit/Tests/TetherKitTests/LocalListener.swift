import Darwin
import Foundation

/// A loopback TCP listener that never accepts: the kernel completes the TCP
/// handshake from the backlog and then nothing speaks, which is exactly what a
/// peer on a silently dead path looks like.
final class LocalListener {
  private(set) var fd: Int32
  let port: Int

  init() throws {
    fd = socket(AF_INET, SOCK_STREAM, 0)
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard bound == 0, listen(fd, 8) == 0 else { throw POSIXError(.EADDRINUSE) }
    var out = sockaddr_in()
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &out) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
    }
    port = Int(UInt16(bigEndian: out.sin_port))
  }

  func close() {
    if fd >= 0 { Darwin.close(fd); fd = -1 }
  }

  /// A port nothing listens on, so a dial is refused at once.
  static func unusedPort() throws -> Int {
    let listener = try LocalListener()
    let port = listener.port
    listener.close()
    return port
  }
}
