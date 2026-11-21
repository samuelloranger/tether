import Foundation

/// What a finished turn changed and ran, shown as one card where the turn ends.
struct ChatTurnReceipt: Equatable {
  struct Change: Equatable {
    var path: String
    var added: Int
    var removed: Int
  }

  struct Command: Equatable {
    var title: String
    var failed: Bool
  }

  var changed: [Change] = []
  var ran: [Command] = []

  var isEmpty: Bool { changed.isEmpty && ran.isEmpty }
}

/// A turn runs from one of your messages to the next; everything before the first one is a turn too.
enum ChatTurns {
  /// The last item id of the turns that are over: all of them, or all but the running one.
  static func finishedThrough(_ items: [ChatItem], working: Bool) -> Int {
    guard working else { return items.last?.id ?? -1 }
    guard let start = items.lastIndex(where: isUser) else { return -1 }
    return start == 0 ? -1 : items[start - 1].id
  }

  typealias DiffCount = (path: String, added: Int, removed: Int)
  /// The call's id and its diff.
  typealias Counter = (String, ACPDiff) -> DiffCount

  /// One receipt per finished turn that changed a file or ran a command, keyed by its last item id.
  /// `count` lets the view cache line counts: the transcript redraws on every streamed chunk.
  static func receipts(
    _ items: [ChatItem], working: Bool, cwd: String, count: Counter? = nil
  ) -> [Int: ChatTurnReceipt] {
    let through = finishedThrough(items, working: working)
    var out: [Int: ChatTurnReceipt] = [:]
    for turn in split(items) {
      guard let last = turn.last, last.id <= through else { continue }
      let receipt = receipt(turn.compactMap(call), cwd: cwd, count: count)
      if !receipt.isEmpty { out[last.id] = receipt }
    }
    return out
  }

  static func receipt(_ calls: [ChatToolCall], cwd: String, count: Counter? = nil) -> ChatTurnReceipt {
    let count = count ?? { _, diff in
      let file = ACPDiffAdapter.file(for: diff, relativeTo: cwd)
      return (file.path, file.added, file.removed)
    }
    var receipt = ChatTurnReceipt()
    // A subagent's commands are its own working; the files it changed are the turn's result.
    for call in calls.flatMap({ [$0] + $0.children }) where call.status != .failed {
      guard let diff = call.diff else { continue }
      let file = count(call.id, diff)
      if let index = receipt.changed.firstIndex(where: { $0.path == file.path }) {
        receipt.changed[index].added += file.added
        receipt.changed[index].removed += file.removed
      } else {
        receipt.changed.append(.init(path: file.path, added: file.added, removed: file.removed))
      }
    }
    for call in calls where call.kind == .execute && call.subagent == nil {
      let title = call.displayTitle
      guard title != ChatToolCall.writingCommand else { continue }
      receipt.ran.append(.init(title: title, failed: call.status == .failed))
    }
    return receipt
  }

  /// A folded run of steps in one line: "Read 2 files, edited 1 file, ran 1 command".
  static func foldSummary(_ calls: [ChatToolCall]) -> String {
    var counts: [ACPToolKind: Int] = [:]
    var subagents = 0
    for call in calls {
      if call.subagent != nil { subagents += 1 } else { counts[call.kind, default: 0] += 1 }
    }
    func n(_ count: Int, _ one: String, _ many: String) -> String { "\(count) \(count == 1 ? one : many)" }
    func times(_ count: Int) -> String { count == 1 ? "once" : count == 2 ? "twice" : "\(count) times" }
    var parts: [String] = []
    if let c = counts[.read] { parts.append("read \(n(c, "file", "files"))") }
    if let c = counts[.search] { parts.append("searched \(times(c))") }
    if let c = counts[.fetch] { parts.append("fetched \(n(c, "page", "pages"))") }
    if let c = counts[.edit] { parts.append("edited \(n(c, "file", "files"))") }
    if let c = counts[.delete] { parts.append("deleted \(n(c, "file", "files"))") }
    if let c = counts[.move] { parts.append("moved \(n(c, "file", "files"))") }
    if let c = counts[.execute] { parts.append("ran \(n(c, "command", "commands"))") }
    if subagents > 0 { parts.append("ran \(n(subagents, "subagent", "subagents"))") }
    let rest = [ACPToolKind.think, .switchMode, .other].reduce(0) { $0 + (counts[$1] ?? 0) }
    if rest > 0 { parts.append(n(rest, "other step", "other steps")) }
    let sentence = parts.joined(separator: ", ")
    return sentence.prefix(1).uppercased() + sentence.dropFirst()
  }

  private static func isUser(_ item: ChatItem) -> Bool {
    if case .user = item.kind { return true }
    return false
  }

  private static func call(_ item: ChatItem) -> ChatToolCall? {
    if case let .tool(call) = item.kind { return call }
    return nil
  }

  private static func split(_ items: [ChatItem]) -> [[ChatItem]] {
    var turns: [[ChatItem]] = []
    for item in items {
      if isUser(item) || turns.isEmpty { turns.append([item]) } else { turns[turns.count - 1].append(item) }
    }
    return turns
  }
}


/// Line counts per tool call, kept by a chat view so a redraw never diffs the same edit twice.
/// The stored diff only guards against an update to the call; comparing it is cheap when unchanged.
@MainActor
final class ChatDiffCounts {
  private var counts: [String: (diff: ACPDiff, count: ChatTurns.DiffCount)] = [:]

  func count(_ id: String, _ diff: ACPDiff, cwd: String) -> ChatTurns.DiffCount {
    if let known = counts[id], known.diff == diff { return known.count }
    let file = ACPDiffAdapter.file(for: diff, relativeTo: cwd)
    let value = (file.path, file.added, file.removed)
    counts[id] = (diff, value)
    return value
  }
}
