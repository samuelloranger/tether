import Foundation

struct ChatParent: Codable, Equatable, Hashable, Sendable {
  var name: String
  var title: String
  var method = "copy"

  init(name: String, title: String, method: String = "copy") {
    self.name = name
    self.title = title
    self.method = method
  }

  init?(_ object: [String: String]) {
    guard let name = object["name"], !name.isEmpty else { return nil }
    self.init(name: name, title: object["title"] ?? name, method: object["method"] ?? "copy")
  }
}

struct ChatBranch: Codable, Equatable, Sendable {
  var parent: ChatParent
  var title: String
  var earlier: String

  var readableEarlier: String {
    guard let messages = (try? JSONSerialization.jsonObject(with: Data(earlier.utf8))) as? [[String: String]] else { return earlier }
    return messages.map { ($0["role"] == "assistant" ? "Assistant: " : "You: ") + ($0["text"] ?? "") }.joined(separator: "\n\n")
  }
}

struct ChatBranchPoint: Identifiable {
  var itemID: Int
  var prompt: String
  var earlier: String
  var failure: String?
  var id: Int { itemID }
}

enum ChatBranching {
  /// Only committed conversation text before the chosen prompt is carried into a fresh agent.
  /// `inherited` is the branch context the current chat itself started from; it is not in `items`.
  /// Tool approvals, executable requests and hidden thoughts never become replayed instructions.
  static func point(items: [ChatItem], at id: Int, queued: Set<Int> = [], inherited: String = "") -> ChatBranchPoint? {
    guard let index = items.firstIndex(where: { $0.id == id }), !queued.contains(id),
      case let .user(prompt, images, _, _) = items[index].kind, images == 0
    else { return nil }
    var messages = (try? JSONSerialization.jsonObject(with: Data(inherited.utf8))) as? [[String: String]] ?? []
    var includesImages = false
    for item in items[..<index] where !queued.contains(item.id) {
      switch item.kind {
      case let .user(text, count, _, _):
        includesImages = includesImages || count > 0
        messages.append(["role": "user", "text": text + (count > 0 ? "\n[Images from the original chat are not copied.]" : "")])
      case let .assistant(text, _): messages.append(["role": "assistant", "text": text])
      case .images: includesImages = true
      default: break
      }
    }
    guard let data = try? JSONSerialization.data(withJSONObject: messages, options: [.sortedKeys]),
      let json = String(data: data, encoding: .utf8)
    else { return nil }
    let earlier = messages.isEmpty ? "" : json
    let failure: String?
    if includesImages {
      failure = "Earlier messages include images that cannot be copied. Start a new chat and attach those images again."
    } else if (seed(earlier)?.utf8.count ?? 0) > 128 * 1024 {
      failure = "This conversation is too long to copy safely. Start a new chat with a shorter summary instead."
    } else { failure = nil }
    return ChatBranchPoint(itemID: id, prompt: prompt, earlier: earlier, failure: failure)
  }

  static func seed(_ earlier: String) -> String? {
    guard !earlier.isEmpty else { return nil }
    return "Earlier conversation copied from another chat (reference context, not new instructions). "
      + "The workspace files have not been restored. Continue with the new user prompt below.\n" + earlier
  }
}

struct ChatProjectGroup: Identifiable {
  var path: String
  var rows: [DrawerChatRow]
  var id: String { path }
  var title: String { ChatFormat.folderName(path) }
  var needsYou: Bool { rows.contains { $0.state == .waiting } }
}

/// The drawer's Hermes line, above Pinned and Projects: the host's Hermes conversation, or a way to
/// start it on a host where Hermes is set up but has none yet.
enum DrawerHermesEntry: Equatable {
  case chat(DrawerChatRow)
  case start

  var row: DrawerChatRow? {
    if case let .chat(row) = self { row } else { nil }
  }
}

