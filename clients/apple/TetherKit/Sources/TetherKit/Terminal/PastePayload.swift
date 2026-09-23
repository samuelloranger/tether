/// A paste fenced in `ESC[200~`/`ESC[201~` when the program asked (DECSET 2004).
///
/// Markers inside the clipboard are stripped either way: a pasted `ESC[201~`
/// would end the fence early and run the rest as typed commands.
enum PastePayload {
  static let start = "\u{1B}[200~"
  static let end = "\u{1B}[201~"

  static func make(_ text: String, bracketed: Bool) -> String {
    let clean = text.replacingOccurrences(of: start, with: "").replacingOccurrences(of: end, with: "")
    return bracketed ? start + clean + end : clean
  }
}
