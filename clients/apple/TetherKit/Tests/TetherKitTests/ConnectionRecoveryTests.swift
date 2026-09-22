import XCTest
@testable import TetherKit

/// The single recovery gate: a network path becoming usable is the only network
/// event that may request a redial, and only from a state that is not already
/// connected or dialing. Repeats are inert — the observer re-reports the same
/// path on every interface change.
final class ConnectionRecoveryTests: XCTestCase {
  private let usable = NetworkReachability(availability: .usable)
  private let offline = NetworkReachability(availability: .offline)
  private let needsConnection = NetworkReachability(availability: .requiresConnection)

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

  // The foreground redial is the safety net for a socket iOS killed while
  // suspended. It shares the gate so it can't race a path-driven redial.
  func test_foreground_redial_skips_a_live_session() {
    XCTAssertFalse(SSHTerminalController.shouldRedialOnForeground(status: .connected, dialing: false, reachability: usable))
  }

  func test_foreground_redial_skips_an_in_flight_dial() {
    XCTAssertFalse(SSHTerminalController.shouldRedialOnForeground(status: .disconnected, dialing: true, reachability: usable))
  }

  func test_foreground_redial_waits_while_offline() {
    XCTAssertFalse(SSHTerminalController.shouldRedialOnForeground(status: .disconnected, dialing: false, reachability: offline))
  }

  func test_foreground_redial_runs_before_any_path_has_been_observed() {
    XCTAssertTrue(SSHTerminalController.shouldRedialOnForeground(status: .disconnected, dialing: false, reachability: nil))
  }

  func test_foreground_redial_retries_a_failed_connection_on_a_usable_path() {
    XCTAssertTrue(SSHTerminalController.shouldRedialOnForeground(status: .failed("timed out"), dialing: false, reachability: usable))
  }

  // Copy must describe the real blocker. "Waiting for a network connection" on a
  // host-key mismatch would be a lie the user can't act on.
  func test_offline_copy_says_the_network_is_missing_not_the_host() {
    let copy = SSHTerminalController.connectionCopy(status: .disconnected, reachability: offline)
    XCTAssertEqual(copy?.message, "Waiting for a network connection")
    XCTAssertEqual(copy?.indicator, .warning(symbol: "wifi.slash"))
    XCTAssertEqual(copy?.indicator.offersRetry, false)
  }

  func test_requires_connection_copy_names_that_state() {
    let copy = SSHTerminalController.connectionCopy(status: .disconnected, reachability: needsConnection)
    XCTAssertEqual(copy?.message, "Network needs a connection")
    XCTAssertEqual(copy?.indicator.offersRetry, false)
  }

  func test_ssh_failure_on_a_usable_path_keeps_the_real_error() {
    let copy = SSHTerminalController.connectionCopy(status: .failed("Host key changed for homelab"), reachability: usable)
    XCTAssertEqual(copy?.message, "Host key changed for homelab")
    XCTAssertEqual(copy?.indicator.offersRetry, true)
  }

  func test_ssh_failure_while_offline_still_keeps_the_host_key_error() {
    // Network copy may never overwrite a security failure.
    let copy = SSHTerminalController.connectionCopy(status: .failed("Host key mismatch — refusing to connect"), reachability: offline)
    XCTAssertEqual(copy?.message, "Host key mismatch — refusing to connect")
  }

  func test_drop_on_a_usable_path_reads_as_reconnecting() {
    let copy = SSHTerminalController.connectionCopy(status: .disconnected, reachability: usable)
    XCTAssertEqual(copy?.message, "Connection lost — reconnecting…")
    XCTAssertEqual(copy?.indicator.offersRetry, false)
  }

  func test_connecting_reads_as_connecting_even_without_a_path_value() {
    let copy = SSHTerminalController.connectionCopy(status: .connecting, reachability: nil)
    XCTAssertEqual(copy?.message, "Connecting…")
  }

  func test_a_connected_session_has_no_status_copy() {
    XCTAssertNil(SSHTerminalController.connectionCopy(status: .connected, reachability: usable))
  }

  func test_a_manual_retry_dials_even_when_the_automatic_gate_would_refuse() {
    // The Retry button is the person answering the gate, so it does not ask it.
    XCTAssertTrue(SSHTerminalController.ConnectTrigger.manual.bypassesRecoveryGate)
    XCTAssertTrue(SSHTerminalController.ConnectTrigger.initial.bypassesRecoveryGate)
    XCTAssertFalse(SSHTerminalController.ConnectTrigger.foreground.bypassesRecoveryGate)
    XCTAssertFalse(SSHTerminalController.ConnectTrigger.networkPath.bypassesRecoveryGate)
  }

  func test_only_the_edge_onto_a_usable_path_asks_for_a_redial() {
    XCTAssertTrue(SSHTerminalController.pathBecameUsable(previous: offline, next: usable))
    XCTAssertTrue(SSHTerminalController.pathBecameUsable(previous: nil, next: usable))
    // The observer re-reports the same path on every interface change.
    XCTAssertFalse(SSHTerminalController.pathBecameUsable(previous: usable, next: usable))
    XCTAssertFalse(SSHTerminalController.pathBecameUsable(previous: usable, next: offline))
  }

  func test_retry_is_offered_only_where_the_art_says_something_went_wrong() {
    let copy = { (status: SSHTerminalController.Status, reach: NetworkReachability?) in
      SSHTerminalController.connectionCopy(status: status, reachability: reach)
    }
    XCTAssertNil(copy(.connected, usable), "a live session needs no overlay")
    XCTAssertEqual(copy(.connecting, usable)?.indicator, .spinner)
    XCTAssertEqual(copy(.disconnected, usable)?.indicator, .spinner)
    XCTAssertEqual(copy(.disconnected, offline)?.indicator, .warning(symbol: "wifi.slash"))
    XCTAssertEqual(copy(.failed("nope"), usable)?.indicator, .error(symbol: "exclamationmark.triangle"))

    XCTAssertTrue(copy(.failed("nope"), usable)?.indicator.offersRetry == true)
    for indicator in [copy(.connecting, usable), copy(.disconnected, usable), copy(.disconnected, offline)] {
      XCTAssertFalse(indicator?.indicator.offersRetry ?? true)
    }
  }

  func test_the_overlay_and_the_header_lamp_read_the_same_value() {
    XCTAssertEqual(SSHTerminalController.connectionCopy(status: .connecting, reachability: usable)?.shortLabel, "connecting")
    XCTAssertEqual(SSHTerminalController.connectionCopy(status: .disconnected, reachability: usable)?.shortLabel, "reconnecting")
    XCTAssertEqual(SSHTerminalController.connectionCopy(status: .disconnected, reachability: offline)?.shortLabel, "no network")
    XCTAssertEqual(SSHTerminalController.connectionCopy(status: .failed("x"), reachability: usable)?.shortLabel, "error")
  }
}
