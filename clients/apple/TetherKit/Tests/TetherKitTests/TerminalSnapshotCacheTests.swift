import Foundation
import XCTest

@testable import TetherKit

final class TerminalSnapshotCacheTests: XCTestCase {
  func testUnknownKeyHasNothingToShow() {
    let cache = TerminalSnapshotCache()
    XCTAssertNil(cache.openingSnapshot(for: "host:term-1"))
  }

  func testSwitchingBackShowsTheCachedGridInsteadOfNil() {
    let cache = TerminalSnapshotCache()
    let grid = frame(1)
    cache.remember(grid, for: "host:term-1")
    XCTAssertEqual(cache.openingSnapshot(for: "host:term-1"), grid)
    XCTAssertNil(
      cache.openingSnapshot(for: "host:term-2"),
      "a session never opened this launch still starts blank until replay"
    )
  }

  func testALaterSnapshotReplacesTheCache() {
    let cache = TerminalSnapshotCache()
    cache.remember(frame(1), for: "a")
    cache.remember(frame(2), for: "a")
    XCTAssertEqual(cache.openingSnapshot(for: "a"), frame(2))
  }

  func testForgetDropsTheCachedGrid() {
    let cache = TerminalSnapshotCache()
    cache.remember(frame(1), for: "a")
    cache.forget("a")
    XCTAssertNil(cache.openingSnapshot(for: "a"))
  }
}

private func frame(_ generation: UInt64) -> TerminalFrame {
  TerminalFrame(
    header: GridSnapshot.Header(
      cols: 1, rows: 1, cursorCol: 0, cursorRow: 0, generation: generation, cursorVisible: true),
    cells: [TerminalPalette.blankCell])
}
