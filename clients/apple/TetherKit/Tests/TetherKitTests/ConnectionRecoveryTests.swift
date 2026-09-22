import XCTest
@testable import TetherKit

/// The single recovery gate: a network path becoming usable is the only network
/// event that may request a redial, and only from a state that is not already
/// connected or dialing. Repeats are inert — the observer re-reports the same
/// path on every interface change.
final class ConnectionRecoveryTests: XCTestCase {
  private let usable = NetworkReachability(availability: .usable, usesWiFi: true, usesCellular: false, isExpensive: false, isConstrained: false)
  private let offline = NetworkReachability(availability: .offline, usesWiFi: false, usesCellular: false, isExpensive: false, isConstrained: false)
  private let needsConnection = NetworkReachability(availability: .requiresConnection, usesWiFi: true, usesCellular: false, isExpensive: false, isConstrained: false)

  func test_offline_path_never_requests_a_redial() {
    XCTAssertFalse(SSHTerminalController.shouldRedial(previous: usable, next: offline, status: .disconnected, dialing: false))
  }

  func test_requires_connection_path_never_requests_a_redial() {
    XCTAssertFalse(SSHTerminalController.shouldRedial(previous: offline, next: needsConnection, status: .disconnected, dialing: false))
  }

  func test_path_becoming_usable_while_disconnected_requests_a_redial() {
    XCTAssertTrue(SSHTerminalController.shouldRedial(previous: offline, next: usable, status: .disconnected, dialing: false))
  }

  func test_first_usable_path_with_no_previous_value_requests_a_redial_when_failed() {
    XCTAssertTrue(SSHTerminalController.shouldRedial(previous: nil, next: usable, status: .failed("no route to host"), dialing: false))
  }

  func test_repeated_usable_updates_are_idempotent() {
    XCTAssertFalse(SSHTerminalController.shouldRedial(previous: usable, next: usable, status: .disconnected, dialing: false))
  }

  func test_a_usable_path_does_not_disturb_a_live_session() {
    XCTAssertFalse(SSHTerminalController.shouldRedial(previous: offline, next: usable, status: .connected, dialing: false))
  }

  func test_a_usable_path_does_not_race_an_in_flight_dial() {
    XCTAssertFalse(SSHTerminalController.shouldRedial(previous: offline, next: usable, status: .connecting, dialing: true))
    XCTAssertFalse(SSHTerminalController.shouldRedial(previous: offline, next: usable, status: .disconnected, dialing: true))
  }

  // Copy must describe the real blocker. "Waiting for a network connection" on a
  // host-key mismatch would be a lie the user can't act on.
  func test_offline_copy_says_the_network_is_missing_not_the_host() {
    let copy = SSHTerminalController.connectionCopy(status: .disconnected, reachability: offline)
    XCTAssertEqual(copy?.message, "Waiting for a network connection")
    XCTAssertEqual(copy?.icon, "wifi.slash")
    XCTAssertEqual(copy?.showsRetry, false)
  }

  func test_requires_connection_copy_names_that_state() {
    let copy = SSHTerminalController.connectionCopy(status: .disconnected, reachability: needsConnection)
    XCTAssertEqual(copy?.message, "Network needs a connection")
    XCTAssertEqual(copy?.showsRetry, false)
  }

  func test_ssh_failure_on_a_usable_path_keeps_the_real_error() {
    let copy = SSHTerminalController.connectionCopy(status: .failed("Host key changed for homelab"), reachability: usable)
    XCTAssertEqual(copy?.message, "Host key changed for homelab")
    XCTAssertEqual(copy?.showsRetry, true)
  }

  func test_ssh_failure_while_offline_still_keeps_the_host_key_error() {
    // Network copy may never overwrite a security failure.
    let copy = SSHTerminalController.connectionCopy(status: .failed("Host key mismatch — refusing to connect"), reachability: offline)
    XCTAssertEqual(copy?.message, "Host key mismatch — refusing to connect")
  }

  func test_drop_on_a_usable_path_reads_as_reconnecting() {
    let copy = SSHTerminalController.connectionCopy(status: .disconnected, reachability: usable)
    XCTAssertEqual(copy?.message, "Connection lost — reconnecting…")
    XCTAssertEqual(copy?.showsRetry, false)
  }

  func test_connecting_reads_as_connecting_even_without_a_path_value() {
    let copy = SSHTerminalController.connectionCopy(status: .connecting, reachability: nil)
    XCTAssertEqual(copy?.message, "Connecting…")
  }

  func test_a_connected_session_has_no_status_copy() {
    XCTAssertNil(SSHTerminalController.connectionCopy(status: .connected, reachability: usable))
  }
}
