import Foundation

/// What the host's holder says the agent is doing, from `acp status`.
enum ChatHostTurn: String, Equatable, Sendable {
  case idle, working, waiting
}

/// `acp status`: one JSON object per chat. A host whose tether predates the command prints an
/// error line instead, which reads as `unsupported` so the caller falls back to `acp ls`.
enum ACPChatStatusListing {
  struct Result: Equatable {
    var chats: [ACPChatSummary]
    var unsupported: Bool
  }

  static func parse(_ output: String) -> Result {
    var chats: [ACPChatSummary] = []
    var stray = false
    for raw in output.split(whereSeparator: \.isNewline) {
      let line = raw.trimmingCharacters(in: .whitespaces)
      guard !line.isEmpty else { continue }
      guard let chat = chat(from: line) else {
        stray = true
        continue
      }
      chats.append(chat)
    }
    chats.sort { $0.created > $1.created }
    return Result(chats: chats, unsupported: chats.isEmpty && stray)
  }

  private static func chat(from line: String) -> ACPChatSummary? {
    guard let object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
      let name = object["name"] as? String, !name.isEmpty,
      let state = object["state"] as? String, state == "running" || state == "ended"
    else { return nil }
    let title = (object["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    return ACPChatSummary(
      name: name, isRunning: state == "running", logBytes: (object["logBytes"] as? NSNumber)?.intValue ?? 0,
      cwd: object["cwd"] as? String ?? "",
      created: Date(timeIntervalSince1970: (object["created"] as? NSNumber)?.doubleValue ?? 0), spawn: "",
      turn: (object["turn"] as? String).flatMap(ChatHostTurn.init(rawValue:)) ?? .idle,
      hostTitle: title.flatMap { $0.isEmpty ? nil : $0 }, hasStatus: true)
  }
}

/// The state a drawer row shows. `running` is what a host without `acp status` can say.
enum DrawerChatState: Equatable {
  case working, waiting, idle, running, ended

  init(_ chat: ACPChatSummary) {
    if !chat.isRunning {
      self = .ended
    } else if !chat.hasStatus {
      self = .running
    } else {
      switch chat.turn {
      case .working: self = .working
      case .waiting: self = .waiting
      case .idle: self = .idle
      }
    }
  }

  var label: String {
    switch self {
    case .working: "working"
    case .waiting: "needs you"
    case .idle: "idle"
    case .running: "running"
    case .ended: "ended"
    }
  }
}
