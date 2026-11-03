import SwiftUI
import UIKit

extension NSAttributedString.Key {
  static let chatCode = NSAttributedString.Key("TetherChatCode")
}

enum ChatSelectionCopy {
  static func text(_ text: NSAttributedString, range: NSRange) -> String {
    let range = NSIntersectionRange(range, NSRange(location: 0, length: text.length))
    guard range.length > 0 else { return "" }
    let selected = text.attributedSubstring(from: range)
    var out = ""
    selected.enumerateAttribute(.chatCode, in: NSRange(location: 0, length: selected.length)) { code, span, _ in
      let part = (selected.string as NSString).substring(with: span)
      out += code as? Bool == true ? part : part.replacingOccurrences(of: #"[\t ]*[\r\n\u2028\u2029]+[\t ]*"#, with: " ", options: .regularExpression)
    }
    return out
  }
}

/// One native text view keeps selection continuous across markdown blocks.
struct ChatSelectableText: UIViewRepresentable {
  var blocks: [MarkdownBlock]
  var reading = true
  var selectable = true
  var plain: String?
  var message: String?
  var branch: (() -> Void)?
  var diff: [DiffRow]?
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  init(_ text: String, selectable: Bool = true, branch: (() -> Void)? = nil) {
    blocks = []
    plain = text
    self.selectable = selectable
    self.branch = branch
  }

  init(blocks: [MarkdownBlock], reading: Bool = true, selectable: Bool = true, message: String? = nil) {
    self.blocks = blocks
    self.reading = reading
    self.selectable = selectable
    self.message = message
  }

  init(diff: [DiffRow], selectable: Bool = true) {
    blocks = []
    self.diff = diff
    self.selectable = selectable
    reading = false
  }

  func makeUIView(context: Context) -> ChatSelectionTextView {
    let view = ChatSelectionTextView()
    view.isEditable = false
    view.delegate = view
    view.isScrollEnabled = false
    view.backgroundColor = .clear
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return view
  }

  func updateUIView(_ view: ChatSelectionTextView, context: Context) {
    let text = attributedText()
    if view.attributedText != text { view.attributedText = text }
    view.isSelectable = selectable
    view.message = message ?? plain
    view.branch = branch
    view.tintColor = UIColor(TetherColors.accent)
    view.linkTextAttributes = [.foregroundColor: UIColor(TetherColors.accent)]
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView: ChatSelectionTextView, context: Context) -> CGSize? {
    guard let width = proposal.width, width > 0 else { return nil }
    let measured = uiView.attributedText.boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
    let fittingWidth = plain == nil ? width : min(width, max(1, ceil(measured.width)))
    let size = uiView.sizeThatFits(CGSize(width: fittingWidth, height: .greatestFiniteMagnitude))
    return CGSize(width: fittingWidth, height: ceil(size.height))
  }

