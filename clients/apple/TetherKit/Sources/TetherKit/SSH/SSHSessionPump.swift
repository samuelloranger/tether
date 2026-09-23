import CLibSSH2
import Darwin
import Foundation

/// One libssh2 session on a dedicated thread (sessions are not thread-safe), polling
/// the socket and a wake pipe so queued input goes out at once and idle sessions sleep.
final class SSHSessionPump: TerminalByteStream, @unchecked Sendable {
  private let session: OpaquePointer
  private let channel: OpaquePointer
  private let socket: Int32
  private let socketGuard: SocketGuard
  private let waker = PumpWaker()

  private let lock = NSLock()
  private var outbound: [Data] = []
  private var pendingResize: (cols: Int32, rows: Int32)?
  private var stopped = false

  private let inbound: AsyncStream<Data>
  private let sink: AsyncStream<Data>.Continuation
  private var iterator: AsyncStream<Data>.AsyncIterator

  init(session: OpaquePointer, channel: OpaquePointer, socket: Int32, socketGuard: SocketGuard) {
    self.session = session
    self.channel = channel
    self.socket = socket
    self.socketGuard = socketGuard
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
    waker.wake()
  }

  func resize(cols: UInt16, rows: UInt16) async {
    lock.lock()
    pendingResize = (Int32(cols), Int32(rows))
    lock.unlock()
    waker.wake()
  }

  func close() async {
    lock.lock()
    stopped = true
    lock.unlock()
    waker.wake()
  }

  private func pump() {
    libssh2_session_set_blocking(session, 0)
    let io = LibSSH2PumpIO(session: session, channel: channel, socket: socket, waker: waker)
    let loop = SSHPumpLoop(io: io) { [sink] data in _ = sink.yield(data) }
    while true {
      lock.lock()
      let done = stopped
      let chunks = outbound
      outbound.removeAll(keepingCapacity: true)
      let resize = pendingResize
      pendingResize = nil
      lock.unlock()

      for chunk in chunks { loop.enqueue(chunk) }
      if let resize { loop.enqueueResize(cols: resize.cols, rows: resize.rows) }
      if case .ended = loop.pass(stopped: done) { break }
    }
    // A half-sent packet would swallow the channel close teardown sends, then
    // each wait out its timeout; a shut socket makes those sends fail at once.
    if loop.pending != nil { socketGuard.shutdown() }
    teardownAndFinish()
  }

  private func teardownAndFinish() {
    // Freeing the channel and disconnecting both send: blocking again, with a
    // short bound so a dead socket cannot hold the thread.
    libssh2_session_set_blocking(session, 1)
    libssh2_session_set_timeout(session, 1000)
    libssh2_channel_free(channel)
    tether_libssh2_session_disconnect(session, "tether closing")
    libssh2_session_free(session)
    socketGuard.close()
    sink.finish()
  }
}
