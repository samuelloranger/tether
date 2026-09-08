import XCTest

@testable import TetherKit

final class ProseMarkdownTests: XCTestCase {
  func testHeadingLevels() {
    XCTAssertEqual(parseProse("## Title"), [.heading(level: 2, text: "Title")])
    XCTAssertEqual(parseProse("#### Deep"), [.heading(level: 4, text: "Deep")])
  }

  func testHashWithoutSpaceIsParagraph() {
    XCTAssertEqual(parseProse("#nospace"), [.paragraph(text: "#nospace")])
  }

  func testUnorderedList() {
    XCTAssertEqual(
      parseProse("- one\n- two"),
      [.bullet(text: "one"), .bullet(text: "two")]
    )
    XCTAssertEqual(parseProse("* star"), [.bullet(text: "star")])
  }

  func testOrderedList() {
    XCTAssertEqual(
      parseProse("1. first\n2. second"),
      [.ordered(number: 1, text: "first"), .ordered(number: 2, text: "second")]
    )
    XCTAssertEqual(parseProse("3) paren"), [.ordered(number: 3, text: "paren")])
  }

  func testConsecutivePlainLinesFoldIntoOneParagraph() {
    XCTAssertEqual(
      parseProse("line one\nline two"),
      [.paragraph(text: "line one\nline two")]
    )
  }

  func testBlankLineSeparatesParagraphs() {
    XCTAssertEqual(
      parseProse("a\n\nb"),
      [.paragraph(text: "a"), .paragraph(text: "b")]
    )
  }

  func testMixedBlocks() {
    let md = "## Steps\nintro text\n- do this\n1. then this"
    XCTAssertEqual(
      parseProse(md),
      [
        .heading(level: 2, text: "Steps"),
        .paragraph(text: "intro text"),
        .bullet(text: "do this"),
        .ordered(number: 1, text: "then this"),
      ]
    )
  }
}
