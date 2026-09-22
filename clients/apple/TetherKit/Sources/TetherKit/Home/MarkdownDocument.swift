import Foundation

/// Just enough markdown for a pull-request body: the block structure. Inline
/// emphasis is left to `AttributedString(markdown:)` at render time.
public enum MarkdownBlock: Equatable, Sendable {
  case heading(level: Int, text: String)
  case paragraph(String)
  case bullets([String])
  case numbered([String])
  case code([String])
  case quote(String)
  case rule
}

public enum MarkdownDocument {
  public static func parse(_ body: String) -> [MarkdownBlock] {
    var blocks: [MarkdownBlock] = []
    var paragraph: [String] = []
    var bullets: [String] = []
    var numbered: [String] = []
    var fence: [String]?

    func flushParagraph() {
      guard !paragraph.isEmpty else { return }
      blocks.append(.paragraph(paragraph.joined(separator: " ")))
      paragraph = []
    }
    func flushLists() {
      if !bullets.isEmpty { blocks.append(.bullets(bullets)); bullets = [] }
      if !numbered.isEmpty { blocks.append(.numbered(numbered)); numbered = [] }
    }
    func flushAll() {
      flushParagraph()
      flushLists()
    }

    for raw in body.components(separatedBy: "\n") {
      let line = raw.trimmingCharacters(in: .whitespaces)

      if line.hasPrefix("```") {
        if let open = fence {
          blocks.append(.code(open))
          fence = nil
        } else {
          flushAll()
          fence = []
        }
        continue
      }
      if fence != nil {
        fence?.append(raw)
        continue
      }

      if line.isEmpty {
        flushAll()
        continue
      }
      if line == "---" || line == "***" || line == "___" {
        flushAll()
        blocks.append(.rule)
        continue
      }
      if line.hasPrefix("#") {
        flushAll()
        let level = line.prefix { $0 == "#" }.count
        blocks.append(.heading(level: min(level, 3), text: String(line.dropFirst(level)).trimmingCharacters(in: .whitespaces)))
        continue
      }
      if line.hasPrefix("> ") || line == ">" {
        flushAll()
        blocks.append(.quote(String(line.dropFirst(1)).trimmingCharacters(in: .whitespaces)))
        continue
      }
      if line.hasPrefix("- ") || line.hasPrefix("* ") {
        flushParagraph()
        bullets.append(String(line.dropFirst(2)))
        continue
      }
      if let dot = line.firstIndex(of: "."), line[line.startIndex..<dot].allSatisfy(\.isNumber),
        line.index(after: dot) < line.endIndex {
        flushParagraph()
        numbered.append(String(line[line.index(after: dot)...]).trimmingCharacters(in: .whitespaces))
        continue
      }

      flushLists()
      paragraph.append(line)
    }

    if let open = fence, !open.isEmpty { blocks.append(.code(open)) }
    flushAll()
    return blocks
  }
}
