import XCTest

@testable import TetherKit

final class TerminalOutputBufferTests: XCTestCase {
  func testAppendAccumulatesBytes() {
    let buffer = TerminalOutputBuffer()
    buffer.append(Data("ab".utf8))
    buffer.append(Data("cd".utf8))
    XCTAssertEqual(buffer.data, Data("abcd".utf8))
  }

  func testResetClearsTheBytes() {
    let buffer = TerminalOutputBuffer()
    buffer.append(Data("ab".utf8))
    buffer.reset()
    XCTAssertTrue(buffer.data.isEmpty)
  }

  func testOverBudgetKeepsTheNewestSuffix() {
    let buffer = TerminalOutputBuffer(byteBudget: 4)
    buffer.append(Data("abcdef".utf8))
    XCTAssertEqual(buffer.data, Data("cdef".utf8))
  }
}

final class TerminalResizeStrategyTests: XCTestCase {
  func testAltScreenSizeChangeRebuildsFromTheBuffer() {
    XCTAssertTrue(
      TerminalResizeStrategy.shouldRebuildFromBuffer(
        altScreen: true, oldCols: 20, oldRows: 8, newCols: 20, newRows: 12
      )
    )
    XCTAssertTrue(
      TerminalResizeStrategy.shouldRebuildFromBuffer(
        altScreen: true, oldCols: 80, oldRows: 24, newCols: 100, newRows: 24
      )
    )
  }

  func testPrimaryScreenShrinkAndColumnChangeKeepAlacrittyReflow() {
    // Shrink: reflow is clean, and rebuilding would drop scrollback past the
    // buffer budget for nothing.
    XCTAssertFalse(
      TerminalResizeStrategy.shouldRebuildFromBuffer(
        altScreen: false, oldCols: 20, oldRows: 12, newCols: 20, newRows: 8
      )
    )
    // Column-only change: alacritty's column reflow is correct here.
    XCTAssertFalse(
      TerminalResizeStrategy.shouldRebuildFromBuffer(
        altScreen: false, oldCols: 80, oldRows: 24, newCols: 100, newRows: 24
      )
    )
  }

  func testPrimaryScreenGrowRebuildsToAvoidReflowDuplication() {
    // A row grow on the primary screen makes alacritty's reflow duplicate a
    // content row into the newly exposed rows (the agent-TUI line-doubling bug).
    // Rebuild from the buffer at the new size instead.
    XCTAssertTrue(
      TerminalResizeStrategy.shouldRebuildFromBuffer(
        altScreen: false, oldCols: 20, oldRows: 8, newCols: 20, newRows: 12
      )
    )
  }

  func testSameSizeDoesNotRebuild() {
    XCTAssertFalse(
      TerminalResizeStrategy.shouldRebuildFromBuffer(
        altScreen: true, oldCols: 20, oldRows: 8, newCols: 20, newRows: 8
      )
    )
  }
}
