import XCTest
@testable import TetherKit

/// A mid-session transport drop must not leave the status at `.connected`:
/// every reconnect gate skips while `.connected`, so a stale value meant the
/// terminal stayed dead until the app was force-quit.
final class SSHTerminalControllerStatusTests: XCTestCase {
  func test_transport_drop_while_connected_flips_off_connected() {
    XCTAssertEqual(
      SSHTerminalController.statusAfterTransportDrop(from: .connected),
      .disconnected
    )
  }

  func test_transport_drop_during_a_reconnect_is_ignored() {
    // A late error from the old transport must not disturb an in-flight redial.
    XCTAssertNil(SSHTerminalController.statusAfterTransportDrop(from: .connecting))
  }

  func test_transport_drop_from_failed_retries() {
    XCTAssertEqual(
      SSHTerminalController.statusAfterTransportDrop(from: .failed("nope")),
      .disconnected
    )
  }

  // A session switch typed at a shell prompt lands, but a full-screen CLI agent
  // (alt-screen) would echo the keystrokes literally — there it must redial.
  func test_switch_at_shell_prompt_types_in_place() {
    XCTAssertEqual(
      SSHTerminalController.switchStrategy(connected: true, altScreen: false),
      .typeInPlace
    )
  }

  func test_switch_inside_a_full_screen_agent_redials() {
    XCTAssertEqual(
      SSHTerminalController.switchStrategy(connected: true, altScreen: true),
      .redial
    )
  }

  func test_switch_while_disconnected_redials() {
    XCTAssertEqual(
      SSHTerminalController.switchStrategy(connected: false, altScreen: false),
      .redial
    )
  }
}
