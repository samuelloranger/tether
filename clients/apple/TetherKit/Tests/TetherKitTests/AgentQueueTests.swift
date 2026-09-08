import XCTest

@testable import TetherKit

@MainActor
final class AgentQueueTests: XCTestCase {
  func testSubmitWhileIdleSendsNow() {
    let m = AgentChatModel(sessionId: "a", cwd: "/tmp")
    m.submit("hi")
    XCTAssertEqual(m.turn, .thinking)
    XCTAssertTrue(m.queued.isEmpty)
    XCTAssertEqual(m.messages.last?.plainText, "hi")
  }

  func testSubmitWhileBusyQueues() {
    let m = AgentChatModel(sessionId: "a", cwd: "/tmp")
    m.submit("first")  // in flight
    m.submit("second")  // deferred
    XCTAssertEqual(m.queued, ["second"])
    XCTAssertEqual(m.messages.filter { $0.role == .user }.count, 1)
  }

  func testQueueFlushesOneTurnAtATimeOnDone() {
    let m = AgentChatModel(sessionId: "a", cwd: "/tmp")
    m.submit("first")
    m.submit("second")
    m.submit("third")
    XCTAssertEqual(m.queued, ["second", "third"])

    m.apply(.agentDone(seq: 1, cost: 0))
    XCTAssertEqual(m.turn, .thinking)  // "second" now in flight
    XCTAssertEqual(m.queued, ["third"])

    m.apply(.agentDone(seq: 2, cost: 0))
    XCTAssertEqual(m.turn, .thinking)  // "third" now in flight
    XCTAssertTrue(m.queued.isEmpty)

    m.apply(.agentDone(seq: 3, cost: 0))
    XCTAssertEqual(m.turn, .idle)
    XCTAssertEqual(
      m.messages.filter { $0.role == .user }.map(\.plainText),
      ["first", "second", "third"]
    )
  }

  func testQueueFlushesOnError() {
    let m = AgentChatModel(sessionId: "a", cwd: "/tmp")
    m.submit("first")
    m.submit("second")
    m.apply(.agentError(message: "boom"))
    XCTAssertEqual(m.turn, .thinking)
    XCTAssertTrue(m.queued.isEmpty)
  }

  func testCancelQueued() {
    let m = AgentChatModel(sessionId: "a", cwd: "/tmp")
    m.submit("first")
    m.submit("second")
    m.submit("third")
    m.cancelQueued(at: 0)  // drops "second"
    XCTAssertEqual(m.queued, ["third"])
  }

  func testEmptySubmitIgnored() {
    let m = AgentChatModel(sessionId: "a", cwd: "/tmp")
    m.submit("   ")
    XCTAssertEqual(m.turn, .idle)
    XCTAssertTrue(m.queued.isEmpty)
  }
}
