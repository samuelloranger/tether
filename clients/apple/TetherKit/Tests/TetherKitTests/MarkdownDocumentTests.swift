import XCTest
@testable import TetherKit

/// A pull-request body is markdown, and showing it raw puts `##` and backticks
/// in front of the reader.
final class MarkdownDocumentTests: XCTestCase {
  func test_headings_carry_their_level() {
    let blocks = MarkdownDocument.parse("# One\n## Two\n### Three")
    XCTAssertEqual(blocks, [.heading(level: 1, text: "One"), .heading(level: 2, text: "Two"), .heading(level: 3, text: "Three")])
  }

  func test_blank_lines_separate_paragraphs_and_soft_breaks_do_not() {
    let blocks = MarkdownDocument.parse("first line\nstill first\n\nsecond")
    XCTAssertEqual(blocks, [.paragraph("first line still first"), .paragraph("second")])
  }

  func test_bullets_group_into_one_list() {
    let blocks = MarkdownDocument.parse("- one\n- two\n* three")
    XCTAssertEqual(blocks, [.bullets(["one", "two", "three"])])
  }

  func test_numbered_items_keep_their_order() {
    XCTAssertEqual(MarkdownDocument.parse("1. first\n2. second"), [.numbered(["first", "second"])])
  }

  func test_a_fenced_block_keeps_its_lines_verbatim() {
    let blocks = MarkdownDocument.parse("before\n\n```swift\nlet a = 1\n\n  indented\n```\n\nafter")
    XCTAssertEqual(blocks, [
      .paragraph("before"),
      .code(["let a = 1", "", "  indented"]),
      .paragraph("after"),
    ])
  }

  func test_an_unclosed_fence_still_yields_its_lines() {
    XCTAssertEqual(MarkdownDocument.parse("```\nstranded"), [.code(["stranded"])])
  }

  func test_quotes_and_rules_are_their_own_blocks() {
    XCTAssertEqual(MarkdownDocument.parse("> quoted\n\n---"), [.quote("quoted"), .rule])
  }

  func test_an_empty_body_has_no_blocks() {
    XCTAssertEqual(MarkdownDocument.parse("   \n\n"), [])
  }
}
