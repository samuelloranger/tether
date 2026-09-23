import XCTest
@testable import TetherKit

/// The drawer follows the finger: every point of the drag maps to a position, and the
/// release settles where the flick was actually headed.
final class DrawerTrackingTests: XCTestCase {
  private let width: CGFloat = 280

  func test_a_closed_drawer_sits_at_zero_until_the_finger_moves() {
    XCTAssertEqual(DrawerDragDecision.progress(isOpen: false, translationX: 0, width: width), 0, accuracy: 0.0001)
  }

  func test_progress_tracks_the_finger_one_to_one() {
    XCTAssertEqual(DrawerDragDecision.progress(isOpen: false, translationX: 140, width: width), 0.5, accuracy: 0.0001)
    XCTAssertEqual(DrawerDragDecision.progress(isOpen: false, translationX: 70, width: width), 0.25, accuracy: 0.0001)
  }

  func test_an_open_drawer_tracks_backwards_from_fully_open() {
    XCTAssertEqual(DrawerDragDecision.progress(isOpen: true, translationX: 0, width: width), 1, accuracy: 0.0001)
    XCTAssertEqual(DrawerDragDecision.progress(isOpen: true, translationX: -140, width: width), 0.5, accuracy: 0.0001)
    XCTAssertEqual(DrawerDragDecision.progress(isOpen: true, translationX: -400, width: width), 0, accuracy: 0.0001)
  }

  func test_pulling_a_closed_drawer_further_closed_does_nothing() {
    XCTAssertEqual(DrawerDragDecision.progress(isOpen: false, translationX: -120, width: width), 0, accuracy: 0.0001)
  }

  func test_pushing_past_fully_open_resists_instead_of_overshooting() {
    let overshoot = DrawerDragDecision.progress(isOpen: true, translationX: 200, width: width)
    XCTAssertGreaterThan(overshoot, 1)
    XCTAssertLessThan(overshoot, 1.1)
  }

  func test_a_zero_width_drawer_cannot_divide_by_zero() {
    XCTAssertEqual(DrawerDragDecision.progress(isOpen: false, translationX: 50, width: 0), 0, accuracy: 0.0001)
  }

  // Release: UIKit hands us a velocity in points per second, and where the
  // drag was going decides — that is what makes a short flick open the drawer.
  func test_a_flick_opens_even_though_the_finger_barely_moved() {
    XCTAssertTrue(DrawerDragDecision.settlesOpen(
      isOpen: false, translationX: 40, velocityX: 1400, width: width))
  }

  func test_a_slow_drag_past_the_middle_opens() {
    XCTAssertTrue(DrawerDragDecision.settlesOpen(
      isOpen: false, translationX: 150, velocityX: 30, width: width))
  }

  func test_a_slow_drag_short_of_the_middle_falls_back_closed() {
    XCTAssertFalse(DrawerDragDecision.settlesOpen(
      isOpen: false, translationX: 90, velocityX: 20, width: width))
  }

  func test_a_flick_back_closes_an_open_drawer_from_almost_fully_open() {
    XCTAssertFalse(DrawerDragDecision.settlesOpen(
      isOpen: true, translationX: -20, velocityX: -1500, width: width))
  }

  func test_releasing_an_open_drawer_where_it_started_leaves_it_open() {
    XCTAssertTrue(DrawerDragDecision.settlesOpen(
      isOpen: true, translationX: -12, velocityX: -40, width: width))
  }

  func test_a_flick_the_wrong_way_does_not_open_a_closed_drawer() {
    XCTAssertFalse(DrawerDragDecision.settlesOpen(
      isOpen: false, translationX: 120, velocityX: -1800, width: width))
  }

  // A pan that never moved horizontally is the terminal's, not the drawer's:
  // the close gesture only begins on a horizontally dominant pan.
  func test_only_a_horizontally_dominant_pan_belongs_to_the_drawer() {
    XCTAssertTrue(DrawerDragDecision.panBelongsToDrawer(velocity: CGSize(width: -600, height: 120)))
    XCTAssertFalse(DrawerDragDecision.panBelongsToDrawer(velocity: CGSize(width: -120, height: 900)))
    XCTAssertFalse(DrawerDragDecision.panBelongsToDrawer(velocity: .zero))
  }
}
