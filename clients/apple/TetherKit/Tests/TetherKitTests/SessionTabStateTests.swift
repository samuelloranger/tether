import XCTest
@testable import TetherKit

final class SessionTabStateTests: XCTestCase {
  private func session(_ name: String, created: Int) -> ZmxSession {
    ZmxSession(name: name, pid: 1, clients: 0, created: created, cwd: "/")
  }

  private func state(_ sessions: [ZmxSession], active: String? = nil) -> SessionTabState {
    var state = SessionTabState()
    _ = state.reconcile(listed: sessions)
    if let active { _ = state.select(active) }
    return state
  }

  func test_tabs_are_ordered_by_creation_oldest_left() {
    let listed = [session("c", created: 30), session("a", created: 10), session("b", created: 20)]
    XCTAssertEqual(SessionTabState.ordered(listed), ["a", "b", "c"])
  }

  func test_initial_choice_prefers_default_else_newest() {
    XCTAssertEqual(SessionTabState.initialChoice([session("a", created: 1), session("default", created: 0)]), "default")
    XCTAssertEqual(SessionTabState.initialChoice([session("a", created: 1), session("b", created: 2)]), "b")
    XCTAssertNil(SessionTabState.initialChoice([]))
  }

  func test_first_listing_selects_the_initial_choice() {
    var state = SessionTabState()
    let change = state.reconcile(listed: [session("a", created: 1), session("b", created: 2)])
    XCTAssertEqual(state.active, "b")
    XCTAssertEqual(change.newActive, "b")
    XCTAssertEqual(state.names, ["a", "b"])
  }

  func test_a_session_that_appears_gets_a_tab_at_its_place() {
    var state = state([session("a", created: 1), session("c", created: 3)], active: "a")
    _ = state.reconcile(listed: [session("a", created: 1), session("b", created: 2), session("c", created: 3)])
    XCTAssertEqual(state.names, ["a", "b", "c"])
    XCTAssertEqual(state.active, "a")
  }

  func test_a_removed_active_tab_hands_over_to_its_left_neighbour() {
    var state = state([session("a", created: 1), session("b", created: 2), session("c", created: 3)], active: "b")
    let change = state.reconcile(listed: [session("a", created: 1), session("c", created: 3)])
    XCTAssertEqual(change.removed, ["b"])
    XCTAssertEqual(state.active, "a")
    XCTAssertEqual(change.newActive, "a")
  }

  func test_a_removed_leftmost_active_tab_hands_over_to_the_right() {
    var state = state([session("a", created: 1), session("b", created: 2)], active: "a")
    _ = state.reconcile(listed: [session("b", created: 2)])
    XCTAssertEqual(state.active, "b")
  }

  func test_an_empty_listing_leaves_no_tabs_and_no_active() {
    var state = state([session("a", created: 1)], active: "a")
    _ = state.reconcile(listed: [])
    XCTAssertTrue(state.names.isEmpty)
    XCTAssertNil(state.active)
    XCTAssertTrue(state.attached.isEmpty)
  }

  func test_removing_a_background_tab_keeps_the_active_one() {
    var state = state([session("a", created: 1), session("b", created: 2)], active: "a")
    let change = state.reconcile(listed: [session("a", created: 1)])
    XCTAssertEqual(change.removed, ["b"])
    XCTAssertNil(change.newActive)
    XCTAssertEqual(state.active, "a")
  }

  func test_a_new_tab_survives_listings_that_do_not_show_it_yet() {
    var state = state([session("a", created: 1)], active: "a")
    _ = state.open("fresh")
    for _ in 0..<SessionTabState.unconfirmedListings {
      _ = state.reconcile(listed: [session("a", created: 1)])
      XCTAssertEqual(state.names, ["a", "fresh"])
    }
    let change = state.reconcile(listed: [session("a", created: 1)])
    XCTAssertEqual(change.removed, ["fresh"])
    XCTAssertEqual(state.active, "a")
  }

  func test_a_confirmed_tab_is_dropped_when_it_disappears() {
    var state = state([session("a", created: 1)], active: "a")
    _ = state.open("fresh")
    _ = state.reconcile(listed: [session("a", created: 1), session("fresh", created: 5)])
    let change = state.reconcile(listed: [session("a", created: 1)])
    XCTAssertEqual(change.removed, ["fresh"])
  }

