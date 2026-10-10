import XCTest

@testable import TetherKit

/// A typed session switch keeps the departing session on screen until the next one is drawn.
final class TerminalSwitchHoldTests: XCTestCase {
  private func feed(_ pipeline: TerminalPipeline, _ text: String) async {
    await pipeline.feedForTest(Data(text.utf8))
  }

  private func row(_ pipeline: TerminalPipeline, _ index: Int) async -> String {
    guard let frame = await pipeline.frameForTest() else { return "" }
    return rowText(frame, index)
  }

  func test_the_bare_shell_between_two_sessions_is_never_published() async throws {
    let pipeline = TerminalPipeline()
    await pipeline.attachForTest(cols: 30, rows: 4)
    await feed(pipeline, "\u{1B}[?1049h\u{1B}[Hold session")
    let before = await pipeline.publishesForTest

    await pipeline.holdFramesForSwitch()
    await feed(pipeline, "\u{1B}c$ zmx attach b\r\n")
    await feed(pipeline, "\u{1B}[2J\u{1B}[H")
    await feed(pipeline, "\u{1B}[?1049h\u{1B}[Hnew session")
    let during = await pipeline.publishesForTest
    XCTAssertEqual(during, before, "the reset shell and the half-replayed session stay off screen")

    try await Task.sleep(for: TerminalPipeline.switchHoldQuiet * 3)
    let holding = await pipeline.isHoldingForSwitchForTest
    XCTAssertFalse(holding)
    let after = await pipeline.publishesForTest
    XCTAssertEqual(after, before + 1, "one frame, once the replay has gone quiet")
    let shown = await pipeline.publishedGenerationForTest
    let latest = await pipeline.frameForTest()?.header.generation
    XCTAssertEqual(shown, latest)
    let first = await row(pipeline, 0)
    XCTAssertEqual(first, "new session")
  }

  func test_the_clear_is_found_when_it_is_split_across_reads() async throws {
    let pipeline = TerminalPipeline()
    await pipeline.attachForTest(cols: 30, rows: 4)
    await pipeline.holdFramesForSwitch()
    await feed(pipeline, "$ zmx attach b\r\n\u{1B}[2")
    await feed(pipeline, "J\u{1B}[Hb")
    try await Task.sleep(for: TerminalPipeline.switchHoldQuiet * 3)
    let holding = await pipeline.isHoldingForSwitchForTest
    XCTAssertFalse(holding)
  }

  func test_an_attach_that_never_clears_lets_go_after_the_limit() async throws {
    let pipeline = TerminalPipeline()
    await pipeline.attachForTest(cols: 30, rows: 4)
    await pipeline.setSwitchHoldLimitForTest(.milliseconds(80))
    await pipeline.holdFramesForSwitch()
    await feed(pipeline, "zmx: no such session\r\n")
    let held = await pipeline.publishesForTest
    try await Task.sleep(for: .milliseconds(250))
    let holding = await pipeline.isHoldingForSwitchForTest
    XCTAssertFalse(holding)
    let after = await pipeline.publishesForTest
    XCTAssertEqual(after, held + 1)
    let first = await row(pipeline, 0)
    XCTAssertEqual(first, "zmx: no such session")
  }

  func test_a_disconnect_drops_the_hold_without_publishing() async throws {
    let pipeline = TerminalPipeline()
    await pipeline.attachForTest(cols: 30, rows: 4)
    await pipeline.setSwitchHoldLimitForTest(.milliseconds(50))
    await pipeline.holdFramesForSwitch()
    await feed(pipeline, "partial")
    let held = await pipeline.publishesForTest
    await pipeline.disconnect()
    try await Task.sleep(for: .milliseconds(150))
    let after = await pipeline.publishesForTest
    XCTAssertEqual(after, held, "the dropped hold's timer must not publish")
  }
}
