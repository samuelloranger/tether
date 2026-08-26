import XCTest
@testable import TetherKit

final class SessionActivityTests: XCTestCase {
  func test_stopped_status_wins_over_any_live_activity_classification() {
    XCTAssertEqual(
      SessionActivityLogic.dotKey(status: "stopped", activity: "working", live: true),
      .stopped
    )
  }

  func test_server_activity_maps_straight_onto_the_drawer_dot() {
    XCTAssertEqual(
      SessionActivityLogic.dotKey(status: "running", activity: "waiting", live: false),
      .waiting
    )
    XCTAssertEqual(
      SessionActivityLogic.dotKey(status: "running", activity: "working", live: false),
      .working
    )
    XCTAssertEqual(
      SessionActivityLogic.dotKey(status: "running", activity: "idle", live: true),
      .idle
    )
  }

  func test_missing_activity_falls_back_to_the_live_recency_flag() {
    XCTAssertEqual(
      SessionActivityLogic.dotKey(status: "running", activity: nil, live: true),
      .working
    )
    XCTAssertEqual(
      SessionActivityLogic.dotKey(status: "running", activity: nil, live: false),
      .idle
    )
  }

  func test_waiting_label_names_the_next_action_not_the_internal_state() {
    XCTAssertEqual(SessionActivityLogic.label(.waiting), "needs input")
    XCTAssertEqual(SessionActivityLogic.label(.working), "working")
    XCTAssertEqual(SessionActivityLogic.label(.idle), "idle")
    XCTAssertEqual(SessionActivityLogic.label(.stopped), "stopped")
  }

  func test_accessibility_label_includes_title_and_activity_in_one_phrase() {
    XCTAssertEqual(
      SessionActivityLogic.accessibilityLabel(
        title: "Build agent",
        status: "running",
        activity: "waiting",
        live: false
      ),
      "Terminal Build agent, needs input"
    )
  }

  func test_is_recently_active_accepts_sqlite_utc_timestamps_within_the_window() {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
    let then = "2026-08-26 12:00:00"
    guard let date = formatter.date(from: then) else {
      return XCTFail("fixture timestamp must parse")
    }
    let thenMs = Int64(date.timeIntervalSince1970 * 1000)
    XCTAssertTrue(
      SessionActivityLogic.isRecentlyActive(lastOutputAt: then, nowMs: thenMs + 5_000)
    )
    XCTAssertFalse(
      SessionActivityLogic.isRecentlyActive(
        lastOutputAt: then,
        nowMs: thenMs + SessionActivityLogic.recentOutputMs + 1
      )
    )
  }

  func test_is_recently_active_treats_nil_and_empty_as_not_live() {
    XCTAssertFalse(SessionActivityLogic.isRecentlyActive(lastOutputAt: nil))
    XCTAssertFalse(SessionActivityLogic.isRecentlyActive(lastOutputAt: ""))
  }
}
