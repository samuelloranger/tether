import XCTest

@testable import TetherKit

@MainActor
final class AgentChatModelTests: XCTestCase {
  func testDeltasCoalesceIntoOneAssistantBubble() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    m.appendUser("hello")
    m.apply(.agentDelta(seq: 1, text: "Hel"))
    m.apply(.agentDelta(seq: 2, text: "lo"))
    m.apply(.agentDone(seq: 3, cost: 0))
    XCTAssertEqual(m.messages.count, 2)  // user + one assistant
    XCTAssertEqual(m.messages.last?.text, "Hello")
    XCTAssertEqual(m.messages.last?.isStreaming, false)
    XCTAssertEqual(m.turn, .idle)
  }

  func testToolThenResultAttachesToAssistant() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    m.apply(.agentDelta(seq: 1, text: "running"))
    m.apply(.agentTool(seq: 2, name: "Bash", input: #"{"command":"ls"}"#))
    m.apply(.agentToolResult(seq: 3, text: "file.txt", isError: false))
    let tools = m.messages.last?.tools ?? []
    XCTAssertEqual(tools.count, 1)
    XCTAssertEqual(tools.first?.name, "Bash")
    XCTAssertEqual(tools.first?.summary, "ls")
    XCTAssertEqual(tools.first?.result, "file.txt")
  }

  func testErrorAppendsErrorRowAndIdles() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    m.turn = .thinking
    m.apply(.agentError(message: "boom"))
    XCTAssertEqual(m.messages.last?.role, .error)
    XCTAssertEqual(m.messages.last?.text, "boom")
    XCTAssertEqual(m.turn, .idle)
  }

  func testPermissionReqSetsPendingApproval() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    m.apply(.agentPermissionReq(reqId: UUID().uuidString, name: "Bash", input: #"{"command":"rm -rf x"}"#))
    XCTAssertNotNil(m.pendingApproval)
    XCTAssertEqual(m.pendingApproval?.name, "Bash")
    XCTAssertEqual(m.pendingApproval?.summary, "rm -rf x")
  }

  func testLastSeqTracksTheHighestSeqSeenAcrossFrameKinds() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    XCTAssertEqual(m.lastSeq, 0)  // cold model — replay-from-scratch default
    m.apply(.agentDelta(seq: 1, text: "Hel"))
    m.apply(.agentDelta(seq: 2, text: "lo"))
    m.apply(.agentTool(seq: 3, name: "Bash", input: "{}"))
    m.apply(.agentToolResult(seq: 4, text: "ok", isError: false))
    m.apply(.agentDone(seq: 5, cost: 0))
    XCTAssertEqual(m.lastSeq, 5)
  }

  // Server-side coalescing (agentRegistry.ts) persists several streamed deltas
  // as ONE replayed row — the reducer must render that identically to the
  // many-small-chunks live path: one assistant bubble either way.
  func testOneCoalescedReplayDeltaRendersSameAsManyLiveDeltas() {
    let live = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    live.apply(.agentDelta(seq: 1, text: "Hel"))
    live.apply(.agentDelta(seq: 2, text: "lo"))
    live.apply(.agentDone(seq: 3, cost: 0))

    let replayed = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    replayed.apply(.agentDelta(seq: 1, text: "Hello"))
    replayed.apply(.agentDone(seq: 3, cost: 0))

    XCTAssertEqual(live.messages.last?.text, replayed.messages.last?.text)
    XCTAssertEqual(live.lastSeq, replayed.lastSeq)
  }

  func testSendPromptAppendsUserAndFiresOutbound() {
    var sent: [AgentOutbound] = []
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp", send: { sent.append($0) })
    m.sendPrompt("do a thing")
    XCTAssertEqual(m.messages.first?.role, .user)
    XCTAssertEqual(m.turn, .thinking)
    XCTAssertEqual(sent, [.prompt("do a thing")])
  }
}
