import Foundation

/// A turn runs from one of your messages to the next; everything before the first one is a turn too.
enum ChatTurns {
  /// The last item id of the turns that are over: all of them, or all but the running one.
  static func finishedThrough(_ items: [ChatItem], working: Bool) -> Int {
    guard working else { return items.last?.id ?? -1 }
    guard let start = items.lastIndex(where: isUser) else { return -1 }
    return start == 0 ? -1 : items[start - 1].id
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
}
