import XCTest
@testable import TetherKit

final class DrawerChatsTests: XCTestCase {
  private func chat(_ name: String, _ cwd: String, running: Bool = true) -> ACPChatSummary {
    ACPChatSummary(
      name: name, isRunning: running, logBytes: 1, cwd: cwd, created: Date(timeIntervalSince1970: 1), spawn: "claude")
  }

  func test_a_stored_title_wins_and_the_folder_becomes_the_subtitle() {
    let rows = DrawerChatRows.rows(
      chats: [chat("chat-a", "/srv/api-server"), chat("chat-b", "/srv/app", running: false)],
      titles: ["chat-a": "Add retry to fetchJSON"])
    XCTAssertEqual(rows[0].title, "Add retry to fetchJSON")
    XCTAssertEqual(rows[0].subtitle, "api-server")
    XCTAssertEqual(rows[0].stateLabel, "running")
    XCTAssertEqual(rows[1].title, "app")
    XCTAssertEqual(rows[1].subtitle, "/srv")
    XCTAssertEqual(rows[1].stateLabel, "ended")
  }

  func test_a_chat_in_home_falls_back_to_a_readable_title() {
    let rows = DrawerChatRows.rows(chats: [chat("c", "/")], titles: ["c": ""])
    XCTAssertEqual(rows[0].title, "/")
    XCTAssertEqual(rows[0].subtitle, "/")
  }

  func test_the_route_follows_the_journal_mode() {
    let row = DrawerChatRows.rows(chats: [chat("c", "/srv/x")], titles: [:])[0]
    XCTAssertEqual(row.route(journal: ChatJournal()), ChatRoute(name: "c", cwd: "/srv/x", readOnly: true))
    var journal = ChatJournal()
    journal.sessionId = "s"
    XCTAssertFalse(row.route(journal: journal).readOnly)
    var shared = chat("c", "/srv/x")
    shared.multiClient = true
    let joined = DrawerChatRows.rows(chats: [shared], titles: [:])[0].route(journal: ChatJournal())
    XCTAssertTrue(joined.join)
    XCTAssertFalse(joined.readOnly)
  }

  func test_selection_swaps_between_a_chat_and_the_terminal() {
    var content = DrawerContent()
    XCTAssertFalse(content.showsChat)
    let route = ChatRoute(name: "chat-a", cwd: "/x", readOnly: false)
    content.open(route)
    XCTAssertTrue(content.showsChat)
    XCTAssertTrue(content.isSelected(chat: "chat-a"))
    XCTAssertFalse(content.isSelected(chat: "chat-b"))
    content.open(ChatRoute(name: "chat-b", cwd: "/y", readOnly: false))
    XCTAssertTrue(content.isSelected(chat: "chat-b"))
    content.showTerminal()
    XCTAssertNil(content.chat)
  }

  func test_killing_the_open_chat_returns_to_the_terminal_but_another_chat_does_not() {
    var content = DrawerContent()
    content.open(ChatRoute(name: "chat-a", cwd: "/x", readOnly: false))
    content.chatKilled("chat-b")
    XCTAssertTrue(content.showsChat)
    content.chatKilled("chat-a")
    XCTAssertFalse(content.showsChat)
  }

  func test_title_store_is_scoped_per_host_and_ignores_blank_titles() {
    let defaults = UserDefaults(suiteName: "drawer-chats-\(UUID().uuidString)")!
    let one = ChatTitleStore(scope: "h1:22", defaults: defaults)
    let two = ChatTitleStore(scope: "h2:22", defaults: defaults)
    one.set("  Fix the build  ", for: "chat-a")
    one.set("   ", for: "chat-b")
    XCTAssertEqual(one.title(for: "chat-a"), "Fix the build")
    XCTAssertNil(one.title(for: "chat-b"))
    XCTAssertNil(two.title(for: "chat-a"))
    XCTAssertEqual(one.titles(for: ["chat-a", "chat-b"]), ["chat-a": "Fix the build"])
    one.clear("chat-a")
    XCTAssertNil(one.title(for: "chat-a"))
  }

  func test_a_fresh_route_resolves_home_and_reports_an_unreadable_host() async {
    let ok = await ChatRoute.fresh(cwdText: "~/proj") { _ in "/home/dev" }
    XCTAssertEqual(ok?.cwd, "/home/dev/proj")
    XCTAssertTrue(ok?.name.hasPrefix("chat-") == true)
    let absolute = await ChatRoute.fresh(cwdText: "/srv/x/") { _ in throw SSHConnectError.transport("down") }
    XCTAssertEqual(absolute?.cwd, "/srv/x")
    let failed = await ChatRoute.fresh(cwdText: "~") { _ in throw SSHConnectError.transport("down") }
    XCTAssertNil(failed)
  }

  func test_last_opened_chat_survives_reopening_and_is_scoped_to_its_host() {
    let suite = "last-chat-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let one = ChatTitleStore(scope: "one:22", defaults: defaults)
    one.lastOpenedChat = "chat-a"
    XCTAssertEqual(ChatTitleStore(scope: "one:22", defaults: defaults).lastOpenedChat, "chat-a")
    XCTAssertNil(ChatTitleStore(scope: "two:22", defaults: defaults).lastOpenedChat)
    one.clear("chat-b")
    XCTAssertEqual(one.lastOpenedChat, "chat-a")
    one.clear("chat-a")
    XCTAssertNil(one.lastOpenedChat)
    one.lastOpenedChat = "chat-b"
    one.lastOpenedChat = nil
    XCTAssertNil(ChatTitleStore(scope: "one:22", defaults: defaults).lastOpenedChat)
  }
}

