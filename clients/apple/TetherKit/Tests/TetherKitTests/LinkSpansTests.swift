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
}
