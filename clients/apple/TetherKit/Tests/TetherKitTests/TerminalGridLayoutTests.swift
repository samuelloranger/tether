import XCTest
@testable import TetherKit

final class TerminalGridLayoutTests: XCTestCase {
  private func cells(_ rows: [String], cols: Int) -> [GridSnapshot.Cell] {
    rows.flatMap { row -> [GridSnapshot.Cell] in
      var line = Array(repeating: GridSnapshot.Cell(
        codepoint: 0x20, foreground: 0, background: 0, attrs: 0
      ), count: cols)
      for (index, scalar) in row.unicodeScalars.enumerated() where index < cols {
        line[index].codepoint = scalar.value
      }
      return line
    }
  }

  func testPrimaryScreenCountsEveryRowEvenWhenTheBottomIsBlank() {
    let cells = cells(["hi", "", "", ""], cols: 4)
    XCTAssertEqual(
      TerminalGridLayout.paintedRows(cells: cells, cols: 4, rows: 4, altScreen: false),
      4,
      "a new shell's empty rows under the prompt are the grid, not slack"
    )
  }

  func testAltScreenDropsTrailingEmptyRows() {
    let cells = cells(["R1xx", "R2xx", "", ""], cols: 4)
    XCTAssertEqual(
      TerminalGridLayout.paintedRows(cells: cells, cols: 4, rows: 4, altScreen: true),
      2
    )
  }

  func testAltScreenKeepsAFullPaint() {
    let cells = cells(["R1", "R2", "R3", "R4"], cols: 2)
    XCTAssertEqual(
      TerminalGridLayout.paintedRows(cells: cells, cols: 2, rows: 4, altScreen: true),
      4
    )
  }

  func testAltScreenAllEmptyIsZeroPaintedRows() {
    let cells = cells(["", "", ""], cols: 2)
    XCTAssertEqual(
      TerminalGridLayout.paintedRows(cells: cells, cols: 2, rows: 3, altScreen: true),
      0
    )
  }
}

final class TerminalGridInsetTests: XCTestCase {
  func testColumnsReserveAnInsetOnEachSide() {
    // 400pt wide, 10pt cells: flush-left would be 40 cols; with 8pt each side
    // (384 available) it is 38.
    XCTAssertEqual(TerminalGridInset.columns(viewWidth: 400, cellWidth: 10), 38)
  }

  func testMarginsAreEqualOnBothSides() {
    // 384 available, 38 cols × 10 = 380, leftover 4 → 2 each side on top of the
    // 8pt inset = 10pt origin, and the same 10pt on the right.
    let originX = TerminalGridInset.originX(viewWidth: 400, cellWidth: 10, cols: 38)
    XCTAssertEqual(originX, 10, accuracy: 0.001)
    let rightMargin = 400 - (originX + CGFloat(38) * 10)
    XCTAssertEqual(rightMargin, originX, accuracy: 0.001, "the grid is centred: both margins equal")
  }

  func testDegenerateWidthYieldsNoColumns() {
    XCTAssertEqual(TerminalGridInset.columns(viewWidth: 10, cellWidth: 10), 0)
    XCTAssertEqual(TerminalGridInset.columns(viewWidth: 400, cellWidth: 0), 0)
  }
}

final class TerminalResizePublishTests: XCTestCase {
  func testARowGrowDoesNotPublishTheEmptyRows() {
    XCTAssertFalse(
      TerminalResizePublish.shouldPublishAfterResize(
        oldCols: 80, oldRows: 24, newCols: 80, newRows: 40
      )
    )
  }

  func testARowShrinkPublishesSoTheGridIsNotClipped() {
    XCTAssertTrue(
      TerminalResizePublish.shouldPublishAfterResize(
        oldCols: 80, oldRows: 40, newCols: 80, newRows: 24
      )
    )
  }

  func testAColumnChangePublishesBecauseTheGridReflowed() {
    XCTAssertTrue(
      TerminalResizePublish.shouldPublishAfterResize(
        oldCols: 80, oldRows: 24, newCols: 100, newRows: 24
      )
    )
  }
}
