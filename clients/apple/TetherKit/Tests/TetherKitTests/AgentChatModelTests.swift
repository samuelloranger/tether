import XCTest

@testable import TetherKit

@MainActor
final class AgentChatModelTests: XCTestCase {
  func testDeltasCoalesceIntoOneAssistantBubble() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    m.appendUser("hello")
    m.apply(.agentDelta(seq: 1, text: "Hel"))
    m.apply(.agentDelta(seq: 2, text: "lo"))
    m.apply(.agentDone(seq: 3, cost: 0, inputTokens: 0, outputTokens: 0))
    XCTAssertEqual(m.messages.count, 2)  // user + one assistant
    XCTAssertEqual(m.messages.last?.plainText, "Hello")
    XCTAssertEqual(m.messages.last?.isStreaming, false)
    XCTAssertEqual(m.turn, .idle)
  }

  /// The transcript view follows the foot by watching `revision`. It MUST tick
  /// on real content (so streamed output stays pinned) and MUST NOT tick on a
  /// draft edit (or typing would yank the scroll — the device bug this fixes).
  func testRevisionTracksContentNotDraft() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    XCTAssertEqual(m.revision, 0)

    m.appendUser("hi")
    let afterUser = m.revision
    XCTAssertGreaterThan(afterUser, 0)

    m.apply(.agentDelta(seq: 1, text: "one"))
    m.apply(.agentDelta(seq: 2, text: "two"))
    let afterDeltas = m.revision
    XCTAssertGreaterThan(afterDeltas, afterUser)

    m.apply(.agentTool(seq: 3, name: "Bash", input: #"{"command":"ls"}"#))
    m.apply(.agentToolResult(seq: 4, text: "ok", isError: false))
    let afterTool = m.revision
    XCTAssertGreaterThan(afterTool, afterDeltas)

    // Typing into the composer changes only the draft — no content, no tick.
    m.draft = "user is typing a long message"
    m.draft = "user is typing a long message that keeps growing"
    XCTAssertEqual(m.revision, afterTool, "draft edits must not bump revision")
  }

  func testDoneStoresUsageOnAssistantTurn() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    m.appendUser("hi")
    m.apply(.agentDelta(seq: 1, text: "done"))
    m.apply(.agentDone(seq: 2, cost: 0.03, inputTokens: 1200, outputTokens: 340))
    XCTAssertEqual(m.messages.last?.usage, AgentUsage(cost: 0.03, inputTokens: 1200, outputTokens: 340))
  }

  func testRetryResendsLastPromptAndDropsErrorRow() {
    var sent: [AgentOutbound] = []
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp", send: { sent.append($0) })
    m.submit("do the thing")
    m.apply(.agentError(message: "boom"))
    XCTAssertEqual(m.messages.last?.role, .error)
    XCTAssertTrue(m.canRetry)

    m.retryLast()
    XCTAssertFalse(m.messages.contains { $0.role == .error }, "error row dropped on retry")
    XCTAssertEqual(m.turn, .thinking)
    XCTAssertEqual(sent, [.prompt("do the thing"), .prompt("do the thing")])
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
    m.apply(.agentDone(seq: 5, cost: 0, inputTokens: 0, outputTokens: 0))
    XCTAssertEqual(m.lastSeq, 5)
  }

  // Server-side coalescing (agentRegistry.ts) persists several streamed deltas
  // as ONE replayed row — the reducer must render that identically to the
  // many-small-chunks live path: one assistant bubble either way.
  func testOneCoalescedReplayDeltaRendersSameAsManyLiveDeltas() {
    let live = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    live.apply(.agentDelta(seq: 1, text: "Hel"))
    live.apply(.agentDelta(seq: 2, text: "lo"))
    live.apply(.agentDone(seq: 3, cost: 0, inputTokens: 0, outputTokens: 0))

    let replayed = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    replayed.apply(.agentDelta(seq: 1, text: "Hello"))
    replayed.apply(.agentDone(seq: 3, cost: 0, inputTokens: 0, outputTokens: 0))

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
    m.apply(.agentDone(seq: 4, cost: 0, inputTokens: 0, outputTokens: 0))

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

  func testSessionUsageSumsFinishedTurns() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    XCTAssertNil(m.sessionUsage)  // nothing reported yet

    m.appendUser("one")
    m.apply(.agentDelta(seq: 1, text: "a"))
    m.apply(.agentDone(seq: 2, cost: 0.01, inputTokens: 1000, outputTokens: 200))
    m.appendUser("two")
    m.apply(.agentDelta(seq: 3, text: "b"))
    m.apply(.agentDone(seq: 4, cost: 0.02, inputTokens: 500, outputTokens: 50))

    let total = m.sessionUsage
    XCTAssertEqual(total?.inputTokens, 1500)
    XCTAssertEqual(total?.outputTokens, 250)
    XCTAssertEqual(total?.cost ?? -1, 0.03, accuracy: 1e-9)
  }

  func testSessionUsageNilWhenTurnsReportedNothing() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    m.appendUser("q")
    m.apply(.agentDelta(seq: 1, text: "a"))
    m.apply(.agentDone(seq: 2, cost: 0, inputTokens: 0, outputTokens: 0))
    XCTAssertNil(m.sessionUsage)  // a subscription turn — nothing worth showing
  }

  func testApplyStatusMergesFieldsAcrossFrames() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    XCTAssertNil(m.status)

    m.applyStatus(model: "claude-opus-4-8")
    XCTAssertEqual(m.status?.model, "claude-opus-4-8")
    XCTAssertNil(m.status?.fiveHour)

    // A later frame carrying only usage keeps the model.
    m.applyStatus(fiveHour: UsageWindow(utilization: 42))
    XCTAssertEqual(m.status?.model, "claude-opus-4-8")
    XCTAssertEqual(m.status?.fiveHour?.utilization, 42)

    // A later model update keeps the window.
    m.applyStatus(model: "claude-sonnet-5")
    XCTAssertEqual(m.status?.model, "claude-sonnet-5")
    XCTAssertEqual(m.status?.fiveHour?.utilization, 42)
  }

  func testAgentStatusFrameLightsUpTheStrip() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    XCTAssertNil(m.status)
    m.apply(
      .agentStatus(
        model: "claude-opus-4-8",
        fiveHour: UsageWindow(utilization: 42),
        sevenDay: UsageWindow(utilization: 78)))
    XCTAssertEqual(m.status?.model, "claude-opus-4-8")
    XCTAssertEqual(m.status?.fiveHour?.utilization, 42)
    XCTAssertEqual(m.status?.sevenDay?.utilization, 78)
  }

  func testAgentUserFrameAdvancesSeqWithoutDoubleBubble() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    m.appendUser("hi")  // local echo, as sendPrompt does
    let before = m.messages.count
    m.apply(.agentUser(seq: 5, text: "hi"))
    XCTAssertEqual(m.messages.count, before)  // no second user bubble
    XCTAssertEqual(m.lastSeq, 5)  // cursor advanced so reconnect won't replay it
  }

  func testAgentUserFrameAppendsBubbleWhenMissing() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    XCTAssertTrue(m.messages.isEmpty)
    XCTAssertEqual(m.turn, .idle)

    m.apply(.agentUser(seq: 1, text: "from desktop"))
    XCTAssertEqual(m.messages.count, 1)
    XCTAssertEqual(m.messages.first?.role, .user)
    XCTAssertEqual(m.messages.first?.plainText, "from desktop")
    XCTAssertEqual(m.turn, .thinking)
    XCTAssertEqual(m.lastSeq, 1)
  }

  func testAgentUserFrameAcksLocalEchoWithoutDuping() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp", send: { _ in })
    m.sendPrompt("hi")
    XCTAssertEqual(m.messages.count, 1)
    XCTAssertEqual(m.messages.first?.role, .user)

    m.apply(.agentUser(seq: 1, text: "hi"))
    XCTAssertEqual(m.messages.count, 1)
    XCTAssertEqual(m.lastSeq, 1)
    XCTAssertEqual(m.turn, .thinking)
  }

  func testSeqOrderedFramesAreDeduped() {
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp")
    XCTAssertEqual(m.lastSeq, 0)
    XCTAssertEqual(m.revision, 0)

    m.apply(.agentDelta(seq: 1, text: "A"))
    let afterFirst = (m.messages.last?.plainText, m.lastSeq, m.revision)

    // Duplicate seq must be ignored (no double-append, no revision tick).
    m.apply(.agentDelta(seq: 1, text: "B"))
    XCTAssertEqual(m.messages.last?.plainText, afterFirst.0)
    XCTAssertEqual(m.lastSeq, afterFirst.1)
    XCTAssertEqual(m.revision, afterFirst.2)
  }

  func testInfoStripTotalLabelFormatsTokensAndCost() {
    XCTAssertNil(AgentInfoStrip.totalLabel(nil))
    XCTAssertNil(
      AgentInfoStrip.totalLabel(AgentUsage(cost: 0, inputTokens: 0, outputTokens: 0)))
    XCTAssertEqual(
      AgentInfoStrip.totalLabel(AgentUsage(cost: 0.02, inputTokens: 1200, outputTokens: 480)),
      "1.2k↑ 480↓ · $0.02")
    XCTAssertEqual(
      AgentInfoStrip.totalLabel(AgentUsage(cost: 0.005, inputTokens: 0, outputTokens: 0)),
      "$0.0050")
  }
}
