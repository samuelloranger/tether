import XCTest

/// Test #12 — a shell that EXITS while the app is backgrounded must show as
/// stopped on reopen, not as a live tab. A natural exit keeps the row (unlike an
/// explicit kill, which removes it), so the reader still sees the session ended.
final class ReopenExitStateTests: TetherUITestCase {
  func testExitWhileBackgroundedShowsStoppedOnReopen() throws {
    let app = launchApp()
    tapNewTerminal(app)

    // The shell exits ~4s from now — after we background it.
    focusAndType(app, "echo LEAVING_SOON; sleep 4; exit\n")
    sleep(1)

    XCUIDevice.shared.press(.home)
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    XCTAssertTrue(springboard.wait(for: .runningForeground, timeout: 15), "did not background")
    let hold = expectation(description: "backgrounded")
    _ = XCTWaiter.wait(for: [hold], timeout: 10)

    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15), "did not reopen")
    sleep(3)

    openDrawer(app)
    let stopped = app.staticTexts["stopped"].firstMatch
    let appeared = stopped.waitForExistence(timeout: 10)
    shot(app, appeared ? "reopen-stopped" : "reopen-NOT-stopped")
    XCTAssertTrue(
      appeared, "session that exited while backgrounded did not show as stopped after reopen")
  }
}
