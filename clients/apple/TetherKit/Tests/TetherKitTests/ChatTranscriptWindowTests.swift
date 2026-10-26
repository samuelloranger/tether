import XCTest
@testable import TetherKit

final class ChatTranscriptWindowTests: XCTestCase {
  private let ids = Array(0..<150)

  func test_a_short_transcript_shows_everything() {
    XCTAssertEqual(ChatTranscriptWindow.range(lastIDs: Array(0..<10), start: nil), 0..<10)
  }

  func test_a_long_transcript_starts_with_the_latest_page() {
    XCTAssertEqual(ChatTranscriptWindow.range(lastIDs: ids, start: nil), 90..<150)
  }

  func test_a_pinned_start_keeps_the_window_from_shrinking_as_blocks_arrive() {
    let grown = ids + [150, 151, 152]
    XCTAssertEqual(ChatTranscriptWindow.range(lastIDs: grown, start: 90), 90..<153)
  }

  func test_a_start_that_is_gone_falls_back_to_the_latest_page() {
    XCTAssertEqual(ChatTranscriptWindow.range(lastIDs: ids, start: 1000), 90..<150)
  }

  func test_a_start_inside_a_grouped_block_keeps_the_whole_group() {
    let lastIDs = [3, 9, 10, 11]
    XCTAssertEqual(ChatTranscriptWindow.range(lastIDs: lastIDs, start: 5), 1..<4)
  }

  func test_earlier_moves_the_start_back_one_page() {
    XCTAssertEqual(ChatTranscriptWindow.earlierStart(lastIDs: ids, range: 90..<150), 30)
  }

  func test_earlier_stops_at_the_first_block() {
    XCTAssertEqual(ChatTranscriptWindow.earlierStart(lastIDs: ids, range: 30..<150), 0)
    XCTAssertNil(ChatTranscriptWindow.earlierStart(lastIDs: ids, range: 0..<150))
  }
}
