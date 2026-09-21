import CLibSSH2
import Darwin
import Foundation

/// Drives one authenticated libssh2 session on a dedicated thread (sessions are
/// not thread-safe). Each pass drains queued input, then reads with a short
/// timeout, so a blocked read never starves outgoing keystrokes. Owns the
/// channel, session, and socket and frees all three when the loop exits.
final class SSHSessionPump: TerminalByteStream, @unchecked Sendable {
  private let session: OpaquePointer
  private let channel: OpaquePointer
  private let socket: Int32

  private let lock = NSLock()
  private var outbound: [Data] = []
  private var pendingResize: (cols: Int32, rows: Int32)?
  private var stopped = false

  private let inbound: AsyncStream<Data>
  private let sink: AsyncStream<Data>.Continuation
  private var iterator: AsyncStream<Data>.AsyncIterator

  private static let readTimeoutMs = 30

  init(session: OpaquePointer, channel: OpaquePointer, socket: Int32) {
    self.session = session
    self.channel = channel
    self.socket = socket
    var continuation: AsyncStream<Data>.Continuation!
    self.inbound = AsyncStream(bufferingPolicy: .unbounded) { continuation = $0 }
    self.sink = continuation
    self.iterator = inbound.makeAsyncIterator()

    let thread = Thread { [weak self] in self?.pump() }
    thread.name = "tether.ssh.pump"
    thread.stackSize = 512 * 1024
    thread.start()
  }

  // Single-consumer: only the pipeline's SSH read loop calls this, serially.
  func read() async -> Data? { await iterator.next() }

  func write(_ bytes: Data) async {
    guard !bytes.isEmpty else { return }
    lock.lock()
    outbound.append(bytes)
    lock.unlock()
  }

  func resize(cols: UInt16, rows: UInt16) async {
    lock.lock()
    pendingResize = (Int32(cols), Int32(rows))
    lock.unlock()
  }

  func close() async {
    lock.lock()
    stopped = true
    lock.unlock()
  }

  private func pump() {
    libssh2_session_set_timeout(session, Self.readTimeoutMs)
    var buffer = [CChar](repeating: 0, count: 32 * 1024)

    while true {
      lock.lock()
      let done = stopped
      let pending = outbound
      outbound.removeAll(keepingCapacity: true)
      let resize = pendingResize
      pendingResize = nil
      lock.unlock()
      if done { break }

      if let resize {
        _ = tether_libssh2_channel_request_pty_size(channel, resize.cols, resize.rows)
      }
      for chunk in pending where !drain(chunk) { return teardownAndFinish() }

      let count = buffer.withUnsafeMutableBufferPointer {
        LibSSH2TransportProbe.read(into: $0, from: channel)
      }
      if count > 0 {
        let data = buffer.withUnsafeBytes { Data(bytes: $0.baseAddress!, count: count) }
        sink.yield(data)
      } else if count == 0 {
        if libssh2_channel_eof(channel) == 1 { break }
      } else if count == LibSSH2Const.timeout || count == LibSSH2Const.eagain {
        continue
      } else {
        break
      }
    }
    teardownAndFinish()
  }

  private func drain(_ chunk: Data) -> Bool {
    var offset = 0
    return chunk.withUnsafeBytes { raw -> Bool in
      let base = raw.baseAddress!.assumingMemoryBound(to: CChar.self)
      while offset < chunk.count {
        let written = tether_libssh2_channel_write(channel, base.advanced(by: offset), chunk.count - offset)
        if written > 0 {
          offset += written
        } else if written == LibSSH2Const.timeout || written == LibSSH2Const.eagain {
          continue
        } else {
          return false
        }
      }
      return true
    }
  }

  private func teardownAndFinish() {
    libssh2_channel_free(channel)
    tether_libssh2_session_disconnect(session, "tether closing")
    libssh2_session_free(session)
    Darwin.close(socket)
    sink.finish()
  }
}
