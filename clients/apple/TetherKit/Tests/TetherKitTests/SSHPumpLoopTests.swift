import XCTest
@testable import TetherKit

/// Records every libssh2 call the pump makes; each call's result is scripted,
/// including whether it left a packet half-sent.
private final class FakePumpIO: SSHPumpIO {
  struct Result {
    var rc: Int
    var halfSent = false
  }

  var log: [String] = []
  var reads: [Result] = []
  var writes: [Result] = []
  var resizes: [Result] = []
  var keepalives: [Result] = []
  var eof = false
  var roomForSmallPacket = true
  /// When set, each write accepts at most this many bytes.
  var writeLimit: Int?
  private(set) var written = Data()
  private var lastHalfSent = false

  func read(into buffer: UnsafeMutableRawBufferPointer) -> Int {
    log.append("read")
    let result = reads.isEmpty ? Result(rc: LibSSH2Const.eagain) : reads.removeFirst()
    if result.rc > 0 { for index in 0..<result.rc { buffer[index] = UInt8(ascii: "x") } }
    lastHalfSent = result.halfSent
    return result.rc
  }

  func write(_ bytes: UnsafeRawBufferPointer) -> Int {
    log.append("write(\(bytes.count))")
    let result = writes.isEmpty ? Result(rc: min(bytes.count, writeLimit ?? bytes.count)) : writes.removeFirst()
    if result.rc > 0 { written.append(contentsOf: bytes.prefix(result.rc)) }
    lastHalfSent = result.halfSent
    return result.rc
  }

  func resize(cols: Int32, rows: Int32) -> Int {
    log.append("resize(\(cols)x\(rows))")
    let result = resizes.isEmpty ? Result(rc: 0) : resizes.removeFirst()
    lastHalfSent = result.halfSent
    return result.rc
  }

  func keepalive() -> (rc: Int, secondsToNext: Int) {
    log.append("keepalive")
    let result = keepalives.isEmpty ? Result(rc: 0) : keepalives.removeFirst()
    lastHalfSent = result.halfSent
    return (result.rc, 15)
  }

  func isEOF() -> Bool { eof }
  func blockedOutbound() -> Bool { lastHalfSent }
  func canSendSmallPacket() -> Bool { roomForSmallPacket }

  func wait(readable: Bool, writable: Bool, timeoutMs: Int) {
    log.append("wait(\(readable ? "r" : "")\(writable ? "w" : ""),\(timeoutMs))")
  }
}

final class SSHPumpLoopTests: XCTestCase {
  private var io: FakePumpIO!
  private var delivered: Data!
  private var loop: SSHPumpLoop!

  override func setUp() {
    io = FakePumpIO()
    delivered = Data()
    loop = SSHPumpLoop(io: io) { [unowned self] in self.delivered.append($0) }
  }

  private func freshPass(stopped: Bool = false) -> SSHPumpLoop.Outcome {
    io.log = []
    return loop.pass(stopped: stopped)
  }

  // MARK: latency and idle cost

  func test_queued_input_goes_out_before_the_read() {
    loop.enqueue(Data("ls\n".utf8))

    XCTAssertEqual(freshPass(), .running)
    XCTAssertEqual(io.log, ["write(3)", "keepalive", "read"])
  }

  func test_an_idle_pass_sleeps_until_the_keepalive_is_due() {
    XCTAssertEqual(freshPass(), .running)
    XCTAssertEqual(io.log, ["keepalive", "read", "wait(r,15000)"])
  }

  func test_arriving_bytes_are_delivered_and_the_pass_does_not_sleep() {
    io.reads = [.init(rc: 4)]

    _ = freshPass()

    XCTAssertEqual(delivered, Data("xxxx".utf8))
    XCTAssertEqual(io.log, ["keepalive", "read"])
  }

  func test_a_partial_write_keeps_the_rest_for_the_next_pass() {
    io.writes = [.init(rc: 2)]
    loop.enqueue(Data("hello".utf8))

    _ = freshPass()
    _ = freshPass()

    XCTAssertEqual(io.log.first, "write(3)")
  }

  func test_a_large_paste_arrives_whole_and_in_order_through_partial_writes() {
    let paste = Data((0..<3_000_000).map { UInt8(truncatingIfNeeded: $0 &* 31) })
    io.writeLimit = 7_001
    loop.enqueue(paste.prefix(1_000_000))

    for pass in 0..<1_000 {
      if pass == 10 { loop.enqueue(paste.dropFirst(1_000_000)) }
      _ = loop.pass(stopped: false)
      if io.written.count == paste.count { break }
    }

    XCTAssertEqual(io.written, paste)
  }

