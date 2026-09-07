import XCTest

/// Test #9 — a tab left running an agent must render its CURRENT screen on
/// return, not a stale or blank one. Two synthetic agents (standing in for
/// claude / cursor-agent) repaint for ~30s while one tab is backgrounded, then
/// we switch back. The oracle (run-bg-accumulation.sh) checks both sentinels
/// persisted and the switch-back re-subscribed live + kicked a SIGWINCH repaint.
final class BackgroundAccumulationRenderTests: TetherUITestCase {
  func testAgentOutputWhileTabbedAwayRendersOnReturn() throws {
    let app = launchApp()
    tapNewTerminal(app)
    focusAndType(app, "bash ~/.tether-e2e/agent-generator.sh AGENT_A 30\n")
    sleep(1)
    shot(app, "01-agentA-started")

    tapNewTerminal(app)
    focusAndType(app, "bash ~/.tether-e2e/agent-generator.sh AGENT_B 30\n")

    // Both agents pump for the full run while A is backgrounded and B is active.
    sleep(32)
    shot(app, "02-after-30s-on-B")

    // Switch back through both tabs; each switch-back drops and re-opens the
    // Noise socket, forcing the repaint the oracle checks.
    for index in [0, 1] {
      openDrawer(app)
      let rows = app.descendants(matching: .any).matching(identifier: "sessionRow")
      XCTAssertTrue(
        rows.element(boundBy: index).waitForExistence(timeout: 10), "no session row \(index)")
      rows.element(boundBy: index).tap()
      sleep(3)
      shot(app, "03-switched-to-\(index)")
    }
  }
}
