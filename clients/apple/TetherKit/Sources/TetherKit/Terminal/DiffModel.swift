import Foundation

/// Pure Swift port of `apps/mobile/src/diffModel.ts` — no UIKit.

public enum DiffLineKind: String, Equatable, Sendable {
  case add
  case remove
  case meta
  case context
}

public struct DiffLine: Equatable, Sendable {
  public var text: String
  public var kind: DiffLineKind
  /// Content with the leading unified-diff marker (+/-/space) stripped.
  public var content: String
  public var oldLine: Int?
  public var newLine: Int?

  public init(
    text: String,
    kind: DiffLineKind,
    content: String,
    oldLine: Int?,
    newLine: Int?
  ) {
    self.text = text
    self.kind = kind
    self.content = content
    self.oldLine = oldLine
    self.newLine = newLine
  }
}

public struct DiffSummaryGroups: Equatable, Sendable {
  public var staged: [DiffFileStat]
  public var unstaged: [DiffFileStat]

  public init(staged: [DiffFileStat], unstaged: [DiffFileStat]) {
    self.staged = staged
    self.unstaged = unstaged
  }
}

private let imageExtensions: Set<String> = [
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico",
]

public func isImagePath(_ path: String) -> Bool {
  let ext = path.split(separator: ".").last.map(String.init)?.lowercased() ?? ""
  return imageExtensions.contains(ext)
}

public func groupSummary(_ summary: DiffSummary) -> DiffSummaryGroups {
  let staged = summary.files.filter { $0.staged == true }
  let unstaged = summary.files.filter { $0.staged != true }
  return DiffSummaryGroups(staged: staged, unstaged: unstaged)
}

public func totalChanges(_ summary: DiffSummary) -> Int {
  summary.files.reduce(0) { $0 + $1.insertions + $1.deletions }
}

public func changeLabel(_ summary: DiffSummary) -> String? {
  guard !summary.files.isEmpty else { return nil }
  let insertions = summary.files.reduce(0) { $0 + $1.insertions }
  let deletions = summary.files.reduce(0) { $0 + $1.deletions }
  return "+\(insertions) -\(deletions)"
}

public func displayDiff(_ diff: String, truncated: Bool) -> String {
  truncated ? "\(diff)\n[Diff truncated at 1 MiB]" : diff
}

public func diffLineKind(_ line: String) -> DiffLineKind {
  if line.hasPrefix("diff --git")
    || line.hasPrefix("index ")
    || line.hasPrefix("---")
    || line.hasPrefix("+++")
    || line.hasPrefix("@@")
    || line.hasPrefix("new file mode")
    || line.hasPrefix("deleted file mode")
    || line.hasPrefix("old mode")
    || line.hasPrefix("new mode")
    || line.hasPrefix("similarity index")
    || line.hasPrefix("dissimilarity index")
    || line.hasPrefix("rename from")
    || line.hasPrefix("rename to")
    || line.hasPrefix("copy from")
    || line.hasPrefix("copy to")
    || line.hasPrefix("Binary files ")
  {
    return .meta
  }
  if line.hasPrefix("+") { return .add }
  if line.hasPrefix("-") { return .remove }
  return .context
}

private let hunkHeaderRegex = try! NSRegularExpression(
  pattern: #"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@"#)

private let hunkStartRegex = try! NSRegularExpression(pattern: #"^@@ -\d"#)

/// Walks a unified diff assigning old/new line numbers per hunk.
public func parseDiffLines(_ diff: String) -> [DiffLine] {
  var oldLine = 0
  var newLine = 0
  let parts = diff.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  return parts.map { text in
    let kind = diffLineKind(text)
    if kind == .meta {
      let range = NSRange(text.startIndex..<text.endIndex, in: text)
      if let match = hunkHeaderRegex.firstMatch(in: text, range: range),
         match.numberOfRanges >= 3,
         let oldRange = Range(match.range(at: 1), in: text),
         let newRange = Range(match.range(at: 2), in: text),
         let old = Int(text[oldRange]),
         let new = Int(text[newRange])
      {
        oldLine = old
        newLine = new
        return DiffLine(text: text, kind: kind, content: text, oldLine: nil, newLine: nil)
      }
      return DiffLine(text: text, kind: kind, content: text, oldLine: nil, newLine: nil)
    }
    let content = String(text.dropFirst())
    switch kind {
    case .remove:
      let n = oldLine
      oldLine += 1
      return DiffLine(text: text, kind: kind, content: content, oldLine: n, newLine: nil)
    case .add:
      let n = newLine
      newLine += 1
      return DiffLine(text: text, kind: kind, content: content, oldLine: nil, newLine: n)
    case .context:
      let o = oldLine
      let n = newLine
      oldLine += 1
      newLine += 1
      return DiffLine(text: text, kind: kind, content: content, oldLine: o, newLine: n)
    case .meta:
      return DiffLine(text: text, kind: kind, content: text, oldLine: nil, newLine: nil)
    }
  }
}

/// Ordinal hunk index for each parsed line (`nil` for non-header lines).
/// Counts one per `@@` header, matching the server's `splitHunks`.
public func annotateHunkIndices(_ lines: [DiffLine]) -> [Int?] {
  var hunk = -1
  return lines.map { line in
    if line.kind == .meta {
      let range = NSRange(line.text.startIndex..<line.text.endIndex, in: line.text)
      if hunkStartRegex.firstMatch(in: line.text, range: range) != nil {
        hunk += 1
        return hunk
      }
    }
    return nil
  }
}
