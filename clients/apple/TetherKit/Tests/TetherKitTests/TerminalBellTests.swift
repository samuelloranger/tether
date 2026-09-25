import XCTest
@testable import TetherKit

final class TerminalBellTests: XCTestCase {
  func testABurstRingsOncePerWindow() {
    var throttle = BellThrottle()
    XCTAssertTrue(throttle.shouldRing(at: 10))
    XCTAssertFalse(throttle.shouldRing(at: 10.05))
    XCTAssertFalse(throttle.shouldRing(at: 10.19))
    XCTAssertTrue(throttle.shouldRing(at: 10.25))
    XCTAssertFalse(throttle.shouldRing(at: 10.3))
  }

  func testEngineCountsExecutedBells() {
    let engine = TerminalEngine(cols: 20, rows: 4)
    engine.feed(Data("done\u{07}\u{07}".utf8))
    XCTAssertEqual(engine.takeBells(), 2)
    XCTAssertEqual(engine.takeBells(), 0, "taking resets the count")
  }

  func testABellThatEndsAnOSCIsNotABell() {
    let engine = TerminalEngine(cols: 20, rows: 4)
    engine.feed(Data("\u{1B}]0;title\u{07}\u{1B}]8;;https://example.com\u{07}link\u{1B}]8;;\u{07}".utf8))
    XCTAssertEqual(engine.takeBells(), 0)
  }

  func testReplayedOutputDoesNotRing() {
    let buffer = TerminalOutputBuffer()
    buffer.append(Data("make\u{07}".utf8))
    XCTAssertEqual(buffer.replay(cols: 30, rows: 4).takeBells(), 0)
  }

  /// Output that ends with a mouse-mode change, so the stream always has a later event.
  private func events(after output: String, count: Int) async -> [TerminalPipelineEvent] {
    let pipeline = TerminalPipeline()
    await pipeline.attachForTest(cols: 20, rows: 4)
    await pipeline.feedForTest(Data((output + "\u{1B}[?1000h").utf8))
    var received: [TerminalPipelineEvent] = []
    for await event in pipeline.events {
      received.append(event)
      if received.count == count { break }
    }
    return received
  }

  func testLiveBellReachesTheEventStream() async {
    let received = await events(after: "\u{07}", count: 2)
    guard case .bell = received.first else { return XCTFail("expected a bell first, got \(received)") }
    guard case .mouseModes = received.last else { return XCTFail("expected mouse modes, got \(received)") }
  }

  func testOutputWithoutABellSendsNone() async {
    let received = await events(after: "\u{1B}]2;title\u{07}hello", count: 1)
    guard case .mouseModes = received.first else { return XCTFail("expected no bell, got \(received)") }
  }
}
