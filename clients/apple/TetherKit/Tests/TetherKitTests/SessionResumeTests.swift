import XCTest
@testable import TetherKit

final class SessionResumeTests: XCTestCase {
  func test_returns_to_the_terminal_that_was_open() {
    XCTAssertEqual(SessionResume.pick(remembered: "build", available: ["main", "build"]), "build")
  }

  /// The shell was killed from another client while the app was closed. Landing
  /// on nothing would hide the terminals that ARE still running.
  func test_falls_back_to_the_first_session_when_the_remembered_one_is_gone() {
    XCTAssertEqual(SessionResume.pick(remembered: "build", available: ["main"]), "main")
  }

  func test_opens_the_first_session_on_a_first_ever_launch() {
    XCTAssertEqual(SessionResume.pick(remembered: nil, available: ["main", "build"]), "main")
  }

  func test_opens_nothing_when_the_host_has_no_sessions() {
    XCTAssertNil(SessionResume.pick(remembered: "build", available: []))
    XCTAssertNil(SessionResume.pick(remembered: nil, available: []))
  }

  func test_host_selection_follows_the_same_rule() {
    XCTAssertEqual(SessionResume.pickHost(remembered: "b", available: ["a", "b"]), "b")
    XCTAssertEqual(SessionResume.pickHost(remembered: "gone", available: ["a", "b"]), "a")
    XCTAssertNil(SessionResume.pickHost(remembered: nil, available: []))
  }
}
