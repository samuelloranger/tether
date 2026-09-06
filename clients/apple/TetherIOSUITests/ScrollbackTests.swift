import XCTest

/// Test #13 — the real-device symptom: after a tab produces pages of output WHILE
/// INACTIVE, switching back shows only the current viewport and scrollback is
/// gone. Terminal A prints 120 numbered lines; we switch to B while it prints,
/// wait, then switch back TO A BY IDENTITY (verified via the activeSession
/// element, not a fragile row index) and read the grid. The orchestration
/// compares the client's rendered grid against the server's terminal_logs.
final class ScrollbackTests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  private func surface(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)["terminalSurface"].firstMatch
  }

  private func activeId(_ app: XCUIApplication) -> String {
    let el = app.staticTexts["activeSession"].firstMatch
    _ = el.waitForExistence(timeout: 5)
    return el.label
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

    // Terminal A + its id.
    newBtn.tap()
    let surfaceA = surface(app)
    XCTAssertTrue(surfaceA.waitForExistence(timeout: 15), "session A never opened")
    surfaceA.tap()
    _ = app.textViews["terminalInput"].firstMatch.waitForExistence(timeout: 5)
    sleep(1)
    let aId = activeId(app)
    print("A_ID=\(aId)")
    XCTAssertFalse(aId.isEmpty && aId == "-", "no active session for A")

    app.typeText("for i in $(seq 1 120); do printf 'SCROLL_LINE_%03d\\n' $i; sleep 0.12; done\n")
    sleep(4)
    dumpGrid(app, "PRESWITCH")
    let active = XCTAttachment(screenshot: app.screenshot())
    active.name = "active-keyboard"
    active.lifetime = .keepAlways
    add(active)

    // Switch AWAY to B while A prints.
    newBtn.tap()
    sleep(2)
    let bId = activeId(app)
    print("B_ID=\(bId)")
    XCTAssertNotEqual(aId, bId, "B did not become a distinct active session")
    sleep(18) // A keeps producing while inactive

    // Switch BACK to A BY IDENTITY: tap each drawer row until active == aId.
    var switched = false
    for attempt in 0..<4 where !switched {
      app.buttons["Open session list"].firstMatch.tap()
      let rows = app.descendants(matching: .any).matching(identifier: "sessionRow")
      XCTAssertTrue(rows.element(boundBy: 0).waitForExistence(timeout: 10), "no session rows")
      let count = rows.count
      let idx = attempt % max(count, 1)
      rows.element(boundBy: idx).tap()
      sleep(2)
      if activeId(app) == aId { switched = true }
    }
    XCTAssertTrue(switched, "could not switch back to A (active=\(activeId(app)) wanted=\(aId))")

    surface(app).tap()
    sleep(1)
    print("SWITCHBACK_ACTIVE=\(activeId(app))")
    dumpGrid(app, "SWITCHBACK")

    for _ in 0..<10 { surface(app).swipeDown() }
    sleep(1)
    dumpGrid(app, "SCROLLUP")

    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "scrollback"
    shot.lifetime = .keepAlways
    add(shot)
  }
}
