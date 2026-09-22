import Network
import XCTest
@testable import TetherKit

/// The reachability value only normalizes what `NWPath` reports. It must never
/// be read as "the SSH host answered" — a satisfied path says the radio has a
/// route, nothing about the host, the port, or authentication.
final class NetworkReachabilityTests: XCTestCase {
  func test_unsatisfied_path_is_offline() {
    let value = NetworkReachability.classify(status: .unsatisfied, interfaces: [])
    XCTAssertEqual(value.availability, .offline)
  }

  func test_requires_connection_path_is_not_usable() {
    let value = NetworkReachability.classify(status: .requiresConnection, interfaces: [])
    XCTAssertEqual(value.availability, .requiresConnection)
  }

  func test_satisfied_path_is_usable() {
    let value = NetworkReachability.classify(status: .satisfied, interfaces: [.wifi])
    XCTAssertEqual(value.availability, .usable)
  }

  func test_unknown_interfaces_do_not_make_an_offline_path_usable() {
    let value = NetworkReachability.classify(status: .unsatisfied, interfaces: [.wifi, .cellular])
    XCTAssertEqual(value.availability, .offline)
  }

  func test_usable_interfaces_keep_the_path_preference_order() {
    let value = NetworkReachability.classify(status: .satisfied, interfaces: [.cellular, .wifi])
    XCTAssertEqual(value.interfaces, [.cellular, .wifi])
    XCTAssertEqual(value.primary, .cellular)
  }

  func test_an_offline_path_carries_no_interfaces() {
    XCTAssertEqual(NetworkReachability.classify(status: .unsatisfied, interfaces: [.wifi]).interfaces, [])
  }
}
