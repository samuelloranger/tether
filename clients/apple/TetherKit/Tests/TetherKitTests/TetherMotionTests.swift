import XCTest
@testable import TetherKit

final class TetherMotionTests: XCTestCase {
  func test_screen_transition_has_a_distinct_entry_scale() {
    XCTAssertLessThan(TetherMotion.screenEntryScale, 1)
    XCTAssertGreaterThan(TetherMotion.screenEntryScale, 0.9)
  }

  func test_press_feedback_never_scales_a_control_up() {
    XCTAssertLessThan(TetherMotion.pressScale, 1)
    XCTAssertGreaterThan(TetherMotion.pressScale, 0.9)
  }


}
