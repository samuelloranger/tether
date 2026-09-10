import Foundation

/// A block of agent prose. `AttributedString(markdown:)` in inline-only mode
/// renders bold/italic/code spans but leaves headings and list markers as
/// literal `##` / `1.` text, so the block structure is parsed here and each
/// element rendered with its own layout — inline styling still handled per
/// element by the view.
public enum ProseElement: Equatable, Sendable {
  case heading(level: Int, text: String)
  case bullet(text: String)
  case ordered(number: Int, text: String)
  /// A GFM pipe table: the header cells and each data row's cells. Cells still
  /// carry inline markdown, rendered per-cell by the view.
  case table(header: [String], rows: [[String]])
  /// Soft-wrapped paragraph; may carry embedded `\n` for consecutive lines.
  case paragraph(text: String)
}

/// Splits a prose blob into headings, list items, and paragraphs. Consecutive
/// plain lines fold into one paragraph so wrapping and inline markdown span the
/// whole paragraph; a blank line, heading, or list item flushes it.
public func parseProse(_ text: String) -> [ProseElement] {
  var out: [ProseElement] = []
  var paragraph: [String] = []

  func flush() {
    if !paragraph.isEmpty {
      let joined = paragraph.joined(separator: "\n")
      if !joined.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        out.append(.paragraph(text: joined))
      }
      paragraph.removeAll()
    }
  }

  let lines = text.components(separatedBy: "\n")
  var i = 0
  while i < lines.count {
    let raw = lines[i]
    let line = raw.trimmingCharacters(in: .whitespaces)
    if line.isEmpty {
      flush()
      i += 1
      continue
    }
    // A pipe row followed by a `|---|---|` separator opens a GFM table; consume
    // it before the paragraph fallback so the pipes are not shown literally.
    if line.contains("|"), i + 1 < lines.count,
      isTableSeparator(lines[i + 1].trimmingCharacters(in: .whitespaces)) {
      flush()
      let header = tableCells(line)
      var rows: [[String]] = []
      i += 2
      while i < lines.count {
        let row = lines[i].trimmingCharacters(in: .whitespaces)
        guard !row.isEmpty, row.contains("|") else { break }
        rows.append(tableCells(row))
        i += 1
      }
      out.append(.table(header: header, rows: rows))
      continue
    }
    if let heading = parseHeading(line) {
      flush()
      out.append(heading)
      i += 1
      continue
    }
    if let bullet = parseBullet(line) {
      flush()
      out.append(.bullet(text: bullet))
      i += 1
      continue
    }
    if let ordered = parseOrdered(line) {
      flush()
      out.append(.ordered(number: ordered.0, text: ordered.1))
      i += 1
      continue
    }
    paragraph.append(raw)
    i += 1
  }
  flush()
  return out
}

/// Splits a pipe row into trimmed cells, dropping the optional outer pipes so
/// `| a | b |` and `a | b` both yield `["a", "b"]`.
private func tableCells(_ line: String) -> [String] {
  var body = line.trimmingCharacters(in: .whitespaces)
  if body.hasPrefix("|") { body.removeFirst() }
  if body.hasSuffix("|") { body.removeLast() }
  return body.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
}

/// The `|---|:--:|--:|` row under a table header: only pipes, dashes, colons and
/// spaces, and every cell is a run of dashes with optional alignment colons.
private func isTableSeparator(_ line: String) -> Bool {
  guard line.contains("-"), line.contains("|") else { return false }
  guard line.allSatisfy({ "|-: ".contains($0) }) else { return false }
  let cells = tableCells(line)
  guard !cells.isEmpty else { return false }
  return cells.allSatisfy { cell in
    var s = Substring(cell)
    if s.first == ":" { s = s.dropFirst() }
    if s.last == ":" { s = s.dropLast() }
    return !s.isEmpty && s.allSatisfy { $0 == "-" }
  }
}

private func parseHeading(_ line: String) -> ProseElement? {
  var level = 0
  var idx = line.startIndex
  while idx < line.endIndex, line[idx] == "#", level < 6 {
    level += 1
    idx = line.index(after: idx)
  }
  guard level > 0, idx < line.endIndex, line[idx] == " " else { return nil }
  let body = String(line[idx...]).trimmingCharacters(in: .whitespaces)
  guard !body.isEmpty else { return nil }
  return .heading(level: level, text: body)
}

private func parseBullet(_ line: String) -> String? {
  for marker in ["- ", "* ", "+ "] where line.hasPrefix(marker) {
    let body = String(line.dropFirst(marker.count)).trimmingCharacters(in: .whitespaces)
    return body.isEmpty ? nil : body
  }
  return nil
}

private func parseOrdered(_ line: String) -> (Int, String)? {
  let digits = line.prefix { $0.isNumber }
  guard !digits.isEmpty, let number = Int(digits) else { return nil }
  let rest = line[digits.endIndex...]
  guard rest.hasPrefix(". ") || rest.hasPrefix(") ") else { return nil }
  let body = String(rest.dropFirst(2)).trimmingCharacters(in: .whitespaces)
  return body.isEmpty ? nil : (number, body)
}
