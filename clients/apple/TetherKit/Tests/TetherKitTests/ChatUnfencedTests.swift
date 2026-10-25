import XCTest
@testable import TetherKit

final class ChatUnfencedTests: XCTestCase {
  func test_a_fenced_shell_output_loses_its_fence_lines() {
    XCTAssertEqual(ChatFormat.unfenced("```console\nports 8081 closed\n```"), "ports 8081 closed")
    XCTAssertEqual(ChatFormat.unfenced("```\na\nb\n```\n"), "a\nb")
  }

  func test_text_without_a_whole_fence_is_left_alone() {
    XCTAssertEqual(ChatFormat.unfenced("plain output"), "plain output")
    XCTAssertEqual(ChatFormat.unfenced("```console\nunterminated"), "```console\nunterminated")
    XCTAssertEqual(ChatFormat.unfenced("before\n```x\ny\n```"), "before\n```x\ny\n```")
    XCTAssertNil(ChatFormat.unfenced(nil))
  }

  func test_an_empty_fenced_block_becomes_empty() {
    XCTAssertEqual(ChatFormat.unfenced("```console\n```"), "")
  }
}
