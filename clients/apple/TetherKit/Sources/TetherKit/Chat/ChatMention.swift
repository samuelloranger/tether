import Foundation

/// `@file` mentions in the composer: finding the token under the cursor, ranking the host's files
/// against it and writing the pick back. Plain `@path` text is what the agent resolves itself.
enum ChatMention {
  /// `range` covers the whole word, `@` included, in Character offsets; `query` is what was typed
  /// between the `@` and the cursor.
  struct Token: Equatable {
    var range: Range<Int>
    var query: String
  }

  /// The `@word` the cursor sits in or right after. `@` only counts at the start of a word, so an
  /// address like `me@host` never opens the palette. A nil cursor means the end of the text.
  static func token(in text: String, cursor: Int?) -> Token? {
    let chars = Array(text)
    let caret = min(max(cursor ?? chars.count, 0), chars.count)
    var start = caret
    while start > 0, !chars[start - 1].isWhitespace { start -= 1 }
    guard start < caret, chars[start] == "@" else { return nil }
    let typed = chars[(start + 1)..<caret]
    guard !typed.contains("@") else { return nil }
    var end = caret
    while end < chars.count, !chars[end].isWhitespace { end += 1 }
    return Token(range: start..<end, query: String(typed))
  }

  struct Match: Equatable, Identifiable {
    var path: String
    var id: String { path }

    var name: String { path.split(separator: "/").last.map(String.init) ?? path }
    /// The folder with its trailing slash, or empty for a file at the top.
    var folder: String { String(path.dropLast(name.count)) }
  }

  /// Case-insensitive subsequence match. A match in the file name ranks first (prefix, then
  /// contains, then scattered), a match only across the path last; then shorter paths, then the
  /// order the host listed them. An empty query lists the first entries as listed.
  static func matches(query: String, files: [String], limit: Int = 60) -> [Match] {
    let cap = max(limit, 0)
    let needle = Array(query.lowercased())
    guard !needle.isEmpty else { return files.prefix(cap).map(Match.init) }
    var scored: [(tier: Int, length: Int, index: Int, path: String)] = []
    for (index, path) in files.enumerated() {
      let lower = path.lowercased()
      guard isSubsequence(needle, of: lower) else { continue }
      let name = (lower.split(separator: "/").last).map(String.init) ?? lower
      let tier: Int
      if name.hasPrefix(String(needle)) {
        tier = 0
      } else if name.contains(String(needle)) {
        tier = 1
      } else if isSubsequence(needle, of: name) {
        tier = 2
      } else {
        tier = 3
      }
      scored.append((tier, path.count, index, path))
    }
    scored.sort { ($0.tier, $0.length, $0.index) < ($1.tier, $1.length, $1.index) }
    return scored.prefix(cap).map { Match(path: $0.path) }
  }

  private static func isSubsequence(_ needle: [Character], of haystack: String) -> Bool {
    var next = needle.startIndex
    for character in haystack where next < needle.endIndex && character == needle[next] { next += 1 }
    return next == needle.endIndex
  }

  /// The text with the token replaced by `@path` and a space, and the cursor just after it. A space
  /// already following the token is reused rather than doubled.
  static func insertion(in text: String, token: Token, path: String) -> (text: String, cursor: Int) {
    var chars = Array(text)
    let range = min(token.range.lowerBound, chars.count)..<min(token.range.upperBound, chars.count)
    let followedBySpace = range.upperBound < chars.count && chars[range.upperBound].isWhitespace
    let replacement = Array("@" + path + (followedBySpace ? "" : " "))
    chars.replaceSubrange(range, with: replacement)
    return (String(chars), range.lowerBound + replacement.count + (followedBySpace ? 1 : 0))
  }
}

/// The host's file list for the palette, from one exec in the chat's folder.
enum ChatFileList {
  static let maxFiles = 3000
  static let maxOutputBytes = 512 * 1024
  /// Past this the list is refetched when the palette opens.
  static let freshFor: TimeInterval = 60

  /// A POSIX script run through `sh -c`, so the host's login shell (fish treats `( )` as a command
  /// substitution) does not matter. Git's own list, else every plain file outside `.git` and `node_modules`.
  static func command(cwd: String) -> String {
    let script =
      "cd \(shellQuote(cwd)) && (git ls-files -co --exclude-standard 2>/dev/null || "
      + "find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' | sed 's|^\\./||') | head -\(maxFiles)"
    return "sh -c \(shellQuote(script))"
  }

  /// Relative paths only; a name with whitespace or a control character cannot be written as plain `@path`.
  static func parse(_ output: String) -> [String] {
    var seen = Set<String>()
    var files: [String] = []
    for raw in output.prefix(maxOutputBytes).split(whereSeparator: \.isNewline) {
      let path = String(raw)
      guard !path.isEmpty, !path.hasPrefix("/"), !path.hasPrefix("../"), !path.contains("/../"),
        !path.unicodeScalars.contains(where: { $0.properties.isWhitespace || CharacterSet.controlCharacters.contains($0) }),
        seen.insert(path).inserted
      else { continue }
      files.append(path)
      if files.count >= maxFiles { break }
    }
    return files
  }
}

/// One chat's cached file list.
struct ChatFileIndex: Equatable {
  private(set) var files: [String] = []
  private(set) var loadedAt: Date?

  mutating func store(_ files: [String], at now: Date) {
    self.files = files
    loadedAt = now
  }

  func isStale(at now: Date) -> Bool {
    guard let loadedAt else { return true }
    return now.timeIntervalSince(loadedAt) > ChatFileList.freshFor
  }
}
