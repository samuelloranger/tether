import XCTest

/// Test #1 — output produced WHILE the app is backgrounded: does the client still
/// show it after reopening? Types a line that prints one marker immediately and a
/// second marker after a delay (which fires while backgrounded, once iOS has
/// suspended the socket). After reopening it dumps the client's rendered grid so
/// the orchestration can compare what the CLIENT shows against the server's
/// terminal_logs — the Noise path does no replay, so this measures the gap.
final class ReconnectReplayTests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  private func focusAndType(_ app: XCUIApplication, _ text: String) {
    let surface = app.descendants(matching: .any)["terminalSurface"].firstMatch
    XCTAssertTrue(surface.waitForExistence(timeout: 15), "terminal surface never appeared")
    surface.tap()
    _ = app.textViews["terminalInput"].firstMatch.waitForExistence(timeout: 5)
    app.typeText(text)
  }

  func testOutputWhileBackgrounded() throws {
    let app = XCUIApplication()
    if let seed = ProcessInfo.processInfo.environment["TETHER_UITEST_PRESEED"] {
      app.launchEnvironment["TETHER_UITEST_PRESEED"] = seed
    }
    app.launch()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))

    let newBtn = app.buttons["newTerminalButton"].firstMatch
    XCTAssertTrue(newBtn.waitForExistence(timeout: 15), "no New terminal button")
    newBtn.tap()

    // VISIBLE_BEFORE renders immediately; GAP_AFTER fires ~4s later — after we
    // background — so the server produces it while the client's socket is asleep.
    focusAndType(app, "echo VISIBLE_BEFORE; sleep 4; echo GAP_AFTER\n")
    sleep(1)

    XCUIDevice.shared.press(.home)
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    XCTAssertTrue(springboard.wait(for: .runningForeground, timeout: 15), "did not background")
    // Long enough for the delayed echo to fire and the socket to be suspended.
    let hold = expectation(description: "backgrounded")
    _ = XCTWaiter.wait(for: [hold], timeout: 12)

    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15), "did not reopen")
    sleep(3)

    let grid = app.staticTexts["terminalGrid"].firstMatch
    XCTAssertTrue(grid.waitForExistence(timeout: 10), "no terminalGrid element")
    let text = grid.label
    // Dumped for the orchestration shell to inspect (server oracle can't see the
    // client's rendered grid).
    print("GRID_DUMP_START")
    print(text)
    print("GRID_DUMP_END")
    let attach = XCTAttachment(string: text)
    attach.name = "client-grid"
    attach.lifetime = .keepAlways
    add(attach)
  }
}
