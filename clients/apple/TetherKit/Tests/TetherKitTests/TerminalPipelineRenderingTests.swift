import XCTest
@testable import TetherKit

final class TerminalPipelineRenderingTests: XCTestCase {
  func test_connectSSH_feeds_received_bytes_into_the_existing_snapshot_stream() async throws {
    let pipeline = TerminalPipeline()
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
    let pipeline = TerminalPipeline()
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
    let pipeline = TerminalPipeline()
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
    let pipeline = TerminalPipeline()
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
    let pipeline = TerminalPipeline()
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

  func test_query_replies_are_written_back_to_the_host() async throws {
    let pipeline = TerminalPipeline()
    let transport = StubTerminalByteStream()
    await pipeline.connectSSH(transport: transport, key: "ssh-test")
    await transport.receive(Data("\u{1B}[6n".utf8))
    let writes = try await eventually {
      let writes = await transport.writes()
      return writes.isEmpty ? nil : writes
    }
    XCTAssertEqual(writes, [Data("\u{1B}[1;1R".utf8)])
  }

  func test_replies_from_a_switched_away_session_are_dropped() async throws {
    let pipeline = TerminalPipeline()
    let first = StubTerminalByteStream()
    let second = StubTerminalByteStream()
    await pipeline.connectSSH(transport: first, key: "one")
    await pipeline.connectSSH(transport: second, key: "two")
    // Queued after the switch, so only the key guard can keep it off `second`.
    pipeline.outbound.yield(.reply(Data("\u{1B}[1;1R".utf8), key: "one"))
    pipeline.outbound.yield(.input("x", key: "two"))
    let writes = try await eventually {
      let writes = await second.writes()
      return writes.isEmpty ? nil : writes
    }
    XCTAssertEqual(writes, [Data("x".utf8)], "a reply keyed to the old session must not reach the new one")
  }
  /// A redial replaces the transport under the same host key. A chunk the old
  /// connection had already buffered must not be drawn into the new session.
  func test_output_buffered_on_a_replaced_connection_is_dropped() async throws {
    let pipeline = TerminalPipeline()
    let old = BufferedAfterCloseStream()
    let fresh = StubTerminalByteStream()
    await pipeline.connectSSH(transport: old, key: "ssh:host:22")
    _ = try await eventually { await old.isReading ? true : nil }
    await pipeline.connectSSH(transport: fresh, key: "ssh:host:22")
    await old.deliver(Data("OLD-SESSION-REDRAW".utf8))
    await fresh.receive(Data("new session".utf8))
    _ = try await eventually {
      let text = await pipeline.historyText()
      return text.contains("new session") ? text : nil
    }
    try await Task.sleep(nanoseconds: 100_000_000)
    let text = await pipeline.historyText()
    XCTAssertFalse(text.contains("OLD-SESSION-REDRAW"), "the replaced connection's output leaked into: \(text)")
  }
}

/// A pump's inbound stream is unbounded: closing it still hands out chunks it
/// already buffered. Models that — `close` does not end a pending read.
private actor BufferedAfterCloseStream: TerminalByteStream {
  private var reader: CheckedContinuation<Data?, Never>?
  var isReading: Bool { reader != nil }

  func read() async throws -> Data? {
    await withCheckedContinuation { reader = $0 }
  }
  func write(_ bytes: Data) async throws {}
  func resize(cols: UInt16, rows: UInt16) async {}
  func close() async {}
  func deliver(_ bytes: Data) {
    reader?.resume(returning: bytes)
    reader = nil
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

private func gridText(_ frame: TerminalFrame) -> String {
  String(String.UnicodeScalarView(frame.cells.compactMap {
    $0.codepoint == 0 ? nil : Unicode.Scalar($0.codepoint)
  }))
}

private actor SnapshotBox {
  private(set) var count = 0
  func increment() { count += 1 }
}
