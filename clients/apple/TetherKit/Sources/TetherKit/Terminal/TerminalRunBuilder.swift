import Foundation

/// Collapses one grid row into the fewest draw operations that still reproduce
/// it: one fill per stretch of equal background, one glyph run per stretch that
/// shares a foreground colour and style.
///
/// The renderer used to pay a `CGContext.fill` and a freshly shaped `CTLine`
/// for every cell — ~3200 of each on an 80x40 grid, every frame, on the main
/// thread. Grouping first is what makes the per-frame cost proportional to how
/// much the row actually varies rather than to how wide it is.
///
/// Pure on purpose: CoreText and the bitmap context are untestable, and the
/// off-by-one bugs all live in the splitting.
public enum TerminalRunBuilder {
  /// Style bits that force a new glyph run. Inverse is resolved away before
  /// grouping, so it is deliberately absent.
  public static let styleMask: UInt32 =
    GridSnapshot.attrBold | GridSnapshot.attrItalic | GridSnapshot.attrUnderline
    | GridSnapshot.attrDim | GridSnapshot.attrStrikethrough

  public struct BackgroundSpan: Equatable, Sendable {
    public var startCol: Int
    public var length: Int
    public var color: UInt32

    public init(startCol: Int, length: Int, color: UInt32) {
      self.startCol = startCol
      self.length = length
      self.color = color
    }
  }

  public struct GlyphRun: Equatable, Sendable {
    public var startCol: Int
    public var codepoints: [UInt32]
    public var color: UInt32
    public var style: UInt32

    public init(startCol: Int, codepoints: [UInt32], color: UInt32, style: UInt32) {
      self.startCol = startCol
      self.codepoints = codepoints
      self.color = color
      self.style = style
    }
  }

  /// Foreground/background with SGR 7 already applied, so nothing downstream
  /// has to remember to swap.
  public static func resolved(_ cell: GridSnapshot.Cell) -> (fg: UInt32, bg: UInt32) {
    if cell.attrs & GridSnapshot.attrInverse != 0 {
      return (cell.background, cell.foreground)
    }
    return (cell.foreground, cell.background)
  }

  /// A cell with nothing to draw: NUL from an untouched grid, or a space.
  public static func isBlank(_ cell: GridSnapshot.Cell) -> Bool {
    cell.codepoint == 0 || cell.codepoint == 0x20
  }

  public static func backgrounds(
    cells: [GridSnapshot.Cell],
    rowStart: Int,
    cols: Int
  ) -> [BackgroundSpan] {
    guard cols > 0, rowStart >= 0, rowStart + cols <= cells.count else { return [] }
    var spans: [BackgroundSpan] = []
    var runStart = 0
    var runColor = resolved(cells[rowStart]).bg
    for col in 1..<cols {
      let color = resolved(cells[rowStart + col]).bg
      if color == runColor { continue }
      spans.append(BackgroundSpan(startCol: runStart, length: col - runStart, color: runColor))
      runStart = col
      runColor = color
    }
    spans.append(BackgroundSpan(startCol: runStart, length: cols - runStart, color: runColor))
    return spans
  }

  public static func glyphRuns(
    cells: [GridSnapshot.Cell],
    rowStart: Int,
    cols: Int
  ) -> [GlyphRun] {
    guard cols > 0, rowStart >= 0, rowStart + cols <= cells.count else { return [] }
    var runs: [GlyphRun] = []
    var current: GlyphRun?
    for col in 0..<cols {
      let cell = cells[rowStart + col]
      if isBlank(cell) {
        if let run = current {
          runs.append(run)
          current = nil
        }
        continue
      }
      let fg = resolved(cell).fg
      let style = cell.attrs & styleMask
      if var run = current, run.color == fg, run.style == style,
        run.startCol + run.codepoints.count == col
      {
        run.codepoints.append(cell.codepoint)
        current = run
      } else {
        if let run = current { runs.append(run) }
        current = GlyphRun(startCol: col, codepoints: [cell.codepoint], color: fg, style: style)
      }
    }
    if let run = current { runs.append(run) }
    return runs
  }

  /// Plain text of one row with trailing blanks trimmed — the input to link
  /// detection and to selection copying.
  public static func rowText(
    cells: [GridSnapshot.Cell],
    rowStart: Int,
    cols: Int
  ) -> String {
    guard cols > 0, rowStart >= 0, rowStart + cols <= cells.count else { return "" }
    var line = ""
    line.reserveCapacity(cols)
    for col in 0..<cols {
      let cp = cells[rowStart + col].codepoint
      if cp == 0 {
        line.append(" ")
      } else if let scalar = Unicode.Scalar(cp) {
        line.append(Character(scalar))
      } else {
        line.append(" ")
      }
    }
    while line.last == " " { line.removeLast() }
    return line
  }

  public static func rowTexts(
    cells: [GridSnapshot.Cell],
    cols: Int,
    rows: Int
  ) -> [String] {
    guard cols > 0, rows > 0 else { return [] }
    var out: [String] = []
    out.reserveCapacity(rows)
    for row in 0..<rows {
      out.append(rowText(cells: cells, rowStart: row * cols, cols: cols))
    }
    return out
  }
}
