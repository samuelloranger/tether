import Darwin

/// A self-pipe the pump's poll() also watches, so input queued from another
/// thread ends the pump's sleep at once.
final class PumpWaker: @unchecked Sendable {
  private let readFD: Int32
  private let writeFD: Int32

  init() {
    var fds: [Int32] = [-1, -1]
    _ = pipe(&fds)
    readFD = fds[0]
    writeFD = fds[1]
    for fd in fds { _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) }
  }

  // Both ends close together, and only once nothing can call wake(): no SIGPIPE.
  deinit {
    Darwin.close(readFD)
    Darwin.close(writeFD)
  }

  /// A full pipe already means "awake", so a failed write is fine.
  func wake() {
    var byte: UInt8 = 1
    _ = Darwin.write(writeFD, &byte, 1)
  }

  func wait(socket: Int32, readable: Bool, writable: Bool, timeoutMs: Int) {
    var events: Int16 = 0
    if readable { events |= Int16(POLLIN) }
    if writable { events |= Int16(POLLOUT) }
    var fds = [
      pollfd(fd: socket, events: events, revents: 0),
      pollfd(fd: readFD, events: Int16(POLLIN), revents: 0),
    ]
    _ = poll(&fds, 2, Int32(clamping: timeoutMs))
    if fds[1].revents & Int16(POLLIN) != 0 { drain() }
  }

  /// POLLOUT means at least the send low-water mark (2 KB by default) is free,
  /// more than a keepalive or window-change packet, so either goes out whole.
  func socketWritable(_ socket: Int32) -> Bool {
    var fd = pollfd(fd: socket, events: Int16(POLLOUT), revents: 0)
    return poll(&fd, 1, 0) == 1 && fd.revents & Int16(POLLOUT) != 0
  }

  private func drain() {
    var scratch = [UInt8](repeating: 0, count: 64)
    while Darwin.read(readFD, &scratch, scratch.count) > 0 {}
  }
}
