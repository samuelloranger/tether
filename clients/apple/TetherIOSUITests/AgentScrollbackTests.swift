import XCTest

/// Test #14 — the faithful repro: run REAL Claude Code (a TUI agent) in a session,
/// have it print pages of output, switch away, switch back BY IDENTITY, and
/// capture SCREENSHOTS at each step. Assertions are made by a human/vision review
/// of the screenshots (ground truth of what the surface renders) — never the
/// store.terminalSnapshot seam, which proved unreliable.
final class AgentScrollbackTests: XCTestCase {
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

  private func shot(_ app: XCUIApplication, _ name: String) {
    let a = XCTAttachment(screenshot: app.screenshot())
    a.name = name
    a.lifetime = .keepAlways
    add(a)
  }

  func testAgentScrollbackAcrossSwitch() throws {
    let app = XCUIApplication()
    if let seed = ProcessInfo.processInfo.environment["TETHER_UITEST_PRESEED"] {
      app.launchEnvironment["TETHER_UITEST_PRESEED"] = seed
    }
    app.launch()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))

    let newBtn = app.buttons["newTerminalButton"].firstMatch
    XCTAssertTrue(newBtn.waitForExistence(timeout: 15), "no New terminal button")

    // Session A.
    newBtn.tap()
    XCTAssertTrue(surface(app).waitForExistence(timeout: 15), "session A never opened")
    surface(app).tap()
    _ = app.textViews["terminalInput"].firstMatch.waitForExistence(timeout: 5)
    sleep(1)
    let aId = activeId(app)
    print("A_ID=\(aId)")

    // Launch Claude Code. The folder is pre-trusted (orchestration sets
    // hasTrustDialogAccepted), so no trust prompt should appear.
    app.typeText("claude\n")
    sleep(20) // claude TUI boot
    surface(app).tap()
    shot(app, "agent-ready")

    // Deterministic, paged request.
    app.typeText(
      "Print exactly the lines SCROLL_LINE_001 through SCROLL_LINE_120, one per line, "
        + "zero-padded to three digits, and nothing else.")
    sleep(1)
    app.typeText("\r")
    sleep(45) // let it stream pages of output
    shot(app, "agent-active")

    // Switch away to B while output is on A.
    newBtn.tap()
    sleep(2)
    let bId = activeId(app)
    print("B_ID=\(bId)")
    sleep(15)

    // Switch back to A by identity.
    var switched = false
    for attempt in 0..<4 where !switched {
      app.buttons["Open session list"].firstMatch.tap()
      let rows = app.descendants(matching: .any).matching(identifier: "sessionRow")
      XCTAssertTrue(rows.element(boundBy: 0).waitForExistence(timeout: 10), "no session rows")
      rows.element(boundBy: attempt % max(rows.count, 1)).tap()
      sleep(2)
      if activeId(app) == aId { switched = true }
    }
    XCTAssertTrue(switched, "could not switch back to A (active=\(activeId(app)) wanted=\(aId))")

    surface(app).tap()
    sleep(2)
    print("SWITCHBACK_ACTIVE=\(activeId(app))")
    shot(app, "agent-switchback")

    // Scroll up to look for the agent's earlier output.
    for _ in 0..<12 { surface(app).swipeDown() }
    sleep(1)
    shot(app, "agent-scrollup")
  }
}
