import XCTest
import UIKit
@testable import TetherKit

final class ChatSelectionTests: XCTestCase {
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
