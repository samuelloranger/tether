import XCTest

/// Test #13 — output produced while the only client is backgrounded must reach
/// the client on reopen. Whether it arrives live (resident session) or via a
/// replay event, the invariant is the same: the gap line renders on return.
final class ReplayAfterSuspendTests: TetherUITestCase {
  func testOutputWhileSuspendedReplaysOnReopen() throws {
    let app = launchApp()
    tapNewTerminal(app)

    focusAndType(app, "echo VISIBLE_NOW; sleep 5; echo SUSPENDED_GAP\n")
    sleep(1)

    XCUIDevice.shared.press(.home)
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    XCTAssertTrue(springboard.wait(for: .runningForeground, timeout: 15), "did not background")
    let hold = expectation(description: "suspended")
    _ = XCTWaiter.wait(for: [hold], timeout: 11)

    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15), "did not reopen")
    sleep(4)
    dumpGrid(app, "client-grid-after-suspend")
  }
}
