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

  func testOverBudgetKeepsTheNewestTwoThirds() {
    let buffer = TerminalOutputBuffer(byteBudget: 6)
    buffer.append(Data("abcdefg".utf8))
    XCTAssertEqual(buffer.data, Data("defg".utf8))
  }

  func testAfterATrimTheNextAppendsDoNotTrimAgain() {
    let buffer = TerminalOutputBuffer(byteBudget: 6)
    buffer.append(Data("abcdefg".utf8))
    buffer.append(Data("h".utf8))
    buffer.append(Data("i".utf8))
    XCTAssertEqual(buffer.data, Data("defghi".utf8), "at budget, not over it: no copy")
    buffer.append(Data("j".utf8))
    XCTAssertEqual(buffer.data, Data("ghij".utf8))
  }

  func testTheBufferNeverHoldsMoreThanItsBudget() {
    let buffer = TerminalOutputBuffer(byteBudget: 6)
    for _ in 0..<50 {
      buffer.append(Data("xyz".utf8))
      XCTAssertLessThanOrEqual(buffer.data.count, 6)
    }
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

  func testPrimaryScreenShrinkAndColumnChangeKeepTheEmulatorReflow() {
    // Shrink: reflow is clean, and rebuilding would drop scrollback past the
    // buffer budget for nothing.
    XCTAssertFalse(
      TerminalResizeStrategy.shouldRebuildFromBuffer(
        altScreen: false, oldCols: 20, oldRows: 12, newCols: 20, newRows: 8
      )
    )
    // Column-only change: the emulator's column reflow is correct here.
    XCTAssertFalse(
      TerminalResizeStrategy.shouldRebuildFromBuffer(
        altScreen: false, oldCols: 80, oldRows: 24, newCols: 100, newRows: 24
      )
    )
  }

  func testPrimaryScreenGrowRebuildsToAvoidReflowDuplication() {
    // A row grow on the primary screen can make the reflow duplicate a
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

final class TerminalOutputBufferReplayTests: XCTestCase {
  func testReplayRebuildsTheGridWithoutAnsweringOldQueries() {
    let buffer = TerminalOutputBuffer()
    buffer.append(Data("hi\u{1B}[6n".utf8))
    let engine = buffer.replay(cols: 20, rows: 5)
    XCTAssertEqual(rowText(engine.frame(), 0), "hi")
    XCTAssertTrue(engine.takeReplies().isEmpty, "replayed history must not re-answer queries")
  }
}
