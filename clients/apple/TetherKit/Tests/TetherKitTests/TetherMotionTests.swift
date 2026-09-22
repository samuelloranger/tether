import XCTest
@testable import TetherKit

final class TetherMotionTests: XCTestCase {
  func test_heat_arrives_faster_than_it_leaves() {
    XCTAssertLessThan(TetherMotion.ignite, TetherMotion.cool)
    XCTAssertLessThan(TetherMotion.arrive, TetherMotion.cool)
  }

  func test_screen_transition_has_a_distinct_entry_scale() {
    XCTAssertLessThan(TetherMotion.screenEntryScale, 1)
    XCTAssertGreaterThan(TetherMotion.screenEntryScale, 0.9)
  }

  func test_press_feedback_never_scales_a_control_up() {
    XCTAssertLessThan(TetherMotion.pressScale, 1)
    XCTAssertGreaterThan(TetherMotion.pressScale, 0.9)
  }

  func test_leading_edge_swipe_opens_only_after_a_deliberate_rightward_drag() {
    XCTAssertTrue(TetherMotion.shouldOpenDrawer(startX: 12, translationX: 56))
    XCTAssertFalse(TetherMotion.shouldOpenDrawer(startX: 12, translationX: 20))
    XCTAssertFalse(TetherMotion.shouldOpenDrawer(startX: 28, translationX: 56))
    XCTAssertFalse(TetherMotion.shouldOpenDrawer(startX: 12, translationX: -56))
  }

}
