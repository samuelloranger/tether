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

/// Hunk headers only (`@@ … @@`). File-level `diff --git` / `---` / `+++` lines
/// are meta but hidden in the review UI (matches RN `DiffLines`).
private let visibleHunkHeaderRegex = try! NSRegularExpression(
  pattern: #"^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@"#)

/// Drops file-header meta lines; keeps hunk headers and body lines.
public func visibleDiffLines(_ lines: [DiffLine]) -> [DiffLine] {
  lines.filter { line in
    if line.kind != .meta { return true }
    return isHunkHeaderLine(line.text)
  }
}

/// Same filter as `visibleDiffLines`, keeping hunk-index annotations aligned.
public func visibleDiffLines(
  _ lines: [DiffLine],
  hunkIndices: [Int?]
) -> (lines: [DiffLine], hunkIndices: [Int?]) {
  var outLines: [DiffLine] = []
  var outIndices: [Int?] = []
  for (i, line) in lines.enumerated() {
    if line.kind != .meta || isHunkHeaderLine(line.text) {
      outLines.append(line)
      outIndices.append(i < hunkIndices.count ? hunkIndices[i] : nil)
    }
  }
  return (outLines, outIndices)
}

private func isHunkHeaderLine(_ text: String) -> Bool {
  let range = NSRange(text.startIndex..<text.endIndex, in: text)
  return visibleHunkHeaderRegex.firstMatch(in: text, range: range) != nil
}

public struct SideBySideRow: Equatable, Sendable {
  public var left: DiffLine?
  public var right: DiffLine?
  /// Meta rows (hunk headers) span the full width.
  public var span: Bool

  public init(left: DiffLine?, right: DiffLine?, span: Bool) {
    self.left = left
    self.right = right
    self.span = span
  }
}

/// Pairs remove/add runs into aligned two-column rows (RN `pairDiffRows`).
public func pairDiffRows(_ lines: [DiffLine]) -> [SideBySideRow] {
  var rows: [SideBySideRow] = []
  var removes: [DiffLine] = []
  var adds: [DiffLine] = []
  func flush() {
    let n = max(removes.count, adds.count)
    for i in 0..<n {
      rows.append(
        SideBySideRow(
          left: i < removes.count ? removes[i] : nil,
          right: i < adds.count ? adds[i] : nil,
          span: false
        )
      )
    }
    removes = []
    adds = []
  }
  for line in lines {
    switch line.kind {
    case .remove:
      removes.append(line)
    case .add:
      adds.append(line)
    case .meta:
      flush()
      rows.append(SideBySideRow(left: line, right: nil, span: true))
    case .context:
      flush()
      rows.append(SideBySideRow(left: line, right: line, span: false))
    }
  }
  flush()
  return rows
}

/// Unified-diff file path headers (`--- a/…`, `+++ b/…`, `/dev/null`).
/// Body lines that merely start with `---`/`+++` (e.g. a removal of `---`) are
/// NOT matched — those need the leading +/- marker plus content, with no
/// required `a/`/`b/`/`/dev/null` form.
func isUnifiedFilePathHeader(_ line: String) -> Bool {
  let prefix: String
  if line.hasPrefix("--- ") {
    prefix = "--- "
  } else if line.hasPrefix("+++ ") {
    prefix = "+++ "
  } else {
    return false
  }
  let rest = String(line.dropFirst(prefix.count))
  return rest.hasPrefix("a/")
    || rest.hasPrefix("b/")
    || rest == "/dev/null"
    || rest.hasPrefix("\"a/")
    || rest.hasPrefix("\"b/")
}

public func diffLineKind(_ line: String) -> DiffLineKind {
  // `---` / `+++` path headers are classified in `parseDiffLines` by structural
  // position (only between `diff --git` and the first `@@` of that file), not
  // by a naive prefix match — otherwise a body line like `----` (deletion of
  // `---`) would be swallowed as meta.
  if line.hasPrefix("diff --git")
    || line.hasPrefix("index ")
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
/// Empty input yields `[]` — an empty string's split is `[""]`, which would
/// otherwise become a degenerate context line rendering as "0 0". Trailing
/// empty segments from a final newline are skipped for the same reason.
public func parseDiffLines(_ diff: String) -> [DiffLine] {
  if diff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return [] }
  var oldLine = 0
  var newLine = 0
  /// False while reading file-level headers; true after the first `@@` until
  /// the next `diff --git` (multi-file patches reset).
  var inHunkBody = false
  let parts = diff.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  var result: [DiffLine] = []
  result.reserveCapacity(parts.count)
  for text in parts {
    // Split artifact / blank — never a real unified-diff body line (those always
    // carry a leading marker). Skipping prevents the stray "0 0" gutter row.
    if text.isEmpty { continue }

    if text.hasPrefix("diff --git") {
      inHunkBody = false
    }

    let kind: DiffLineKind
    if !inHunkBody && isUnifiedFilePathHeader(text) {
      kind = .meta
    } else {
      kind = diffLineKind(text)
    }

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
        inHunkBody = true
        result.append(DiffLine(text: text, kind: kind, content: text, oldLine: nil, newLine: nil))
        continue
      }
      result.append(DiffLine(text: text, kind: kind, content: text, oldLine: nil, newLine: nil))
      continue
    }
    let content = String(text.dropFirst())
    switch kind {
    case .remove:
      let n = oldLine
      oldLine += 1
      result.append(DiffLine(text: text, kind: kind, content: content, oldLine: n, newLine: nil))
    case .add:
      let n = newLine
      newLine += 1
      result.append(DiffLine(text: text, kind: kind, content: content, oldLine: nil, newLine: n))
    case .context:
      let o = oldLine
      let n = newLine
      oldLine += 1
      newLine += 1
      result.append(DiffLine(text: text, kind: kind, content: content, oldLine: o, newLine: n))
    case .meta:
      result.append(DiffLine(text: text, kind: kind, content: text, oldLine: nil, newLine: nil))
    }
  }
  return result
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
