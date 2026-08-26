import Foundation

/// Pure Swift port of `apps/mobile/src/codeLanguage.ts` + a dependency-free
/// tokenizer (RN uses Prism; we approximate enough for diff bodies).

public enum CodeLanguage: String, Sendable, Hashable {
  case typescript
  case tsx
  case javascript
  case jsx
  case json
  case bash
  case markup
  case css
  case markdown
  case yaml
  case python
}

private let extensionMap: [String: CodeLanguage] = [
  "ts": .typescript,
  "tsx": .tsx,
  "js": .javascript,
  "jsx": .jsx,
  "json": .json,
  "sh": .bash,
  "bash": .bash,
  "zsh": .bash,
  "html": .markup,
  "css": .css,
  "md": .markdown,
  "yaml": .yaml,
  "yml": .yaml,
  "py": .python,
]

public func languageForPath(_ path: String) -> CodeLanguage? {
  let ext = path.lowercased().split(separator: ".").last.map(String.init) ?? ""
  return extensionMap[ext]
}

public struct HighlightToken: Equatable, Sendable {
  public var content: String
  public var types: [String]

  public init(content: String, types: [String]) {
    self.content = content
    self.types = types
  }
}

/// Tokenizes one source line independently so surrounding +/-/hunk markup
/// never corrupts the grammar. Returns `nil` when no language is known.
public func tokenizeLine(_ content: String, language: CodeLanguage?) -> [HighlightToken]? {
  guard let language else { return nil }
  return tokenize(content, language: language)
}

// MARK: - Tokenizer

private let cLikeKeywords: Set<String> = [
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for",
  "function", "if", "import", "in", "instanceof", "let", "new", "null", "return",
  "super", "switch", "this", "throw", "true", "try", "typeof", "undefined", "var",
  "void", "while", "with", "yield", "async", "await", "from", "as", "type",
  "interface", "implements", "private", "public", "protected", "readonly",
  "static", "namespace", "module", "declare", "abstract", "of",
]

private let pythonKeywords: Set<String> = [
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally", "for",
  "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not",
  "or", "pass", "raise", "return", "try", "while", "with", "yield",
]

private let bashKeywords: Set<String> = [
  "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case",
  "esac", "function", "in", "select", "until", "time", "coproc",
]

private func tokenize(_ content: String, language: CodeLanguage) -> [HighlightToken] {
  switch language {
  case .json:
    return tokenizeGeneric(content, keywords: ["true", "false", "null"], lineComment: nil)
  case .python:
    return tokenizeGeneric(content, keywords: pythonKeywords, lineComment: "#")
  case .bash:
    return tokenizeGeneric(content, keywords: bashKeywords, lineComment: "#")
  case .yaml:
    return tokenizeYaml(content)
  case .css:
    return tokenizeCss(content)
  case .markup:
    return tokenizeMarkup(content)
  case .markdown:
    return tokenizeMarkdown(content)
  case .typescript, .tsx, .javascript, .jsx:
    return tokenizeGeneric(content, keywords: cLikeKeywords, lineComment: "//")
  }
}

private func tokenizeGeneric(
  _ content: String,
  keywords: Set<String>,
  lineComment: String?
) -> [HighlightToken] {
  var tokens: [HighlightToken] = []
  let chars = Array(content)
  var i = 0

  while i < chars.count {
    let c = chars[i]

    if let lineComment,
       content[content.index(content.startIndex, offsetBy: i)...]
         .hasPrefix(lineComment)
    {
      tokens.append(HighlightToken(content: String(chars[i...]), types: ["comment"]))
      break
    }

    if c == "\"" || c == "'" || c == "`" {
      let quote = c
      var j = i + 1
      while j < chars.count {
        if chars[j] == "\\" { j += 2; continue }
        if chars[j] == quote { j += 1; break }
        j += 1
      }
      tokens.append(HighlightToken(content: String(chars[i..<min(j, chars.count)]), types: ["string"]))
      i = j
      continue
    }

    if c.isNumber {
      var j = i + 1
      while j < chars.count && (chars[j].isNumber || chars[j] == "." || chars[j] == "_") {
        j += 1
      }
      tokens.append(HighlightToken(content: String(chars[i..<j]), types: ["number"]))
      i = j
      continue
    }

    if c.isLetter || c == "_" || c == "$" {
      var j = i + 1
      while j < chars.count && (chars[j].isLetter || chars[j].isNumber || chars[j] == "_" || chars[j] == "$") {
        j += 1
      }
      let word = String(chars[i..<j])
      let types = keywords.contains(word) ? ["keyword"] : ["plain"]
      tokens.append(HighlightToken(content: word, types: types))
      i = j
      continue
    }

    if "{}[]().,;:+-*/%=<>!&|^~?".contains(c) {
      tokens.append(HighlightToken(content: String(c), types: ["punctuation"]))
      i += 1
      continue
    }

    tokens.append(HighlightToken(content: String(c), types: ["plain"]))
    i += 1
  }

  return tokens
}

private func tokenizeYaml(_ content: String) -> [HighlightToken] {
  if content.trimmingCharacters(in: .whitespaces).hasPrefix("#") {
    return [HighlightToken(content: content, types: ["comment"])]
  }
  if let colon = content.firstIndex(of: ":"),
     !content[content.startIndex..<colon].contains("\"")
  {
    let key = String(content[content.startIndex..<colon])
    let rest = String(content[colon...])
    return [
      HighlightToken(content: key, types: ["attr-name"]),
      HighlightToken(content: rest, types: ["plain"]),
    ]
  }
  return tokenizeGeneric(content, keywords: ["true", "false", "null", "yes", "no"], lineComment: "#")
}

private func tokenizeCss(_ content: String) -> [HighlightToken] {
  tokenizeGeneric(
    content,
    keywords: [
      "important", "from", "to", "and", "or", "not", "only",
    ],
    lineComment: nil
  )
}

private func tokenizeMarkup(_ content: String) -> [HighlightToken] {
  var tokens: [HighlightToken] = []
  let chars = Array(content)
  var i = 0
  while i < chars.count {
    if chars[i] == "<" {
      var j = i + 1
      while j < chars.count && chars[j] != ">" { j += 1 }
      if j < chars.count { j += 1 }
      tokens.append(HighlightToken(content: String(chars[i..<j]), types: ["tag"]))
      i = j
    } else {
      var j = i + 1
      while j < chars.count && chars[j] != "<" { j += 1 }
      tokens.append(HighlightToken(content: String(chars[i..<j]), types: ["plain"]))
      i = j
    }
  }
  return tokens
}

private func tokenizeMarkdown(_ content: String) -> [HighlightToken] {
  let trimmed = content.trimmingCharacters(in: .whitespaces)
  if trimmed.hasPrefix("#") {
    return [HighlightToken(content: content, types: ["keyword"])]
  }
  if trimmed.hasPrefix("```") || trimmed.hasPrefix("`") {
    return [HighlightToken(content: content, types: ["string"])]
  }
  return [HighlightToken(content: content, types: ["plain"])]
}
