import Foundation

/// A coding agent's replies are mostly prose interleaved with fenced code.
/// SwiftUI's `AttributedString(markdown:)` renders inline styles but drops code
/// blocks, so we split a message into prose and code spans and render each with
/// the treatment it deserves — prose inline, code through the console highlighter.
public enum MarkdownBlock: Equatable, Sendable {
  case prose(String)
  case code(language: String?, body: String)
}

/// Splits a message body on ``` fenced regions. Everything outside a fence is
/// prose; the word after an opening fence (```swift) is the language hint.
public func splitMarkdownBlocks(_ text: String) -> [MarkdownBlock] {
  var blocks: [MarkdownBlock] = []
  var prose: [String] = []
  var code: [String] = []
  var inCode = false
  var language: String?

  func flushProse() {
    if !prose.isEmpty {
      let joined = prose.joined(separator: "\n")
      if !joined.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        blocks.append(.prose(joined))
      }
      prose.removeAll()
    }
  }

  for line in text.components(separatedBy: "\n") {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.hasPrefix("```") {
      if inCode {
        blocks.append(.code(language: language, body: code.joined(separator: "\n")))
        code.removeAll()
        language = nil
        inCode = false
      } else {
        flushProse()
        let hint = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
        language = hint.isEmpty ? nil : hint
        inCode = true
      }
      continue
    }
    if inCode { code.append(line) } else { prose.append(line) }
  }

  // Unterminated fence: keep what we have rather than dropping it.
  if inCode { blocks.append(.code(language: language, body: code.joined(separator: "\n"))) }
  flushProse()
  return blocks
}
