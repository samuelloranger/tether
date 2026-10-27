import Foundation

/// One chat as the terminal screen's drawer lists it.
struct DrawerChatRow: Equatable, Identifiable {
  var name: String
  var title: String
  var subtitle: String
  var state: DrawerChatState
  var cwd: String
  var multiClient = false
  /// The resolved agent's key; nil for an agent this app does not know.
  var agentKey: String? = ChatAgents.claude.key

  var agent: ChatAgentProfile? { ChatAgents.profile(forKey: agentKey) }
  /// Only a chat that is not Claude's names its agent: Claude rows look as they always did.
  var agentLabel: String? { agentKey == ChatAgents.claude.key ? nil : ChatAgents.label(of: agent) }

  var id: String { name }
  var isRunning: Bool { state != .ended }
  var stateLabel: String { state.label }

  func route(journal: ChatJournal) -> ChatRoute {
    ChatRoute(existing: name, cwd: cwd, journal: journal, multiClient: multiClient, agentKey: agentKey)
  }
}

enum DrawerChatRows {
  /// The host's title, else the stored agent title, else the folder name. The subtitle is the folder,
  /// or the path above it when the folder is already the title.
  /// `agents` holds the keys this device recorded for the chats it started; the host's spawn command covers the rest.
  static func rows(chats: [ACPChatSummary], titles: [String: String], agents: [String: String] = [:]) -> [DrawerChatRow] {
    chats.map { chat in
      let folder = ChatFormat.folderName(chat.cwd)
      let stored = titles[chat.name].flatMap { $0.isEmpty ? nil : $0 }
      let title = chat.hostTitle ?? stored ?? folder
      let subtitle = title == folder ? (ChatFormat.parentPath(chat.cwd) ?? chat.cwd) : folder
      return DrawerChatRow(
        name: chat.name, title: title, subtitle: subtitle, state: DrawerChatState(chat), cwd: chat.cwd,
        multiClient: chat.multiClient,
        agentKey: ChatAgents.resolve(localKey: agents[chat.name], statusSpawn: chat.spawn)?.key)
    }
  }
}

extension DrawerChatRows {
  /// A chat other than the open one is waiting on an answer; the drawer button says so because its
  /// banner would sit in the terminal stack, out of sight behind the open chat.
  static func othersWaiting(chats: [ACPChatSummary], open: String?) -> Bool {
    chats.contains { $0.isRunning && $0.hasStatus && $0.turn == .waiting && $0.name != open }
  }
}

/// What the terminal screen's main area shows: the terminal, or one chat swapped in over it.
struct DrawerContent: Equatable {
  private(set) var chat: ChatRoute?

  var showsChat: Bool { chat != nil }

  func isSelected(chat name: String) -> Bool { chat?.name == name }

  mutating func open(_ route: ChatRoute) { chat = route }
  mutating func showTerminal() { chat = nil }

  mutating func chatKilled(_ name: String) {
    if chat?.name == name { chat = nil }
  }
}

extension ChatRoute {
  /// A chat a push or link names. The folder only matters to a chat that has to be spawned,
  /// which one this phone has no session for never is: that one is joined or read.
  static func opening(
    name: String, chats: [ACPChatSummary], journal: ChatJournal, localAgent: String? = nil
  ) -> ChatRoute {
    let chat = chats.first { $0.name == name }
    return ChatRoute(
      existing: name, cwd: chat?.cwd ?? "", journal: journal, multiClient: chat?.multiClient ?? false,
      agentKey: ChatAgents.resolve(localKey: localAgent, statusSpawn: chat?.spawn)?.key)
  }

  /// A fresh chat in `cwdText`; `~` needs the host's home, so a host that cannot report it gives nil.
  static func fresh(cwdText: String, exec: (String) async throws -> String) async -> ChatRoute? {
    var home = ""
    if ACPCwd.needsHome(cwdText) {
      guard let found = try? await exec(ACPHostCommand.home), found.hasPrefix("/") else { return nil }
      home = found.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return ChatRoute(name: newName(), cwd: ACPCwd.expand(cwdText, home: home), readOnly: false)
  }
}
