import XCTest

/// Shared harness for the Tether iOS E2E suite. Every real-UI test needs the same
/// four things — preseed injection, a launched foreground app, focus-then-type
/// into the terminal (with the first-keystroke warm-up), and a way to hand the
/// rendered grid or a screenshot back to the orchestration — so they live here
/// once instead of being copy-pasted into each test.
class TetherUITestCase: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  /// An app carrying whatever preseed / deep-link fixtures the runner forwarded.
  func makeApp() -> XCUIApplication {
    let app = XCUIApplication()
    let env = ProcessInfo.processInfo.environment
    for key in ["TETHER_UITEST_PRESEED", "TETHER_UITEST_PRESEED2", "TETHER_UITEST_DEEPLINK"] {
      if let value = env[key] { app.launchEnvironment[key] = value }
    }
    return app
  }

  /// Launch (making a fresh app if none is given) and wait for the foreground.
  @discardableResult
  func launchApp(_ app: XCUIApplication? = nil) -> XCUIApplication {
    let a = app ?? makeApp()
    a.launch()
    XCTAssertTrue(
      a.wait(for: .runningForeground, timeout: 15),
      "app never reached foreground (state=\(a.state.rawValue))")
    return a
  }

  /// Tap "new terminal" and wait for the button to be there first.
  func tapNewTerminal(_ app: XCUIApplication) {
    let newBtn = app.buttons["newTerminalButton"].firstMatch
    XCTAssertTrue(newBtn.waitForExistence(timeout: 15), "no New terminal button")
    newBtn.tap()
  }

  /// Tap the surface (raises the keyboard) then type. The first keystroke after
  /// focus is dropped before the hidden input is first responder, so warm up with
  /// a throwaway newline before the real text.
  func focusAndType(_ app: XCUIApplication, _ text: String) {
    let surface = app.descendants(matching: .any)["terminalSurface"].firstMatch
    XCTAssertTrue(surface.waitForExistence(timeout: 15), "terminal surface never appeared")
    surface.tap()
    _ = app.textViews["terminalInput"].firstMatch.waitForExistence(timeout: 5)
    usleep(800_000)
    app.typeText("\n")
    usleep(300_000)
    app.typeText(text)
  }

  func openDrawer(_ app: XCUIApplication) {
    let drawer = app.buttons["Open session list"].firstMatch
    XCTAssertTrue(drawer.waitForExistence(timeout: 10), "no drawer button")
    drawer.tap()
  }

  /// Print the client's rendered grid between markers (so the shell oracle can
  /// read it out of the xcodebuild log) and attach it to the result.
  func dumpGrid(_ app: XCUIApplication, _ name: String) {
    let grid = app.staticTexts["terminalGrid"].firstMatch
    XCTAssertTrue(grid.waitForExistence(timeout: 10), "no terminalGrid element")
    let text = grid.label
    print("GRID_DUMP_START")
    print(text)
    print("GRID_DUMP_END")
    attach(string: text, name: name)
  }

  func shot(_ app: XCUIApplication, _ name: String) {
    let a = XCTAttachment(screenshot: app.screenshot())
    a.name = name
    a.lifetime = .keepAlways
    add(a)
  }

  func attach(string: String, name: String) {
    let a = XCTAttachment(string: string)
    a.name = name
    a.lifetime = .keepAlways
    add(a)
  }
}
