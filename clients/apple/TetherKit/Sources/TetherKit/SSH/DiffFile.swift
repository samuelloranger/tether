import Foundation

/// One line of a patch, with the numbers git only states once per hunk.
public struct DiffRow: Equatable, Identifiable, Sendable {
  public enum Kind: Equatable, Sendable { case context, added, removed, hunk, plain }

  /// Position within its file, so an edit in one file never renumbers the rows of the next.
  public let id: Int
  public let kind: Kind
  public let oldLine: Int?
  public let newLine: Int?
  /// The marker is dropped: the gutter carries it instead of a character.
  public let text: String
  /// A hunk's full `@@ … @@` line, kept so the hunk can be copied as a patch.
  public var header: String? = nil
}

public struct DiffFile: Equatable, Identifiable, Sendable {
  public let path: String
  public let added: Int
  public let removed: Int
  public let rows: [DiffRow]

  public var id: String { path.isEmpty ? "__preamble__" : path }
  /// `git show` prints a message and a stat block before the first file.
  public var isPreamble: Bool { path.isEmpty }
  /// Digits in the largest line number, so the gutter fits it at any size.
  public var lineDigits: Int {
    let largest = rows.reduce(0) { max($0, $1.newLine ?? $1.oldLine ?? 0) }
    return max(2, String(largest).count)
  }

  public static func group(_ lines: [GitDiffLine]) -> [DiffFile] {
    var files: [DiffFile] = []
    var path = ""
    var headerPath: String?
    var oldPath: String?
    var oldMode: String?
    var newMode: String?
    var rows: [DiffRow] = []
    var added = 0
    var removed = 0
    var oldLine = 0
    var newLine = 0

    func append(_ kind: DiffRow.Kind, old: Int?, new: Int?, _ text: String, header: String? = nil) {
      rows.append(DiffRow(id: rows.count, kind: kind, oldLine: old, newLine: new, text: text, header: header))
    }

    func flush() {
      if path.isEmpty, let headerPath { path = headerPath }
      guard !rows.isEmpty || !path.isEmpty else { return }
      // A rename or a mode change has no hunks; say what happened instead of dropping the file.
      if rows.isEmpty {
        if let oldPath, oldPath != path { append(.plain, old: nil, new: nil, "Renamed from \(oldPath)") }
        if let oldMode, let newMode { append(.plain, old: nil, new: nil, "Mode \(oldMode) → \(newMode)") }
      }
      files.append(DiffFile(path: path, added: added, removed: removed, rows: rows))
      path = ""
      headerPath = nil
      oldPath = nil
      oldMode = nil
      newMode = nil
      rows = []
      added = 0
      removed = 0
    }

    for line in lines {
      let text = line.text
      let code = String(text.dropFirst(line.markerWidth))
      switch line.kind {
      case .fileHeader:
        if text.hasPrefix("diff ") {
          flush()
          headerPath = gitHeaderPath(text)
        } else if text.hasPrefix("+++ "), let name = patchPath(text.dropFirst(4)) {
          path = name
        } else if text.hasPrefix("--- "), let name = patchPath(text.dropFirst(4)) {
          oldPath = name
          if path.isEmpty { headerPath = name }
        } else if text.hasPrefix("rename from ") {
          oldPath = unquote(text.dropFirst(12))
        } else if text.hasPrefix("rename to ") {
          path = unquote(text.dropFirst(10))
        } else if text.hasPrefix("old mode ") {
          oldMode = String(text.dropFirst(9))
        } else if text.hasPrefix("new mode ") {
          newMode = String(text.dropFirst(9))
        }
      case .hunk:
        if path.isEmpty, let headerPath { path = headerPath }
        let (old, new) = hunkStart(text)
        oldLine = old
        newLine = new
        append(.hunk, old: nil, new: nil, hunkContext(text), header: text)
      case .added:
        added += 1
        append(.added, old: nil, new: newLine, code)
        newLine += 1
      case .removed:
        removed += 1
        append(.removed, old: oldLine, new: nil, code)
        oldLine += 1
      case .context where !(path.isEmpty && headerPath == nil):
        append(.context, old: oldLine, new: newLine, code)
        oldLine += 1
        newLine += 1
      case .note, .context:
        if path.isEmpty, let headerPath { path = headerPath }
        append(.plain, old: nil, new: nil, text)
      }
    }
    flush()
    return files.filter { !$0.rows.isEmpty }
  }

  public static func stat(_ files: [DiffFile]) -> (added: Int, removed: Int) {
    files.reduce(into: (0, 0)) { total, file in
      total.0 += file.added
      total.1 += file.removed
    }
  }

  /// The file as a patch, for the clipboard.
  public var patchText: String {
    var out = "--- a/\(path)\n+++ b/\(path)\n"
    for row in rows { out += Self.patchLine(row) + "\n" }
    return out
  }

  /// The hunk that starts at `rowID`, as a patch.
  public func hunkPatch(startingAt rowID: Int) -> String {
    guard rows.indices.contains(rowID) else { return "" }
    var out = Self.patchLine(rows[rowID]) + "\n"
    for row in rows[(rowID + 1)...] {
      if row.kind == .hunk { break }
      out += Self.patchLine(row) + "\n"
    }
    return out
  }