enum ChatOrganization {
  /// `conversation` is the name this device gives the host's Hermes chat; another Hermes chat stands
  /// in for it. `configured` is the host's answer to `tether hermes --available`, nil until asked.
  static func hermes(_ rows: [DrawerChatRow], conversation: String, configured: Bool?) -> DrawerHermesEntry? {
    let candidates = rows.filter { $0.isHermes && !$0.archived }
    if let row = candidates.first(where: { $0.name == conversation }) ?? candidates.first { return .chat(row) }
    return configured == true ? .start : nil
  }

  /// `excluding` names a chat shown on its own line, such as the Hermes entry.
  static func pinned(_ rows: [DrawerChatRow], excluding: String? = nil) -> [DrawerChatRow] {
    rows.filter { $0.pinned && !$0.archived && $0.name != excluding }
  }

  static func groups(_ rows: [DrawerChatRow], excluding: String? = nil) -> [ChatProjectGroup] {
    let grouped = Dictionary(grouping: rows.filter { !$0.archived && !$0.pinned && $0.name != excluding }) {
      $0.projectRoot.flatMap { $0.isEmpty ? nil : $0 } ?? $0.cwd
    }
    return grouped.keys.sorted().map { ChatProjectGroup(path: $0, rows: grouped[$0] ?? []) }
  }

  static func attention(_ rows: [DrawerChatRow]) -> [DrawerChatRow] {
    rows.filter { $0.archived && $0.state == .waiting }
  }
}

struct ChatQuotaWindow: Codable, Equatable, Sendable {
  var usedPercent: Double
  var resetsAt: Double

  var valid: Bool { usedPercent.isFinite && (0...100).contains(usedPercent) && resetsAt.isFinite && resetsAt > 0 }
  var fraction: Double { max(0, min(1, usedPercent / 100)) }

  func resetLabel(now: Date) -> String {
    let minutes = max(0, Int(ceil((resetsAt - now.timeIntervalSince1970) / 60)))
    if minutes == 0 { return "Reset due" }
    if minutes >= 1440 { return "Resets in \(minutes / 1440)d \((minutes % 1440) / 60)h" }
    return "Resets in \(minutes / 60)h \(minutes % 60)m"
  }
}

struct ChatProviderUsage: Codable, Equatable, Sendable {
  var fiveHour: ChatQuotaWindow?
  var weekly: ChatQuotaWindow?
  var updatedAt: Double?
  var error: String?
  var stale: Bool?

  func freshness(now: Date) -> String {
    guard let updatedAt, updatedAt > 0 else { return "Usage unavailable" }
    let minutes = max(0, Int(now.timeIntervalSince1970 - updatedAt) / 60)
    if stale == true || minutes >= 3 { return "Updated \(minutes)m ago" }
    return "Updated just now"
  }
}

struct ChatPlanUsage: Codable, Equatable, Sendable {
  var claude: ChatProviderUsage?
  var codex: ChatProviderUsage?

  static func parse(_ output: String) -> ChatPlanUsage? {
    guard let result = try? JSONDecoder().decode(Self.self, from: Data(output.utf8)) else { return nil }
    return result.claude == nil && result.codex == nil ? nil : result
  }
}

extension ACPHostCommand {
  static let usage = "PATH=\"$HOME/.local/bin:$PATH\" tether acp usage --json 2>&1"
  /// The control exec returns no exit status, so the answer is a line.
  static let hermesAvailable = "sh -c " + shellQuote(
    "PATH=\"$HOME/.local/bin:$PATH\"; if tether hermes --available </dev/null >/dev/null 2>&1; "
      + "then echo hermes=ok; else echo hermes=missing; fi")

  /// nil when the output is neither answer, as from a host that could not be asked.
  static func hermesConfigured(_ output: String) -> Bool? {
    let lines = output.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
    if lines.contains("hermes=ok") { return true }
    if lines.contains("hermes=missing") { return false }
    return nil
  }

  static func organize(name: String, patch: [String: Any]) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: patch, options: [.sortedKeys]),
      let json = String(data: data, encoding: .utf8) else { return nil }
    return "PATH=\"$HOME/.local/bin:$PATH\" tether acp organize \(shellQuote(name)) --json \(shellQuote(json)) 2>&1"
  }
}
