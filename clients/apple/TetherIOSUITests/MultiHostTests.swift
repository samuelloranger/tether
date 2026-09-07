import XCTest

/// Test #21 — two paired hosts must coexist: the drawer groups sessions by host,
/// and opening a terminal on each reaches THAT server independently. Both hosts
/// (e2e, e2e2) are preseeded; the orchestration confirms each server logged its
/// own session.
final class MultiHostTests: TetherUITestCase {
  func testTwoHostsEachGetTheirOwnSession() throws {
    let app = launchApp()
    openDrawer(app)

    let newOnHost1 = app.buttons["New terminal on e2e"].firstMatch
    let newOnHost2 = app.buttons["New terminal on e2e2"].firstMatch
    XCTAssertTrue(newOnHost1.waitForExistence(timeout: 15), "host e2e not shown in drawer")
    XCTAssertTrue(newOnHost2.waitForExistence(timeout: 15), "host e2e2 not shown in drawer")

    // A terminal on host 1 (the row closes the drawer on tap).
    newOnHost1.tap()
    XCTAssertTrue(
      app.descendants(matching: .any)["terminalSurface"].firstMatch.waitForExistence(timeout: 15),
      "session on host e2e never opened")
    sleep(2)

    // A terminal on host 2.
    openDrawer(app)
    let newOnHost2Again = app.buttons["New terminal on e2e2"].firstMatch
    XCTAssertTrue(newOnHost2Again.waitForExistence(timeout: 10), "host e2e2 row gone")
    newOnHost2Again.tap()
    sleep(3)

    openDrawer(app)
    let rows = app.descendants(matching: .any).matching(identifier: "sessionRow")
    XCTAssertTrue(rows.element(boundBy: 1).waitForExistence(timeout: 10), "expected a session per host")
    shot(app, "two-hosts")
  }
}