  private static func patchLine(_ row: DiffRow) -> String {
    switch row.kind {
    case .hunk: row.header ?? row.text
    case .added: "+" + row.text
    case .removed: "-" + row.text
    case .context: " " + row.text
    case .plain: row.text
    }
  }

  /// `diff --git a/P b/P`: the two names are the same unless the file moved, so the split is the
  /// midpoint; ` b/` alone is ambiguous once a name holds a space. A rename's real name comes
  /// later, from `rename to` or `+++`.
  static func gitHeaderPath(_ header: String) -> String? {
    let names = header.drop { $0 != " " }.dropFirst().drop { $0 != " " }.dropFirst()
    if names.first == "\"", let quoted = splitQuoted(names) { return quoted }
    // `diff --cc NAME`: a combined diff names the file once.
    guard names.hasPrefix("a/") else { return names.isEmpty ? nil : unquote(names) }
    let count = names.count
    if count >= 5, count % 2 == 1 {
      let half = (count - 1) / 2
      let left = names.prefix(half)
      let right = names.suffix(half)
      if left.hasPrefix("a/"), right.hasPrefix("b/"), left.dropFirst(2) == right.dropFirst(2),
        names.dropFirst(half).first == " " {
        return String(right.dropFirst(2))
      }
    }
    guard let range = names.range(of: " b/", options: .backwards) else { return nil }
    return String(names[range.upperBound...])
  }

  /// Both names quoted (`"a/x y" "b/x y"`): the second one is the new name.
  private static func splitQuoted(_ names: Substring) -> String? {
    guard let close = closingQuote(in: names) else { return nil }
    let rest = names[names.index(after: close)...].drop { $0 == " " }
    let name = unquote(rest.isEmpty ? names[...close] : rest)
    return name.hasPrefix("b/") ? String(name.dropFirst(2)) : name
  }

  private static func closingQuote(in quoted: Substring) -> Substring.Index? {
    var index = quoted.index(after: quoted.startIndex)
    while index < quoted.endIndex {
      if quoted[index] == "\\" { index = quoted.index(after: index) }
      else if quoted[index] == "\"" { return index }
      if index < quoted.endIndex { index = quoted.index(after: index) }
    }
    return nil
  }

  /// `--- a/x` / `+++ b/x`. Git ends a name holding a space with a tab; `/dev/null` is no name.
  private static func patchPath(_ field: Substring) -> String? {
    var name = unquote(field)
    if name.hasSuffix("\t") { name.removeLast() }
    if name == "/dev/null" { return nil }
    if name.hasPrefix("a/") || name.hasPrefix("b/") { name.removeFirst(2) }
    return name
  }

  /// Git C-quotes a name with control characters, quotes or backslashes (and non-ASCII, unless
  /// `core.quotePath` is off): `"tab\there"`, `"caf\303\251"`.
  static func unquote(_ field: Substring) -> String {
    guard field.first == "\"", field.count >= 2, field.last == "\"" else { return String(field) }
    var bytes: [UInt8] = []
    var iterator = Array(field.dropFirst().dropLast().utf8).makeIterator()
    while let byte = iterator.next() {
      guard byte == UInt8(ascii: "\\"), let escaped = iterator.next() else {
        bytes.append(byte)
        continue
      }
      switch escaped {
      case UInt8(ascii: "n"): bytes.append(0x0A)
      case UInt8(ascii: "t"): bytes.append(0x09)
      case UInt8(ascii: "r"): bytes.append(0x0D)
      case UInt8(ascii: "a"): bytes.append(0x07)
      case UInt8(ascii: "b"): bytes.append(0x08)
      case UInt8(ascii: "f"): bytes.append(0x0C)
      case UInt8(ascii: "v"): bytes.append(0x0B)
      case UInt8(ascii: "0")...UInt8(ascii: "7"):
        var value = Int(escaped - UInt8(ascii: "0"))
        for _ in 0..<2 {
          guard let digit = iterator.next() else { break }
          value = value * 8 + Int(digit - UInt8(ascii: "0"))
        }
        bytes.append(UInt8(truncatingIfNeeded: value))
      default: bytes.append(escaped)
      }
    }
    return String(decoding: bytes, as: UTF8.self)
  }

  private static func hunkStart(_ header: String) -> (old: Int, new: Int) {
    let parts = header.split(separator: " ")
    func number(_ token: Substring?) -> Int {
      guard let token else { return 1 }
      let digits = token.dropFirst().prefix { $0.isNumber }
      return Int(digits) ?? 1
    }
    // A combined diff lists one `-` range per parent; the result is the last, `+` range.
    return (number(parts.dropFirst().first { $0.hasPrefix("-") }), number(parts.first { $0.hasPrefix("+") }))
  }

  private static func hunkContext(_ header: String) -> String {
    let marker = header.prefix { $0 == "@" }
    let parts = header.components(separatedBy: String(marker))
    guard parts.count > 2 else { return "" }
    return parts[2].trimmingCharacters(in: .whitespaces)
  }
}
