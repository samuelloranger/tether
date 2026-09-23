import XCTest
@testable import TetherKit

@MainActor
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

  func test_a_push_the_open_host_covers_shows_no_system_banner() async {
    let router = NotificationTapRouter()
    router.coversForegroundPush = { $0.identityName == "devbox" }
    let covered = await router.presentationOptions(for: ["link": "tether://session/b?host=devbox"])
    let other = await router.presentationOptions(for: ["link": "tether://session/b?host=elsewhere"])
    XCTAssertEqual(covered, [])
    XCTAssertEqual(other, [.banner, .sound, .badge])
  }

  func test_without_an_open_terminal_every_push_shows() async {
    let router = NotificationTapRouter()
    let options = await router.presentationOptions(for: ["link": "tether://session/b?host=devbox"])
    XCTAssertEqual(options, [.banner, .sound, .badge])
  }

  func test_a_push_without_a_tether_link_shows() async {
    let router = NotificationTapRouter()
    router.coversForegroundPush = { _ in true }
    let options = await router.presentationOptions(for: [:])
    XCTAssertEqual(options, [.banner, .sound, .badge])
  }
}
