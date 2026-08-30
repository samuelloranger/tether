import XCTest

@testable import TetherKit

final class TerminalRunBuilderTests: XCTestCase {
  private func cell(
    _ codepoint: UInt32,
    fg: UInt32 = 0xFFFF_FFFF,
    bg: UInt32 = 0xFF00_0000,
    attrs: UInt32 = 0
  ) -> GridSnapshot.Cell {
    GridSnapshot.Cell(codepoint: codepoint, foreground: fg, background: bg, attrs: attrs)
  }

  func testBackgroundsCollapseEqualNeighbours() {
    let cells = [
      cell(0x41, bg: 0xFF00_0000),
      cell(0x42, bg: 0xFF00_0000),
      cell(0x43, bg: 0xFF11_2233),
    ]
    let spans = TerminalRunBuilder.backgrounds(cells: cells, rowStart: 0, cols: 3)
    XCTAssertEqual(
      spans,
      [
        TerminalRunBuilder.BackgroundSpan(startCol: 0, length: 2, color: 0xFF00_0000),
        TerminalRunBuilder.BackgroundSpan(startCol: 2, length: 1, color: 0xFF11_2233),
      ]
    )
  }

  func testBackgroundsCoverEveryColumn() {
    let cells = (0..<5).map { cell(0x41, bg: UInt32($0)) }
    let spans = TerminalRunBuilder.backgrounds(cells: cells, rowStart: 0, cols: 5)
    XCTAssertEqual(spans.map(\.length).reduce(0, +), 5)
    XCTAssertEqual(spans.first?.startCol, 0)
  }

  func testInverseSwapsForegroundAndBackground() {
    let inverted = cell(0x41, fg: 0x1, bg: 0x2, attrs: GridSnapshot.attrInverse)
    let resolved = TerminalRunBuilder.resolved(inverted)
    XCTAssertEqual(resolved.fg, 0x2)
    XCTAssertEqual(resolved.bg, 0x1)
  }

  func testGlyphRunsBreakOnBlanksColourAndStyle() {
    let cells = [
      cell(0x41),
      cell(0x42),
      cell(0x20),
      cell(0x43),
      cell(0x44, fg: 0xFF00_FF00),
      cell(0x45, attrs: GridSnapshot.attrBold),
    ]
    let runs = TerminalRunBuilder.glyphRuns(cells: cells, rowStart: 0, cols: 6)
    XCTAssertEqual(runs.count, 4)
    XCTAssertEqual(runs[0].startCol, 0)
    XCTAssertEqual(runs[0].codepoints, [0x41, 0x42])
    XCTAssertEqual(runs[1].startCol, 3)
    XCTAssertEqual(runs[1].codepoints, [0x43])
    XCTAssertEqual(runs[2].startCol, 4)
    XCTAssertEqual(runs[3].style, GridSnapshot.attrBold)
  }

  func testNulCellsAreBlank() {
    let cells = [cell(0), cell(0x41), cell(0)]
    let runs = TerminalRunBuilder.glyphRuns(cells: cells, rowStart: 0, cols: 3)
    XCTAssertEqual(runs.count, 1)
    XCTAssertEqual(runs[0].startCol, 1)
  }

  func testRowStartOffsetsIntoTheGrid() {
    let cells = [cell(0x41), cell(0x42), cell(0x43), cell(0x44)]
    let runs = TerminalRunBuilder.glyphRuns(cells: cells, rowStart: 2, cols: 2)
    XCTAssertEqual(runs.count, 1)
    XCTAssertEqual(runs[0].codepoints, [0x43, 0x44])
    XCTAssertEqual(runs[0].startCol, 0)
  }

  func testOutOfRangeRowIsEmptyRatherThanACrash() {
    let cells = [cell(0x41)]
    XCTAssertTrue(TerminalRunBuilder.glyphRuns(cells: cells, rowStart: 0, cols: 4).isEmpty)
    XCTAssertTrue(TerminalRunBuilder.backgrounds(cells: cells, rowStart: 4, cols: 1).isEmpty)
  }

  func testRowTextTrimsTrailingBlanks() {
    let cells = [cell(0x68), cell(0x69), cell(0x20), cell(0)]
    XCTAssertEqual(TerminalRunBuilder.rowText(cells: cells, rowStart: 0, cols: 4), "hi")
  }

  func testRowTextsSplitsByGridWidth() {
    let cells = [cell(0x61), cell(0x62), cell(0x63), cell(0x64)]
    XCTAssertEqual(
      TerminalRunBuilder.rowTexts(cells: cells, cols: 2, rows: 2),
      ["ab", "cd"]
    )
  }
}
