import Darwin
import XCTest
@testable import TetherKit

/// Queued input must end the pump's sleep at once. Before this, a keystroke
/// waited for a read timeout that libssh2 rounds up to the next whole second.
final class PumpWakerTests: XCTestCase {
  private func pair() -> (Int32, Int32) {
    var fds: [Int32] = [-1, -1]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
    return (fds[0], fds[1])
  }

  private func elapsed(_ body: () -> Void) -> TimeInterval {
    let start = Date()
    body()
    return Date().timeIntervalSince(start)
  }

  func test_a_wake_from_another_thread_ends_the_wait_at_once() {
    let waker = PumpWaker()
    let (mine, peer) = pair()
    defer { close(mine); close(peer) }
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { waker.wake() }

    XCTAssertLessThan(elapsed { waker.wait(socket: mine, readable: true, writable: false, timeoutMs: 5000) }, 1)
  }

  func test_a_wake_before_the_wait_is_not_lost() {
    let waker = PumpWaker()
    let (mine, peer) = pair()
    defer { close(mine); close(peer) }
    waker.wake()

    XCTAssertLessThan(elapsed { waker.wait(socket: mine, readable: true, writable: false, timeoutMs: 5000) }, 0.5)
  }

  func test_incoming_bytes_end_the_wait() {
    let waker = PumpWaker()
    let (mine, peer) = pair()
    defer { close(mine); close(peer) }
    var byte: UInt8 = 1
    _ = write(peer, &byte, 1)

    XCTAssertLessThan(elapsed { waker.wait(socket: mine, readable: true, writable: false, timeoutMs: 5000) }, 0.5)
  }

  func test_an_idle_wait_lasts_until_its_timeout() {
    let waker = PumpWaker()
    let (mine, peer) = pair()
    defer { close(mine); close(peer) }

    let took = elapsed { waker.wait(socket: mine, readable: true, writable: false, timeoutMs: 200) }

    XCTAssertGreaterThanOrEqual(took, 0.15)
    XCTAssertLessThan(took, 1)
  }

  func test_spent_wakes_do_not_cut_later_waits_short() {
    let waker = PumpWaker()
    let (mine, peer) = pair()
    defer { close(mine); close(peer) }
    waker.wake(); waker.wake(); waker.wake()
    waker.wait(socket: mine, readable: true, writable: false, timeoutMs: 5000)

    XCTAssertGreaterThanOrEqual(elapsed { waker.wait(socket: mine, readable: true, writable: false, timeoutMs: 200) }, 0.15)
  }

  func test_a_full_socket_cannot_take_a_small_packet() {
    let waker = PumpWaker()
    let (mine, peer) = pair()
    defer { close(mine); close(peer) }
    XCTAssertTrue(waker.socketWritable(mine))

    _ = fcntl(mine, F_SETFL, fcntl(mine, F_GETFL) | O_NONBLOCK)
    var chunk = [UInt8](repeating: 0, count: 4096)
    while write(mine, &chunk, chunk.count) > 0 {}
    // Top up byte by byte: a failed 4 KB write can still leave the low-water
    // mark free, which is exactly what POLLOUT reports.
    var byte: UInt8 = 0
    while write(mine, &byte, 1) > 0 {}

    XCTAssertFalse(waker.socketWritable(mine))
  }
}
