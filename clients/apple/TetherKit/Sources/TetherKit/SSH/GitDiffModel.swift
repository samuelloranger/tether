import Foundation

/// Classifies raw `git diff` output for display. Kept Swift-side (no Rust) so it
/// stands on its own once the Rust core is removed.
public enum GitDiffLineKind: Equatable, Sendable {
  case fileHeader // diff --git / index / --- / +++
  case hunk // @@ ... @@
  case added
  case removed
  case context
}

public struct GitDiffLine: Equatable, Identifiable, Sendable {
  public let id: Int
  public let kind: GitDiffLineKind
  public let text: String
}

public enum GitDiffModel {
  public static func classify(_ diff: String) -> [GitDiffLine] {
    guard !diff.isEmpty else { return [] }
    return diff.components(separatedBy: "\n").enumerated().map { index, raw in
      GitDiffLine(id: index, kind: kind(of: raw), text: raw)
    }
  }

  public static func stat(_ lines: [GitDiffLine]) -> (added: Int, removed: Int) {
    (lines.filter { $0.kind == .added }.count, lines.filter { $0.kind == .removed }.count)
  }

  private static func kind(of line: String) -> GitDiffLineKind {
    if line.hasPrefix("diff ") || line.hasPrefix("index ")
      || line.hasPrefix("--- ") || line.hasPrefix("+++ ")
      || line.hasPrefix("new file") || line.hasPrefix("deleted file")
      || line.hasPrefix("rename ") || line.hasPrefix("similarity ") {
      return .fileHeader
    }
    if line.hasPrefix("@@") { return .hunk }
    if line.hasPrefix("+") { return .added }
    if line.hasPrefix("-") { return .removed }
    return .context
  }
}
