import XCTest
@testable import TetherKit

final class LitThemeTests: XCTestCase {
  func test_state_carries_drawer_classification_straight_through() {
    XCTAssertEqual(LitTheme.state(for: .working), .working)
    XCTAssertEqual(LitTheme.state(for: .waiting), .waiting)
    XCTAssertEqual(LitTheme.state(for: .idle), .idle)
  }

  func test_stopped_and_missing_do_not_tint() {
    XCTAssertEqual(LitTheme.state(for: .stopped), .none)
    XCTAssertEqual(LitTheme.state(for: nil), .none)
    XCTAssertEqual(
      LitTheme.state(status: nil, activity: "working", lastOutputAt: nil),
      .none
    )
  }

  func test_waiting_bloom_is_quieter_than_working() {
    XCTAssertLessThan(LitBloom.waiting.b1, LitBloom.working.b1)
    XCTAssertLessThan(LitBloom.waiting.rim, LitBloom.working.rim)
  }

  func test_idle_is_quietest_live_state() {
    XCTAssertLessThan(LitBloom.idle.b1, LitBloom.waiting.b1)
    XCTAssertGreaterThan(LitBloom.idle.b1, 0)
  }

  func test_none_zeroes_bloom() {
    let bloom = LitBloom.forState(.none)
    XCTAssertEqual(bloom.b1, 0)
    XCTAssertEqual(bloom.b2, 0)
    XCTAssertEqual(bloom.b3, 0)
    XCTAssertEqual(bloom.rim, 0)
  }

  func test_resolve_matches_drawer_dot_for_a_waiting_session() {
    let chrome = LitChrome.resolve(
      status: "running",
      activity: "waiting",
      lastOutputAt: nil
    )
    XCTAssertEqual(chrome.state, .waiting)
  }

  func test_done_carries_through_to_its_own_lit_state() {
    XCTAssertEqual(LitTheme.state(for: .done), .done)
  }

  func test_done_glows_quieter_than_blocked() {
    XCTAssertLessThan(LitBloom.done.rim, LitBloom.waiting.rim)
    XCTAssertGreaterThan(LitBloom.done.rim, LitBloom.idle.rim)
  }

  func test_done_does_not_fire_the_arrival_swell() {
    XCTAssertFalse(
      TetherMotion.pulses(from: .working, to: .done, settled: true, reduceMotion: false)
    )
  }
}

final class SessionStripTests: XCTestCase {
  func test_relative_since_formats_compact_ages() {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
    let then = "2026-08-26 12:00:00"
    guard let date = formatter.date(from: then) else {
      return XCTFail("fixture timestamp must parse")
    }
    let thenMs = Int64(date.timeIntervalSince1970 * 1000)
    XCTAssertEqual(SessionStrip.relativeSince(then, nowMs: thenMs + 4_000), "4s")
    XCTAssertEqual(SessionStrip.relativeSince(then, nowMs: thenMs + 120_000), "2m")
    XCTAssertEqual(SessionStrip.relativeSince(nil), "—")
  }
}
