import XCTest

/// Test #14 — the server can restart under a live session without losing it. The
/// session touches a trigger file on the HOST (the PTY runs there), which the
/// orchestration watches to restart the daemon at exactly this point; a marker
/// fires afterward and must reach the reconnected client.
final class ServerRestartTests: TetherUITestCase {
  func testSessionSurvivesServerRestart() throws {
    let app = launchApp()
    tapNewTerminal(app)

    // touch the trigger -> orchestration restarts the daemon ~1s later.
    // AFTER_RESTART_MARK fires at +12s, so it only reaches the client if the
    // holder survived and the client reconnected.
    focusAndType(
      app,
      "touch ~/.tether-e2e/RESTART_NOW; echo BEFORE_RESTART; sleep 12; echo AFTER_RESTART_MARK\n")

    let wait = expectation(description: "restart cycle")
    _ = XCTWaiter.wait(for: [wait], timeout: 22)
    dumpGrid(app, "client-grid-after-restart")
  }
}
