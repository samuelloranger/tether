import Foundation

/// Inclusive grid selection range for the CoreText surface.
public struct TerminalSelection: Equatable, Sendable {
  public var startRow: Int
  public var startCol: Int
  public var endRow: Int
  public var endCol: Int

  public init(startRow: Int, startCol: Int, endRow: Int, endCol: Int) {
    self.startRow = startRow
    self.startCol = startCol
    self.endRow = endRow
    self.endCol = endCol
  }

  public var normalized: TerminalSelection {
    if startRow < endRow || (startRow == endRow && startCol <= endCol) {
      return self
    }
    return TerminalSelection(
      startRow: endRow, startCol: endCol, endRow: startRow, endCol: startCol
    )
  }

  public func contains(row: Int, col: Int) -> Bool {
    let n = normalized
    if row < n.startRow || row > n.endRow { return false }
    if n.startRow == n.endRow {
      return col >= n.startCol && col <= n.endCol
    }
    if row == n.startRow { return col >= n.startCol }
    if row == n.endRow { return col <= n.endCol }
    return true
  }

  /// Extracts selected text from packed row strings (one String per grid row).
  public func text(from rows: [String]) -> String {
    let n = normalized
    guard !rows.isEmpty else { return "" }
    var lines: [String] = []
    for row in n.startRow...n.endRow {
      guard row >= 0, row < rows.count else { continue }
      let line = rows[row]
      let chars = Array(line)
      let start: Int
      let end: Int
      if n.startRow == n.endRow {
        start = max(0, n.startCol)
        end = min(chars.count - 1, n.endCol)
      } else if row == n.startRow {
        start = max(0, n.startCol)
        end = chars.count - 1
      } else if row == n.endRow {
        start = 0
        end = min(chars.count - 1, n.endCol)
      } else {
        start = 0
        end = chars.count - 1
      }
      if start <= end, start < chars.count {
        lines.append(String(chars[start...end]))
      } else {
        lines.append("")
      }
    }
    return lines.joined(separator: "\n")
  }
}
