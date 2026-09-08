import XCTest

@testable import TetherKit

@MainActor
final class AgentControlTests: XCTestCase {
  func testInterruptMarksInterruptingAndSends() {
    var sent: [AgentOutbound] = []
    let m = AgentChatModel(sessionId: "a", cwd: "/tmp", send: { sent.append($0) })
    m.sendPrompt("go")
    m.interrupt()
    XCTAssertTrue(m.interrupting)
    XCTAssertTrue(sent.contains(.interrupt))
  }

  func testInterruptIgnoredWhenIdle() {
    var sent: [AgentOutbound] = []
    let m = AgentChatModel(sessionId: "a", cwd: "/tmp", send: { sent.append($0) })
    m.interrupt()
    XCTAssertFalse(m.interrupting)
    XCTAssertFalse(sent.contains(.interrupt))
  }

  func testInterruptingClearsOnDone() {
    let m = AgentChatModel(sessionId: "a", cwd: "/tmp")
    m.sendPrompt("go")
    m.interrupt()
    m.apply(.agentDone(seq: 1, cost: 0))
    XCTAssertFalse(m.interrupting)
  }

  func testSecondApprovalQueuesBehindFirst() {
    let m = AgentChatModel(sessionId: "a", cwd: "/tmp")
    m.apply(.agentPermissionReq(reqId: UUID().uuidString, name: "Bash", input: "{}"))
    m.apply(.agentPermissionReq(reqId: UUID().uuidString, name: "Write", input: "{}"))
    XCTAssertEqual(m.pendingApproval?.name, "Bash")

    m.resolveApproval("allow")
    XCTAssertEqual(m.pendingApproval?.name, "Write")  // second surfaces, not lost

    m.resolveApproval("allow")
    XCTAssertNil(m.pendingApproval)
  }

  func testDenyWithBacklogDoesNotIdle() {
    let m = AgentChatModel(sessionId: "a", cwd: "/tmp")
    m.sendPrompt("go")  // turn = thinking
    m.apply(.agentPermissionReq(reqId: UUID().uuidString, name: "Bash", input: "{}"))
    m.apply(.agentPermissionReq(reqId: UUID().uuidString, name: "Write", input: "{}"))
    m.resolveApproval("deny")
    XCTAssertEqual(m.pendingApproval?.name, "Write")
    XCTAssertNotEqual(m.turn, .idle)  // still one to answer
  }
}
