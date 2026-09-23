import XCTest
@testable import TetherKit

/// A mid-session transport drop must not leave the status at `.connected`: every
/// reconnect gate skips while `.connected`, so the terminal would stay dead.
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
}
