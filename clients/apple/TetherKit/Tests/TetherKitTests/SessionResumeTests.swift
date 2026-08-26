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

extension SessionResumeTests {
  /// Opening a session's socket makes the server start it, so restoring onto a
  /// stopped one would resurrect a shell the user killed.
  func test_a_cold_launch_never_restores_a_stopped_session() {
    let listed = [("main", "stopped"), ("build", "running")]
    XCTAssertEqual(SessionResume.restorable(listed), ["build"])
    XCTAssertEqual(
      SessionResume.pick(remembered: "main", available: SessionResume.restorable(listed)),
      "build"
    )
  }

  func test_a_host_whose_sessions_are_all_stopped_restores_nothing() {
    let listed = [("main", "stopped"), ("build", "exited")]
    XCTAssertTrue(SessionResume.restorable(listed).isEmpty)
    XCTAssertNil(
      SessionResume.pick(remembered: "main", available: SessionResume.restorable(listed))
    )
  }
}
