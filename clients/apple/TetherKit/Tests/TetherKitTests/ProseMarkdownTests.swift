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

  func testPipeTableParsesHeaderAndRows() {
    let md = "| Sev | Finding |\n|---|---|\n| Low | orphaned stack |\n| Info | flap |"
    XCTAssertEqual(
      parseProse(md),
      [
        .table(
          header: ["Sev", "Finding"],
          rows: [["Low", "orphaned stack"], ["Info", "flap"]]
        )
      ]
    )
  }

  func testTableSeparatorAcceptsAlignmentColons() {
    let md = "| A | B | C |\n|:--|:-:|--:|\n| 1 | 2 | 3 |"
    XCTAssertEqual(
      parseProse(md),
      [.table(header: ["A", "B", "C"], rows: [["1", "2", "3"]])]
    )
  }

  func testTableWithoutOuterPipesStillParses() {
    let md = "a | b\n--- | ---\n1 | 2"
    XCTAssertEqual(
      parseProse(md),
      [.table(header: ["a", "b"], rows: [["1", "2"]])]
    )
  }

  func testTableEndsAtBlankLineAndProseResumes() {
    let md = "| H |\n|---|\n| r |\n\nafter"
    XCTAssertEqual(
      parseProse(md),
      [.table(header: ["H"], rows: [["r"]]), .paragraph(text: "after")]
    )
  }

  func testPipeLineWithoutSeparatorStaysParagraph() {
    // A stray pipe in prose must not be mistaken for a table.
    XCTAssertEqual(
      parseProse("use a | b pipe here"),
      [.paragraph(text: "use a | b pipe here")]
    )
  }

  func testDataRowWithDashesIsNotMistakenForSeparator() {
    // A row whose cells contain hyphens (rawkoon-db-dev) is data, not a rule.
    let md = "| Sev | Name |\n|---|---|\n| Low | rawkoon-db-dev |"
    XCTAssertEqual(
      parseProse(md),
      [.table(header: ["Sev", "Name"], rows: [["Low", "rawkoon-db-dev"]])]
    )
  }
}
