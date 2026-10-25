import XCTest
@testable import TetherKit

final class ChatToolDetailTests: XCTestCase {
  func test_shell_output_arrives_as_a_code_block_not_literal_backticks() {
    let blocks = ChatToolDetail.blocks(text: "```console\nports 8081 closed\n```", rawOutput: "ignored")
    XCTAssertEqual(blocks, [.code(["ports 8081 closed"])])
  }

  func test_prose_and_a_fence_in_one_result_both_render() {
    let blocks = ChatToolDetail.blocks(text: "Ran it:\n\n```console\nok\n```", rawOutput: nil)
    XCTAssertEqual(blocks.count, 2)
    XCTAssertEqual(blocks.last, .code(["ok"]))
  }

  func test_raw_output_is_the_fallback_when_there_is_no_content() {
    XCTAssertEqual(ChatToolDetail.blocks(text: nil, rawOutput: "a\nb"), [.code(["a", "b"])])
    XCTAssertEqual(ChatToolDetail.blocks(text: "  \n", rawOutput: "a"), [.code(["a"])])
  }

  func test_nothing_to_show_is_empty() {
    XCTAssertFalse(ChatToolDetail.hasContent(text: " ", rawOutput: nil))
    XCTAssertEqual(ChatToolDetail.blocks(text: nil, rawOutput: ""), [])
  }

  func test_a_long_code_block_is_cut_with_a_count() {
    let lines = (1...250).map { "line \($0)" }.joined(separator: "\n")
    guard case let .code(shown)? = ChatToolDetail.blocks(text: nil, rawOutput: lines).first else { return XCTFail() }
    XCTAssertEqual(shown.count, ChatToolDetail.maxCodeLines + 1)
    XCTAssertEqual(shown.last, "\u{2026} 50 more lines")
  }
}
