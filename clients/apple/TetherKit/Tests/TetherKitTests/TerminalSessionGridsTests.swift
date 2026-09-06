import XCTest

import TetherFFIBindings
@testable import TetherKit

/// Switch-back reuses the emulator and replays only missed log ids onto it.
/// A server `{t:reset}` is the one path that wipes the grid.
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

  func testResetWipesTheEmulatorAndByteBuffer() throws {
    let grid = TerminalSessionGrid(cols: 20, rows: 8)
    grid.emulator.feed(bytes: Data("kept".utf8))
    grid.buffer.append(Data("kept".utf8))
    grid.lastAltScreen = true
    grid.reset(cols: 20, rows: 8)
    XCTAssertTrue(grid.buffer.data.isEmpty)
    XCTAssertFalse(grid.lastAltScreen)
    let (header, cells) = try GridSnapshotDecoder.decode(grid.emulator.snapshot())
    let text = String(
      cells.prefix(Int(header.cols)).map { Character(UnicodeScalar($0.codepoint) ?? " ") }
    ).trimmingCharacters(in: .whitespaces)
    XCTAssertEqual(text, "")
  }
}
