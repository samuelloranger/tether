import XCTest
@testable import TetherKit

/// A pull-request body is GitHub-flavored markdown, and showing it raw puts `##`,
/// pipes and backticks in front of the reader.
final class MarkdownDocumentTests: XCTestCase {
  private func plain(_ text: AttributedString) -> String { String(text.characters) }

  private func links(_ text: AttributedString) -> [String] {
    text.runs.compactMap { $0.link?.absoluteString }
  }

  /// Each block reduced to a readable line, so a test states the whole document at once.
  private func outline(_ body: String) -> [String] {
    MarkdownDocument.parse(body).flatMap { block -> [String] in
      switch block {
      case let .heading(level, text): ["h\(level) \(plain(text))"]
      case let .paragraph(text): ["p \(plain(text))"]
      case let .quote(text): ["> \(plain(text))"]
      case let .code(lines): ["code \(lines)"]
      case .rule: ["---"]
      case let .table(header, rows):
        ["table \(header.map(plain)) \(rows.map { $0.map(plain) })"]
      case let .list(items):
        items.map { item in
          let marker = switch item.marker {
          case .bullet: "•"
          case let .number(n): "\(n)."
          case let .task(done): done ? "[x]" : "[ ]"
          case .continuation: "_"
          }
          return String(repeating: "  ", count: item.depth) + "\(marker) \(plain(item.text))"
        }
      }
    }
  }

  func test_headings_carry_their_level_capped_at_three() {
    XCTAssertEqual(outline("# One\n## Two\n#### Four"), ["h1 One", "h2 Two", "h3 Four"])
  }

  func test_blank_lines_separate_paragraphs_and_soft_breaks_do_not() {
    XCTAssertEqual(outline("first line\nstill first\n\nsecond"), ["p first line still first", "p second"])
  }

  func test_bullets_and_numbers_get_their_marker() {
    XCTAssertEqual(outline("- one\n- two\n\n1. first\n2. second"), ["• one", "• two", "1. first", "2. second"])
  }

  func test_a_numbered_list_keeps_its_start() {
    XCTAssertEqual(outline("3. three\n4. four"), ["3. three", "4. four"])
    XCTAssertEqual(outline("3.14 is pi"), ["p 3.14 is pi"])
  }

  func test_nested_lists_carry_their_depth() {
    XCTAssertEqual(outline("- top\n  - inner\n    - deepest\n- next"), ["• top", "  • inner", "    • deepest", "• next"])
  }

  func test_task_list_items_show_their_state() {
    XCTAssertEqual(outline("- [ ] write tests\n- [x] ship it"), ["[ ] write tests", "[x] ship it"])
  }

  func test_a_second_paragraph_of_an_item_is_not_marked_again() {
    XCTAssertEqual(outline("1. first\n\n   more about first\n2. second"), ["1. first", "_ more about first", "2. second"])
  }

  func test_a_fenced_block_keeps_its_lines_verbatim() {
    XCTAssertEqual(outline("before\n\n```swift\nlet a = 1\n\n  indented\n```\n\nafter"), [
      "p before",
      #"code ["let a = 1", "", "  indented"]"#,
      "p after",
    ])
  }

  func test_an_unclosed_fence_still_yields_its_lines() {
    XCTAssertEqual(outline("```\nstranded"), [#"code ["stranded"]"#])
  }

  func test_quotes_and_rules_are_their_own_blocks() {
    XCTAssertEqual(outline("> quoted\n> still quoted\n\n---"), ["> quoted still quoted", "---"])
  }

  func test_an_empty_body_has_no_blocks() {
    XCTAssertEqual(MarkdownDocument.parse("   \n\n"), [])
  }

  func test_a_list_inside_a_quote_keeps_the_quote() {
    guard case let .list(items) = MarkdownDocument.parse("> - one\n> - two").first else {
      return XCTFail("expected a list")
    }
    XCTAssertEqual(items.map(\.quoted), [true, true])
    guard case let .list(plainItems) = MarkdownDocument.parse("- one").first else {
      return XCTFail("expected a list")
    }
    XCTAssertEqual(plainItems.map(\.quoted), [false])
  }

  func test_a_table_keeps_its_header_and_cells() {
    XCTAssertEqual(
      outline("| name | n |\n|---|--:|\n| **alpha** | 1 |\n| b | 22 |"),
      [#"table ["name", "n"] [["alpha", "1"], ["b", "22"]]"#]
    )
  }

  func test_html_comments_and_tags_are_dropped_but_their_body_stays() {
    XCTAssertEqual(
      outline("<!-- describe your change -->\n\n<details>\n<summary>Logs</summary>\n\nthe body\n\n</details>"),
      ["p the body"]
    )
  }

  func test_quotes_are_kept_straight() {
    XCTAssertEqual(outline(#"it's "fine" -- really"#), [#"p it's "fine" -- really"#])
  }

  func test_emphasis_strike_and_code_become_attributes_not_markers() {
    guard case let .paragraph(text) = MarkdownDocument.parse("a **bold** and `code` and *it* and ~~gone~~").first else {
      return XCTFail("expected a paragraph")
    }
    XCTAssertEqual(plain(text), "a bold and code and it and gone")
    let intents = text.runs.compactMap(\.inlinePresentationIntent)
    XCTAssertTrue(intents.contains(.stronglyEmphasized))
    XCTAssertTrue(intents.contains(.code))
    XCTAssertTrue(intents.contains(.emphasized))
    XCTAssertTrue(intents.contains(.strikethrough))
  }

  func test_nested_emphasis_keeps_both_intents() {
    guard case let .paragraph(text) = MarkdownDocument.parse("***both***").first else {
      return XCTFail("expected a paragraph")
    }
    XCTAssertEqual(text.runs.first?.inlinePresentationIntent, [.emphasized, .stronglyEmphasized])
  }

  func test_a_link_keeps_its_label_and_points_at_its_url() {
    guard case let .paragraph(text) = MarkdownDocument.parse("see [the docs](https://example.test/a_(b)) now").first else {
      return XCTFail("expected a paragraph")
    }
    XCTAssertEqual(plain(text), "see the docs now")
    XCTAssertEqual(links(text), ["https://example.test/a_(b)"])
  }

  func test_bare_urls_become_links_without_trailing_punctuation() {
    guard case let .paragraph(text) = MarkdownDocument.parse("go to https://example.test/x, then <https://example.test/y>.").first else {
      return XCTFail("expected a paragraph")
    }
    XCTAssertEqual(plain(text), "go to https://example.test/x, then https://example.test/y.")
    XCTAssertEqual(links(text), ["https://example.test/x", "https://example.test/y"])
  }

  func test_only_links_the_app_would_open_elsewhere_are_kept() {
    guard case let .paragraph(text) = MarkdownDocument.parse(
      "[run](javascript:alert(1)) and [file](file:///etc/passwd) and [rel](docs/a.md)"
    ).first else {
      return XCTFail("expected a paragraph")
    }
    XCTAssertEqual(plain(text), "run and file and rel")
    XCTAssertEqual(links(text), [])
  }

  func test_an_image_shows_its_alt_text() {
    XCTAssertEqual(outline("![logo](https://example.test/l.png)"), ["p logo"])
  }
}
