import XCTest
@testable import TetherKit

final class DpadModelTests: XCTestCase {
  func test_stays_neutral_inside_threshold_even_after_sample() {
    XCTAssertNil(DPadModel.resolveDirection(dx: 5, dy: -3, active: nil, sampled: true))
  }

  func test_does_not_lock_until_the_sample_window_elapses() {
    XCTAssertNil(DPadModel.resolveDirection(dx: 20, dy: 0, active: nil, sampled: false))
    XCTAssertNil(DPadModel.resolveDirection(dx: 0, dy: 20, active: nil, sampled: false))
  }

  func test_locks_the_sampled_axis_once_the_window_elapses() {
    XCTAssertEqual(DPadModel.resolveDirection(dx: 20, dy: 0, active: nil, sampled: true), .C)
    XCTAssertEqual(DPadModel.resolveDirection(dx: -20, dy: 0, active: nil, sampled: true), .D)
    XCTAssertEqual(DPadModel.resolveDirection(dx: 0, dy: -20, active: nil, sampled: true), .A)
    XCTAssertEqual(DPadModel.resolveDirection(dx: 0, dy: 20, active: nil, sampled: true), .B)
  }

  /// The first pixels of a thumb drag are noisy: pick the larger accumulated axis, not whichever
  /// first beat a dominance ratio.
  func test_after_sample_picks_the_larger_axis_of_the_measured_vector() {
    XCTAssertEqual(DPadModel.resolveDirection(dx: 16, dy: 12, active: nil, sampled: true), .C)
    XCTAssertEqual(DPadModel.resolveDirection(dx: 12, dy: -16, active: nil, sampled: true), .A)
  }

  func test_holds_locked_direction_for_the_rest_of_the_gesture() {
    XCTAssertEqual(DPadModel.resolveDirection(dx: 15, dy: 16, active: .C, sampled: true), .C)
  }

  func test_returning_inside_threshold_unlocks() {
    XCTAssertNil(DPadModel.resolveDirection(dx: 2, dy: 2, active: .C, sampled: true))
  }

  private func drive(_ lock: inout DPadLock, _ xs: [CGFloat], y: CGFloat = 0) -> [DPadDirection?] {
    xs.map { lock.update(translation: CGPoint(x: $0, y: y), sampled: true) }
  }

  func test_reversing_past_the_far_point_flips_without_returning_to_touch_down() {
    var lock = DPadLock()
    XCTAssertEqual(drive(&lock, [20, 60, 55, 46, 43]), [.C, .C, .C, nil, .D])
  }

  func test_backing_off_a_little_stops_then_resumes_on_return() {
    var lock = DPadLock()
    XCTAssertEqual(drive(&lock, [20, 40, 31, 40]), [.C, .C, nil, .C])
  }

  func test_can_reverse_back_and_forth_in_one_gesture() {
    var lock = DPadLock()
    XCTAssertEqual(drive(&lock, [30, 10, -20, 0]), [.C, .D, .D, .C])
  }

  func test_fast_reversal_flips_in_a_single_move() {
    var lock = DPadLock()
    XCTAssertEqual(drive(&lock, [60, 30]), [.C, .D])
  }

  func test_perpendicular_drift_while_locked_cannot_pick_a_new_axis_on_release() {
    var lock = DPadLock()
    XCTAssertEqual(lock.update(translation: CGPoint(x: 40, y: 0), sampled: true), .C)
    XCTAssertEqual(lock.update(translation: CGPoint(x: 40, y: 30), sampled: true), .C)
    XCTAssertEqual(lock.update(translation: CGPoint(x: 20, y: 34), sampled: true), .D)
  }

  func test_lock_waits_for_the_sample_window() {
    var lock = DPadLock()
    XCTAssertNil(lock.update(translation: CGPoint(x: 20, y: 0), sampled: false))
    XCTAssertEqual(lock.update(translation: CGPoint(x: 20, y: 0), sampled: true), .C)
  }

  func test_relative_translation_restarts_from_the_release_point() {
    var lock = DPadLock()
    _ = drive(&lock, [60, 40])
    XCTAssertEqual(lock.relative(CGPoint(x: 40, y: 0)).x, -12)
  }
}