  func attributedText() -> NSAttributedString {
    let font = UIFont.preferredFont(forTextStyle: reading ? .subheadline : .footnote)
    let ink = UIColor(reading ? TetherColors.textPrimary : TetherColors.textSecondary)
    let out = NSMutableAttributedString(string: "")
    func append(_ text: AttributedString, font: UIFont = font, color: UIColor = ink, code: Bool = false) {
      let part = NSMutableAttributedString(string: String(text.characters), attributes: [.font: font, .foregroundColor: color])
      var offset = 0
      for run in text.runs {
        let length = String(text[run.range].characters).utf16.count
        let range = NSRange(location: offset, length: length)
        let intent = run.inlinePresentationIntent ?? []
        var face = intent.contains(.code) ? UIFont.monospacedSystemFont(ofSize: font.pointSize, weight: .regular) : font
        var traits = face.fontDescriptor.symbolicTraits
        if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
        if intent.contains(.emphasized) { traits.insert(.traitItalic) }
        if let descriptor = face.fontDescriptor.withSymbolicTraits(traits) { face = UIFont(descriptor: descriptor, size: face.pointSize) }
        part.addAttribute(.font, value: face, range: range)
        if intent.contains(.strikethrough) { part.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: range) }
        if intent.contains(.code) { part.addAttribute(.backgroundColor, value: UIColor(TetherColors.surfaceRaised), range: range) }
        if let link = run.link { part.addAttribute(.link, value: link, range: range) }
        offset += length
      }
      let paragraph = NSMutableParagraphStyle()
      paragraph.paragraphSpacing = reading ? 9 : 6
      paragraph.lineSpacing = code ? 0 : 2
      part.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: part.length))
      if code {
        part.addAttributes([.chatCode: true, .backgroundColor: UIColor(TetherColors.input)], range: NSRange(location: 0, length: part.length))
      }
      out.append(part)
    }
    if let plain {
      append(AttributedString(plain))
      return out
    }
    if let diff {
      for (index, row) in diff.enumerated() {
        let marker = row.kind == .added ? "+ " : row.kind == .removed ? "− " : "  "
        let text = row.kind == .hunk ? (row.text.isEmpty ? "⋯" : row.text) : marker + row.text
        let color = row.kind == .added ? TetherColors.success : row.kind == .removed ? TetherColors.danger : TetherColors.textSecondary
        append(AttributedString((index > 0 ? "\n" : "") + text),
          font: .monospacedSystemFont(ofSize: font.pointSize - 1, weight: .regular), color: UIColor(color), code: true)
      }
      return out
    }
    for (index, block) in blocks.enumerated() {
      if index > 0 {
        // Boundaries touching code remain newlines so a mixed selection still contains usable code.
        let code: Bool = { if case .code = block { return true }; if case .code = blocks[index - 1] { return true }; return false }()
        out.append(NSAttributedString(string: "\n", attributes: [.font: font, .chatCode: code]))
      }
      switch block {
      case let .heading(level, text):
        append(text, font: .preferredFont(forTextStyle: level == 1 ? .headline : .subheadline).withTraits(.traitBold))
      case let .paragraph(text): append(text)
      case let .quote(text): append(text, font: font.withTraits(.traitItalic), color: UIColor(TetherColors.textFaint))
      case let .code(lines):
        append(AttributedString(lines.joined(separator: "\n")), font: .monospacedSystemFont(ofSize: font.pointSize - 1, weight: .regular), code: true)
      case let .list(items):
        for (n, item) in items.enumerated() {
          if n > 0 { append(AttributedString("\n")) }
          let marker: String = switch item.marker {
          case .bullet: "• "
          case let .number(number): "\(number). "
          case let .task(done): done ? "☑ " : "☐ "
          case .continuation: ""
          }
          append(AttributedString(String(repeating: "  ", count: item.depth) + marker) + item.text)
        }
      case let .table(header, rows):
        for (n, row) in ([header] + rows).enumerated() {
          if n > 0 { append(AttributedString("\n")) }
          append(row.reduce(into: AttributedString()) { result, cell in
            if !result.characters.isEmpty { result += AttributedString("\t") }
            result += cell
          }, font: .monospacedSystemFont(ofSize: font.pointSize - 1, weight: n == 0 ? .semibold : .regular))
        }
      case .rule: append(AttributedString("────────"), color: UIColor(TetherColors.border))
      }
    }
    return out
  }
}

private extension UIFont {
  func withTraits(_ traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
    guard let descriptor = fontDescriptor.withSymbolicTraits(traits) else { return self }
    return UIFont(descriptor: descriptor, size: pointSize)
  }
}

final class ChatSelectionTextView: UITextView, UITextViewDelegate {
  var message: String?
  var branch: (() -> Void)?
  var writeClipboard: (String) -> Void = { UIPasteboard.general.string = $0 }

  override func copy(_ sender: Any?) {
    guard selectedRange.length > 0 else { return }
    writeClipboard(ChatSelectionCopy.text(attributedText, range: selectedRange))
  }

  func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
    var actions = suggestedActions
    actions.append(UIAction(title: "Copy message", image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in
      guard let self else { return }
      writeClipboard(message ?? ChatSelectionCopy.text(attributedText, range: NSRange(location: 0, length: attributedText.length)))
    })
    if let branch {
      actions.append(UIAction(title: "Branch & edit…", image: UIImage(systemName: "arrow.triangle.branch")) { _ in branch() })
    }
    return UIMenu(children: actions)
  }
}
