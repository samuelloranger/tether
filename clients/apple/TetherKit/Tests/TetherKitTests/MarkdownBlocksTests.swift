import XCTest

@testable import TetherKit

final class MarkdownBlocksTests: XCTestCase {
  func testSplitsFencedCodeFromProse() {
    let input = "Here:\n```swift\nlet x = 1\n```\nDone."
    let blocks = splitMarkdownBlocks(input)
    XCTAssertEqual(blocks.count, 3)
    guard case let .prose(p0) = blocks[0], case let .code(lang, body) = blocks[1],
      case let .prose(p2) = blocks[2]
    else { return XCTFail("unexpected block shape: \(blocks)") }
    XCTAssertTrue(p0.contains("Here:"))
    XCTAssertEqual(lang, "swift")
    XCTAssertEqual(body, "let x = 1")
    XCTAssertTrue(p2.contains("Done."))
  }

  func testPlainTextIsOneProseBlock() {
    XCTAssertEqual(splitMarkdownBlocks("just text"), [.prose("just text")])
  }

  func testUnterminatedFenceStillYieldsCode() {
    let blocks = splitMarkdownBlocks("intro\n```ts\nconst a = 1")
    guard case .code(_, let body) = blocks.last else { return XCTFail("expected code tail") }
    XCTAssertEqual(body, "const a = 1")
  }
}
