import SwiftUI
import UIKit
import XCTest
@testable import TetherKit

final class ChatMarkdownTableTests: XCTestCase {
  private let markdown = """
    Before **bold**.

    | Component | Our code | Upstream |
    | --- | --- | --- |
    | Jellyfin Android TV player/profile code | Adapted into our player | Translations, tooling updates and a home/search lifecycle fix; no player changes. [History](https://example.com/history) |
    | Media3 / ExoPlayer | `1.8.0` | Stable **1.11.1**, including seeking, playback stability and HLS fixes. |

    After.
    """

  func test_tables_keep_their_boundaries_and_surrounding_prose_order() {
    let blocks = MarkdownDocument.parse(markdown)
    let groups = ChatMarkdownView.groups(blocks)
    XCTAssertEqual(groups.map(\.count), [1, 1, 1])
    XCTAssertEqual(groups.flatMap { $0 }, blocks)
    guard case let .table(header, rows) = groups[1][0] else { return XCTFail("Expected a table") }
    XCTAssertEqual(header.map { String($0.characters) }, ["Component", "Our code", "Upstream"])
    XCTAssertEqual(rows.count, 2)
    XCTAssertEqual(rows[0][2].runs.compactMap(\.link), [URL(string: "https://example.com/history")!])
  }

  func test_plain_messages_remain_one_continuous_selection() {
    let blocks = MarkdownDocument.parse("First.\n\nSecond.\n\n```swift\nlet a = 1\n```\n\nLast.")
    XCTAssertEqual(ChatMarkdownView.groups(blocks), [blocks])
    XCTAssertTrue(ChatMarkdownView.groups([]).isEmpty)
    let table = MarkdownBlock.table(header: [], rows: [])
    XCTAssertEqual(ChatMarkdownView.groups([table, table]), [[table], [table]])
  }

  @MainActor func test_columns_are_bounded_and_scale_with_dynamic_type() {
    guard case let .table(header, rows) = MarkdownDocument.parse(markdown)[1] else { return XCTFail("Expected a table") }
    let widths = ChatMarkdownTable.columnWidths(header: header, rows: rows, font: .systemFont(ofSize: 15))
    XCTAssertEqual(widths.count, 3)
    XCTAssertEqual(widths[2], 240)
    XCTAssertLessThan(widths[1], widths[2])
    let large = ChatMarkdownTable.columnWidths(header: header, rows: rows, font: .systemFont(ofSize: 30))
    XCTAssertEqual(large[2], 480)
    XCTAssertEqual(ChatMarkdownTable.columnWidths(header: [], rows: [], font: .systemFont(ofSize: 15)), [])
  }

  @MainActor func test_phone_table_has_aligned_cells_and_preserves_copy_message() {
    let content = ChatMarkdownView(blocks: MarkdownDocument.parse(markdown), message: markdown)
    let host = UIHostingController(rootView: content.environment(\.colorScheme, .dark))
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 375, height: 1500))
    window.rootViewController = host
    window.makeKeyAndVisible()
    host.view.frame = window.bounds
    host.view.layoutIfNeeded()
    func textViews(_ view: UIView) -> [ChatSelectionTextView] {
      (view as? ChatSelectionTextView).map { [$0] } ?? view.subviews.flatMap(textViews)
    }
    let views = textViews(host.view)
    XCTAssertEqual(views.count, 11, "Nine separate table cells plus the surrounding prose")
    let cells = views.filter { !["Before bold.", "After."].contains($0.text ?? "") }
    XCTAssertEqual(cells.count, 9)
    XCTAssertTrue(cells.allSatisfy { $0.message == markdown && $0.isSelectable })
    let versions = cells.filter { ["Our code", "Adapted into our player", "1.8.0"].contains($0.text ?? "") }
    let origins = versions.map { $0.convert(CGPoint.zero, to: host.view).x }
    XCTAssertEqual(origins.count, 3)
    XCTAssertLessThan((origins.max() ?? 1) - (origins.min() ?? 0), 1)
    XCTAssertLessThan(cells.map { $0.bounds.width }.max() ?? .infinity, 300)
    window.isHidden = true
  }
}
