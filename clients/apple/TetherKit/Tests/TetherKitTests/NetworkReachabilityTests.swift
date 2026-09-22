import Network
import XCTest
@testable import TetherKit

/// The reachability value only normalizes what `NWPath` reports. It must never
/// be read as "the SSH host answered" — a satisfied path says the radio has a
/// route, nothing about the host, the port, or authentication.
final class NetworkReachabilityTests: XCTestCase {
  func test_unsatisfied_path_is_offline() {
    let value = NetworkReachability.classify(status: .unsatisfied, interfaces: [], isExpensive: false, isConstrained: false)
    XCTAssertEqual(value.availability, .offline)
  }

  func test_requires_connection_path_is_not_usable() {
    let value = NetworkReachability.classify(status: .requiresConnection, interfaces: [], isExpensive: false, isConstrained: false)
    XCTAssertEqual(value.availability, .requiresConnection)
  }

  func test_satisfied_path_is_usable() {
    let value = NetworkReachability.classify(status: .satisfied, interfaces: [.wifi], isExpensive: false, isConstrained: false)
    XCTAssertEqual(value.availability, .usable)
    XCTAssertTrue(value.usesWiFi)
    XCTAssertFalse(value.usesCellular)
  }

  func test_constrained_cellular_path_is_still_usable_but_flagged() {
    let value = NetworkReachability.classify(status: .satisfied, interfaces: [.cellular], isExpensive: true, isConstrained: true)
    XCTAssertEqual(value.availability, .usable)
    XCTAssertTrue(value.usesCellular)
    XCTAssertTrue(value.isExpensive)
    XCTAssertTrue(value.isConstrained)
  }

  func test_unknown_interfaces_do_not_make_an_offline_path_usable() {
    let value = NetworkReachability.classify(status: .unsatisfied, interfaces: [.wifi, .cellular], isExpensive: false, isConstrained: false)
    XCTAssertEqual(value.availability, .offline)
  }
}
