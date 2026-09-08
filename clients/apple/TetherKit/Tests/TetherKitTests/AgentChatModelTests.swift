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
    XCTAssertEqual(m.messages.last?.plainText, "Hello")
    XCTAssertEqual(m.messages.last?.isStreaming, false)
    XCTAssertEqual(m.turn, .idle)
  }

  func testToolThenResultAttachesToAssistant() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    m.apply(.agentDelta(seq: 1, text: "running"))
    m.apply(.agentTool(seq: 2, name: "Bash", input: #"{"command":"ls"}"#))
    m.apply(.agentToolResult(seq: 3, text: "file.txt", isError: false))
    let toolCalls: [AgentToolCall] = m.messages.last?.blocks.compactMap {
      if case let .tool(call) = $0 { return call }
      return nil
    } ?? []
    XCTAssertEqual(toolCalls.count, 1)
    XCTAssertEqual(toolCalls.first?.name, "Bash")
    XCTAssertEqual(toolCalls.first?.summary, "ls")
    XCTAssertEqual(toolCalls.first?.result, "file.txt")
  }

  func testErrorAppendsErrorRowAndIdles() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    m.turn = .thinking
    m.apply(.agentError(message: "boom"))
    XCTAssertEqual(m.messages.last?.role, .error)
    XCTAssertEqual(m.messages.last?.plainText, "boom")
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

    XCTAssertEqual(live.messages.last?.plainText, replayed.messages.last?.plainText)
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

  func testOnFirstPromptFiresOnceOnFirstUserMessageOnly() {
    var fired: [String] = []
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    m.onFirstPrompt = { fired.append($0) }

    m.sendPrompt("first prompt")
    XCTAssertEqual(fired, ["first prompt"])

    m.turn = .idle  // let a second prompt actually send
    m.sendPrompt("second prompt")
    XCTAssertEqual(fired, ["first prompt"])  // unchanged — did not fire again
  }

  // The bug this fix addresses: text/tool/text must stay three ordered blocks
  // — NOT one coalesced text block followed by a trailing tool.
  func testTextToolTextInterleaveInArrivalOrder() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    m.apply(.agentDelta(seq: 1, text: "A"))
    m.apply(.agentTool(seq: 2, name: "Bash", input: #"{"command":"ls"}"#))
    m.apply(.agentDelta(seq: 3, text: "B"))
    m.apply(.agentDone(seq: 4, cost: 0))

    let blocks = m.messages.last?.blocks ?? []
    XCTAssertEqual(blocks.count, 3)
    guard blocks.count == 3 else { return }
    guard case let .text(_, first) = blocks[0] else { return XCTFail("expected text block first") }
    XCTAssertEqual(first, "A")
    guard case let .tool(call) = blocks[1] else { return XCTFail("expected tool block second") }
    XCTAssertEqual(call.name, "Bash")
    guard case let .text(_, third) = blocks[2] else { return XCTFail("expected text block third") }
    XCTAssertEqual(third, "B")
  }

  func testErrorClearsAHalfStreamedTurn() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    m.apply(.agentDelta(seq: 1, text: "partial"))
    XCTAssertEqual(m.messages.last?.isStreaming, true)
    m.apply(.agentError(message: "boom"))
    let assistant = m.messages.first { $0.role == .assistant }
    XCTAssertEqual(assistant?.isStreaming, false)
    XCTAssertEqual(m.messages.last?.role, .error)
    XCTAssertEqual(m.turn, .idle)
  }
}
