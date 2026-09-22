import XCTest
@testable import TetherKit

/// The drawer's drag rules are pure so the terminal never has to host a gesture
/// to prove them: a closed drawer only opens from the narrow leading edge, and
/// an open drawer only closes on a deliberate leftward pull of its own panel.
final class DrawerDragDecisionTests: XCTestCase {
  func test_deliberate_rightward_drag_from_the_edge_opens() {
    XCTAssertEqual(
      DrawerDragDecision.decide(isOpen: false, startX: 10, translation: CGSize(width: 60, height: 4)),
      .open
    )
  }

  func test_drag_starting_past_the_edge_strip_is_terminal_input() {
    XCTAssertEqual(
      DrawerDragDecision.decide(isOpen: false, startX: 120, translation: CGSize(width: 60, height: 4)),
      .ignore
    )
  }

  func test_short_drag_is_touch_noise() {
    XCTAssertEqual(
      DrawerDragDecision.decide(isOpen: false, startX: 10, translation: CGSize(width: 18, height: 2)),
      .ignore
    )
  }

  func test_vertical_drag_is_never_a_drawer_gesture() {
    // Scrolling the terminal begins at the edge too — dominance decides.
    XCTAssertEqual(
      DrawerDragDecision.decide(isOpen: false, startX: 8, translation: CGSize(width: 50, height: 90)),
      .ignore
    )
    XCTAssertEqual(
      DrawerDragDecision.decide(isOpen: true, startX: 8, translation: CGSize(width: -50, height: 90)),
      .ignore
    )
  }

  func test_leftward_pull_on_an_open_drawer_closes_it_from_anywhere_in_the_panel() {
    XCTAssertEqual(
      DrawerDragDecision.decide(isOpen: true, startX: 240, translation: CGSize(width: -70, height: 6)),
      .close
    )
  }

  func test_rightward_drag_on_an_open_drawer_does_nothing() {
    XCTAssertEqual(
      DrawerDragDecision.decide(isOpen: true, startX: 40, translation: CGSize(width: 70, height: 0)),
      .ignore
    )
  }

  func test_short_pull_leaves_an_open_drawer_open() {
    XCTAssertEqual(
      DrawerDragDecision.decide(isOpen: true, startX: 200, translation: CGSize(width: -20, height: 0)),
      .ignore
    )
  }
}
