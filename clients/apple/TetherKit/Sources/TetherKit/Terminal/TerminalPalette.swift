import SwiftTerm

/// The theme's `background` is also the view background around the grid, or a seam shows.
enum TerminalPalette {
  static let foreground = TerminalTheme.tether.foreground
  static let background = TerminalTheme.tether.background

  static var blankCell: GridSnapshot.Cell { blankCell(for: .tether) }

  static func blankCell(for theme: TerminalTheme) -> GridSnapshot.Cell {
    GridSnapshot.Cell(
      codepoint: 0x20, foreground: theme.foreground, background: theme.background,
      attrs: GridSnapshot.attrDefaultBackground
    )
  }

  static func install(_ theme: TerminalTheme = .tether, on terminal: Terminal) {
    terminal.installPalette(colors: theme.ansi.map(color))
    terminal.foregroundColor = color(theme.foreground)
    terminal.backgroundColor = color(theme.background)
  }

  /// The live 256-entry palette, read once per frame. From `paletteColor`, not
  /// the theme: programs can repaint entries with OSC 4.
  static func table(of terminal: Terminal, fallback: UInt32 = foreground) -> [UInt32] {
    (0..<256).map { index in
      guard let entry = terminal.paletteColor(index: index) else { return fallback }
      return pack(UInt8(entry.red >> 8), UInt8(entry.green >> 8), UInt8(entry.blue >> 8))
    }
  }

  static func resolve(
    _ value: Attribute.Color, isForeground: Bool, palette: [UInt32], theme: TerminalTheme = .tether
  ) -> UInt32 {
    switch value {
    case let .trueColor(red, green, blue):
      return pack(red, green, blue)
    case let .ansi256(code):
      return palette[Int(code)]
    case .defaultColor:
      return isForeground ? theme.foreground : theme.background
    case .defaultInvertedColor:
      return isForeground ? theme.background : theme.foreground
    }
  }

  private static func color(_ argb: UInt32) -> Color {
    Color(
      red8: UInt16((argb >> 16) & 0xFF),
      green8: UInt16((argb >> 8) & 0xFF),
      blue8: UInt16(argb & 0xFF))
  }

  private static func pack(_ red: UInt8, _ green: UInt8, _ blue: UInt8) -> UInt32 {
    0xFF00_0000 | UInt32(red) << 16 | UInt32(green) << 8 | UInt32(blue)
  }
}
