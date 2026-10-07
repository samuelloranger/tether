import SnapshotTesting
import SwiftUI
import UIKit
import XCTest

@testable import TetherKit

/// Whole-picture checks for what structural tests can't see: glyph placement, colours,
/// spacing. References are recorded on the simulator CI runs (iPhone 16, iOS 26.2); the
/// tolerance absorbs anti-aliasing differences between runtimes, not layout changes.
/// To re-record after an intended change, delete the image in `__Snapshots__` and run once.
@MainActor
final class SnapshotTests: XCTestCase {
  private let image = Snapshotting<UIImage, UIImage>.image(precision: 0.99, perceptualPrecision: 0.97)

  // MARK: Terminal

  private func renderTerminal(_ bytes: String, cols: Int, rows: Int) -> UIImage? {
    let engine = TerminalEngine(cols: UInt16(cols), rows: UInt16(rows))
    engine.feed(Data(bytes.utf8))
    let frame = engine.frame()
    let font = UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)
    let bold = UIFont.monospacedSystemFont(ofSize: 14, weight: .bold)
    let cellWidth = ceil(("M" as NSString).size(withAttributes: [.font: font]).width)
    let cellHeight = ceil(font.lineHeight)
    let bg = TerminalTheme.tether.background
    let metrics = TerminalRenderMetrics(
      cellWidth: cellWidth,
      cellHeight: cellHeight,
      size: CGSize(width: cellWidth * CGFloat(cols), height: cellHeight * CGFloat(rows)),
      scale: 2,
      font: font,
      boldFont: bold,
      background: CGColor(
        srgbRed: CGFloat((bg >> 16) & 0xFF) / 255, green: CGFloat((bg >> 8) & 0xFF) / 255,
        blue: CGFloat(bg & 0xFF) / 255, alpha: 1
      )
    )
    let rendered = TerminalGridRenderer().render(header: frame.header, cells: frame.cells, metrics: metrics)
    return rendered.map { UIImage(cgImage: $0, scale: 2, orientation: .up) }
  }

  func test_terminal_colours_attributes_and_wide_characters() throws {
    let esc = "\u{1B}["
    let screen = [
      "\(esc)1;32muser@host\(esc)0m:\(esc)1;34m~/project\(esc)0m$ git status",
      "\(esc)31mred\(esc)0m \(esc)32mgreen\(esc)0m \(esc)33myellow\(esc)0m \(esc)35mmagenta\(esc)0m \(esc)36mcyan\(esc)0m",
      "\(esc)1mbold\(esc)0m \(esc)3mitalic\(esc)0m \(esc)4munderline\(esc)0m \(esc)7minverse\(esc)0m \(esc)9mstrike\(esc)0m",
      "\(esc)38;5;208m256-colour\(esc)0m \(esc)48;2;40;90;160m truecolour bg \(esc)0m",
      "wide: 你好 世界 | emoji: ✓ ✗",
      "┌──────────┐",
      "│ box line │",
      "└──────────┘",
    ].joined(separator: "\r\n")
    let rendered = try XCTUnwrap(renderTerminal(screen, cols: 44, rows: 9))
    assertSnapshot(of: rendered, as: image)
  }

  // MARK: Pull-request body

  private let sampleBody = """
    ## Summary

    Fixes **reconnect** after the network drops, see [the issue](https://example.test/issues/1).

    - [x] parse the header
    - [ ] handle `EAGAIN`
      - nested detail with *emphasis*
    3. third
    4. fourth

    | Case | Before | After |
    |---|---|--:|
    | cold start | 2.1 s | 0.4 s |
    | resume | fails | 0.1 s |

    > Note: only affects ~~old~~ hosts.
    >
    > - quoted item

    ```swift
    let session = try await connect()
    ```

    ---
    <!-- template comment that should not show -->
    """

  /// Laid out at a phone's width and its own height, as it sits in the scroll view.
  private func assertLooks(_ view: some View, dark: Bool, file: StaticString = #filePath, testName: String = #function, line: UInt = #line) {
    let framed = view
      .padding(14)
      .frame(width: 375, alignment: .topLeading)
      .background(TetherColors.background)
    assertSnapshot(
      of: framed,
      as: .image(
        precision: 0.99,
        perceptualPrecision: 0.97,
        layout: .sizeThatFits,
        traits: UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
      ),
      file: file,
      testName: testName,
      line: line
    )
  }

  func test_pull_request_body_light() {
    assertLooks(MarkdownBodyView(blocks: MarkdownDocument.parse(sampleBody)), dark: false)
  }

  func test_pull_request_body_dark() {
    assertLooks(MarkdownBodyView(blocks: MarkdownDocument.parse(sampleBody)), dark: true)
  }

  // MARK: Diff

  func test_diff_review() {
    let patch = """
      diff --git a/Sources/App/Reconnect.swift b/Sources/App/Reconnect.swift
      index 1111111..2222222 100644
      --- a/Sources/App/Reconnect.swift
      +++ b/Sources/App/Reconnect.swift
      @@ -10,7 +10,8 @@ final class Reconnect {
         func start() {
      -    timer = Timer(interval: 5)
      +    timer = Timer(interval: backoff.next())
      +    attempts += 1
           timer.resume()
         }
       }
      """
    assertLooks(DiffReviewView(files: DiffFile.group(GitDiffModel.classify(patch))), dark: true)
  }
}
