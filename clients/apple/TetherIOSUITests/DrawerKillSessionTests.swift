import XCTest

/// Test #20 — killing a session from the drawer removes it. The server-side
/// `session_kill` event proves the kill fired; here we drive the kebab menu and
/// confirm the app survives.
final class DrawerKillSessionTests: TetherUITestCase {
  func testKillFromDrawerRemovesTheSession() throws {
    let app = launchApp()
    tapNewTerminal(app)
    sleep(1)
    tapNewTerminal(app)
    sleep(2)

    openDrawer(app)

    // SwiftUI Menu drops accessibilityIdentifier, so drive it by label. The
    // kebab trigger is labelled "Kill terminal"; the destructive item carries a
    // distinct "Confirm kill terminal" so the two don't collide.
    let trigger = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label == %@", "Kill terminal")).firstMatch
    XCTAssertTrue(trigger.waitForExistence(timeout: 10), "no kill menu in drawer")
    trigger.tap()
    let item = app.buttons["Confirm kill terminal"].firstMatch
    XCTAssertTrue(item.waitForExistence(timeout: 5), "kill menu did not present")
    item.tap()
    sleep(3)

    XCTAssertTrue(
      app.buttons["newTerminalButton"].firstMatch.waitForExistence(timeout: 10),
      "app not usable after kill")
    shot(app, "after-kill")
  }
}
