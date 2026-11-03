import XCTest
import UIKit
@testable import TetherKit

final class ChatSelectionTests: XCTestCase {
  @MainActor func test_diff_selection_retains_copy_file_and_copy_hunk_as_valid_patches() {
    let file = DiffFile(path: "file.swift", added: 1, removed: 1, rows: [
      DiffRow(id: 0, kind: .hunk, oldLine: nil, newLine: nil, text: "", header: "@@ -1 +1 @@"),
      DiffRow(id: 1, kind: .removed, oldLine: 1, newLine: nil, text: "old"),
      DiffRow(id: 2, kind: .added, oldLine: nil, newLine: 1, text: "new"),
    ])
    let rendered = ChatSelectableText(diff: file.rows, file: file)
    let view = ChatSelectionTextView()
    view.attributedText = rendered.attributedText()
    rendered.configureCopyActions(view)
    let hunk = NSRange(location: 0, length: 1)
    let menu = view.textView(view, editMenuForTextIn: hunk, suggestedActions: [])
    XCTAssertEqual(menu?.children.map(\.title), ["Copy file", "Copy hunk"])
    XCTAssertEqual(view.message, "--- a/file.swift\n+++ b/file.swift\n@@ -1 +1 @@\n-old\n+new\n")
    XCTAssertEqual(view.copyHunk?(hunk), "@@ -1 +1 @@\n-old\n+new\n")
    XCTAssertNil(view.copyHunk?(NSRange(location: 3, length: 2)))
  }

  @MainActor func test_quoted_list_items_keep_distinct_quote_styling() {
    let quoted = ChatSelectableText(blocks: MarkdownDocument.parse("> - one\n> - two")).attributedText()
    let plain = ChatSelectableText(blocks: MarkdownDocument.parse("- one\n- two")).attributedText()
    let range = (quoted.string as NSString).range(of: "one")
    let font = quoted.attribute(.font, at: range.location, effectiveRange: nil) as? UIFont
    let plainFont = plain.attribute(.font, at: range.location, effectiveRange: nil) as? UIFont
    XCTAssertEqual(quoted.string, plain.string)
    XCTAssertTrue(font?.fontDescriptor.symbolicTraits.contains(.traitItalic) == true)
    XCTAssertFalse(plainFont?.fontDescriptor.symbolicTraits.contains(.traitItalic) == true)
  }

  func test_selected_prose_flattens_paragraphs_and_windows_newlines() {
    let text = NSAttributedString(string: "before first\r\n  second\n\nthird after")
    let range = (text.string as NSString).range(of: "first\r\n  second\n\nthird")
    XCTAssertEqual(ChatSelectionCopy.text(text, range: range), "first second third")
  }

  func test_mixed_selection_preserves_code_and_indentation() {
    let text = NSMutableAttributedString(string: "Intro\n\ntext")
    text.append(NSAttributedString(string: "\nlet a = 1\n  print(a)\n", attributes: [.chatCode: true]))
    text.append(NSAttributedString(string: "Last\nparagraph"))
    XCTAssertEqual(ChatSelectionCopy.text(text, range: NSRange(location: 0, length: text.length)),
      "Intro text\nlet a = 1\n  print(a)\nLast paragraph")
  }

  func test_partial_code_and_unicode_use_utf16_ranges() {
    let text = NSAttributedString(string: "🙂 café\n  next", attributes: [.chatCode: true])
    let range = (text.string as NSString).range(of: "café\n  next")
    XCTAssertEqual(ChatSelectionCopy.text(text, range: range), "café\n  next")
    XCTAssertEqual(ChatSelectionCopy.text(text, range: NSRange(location: text.length, length: 0)), "")
  }

  @MainActor func test_rendered_markdown_keeps_links_and_code_copy_boundaries() {
    let view = ChatSelectableText(blocks: MarkdownDocument.parse("Before **bold**\n\n[site](https://example.com)\n\n```swift\nlet a = 1\n  print(a)\n```\n\nAfter"))
    let text = view.attributedText()
    XCTAssertEqual(text.string, "Before bold\nsite\nlet a = 1\n  print(a)\nAfter")
    let link = (text.string as NSString).range(of: "site")
    XCTAssertEqual(text.attribute(.link, at: link.location, effectiveRange: nil) as? URL, URL(string: "https://example.com"))
    XCTAssertEqual(ChatSelectionCopy.text(text, range: NSRange(location: 0, length: text.length)),
      "Before bold site\nlet a = 1\n  print(a)\nAfter")
  }

  @MainActor func test_native_copy_uses_only_the_selected_range() {
    let view = ChatSelectionTextView()
    view.attributedText = NSAttributedString(string: "before hello\nworld after")
    view.selectedRange = NSRange(location: 7, length: 11)
    var copied: String?
    view.writeClipboard = { copied = $0 }
    view.copy(nil)
    XCTAssertEqual(copied, "hello world")
  }
}
