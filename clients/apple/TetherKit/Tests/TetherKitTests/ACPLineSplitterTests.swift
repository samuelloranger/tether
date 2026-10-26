import XCTest
@testable import TetherKit

final class ACPLineSplitterTests: XCTestCase {
  private func texts(_ lines: [ACPLine]) -> [String] { lines.map { String(decoding: $0.bytes, as: UTF8.self) } }

  func test_lines_split_across_arbitrary_chunks() throws {
    var splitter = ACPLineSplitter()
    var out: [String] = []
    for chunk in ["{\"a\":", "1}\n{\"b\"", ":2}\n{\"c\":3}", "\n"] {
      out += texts(try splitter.feed(Data(chunk.utf8)))
    }
    XCTAssertEqual(out, ["{\"a\":1}", "{\"b\":2}", "{\"c\":3}"])
  }

  func test_a_multibyte_character_cut_at_every_byte_boundary_stays_whole() throws {
    let line = "{\"t\":\"é 你 😀\"}"
    let bytes = Array((line + "\n").utf8)
    for cut in 1..<bytes.count {
      var splitter = ACPLineSplitter()
      var out = texts(try splitter.feed(Data(bytes[..<cut])))
      out += texts(try splitter.feed(Data(bytes[cut...])))
      XCTAssertEqual(out, [line], "cut at \(cut)")
    }
  }

  func test_crlf_is_tolerated_and_blank_lines_are_skipped() throws {
    var splitter = ACPLineSplitter()
    let lines = try splitter.feed(Data("a\r\n\r\n\nb\r\n".utf8))
    XCTAssertEqual(texts(lines), ["a", "b"])
    XCTAssertEqual(lines.map(\.start), [0, 6])
    XCTAssertEqual(lines.map(\.end), [3, 9])
  }

  func test_offsets_advance_across_chunks() throws {
    var splitter = ACPLineSplitter()
    _ = try splitter.feed(Data("abc\nde".utf8))
    let lines = try splitter.feed(Data("f\n".utf8))
    XCTAssertEqual(lines, [ACPLine(bytes: Data("def".utf8), start: 4, end: 8)])
  }

  func test_an_unterminated_line_past_the_cap_fails_loudly() throws {
    var splitter = ACPLineSplitter(maxLineBytes: 8)
    XCTAssertNoThrow(try splitter.feed(Data("12345678".utf8)))
    XCTAssertThrowsError(try splitter.feed(Data("9".utf8))) { error in
      XCTAssertEqual(error as? ACPLineError, .lineTooLong(limit: 8))
    }
    XCTAssertThrowsError(try splitter.feed(Data("\n".utf8)))
  }

  func test_a_complete_line_past_the_cap_fails_too() {
    var splitter = ACPLineSplitter(maxLineBytes: 4)
    XCTAssertThrowsError(try splitter.feed(Data("ok\nwaytoolong\n".utf8)))
  }
}
