import XCTest
@testable import TetherKit

final class ChatScrollFollowTests: XCTestCase {
  func test_short_content_is_always_at_the_bottom() {
    XCTAssertTrue(ChatScrollFollow.isNearBottom(offset: 0, content: 300, container: 600))
  }

  func test_resting_at_the_end_is_near_the_bottom() {
    XCTAssertTrue(ChatScrollFollow.isNearBottom(offset: 1400, content: 2000, container: 600))
  }

  func test_within_the_threshold_still_counts() {
    XCTAssertTrue(ChatScrollFollow.isNearBottom(offset: 1360, content: 2000, container: 600))
  }

  func test_scrolled_up_past_the_threshold_is_not_near() {
    XCTAssertFalse(ChatScrollFollow.isNearBottom(offset: 1000, content: 2000, container: 600))
  }

  func test_growing_content_while_pinned_is_far_until_the_view_follows() {
    XCTAssertFalse(ChatScrollFollow.isNearBottom(offset: 1400, content: 2200, container: 600))
  }

  func test_bottom_inset_moves_the_end() {
    XCTAssertTrue(ChatScrollFollow.isNearBottom(offset: 1434, content: 2000, container: 600, bottomInset: 34))
    XCTAssertFalse(ChatScrollFollow.isNearBottom(offset: 1300, content: 2000, container: 600, bottomInset: 34))
  }
}
