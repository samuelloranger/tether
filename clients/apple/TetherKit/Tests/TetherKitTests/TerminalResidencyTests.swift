import XCTest
@testable import TetherKit

final class TerminalResidencyTests: XCTestCase {
  func test_touch_moves_key_to_front_deduped() {
    XCTAssertEqual(TerminalResidency.touch(["a", "b", "c"], "c"), ["c", "a", "b"])
    XCTAssertEqual(TerminalResidency.touch(["a", "b"], "a"), ["a", "b"])
  }

  func test_touch_caps_length() {
    XCTAssertEqual(TerminalResidency.touch(["a", "b", "c"], "d", max: 3), ["d", "a", "b"])
  }

  func test_resident_keeps_active_first_then_recency_within_cap() {
    let out = TerminalResidency.resident(
      active: "h:a", order: ["h:c", "h:b"],
      live: ["h:a", "h:b", "h:c"], cap: 2)
    XCTAssertEqual(out, ["h:a", "h:c"])
  }

  func test_resident_excludes_dead_sessions() {
    let out = TerminalResidency.resident(
      active: "h:a", order: ["h:ghost", "h:b"],
      live: ["h:a", "h:b"], cap: 8)
    XCTAssertFalse(out.contains("h:ghost"))
    XCTAssertTrue(out.contains("h:b"))
  }

  func test_resident_never_exceeds_cap() {
    let out = TerminalResidency.resident(
      active: "h:a", order: ["h:b", "h:c", "h:d"],
      live: ["h:a", "h:b", "h:c", "h:d"], cap: 2)
    XCTAssertEqual(out.count, 2)
  }
}
