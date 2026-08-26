import XCTest
@testable import TetherKit

final class NotificationTapRouterTests: XCTestCase {
  func test_link_from_user_info_prefers_an_explicit_tether_link() {
    let link = NotificationTapRouter.link(from: [
      "link": "tether://session/abc?host=devbox",
      "sessionId": "ignored",
      "host": "ignored",
    ])
    XCTAssertEqual(link, "tether://session/abc?host=devbox")
  }

  func test_link_from_user_info_rejects_non_tether_schemes() {
    XCTAssertNil(
      NotificationTapRouter.link(from: ["link": "https://example.com/session/abc"])
    )
  }

  func test_link_from_user_info_builds_a_tether_url_from_session_and_host_fields() {
    let link = NotificationTapRouter.link(from: [
      "sessionId": "term-1",
      "host": "devbox",
    ])
    XCTAssertEqual(link, "tether://session/term-1?host=devbox")
  }

  func test_link_from_user_info_returns_nil_when_session_or_host_is_missing() {
    XCTAssertNil(NotificationTapRouter.link(from: ["sessionId": "term-1"]))
    XCTAssertNil(NotificationTapRouter.link(from: ["host": "devbox"]))
    XCTAssertNil(NotificationTapRouter.link(from: [:]))
  }
}

final class LifecycleLogicChecksTests: XCTestCase {
  func test_resume_and_activity_reference_checks_still_pass() {
    // LifecycleLogicChecks encodes the same invariants as the suites above —
    // keep it green so a future agent can call allPass() from one place.
    XCTAssertTrue(ResumeLogicChecks.allPass())
    XCTAssertTrue(SessionActivityChecks.allPass())
  }
}
