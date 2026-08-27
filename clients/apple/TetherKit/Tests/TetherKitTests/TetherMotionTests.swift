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
    XCTAssertTrue(TetherMotion.pulses(from: .working, to: .waiting, reduceMotion: false))
    XCTAssertTrue(TetherMotion.pulses(from: .none, to: .waiting, reduceMotion: false))
    XCTAssertFalse(TetherMotion.pulses(from: .waiting, to: .waiting, reduceMotion: false))
    XCTAssertFalse(TetherMotion.pulses(from: .waiting, to: .idle, reduceMotion: false))
    XCTAssertFalse(TetherMotion.pulses(from: .idle, to: .working, reduceMotion: false))
  }

  func test_reduce_motion_suppresses_the_pulse() {
    XCTAssertFalse(TetherMotion.pulses(from: .working, to: .waiting, reduceMotion: true))
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
