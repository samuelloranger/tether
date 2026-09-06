import XCTest

/// Test #13 — the real-device symptom: after a tab produces pages of output WHILE
/// INACTIVE, switching back shows only the current viewport and scrollback is
/// gone (can't scroll up). Terminal A prints 120 numbered lines over ~15s; we
/// switch to B while it prints, wait for it to finish, switch back to A with the
/// keyboard up, read the grid, scroll up, and read again. The orchestration
/// compares the client's rendered grid against the server's terminal_logs.
final class ScrollbackTests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  private func surface(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)["terminalSurface"].firstMatch
  }

  private func dumpGrid(_ app: XCUIApplication, _ tag: String) {
    let grid = app.staticTexts["terminalGrid"].firstMatch
    _ = grid.waitForExistence(timeout: 10)
    print("GRID_\(tag)_START")
    print(grid.label)
    print("GRID_\(tag)_END")
  }

  func testScrollbackSurvivesInactiveTab() throws {
    let app = XCUIApplication()
    if let seed = ProcessInfo.processInfo.environment["TETHER_UITEST_PRESEED"] {
      app.launchEnvironment["TETHER_UITEST_PRESEED"] = seed
    }
    app.launch()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))

    let newBtn = app.buttons["newTerminalButton"].firstMatch
    XCTAssertTrue(newBtn.waitForExistence(timeout: 15), "no New terminal button")

    // Terminal A: start a slow loop that scrolls ~120 lines over ~15s.
    newBtn.tap()
    let surfaceA = surface(app)
    XCTAssertTrue(surfaceA.waitForExistence(timeout: 15), "session A never opened")
    surfaceA.tap()
    _ = app.textViews["terminalInput"].firstMatch.waitForExistence(timeout: 5)
    app.typeText("for i in $(seq 1 120); do printf 'SCROLL_LINE_%03d\\n' $i; sleep 0.12; done\n")
    sleep(2)

    // Switch AWAY to a new tab while A is still printing.
    newBtn.tap()
    sleep(20) // A keeps producing lines while inactive, then finishes

    // Switch BACK to A via the drawer.
    let drawer = app.buttons["Open session list"].firstMatch
    XCTAssertTrue(drawer.waitForExistence(timeout: 10), "no drawer button")
    drawer.tap()
    // Sessions list newest-first (created_at DESC), so the busy terminal A — made
    // before B — is row 1. Switching to it is the whole point of the test.
    let rows = app.descendants(matching: .any).matching(identifier: "sessionRow")
    XCTAssertTrue(rows.element(boundBy: 1).waitForExistence(timeout: 10), "no session row 1 (A)")
    rows.element(boundBy: 1).tap()
    sleep(3)

    // Keyboard up, like the real repro.
    surface(app).tap()
    sleep(1)
    dumpGrid(app, "SWITCHBACK")

    // Try to scroll up into scrollback.
    for _ in 0..<10 {
      surface(app).swipeDown()
    }
    sleep(1)
    dumpGrid(app, "SCROLLUP")

    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "scrollback"
    shot.lifetime = .keepAlways
    add(shot)
  }
}
