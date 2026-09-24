import XCTest
@testable import TetherKit

final class DeepLinkRouteTests: XCTestCase {
  private let desk = SSHHostProfile(id: "p1", name: "Desk", host: "devbox.lan", username: "sam", auth: .password)
  private let pi = SSHHostProfile(id: "p2", name: "pi", host: "10.0.0.9", username: "sam", auth: .password)

  private func route(_ label: String, current: String? = nil, labels: Set<String> = []) -> DeepLinkRoute {
    SessionDeepLink(sessionId: "work", identityName: label)
      .route(profiles: [desk, pi], currentProfileID: current, currentHostLabels: labels)
  }

  func test_the_open_host_answering_to_the_label_switches_in_place() {
    XCTAssertEqual(route("homebox", current: "p2", labels: ["homebox"]), .switchSession("work"))
  }

  func test_a_saved_machine_named_like_the_label_is_opened() {
    XCTAssertEqual(route("PI"), .open(profileID: "p2", session: "work"))
  }

  func test_a_machine_whose_host_address_starts_with_the_label_is_opened() {
    XCTAssertEqual(route("devbox"), .open(profileID: "p1", session: "work"))
    XCTAssertEqual(route("devbox.lan"), .open(profileID: "p1", session: "work"))
  }

  func test_the_open_machine_matched_by_name_switches_in_place() {
    XCTAssertEqual(route("pi", current: "p2"), .switchSession("work"))
  }

  func test_another_machine_is_opened_even_while_one_is_open() {
    XCTAssertEqual(route("desk", current: "p2", labels: ["homebox"]), .open(profileID: "p1", session: "work"))
  }

  func test_an_unknown_label_goes_nowhere() {
    XCTAssertEqual(route("elsewhere", current: "p2"), .none)
  }
}
