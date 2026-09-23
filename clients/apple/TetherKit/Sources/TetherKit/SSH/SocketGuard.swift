import Darwin
import Foundation

/// `shutdown()` is the only cross-thread touch; the lock stops it racing the owner's `close()`,
/// after which the fd number may belong to a different connection.
final class SocketGuard: @unchecked Sendable {
  private let lock = NSLock()
  private var fd: Int32 = -1
  private var cut = false

  var isCut: Bool {
    lock.lock(); defer { lock.unlock() }
    return cut
  }

  /// False once cut: shutdown() does nothing to a socket that has not
  /// connected, so a dial must not carry on with it.
  func adopt(_ descriptor: Int32) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard !cut else { return false }
    fd = descriptor
    return true
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
