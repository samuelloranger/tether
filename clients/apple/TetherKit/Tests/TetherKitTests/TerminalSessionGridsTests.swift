import XCTest

@testable import TetherKit

/// Switch-back reuses the emulator and its grid.
final class TerminalSessionGridsTests: XCTestCase {
  func testFirstAttachIsAFreshEmulator() {
    let grids = TerminalSessionGrids()
    let first = grids.attach(key: "h:term-1", cols: 20, rows: 8)
    XCTAssertFalse(first.reused)
  }

  func testSwitchingAwayAndBackReusesTheEmulator() {
    let grids = TerminalSessionGrids()
    let first = grids.attach(key: "h:term-1", cols: 20, rows: 8)
    first.grid.emulator.feed(Data("kept".utf8))
    _ = grids.attach(key: "h:term-2", cols: 20, rows: 8)
    let again = grids.attach(key: "h:term-1", cols: 20, rows: 8)
    XCTAssertTrue(again.reused)
    XCTAssertTrue(rowText(again.grid.emulator.frame(), 0).hasPrefix("kept"))
  }
}
