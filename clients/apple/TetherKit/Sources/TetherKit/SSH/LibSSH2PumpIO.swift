import CLibSSH2
import Foundation

/// `SSHPumpIO` over a non-blocking libssh2 session. Used only on the pump's thread.
final class LibSSH2PumpIO: SSHPumpIO {
  private let session: OpaquePointer
  private let channel: OpaquePointer
  private let socket: Int32
  private let waker: PumpWaker

  init(session: OpaquePointer, channel: OpaquePointer, socket: Int32, waker: PumpWaker) {
    self.session = session
    self.channel = channel
    self.socket = socket
    self.waker = waker
  }

  func read(into buffer: UnsafeMutableRawBufferPointer) -> Int {
    // Asking for more than the window makes read_ex send its own adjust and
    // drop that adjust's EAGAIN; within the window, the adjust is resumable.
    let window = Int(libssh2_channel_window_read_ex(channel, nil, nil))
    let length = min(buffer.count, max(window, 1))
    return tether_libssh2_channel_read(channel, buffer.baseAddress?.assumingMemoryBound(to: CChar.self), length)
  }

  func write(_ bytes: UnsafeRawBufferPointer) -> Int {
    tether_libssh2_channel_write(channel, bytes.baseAddress?.assumingMemoryBound(to: CChar.self), bytes.count)
  }

  func resize(cols: Int32, rows: Int32) -> Int {
    Int(tether_libssh2_channel_request_pty_size(channel, cols, rows))
  }

  func keepalive() -> (rc: Int, secondsToNext: Int) {
    var next: Int32 = 0
    let rc = libssh2_keepalive_send(session, &next)
    return (Int(rc), Int(next))
  }

  func isEOF() -> Bool { libssh2_channel_eof(channel) == 1 }

  func blockedOutbound() -> Bool {
    libssh2_session_block_directions(session) & LibSSH2Const.blockOutbound != 0
  }

  func canSendSmallPacket() -> Bool { waker.socketWritable(socket) }

  func wait(readable: Bool, writable: Bool, timeoutMs: Int) {
    waker.wait(socket: socket, readable: readable, writable: writable, timeoutMs: timeoutMs)
  }
}
