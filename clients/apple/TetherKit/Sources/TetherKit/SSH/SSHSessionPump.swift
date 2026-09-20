import CLibSSH2
import Darwin
import Foundation

/// Drives one authenticated libssh2 session on a dedicated thread.
///
/// libssh2 sessions are not thread-safe, so every call on `session`/`channel`
/// happens on this one thread. The loop is bounded-blocking: each pass drains
/// queued terminal input, then reads with a short session timeout, so a blocked
/// read never starves outgoing keystrokes. Input latency is at most the timeout.
///
/// Ownership: the pump owns the channel, session, and socket and releases all
/// three when the loop exits (`close()`, EOF, or a fatal read). The connector
/// hands them over on success and never frees them itself.
final class SSHSessionPump: TerminalByteStream, @unchecked Sendable {
  private let session: OpaquePointer
  private let channel: OpaquePointer
  private let socket: Int32

  private let lock = NSLock()
  private var outbound: [Data] = []
  private var stopped = false

  private let inbound: AsyncStream<Data>
  private let sink: AsyncStream<Data>.Continuation
  private var iterator: AsyncStream<Data>.AsyncIterator

  /// Milliseconds a read may block before the loop cycles back to drain input.
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
  func read() async -> Data? {
    await iterator.next()
  }

  func write(_ bytes: Data) async {
    guard !bytes.isEmpty else { return }
    lock.lock()
    outbound.append(bytes)
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
      lock.unlock()
      if done { break }

      for chunk in pending where !drain(chunk) { return teardownAndFinish() }

      let count = buffer.withUnsafeMutableBufferPointer {
        LibSSH2TransportProbe.read(into: $0, from: channel)
      }
      if count > 0 {
        sink.yield(Data(buffer.prefix(count).map(UInt8.init(bitPattern:))))
      } else if count == 0 {
        if libssh2_channel_eof(channel) == 1 { break }
      } else if count == LIBSSH2_ERROR_TIMEOUT || count == LIBSSH2_ERROR_EAGAIN {
        continue // no data this window; loop to re-drain input and read again
      } else {
        break // fatal transport error
      }
    }
    teardownAndFinish()
  }

  /// Writes one chunk fully, tolerating partial writes and short timeouts.
  /// Returns false on a fatal write error.
  private func drain(_ chunk: Data) -> Bool {
    var offset = 0
    return chunk.withUnsafeBytes { raw -> Bool in
      let base = raw.baseAddress!.assumingMemoryBound(to: CChar.self)
      while offset < chunk.count {
        let written = tether_libssh2_channel_write(channel, base.advanced(by: offset), chunk.count - offset)
        if written > 0 {
          offset += written
        } else if written == LIBSSH2_ERROR_TIMEOUT || written == LIBSSH2_ERROR_EAGAIN {
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

private let LIBSSH2_ERROR_TIMEOUT: Int = -9
private let LIBSSH2_ERROR_EAGAIN: Int = -37
