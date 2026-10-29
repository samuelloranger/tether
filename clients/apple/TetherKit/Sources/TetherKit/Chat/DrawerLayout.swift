import Foundation

/// The drawer's ordering and labelling rules, kept free of views so they can be tested.
enum DrawerLayout {
  /// Rows that need an answer first, every other row keeping its order.
  static func waitingFirst<Row>(_ rows: [Row], isWaiting: (Row) -> Bool) -> [Row] {
    rows.filter(isWaiting) + rows.filter { !isWaiting($0) }
  }

  /// Ended chats fold into one disclosure once there are two of them.
  static let endedCollapseThreshold = 2

  static func splitEnded(_ rows: [DrawerChatRow]) -> (live: [DrawerChatRow], ended: [DrawerChatRow], collapsed: Bool) {
    let ended = rows.filter { $0.state == .ended }
    return (rows.filter { $0.state != .ended }, ended, ended.count >= endedCollapseThreshold)
  }

  /// One line under the host name: "connected · 3 terminals · 4 chats". A count of zero is left out.
  static func summary(state: String, terminals: Int, chats: Int) -> String {
    var parts = [state]
    if terminals > 0 { parts.append(terminals == 1 ? "1 terminal" : "\(terminals) terminals") }
    if chats > 0 { parts.append(chats == 1 ? "1 chat" : "\(chats) chats") }
    return parts.joined(separator: " · ")
  }

  /// What each session shows for its folder: the folder name, or the `~`-relative path for the
  /// sessions whose folder names collide. Sessions with no folder are left out.
  static func sessionFolders(_ sessions: [ZmxSession]) -> [String: String] {
    let paths = sessions.map { ($0.name, $0.displayCwd) }.filter { !$0.1.isEmpty }
    var counts: [String: Int] = [:]
    for (_, path) in paths { counts[ChatFormat.folderName(path), default: 0] += 1 }
    return Dictionary(
      paths.map { name, path in
        let folder = ChatFormat.folderName(path)
        return (name, counts[folder, default: 0] > 1 ? homeRelative(path) : folder)
      }, uniquingKeysWith: { first, _ in first })
  }

  static func homeRelative(_ path: String) -> String {
    let parts = path.split(separator: "/", omittingEmptySubsequences: true)
    guard parts.count >= 2, parts[0] == "home" || parts[0] == "Users" else { return path }
    return parts.count == 2 ? "~" : "~/" + parts.dropFirst(2).joined(separator: "/")
  }

  /// The fallbacks for a chat's second line when it does not fit, widest first. The logo already
  /// names the agent, so a narrow row gives up the agent label before the folder.
  static let chatSubtitleFits: [(agentLabel: Bool, folder: Bool)] = [(true, true), (false, true), (true, false)]

  /// The conversation id a chat can be continued from in a terminal: only a live Claude chat
  /// this phone has already talked to knows one.
  static func resumableSessionId(_ row: DrawerChatRow, journal: ChatJournal) -> String? {
    guard row.isRunning, row.agentKey == ChatAgents.claude.key, let id = journal.sessionId, !id.isEmpty else { return nil }
    return id
  }
}
