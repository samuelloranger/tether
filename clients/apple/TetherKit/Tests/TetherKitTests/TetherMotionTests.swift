import XCTest
@testable import TetherKit

final class TetherMotionTests: XCTestCase {
  func test_heat_arrives_faster_than_it_leaves() {
    XCTAssertLessThan(TetherMotion.ignite, TetherMotion.cool)
    XCTAssertLessThan(TetherMotion.arrive, TetherMotion.cool)
  }

  func test_pulse_rises_faster_than_it_falls() {
    XCTAssertLessThan(TetherMotion.pulseRise, TetherMotion.pulseFall)
  }

  func test_pulses_only_on_entering_waiting() {
    XCTAssertTrue(TetherMotion.pulses(from: .working, to: .waiting, settled: true, reduceMotion: false))
    XCTAssertTrue(TetherMotion.pulses(from: .none, to: .waiting, settled: true, reduceMotion: false))
    XCTAssertFalse(TetherMotion.pulses(from: .waiting, to: .waiting, settled: true, reduceMotion: false))
    XCTAssertFalse(TetherMotion.pulses(from: .waiting, to: .idle, settled: true, reduceMotion: false))
    XCTAssertFalse(TetherMotion.pulses(from: .idle, to: .working, settled: true, reduceMotion: false))
  }

  /// The store has no sessions until the first fetch answers, so opening the app
  /// onto a session that is already waiting must not announce it.
  func test_launch_does_not_announce_a_session_that_was_already_waiting() {
    XCTAssertFalse(TetherMotion.pulses(from: .none, to: .waiting, settled: false, reduceMotion: false))
  }

  func test_reduce_motion_suppresses_the_pulse() {
    XCTAssertFalse(TetherMotion.pulses(from: .working, to: .waiting, settled: true, reduceMotion: true))
  }

  func test_cancel_is_faster_than_the_fall_it_interrupts() {
    XCTAssertLessThan(TetherMotion.pulseCancel, TetherMotion.pulseFall)
  }

  /// The bloom is built at peak gain and held back by `restOpacity`, so a
  /// session that is not pulsing must render exactly the alphas `LitBloom`
  /// documents. If these two ever drift apart the whole chrome changes
  /// brightness.
  func test_rest_opacity_cancels_the_pulse_gain() {
    XCTAssertEqual(LitBloom.pulseGain * LitBloom.restOpacity, 1, accuracy: 0.0001)
    XCTAssertGreaterThan(LitBloom.pulseGain, 1)
  }
}
