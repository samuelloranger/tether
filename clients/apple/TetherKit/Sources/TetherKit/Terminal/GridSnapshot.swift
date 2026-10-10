/// Terminal grid value types shared by the engine and the renderer.
public enum GridSnapshot {
  public static let attrBold: UInt32 = 1 << 0
  public static let attrItalic: UInt32 = 1 << 1
  public static let attrUnderline: UInt32 = 1 << 2
  public static let attrInverse: UInt32 = 1 << 3
  public static let attrDim: UInt32 = 1 << 4
  public static let attrStrikethrough: UInt32 = 1 << 5
  /// The cell's background is the terminal default, not a color a program set.
  public static let attrDefaultBackground: UInt32 = 1 << 6
  /// SGR 8: drawn as its background only.
  public static let attrHidden: UInt32 = 1 << 7
  /// The first cell of a two-column glyph.
  public static let attrWide: UInt32 = 1 << 8
  /// The second cell of a two-column glyph: a space that is not text.
  public static let attrWideTail: UInt32 = 1 << 9
  /// SGR 4:n underline style, in three bits.
  public static let underlineStyleShift: UInt32 = 10
  public static let underlineStyleMask: UInt32 = 0b111 << underlineStyleShift

  public enum UnderlineStyle: UInt32, Sendable {
    case single = 1, double, curly, dotted, dashed
  }

  public static func underlineStyle(_ attrs: UInt32) -> UnderlineStyle? {
    guard attrs & attrUnderline != 0 else { return nil }
    return UnderlineStyle(rawValue: (attrs & underlineStyleMask) >> underlineStyleShift) ?? .single
  }

  public struct Header: Equatable, Sendable {
    public var cols: UInt16
    public var rows: UInt16
    public var cursorCol: UInt16
    public var cursorRow: UInt16
    public var generation: UInt64
    public var cursorVisible: Bool
    public var altScreen: Bool = false
    /// Set while a program has chosen the cursor's shape; nil means the user's setting.
    public var programCursor: TerminalCursorStyle? = nil
    /// The cursor sits on a two-column glyph.
    public var cursorWide = false
    /// The top row's line number counted from the start of output, so a selection can stay
    /// on its text while the screen scrolls.
    public var firstLine = 0
    /// Changes when line numbers restart (a reset, a cleared scrollback).
    public var lineEpoch: UInt32 = 0
    /// Set by OSC 12; nil means the theme's.
    public var cursorColor: UInt32? = nil
    /// Rows the program has not painted since the grid grew: drawn as slack above the grid,
    /// not as a gap under the program.
    public var trimsBlankRows = false
  }

  public struct Cell: Equatable, Sendable {
    public var codepoint: UInt32
    public var foreground: UInt32
    public var background: UInt32
    public var attrs: UInt32
    /// SGR 58; 0 means the foreground.
    public var underlineColor: UInt32 = 0
  }
}

/// The visible grid handed to the renderer.
public struct TerminalFrame: Sendable, Equatable {
  public var header: GridSnapshot.Header
  public var cells: [GridSnapshot.Cell]
  /// OSC 8 hyperlinks per visible row; empty when the screen has none.
  public var hyperlinks: [[LinkSpan]]
  public var images: TerminalImageLayer
  /// Cells holding more than one scalar (a ZWJ emoji, a flag, a keycap, a base and marks
  /// that don't compose), by cell index. `codepoint` keeps the first scalar.
  public var clusters: [Int: String]
  /// The default background in effect: the theme's, or what a program set with OSC 11.
  public var defaultBackground: UInt32?

  public init(
    header: GridSnapshot.Header, cells: [GridSnapshot.Cell], hyperlinks: [[LinkSpan]] = [],
    images: TerminalImageLayer = .empty, clusters: [Int: String] = [:], defaultBackground: UInt32? = nil
  ) {
    self.header = header
    self.cells = cells
    self.hyperlinks = hyperlinks
    self.images = images
    self.clusters = clusters
    self.defaultBackground = defaultBackground
  }
}
