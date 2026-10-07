import Foundation
import Markdown

/// A pull-request body as GitHub renders it: GitHub-flavored markdown (tables, task lists,
/// nested lists) parsed by swift-markdown, with inline emphasis, code and links kept as
/// attributes for `Text`.
public enum MarkdownBlock: Equatable, Sendable {
  case heading(level: Int, text: AttributedString)
  case paragraph(AttributedString)
  case list([MarkdownListItem])
  case code([String])
  case quote(AttributedString)
  case table(header: [AttributedString], rows: [[AttributedString]])
  case rule
}

public struct MarkdownListItem: Equatable, Sendable {
  public enum Marker: Equatable, Sendable {
    case bullet
    case number(Int)
    case task(done: Bool)
    /// A later paragraph of the same item: indented like it, with no marker of its own.
    case continuation
  }

  public var marker: Marker
  /// 0 at the top, one more per nested list.
  public var depth: Int
  public var text: AttributedString
  /// Inside a `>` quote: drawn with the quote's bar.
  public var quoted = false
}

public enum MarkdownDocument {
  public static func parse(_ body: String) -> [MarkdownBlock] {
    var blocks: [MarkdownBlock] = []
    let document = Document(parsing: body, options: [.disableSmartOpts, .disableSourcePosOpts])
    for child in document.blockChildren {
      append(child, to: &blocks, quoted: false)
    }
    return blocks
  }

  private static func append(_ block: Markup, to blocks: inout [MarkdownBlock], quoted: Bool) {
    switch block {
    case let heading as Heading:
      blocks.append(.heading(level: min(heading.level, 3), text: inline(heading)))
    case let paragraph as Paragraph:
      let text = inline(paragraph)
      guard !text.characters.isEmpty else { return }
      blocks.append(quoted ? .quote(text) : .paragraph(text))
    case let quote as BlockQuote:
      for child in quote.blockChildren { append(child, to: &blocks, quoted: true) }
    case let code as CodeBlock:
      var lines = code.code.components(separatedBy: "\n")
      if lines.last == "" { lines.removeLast() }
      blocks.append(.code(lines))
    case let list as ListItemContainer:
      appendList(list, depth: 0, to: &blocks, quoted: quoted)
    case let table as Markdown.Table:
      blocks.append(.table(
        header: table.head.cells.map { inline($0) },
        rows: table.body.rows.map { row in row.cells.map { inline($0) } }
      ))
    case is ThematicBreak:
      blocks.append(.rule)
    case is HTMLBlock:
      return
    default:
      for child in block.children { append(child, to: &blocks, quoted: quoted) }
    }
  }

  private static func appendList(_ list: ListItemContainer, depth: Int, to blocks: inout [MarkdownBlock], quoted: Bool) {
    let start = (list as? OrderedList).map { Int($0.startIndex) }
    for (index, item) in list.listItems.enumerated() {
      var marker: MarkdownListItem.Marker =
        if let box = item.checkbox { .task(done: box == .checked) }
        else if let start { .number(start + index) }
        else { .bullet }
      for child in item.blockChildren {
        switch child {
        case let nested as ListItemContainer:
          appendList(nested, depth: depth + 1, to: &blocks, quoted: quoted)
        case let paragraph as Paragraph:
          let row = MarkdownListItem(marker: marker, depth: depth, text: inline(paragraph), quoted: quoted)
          if case let .list(rows) = blocks.last {
            blocks[blocks.count - 1] = .list(rows + [row])
          } else {
            blocks.append(.list([row]))
          }
          marker = .continuation
        default:
          append(child, to: &blocks, quoted: quoted)
        }
      }
    }
  }

  // MARK: Inline

  static func inline(_ markup: Markup) -> AttributedString {
    markup.children.reduce(into: AttributedString()) { $0 += render($1, inLink: false) }
  }

  private static func render(_ markup: Markup, inLink: Bool) -> AttributedString {
    func children(inLink: Bool = inLink) -> AttributedString {
      markup.children.reduce(into: AttributedString()) { $0 += render($1, inLink: inLink) }
    }
    switch markup {
    case let text as Markdown.Text:
      return inLink ? AttributedString(text.string) : linkingBareURLs(text.string)
    case let code as InlineCode:
      var out = AttributedString(code.code)
      out.inlinePresentationIntent = .code
      return out
    case is Emphasis:
      return adding(.emphasized, to: children())
    case is Strong:
      return adding(.stronglyEmphasized, to: children())
    case is Strikethrough:
      return adding(.strikethrough, to: children())
    case let link as Markdown.Link:
      var out = children(inLink: true)
      if let url = link.destination.flatMap(openableURL) { out.link = url }
      return out
    case let image as Markdown.Image:
      return AttributedString(image.plainText)
    case is SoftBreak:
      return AttributedString(" ")
    case is LineBreak:
      return AttributedString("\n")
    case is InlineHTML:
      return AttributedString()
    case let plain as PlainTextConvertibleMarkup:
      return AttributedString(plain.plainText)
    default:
      return children()
    }
  }

  private static func adding(_ intent: InlinePresentationIntent, to text: AttributedString) -> AttributedString {
    var out = text
    for run in out.runs {
      out[run.range].inlinePresentationIntent = (run.inlinePresentationIntent ?? []).union(intent)
    }
    return out
  }

  /// Only links the app would open anywhere else: no `javascript:`, `file:` or relative paths.
  static func openableURL(_ string: String) -> URL? {
    let lower = string.lowercased()
    guard lower.hasPrefix("http://") || lower.hasPrefix("https://") || lower.hasPrefix("mailto:") else { return nil }
    return URL(string: string)
  }

  private static let bareURL = try! NSRegularExpression(pattern: #"(?<![\w/])https?://[^\s<>]+"#, options: [.caseInsensitive])

  /// GitHub links URLs written as plain text; cmark leaves them as text.
  private static func linkingBareURLs(_ string: String) -> AttributedString {
    var out = AttributedString()
    var cursor = string.startIndex
    for match in bareURL.matches(in: string, range: NSRange(string.startIndex..., in: string)) {
      guard let range = Range(match.range, in: string) else { continue }
      var raw = string[range]
      while let last = raw.last, ".,;:)!?".contains(last) { raw = raw.dropLast() }
      out += AttributedString(string[cursor..<raw.startIndex])
      var link = AttributedString(raw)
      link.link = openableURL(String(raw))
      out += link
      cursor = raw.endIndex
    }
    out += AttributedString(string[cursor...])
    return out
  }
}
