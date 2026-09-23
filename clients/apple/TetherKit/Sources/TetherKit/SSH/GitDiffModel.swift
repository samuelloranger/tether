import Foundation

public enum GitDiffLineKind: Equatable, Sendable {
  case fileHeader
  case hunk
  case added
  case removed
  case context
}

public struct GitDiffLine: Equatable, Identifiable, Sendable {
  public let id: Int
  public let kind: GitDiffLineKind
  public let text: String
}

/// Classifies raw `git diff` output for display.
public enum GitDiffModel {
  public static func classify(_ diff: String) -> [GitDiffLine] {
    guard !diff.isEmpty else { return [] }
    return diff.components(separatedBy: "\n").enumerated().map { index, raw in
      GitDiffLine(id: index, kind: kind(of: raw), text: raw)
    }
  }

  /// Splits `git show --format=%b%x1e` into message and patch. Without the marker git
  /// separates them with a bare `---`, which the classifier would read as a deletion.
  public static func commitShow(_ output: String) -> (body: String, patch: String) {
    guard let marker = output.firstIndex(of: "\u{1E}") else { return ("", output) }
    var patch = Substring(output[output.index(after: marker)...])
    while patch.first == "\n" { patch = patch.dropFirst() }
    return (
      String(output[output.startIndex..<marker]).trimmingCharacters(in: .whitespacesAndNewlines),
      String(patch)
    )
  }

  private static func kind(of line: String) -> GitDiffLineKind {
    if line.hasPrefix("diff ") || line.hasPrefix("index ")
      || line.hasPrefix("--- ") || line.hasPrefix("+++ ")
      || line.hasPrefix("new file") || line.hasPrefix("deleted file")
      || line.hasPrefix("rename ") || line.hasPrefix("similarity ")
      || line.hasPrefix("old mode ") || line.hasPrefix("new mode ") {
      return .fileHeader
    }
    if line.hasPrefix("@@") { return .hunk }
    if line.hasPrefix("+") { return .added }
    if line.hasPrefix("-") { return .removed }
    return .context
  }
}
