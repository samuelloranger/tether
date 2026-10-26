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

final class ChatStickToEndTests: XCTestCase {
  private func m(_ offset: CGFloat, _ content: CGFloat, _ container: CGFloat = 600) -> ChatScrollMetrics {
    ChatScrollMetrics(offset: offset, content: content, container: container)
  }

  func test_a_transcript_that_arrives_after_the_first_layout_is_followed_to_its_end() {
    var sticking = true
    var old = m(0, 0)
    for content in [300, 1200, 4000, 9000] as [CGFloat] {
      let new = m(0, content)
      sticking = ChatScrollFollow.sticks(sticking: sticking, old: old, new: new, userScrolling: false)
      XCTAssertTrue(sticking)
      old = new
    }
    XCTAssertTrue(ChatScrollFollow.shouldFollowEnd(sticking: sticking, userScrolling: false, new: m(0, 9000)))
  }

  func test_growth_under_a_resting_view_does_not_end_the_mode() {
    XCTAssertTrue(ChatScrollFollow.sticks(sticking: true, old: m(1400, 2000), new: m(1400, 2600), userScrolling: false))
  }

  func test_dragging_up_away_from_the_end_ends_the_mode() {
    XCTAssertFalse(ChatScrollFollow.sticks(sticking: true, old: m(1400, 2000), new: m(1200, 2000), userScrolling: true))
  }

  func test_content_growth_while_the_user_drags_does_not_end_the_mode_but_does_not_yank_either() {
    let new = m(1300, 2600)
    XCTAssertTrue(ChatScrollFollow.sticks(sticking: true, old: m(1300, 2000), new: new, userScrolling: true))
    XCTAssertFalse(ChatScrollFollow.shouldFollowEnd(sticking: true, userScrolling: true, new: new))
  }

  func test_a_programmatic_move_up_is_not_the_user_leaving() {
    XCTAssertTrue(ChatScrollFollow.sticks(sticking: true, old: m(1400, 2000), new: m(0, 2000), userScrolling: false))
  }

  func test_scrolled_away_stays_away_while_content_grows() {
    let new = m(300, 2600)
    XCTAssertFalse(ChatScrollFollow.sticks(sticking: false, old: m(300, 2000), new: new, userScrolling: false))
    XCTAssertFalse(ChatScrollFollow.shouldFollowEnd(sticking: false, userScrolling: false, new: new))
  }

  func test_coming_back_to_the_end_turns_the_mode_on_again() {
    XCTAssertTrue(ChatScrollFollow.sticks(sticking: false, old: m(1200, 2000), new: m(1380, 2000), userScrolling: true))
  }

  func test_nothing_to_follow_when_already_at_the_end() {
    XCTAssertFalse(ChatScrollFollow.shouldFollowEnd(sticking: true, userScrolling: false, new: m(1400, 2000)))
  }
}
