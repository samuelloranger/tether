import XCTest
@testable import TetherKit

final class UTF8StreamDecoderTests: XCTestCase {
  func test_a_character_split_across_chunks_arrives_whole() {
    var decoder = UTF8StreamDecoder()
    let bytes = Array("✓ ok".utf8)
    XCTAssertEqual(decoder.decode(bytes.prefix(2)), "")
    XCTAssertEqual(decoder.decode(bytes.dropFirst(2)), "✓ ok")
  }

  func test_a_four_byte_character_split_three_ways() {
    var decoder = UTF8StreamDecoder()
    let bytes = Array("a😀b".utf8)
    XCTAssertEqual(decoder.decode(bytes.prefix(2)), "a")
    XCTAssertEqual(decoder.decode(bytes[2..<4]), "")
    XCTAssertEqual(decoder.decode(bytes.dropFirst(4)), "😀b")
  }

  func test_plain_ascii_passes_straight_through() {
    var decoder = UTF8StreamDecoder()
    XCTAssertEqual(decoder.decode(Array("abc".utf8)), "abc")
    XCTAssertEqual(UTF8StreamDecoder.incompleteTail(Array("é".utf8)), 0)
  }
}
