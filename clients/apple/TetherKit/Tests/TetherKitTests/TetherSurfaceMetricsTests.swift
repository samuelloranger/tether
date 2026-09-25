import UIKit
import XCTest
@testable import TetherKit

@MainActor
final class TetherSurfaceMetricsTests: XCTestCase {
  private func makeSurface() -> (TetherSurfaceView, () -> (cols: UInt16, rows: UInt16)?) {
    let view = TetherSurfaceView(frame: CGRect(x: 0, y: 0, width: 400, height: 600))
    var reported: (cols: UInt16, rows: UInt16)?
    view.onGridSizeChange = { reported = ($0, $1) }
    view.fontSize = 14
    return (view, { reported })
  }

  func testLineSpacingMakesRowsTallerAndTheReportedGridShrinks() {
    let (view, reported) = makeSurface()
    let single = view.cellHeight
    view.lineSpacing = 1.5
    XCTAssertGreaterThan(view.cellHeight, single * 1.4)
    XCTAssertEqual(reported()?.rows, UInt16(600 / view.cellHeight))
  }

  func testPaddingNarrowsTheReportedGrid() {
    let (view, reported) = makeSurface()
    view.horizontalPadding = 0
    XCTAssertEqual(reported()?.cols, UInt16(Int(400 / view.cellWidth)))
    view.horizontalPadding = 24
    XCTAssertEqual(
      reported()?.cols,
      UInt16(TerminalGridInset.columns(viewWidth: 400, cellWidth: view.cellWidth, padding: 24))
    )
  }
}
