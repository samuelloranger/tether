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

    guard case let .agentDone(_, cost) = try decode(#"{"t":"agent.done","seq":6,"cost":0.02}"#)
    else { return XCTFail("wrong case") }
    XCTAssertEqual(cost, 0.02, accuracy: 0.0001)
  }

  func testDecodesAgentError() throws {
    guard case let .agentError(message) = try decode(#"{"t":"agent.error","message":"boom"}"#)
    else { return XCTFail("wrong case") }
    XCTAssertEqual(message, "boom")
  }
}
