import XCTest

@testable import TetherKit

final class TerminalOutputBufferTests: XCTestCase {
  func testAppendAccumulatesBytes() {
    var buffer = TerminalOutputBuffer()
    buffer.append(Data("ab".utf8))
    buffer.append(Data("cd".utf8))
    XCTAssertEqual(buffer.data, Data("abcd".utf8))
  }

  func testResetClearsTheBytes() {
    var buffer = TerminalOutputBuffer()
    buffer.append(Data("ab".utf8))
    buffer.reset()
    XCTAssertTrue(buffer.data.isEmpty)
  }

  func testOverBudgetKeepsTheNewestSuffix() {
    var buffer = TerminalOutputBuffer(byteBudget: 4)
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

  func testPrimaryScreenKeepsAlacrittyReflow() {
    XCTAssertFalse(
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
