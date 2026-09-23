import XCTest
@testable import TetherKit

final class SessionDeepLinkTests: XCTestCase {
  func test_parses_a_session_link_and_its_host_identity() {
    XCTAssertEqual(
      DeepLinkCoordinator.parse("tether://session/term-7?host=alpha"),
      SessionDeepLink(sessionId: "term-7", identityName: "alpha"))
  }

  func test_decodes_a_percent_encoded_host_identity() {
    XCTAssertEqual(
      DeepLinkCoordinator.parse("tether://session/term-7?host=App%20terminal"),
      SessionDeepLink(sessionId: "term-7", identityName: "App terminal"))
    XCTAssertEqual(
      DeepLinkCoordinator.parse("tether://session/term-7?host=App+terminal"),
      SessionDeepLink(sessionId: "term-7", identityName: "App terminal"))
  }

  func test_ignores_a_fragment_and_other_parameters() {
    XCTAssertEqual(
      DeepLinkCoordinator.parse("tether://session/s1?x=1&host=beta#frag"),
      SessionDeepLink(sessionId: "s1", identityName: "beta"))
  }

  func test_rejects_malformed_urls() {
    for url in [
      "https://session/term-7?host=alpha",
      "tether://session/?host=alpha",
      "tether://session/term-7",
      "tether://session/term-7?host=",
      "tether://session/term-7?host=%zz",
    ] {
      XCTAssertNil(DeepLinkCoordinator.parse(url), url)
    }
  }
}
