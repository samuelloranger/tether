import Foundation

/// A tool call's content is markdown, as ACP defines text content (the shell tool sends its output
/// as a fenced block); the raw output is the fallback when the agent sent no content.
enum ChatToolDetail {
  static let maxCodeLines = 200
  /// A longer line is cut: a minified file or a data dump must not be laid out whole.
  static let maxLineCharacters = 2_000
  static let maxCharacters = 100_000
  /// A run of base64 alphabet this long is an encoded blob, not text anyone reads.
  static let blobRun = 1_500

  static func hasContent(text: String?, rawOutput: String?) -> Bool {
    isPresent(text) || isPresent(rawOutput)
  }

  static func blocks(text: String?, rawOutput: String?) -> [MarkdownBlock] {
    let parsed: [MarkdownBlock]
    if let text, isPresent(text) {
      parsed = MarkdownDocument.parse(bounded(text))
    } else if let rawOutput, isPresent(rawOutput) {
      parsed = [.code(bounded(rawOutput).split(separator: "\n", omittingEmptySubsequences: false).map(String.init))]
    } else {
      parsed = []
    }
    return parsed.map(capped)
  }

  /// True for an image result dumped as JSON text, or any text carrying a long base64 run.
  static func looksLikeBlob(_ text: String) -> Bool {
    if let first = text.utf8.first, first == 0x5B || first == 0x7B,
      text.contains("\"type\":\"image\"") || text.contains("\"type\": \"image\"")
    {
      return true
    }
    var run = 0
    for byte in text.utf8 {
      switch byte {
      case 0x41...0x5A, 0x61...0x7A, 0x30...0x39, 0x2B, 0x2F, 0x3D:
        run += 1
        if run >= blobRun { return true }
      default:
        run = 0
      }
    }
    return false
  }

  private static func isPresent(_ text: String?) -> Bool {
    guard let text, !looksLikeBlob(text) else { return false }
    return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private static func bounded(_ text: String) -> String {
    text.count > maxCharacters ? String(text.prefix(maxCharacters)) + "\n\u{2026}" : text
  }

  private static func capped(_ block: MarkdownBlock) -> MarkdownBlock {
    guard case let .code(all) = block else { return block }
    let lines = all.map { $0.count > maxLineCharacters ? String($0.prefix(maxLineCharacters)) + "\u{2026}" : $0 }
    guard lines.count > maxCodeLines else { return .code(lines) }
    return .code(Array(lines.prefix(maxCodeLines)) + ["\u{2026} \(lines.count - maxCodeLines) more lines"])
  }
}
