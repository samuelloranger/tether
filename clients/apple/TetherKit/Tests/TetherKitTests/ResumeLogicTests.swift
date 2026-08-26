import XCTest
@testable import TetherKit

final class ResumeLogicTests: XCTestCase {
  func test_a_closed_socket_reconnects_instead_of_waiting_out_backoff() {
    let now: Int64 = 1_000_000
    XCTAssertEqual(
      ResumeLogic.action(open: false, lastSeenMs: now, nowMs: now),
      .reconnect
    )
    XCTAssertEqual(
      ResumeLogic.action(open: false, lastSeenMs: 0, nowMs: now),
      .reconnect
    )
  }

  func test_an_open_socket_silent_past_stale_ms_is_closed_as_half_open() {
    let now: Int64 = 1_000_000
    XCTAssertEqual(
      ResumeLogic.action(
        open: true,
        lastSeenMs: now - ResumeLogic.staleMs - 1,
        nowMs: now
      ),
      .close
    )
  }

  func test_an_open_socket_heard_from_recently_is_left_alone() {
    let now: Int64 = 1_000_000
    XCTAssertEqual(
      ResumeLogic.action(open: true, lastSeenMs: now - 1000, nowMs: now),
      .none
    )
    XCTAssertEqual(
      ResumeLogic.action(open: true, lastSeenMs: now, nowMs: now),
      .none
    )
  }
}
