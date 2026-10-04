import XCTest
@testable import TetherKit

final class LinkSpansTests: XCTestCase {
  func testExternalUrlIsDetectedAndHitTested() {
    let texts = ["see https://example.com/path now"]
    let spans = LinkSpans.compute(texts: texts, wrapped: [false])
    XCTAssertEqual(spans.count, 1)
    XCTAssertEqual(spans[0].count, 1)
    guard let span = spans[0].first else {
      return XCTFail("expected a url span")
    }
    XCTAssertEqual(span.target, .external(url: "https://example.com/path"))
    // Columns under the URL open; surrounding text does not.
    XCTAssertNotNil(LinkSpans.target(atColumn: span.start, row: 0, spans: spans))
    XCTAssertNotNil(LinkSpans.target(atColumn: span.end - 1, row: 0, spans: spans))
    XCTAssertNil(LinkSpans.target(atColumn: 0, row: 0, spans: spans))
  }

  func testFilePathIsDetected() {
    let texts = ["error in src/main.rs:12:3"]
    let spans = LinkSpans.compute(texts: texts, wrapped: [false])
    XCTAssertEqual(spans[0].count, 1)
    XCTAssertEqual(
      spans[0].first?.target,
      .file(path: "src/main.rs", line: 12, column: 3)
    )
  }

  private func targets(_ line: String) -> [LinkTarget] {
    LinkSpans.compute(texts: [line], wrapped: [false])[0].map(\.target)
  }

  func testQuotedAbsolutePathIsDetected() {
    let line = "attached '/home/user/project/photo-1.png' to the prompt"
    let spans = LinkSpans.compute(texts: [line], wrapped: [false])[0]
    XCTAssertEqual(spans.map(\.target), [.file(path: "/home/user/project/photo-1.png", line: nil, column: nil)])
    XCTAssertEqual(spans.first?.start, 10)
    XCTAssertEqual(spans.first?.end, 10 + "/home/user/project/photo-1.png".count)
  }

  func testBacktickedTildeAndParentPathsAreDetected() {
    XCTAssertEqual(targets("edit `src/main.rs:12:3` now"), [.file(path: "src/main.rs", line: 12, column: 3)])
    XCTAssertEqual(targets("see ~/.config/app.env"), [.file(path: "~/.config/app.env", line: nil, column: nil)])
    XCTAssertEqual(targets("(../up/f.go:4)"), [.file(path: "../up/f.go", line: 4, column: nil)])
    XCTAssertEqual(targets("wrote /tmp/out"), [.file(path: "/tmp/out", line: nil, column: nil)])
  }

  func testTrailingPunctuationIsNotPartOfThePathSpan() {
    let line = "saved to /var/log/app.log."
    let spans = LinkSpans.compute(texts: [line], wrapped: [false])[0]
    XCTAssertEqual(spans.map(\.target), [.file(path: "/var/log/app.log", line: nil, column: nil)])
    XCTAssertEqual(spans.first?.end, line.count - 1)
  }

  func testProseWithSlashesIsNotAPath() {
    XCTAssertEqual(targets("run /help for and/or 12/03/2026 details"), [])
  }

  func testUrlPathIsNotAlsoReadAsAFile() {
    XCTAssertEqual(targets("open https://example.com/a/b.png"), [.external(url: "https://example.com/a/b.png")])
  }

  func testUrlWrappedInsideABoxJoinsAcrossRows() {
    let rows = [
      "│ https://example.com/very/long/pa │",
      "│ th/to/page                      │",
    ]
    let spans = LinkSpans.compute(texts: rows, wrapped: [false, false])
    let url = LinkTarget.external(url: "https://example.com/very/long/path/to/page")
    XCTAssertEqual(spans[0], [LinkSpan(start: 2, end: 34, target: url)])
    XCTAssertEqual(spans[1], [LinkSpan(start: 2, end: 12, target: url)])
  }

  func testLinkTextIsWhatACopyPuts() {
    XCTAssertEqual(LinkTarget.external(url: "https://example.com").text, "https://example.com")
    XCTAssertEqual(LinkTarget.file(path: "src/a.rs", line: 3, column: 1).text, "src/a.rs:3:1")
    XCTAssertEqual(LinkTarget.file(path: "/tmp/a", line: nil, column: nil).text, "/tmp/a")
  }

  func testPaddedBoxRowDoesNotJoinTheNextRow() {
    let rows = [
      "│ https://example.com/docs        │",
      "│ /tmp/out/file.txt               │",
    ]
    let spans = LinkSpans.compute(texts: rows, wrapped: [false, false])
    XCTAssertEqual(spans[0].map(\.target), [.external(url: "https://example.com/docs")])
    XCTAssertEqual(spans[1].map(\.target), [.file(path: "/tmp/out/file.txt", line: nil, column: nil)])
  }

  func testUrlWrappedOverThreeRowsJoins() {
    let rows = [
      "see https://example.com/aaaa",
      "bbbb/cccc/dddd/eeee/ffff/gg",
      "hh/end then text",
    ]
    let spans = LinkSpans.compute(texts: rows, wrapped: [false, false, false])
    let url = LinkTarget.external(url: "https://example.com/aaaabbbb/cccc/dddd/eeee/ffff/gghh/end")
    XCTAssertEqual(spans[0].map(\.target), [url])
    XCTAssertEqual(spans[1].map(\.target), [url])
    XCTAssertEqual(spans[2], [LinkSpan(start: 0, end: 6, target: url)])
  }

  func testDotfileAndTildeUserPathsNeedAnExtensionOrAnchor() {
    XCTAssertEqual(targets("in .git/config"), [])
    XCTAssertEqual(targets("in ~user/notes.txt"), [])
  }

  func testShortRowsAfterAUrlDoNotChainOn() {
    let rows = ["https://example.com/users/alice", "bob/carol", "dave/erin.txt"]
    let spans = LinkSpans.compute(texts: rows, wrapped: [false, false, false])
    XCTAssertEqual(spans[2].map(\.target), [.file(path: "dave/erin.txt", line: nil, column: nil)])
  }

  func testDotfileInADirectoryIsDetected() {
    XCTAssertEqual(targets("edit src/.env now"), [.file(path: "src/.env", line: nil, column: nil)])
  }

  func testUrlCutRightAfterTheSchemeAtTheEdgeJoins() {
    let rows = [
      "published: https://git",
      "hub.com/owner/repo/releases/tag/v1.2.3",
    ]
    let spans = LinkSpans.compute(texts: rows, wrapped: [false, false], cols: rows[0].count)
    let url = LinkTarget.external(url: "https://github.com/owner/repo/releases/tag/v1.2.3")
    XCTAssertEqual(spans[0], [LinkSpan(start: 11, end: rows[0].count, target: url)])
    XCTAssertEqual(spans[1], [LinkSpan(start: 0, end: rows[1].count, target: url)])
  }

  func testShortUrlStoppingShortOfTheEdgeStaysWhole() {
    // One column short of the edge is still short: the last cell is blank.
    let rows = ["see https://x.io", "foo/bar.txt here"]
    let spans = LinkSpans.compute(texts: rows, wrapped: [false, false], cols: rows[0].count + 1)
    XCTAssertEqual(spans[0].map(\.target), [.external(url: "https://x.io")])
    XCTAssertEqual(spans[1].map(\.target), [.file(path: "foo/bar.txt", line: nil, column: nil)])
  }
}
