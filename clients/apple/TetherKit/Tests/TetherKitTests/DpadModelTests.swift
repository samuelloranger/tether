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

  /// The first few pixels of a thumb drag are noisy. After sampling, pick the
  /// larger axis of the accumulated translation — not whichever axis first
  /// beat a dominance ratio.
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
}
