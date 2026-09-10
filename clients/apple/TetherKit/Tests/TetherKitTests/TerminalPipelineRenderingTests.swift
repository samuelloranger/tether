import TetherFFIBindings
import XCTest
@testable import TetherKit

final class TerminalPipelineRenderingTests: XCTestCase {
  func test_setRendering_false_suppresses_snapshots() async throws {
    let pipeline = TerminalPipeline(replayStore: FfiReplayStore())
    await pipeline.attachForTest(cols: 80, rows: 24)
    await pipeline.setRendering(false)

    let box = SnapshotBox()
    let collector = Task {
      for await snap in pipeline.snapshots where snap != nil { await box.increment() }
    }
    await pipeline.feedForTest(Data("hello".utf8))
    try await Task.sleep(nanoseconds: 60_000_000)
    collector.cancel()
    let count = await box.count
    XCTAssertEqual(count, 0, "no snapshots should be produced while rendering is off")
  }

  func test_rendering_on_produces_snapshots() async throws {
    let pipeline = TerminalPipeline(replayStore: FfiReplayStore())
    await pipeline.attachForTest(cols: 80, rows: 24)
    // rendering defaults to true.

    let box = SnapshotBox()
    let collector = Task {
      for await snap in pipeline.snapshots where snap != nil { await box.increment() }
    }
    await pipeline.feedForTest(Data("hello".utf8))
    try await Task.sleep(nanoseconds: 60_000_000)
    collector.cancel()
    let count = await box.count
    XCTAssertGreaterThan(count, 0, "feeding output while visible must produce a snapshot")
  }

  /// Switching back to a resident session that produced NO output while
  /// backgrounded: its emulator generation is unchanged, so `publishSnapshot`'s
  /// generation guard would skip it and the surface would keep showing the
  /// previous tab's frame. Turning rendering back on must force a fresh frame.
  func test_setRendering_on_republishes_the_current_grid_after_backgrounding() async throws {
    let pipeline = TerminalPipeline(replayStore: FfiReplayStore())
    await pipeline.attachForTest(cols: 80, rows: 24)

    let box = SnapshotBox()
    let collector = Task {
      for await snap in pipeline.snapshots where snap != nil { await box.increment() }
    }
    // Draw once while visible.
    await pipeline.feedForTest(Data("hello".utf8))
    try await Task.sleep(nanoseconds: 60_000_000)
    let afterFirst = await box.count
    XCTAssertGreaterThan(afterFirst, 0)

    // Background, then foreground again with NO new output in between.
    await pipeline.setRendering(false)
    await pipeline.setRendering(true)
    try await Task.sleep(nanoseconds: 60_000_000)
    collector.cancel()
    let afterReshow = await box.count
    XCTAssertGreaterThan(
      afterReshow, afterFirst,
      "returning to a quiescent resident session must re-publish its current grid")
  }
}

private actor SnapshotBox {
  private(set) var count = 0
  func increment() { count += 1 }
}
