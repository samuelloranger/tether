import Foundation

/// One fill per stretch of equal background, one glyph run per stretch of shared fg and style.
/// Pure on purpose: CoreText is untestable, and the off-by-one bugs all live in the splitting.
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

  /// A cell with no glyph to draw: NUL from an untouched grid, a space, or concealed text.
  public static func isBlank(_ cell: GridSnapshot.Cell) -> Bool {
    cell.codepoint == 0 || cell.codepoint == 0x20 || cell.attrs & GridSnapshot.attrHidden != 0
  }

  /// An underline or strikethrough over a stretch of cells. Built from attributes, not glyph
  /// runs, so it carries across spaces the way a terminal underlines a whole span.
  public struct DecorationSpan: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
      case underline(GridSnapshot.UnderlineStyle)
      case strikethrough
    }

    public var startCol: Int
    public var length: Int
    public var color: UInt32
    public var kind: Kind
  }

  public static func decorations(
    cells: [GridSnapshot.Cell],
    rowStart: Int,
    cols: Int
  ) -> [DecorationSpan] {
    guard cols > 0, rowStart >= 0, rowStart + cols <= cells.count else { return [] }
    var spans: [DecorationSpan] = []
    var underline: DecorationSpan?
    var strike: DecorationSpan?
    func extend(_ span: inout DecorationSpan?, with next: DecorationSpan?, at col: Int) {
      if let current = span, let next, current.kind == next.kind, current.color == next.color,
        current.startCol + current.length == col {
        span?.length += 1
        return
      }
      if let current = span { spans.append(current) }
      span = next
    }
    for col in 0..<cols {
      let cell = cells[rowStart + col]
      let hidden = cell.attrs & GridSnapshot.attrHidden != 0
      let fg = resolved(cell).fg
      let style = hidden ? nil : GridSnapshot.underlineStyle(cell.attrs)
      extend(&underline, with: style.map {
        DecorationSpan(startCol: col, length: 1, color: cell.underlineColor != 0 ? cell.underlineColor : fg, kind: .underline($0))
      }, at: col)
      let struck = !hidden && cell.attrs & GridSnapshot.attrStrikethrough != 0
      extend(&strike, with: struck ? DecorationSpan(startCol: col, length: 1, color: fg, kind: .strikethrough) : nil, at: col)
    }
    if let underline { spans.append(underline) }
    if let strike { spans.append(strike) }
    return spans
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
    cols: Int,
    clusters: [Int: String] = [:]
  ) -> String {
    guard cols > 0, rowStart >= 0, rowStart + cols <= cells.count else { return "" }
    var line = ""
    line.reserveCapacity(cols)
    for col in 0..<cols {
      let cell = cells[rowStart + col]
      // A wide glyph's second cell keeps its column (selection and links index by column) but
      // is not a space in the text: `wideTail` is dropped wherever text leaves the terminal.
      if cell.attrs & GridSnapshot.attrWideTail != 0 {
        line.append(wideTail)
        continue
      }
      if let cluster = clusters[rowStart + col] {
        line.append(cluster)
        continue
      }
      let cp = cell.codepoint
      if cp == 0 {
        line.append(" ")
      } else if let scalar = Unicode.Scalar(cp) {
        line.append(Character(scalar))
      } else {
        line.append(" ")
      }
    }
    while line.last == " " || line.last == wideTail { line.removeLast() }
    return line
  }

  /// Stands in for a wide glyph's second column in row text.
  public static let wideTail: Character = "\u{0}"

  public static func rowTexts(
    cells: [GridSnapshot.Cell],
    cols: Int,
    rows: Int,
    clusters: [Int: String] = [:]
  ) -> [String] {
    guard cols > 0, rows > 0 else { return [] }
    var out: [String] = []
    out.reserveCapacity(rows)
    for row in 0..<rows {
      out.append(rowText(cells: cells, rowStart: row * cols, cols: cols, clusters: clusters))
    }
    return out
  }
}
