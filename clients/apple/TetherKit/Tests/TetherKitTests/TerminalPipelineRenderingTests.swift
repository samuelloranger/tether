import TetherFFIBindings
import XCTest
@testable import TetherKit

final class TerminalPipelineRenderingTests: XCTestCase {
  func test_connectSSH_feeds_received_bytes_into_the_existing_snapshot_stream() async throws {
    let pipeline = TerminalPipeline(replayStore: FfiReplayStore())
    let transport = StubTerminalByteStream()
    let snapshot = Task {
      for await snapshot in pipeline.snapshots {
        if let snapshot { return snapshot }
      }
      fatalError("snapshot stream unexpectedly finished")
    }

    await pipeline.connectSSH(transport: transport, key: "ssh-test")
    await transport.receive(Data("attached over ssh".utf8))

    let bytes = await snapshot.value
    XCTAssertTrue(gridText(bytes).contains("attached over ssh"))
  }

  func test_connectSSH_routes_terminal_input_to_the_byte_stream() async throws {
    let pipeline = TerminalPipeline(replayStore: FfiReplayStore())
    let transport = StubTerminalByteStream()
    await pipeline.connectSSH(transport: transport, key: "ssh-test")

    pipeline.outbound.yield(.input("echo attached\\n", key: "ssh-test"))
    let writes = try await eventually {
      let writes = await transport.writes()
      return writes.isEmpty ? nil : writes
    }
    XCTAssertEqual(writes, [Data("echo attached\\n".utf8)])
  }

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

private actor StubTerminalByteStream: TerminalByteStream {
  private var buffered: [Data] = []
  private var reader: CheckedContinuation<Data?, Never>?
  private var sent: [Data] = []

  func read() async throws -> Data? {
    if !buffered.isEmpty { return buffered.removeFirst() }
    return await withCheckedContinuation { reader = $0 }
  }
  func write(_ bytes: Data) async throws { sent.append(bytes) }
  func close() async { reader?.resume(returning: nil); reader = nil }
  func receive(_ bytes: Data) {
    if let reader { self.reader = nil; reader.resume(returning: bytes) }
    else { buffered.append(bytes) }
  }
  func writes() -> [Data] { sent }
}

private func eventually<T>(
  timeoutNanoseconds: UInt64 = 1_000_000_000,
  poll: @escaping @Sendable () async -> T?
) async throws -> T {
  let deadline = ContinuousClock.now + .nanoseconds(Int64(timeoutNanoseconds))
  while ContinuousClock.now < deadline {
    if let value = await poll() { return value }
    try await Task.sleep(nanoseconds: 10_000_000)
  }
  // A timeout here is a failure, not a skip: skipping would hide a regression
  // as "passed with skips" in the test report.
  XCTFail("condition was not met before timeout")
  throw NSError(domain: "TerminalPipelineRenderingTests", code: 1, userInfo: nil)
}

private func gridText(_ data: Data) -> String {
  guard let (_, cells) = try? GridSnapshotDecoder.decode(data) else { return "" }
  return String(String.UnicodeScalarView(cells.compactMap {
    $0.codepoint == 0 ? nil : Unicode.Scalar($0.codepoint)
  }))
}

private actor SnapshotBox {
  private(set) var count = 0
  func increment() { count += 1 }
}
