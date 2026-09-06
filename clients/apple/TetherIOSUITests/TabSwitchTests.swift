import XCTest

/// Test #5 — switching between session tabs must repaint. A full-screen TUI only
/// redraws on SIGWINCH, and the Noise reattach does not replay, so on switch-back
/// to a live session the server must kick the PTY size. This drives two sessions,
/// switches between them via the drawer, and the orchestration asserts the server
/// emitted `sigwinch` + a `noise_start` with wasLive=true.
final class TabSwitchTests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  func testSwitchBackRepaints() throws {
    let app = XCUIApplication()
    if let seed = ProcessInfo.processInfo.environment["TETHER_UITEST_PRESEED"] {
      app.launchEnvironment["TETHER_UITEST_PRESEED"] = seed
    }
    app.launch()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))

    let newBtn = app.buttons["newTerminalButton"].firstMatch
    XCTAssertTrue(newBtn.waitForExistence(timeout: 15), "no New terminal button")

    // Two live sessions.
    newBtn.tap()
    XCTAssertTrue(
      app.descendants(matching: .any)["terminalSurface"].firstMatch.waitForExistence(timeout: 15),
      "first session never opened")
    sleep(1)
    newBtn.tap()
    sleep(2)

    // Switch to each tab via the drawer; at least one is a switch-back to a live,
    // non-active session, which is what triggers the SIGWINCH kick.
    for index in [0, 1] {
      let drawer = app.buttons["Open session list"].firstMatch
      XCTAssertTrue(drawer.waitForExistence(timeout: 10), "no drawer button")
      drawer.tap()
      let rows = app.descendants(matching: .any).matching(identifier: "sessionRow")
      XCTAssertTrue(rows.element(boundBy: index).waitForExistence(timeout: 10), "no session row \(index)")
      rows.element(boundBy: index).tap()
      sleep(2)
    }

    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "after-switch"
    shot.lifetime = .keepAlways
    add(shot)
  }
}