  func test_the_eleventh_attached_tab_evicts_the_least_recently_viewed() {
    let all = (0..<12).map { session("s\($0)", created: $0) }
    var state = SessionTabState()
    _ = state.reconcile(listed: all)
    var evicted: [String] = []
    for index in 0..<10 { evicted += state.select("s\(index)") }
    XCTAssertEqual(evicted, ["s11"], "the initial choice (newest) was viewed first")
    XCTAssertEqual(state.attached.count, SessionTabState.maxAttached)
    XCTAssertFalse(state.attached.contains("s11"))
    XCTAssertTrue(state.attached.contains("s9"))
  }

  func test_viewing_a_tab_again_protects_it_from_eviction() {
    var state = SessionTabState()
    let all = (0..<12).map { session("s\($0)", created: $0) }
    _ = state.reconcile(listed: all)
    for index in 0..<10 { _ = state.select("s\(index)") }
    _ = state.select("s0")
    XCTAssertEqual(state.select("s10"), ["s1"])
  }

  func test_new_session_name_follows_the_ios_rule() {
    XCTAssertEqual(SessionTabState.newSessionName(existing: []), "default")
    XCTAssertEqual(SessionTabState.newSessionName(existing: ["default"]), "session-2")
    XCTAssertEqual(SessionTabState.newSessionName(existing: ["default", "session-3"]), "session-4")
    XCTAssertEqual(SessionTabState.newSessionName(existing: ["a", "session-3", "c"]), "session-4")
  }

  func test_a_bell_marks_only_background_tabs_and_viewing_clears_it() {
    var state = state([session("a", created: 1), session("b", created: 2)], active: "a")
    state.noteBell("a")
    XCTAssertTrue(state.attention.isEmpty)
    state.noteBell("b")
    XCTAssertEqual(state.attention, ["b"])
    _ = state.select("b")
    XCTAssertTrue(state.attention.isEmpty)
    state.noteBell("missing")
    XCTAssertTrue(state.attention.isEmpty)
  }

  func test_neighbour_wraps_in_both_directions() {
    let state = state([session("a", created: 1), session("b", created: 2), session("c", created: 3)], active: "c")
    XCTAssertEqual(state.neighbour(offset: 1), "a")
    XCTAssertEqual(state.neighbour(offset: -1), "b")
    XCTAssertNil(self.state([session("a", created: 1)], active: "a").neighbour(offset: 1))
  }

  func test_name_at_index_is_nil_past_the_end() {
    let state = state([session("a", created: 1)], active: "a")
    XCTAssertEqual(state.name(at: 0), "a")
    XCTAssertNil(state.name(at: 1))
    XCTAssertNil(state.name(at: -1))
  }

  func test_emptying_two_tabs_at_once_selects_nothing() {
    var state = state([session("a", created: 1), session("b", created: 2)], active: "a")
    let change = state.reconcile(listed: [])
    XCTAssertEqual(Set(change.removed), ["a", "b"])
    XCTAssertNil(change.newActive)
    XCTAssertNil(state.active)
    XCTAssertTrue(state.names.isEmpty)
  }

  func test_the_handover_skips_neighbours_that_vanish_in_the_same_listing() {
    var state = state([session("a", created: 1), session("b", created: 2), session("c", created: 3)], active: "b")
    let change = state.reconcile(listed: [session("c", created: 3)])
    XCTAssertEqual(change.newActive, "c")
    XCTAssertEqual(state.active, "c")
  }

  func test_a_killed_session_stays_out_until_a_listing_stops_showing_it() {
    var state = state([session("a", created: 1), session("b", created: 2)], active: "a")
    state.markKilled("b")
    _ = state.reconcile(listed: [session("a", created: 1), session("b", created: 2)])
    XCTAssertEqual(state.names, ["a"])
    _ = state.reconcile(listed: [session("a", created: 1)])
    _ = state.reconcile(listed: [session("a", created: 1), session("b", created: 9)])
    XCTAssertEqual(state.names, ["a", "b"], "a new session reusing the name is a real one")
  }
}
