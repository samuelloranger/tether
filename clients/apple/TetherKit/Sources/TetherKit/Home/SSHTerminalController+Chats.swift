import Foundation

extension SSHTerminalController {
  var chatTitles: ChatTitleStore { ChatTitleStore(config: config) }

  /// One extra exec per refresh. A host without `acp status` falls back to `acp ls` (running or
  /// ended only); a failed read or a host without chats shows no chats and never an error: chats are
  /// an extra on top of the terminal.
  func refreshChats() async {
    if chatStatusSupported {
      guard let output = try? await control.exec(ACPHostCommand.status) else { return }
      let listing = ACPChatStatusListing.parse(output)
      if !listing.unsupported {
        if listing.chats != chats { chats = listing.chats }
        return
      }
      chatStatusSupported = false
    }
    guard let output = try? await control.exec(ACPHostCommand.list) else { return }
    let parsed = ACPChatListing.parse(output).chats
    if parsed != chats { chats = parsed }
  }

  func killChat(_ name: String) async {
    _ = try? await control.exec(ACPHostCommand.kill(name: name))
    await forgetChat(name)
  }

  /// Ends the chat's agent; false unless the host confirmed it, since the exec reports no status.
  func endChatAgent(_ name: String) async -> Bool {
    let output = try? await control.exec(ACPHostCommand.kill(name: name) + " && echo ended")
    return output?.split(whereSeparator: \.isNewline).contains { $0.trimmingCharacters(in: .whitespaces) == "ended" } == true
  }

  /// Drops what this device kept for a chat the host no longer has.
  func forgetChat(_ name: String) async {
    UserDefaultsChatJournalStore(name: name).save(ChatJournal())
    chatTitles.clear(name)
    ChatLocalFiles(scope: ChatTitleStore.scope(for: config)).clear(name)
    chats.removeAll { $0.name == name }
    await refreshChats()
  }

  func chatRoute(for row: DrawerChatRow) -> ChatRoute {
    row.route(journal: UserDefaultsChatJournalStore(name: row.name).load())
  }

  func newChat(cwdText: String) async -> ChatStart {
    await ChatRoute.start(cwdText: cwdText, host: config.host) { try await self.control.exec($0) }
  }

  func savedSessions(folderText: String) async -> ChatContinueLoader.Result {
    let control = control
    return await ChatContinueLoader.load(folderText: folderText) { try await control.exec($0) }
  }

  func continueChat(session: ACPSavedSession, folderText: String) async -> ChatStart {
    await ChatRoute.startContinuing(session: session, cwdText: folderText, host: config.host) {
      try await self.control.exec($0)
    }
  }

  /// The attached session's folder, the default for a new chat.
  var activeSessionCwd: String? {
    sessions.first { $0.name == attach }.map(\.displayCwd).flatMap { $0.isEmpty ? nil : $0 }
  }

  func makeChatModel(route: ChatRoute) -> ChatSessionModel {
    #if DEBUG
    if let debugChatModel { return debugChatModel(route) }
    #endif
    return .live(route: route, config: config, hostKeyStore: hostKeyStore)
  }
}
