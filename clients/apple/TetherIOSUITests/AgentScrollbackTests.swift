import XCTest

/// Test #14 — the faithful repro: run a REAL agent TUI (cursor-agent; Claude Code
/// hits the user's session limit) in a session, have it print pages of output,
/// switch away, switch back BY IDENTITY, and capture SCREENSHOTS at each step.
/// Assertions are made by a human/vision review of the screenshots (ground truth
/// of what the surface renders) — never the store.terminalSnapshot seam.
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

    // Slow printer lives at ~/.tether-e2e/slowprint.py (dropped by the
    // orchestration script). A one-shot 120-line dump finishes before we can
    // switch (11:31 run: agent-ready already showed 097–120).
    app.typeText(
      "cursor-agent -f Run python3 $HOME/.tether-e2e/slowprint.py and stream its live "
        + "stdout. Do not write any other files.\n")
    sleep(12) // TUI boot + first lines
    surface(app).tap()
    shot(app, "agent-ready")

    // Switch away to B while A is still printing (~48s of output).
    newBtn.tap()
    sleep(2)
    let bId = activeId(app)
    print("B_ID=\(bId)")
    shot(app, "agent-away")
    sleep(50)

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
