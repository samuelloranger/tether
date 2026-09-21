import Foundation

/// Flattens a decoded grid snapshot into plain text for the clipboard.
enum TerminalGridText {
  /// One line per row, trailing blank rows dropped. `codepoint == 0` is an
  /// unwritten cell or the spacer after a wide glyph, so it is skipped — real
  /// spaces are U+0020. A row's trailing spaces are trimmed.
  static func plainText(header: GridSnapshot.Header, cells: [GridSnapshot.Cell]) -> String {
    let cols = Int(header.cols)
    let rows = Int(header.rows)
    guard cols > 0, rows > 0, cells.count >= cols * rows else { return "" }

    var lines: [String] = []
    for row in 0..<rows {
      var line = ""
      for col in 0..<cols {
        let cp = cells[row * cols + col].codepoint
        guard cp != 0, let scalar = Unicode.Scalar(cp) else { continue }
        line.unicodeScalars.append(scalar)
      }
      while line.last == " " { line.removeLast() }
      lines.append(line)
    }
    while lines.last == "" { lines.removeLast() }
    return lines.joined(separator: "\n")
  }
}
