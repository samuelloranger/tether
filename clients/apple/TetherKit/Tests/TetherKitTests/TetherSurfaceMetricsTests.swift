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

  private func relayout(_ view: TetherSurfaceView, height: CGFloat) {
    view.frame = CGRect(x: 0, y: 0, width: 400, height: height)
    view.setNeedsLayout()
    view.layoutIfNeeded()
  }

  private func settle() {
    RunLoop.main.run(until: Date().addingTimeInterval(0.7))
  }

  func testAFrozenGridIgnoresBoundsChangesUntilItThaws() {
    let (view, reported) = makeSurface()
    let before = reported()
    view.freezesGrid = true
    relayout(view, height: 900)
    XCTAssertEqual(reported()?.rows, before?.rows)
    view.freezesGrid = false
    XCTAssertEqual(reported()?.rows, UInt16(900 / view.cellHeight))
  }

  func testTheHostSeesNoResizeForASizeThatOnlyLastedWhileFrozen() {
    let (view, _) = makeSurface()
    var settled: [UInt16] = []
    view.onGridSizeSettled = { _, rows in settled.append(rows) }
    settle()
    XCTAssertEqual(settled, [UInt16(600 / view.cellHeight)])
    view.freezesGrid = true
    relayout(view, height: 900)
    settle()
    relayout(view, height: 600)
    view.freezesGrid = false
    settle()
    XCTAssertFalse(settled.contains(UInt16(900 / view.cellHeight)), "\(settled)")
    XCTAssertEqual(settled.last, UInt16(600 / view.cellHeight))
  }

  func testAFontChangeStillResizesAFrozenGrid() {
    let (view, reported) = makeSurface()
    view.freezesGrid = true
    view.fontSize = 20
    XCTAssertEqual(reported()?.rows, UInt16(600 / view.cellHeight))
  }

  /// A keyboard coming up while the drawer is open must not leave rows under the key bar.
  func testAFrozenGridStillShrinksToFit() {
    let (view, reported) = makeSurface()
    view.freezesGrid = true
    relayout(view, height: 300)
    XCTAssertEqual(reported()?.rows, UInt16(300 / view.cellHeight))
  }
}

