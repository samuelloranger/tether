import Darwin
import Foundation

/// The only way another thread may touch a libssh2 socket: `shutdown()` makes
/// any call blocked on it return. The lock keeps that from racing the owner's
/// `close()`, after which the number may belong to a different connection.
final class SocketGuard: @unchecked Sendable {
  private let lock = NSLock()
  private var fd: Int32 = -1
  private var cut = false

  func adopt(_ descriptor: Int32) {
    lock.lock(); defer { lock.unlock() }
    fd = descriptor
    if cut { _ = Darwin.shutdown(descriptor, SHUT_RDWR) }
  }

  func shutdown() {
    lock.lock(); defer { lock.unlock() }
    cut = true
    if fd >= 0 { _ = Darwin.shutdown(fd, SHUT_RDWR) }
  }

  func close() {
    lock.lock(); defer { lock.unlock() }
    if fd >= 0 { Darwin.close(fd); fd = -1 }
  }
}
