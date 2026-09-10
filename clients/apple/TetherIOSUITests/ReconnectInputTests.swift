import XCTest

/// Test #8 — typing into a session after the app is backgrounded and reopened.
/// Drives the real app: preseed a paired host, open a shell, type a baseline
/// command, background via the home button, reopen, then type again. The shell
/// orchestration asserts against the server (oracle events + terminal_logs)
/// whether the post-reopen keystrokes actually reached the PTY.
final class ReconnectInputTests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    if let seed = ProcessInfo.processInfo.environment["TETHER_UITEST_PRESEED"] {
      app.launchEnvironment["TETHER_UITEST_PRESEED"] = seed
    }
    app.launch()
    XCTAssertTrue(
      app.wait(for: .runningForeground, timeout: 15),
      "app never reached foreground (state=\(app.state.rawValue))")
    return app
  }

  private func focusAndType(_ app: XCUIApplication, _ text: String) {
    // Tapping the surface runs the app's onTap -> keyboardFocused = true, which
    // makes the hidden input the first responder (keyboard up). Tapping the 1pt
    // input directly does not, so type only after the surface tap.
    let surface = app.descendants(matching: .any)["terminalSurface"].firstMatch
    XCTAssertTrue(surface.waitForExistence(timeout: 15), "terminal surface never appeared")
    surface.tap()
    let input = app.textViews["terminalInput"].firstMatch
    _ = input.waitForExistence(timeout: 5)
    app.typeText(text)
  }

  func testTypeAfterBackgroundReopen() throws {
    let app = launch()

    let newBtn = app.buttons["newTerminalButton"].firstMatch
    XCTAssertTrue(newBtn.waitForExistence(timeout: 15), "no New terminal button")
    newBtn.tap()

    // Baseline before backgrounding — proves the harness can drive input at all.
    focusAndType(app, "echo BEFORE_BG_OK\n")
    sleep(2)

    // The reconnect under test: background with the home button, then reopen.
    XCUIDevice.shared.press(.home)
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    XCTAssertTrue(
      springboard.wait(for: .runningForeground, timeout: 15),
      "home press never backgrounded the app")
    sleep(2)
    app.activate()
    XCTAssertTrue(
      app.wait(for: .runningForeground, timeout: 15),
      "app never returned to foreground")

    // The keystrokes the suite cares about: do they reach the PTY after reopen?
    focusAndType(app, "echo AFTER_REOPEN_OK\n")
    sleep(3)

    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "after-reopen"
    shot.lifetime = .keepAlways
    add(shot)
  }
}
