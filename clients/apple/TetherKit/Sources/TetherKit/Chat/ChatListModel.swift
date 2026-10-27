import Foundation
import Observation

/// The chats a host holds, through the same one-off exec path as the terminal's session list.
@MainActor
@Observable
final class ChatListModel {
  enum Load: Equatable {
    case loading
    case loaded
    case failed(String)
  }

  typealias Exec = (String) async throws -> String

  let hostName: String
  private(set) var chats: [ACPChatSummary] = []
  private(set) var load: Load = .loading
  var errorMessage: String?
  /// Why the last "Start chat" did not start one, shown under the button.
  private(set) var startError: String?

  private let exec: Exec
  private let titles: ChatTitleStore?
  private let files: ChatLocalFiles?
  private let closeConnection: () async -> Void

  init(
    hostName: String, titles: ChatTitleStore? = nil, files: ChatLocalFiles? = nil, exec: @escaping Exec,
    close: @escaping () async -> Void = {}
  ) {
    self.hostName = hostName
    self.titles = titles
    self.files = files
    self.exec = exec
    self.closeConnection = close
  }

  static func live(hostName: String, config: SSHConnectionConfig, hostKeyStore: HostKeyStore) -> ChatListModel {
    let control = ControlConnection(config: config, store: hostKeyStore)
    return ChatListModel(hostName: hostName, titles: ChatTitleStore(config: config), files: ChatLocalFiles(scope: ChatTitleStore.scope(for: config)), exec: { try await control.exec($0) }, close: { await control.close() })
  }

  func refresh() async {
    do {
      let output = try await exec(ACPHostCommand.listWithErrors)
      let listing = ACPChatListing.parse(output)
      if listing.chats.isEmpty, let first = listing.skipped.first {
        load = .failed(Self.explain(first, host: hostName))
      } else {
        chats = listing.chats
        load = .loaded
      }
    } catch {
      load = .failed(error.localizedDescription)
    }
  }

  func delete(_ chat: ACPChatSummary) async {
    do {
      _ = try await exec(ACPHostCommand.kill(name: chat.name))
      UserDefaultsChatJournalStore(name: chat.name).save(ChatJournal())
      titles?.clear(chat.name)
      files?.clear(chat.name)
      chats.removeAll { $0.name == chat.name }
    } catch {
      errorMessage = "Couldn't delete the chat: \(error.localizedDescription)"
    }
  }

  func newRoute(cwdText: String) async -> ChatRoute? {
    startError = nil
    switch await ChatRoute.start(cwdText: cwdText, host: hostName, exec: exec) {
    case let .ready(route): return route
    case let .failed(message):
      startError = message
      return nil
    }
  }

  func agent(for chat: ACPChatSummary) -> ChatAgentProfile? {
    ChatAgents.resolve(localKey: titles?.agent(for: chat.name), statusSpawn: chat.spawn)
  }

  func route(for chat: ACPChatSummary) -> ChatRoute {
    ChatRoute(
      existing: chat.name, cwd: chat.cwd, journal: UserDefaultsChatJournalStore(name: chat.name).load(),
      multiClient: chat.multiClient,
      agentKey: ChatAgents.resolve(localKey: titles?.agent(for: chat.name), statusSpawn: chat.spawn)?.key)
  }

  func close() async { await closeConnection() }

  static func explain(_ line: String, host: String? = nil) -> String {
    let lower = line.lowercased()
    if lower.contains("not found") || lower.contains("unknown command") || lower.contains("usage") {
      let update = host.map { "Update tether on \($0). " } ?? ""
      return update + "This host's tether is missing or too old for chat. Reinstall it, then pull to refresh."
    }
    return line
  }
}
