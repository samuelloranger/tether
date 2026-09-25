import Foundation

/// A macro key's text, with escapes for the bytes a phone keyboard can't type.
///
/// `\r` and `\n` send Return (terminals expect CR), `\t` Tab, `\e` Esc, `\cX` Ctrl-X (`\c?` DEL),
/// `\xHH` one ASCII byte, `\\` a backslash. Anything else after a backslash is kept as typed.
enum MacroText {
  static func bytes(from text: String) -> String {
    var out = ""
    var chars = Array(text)[...]
    while let ch = chars.popFirst() {
      guard ch == "\\", let next = chars.first else {
        out.append(ch)
        continue
      }
      switch next {
      case "r", "n":
        out.append("\r"); chars.removeFirst()
      case "t":
        out.append("\t"); chars.removeFirst()
      case "e":
        out.append("\u{1B}"); chars.removeFirst()
      case "\\":
        out.append("\\"); chars.removeFirst()
      case "c":
        let target = chars.dropFirst().first.map(String.init)
        // Ctrl-? is DEL by convention; masking would give 0x1F.
        if target == "?" {
          out.append("\u{7F}")
          chars.removeFirst(2)
        } else if let target, let control = TerminalKeyMap.ctrlFolded(target) {
          out.append(control)
          chars.removeFirst(2)
        } else {
          out.append(ch)
        }
      case "x":
        let digits = String(chars.dropFirst().prefix(2))
        if digits.count == 2, let value = UInt8(digits, radix: 16), value < 0x80 {
          out.append(Character(UnicodeScalar(value)))
          chars.removeFirst(3)
        } else {
          out.append(ch)
        }
      default:
        out.append(ch)
      }
    }
    return out
  }

  /// The bytes with control characters made visible, for the editor.
  static func visible(_ bytes: String) -> String {
    bytes.unicodeScalars.map { scalar -> String in
      switch scalar.value {
      case 0x0D: "⏎"
      case 0x09: "⇥"
      case 0x1B: "⎋"
      case 0x7F: "^?"
      case 0x00..<0x20: "^" + String(UnicodeScalar(UInt8(scalar.value) + 0x40))
      default: String(scalar)
      }
    }.joined()
  }
}
