import Foundation

/// The libssh2 calls the pump makes, one method each, so the loop's ordering
/// rules can be tested without a host. Returns are libssh2's: a byte count, 0,
/// or a negative error code.
protocol SSHPumpIO: AnyObject {
  func read(into buffer: UnsafeMutableRawBufferPointer) -> Int
  func write(_ bytes: UnsafeRawBufferPointer) -> Int
  func resize(cols: Int32, rows: Int32) -> Int
  func keepalive() -> (rc: Int, secondsToNext: Int)
  func isEOF() -> Bool
  /// The call just made left a packet half-sent.
  func blockedOutbound() -> Bool
  /// The socket can take a small packet whole right now.
  func canSendSmallPacket() -> Bool
  /// Sleeps until the socket is ready, the pump is woken, or the timeout ends.
  func wait(readable: Bool, writable: Bool, timeoutMs: Int)
}

/// One non-blocking pass at a time over an SSH PTY channel.
///
/// libssh2 keeps one half-sent outgoing packet. The next send of any kind
/// flushes it and then reports success for its own packet without sending it,
/// so once a call leaves one behind, only that call may run until it finishes.
/// A read counts: it can send a window adjust.
final class SSHPumpLoop {
  enum Outcome: Equatable {
    case running
    case ended(Reason)
  }

  enum Reason: Equatable {
    case stopped
    case eof
    case transport(Int)
  }

  enum Pending: Equatable {
    case write(length: Int)
    case flush
    case resize(cols: Int32, rows: Int32)
    case read
  }

  static let idleWaitMs = 1000
  private static let maxWrite = 32_700

  private(set) var pending: Pending?
  private var outbound = Data()
  private var queuedResize: (cols: Int32, rows: Int32)?
  private var buffer = [UInt8](repeating: 0, count: 32 * 1024)
  private let io: SSHPumpIO
  private let deliver: (Data) -> Void

  init(io: SSHPumpIO, deliver: @escaping (Data) -> Void) {
    self.io = io
    self.deliver = deliver
  }

  func enqueue(_ bytes: Data) { outbound.append(bytes) }
  func enqueueResize(cols: Int32, rows: Int32) { queuedResize = (cols, rows) }

  func pass(stopped: Bool) -> Outcome {
    if stopped { return .ended(.stopped) }
    if let pending { return finish(pending) }

    var progressed = false
    if let size = queuedResize, io.canSendSmallPacket() {
      queuedResize = nil
      if io.resize(cols: size.cols, rows: size.rows) == LibSSH2Const.eagain {
        return park(.resize(cols: size.cols, rows: size.rows))
      }
    }

    if !outbound.isEmpty {
      let length = min(outbound.count, Self.maxWrite)
      let rc = write(length: length)
      if rc > 0 {
        progressed = true
      } else if rc == LibSSH2Const.eagain {
        if io.blockedOutbound() { return park(.write(length: length)) }
      } else if rc < 0 {
        return .ended(.transport(rc))
      }
    }

    var sleepMs = Self.idleWaitMs
    if io.canSendSmallPacket() {
      let (rc, next) = io.keepalive()
      if rc < 0 { return .ended(.transport(rc)) }
      if io.blockedOutbound() { return park(.flush) }
      sleepMs = max(1, next) * 1000
    }

    let count = readOnce()
    if count > 0 {
      progressed = true
    } else if count == 0 {
      if io.isEOF() { return .ended(.eof) }
    } else if count == LibSSH2Const.eagain {
      if io.blockedOutbound() { return park(.read) }
    } else {
      return .ended(.transport(count))
    }

    if !progressed {
      io.wait(readable: true, writable: queuedResize != nil, timeoutMs: sleepMs)
    }
    return .running
  }

  private func finish(_ op: Pending) -> Outcome {
    let rc: Int
    switch op {
    case let .write(length): rc = write(length: length)
    case .flush: rc = flush()
    case let .resize(cols, rows): rc = io.resize(cols: cols, rows: rows)
    case .read: rc = readOnce()
    }
    if rc == LibSSH2Const.eagain, io.blockedOutbound() {
      io.wait(readable: op == .read, writable: true, timeoutMs: Self.idleWaitMs)
      return .running
    }
    pending = nil
    if case .resize = op { return .running }
    if op == .read, rc == 0, io.isEOF() { return .ended(.eof) }
    if rc < 0, rc != LibSSH2Const.eagain { return .ended(.transport(rc)) }
    return .running
  }

  private func park(_ op: Pending) -> Outcome {
    pending = op
    io.wait(readable: op == .read, writable: true, timeoutMs: Self.idleWaitMs)
    return .running
  }

  private func write(length: Int) -> Int {
    let rc = outbound.withUnsafeBytes { io.write(UnsafeRawBufferPointer(rebasing: $0.prefix(length))) }
    if rc > 0 { outbound.removeFirst(rc) }
    return rc
  }

  /// A zero-length channel write pushes out whatever packet is half-sent; the
  /// empty packet that gets dropped in its place carried nothing.
  private func flush() -> Int {
    var zero: UInt8 = 0
    return withUnsafeBytes(of: &zero) { io.write(UnsafeRawBufferPointer(rebasing: $0.prefix(0))) }
  }

  private func readOnce() -> Int {
    let count = buffer.withUnsafeMutableBytes { io.read(into: $0) }
    if count > 0 { deliver(Data(buffer[0..<count])) }
    return count
  }
}
