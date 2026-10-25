import Foundation

/// A tool call's content is markdown, as ACP defines text content (the shell tool sends its output
/// as a fenced block); the raw output is the fallback when the agent sent no content.
enum ChatToolDetail {
  static let maxCodeLines = 200

  static func hasContent(text: String?, rawOutput: String?) -> Bool {
    isPresent(text) || isPresent(rawOutput)
  }

  static func blocks(text: String?, rawOutput: String?) -> [MarkdownBlock] {
    let parsed: [MarkdownBlock]
    if let text, isPresent(text) {
      parsed = MarkdownDocument.parse(text)
    } else if let rawOutput, isPresent(rawOutput) {
      parsed = [.code(rawOutput.split(separator: "\n", omittingEmptySubsequences: false).map(String.init))]
    } else {
      parsed = []
    }
    return parsed.map(capped)
  }

  private static func isPresent(_ text: String?) -> Bool {
    text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
  }

  private static func capped(_ block: MarkdownBlock) -> MarkdownBlock {
    guard case let .code(lines) = block, lines.count > maxCodeLines else { return block }
    return .code(Array(lines.prefix(maxCodeLines)) + ["\u{2026} \(lines.count - maxCodeLines) more lines"])
  }
}
