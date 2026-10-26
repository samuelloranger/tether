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

  private func metrics(_ offset: CGFloat, _ content: CGFloat, _ container: CGFloat) -> ChatScrollMetrics {
    ChatScrollMetrics(offset: offset, content: content, container: container)
  }

  func test_a_pending_send_waits_for_its_rows() {
    let before = metrics(1400, 2000, 600)
    XCTAssertFalse(ChatScrollFollow.shouldJumpToEnd(old: before, new: metrics(1400, 2000, 700), sendPending: true))
    XCTAssertTrue(ChatScrollFollow.shouldJumpToEnd(old: before, new: metrics(1400, 2150, 600), sendPending: true))
  }

  func test_a_pending_send_jumps_even_when_scrolled_up() {
    XCTAssertTrue(ChatScrollFollow.shouldJumpToEnd(old: metrics(300, 2000, 600), new: metrics(300, 2150, 600), sendPending: true))
  }

  func test_a_viewport_that_shrinks_at_the_end_keeps_the_end() {
    XCTAssertTrue(ChatScrollFollow.shouldJumpToEnd(old: metrics(1400, 2000, 600), new: metrics(1400, 2000, 330), sendPending: false))
  }

  func test_a_viewport_that_shrinks_while_scrolled_up_is_left_alone() {
    XCTAssertFalse(ChatScrollFollow.shouldJumpToEnd(old: metrics(300, 2000, 600), new: metrics(300, 2000, 330), sendPending: false))
  }

  func test_content_growth_alone_is_left_to_the_anchor() {
    XCTAssertFalse(ChatScrollFollow.shouldJumpToEnd(old: metrics(1400, 2000, 600), new: metrics(1400, 2200, 600), sendPending: false))
  }
}