@MainActor
final class ControllerChatsTests: XCTestCase {
  private let config = SSHConnectionConfig(host: "chats.test", port: 22, username: "sam", credentials: [.password("pw")])

  private func controller(_ ops: FakeOps) -> SSHTerminalController {
    let store = InMemoryHostKeyStore()
    return SSHTerminalController(
      title: "t", config: config, hostKeyStore: store, attach: "work",
      control: ControlConnection(config: config, store: store) { ops })
      .creating("work")
  }

  private let statusLine = #"{"name":"chat-a","state":"running","turn":"waiting","title":"T","cwd":"/srv/x","created":100,"logBytes":10,"endedReason":""}"#

  func test_last_chat_is_restored_once_after_listing_without_spawning() async {
    let ops = FakeOps()
    ops.execResult = { _ in self.statusLine }
    let controller = controller(ops)
    controller.chatTitles.lastOpenedChat = "chat-a"
    defer { controller.chatTitles.lastOpenedChat = nil }
    await controller.refreshChats()
    XCTAssertEqual(controller.requestedChat, "chat-a")
    controller.requestedChat = nil
    await controller.refreshChats()
    XCTAssertNil(controller.requestedChat)
    XCTAssertFalse(ops.commands.contains { $0.contains("--spawn") || $0.contains(" attach ") })
  }

  func test_failed_listing_retries_restoration_and_a_notification_takes_priority() async {
    let ops = FakeOps()
    let controller = controller(ops)
    controller.chatTitles.lastOpenedChat = "chat-a"
    defer { controller.chatTitles.lastOpenedChat = nil }
    ops.execResult = { _ in throw SSHConnectError.transport("down") }
    await controller.refreshChats()
    XCTAssertTrue(controller.chatRestorationPending)
    controller.requestedChat = "chat-notification"
    ops.execResult = { _ in self.statusLine }
    await controller.refreshChats()
    XCTAssertEqual(controller.requestedChat, "chat-notification")
  }

  func test_missing_ended_and_archived_chats_are_not_restored() async {
    for listing in ["", statusLine.replacingOccurrences(of: "running", with: "ended"),
      statusLine.replacingOccurrences(of: "\"state\"", with: "\"archived\":true,\"state\"")]
    {
      let ops = FakeOps()
      ops.execResult = { _ in listing }
      let controller = controller(ops)
      controller.chatTitles.lastOpenedChat = "chat-a"
      await controller.refreshChats()
      XCTAssertNil(controller.requestedChat)
      XCTAssertNil(controller.chatTitles.lastOpenedChat)
    }
  }

  func test_an_explicit_terminal_choice_clears_the_remembered_chat() async {
    let titles = ChatTitleStore(config: config)
    titles.lastOpenedChat = "chat-a"
    defer { titles.lastOpenedChat = nil }
    let ops = FakeOps()
    ops.execResult = { _ in self.statusLine }
    let store = InMemoryHostKeyStore()
    let controller = SSHTerminalController(
      title: "t", config: config, hostKeyStore: store, attach: "work", picked: true,
      control: ControlConnection(config: config, store: store) { ops })
    await controller.refreshChats()
    XCTAssertNil(controller.requestedChat)
    XCTAssertNil(titles.lastOpenedChat)
  }

  func test_refresh_reads_status_and_a_host_without_the_commands_shows_none() async {
    let ops = FakeOps()
    ops.execResult = { $0.contains("acp status") ? self.statusLine : "" }
    let controller = controller(ops)
    await controller.refreshChats()
    XCTAssertEqual(controller.chats.map(\.name), ["chat-a"])
    XCTAssertEqual(controller.chats.first?.turn, .waiting)
    XCTAssertFalse(ops.commands.contains { $0.contains("acp ls") })

    ops.execResult = { _ in "tether: unknown command acp" }
    await controller.refreshChats()
    XCTAssertTrue(controller.chats.isEmpty)
  }

  func test_a_host_without_acp_status_falls_back_to_ls_once_and_stays_there() async {
    let ops = FakeOps()
    ops.execResult = {
      $0.contains("acp status") ? "tether: unknown acp command \"status\"" : "chat-a\trunning\t10\t/srv/x\t100\tclaude"
    }
    let controller = controller(ops)
    await controller.refreshChats()
    XCTAssertEqual(controller.chats.map(\.name), ["chat-a"])
    XCTAssertEqual(DrawerChatState(controller.chats[0]), .running)
    await controller.refreshChats()
    XCTAssertEqual(ops.commands.filter { $0.contains("acp status") }.count, 1)
    XCTAssertEqual(ops.commands.filter { $0.contains("acp ls") }.count, 2)
  }

  func test_a_failed_read_keeps_the_rows_and_raises_nothing() async {
    let ops = FakeOps()
    ops.execResult = { _ in self.statusLine }
    let controller = controller(ops)
    await controller.refreshChats()
    ops.execResult = { _ in throw SSHConnectError.transport("down") }
    await controller.refreshChats()
    XCTAssertEqual(controller.chats.count, 1)
  }

  func test_killing_a_chat_runs_the_kill_and_clears_its_title() async {
    let ops = FakeOps()
    ops.execResult = { _ in "" }
    let controller = controller(ops)
    controller.chatTitles.set("Some title", for: "chat-z")
    await controller.killChat("chat-z")
    XCTAssertTrue(ops.commands.contains { $0.contains("acp kill 'chat-z'") })
    XCTAssertNil(controller.chatTitles.title(for: "chat-z"))
  }
}
