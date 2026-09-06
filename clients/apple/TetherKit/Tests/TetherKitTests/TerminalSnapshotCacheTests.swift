import Foundation
import XCTest

@testable import TetherKit

/// Switching sessions used to `yield(nil)`, which clears the surface. A cached
/// last grid for the session being attached to is what stops that blank flash
/// until server replay lands.
final class TerminalSnapshotCacheTests: XCTestCase {
  func testUnknownKeyHasNothingToShow() {
    let cache = TerminalSnapshotCache()
    XCTAssertNil(cache.openingSnapshot(for: "host:term-1"))
  }

  func testSwitchingBackShowsTheCachedGridInsteadOfNil() {
    let cache = TerminalSnapshotCache()
    let grid = Data([1, 2, 3])
    cache.remember(grid, for: "host:term-1")
    XCTAssertEqual(cache.openingSnapshot(for: "host:term-1"), grid)
    XCTAssertNil(
      cache.openingSnapshot(for: "host:term-2"),
      "a session never opened this launch still starts blank until replay"
    )
  }

  func testALaterSnapshotReplacesTheCache() {
    let cache = TerminalSnapshotCache()
    cache.remember(Data([1]), for: "a")
    cache.remember(Data([2]), for: "a")
    XCTAssertEqual(cache.openingSnapshot(for: "a"), Data([2]))
  }

  func testForgetDropsTheCachedGrid() {
    let cache = TerminalSnapshotCache()
    cache.remember(Data([1]), for: "a")
    cache.forget("a")
    XCTAssertNil(cache.openingSnapshot(for: "a"))
  }
}