  // MARK: the half-sent packet rule

  func test_a_half_sent_write_is_finished_before_any_other_call() {
    io.writes = [.init(rc: LibSSH2Const.eagain, halfSent: true), .init(rc: 3)]
    loop.enqueue(Data("ls\n".utf8))

    _ = freshPass()
    XCTAssertEqual(io.log, ["write(3)", "wait(w,1000)"])
    XCTAssertEqual(loop.pending, .write(length: 3))

    loop.enqueueResize(cols: 100, rows: 40)
    loop.enqueue(Data("x".utf8))
    _ = freshPass()
    XCTAssertEqual(io.log, ["write(3)"], "the retry must repeat the same call with the same length, alone")

    _ = freshPass()
    XCTAssertEqual(io.log, ["resize(100x40)", "write(1)", "keepalive", "read"])
  }

  func test_a_read_that_half_sent_a_window_adjust_blocks_writes_until_it_finishes() {
    io.reads = [.init(rc: LibSSH2Const.eagain, halfSent: true), .init(rc: LibSSH2Const.eagain)]

    _ = freshPass()
    XCTAssertEqual(io.log, ["keepalive", "read", "wait(rw,1000)"])

    loop.enqueue(Data("a".utf8))
    _ = freshPass()
    XCTAssertEqual(io.log, ["read"])

    _ = freshPass()
    XCTAssertEqual(io.log, ["write(1)", "keepalive", "read"])
  }

  func test_a_half_sent_keepalive_is_flushed_by_an_empty_write_before_real_input() {
    io.keepalives = [.init(rc: 0, halfSent: true)]

    _ = freshPass()
    XCTAssertEqual(io.log, ["keepalive", "wait(w,1000)"])

    loop.enqueue(Data("a".utf8))
    _ = freshPass()
    XCTAssertEqual(io.log, ["write(0)"])

    _ = freshPass()
    XCTAssertEqual(io.log, ["write(1)", "keepalive", "read"])
  }

  func test_a_half_sent_resize_is_resent_with_the_same_size() {
    io.resizes = [.init(rc: LibSSH2Const.eagain, halfSent: true)]
    loop.enqueueResize(cols: 80, rows: 24)

    _ = freshPass()
    loop.enqueueResize(cols: 90, rows: 30)
    _ = freshPass()

    XCTAssertEqual(io.log, ["resize(80x24)"])
    _ = freshPass()
    XCTAssertEqual(io.log.first, "resize(90x30)")
  }

  // MARK: small packets wait for room

  func test_a_keepalive_waits_for_room_on_the_socket() {
    io.roomForSmallPacket = false

    _ = freshPass()

    XCTAssertEqual(io.log, ["read", "wait(r,1000)"])
  }

  func test_a_resize_waits_for_room_then_goes_out() {
    io.roomForSmallPacket = false
    loop.enqueueResize(cols: 80, rows: 24)

    _ = freshPass()
    XCTAssertEqual(io.log, ["read", "wait(rw,1000)"])

    io.roomForSmallPacket = true
    _ = freshPass()
    XCTAssertEqual(io.log, ["resize(80x24)", "keepalive", "read", "wait(r,15000)"])
  }

  // MARK: ending

  func test_stop_ends_the_pump_without_touching_the_session_even_mid_write() {
    io.writes = [.init(rc: LibSSH2Const.eagain, halfSent: true)]
    loop.enqueue(Data("paste".utf8))
    _ = freshPass()

    XCTAssertEqual(freshPass(stopped: true), .ended(.stopped))
    XCTAssertEqual(io.log, [])
  }

  func test_a_read_error_ends_the_pump() {
    io.reads = [.init(rc: -43)]
    XCTAssertEqual(freshPass(), .ended(.transport(-43)))
  }

  func test_a_write_error_ends_the_pump() {
    io.writes = [.init(rc: -7)]
    loop.enqueue(Data("a".utf8))
    XCTAssertEqual(freshPass(), .ended(.transport(-7)))
  }

  func test_a_failed_keepalive_ends_the_pump() {
    io.keepalives = [.init(rc: -7)]
    XCTAssertEqual(freshPass(), .ended(.transport(-7)))
  }

  func test_end_of_file_ends_the_pump() {
    io.reads = [.init(rc: 0)]
    io.eof = true
    XCTAssertEqual(freshPass(), .ended(.eof))
  }

  func test_zero_bytes_without_end_of_file_keeps_running() {
    io.reads = [.init(rc: 0)]
    XCTAssertEqual(freshPass(), .running)
  }
}
