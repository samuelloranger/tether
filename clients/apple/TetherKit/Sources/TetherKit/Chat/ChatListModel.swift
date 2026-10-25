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
      let output = try await exec(ACPHostCommand.list)
      let listing = ACPChatListing.parse(output)
      if listing.chats.isEmpty, let first = listing.skipped.first {
        load = .failed(Self.explain(first))
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
    guard let route = await ChatRoute.fresh(cwdText: cwdText, exec: exec) else {
      errorMessage = "Couldn't read the host's home folder."
      return nil
    }
    return route
  }

  func route(for chat: ACPChatSummary) -> ChatRoute {
    let mode = ChatOpenMode.mode(for: UserDefaultsChatJournalStore(name: chat.name).load())
    return ChatRoute(name: chat.name, cwd: chat.cwd, readOnly: mode == .readOnly)
  }

  func close() async { await closeConnection() }

  static func explain(_ line: String) -> String {
    let lower = line.lowercased()
    if lower.contains("not found") || lower.contains("unknown command") || lower.contains("usage") {
      return "This host's tether-notify is missing or too old for chat. Reinstall it, then pull to refresh."
    }
    return line
  }
}
