import Foundation

/// One chat as the terminal screen's drawer lists it.
struct DrawerChatRow: Equatable, Identifiable {
  var name: String
  var title: String
  var subtitle: String
  var isRunning: Bool
  var cwd: String

  var id: String { name }
  var stateLabel: String { isRunning ? "running" : "ended" }

  func route(readOnly: Bool) -> ChatRoute { ChatRoute(name: name, cwd: cwd, readOnly: readOnly) }
}

enum DrawerChatRows {
  /// The stored agent title, else the folder name. The subtitle is the folder, or the path above
  /// it when the folder is already the title.
  static func rows(chats: [ACPChatSummary], titles: [String: String]) -> [DrawerChatRow] {
    chats.map { chat in
      let folder = ChatFormat.folderName(chat.cwd)
      let stored = titles[chat.name].flatMap { $0.isEmpty ? nil : $0 }
      let title = stored ?? folder
      let subtitle = title == folder ? (ChatFormat.parentPath(chat.cwd) ?? chat.cwd) : folder
      return DrawerChatRow(
        name: chat.name, title: title, subtitle: subtitle, isRunning: chat.isRunning, cwd: chat.cwd)
    }
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
