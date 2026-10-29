import XCTest
@testable import TetherKit

final class DrawerLayoutTests: XCTestCase {
  private func chat(_ name: String, _ state: DrawerChatState, agent: String? = ChatAgents.claude.key) -> DrawerChatRow {
    DrawerChatRow(name: name, title: name, subtitle: "", state: state, cwd: "/srv/\(name)", agentKey: agent)
  }

  private func session(_ name: String, _ cwd: String) -> ZmxSession {
    ZmxSession(name: name, pid: 1, clients: 0, created: 0, cwd: cwd)
  }

  func test_waiting_rows_come_first_and_keep_their_order() {
    let rows = [chat("a", .idle), chat("b", .waiting), chat("c", .working), chat("d", .waiting)]
    XCTAssertEqual(DrawerLayout.waitingFirst(rows) { $0.state == .waiting }.map(\.name), ["b", "d", "a", "c"])
    XCTAssertEqual(DrawerLayout.waitingFirst(["x", "y"]) { _ in false }, ["x", "y"])
  }

  func test_ended_chats_collapse_from_two() {
    let one = DrawerLayout.splitEnded([chat("a", .idle), chat("b", .ended)])
    XCTAssertFalse(one.collapsed)
    XCTAssertEqual(one.ended.map(\.name), ["b"])
    let two = DrawerLayout.splitEnded([chat("a", .ended), chat("b", .idle), chat("c", .ended)])
    XCTAssertTrue(two.collapsed)
    XCTAssertEqual(two.live.map(\.name), ["b"])
    XCTAssertEqual(two.ended.map(\.name), ["a", "c"])
  }

  func test_the_summary_spells_out_the_state_and_skips_zero_counts() {
    XCTAssertEqual(DrawerLayout.summary(state: "connected", terminals: 3, chats: 4), "connected · 3 terminals · 4 chats")
    XCTAssertEqual(DrawerLayout.summary(state: "connected", terminals: 1, chats: 1), "connected · 1 terminal · 1 chat")
    XCTAssertEqual(DrawerLayout.summary(state: "connecting", terminals: 0, chats: 0), "connecting")
  }

  func test_a_session_shows_its_folder_name() {
    let folders = DrawerLayout.sessionFolders([
      session("a", "file://host/home/dev/projects/api"), session("b", "/srv/docs"), session("c", ""),
    ])
    XCTAssertEqual(folders, ["a": "api", "b": "docs"])
  }

  func test_sessions_sharing_a_folder_name_show_the_home_relative_path() {
    let folders = DrawerLayout.sessionFolders([
      session("a", "/home/dev/work/app"), session("b", "/home/dev/play/app"), session("c", "/srv/other"),
    ])
    XCTAssertEqual(folders, ["a": "~/work/app", "b": "~/play/app", "c": "other"])
  }

  func test_home_relative_only_rewrites_a_home_directory() {
    XCTAssertEqual(DrawerLayout.homeRelative("/home/dev"), "~")
    XCTAssertEqual(DrawerLayout.homeRelative("/Users/dev/x"), "~/x")
    XCTAssertEqual(DrawerLayout.homeRelative("/srv/x"), "/srv/x")
  }

  func test_home_relative_handles_a_bare_home_root_and_trailing_slashes() {
    XCTAssertEqual(DrawerLayout.homeRelative("/home"), "/home")
    XCTAssertEqual(DrawerLayout.homeRelative("/Users"), "/Users")
    XCTAssertEqual(DrawerLayout.homeRelative("/home/dev/"), "~")
    XCTAssertEqual(DrawerLayout.homeRelative("/home/dev/x/"), "~/x")
  }

  func test_an_open_ended_chat_keeps_the_fold_open() {
    let ended = [chat("a", .ended), chat("b", .ended)]
    XCTAssertFalse(DrawerLayout.showsEnded(expanded: false, ended: ended, open: nil))
    XCTAssertFalse(DrawerLayout.showsEnded(expanded: false, ended: ended, open: "live"))
    XCTAssertTrue(DrawerLayout.showsEnded(expanded: false, ended: ended, open: "b"))
    XCTAssertTrue(DrawerLayout.showsEnded(expanded: true, ended: ended, open: nil))
  }

  func test_git_is_offered_for_an_absolute_folder_or_the_attached_session() {
    XCTAssertEqual(DrawerLayout.gitTarget(cwd: "/srv/x", isAttached: false), .folder("/srv/x"))
    XCTAssertEqual(DrawerLayout.gitTarget(cwd: "/srv/x", isAttached: true), .session)
    XCTAssertEqual(DrawerLayout.gitTarget(cwd: "", isAttached: true), .session)
    XCTAssertNil(DrawerLayout.gitTarget(cwd: "", isAttached: false))
    XCTAssertNil(DrawerLayout.gitTarget(cwd: "~/x", isAttached: false))
  }

  func test_a_chat_titled_by_its_folder_shows_a_home_relative_parent() {
    let summary = ACPChatSummary(
      name: "c", isRunning: true, logBytes: 1, cwd: "/home/dev/projects/app", created: Date(timeIntervalSince1970: 1), spawn: "claude")
    XCTAssertEqual(DrawerChatRows.rows(chats: [summary], titles: [:])[0].subtitle, "~/projects")
  }

  func test_a_narrow_chat_row_gives_up_the_agent_label_before_the_folder() {
    let fits = DrawerLayout.chatSubtitleFits
    XCTAssertTrue(fits[0].agentLabel && fits[0].folder)
    XCTAssertTrue(!fits[1].agentLabel && fits[1].folder)
    XCTAssertTrue(fits[2].agentLabel && !fits[2].folder)
  }

  func test_only_a_live_claude_chat_with_a_known_conversation_can_continue_in_a_terminal() {
    var journal = ChatJournal()
    XCTAssertNil(DrawerLayout.resumableSessionId(chat("a", .idle), journal: journal))
    journal.sessionId = "sess-1"
    XCTAssertEqual(DrawerLayout.resumableSessionId(chat("a", .idle), journal: journal), "sess-1")
    XCTAssertNil(DrawerLayout.resumableSessionId(chat("a", .ended), journal: journal))
    XCTAssertNil(DrawerLayout.resumableSessionId(chat("a", .idle, agent: ChatAgents.codex.key), journal: journal))
  }
}
