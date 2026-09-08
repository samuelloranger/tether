import XCTest

@testable import TetherKit

final class AgentFrameDecodeTests: XCTestCase {
  private func decode(_ json: String) throws -> NoiseServerMessage {
    try JSONDecoder().decode(NoiseServerMessage.self, from: Data(json.utf8))
  }

  func testDecodesAgentDelta() throws {
    guard case let .agentDelta(seq, text) = try decode(#"{"t":"agent.delta","seq":3,"text":"Hi"}"#)
    else { return XCTFail("wrong case") }
    XCTAssertEqual(seq, 3)
    XCTAssertEqual(text, "Hi")
  }

  func testDecodesAgentToolWithObjectInput() throws {
    let json = #"{"t":"agent.tool","seq":4,"name":"Bash","input":{"command":"ls -la"}}"#
    guard case let .agentTool(seq, name, input) = try decode(json) else {
      return XCTFail("wrong case")
    }
    XCTAssertEqual(seq, 4)
    XCTAssertEqual(name, "Bash")
    XCTAssertTrue(input.contains("\"command\""))
    XCTAssertTrue(input.contains("ls -la"))
  }

  func testDecodesAgentToolResultAndDone() throws {
    guard
      case let .agentToolResult(_, text, isError) = try decode(
        #"{"t":"agent.tool_result","seq":5,"text":"ok","isError":false}"#)
    else { return XCTFail("wrong case") }
    XCTAssertEqual(text, "ok")
    XCTAssertFalse(isError)

    guard case let .agentDone(_, cost, _, _) = try decode(#"{"t":"agent.done","seq":6,"cost":0.02}"#)
    else { return XCTFail("wrong case") }
    XCTAssertEqual(cost, 0.02, accuracy: 0.0001)

    // Token usage rides in the `usage` sub-object; a frame without it is 0.
    guard
      case let .agentDone(_, _, inTok, outTok) = try decode(
        #"{"t":"agent.done","seq":7,"cost":0.03,"usage":{"input_tokens":1234,"output_tokens":56}}"#)
    else { return XCTFail("wrong case") }
    XCTAssertEqual(inTok, 1234)
    XCTAssertEqual(outTok, 56)
  }

  func testDecodesAgentError() throws {
    guard case let .agentError(message) = try decode(#"{"t":"agent.error","message":"boom"}"#)
    else { return XCTFail("wrong case") }
    XCTAssertEqual(message, "boom")
  }

  func testDecodesAgentUser() throws {
    guard case let .agentUser(seq, text) = try decode(#"{"t":"agent.user","seq":1,"text":"Hi"}"#)
    else { return XCTFail("wrong case") }
    XCTAssertEqual(seq, 1)
    XCTAssertEqual(text, "Hi")
  }

  func testDecodesAgentStatusWithWindows() throws {
    let json = #"""
      {"t":"agent.status","model":"claude-opus-4-8",
       "fiveHour":{"utilization":42,"resetsAt":"2026-09-08T20:00:00Z"},
       "sevenDay":{"utilization":78,"resetsAt":null}}
      """#
    guard case let .agentStatus(model, five, seven) = try decode(json)
    else { return XCTFail("wrong case") }
    XCTAssertEqual(model, "claude-opus-4-8")
    XCTAssertEqual(five?.utilization, 42)
    XCTAssertEqual(five?.resetsAt, "2026-09-08T20:00:00Z")
    XCTAssertEqual(seven?.utilization, 78)
    XCTAssertNil(seven?.resetsAt)
  }

  func testAgentStatusToleratesMissingFields() throws {
    guard case let .agentStatus(model, five, seven) = try decode(#"{"t":"agent.status"}"#)
    else { return XCTFail("wrong case") }
    XCTAssertNil(model)
    XCTAssertNil(five)
    XCTAssertNil(seven)
  }

  // The whole point of the fix: an unknown frame type must NOT throw (a thrown
  // decode tears down the session), it decodes to `.ignored`.
  func testUnknownFrameTypeIsIgnoredNotThrown() throws {
    guard case .ignored = try decode(#"{"t":"agent.future_thing","whatever":1}"#)
    else { return XCTFail("expected .ignored") }
  }
}
