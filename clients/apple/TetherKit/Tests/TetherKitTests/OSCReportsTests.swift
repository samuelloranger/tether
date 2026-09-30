import XCTest
@testable import TetherKit

final class OSCReportsTests: XCTestCase {
  private func engineReport(_ text: String) -> TerminalReport {
    let engine = TerminalEngine(cols: 40, rows: 4)
    engine.feed(Data(text.utf8))
    return engine.report
  }

  private func b64(_ text: String) -> String { Data(text.utf8).base64EncodedString() }

  // MARK: - Title

  func testOSC0AndOSC2SetTheTitleAndOSC1DoesNot() {
    XCTAssertEqual(engineReport("\u{1B}]0;vim notes.md\u{07}").title, "vim notes.md")
    XCTAssertEqual(engineReport("\u{1B}]2;make\u{1B}\\").title, "make")
    XCTAssertNil(engineReport("\u{1B}]1;icon\u{07}").title)
  }

  func testTheNewestTitleWinsAndAnEmptyOneClearsIt() {
    XCTAssertEqual(engineReport("\u{1B}]2;one\u{07}\u{1B}]2;two\u{07}").title, "two")
    XCTAssertNil(engineReport("\u{1B}]2;one\u{07}\u{1B}]2;\u{07}").title)
  }

  func testTitleLosesControlAndBidiCharactersAndIsCapped() {
    XCTAssertEqual(OSCReports.title(Array("a\u{202E}b\u{200B}c\u{0008}d".utf8)), "abcd")
    XCTAssertEqual(OSCReports.title(Array(String(repeating: "x", count: 500).utf8))?.count, OSCReports.titleLimit)
  }

  // MARK: - Working directory

  func testOSC7ReportsThePathAndIgnoresTheHost() {
    XCTAssertEqual(engineReport("\u{1B}]7;file://box/home/sam/my%20app\u{07}").cwd, "/home/sam/my app")
    XCTAssertEqual(engineReport("\u{1B}]7;file:///srv\u{07}").cwd, "/srv")
  }

  func testOSC7RejectsWhatIsNotAnAbsoluteFilePath() {
    XCTAssertNil(engineReport("\u{1B}]7;https://example.com/x\u{07}").cwd)
    XCTAssertNil(engineReport("\u{1B}]7;file://box\u{07}").cwd)
    XCTAssertNil(engineReport("\u{1B}]7;file://box/a%00b\u{07}").cwd)
    XCTAssertNil(engineReport("\u{1B}]7;file://box/a%0Ab\u{07}").cwd)
  }

  // MARK: - Progress

  func testProgressStatesAndClamping() {
    XCTAssertEqual(engineReport("\u{1B}]9;4;1;42\u{07}").progress, TerminalProgress(state: .normal, percent: 42))
    XCTAssertEqual(engineReport("\u{1B}]9;4;1;250\u{07}").progress?.percent, 100)
    XCTAssertEqual(engineReport("\u{1B}]9;4;2;10\u{07}").progress?.state, .error)
    XCTAssertEqual(engineReport("\u{1B}]9;4;4;10\u{07}").progress?.state, .warning)
    XCTAssertEqual(engineReport("\u{1B}]9;4;3\u{07}").progress?.state, .indeterminate)
  }

  func testProgressClearsOnStateZeroPromptAndReset() {
    XCTAssertNil(engineReport("\u{1B}]9;4;1;50\u{07}\u{1B}]9;4;0\u{07}").progress)
    XCTAssertNil(engineReport("\u{1B}]9;4;1;50\u{07}\u{1B}]133;A\u{07}").progress)
    XCTAssertNil(engineReport("\u{1B}]9;4;1;50\u{07}\u{1B}c").progress)
  }

  func testAPlainOSC9NotificationIsNotProgress() {
    XCTAssertNil(engineReport("\u{1B}]9;build finished\u{07}").progress)
    XCTAssertNil(engineReport("\u{1B}]9;4;9;10\u{07}").progress)
  }

  func testAnErrorWithoutAPercentKeepsTheLastOne() {
    XCTAssertEqual(
      engineReport("\u{1B}]9;4;1;70\u{07}\u{1B}]9;4;2\u{07}").progress,
      TerminalProgress(state: .error, percent: 70))
  }

  // MARK: - Clipboard

  func testOSC52WritesAreQueuedInOrderAndTakenOnce() {
    let engine = TerminalEngine(cols: 40, rows: 4)
    engine.feed(Data("\u{1B}]52;c;\(b64("one"))\u{07}\u{1B}]52;;\(b64("two é"))\u{1B}\\".utf8))
    XCTAssertEqual(engine.takeClipboard(), ["one", "two é"])
    XCTAssertEqual(engine.takeClipboard(), [])
  }

  func testOSC52QueriesAndEmptyPayloadsAreNeverHonored() {
    let engine = TerminalEngine(cols: 40, rows: 4)
    engine.feed(Data("\u{1B}]52;c;?\u{07}\u{1B}]52;c;\u{07}\u{1B}]52;c;!!!\u{07}".utf8))
    XCTAssertEqual(engine.takeClipboard(), [])
    XCTAssertTrue(engine.takeReplies().isEmpty, "a query must not be answered")
  }

  func testOSC52AcceptsUnpaddedBase64() {
    let engine = TerminalEngine(cols: 40, rows: 4)
    engine.feed(Data("\u{1B}]52;c;aGk\u{07}".utf8))
    XCTAssertEqual(engine.takeClipboard(), ["hi"])
  }

  func testOSC52SurvivesAReadBoundaryAndALargePayload() {
    let engine = TerminalEngine(cols: 40, rows: 4)
    let text = String(repeating: "y", count: 60_000)
    let sequence = Array("\u{1B}]52;c;\(b64(text))\u{07}".utf8)
    engine.feed(Data(sequence[..<30_000]))
    engine.feed(Data(sequence[30_000...]))
    XCTAssertEqual(engine.takeClipboard(), [text])
  }

  func testOSC52OverTheCapIsDropped() {
    let engine = TerminalEngine(cols: 40, rows: 4)
    engine.feed(Data("\u{1B}]52;c;\(b64(String(repeating: "y", count: OSCReports.clipboardLimit + 1)))\u{07}".utf8))
    XCTAssertEqual(engine.takeClipboard(), [])
  }

  // MARK: - Replay

  func testReplayKeepsTheReportButDoesNotWriteTheClipboardAgain() {
    let buffer = TerminalOutputBuffer()
    buffer.append(Data("\u{1B}]2;build\u{07}\u{1B}]7;file:///srv\u{07}\u{1B}]52;c;\(b64("x"))\u{07}".utf8))
    let replayed = buffer.replay(cols: 30, rows: 4)
    XCTAssertEqual(replayed.report.title, "build")
    XCTAssertEqual(replayed.report.cwd, "/srv")
    XCTAssertEqual(replayed.takeClipboard(), [])
  }

  func testARebuiltEngineKeepsTheTitleTheTruncatedBufferForgot() {
    let rebuilt = TerminalEngine(cols: 30, rows: 4)
    rebuilt.feed(Data("\u{1B}]2;new\u{07}".utf8))
    rebuilt.restoreReport(TerminalReport(title: "old", cwd: "/srv", progress: nil))
    XCTAssertEqual(rebuilt.report.title, "new", "what the engine saw itself is newer")
    XCTAssertEqual(rebuilt.report.cwd, "/srv")
  }
}
