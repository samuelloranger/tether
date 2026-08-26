import SwiftUI

/// Maps Prism-style token type names onto `TetherColors` (no invented palette).
public func colorForTokenTypes(_ types: [String]) -> Color? {
  if types.contains(where: {
    ["comment", "prolog", "doctype", "cdata"].contains($0)
  }) {
    return TetherColors.textSecondary
  }
  if types.contains(where: {
    ["property", "tag", "constant", "symbol", "deleted", "attr-name"].contains($0)
  }) {
    return TetherColors.danger
  }
  if types.contains(where: { ["boolean", "number", "regex", "important", "variable"].contains($0) }) {
    return TetherColors.accent
  }
  if types.contains(where: {
    ["selector", "string", "char", "builtin", "inserted"].contains($0)
  }) {
    return Color.green.opacity(0.9)
  }
  if types.contains(where: {
    ["operator", "entity", "url", "function", "class-name", "atrule", "attr-value", "keyword"]
      .contains($0)
  }) {
    return TetherColors.accent
  }
  if types.contains("punctuation") {
    return TetherColors.textPrimary
  }
  return nil
}

/// Highlighted monospace run for one source line.
public struct HighlightedCodeText: View {
  public var content: String
  public var language: CodeLanguage?

  public init(content: String, language: CodeLanguage?) {
    self.content = content
    self.language = language
  }

  public var body: some View {
    Group {
      if let tokens = tokenizeLine(content, language: language) {
        tokens.reduce(Text("")) { partial, token in
          let color = colorForTokenTypes(token.types) ?? TetherColors.textPrimary
          return partial + Text(token.content).foregroundColor(color)
        }
      } else {
        Text(content.isEmpty ? " " : content)
          .foregroundStyle(TetherColors.textPrimary)
      }
    }
  }
}
