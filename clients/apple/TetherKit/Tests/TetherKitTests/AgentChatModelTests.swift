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

  func testSendPromptAppendsUserAndFiresOutbound() {
    var sent: [AgentOutbound] = []
    let m = AgentChatModel(sessionId: "a1", cwd: "/tmp", send: { sent.append($0) })
    m.sendPrompt("do a thing")
    XCTAssertEqual(m.messages.first?.role, .user)
    XCTAssertEqual(m.turn, .thinking)
    XCTAssertEqual(sent, [.prompt("do a thing")])
  }
}
