import XCTest

import TetherFFIBindings
@testable import TetherKit

/// Noise `start` does not replay history. The only way switch-back is not a
/// void is to keep the emulator that already holds the TUI.
final class TerminalSessionGridsTests: XCTestCase {
  func testFirstAttachIsAFreshEmulator() {
    let grids = TerminalSessionGrids()
    let first = grids.attach(key: "h:term-1", cols: 20, rows: 8)
    XCTAssertFalse(first.reused)
  }

  func testSwitchingAwayAndBackReusesTheEmulator() throws {
    let grids = TerminalSessionGrids()
    let first = grids.attach(key: "h:term-1", cols: 20, rows: 8)
    first.grid.emulator.feed(bytes: Data("kept".utf8))
    _ = grids.attach(key: "h:term-2", cols: 20, rows: 8)
    let again = grids.attach(key: "h:term-1", cols: 20, rows: 8)
    XCTAssertTrue(again.reused)
    let (header, cells) = try GridSnapshotDecoder.decode(again.grid.emulator.snapshot())
    let text = String(
      cells.prefix(Int(header.cols)).map { Character(UnicodeScalar($0.codepoint) ?? " ") }
    ).trimmingCharacters(in: .whitespaces)
    XCTAssertTrue(text.hasPrefix("kept"))
  }

  func testForgetDropsTheEmulatorSoTheNextAttachIsFresh() {
    let grids = TerminalSessionGrids()
    _ = grids.attach(key: "h:term-1", cols: 20, rows: 8)
    grids.forget("h:term-1")
    XCTAssertFalse(grids.attach(key: "h:term-1", cols: 20, rows: 8).reused)
  }
}
