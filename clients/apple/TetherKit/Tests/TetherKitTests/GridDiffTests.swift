import XCTest

@testable import TetherKit

final class GridDiffTests: XCTestCase {
  private func grid(_ codepoints: [UInt32]) -> [GridSnapshot.Cell] {
    codepoints.map {
      GridSnapshot.Cell(codepoint: $0, foreground: 0xFFFF_FFFF, background: 0, attrs: 0)
    }
  }

  func testIdenticalGridsHaveNoDirtyRows() {
    let cells = grid([1, 2, 3, 4])
    XCTAssertEqual(GridDiff.dirtyRows(previous: cells, current: cells, cols: 2, rows: 2), [])
  }

  func testOnlyChangedRowsAreReported() {
    let before = grid([1, 2, 3, 4, 5, 6])
    let after = grid([1, 2, 3, 9, 5, 6])
    XCTAssertEqual(GridDiff.dirtyRows(previous: before, current: after, cols: 2, rows: 3), [1])
  }

  func testAttributeOnlyChangeIsDirty() {
    let before = grid([1, 2])
    var after = before
    after[1].attrs = GridSnapshot.attrBold
    XCTAssertEqual(GridDiff.dirtyRows(previous: before, current: after, cols: 2, rows: 1), [0])
  }

  func testGeometryChangeForcesAFullRepaint() {
    let before = grid([1, 2, 3, 4])
    let after = grid([1, 2, 3, 4, 5, 6])
    XCTAssertNil(GridDiff.dirtyRows(previous: before, current: after, cols: 2, rows: 3))
    XCTAssertNil(GridDiff.dirtyRows(previous: [], current: after, cols: 2, rows: 3))
  }

  func testEmptyGeometryIsFullRepaint() {
    XCTAssertNil(GridDiff.dirtyRows(previous: [], current: [], cols: 0, rows: 0))
  }
}
