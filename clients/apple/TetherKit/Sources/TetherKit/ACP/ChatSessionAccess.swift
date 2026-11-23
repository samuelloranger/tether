import Foundation

/// What the agent's `initialize` said it can do with sessions, kept in the journal so an ended chat
/// still knows whether it can be resumed.
struct ACPAgentCapabilities: Codable, Equatable, Sendable {
  var fork = false
  var resume = false
  var delete = false
  var additionalDirectories = false
  var mcpHttp = false

  init(fork: Bool = false, resume: Bool = false, delete: Bool = false, additionalDirectories: Bool = false, mcpHttp: Bool = false) {
    self.fork = fork
    self.resume = resume
    self.delete = delete
    self.additionalDirectories = additionalDirectories
    self.mcpHttp = mcpHttp
  }

  /// A key's presence is the capability: the adapter answers `fork: {}`.
  init(agentCapabilities: [String: Any]) {
    let session = agentCapabilities["sessionCapabilities"] as? [String: Any] ?? [:]
    fork = session["fork"] != nil
    resume = session["resume"] != nil
    delete = session["delete"] != nil
    additionalDirectories = session["additionalDirectories"] != nil
    mcpHttp = (agentCapabilities["mcpCapabilities"] as? [String: Any])?["http"] as? Bool == true
  }
}

/// The conversation a branch forks from, up to and including `messageId`; nil copies all of it.
struct ChatForkSource: Codable, Equatable, Sendable {
  var sessionId: String
  var messageId: String?

  /// The fork-point hook the Claude adapter reads; ACP itself only forks a whole session.
  var params: [String: Any] {
    var params: [String: Any] = ["sessionId": sessionId]
    if let messageId {
      params["_meta"] = ["jetbrains": ["air": ["fork": ["version": 1, "messageId": messageId]]]]
    }
    return params
  }

  /// Forks before the user prompt `id`: up to the last agent message before it. Nil when there is
  /// nothing before it to keep, or when that message has no id (the copy fallback then applies).
  static func before(items: [ChatItem], at id: Int, sessionId: String?) -> ChatForkSource? {
    guard let sessionId, let index = items.firstIndex(where: { $0.id == id }) else { return nil }
    for item in items[..<index].reversed() {
      switch item.kind {
      case let .assistant(_, messageId): return messageId.map { ChatForkSource(sessionId: sessionId, messageId: $0) }
      case .user: return nil
      default: continue
      }
    }
    return nil
  }
}

struct ChatMCPServer: Codable, Equatable, Hashable, Identifiable, Sendable {
  struct Header: Codable, Equatable, Hashable, Sendable {
    var name: String
    var value: String
  }

  var name: String
  var url: String
  var headers: [Header] = []

  var id: String { name }

  var json: [String: Any] {
    ["type": "http", "name": name, "url": url, "headers": headers.map { ["name": $0.name, "value": $0.value] }]
  }

  /// `Name: value` per line; blank lines are skipped, a line without a colon is an error.
  static func headers(from text: String) -> [Header]? {
    var headers: [Header] = []
    for raw in text.split(whereSeparator: \.isNewline) {
      let line = raw.trimmingCharacters(in: .whitespaces)
      guard !line.isEmpty else { continue }
      guard let colon = line.firstIndex(of: ":") else { return nil }
      let name = line[..<colon].trimmingCharacters(in: .whitespaces)
      guard !name.isEmpty else { return nil }
      headers.append(Header(name: name, value: line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)))
    }
    return headers
  }

  /// Why `self` can't join `existing`, or nil.
  func problem(among existing: [ChatMCPServer]) -> String? {
    let trimmed = name.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { return "Give the server a name." }
    if existing.contains(where: { $0.name == trimmed }) { return "A server with that name already exists." }
    guard let scheme = URL(string: url)?.scheme?.lowercased(), ["http", "https"].contains(scheme),
      URL(string: url)?.host?.isEmpty == false
    else { return "The URL must start with http:// or https://." }
    return nil
  }
}

/// The MCP servers saved for one host. Headers can carry tokens, so the list lives in the Keychain.
final class ChatMCPServerStore: @unchecked Sendable {
  private let secrets: any SSHSecretStore
  private let key: String

  init(scope: String, secrets: any SSHSecretStore = KeychainSecretStore(service: "tether.acp.mcp")) {
    self.secrets = secrets
    self.key = "servers.\(scope)"
  }

  convenience init(config: SSHConnectionConfig) { self.init(scope: ChatTitleStore.scope(for: config)) }

  var servers: [ChatMCPServer] {
    get {
      secrets.secret(forKey: key).flatMap { try? JSONDecoder().decode([ChatMCPServer].self, from: Data($0.utf8)) } ?? []
    }
    set {
      let text = try? String(data: JSONEncoder().encode(newValue), encoding: .utf8)
      secrets.setSecret(newValue.isEmpty ? nil : text, forKey: key)
    }
  }

  /// The saved servers a chat picked, in its order; a name no longer saved is dropped.
  func resolve(_ names: [String]) -> [ChatMCPServer] {
    let saved = servers
    return names.compactMap { name in saved.first { $0.name == name } }
  }
}

extension ACPHostCommand {
  /// Nil when the host confirmed; otherwise what to show.
  static func deleteFailure(_ output: String) -> String? {
    for line in output.split(whereSeparator: \.isNewline) {
      if let object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any], object["deleted"] != nil {
        return nil
      }
    }
    let lower = output.lowercased()
    if lower.contains("flag provided but not defined") || lower.contains("usage:") {
      return "Update tether on the host to delete conversations."
    }
    let first = output.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
    return first.isEmpty ? "The host didn't confirm the delete." : ACPSavedSessionListing.explain(first)
  }
}

extension ChatRoute {
  /// Expands `~` the way the main folder is; nil when the host's home can't be read.
  static func extraDirectories(_ folders: [String], exec: (String) async throws -> String) async -> [String]? {
    guard !folders.isEmpty else { return [] }
    var home = ""
    if folders.contains(where: ACPCwd.needsHome) {
      guard let found = try? await exec(ACPHostCommand.home), found.hasPrefix("/") else { return nil }
      home = found.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return folders.map { ACPCwd.expand($0, home: home) }
  }
}
