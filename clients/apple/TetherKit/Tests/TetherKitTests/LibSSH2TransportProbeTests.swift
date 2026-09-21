import XCTest
@testable import TetherKit

final class LibSSH2TransportProbeTests: XCTestCase {
  /// Break caught: removing the libssh2 binary/module exposure makes the transport
  /// probe unavailable, so the v5 SSH calls can no longer be compiled or linked.
  func test_probe_reports_the_linked_libssh2_version() {
    XCTAssertFalse(LibSSH2TransportProbe.libraryVersion.isEmpty)
  }
}
