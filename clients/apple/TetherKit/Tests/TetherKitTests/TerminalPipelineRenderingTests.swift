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
}

private actor SnapshotBox {
  private(set) var count = 0
  func increment() { count += 1 }
}
