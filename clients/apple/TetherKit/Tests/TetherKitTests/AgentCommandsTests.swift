import XCTest

@testable import TetherKit

final class AgentCommandsTests: XCTestCase {
  func testBareSlashReturnsAll() {
    XCTAssertEqual(matchCommands("/").count, agentCommands.count)
  }

  func testFiltersBySubstring() {
    let ids = matchCommands("/co").map(\.id)
    XCTAssertTrue(ids.contains("copy"))
    XCTAssertTrue(ids.contains("compact"))
    XCTAssertFalse(ids.contains("clear"))
  }

  func testSpaceClosesPalette() {
    XCTAssertTrue(matchCommands("/model sonnet").isEmpty)
  }

  func testNonSlashNeverMatches() {
    XCTAssertTrue(matchCommands("hello").isEmpty)
  }

  func testDispatchLocalAgentPassthrough() {
    XCTAssertEqual(dispatchDraft("/copy all"), .local(id: "copy", args: "all"))
    XCTAssertEqual(dispatchDraft("/compact"), .agentText("/compact"))
    XCTAssertEqual(dispatchDraft("/wibble x"), .agentText("/wibble x"))
    XCTAssertEqual(dispatchDraft("hello"), .none)
  }
}

@MainActor
final class AgentPaletteModelTests: XCTestCase {
  func testOpenClosePicker() {
    let m = AgentChatModel(sessionId: "a", cwd: "/x")
    m.openPicker(.model)
    XCTAssertEqual(m.pendingPicker, .model)
    m.closePicker()
    XCTAssertNil(m.pendingPicker)
  }

  func testClearTranscriptEmptiesMessages() {
    let m = AgentChatModel(sessionId: "a", cwd: "/x")
    m.appendUser("hi")
    XCTAssertEqual(m.messages.count, 1)
    m.clearTranscript()
    XCTAssertTrue(m.messages.isEmpty)
  }

  func testAgentSessionsPopulatesResumeList() {
    let m = AgentChatModel(sessionId: "a", cwd: "/x")
    m.apply(
      .agentSessions(sessions: [
        ClaudeSessionMeta(id: "s1", label: "x", mtimeMs: 1, msgCount: 2, cwd: "/x")
      ]))
    XCTAssertEqual(m.resumeSessions.map(\.id), ["s1"])
  }
}
