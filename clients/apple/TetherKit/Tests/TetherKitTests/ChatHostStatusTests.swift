import XCTest
@testable import TetherKit

final class ChatHostStatusTests: XCTestCase {
  private let working = #"{"name":"chat-a","state":"running","turn":"working","title":"","cwd":"/srv/api","created":300,"logBytes":10,"endedReason":""}"#
  private let waiting = #"{"name":"chat-b","state":"running","turn":"waiting","title":"Migrate the docs","cwd":"/srv/docs","created":200,"logBytes":10,"endedReason":""}"#
  private let ended = #"{"name":"chat-c","state":"ended","turn":"idle","title":"","cwd":"/srv/app","created":100,"logBytes":10,"endedReason":"agent exited"}"#

  func test_status_lines_become_summaries_newest_first() {
    let result = ACPChatStatusListing.parse([ended, working, waiting].joined(separator: "\n"))
    XCTAssertFalse(result.unsupported)
    XCTAssertEqual(result.chats.map(\.name), ["chat-a", "chat-b", "chat-c"])
    XCTAssertEqual(result.chats.map(\.turn), [.working, .waiting, .idle])
    XCTAssertEqual(result.chats.map(\.isRunning), [true, true, false])
    XCTAssertEqual(result.chats[1].hostTitle, "Migrate the docs")
    XCTAssertNil(result.chats[0].hostTitle)
    XCTAssertTrue(result.chats.allSatisfy(\.hasStatus))
    XCTAssertEqual(result.chats[0].cwd, "/srv/api")
    XCTAssertEqual(result.chats[0].created, Date(timeIntervalSince1970: 300))
  }

  func test_an_old_host_reads_as_unsupported_but_a_host_with_no_chats_does_not() {
    XCTAssertTrue(ACPChatStatusListing.parse("tether-notify: unknown acp command \"status\"").unsupported)
    XCTAssertTrue(ACPChatStatusListing.parse("sh: tether-notify: command not found").unsupported)
    XCTAssertFalse(ACPChatStatusListing.parse("").unsupported)
    XCTAssertFalse(ACPChatStatusListing.parse("\n").unsupported)
    XCTAssertTrue(ACPChatStatusListing.parse("").chats.isEmpty)
  }

  func test_a_stray_line_beside_real_ones_is_ignored() {
    let result = ACPChatStatusListing.parse("warning: something\n" + working)
    XCTAssertFalse(result.unsupported)
    XCTAssertEqual(result.chats.map(\.name), ["chat-a"])
  }

  func test_a_missing_turn_reads_as_idle_and_an_unknown_state_is_skipped() {
    let bare = #"{"name":"chat-d","state":"running","cwd":"/x","created":1}"#
    let odd = #"{"name":"chat-e","state":"paused","turn":"idle","cwd":"/x","created":1}"#
    let result = ACPChatStatusListing.parse(bare + "\n" + odd)
    XCTAssertEqual(result.chats.map(\.name), ["chat-d"])
    XCTAssertEqual(result.chats[0].turn, .idle)
  }

  func test_rows_carry_the_state_and_the_host_title_wins_over_the_stored_one() {
    let chats = ACPChatStatusListing.parse([working, waiting, ended].joined(separator: "\n")).chats
    let rows = DrawerChatRows.rows(chats: chats, titles: ["chat-a": "Stored title", "chat-b": "Stored title"])
    XCTAssertEqual(rows.map(\.state), [.working, .waiting, .ended])
    XCTAssertEqual(rows.map(\.stateLabel), ["working", "needs you", "ended"])
    XCTAssertEqual(rows[0].title, "Stored title")
    XCTAssertEqual(rows[1].title, "Migrate the docs")
    XCTAssertEqual(rows[2].title, "app")
  }

  func test_a_running_chat_with_no_status_shows_running_and_an_idle_one_shows_idle() {
    let legacy = ACPChatSummary(
      name: "l", isRunning: true, logBytes: 1, cwd: "/x", created: Date(timeIntervalSince1970: 1), spawn: "")
    XCTAssertEqual(DrawerChatState(legacy), .running)
    var idle = legacy
    idle.hasStatus = true
    XCTAssertEqual(DrawerChatState(idle), .idle)
    XCTAssertEqual(DrawerChatState.idle.label, "idle")
    var gone = idle
    gone.isRunning = false
    XCTAssertEqual(DrawerChatState(gone), .ended)
  }

  func test_the_drawer_button_flags_a_waiting_chat_other_than_the_open_one() {
    let chats = ACPChatStatusListing.parse([working, waiting, ended].joined(separator: "\n")).chats
    XCTAssertTrue(DrawerChatRows.othersWaiting(chats: chats, open: nil))
    XCTAssertTrue(DrawerChatRows.othersWaiting(chats: chats, open: "chat-a"))
    XCTAssertFalse(DrawerChatRows.othersWaiting(chats: chats, open: "chat-b"))
    XCTAssertFalse(DrawerChatRows.othersWaiting(chats: [], open: nil))
  }

  func test_an_ended_chat_that_was_waiting_does_not_flag_the_button() {
    var chat = ACPChatStatusListing.parse(waiting).chats[0]
    chat.isRunning = false
    XCTAssertFalse(DrawerChatRows.othersWaiting(chats: [chat], open: nil))
  }

  func test_the_status_command_folds_stderr_in_so_an_old_host_can_be_told_apart() {
    XCTAssertTrue(ACPHostCommand.status.hasSuffix("acp status 2>&1"))
  }
}
