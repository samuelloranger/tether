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

  for raw in text.components(separatedBy: "\n") {
    let line = raw.trimmingCharacters(in: .whitespaces)
    if line.isEmpty {
      flush()
      continue
    }
    if let heading = parseHeading(line) {
      flush()
      out.append(heading)
      continue
    }
    if let bullet = parseBullet(line) {
      flush()
      out.append(.bullet(text: bullet))
      continue
    }
    if let ordered = parseOrdered(line) {
      flush()
      out.append(.ordered(number: ordered.0, text: ordered.1))
      continue
    }
    paragraph.append(raw)
  }
  flush()
  return out
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
