import Foundation

/// Word extraction for double-tap-to-select — port of `apps/mobile/src/wordAt.ts`.
///
/// "Word" is shell-flavored: paths, flags, URLs, identifiers.
public enum WordAt {
  private static let wordCharacters = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_@$%+=:~./-"
  )

  public static func isWordCharacter(_ ch: Character) -> Bool {
    guard let scalar = ch.unicodeScalars.first, ch.unicodeScalars.count == 1 else {
      return false
    }
    return wordCharacters.contains(scalar)
  }

  public static func word(atColumn col: Int, in text: String) -> String? {
    guard col >= 0 else { return nil }
    let chars = Array(text)
    guard col < chars.count else { return nil }
    guard isWordCharacter(chars[col]) else { return nil }
    var start = col
    while start > 0, isWordCharacter(chars[start - 1]) {
      start -= 1
    }
    var end = col + 1
    while end < chars.count, isWordCharacter(chars[end]) {
      end += 1
    }
    let word = String(chars[start..<end])
    let trimmed = word.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : word
  }

  /// Inclusive start/end column bounds of the word under `col`, if any.
  public static func bounds(atColumn col: Int, in text: String) -> (start: Int, end: Int)? {
    guard word(atColumn: col, in: text) != nil else { return nil }
    let chars = Array(text)
    var start = col
    while start > 0, isWordCharacter(chars[start - 1]) {
      start -= 1
    }
    var end = col
    while end + 1 < chars.count, isWordCharacter(chars[end + 1]) {
      end += 1
    }
    return (start, end)
  }
}
