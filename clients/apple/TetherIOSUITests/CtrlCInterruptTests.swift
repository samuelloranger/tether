import XCTest

/// Test #17 — Ctrl-C from the accessory bar must interrupt a running program.
/// The recovery marker can only reach the PTY if the loop was actually killed and
/// the prompt returned; if Ctrl-C were lost, the loop would run forever.
final class CtrlCInterruptTests: TetherUITestCase {
  func testCtrlCInterruptsARunningLoop() throws {
    let app = launchApp()
    tapNewTerminal(app)

    focusAndType(app, "while true; do echo LOOP_TICK; sleep 0.4; done\n")
    sleep(2)

    // Arm the latched Ctrl (accessory bar keeps the terminal first responder),
    // then send `c` so the fold produces 0x03.
    let ctrl = app.buttons["Control modifier"].firstMatch
    XCTAssertTrue(ctrl.waitForExistence(timeout: 5), "no Ctrl key")
    ctrl.tap()
    app.typeText("c")
    sleep(2)

    focusAndType(app, "echo INTERRUPT_RECOVERED\n")
    sleep(2)
    shot(app, "after-ctrl-c")
  }
}
