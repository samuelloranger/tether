import Foundation

/// One line of a patch, with the numbers git only states once per hunk.
public struct DiffRow: Equatable, Identifiable, Sendable {
  public enum Kind: Equatable, Sendable { case context, added, removed, hunk, plain }

  public let id: Int
  public let kind: Kind
  public let oldLine: Int?
  public let newLine: Int?
  /// The marker is dropped: the gutter carries it instead of a character.
  public let text: String
}

public struct DiffFile: Equatable, Identifiable, Sendable {
  public let path: String
  public let added: Int
  public let removed: Int
  public let rows: [DiffRow]

  public var id: String { path.isEmpty ? "__preamble__" : path }
  /// `git show` prints a message and a stat block before the first file.
  public var isPreamble: Bool { path.isEmpty }

  public static func group(_ lines: [GitDiffLine]) -> [DiffFile] {
    var files: [DiffFile] = []
    var path = ""
    var rows: [DiffRow] = []
    var added = 0
    var removed = 0
    var oldLine = 0
    var newLine = 0
    var id = 0

    func flush() {
      guard !rows.isEmpty || !path.isEmpty else { return }
      files.append(DiffFile(path: path, added: added, removed: removed, rows: rows))
      rows = []
      added = 0
      removed = 0
    }

    for line in lines {
      let text = line.text
      if text.hasPrefix("diff --git ") {
        flush()
        path = newPath(from: text)
        continue
      }
      if text.hasPrefix("index ") || text.hasPrefix("--- ") || text.hasPrefix("+++ ")
        || text.hasPrefix("new file") || text.hasPrefix("deleted file")
        || text.hasPrefix("similarity ") || text.hasPrefix("rename ") {
        continue
      }

      id += 1
      switch line.kind {
      case .hunk:
        let (old, new) = hunkStart(text)
        oldLine = old
        newLine = new
        rows.append(DiffRow(id: id, kind: .hunk, oldLine: nil, newLine: nil, text: hunkContext(text)))
      case .added:
        added += 1
        rows.append(DiffRow(id: id, kind: .added, oldLine: nil, newLine: newLine, text: String(text.dropFirst())))
        newLine += 1
      case .removed:
        removed += 1
        rows.append(DiffRow(id: id, kind: .removed, oldLine: oldLine, newLine: nil, text: String(text.dropFirst())))
        oldLine += 1
      case .context where !path.isEmpty:
        rows.append(DiffRow(id: id, kind: .context, oldLine: oldLine, newLine: newLine, text: String(text.dropFirst())))
        oldLine += 1
        newLine += 1
      default:
        rows.append(DiffRow(id: id, kind: .plain, oldLine: nil, newLine: nil, text: text))
      }
    }
    flush()
    return files.filter { !$0.rows.isEmpty }
  }

  private static func newPath(from header: String) -> String {
    guard let range = header.range(of: " b/") else { return header }
    return String(header[range.upperBound...])
  }

  private static func hunkStart(_ header: String) -> (old: Int, new: Int) {
    let parts = header.split(separator: " ")
    func number(_ token: Substring?) -> Int {
      guard let token else { return 1 }
      let digits = token.dropFirst().prefix { $0.isNumber }
      return Int(digits) ?? 1
    }
    return (number(parts.first { $0.hasPrefix("-") }), number(parts.first { $0.hasPrefix("+") }))
  }

  private static func hunkContext(_ header: String) -> String {
    let parts = header.components(separatedBy: "@@")
    guard parts.count > 2 else { return "" }
    return parts[2].trimmingCharacters(in: .whitespaces)
  }
}
