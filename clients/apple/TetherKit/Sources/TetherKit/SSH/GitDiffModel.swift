import Foundation

public enum GitDiffLineKind: Equatable, Sendable {
  case fileHeader
  case hunk
  case added
  case removed
  case context
  /// Inside a file but not a line of code: `\ No newline at end of file`, `Binary files … differ`.
  case note
}

public struct GitDiffLine: Equatable, Identifiable, Sendable {
  public let id: Int
  public let kind: GitDiffLineKind
  public let text: String
  /// Marker columns before the code: one in a plain diff, one per parent in a combined (merge) diff.
  public var markerWidth: Int = 1
}

/// Classifies raw `git diff` output for display.
public enum GitDiffModel {
  /// A line's prefix only means something in the right place: inside a hunk the first column is
  /// the marker (so a removed `-- comment` is a removal, not a `--- ` header), and the hunk's own
  /// line counts say where it ends.
  public static func classify(_ diff: String) -> [GitDiffLine] {
    guard !diff.isEmpty else { return [] }
    var raw = diff.utf8.split(separator: UInt8(ascii: "\n"), omittingEmptySubsequences: false)
    if raw.last?.isEmpty == true { raw.removeLast() }
    var lines: [GitDiffLine] = []
    lines.reserveCapacity(raw.count)
    var inFile = false
    var inHunk = false
    var parents = 1
    var oldLeft = 0
    var newLeft = 0

    for (index, bytes) in raw.enumerated() {
      let text = String(Substring(bytes))
      let first = bytes.first
      if inHunk {
        if parents == 1 {
          var kind: GitDiffLineKind?
          switch first {
          case UInt8(ascii: "+"): kind = .added; newLeft -= 1
          case UInt8(ascii: "-"): kind = .removed; oldLeft -= 1
          case UInt8(ascii: " "), nil: kind = .context; oldLeft -= 1; newLeft -= 1
          case UInt8(ascii: "\\"): kind = .note
          default: inHunk = false
          }
          if let kind {
            lines.append(GitDiffLine(id: index, kind: kind, text: text))
            if oldLeft <= 0, newLeft <= 0 { inHunk = false }
            continue
          }
        } else if let combined = combinedKind(bytes, parents: parents) {
          lines.append(GitDiffLine(id: index, kind: combined, text: text, markerWidth: parents))
          continue
        } else {
          inHunk = false
        }
      }

      let kind: GitDiffLineKind
      if text.hasPrefix("diff ") || text.hasPrefix("--- ") || text.hasPrefix("+++ ") {
        inFile = true
        kind = .fileHeader
      } else if inFile, first == UInt8(ascii: "@") {
        let ats = bytes.prefix { $0 == UInt8(ascii: "@") }.count
        parents = max(1, ats - 1)
        (oldLeft, newLeft) = hunkCounts(text)
        inHunk = parents > 1 || oldLeft > 0 || newLeft > 0
        kind = .hunk
      } else if text.hasPrefix("Binary files ") || first == UInt8(ascii: "\\") {
        kind = .note
      } else if inFile {
        kind = .fileHeader
      } else {
        kind = .context
      }
      lines.append(GitDiffLine(id: index, kind: kind, text: text))
    }
    return lines
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

  /// `@@ -a,b +c,d @@`: the lines the hunk spans on each side (a missing count means one).
  static func hunkCounts(_ header: String) -> (old: Int, new: Int) {
    var old = 0
    var new = 0
    for token in header.split(separator: " ").dropFirst() {
      guard let sign = token.first, sign == "-" || sign == "+" else { break }
      let parts = token.dropFirst().split(separator: ",", omittingEmptySubsequences: false)
      let count = parts.count > 1 ? Int(parts[1]) ?? 0 : 1
      if sign == "-" { old = count } else { new = count }
    }
    return (old, new)
  }

  /// A combined diff marks each parent in its own column; a line added against any parent reads
  /// as an addition. Anything without a marker in every column has left the hunk.
  private static func combinedKind(_ bytes: Substring.UTF8View, parents: Int) -> GitDiffLineKind? {
    let markers = bytes.prefix(parents)
    guard markers.count == parents else { return bytes.isEmpty ? .context : nil }
    var added = false
    var removed = false
    for marker in markers {
      switch marker {
      case UInt8(ascii: "+"): added = true
      case UInt8(ascii: "-"): removed = true
      case UInt8(ascii: " "): break
      default: return nil
      }
    }
    return added ? .added : removed ? .removed : .context
  }
}
