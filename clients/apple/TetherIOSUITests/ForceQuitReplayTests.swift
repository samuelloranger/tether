import XCTest

/// Test #10 — a HARD force-quit must not lose the session. The PTY lives in a
/// detached holder, so terminating the app and relaunching should re-adopt the
/// shell and replay what it printed while the app was dead.
final class ForceQuitReplayTests: TetherUITestCase {
  func testSessionSurvivesForceQuitAndReplaysMissedOutput() throws {
    let app = launchApp()
    tapNewTerminal(app)

    // BEFORE_QUIT renders now; AFTER_QUIT_MARK fires ~6s later, after the app is
    // dead, so the server produces it with no client attached at all.
    focusAndType(app, "echo BEFORE_QUIT; sleep 6; echo AFTER_QUIT_MARK\n")
    sleep(2)

    app.terminate()
    XCTAssertTrue(app.wait(for: .notRunning, timeout: 15), "app never terminated")
    let dead = expectation(description: "app dead")
    _ = XCTWaiter.wait(for: [dead], timeout: 8)

    let relaunched = launchApp()
    sleep(4)
    dumpGrid(relaunched, "client-grid-after-relaunch")
  }
}
